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

            const prompt = this.buildJsonPrompt(validatedDiffs);

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

            const prompt = this.buildJsonPrompt(validatedDiffs);

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

  private readonly buildJsonPrompt = (diffs: GitDiff[]): string => {
    const promptData = {
      role: 'expert commit message generator for software development',
      task: 'analyze code changes and craft a single, concise commit message (4-20 words) that clearly describes the functional changes',
      requirements: {
        focus:
          'WHAT WAS BUILT/IMPLEMENTED - Describe the new functionality, features, or significant changes introduced',
        tense:
          'Use Past Tense Verbs - Start with action verbs like "Implemented," "Added," "Created," "Refactored," "Fixed," "Optimized"',
        purpose:
          'Highlight Purpose/Value - Explain why the change was made and its benefit to the system or users',
        specificity:
          'Be Specific, Not Generic - Avoid vague statements; detail the exact functionality',
        prefixes:
          'No Prefixes - Do NOT include conventional prefixes like "feat:", "fix:", "chore:"',
        length: 'Length Constraint - Keep the message between 4 and 20 words',
      },
      examples: {
        good: [
          {
            message: 'Implemented Zod validation schemas for type-safe configuration management',
            reason: 'Describes specific functionality and its purpose clearly',
          },
          {
            message: 'Added ts-pattern utilities for error handling and file type detection',
            reason: 'Specific about what was added and its functional purpose',
          },
          {
            message: 'Created centralized validation system with comprehensive type definitions',
            reason: 'Explains the system architecture and its comprehensive nature',
          },
          {
            message: 'Integrated tsup build configuration for optimized bundle generation',
            reason: 'Clear about the integration purpose and optimization benefit',
          },
          {
            message: 'Built pattern matching utilities for commit message classification',
            reason: 'Specific about the utility type and its classification purpose',
          },
        ],
        bad: [
          {
            message: 'Major updates to validation.ts (+279/-0 lines)',
            reason: 'Focuses on metrics, not functionality',
          },
          {
            message: 'Updated files for better functionality',
            reason: 'Too vague; lacks specifics',
          },
          {
            message: 'Improved code quality and maintainability',
            reason: 'Generic and not descriptive of concrete changes',
          },
          {
            message: 'Enhanced data processing capabilities',
            reason: 'Lacks details on how or what was enhanced',
          },
          {
            message: 'Added 15 new functions and 3 classes',
            reason: 'Focuses on quantity rather than purpose or impact',
          },
        ],
      },
      files: diffs.map((diff, index) => ({
        id: index + 1,
        name: diff.file,
        status: diff.isNew
          ? 'new file created'
          : diff.isDeleted
            ? 'file deleted'
            : diff.isRenamed
              ? 'file renamed'
              : 'modified',
        changes: diff.changes?.substring(0, 3000) || '',
        truncated: diff.changes && diff.changes.length > 3000,
        additions: diff.additions,
        deletions: diff.deletions,
      })),
      output: {
        format: 'json',
        structure:
          diffs.length === 1
            ? { suggestions: 'Array of objects with message, description, confidence' }
            : { files: 'Object with filename as key, containing message, description, confidence' },
      },
    };

    return JSON.stringify(promptData, null, 2);
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
              confidence:
                typeof fileResult.confidence === 'number'
                  ? fileResult.confidence
                  : parseFloat(fileResult.confidence) || 0.8,
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
          confidence:
            typeof suggestion.confidence === 'number'
              ? suggestion.confidence
              : parseFloat(suggestion.confidence) || 0.8,
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
