import { GoogleGenerativeAI } from '@google/generative-ai';
import type { CommitSuggestion, GitDiff } from '../types/common.js';
import { ConfigManager } from '../config.js';
import { GitDiffSchema, CommitSuggestionSchema, DiffContentSchema } from '../schemas/validation.js';
import { withTimeout } from '../utils/security.js';
import { ErrorType } from '../types/error-handler.js';
import { ErrorHandler, withErrorHandling, withRetry, SecureError } from '../utils/error-handler.js';
import { DEFAULT_LIMITS } from '../constants/security.js';
import {
  AI_RETRY_ATTEMPTS,
  AI_RETRY_DELAY_MS,
  AI_DEFAULT_MODEL,
  AI_MAX_SUGGESTIONS,
} from '../constants/ai.js';

export class AIService {
  private readonly genAI: GoogleGenerativeAI;
  private readonly config: ConfigManager;
  private readonly errorHandler: ErrorHandler;

  constructor() {
    this.config = ConfigManager.getInstance();
    this.errorHandler = ErrorHandler.getInstance();

    const apiKey = this.config.getApiKey();

    if (!apiKey) {
      throw new SecureError(
        'Gemini API key not found. Please set GEMINI_API_KEY environment variable or configure it with "commit-x config set apiKey YOUR_API_KEY"',
        ErrorType.CONFIG_ERROR,
        { operation: 'AIService.constructor' },
        true
      );
    }

    // API key is already validated by ConfigManager.getApiKey()
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  generateCommitMessage = async (diffs: GitDiff[]): Promise<CommitSuggestion[]> => {
    return withRetry(
      async () => {
        return withErrorHandling(
          async () => {
            if (!diffs || diffs.length === 0) {
              throw new SecureError(
                'No diffs provided for commit message generation',
                ErrorType.VALIDATION_ERROR,
                { operation: 'generateCommitMessage' },
                true
              );
            }

            // Validate and filter diffs using Zod
            const validatedDiffs: GitDiff[] = [];
            for (const diff of diffs) {
              const diffResult = GitDiffSchema.safeParse(diff);
              if (diffResult.success) {
                // Additional validation for diff content size
                const contentResult = DiffContentSchema.safeParse(diff.changes);
                if (contentResult.success) {
                  validatedDiffs.push(diffResult.data);
                } else {
                  console.warn(`Skipping diff for ${diff.file}: content too large`);
                }
              } else {
                console.warn(`Skipping invalid diff for ${diff.file}:`, diffResult.error.issues);
              }
            }

            if (validatedDiffs.length === 0) {
              throw new SecureError(
                'No valid diffs found for commit message generation',
                ErrorType.VALIDATION_ERROR,
                { operation: 'generateCommitMessage' },
                true
              );
            }

            const config = this.config.getConfig();
            const model = this.genAI.getGenerativeModel({
              model: config.model ?? AI_DEFAULT_MODEL,
            });

            const prompt = this.buildEnhancedPrompt(validatedDiffs);

            if (prompt.length > DEFAULT_LIMITS.maxApiRequestSize) {
              throw new SecureError(
                `Prompt size ${prompt.length} exceeds limit of ${DEFAULT_LIMITS.maxApiRequestSize} characters`,
                ErrorType.VALIDATION_ERROR,
                { operation: 'generateCommitMessage' },
                true
              );
            }

            const { response } = await withTimeout(
              model.generateContent(prompt),
              DEFAULT_LIMITS.timeoutMs
            );
            const text = response.text();
            const suggestions = this.parseResponse(text);

            // Validate suggestions using Zod
            return this.validateAndImprove(suggestions);
          },
          { operation: 'generateCommitMessage' }
        );
      },
      AI_RETRY_ATTEMPTS,
      AI_RETRY_DELAY_MS,
      { operation: 'generateCommitMessage' }
    );
  };

  generateBatchCommitMessages = async (
    diffs: GitDiff[]
  ): Promise<{ [filename: string]: CommitSuggestion[] }> => {
    return withRetry(
      async () => {
        return withErrorHandling(
          async () => {
            if (!diffs || diffs.length === 0) {
              throw new SecureError(
                'No diffs provided for batch commit message generation',
                ErrorType.VALIDATION_ERROR,
                { operation: 'generateBatchCommitMessages' },
                true
              );
            }

            // Validate and filter diffs using Zod
            const validatedDiffs: GitDiff[] = [];
            for (const diff of diffs) {
              const diffResult = GitDiffSchema.safeParse(diff);
              if (diffResult.success) {
                // Additional validation for diff content size
                const contentResult = DiffContentSchema.safeParse(diff.changes);
                if (contentResult.success) {
                  validatedDiffs.push(diffResult.data);
                } else {
                  console.warn(`Skipping diff for ${diff.file}: content too large`);
                }
              } else {
                console.warn(`Skipping invalid diff for ${diff.file}:`, diffResult.error.issues);
              }
            }

            if (validatedDiffs.length === 0) {
              throw new SecureError(
                'No valid diffs found for batch commit message generation',
                ErrorType.VALIDATION_ERROR,
                { operation: 'generateBatchCommitMessages' },
                true
              );
            }

            const config = this.config.getConfig();
            const model = this.genAI.getGenerativeModel({
              model: config.model ?? AI_DEFAULT_MODEL,
            });

            const prompt = this.buildBatchPrompt(validatedDiffs);

            if (prompt.length > DEFAULT_LIMITS.maxApiRequestSize) {
              throw new SecureError(
                `Prompt size ${prompt.length} exceeds limit of ${DEFAULT_LIMITS.maxApiRequestSize} characters`,
                ErrorType.VALIDATION_ERROR,
                { operation: 'generateBatchCommitMessages' },
                true
              );
            }

            const { response } = await withTimeout(
              model.generateContent(prompt),
              DEFAULT_LIMITS.timeoutMs
            );
            const text = response.text();
            const batchResults = this.parseBatchResponse(text, validatedDiffs);

            return batchResults;
          },
          { operation: 'generateBatchCommitMessages' }
        );
      },
      AI_RETRY_ATTEMPTS,
      AI_RETRY_DELAY_MS,
      { operation: 'generateBatchCommitMessages' }
    );
  };

  private readonly getMaxLengthForStyle = (): number => {
    return 96; // Standard length for descriptive commit messages
  };

  private readonly getDefaultPrompt = (): string => {
    let prompt =
      'You are an expert commit message generator for software development. Your task is to analyze code changes and craft a single, concise commit message (4-20 words) that clearly describes the functional changes.\n\n' +

      '## COMMIT MESSAGE REQUIREMENTS: (INSTRUCTIONS)\n' +
      '- **Focus on "WHAT WAS BUILT/IMPLEMENTED":** Describe the new functionality, features, or significant changes introduced.\n' +
      '- **Use Past Tense Verbs:** Start with action verbs like "Implemented," "Added," "Created," "Refactored," "Fixed," "Optimized."\n' +
      '- **Highlight Purpose/Value:** Explain *why* the change was made and its benefit to the system or users.\n' +
      '- **Be Specific, Not Generic:** Avoid vague statements; detail the exact functionality.\n' +
      '- **No Prefixes:** Do NOT include conventional prefixes like "feat:", "fix:", "chore:".\n' +
      '- **Length Constraint:** Keep the message between 4 and 20 words.\n\n' +

      '## GOOD EXAMPLES:\n' +
      '- "Implemented Zod validation schemas for type-safe configuration management"\n' +
      '- "Added ts-pattern utilities for error handling and file type detection"\n' +
      '- "Created centralized validation system with comprehensive type definitions"\n' +
      '- "Integrated tsup build configuration for optimized bundle generation"\n' +
      '- "Built pattern matching utilities for commit message classification"\n\n' +

      '## BAD EXAMPLES (Avoid these common pitfalls):\n' +
      '- "Major updates to validation.ts (+279/-0 lines)" (Focuses on metrics, not functionality.)\n' +
      '- "Updated files for better functionality" (Too vague; lacks specifics.)\n' +
      '- "Improved code quality and maintainability" (Generic and not descriptive of concrete changes.)\n' +
      '- "Enhanced data processing capabilities" (Lacks details on *how* or *what* was enhanced.)\n' +
      '- "Added 15 new functions and 3 classes" (Focuses on quantity rather than purpose or impact.)\n\n' +

      '## OUTPUT:\n' +
      '--- ANALYZE THE PROVIDED CODE CHANGES AND GENERATE THE OPTIMIZED COMMIT MESSAGE BELOW ---';

    return prompt;
  };

  private readonly buildEnhancedPrompt = (diffs: GitDiff[]): string => {
    let prompt = this.getDefaultPrompt();

    prompt += `\n\nFILE ANALYSIS:\n`;

    // Show the actual diff content for precise analysis
    diffs.forEach((diff, _index) => {
      let status = 'Modified';
      if (diff.isNew) status = 'New file created';
      else if (diff.isDeleted) status = 'File deleted';
      else if (diff.isRenamed) status = 'File renamed';

      prompt += `\nFile: ${diff.file}\n`;
      prompt += `Status: ${status}\n`;

      if (diff.changes?.trim()) {
        // Show the actual diff content for better analysis
        const diffPreview = diff.changes.substring(0, 3000);
        prompt += `\nCode implementation:\n${diffPreview}\n`;
        if (diff.changes.length > 3000) {
          prompt += '... (code truncated)\n';
        }
      }
    });

    prompt += '\nBased on the CODE IMPLEMENTATION shown above:\n';
    prompt +=
      '1. Identify WHAT FUNCTIONALITY was implemented (what features, systems, or capabilities were built)\n';
    prompt += '2. Generate a descriptive 8-20 word message focusing on WHAT WAS IMPLEMENTED\n';
    prompt +=
      '3. Emphasize the PURPOSE and VALUE of the implementation, not just technical details\n';
    prompt +=
      '\nReturn as JSON: {"suggestions": [{"message": "...", "description": "...", "confidence": 0.95}]}\n';

    return prompt;
  };

  private readonly buildBatchPrompt = (diffs: GitDiff[]): string => {
    let prompt = this.getDefaultPrompt();

    prompt += `\n\nBATCH ANALYSIS - Generate individual commit messages for each file:\n`;
    prompt += `You are analyzing ${diffs.length} files with changes. For EACH file, generate a specific commit message.\n\n`;

    // Show the actual diff content for precise analysis
    diffs.forEach((diff, index) => {
      let status = 'Modified';
      if (diff.isNew) status = 'New file created';
      else if (diff.isDeleted) status = 'File deleted';
      else if (diff.isRenamed) status = 'File renamed';

      prompt += `\n=== FILE ${index + 1}: ${diff.file} ===\n`;
      prompt += `Status: ${status}\n`;

      if (diff.changes?.trim()) {
        // Show the actual diff content for better analysis
        const diffPreview = diff.changes.substring(0, 2000); // Smaller per-file limit for batch
        prompt += `\nCode implementation:\n${diffPreview}\n`;
        if (diff.changes.length > 2000) {
          prompt += '... (code truncated)\n';
        }
      }
    });

    prompt +=
      '\n\nFOR EACH FILE ABOVE, generate a specific commit message that describes WHAT WAS IMPLEMENTED in that file.\n';
    prompt += 'Return as JSON with this EXACT structure:\n';
    prompt += '{\n';
    prompt += '  "files": {\n';
    diffs.forEach((diff, index) => {
      const comma = index === diffs.length - 1 ? '' : ',';
      prompt += `    "${diff.file}": {"message": "...", "description": "...", "confidence": 0.95}${comma}\n`;
    });
    prompt += '  }\n';
    prompt += '}\n';

    return prompt;
  };

  private readonly parseBatchResponse = (
    response: string,
    diffs: GitDiff[]
  ): { [filename: string]: CommitSuggestion[] } => {
    const results: { [filename: string]: CommitSuggestion[] } = {};

    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      if (parsed.files && typeof parsed.files === 'object') {
        for (const diff of diffs) {
          const fileResult = parsed.files[diff.file];
          if (fileResult && fileResult.message) {
            const suggestion: CommitSuggestion = {
              message: fileResult.message,
              description: fileResult.description || '',
              type: fileResult.type || '',
              scope: fileResult.scope || '',
              confidence: fileResult.confidence || 0.8,
            };
            results[diff.file] = this.validateAndImprove([suggestion]);
          } else {
            // Fallback if specific file not found in response
            results[diff.file] = [
              {
                message: this.generateFallbackMessage(diff),
                description: 'Generated fallback commit message',
                confidence: 0.3,
              },
            ];
          }
        }
      } else {
        throw new Error('Invalid batch response format');
      }
    } catch (error) {
      console.warn('Failed to parse batch JSON response, using fallbacks:', error);
      // Generate fallback messages for all files
      for (const diff of diffs) {
        results[diff.file] = [
          {
            message: this.generateFallbackMessage(diff),
            description: 'Generated fallback commit message due to parsing error',
            confidence: 0.3,
          },
        ];
      }
    }

    return results;
  };

