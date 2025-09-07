import { GoogleGenerativeAI } from '@google/generative-ai';
import { CommitSuggestion, CommitConfig, GitDiff } from '../types/common.js';
import { ConfigManager } from '../config.js';
// No longer needed - using descriptive style only
import {
  validateDiffSize,
  validateApiKey,
  withTimeout,
} from '../utils/security.js';
import { ErrorType } from '../types/error-handler.js';
import {
  ErrorHandler,
  withErrorHandling,
  withRetry,
  SecureError
} from '../utils/error-handler.js';
import { DEFAULT_LIMITS } from '../constants/security.js';
import { AI_RETRY_ATTEMPTS, AI_RETRY_DELAY_MS, AI_DEFAULT_MODEL, AI_MAX_SUGGESTIONS, AI_DIFF_PREVIEW_LENGTH } from '../constants/ai.js';

export class AIService {
  private genAI: GoogleGenerativeAI;
  private config: ConfigManager;
  private errorHandler: ErrorHandler;

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

    // Validate API key format
    const keyValidation = validateApiKey(apiKey);
    if (!keyValidation.isValid) {
      throw new SecureError(
        keyValidation.error!,
        ErrorType.VALIDATION_ERROR,
        { operation: 'AIService.constructor' },
        true
      );
    }

    this.genAI = new GoogleGenerativeAI(keyValidation.sanitizedValue!);
  }


  generateCommitMessage = async (diffs: GitDiff[]): Promise<CommitSuggestion[]> => {
    return withRetry(async () => {
      return withErrorHandling(async () => {
        if (!diffs || diffs.length === 0) {
          throw new SecureError(
            'No diffs provided for commit message generation',
            ErrorType.VALIDATION_ERROR,
            { operation: 'generateCommitMessage' },
            true
          );
        }

        // Filter out empty diffs (no changes and no content)
        const meaningfulDiffs = diffs.filter(diff => {
          const hasChanges = diff.additions > 0 || diff.deletions > 0;
          const hasContent = diff.changes && diff.changes.trim() !== '';
          return hasChanges || hasContent;
        });

        if (meaningfulDiffs.length === 0) {
          throw new SecureError(
            'No meaningful changes found in provided diffs',
            ErrorType.VALIDATION_ERROR,
            { operation: 'generateCommitMessage' },
            true
          );
        }

        for (const diff of meaningfulDiffs) {
          const diffValidation = validateDiffSize(diff.changes, DEFAULT_LIMITS.maxDiffSize);
          if (!diffValidation.isValid) {
            throw new SecureError(
              diffValidation.error!,
              ErrorType.VALIDATION_ERROR,
              { operation: 'generateCommitMessage', file: diff.file },
              true
            );
          }
        }

        const config = this.config.getConfig();
        const model = this.genAI.getGenerativeModel({ model: config.model || AI_DEFAULT_MODEL });

        const prompt = this.buildEnhancedPrompt(meaningfulDiffs);

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

        return this.validateAndImprove(suggestions);
      }, { operation: 'generateCommitMessage' });
    }, AI_RETRY_ATTEMPTS, AI_RETRY_DELAY_MS, { operation: 'generateCommitMessage' });
  }

  private getMaxLengthForStyle = (): number => {
    return 96; // Standard length for descriptive commit messages
  }

  private getDefaultPrompt = (): string => {
    let prompt = 'You are an expert at analyzing code changes and generating precise commit messages.\n\n';

    prompt += 'REQUIREMENTS:\n';
    prompt += '- Generate 7-15 words describing EXACTLY what changed in the code\n';
    prompt += '- Be SPECIFIC about the actual changes, not generic improvements\n';
    prompt += '- Use past tense verbs: "Converted", "Added", "Removed", "Replaced", "Refactored"\n';
    prompt += '- NO prefixes like "feat:", "fix:", "chore:"\n';
    prompt += '- Focus on the CODE CHANGES, not theoretical benefits\n\n';

    prompt += 'GOOD EXAMPLES (specific to actual changes):\n';
    prompt += '- "Converted getUserData function from regular function to arrow function"\n';
    prompt += '- "Added email validation regex pattern to user input validator"\n';
    prompt += '- "Removed unused import statements and cleaned up dependencies"\n';
    prompt += '- "Replaced setTimeout with setInterval in polling mechanism"\n';
    prompt += '- "Refactored database query methods to use async await syntax"\n\n';

    prompt += 'BAD EXAMPLES (avoid these generic patterns):\n';
    prompt += '- "Enhanced service logic for improved performance" (too generic)\n';
    prompt += '- "Updated configuration for better functionality" (vague)\n';
    prompt += '- "Improved code quality and maintainability" (meaningless)\n';
    prompt += '- "Enhanced data processing capabilities" (no specifics)\n\n';

    prompt += 'ANALYZE the actual code diff and describe the SPECIFIC technical changes made.\n';

    return prompt;
  }

  private buildEnhancedPrompt = (diffs: GitDiff[]): string => {
    let prompt = this.getDefaultPrompt();

    prompt += `\n\nFILE ANALYSIS:\n`;

    // Show the actual diff content for precise analysis
    diffs.forEach((diff, index) => {
      let status = 'Modified';
      if (diff.isNew) status = 'New file created';
      else if (diff.isDeleted) status = 'File deleted';
      else if (diff.isRenamed) status = 'File renamed';

      prompt += `\nFile: ${diff.file}\n`;
      prompt += `Status: ${status}\n`;
      prompt += `Changes: +${diff.additions} lines, -${diff.deletions} lines\n`;

      if (diff.changes && diff.changes.trim()) {
        // Show more of the actual diff content for better analysis
        const diffPreview = diff.changes.substring(0, 2000); // Increased from AI_DIFF_PREVIEW_LENGTH
        prompt += `\nActual code changes:\n${diffPreview}\n`;
        if (diff.changes.length > 2000) {
          prompt += '... (diff truncated)\n';
        }
      }
    });

    prompt += '\nBased on the ACTUAL CODE CHANGES shown above:\n';
    prompt += '1. Identify the SPECIFIC technical changes made (what functions/methods/syntax changed)\n';
    prompt += '2. Generate a precise 7-15 word message describing exactly what was changed\n';
    prompt += '3. Focus on the code modifications, not generic improvements\n';
    prompt += '\nReturn as JSON: {"suggestions": [{"message": "...", "description": "...", "confidence": 0.95}]}\n';

    return prompt;
  }

  private validateAndImprove = (suggestions: CommitSuggestion[]): CommitSuggestion[] => {
    return suggestions.map(suggestion => {
      let improvedMessage = suggestion.message.trim();

      // Validate word count (7-21 words) - reject messages that are too short/long
      const wordCount = improvedMessage.split(/\s+/).length;
      let confidence = suggestion.confidence || 0.8;

      if (wordCount < 7) {
        // Don't add filler words - mark as low confidence instead
        confidence = Math.max(0.3, confidence - 0.4);
      } else if (wordCount > 25) {
        // Truncate to exactly 21 words without adding filler
        const words = improvedMessage.split(/\s+/);
        improvedMessage = words.slice(0, 25).join(' ');
        confidence = Math.max(0.6, confidence - 0.1);
      }

      if (improvedMessage.length > 96) {
        improvedMessage = improvedMessage.substring(0, 96) + '...';
      }

      return {
        ...suggestion,
        message: improvedMessage,
        confidence
      };
    });
  }

  private parseResponse = (response: string): CommitSuggestion[] => {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      if (parsed.suggestions && Array.isArray(parsed.suggestions)) {
        return parsed.suggestions.map((suggestion: any) => ({
          message: suggestion.message || '',
          description: suggestion.description || '',
          type: suggestion.type || '',
          scope: suggestion.scope || '',
          confidence: suggestion.confidence || 0.8
        }));
      }
    } catch {
      console.warn('Failed to parse JSON response, falling back to text parsing');
    }

    return this.parseTextResponse(response);
  }

  private parseTextResponse = (response: string): CommitSuggestion[] => {
    const lines = response.split('\n').filter(line => line.trim());
    const suggestions: CommitSuggestion[] = [];

    for (const line of lines) {
      if (line.match(/^\d+\./) || line.includes('feat:') || line.includes('fix:') || line.includes('chore:')) {
        const message = line.replace(/^\d+\.\s*/, '').trim();
        if (message && message.length > 5) {
          suggestions.push({
            message,
            confidence: 0.8
          });
        }
      }
    }

    if (suggestions.length === 0) {
      suggestions.push({
        message: 'Update files',
        description: 'Generated fallback commit message',
        confidence: 0.3
      });
    }

    return suggestions.slice(0, AI_MAX_SUGGESTIONS);
  }

}