  private readonly generateFallbackMessage = (diff: GitDiff): string => {
    const fileName = diff.file.split('/').pop() ?? diff.file;

    if (diff.isNew) {
      return `Created new ${fileName} file with initial implementation`;
    } else if (diff.isDeleted) {
      return `Removed ${fileName} file as it is no longer needed`;
    } else if (diff.additions > diff.deletions * 2) {
      return `Added new functionality to ${fileName} file`;
    } else if (diff.deletions > diff.additions * 2) {
      return `Removed unused code from ${fileName} file`;
    } else {
      return `Updated ${fileName} file with code improvements`;
    }
  };

  private readonly validateAndImprove = (suggestions: CommitSuggestion[]): CommitSuggestion[] => {
    const validatedSuggestions: CommitSuggestion[] = [];

    for (const suggestion of suggestions) {
      const result = CommitSuggestionSchema.safeParse(suggestion);
      if (result.success) {
        let improvedMessage = result.data.message.trim();

        // Validate word count (7-21 words) - reject messages that are too short/long
        const wordCount = improvedMessage.split(/\s+/).length;
        let confidence = result.data.confidence;

        if (wordCount < 7) {
          // Don't add filler words - mark as low confidence instead
          confidence = Math.max(0.3, confidence - 0.4);
        } else if (wordCount > 25) {
          // Truncate to exactly 21 words without adding filler
          const words = improvedMessage.split(/\s+/);
          improvedMessage = words.slice(0, 25).join(' ');
          confidence = Math.max(0.6, confidence - 0.1);
        }

        if (improvedMessage.length > 120) {
          improvedMessage = `${improvedMessage.substring(0, 120)}...`;
        }

        validatedSuggestions.push({
          ...result.data,
          message: improvedMessage,
          confidence,
        });
      } else {
        console.warn('Skipping invalid suggestion:', result.error.issues);
      }
    }

    return validatedSuggestions;
  };

  private readonly parseResponse = (response: string): CommitSuggestion[] => {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      if (parsed.suggestions && Array.isArray(parsed.suggestions)) {
        return parsed.suggestions.map((suggestion: any) => ({
          message: suggestion.message ?? '',
          description: suggestion.description ?? '',
          type: suggestion.type ?? '',
          scope: suggestion.scope ?? '',
          confidence: suggestion.confidence ?? 0.8,
        }));
      }
    } catch {
      console.warn('Failed to parse JSON response, falling back to text parsing');
    }

    return this.parseTextResponse(response);
  };

  private readonly parseTextResponse = (response: string): CommitSuggestion[] => {
    const lines = response.split('\n').filter((line) => line.trim());
    const suggestions: CommitSuggestion[] = [];

    for (const line of lines) {
      if (
        line.match(/^\d+\./) ||
        line.includes('feat:') ||
        line.includes('fix:') ||
        line.includes('chore:')
      ) {
        const message = line.replace(/^\d+\.\s*/, '').trim();
        if (message && message.length > 5) {
          suggestions.push({
            message,
            confidence: 0.8,
          });
        }
      }
    }

    if (suggestions.length === 0) {
      suggestions.push({
        message: 'Implement code changes',
        description: 'Generated fallback commit message for code implementation',
        confidence: 0.3,
      });
    }

    return suggestions.slice(0, AI_MAX_SUGGESTIONS);
  };
}
