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
import { ERROR_MESSAGES, COMMIT_MESSAGES } from '../constants/messages.js';
import { UI_CONSTANTS, COMMIT_MESSAGE_PATTERNS } from '../constants/ui.js';
import {
  sanitizeGitDiff,
  shouldSkipFileForAI,
  createPrivacyReport,
  type SanitizedDiff,
} from '../utils/data-sanitization.js';

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
        ERROR_MESSAGES.API_KEY_NOT_FOUND,
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
                ERROR_MESSAGES.NO_DIFFS_PROVIDED,
                ErrorType.VALIDATION_ERROR,
                { operation: 'generateCommitMessage' },
                true
              );
            }

            // Filter out sensitive files and validate diffs
            const validatedDiffs: GitDiff[] = [];
            const skippedFiles: string[] = [];

            for (const diff of diffs) {
              // Check if file should be skipped for privacy reasons
              const skipCheck = shouldSkipFileForAI(diff.file, diff.changes || '');
              if (skipCheck.skip) {
                console.warn(`⚠️  Skipping ${diff.file}: ${skipCheck.reason}`);
                skippedFiles.push(diff.file);
                continue;
              }

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

            // Log privacy summary
            if (skippedFiles.length > 0) {
              console.warn(
                `🔒 Privacy: Skipped ${skippedFiles.length} sensitive files from AI processing`
              );
            }

            if (validatedDiffs.length === 0) {
              throw new SecureError(
                ERROR_MESSAGES.NO_VALID_DIFFS,
                ErrorType.VALIDATION_ERROR,
                { operation: 'generateCommitMessage' },
                true
              );
            }

            const config = this.config.getConfig();
            const model = this.genAI.getGenerativeModel({
              model: config.model ?? AI_DEFAULT_MODEL,
            });

            const { prompt } = this.buildJsonPrompt(validatedDiffs);

            if (prompt.length > DEFAULT_LIMITS.maxApiRequestSize) {
              throw new SecureError(
                `${ERROR_MESSAGES.PROMPT_SIZE_EXCEEDED} ${DEFAULT_LIMITS.maxApiRequestSize} characters`,
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
                ERROR_MESSAGES.NO_DIFFS_BATCH,
                ErrorType.VALIDATION_ERROR,
                { operation: 'generateBatchCommitMessages' },
                true
              );
            }

            // Filter out sensitive files and validate diffs
            const validatedDiffs: GitDiff[] = [];
            const skippedFiles: string[] = [];

            for (const diff of diffs) {
              // Check if file should be skipped for privacy reasons
              const skipCheck = shouldSkipFileForAI(diff.file, diff.changes || '');
              if (skipCheck.skip) {
                console.warn(`⚠️  Skipping ${diff.file}: ${skipCheck.reason}`);
                skippedFiles.push(diff.file);
                continue;
              }

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

            // Log privacy summary
            if (skippedFiles.length > 0) {
              console.warn(
                `🔒 Privacy: Skipped ${skippedFiles.length} sensitive files from AI processing`
              );
            }

            if (validatedDiffs.length === 0) {
              throw new SecureError(
                ERROR_MESSAGES.NO_VALID_DIFFS_BATCH,
                ErrorType.VALIDATION_ERROR,
                { operation: 'generateBatchCommitMessages' },
                true
              );
            }

            const config = this.config.getConfig();
            const model = this.genAI.getGenerativeModel({
              model: config.model ?? AI_DEFAULT_MODEL,
            });

            const { prompt, sanitizedDiffs } = this.buildJsonPrompt(validatedDiffs);

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
            const batchResults = this.parseBatchResponse(text, validatedDiffs, sanitizedDiffs);

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

  private readonly buildJsonPrompt = (
    diffs: GitDiff[],
    baseDir: string = process.cwd()
  ): { prompt: string; sanitizedDiffs: SanitizedDiff[] } => {
    // Sanitize all diffs before sending to AI
    const sanitizedDiffs = diffs.map((diff) => sanitizeGitDiff(diff, baseDir));

    // Create privacy report
    const privacyReport = createPrivacyReport(sanitizedDiffs);

    // Log privacy warnings if any
    if (privacyReport.sanitizedFiles > 0) {
      console.warn(''); // Add newline before privacy notice
      console.warn(
        `⚠️  Privacy Notice: ${privacyReport.sanitizedFiles} files were sanitized before sending to AI`
      );
      if (privacyReport.warnings.length > 0) {
        console.warn('   Warnings:');
        privacyReport.warnings.slice(0, 5).forEach((warning, index) => {
          console.warn(`   ${index + 1}. ${warning}`);
        });
        if (privacyReport.warnings.length > 5) {
          console.warn(`   ... and ${privacyReport.warnings.length - 5} more warnings`);
        }
      }
    }

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
      files: sanitizedDiffs.map((diff, index) => ({
        id: index + 1,
        name: diff.file,
        status: diff.isNew
          ? 'new file created'
          : diff.isDeleted
            ? 'file deleted'
            : diff.isRenamed
              ? 'file renamed'
              : 'modified',
        changes: diff.changes?.substring(0, UI_CONSTANTS.DIFF_CONTENT_TRUNCATE_LIMIT) || '',
        truncated: diff.changes && diff.changes.length > UI_CONSTANTS.DIFF_CONTENT_TRUNCATE_LIMIT,
        additions: diff.additions,
        deletions: diff.deletions,
        sanitized: diff.sanitized,
      })),
      output: {
        format: 'json',
        structure:
          diffs.length === 1
            ? {
                suggestions: [
                  {
                    message: 'string (4-20 words)',
                    confidence: 'number (0-1)',
                  },
                ],
              }
            : {
                files: {
                  filename1: {
                    message: 'string (4-20 words)',
                    confidence: 'number (0-1)',
                  },
                  filename2: {
                    message: 'string (4-20 words)',
                    confidence: 'number (0-1)',
                  },
                },
              },
        example:
          diffs.length === 1
            ? {
                suggestions: [
                  {
                    message: 'Implemented user authentication system',
                    description: 'Added login and registration functionality',
                    confidence: 0.9,
                  },
                ],
              }
            : {
                files: {
                  'auth.ts': {
                    message: 'Implemented user authentication system',
                    description: 'Added login and registration functionality',
                    confidence: 0.9,
                  },
                  'user.ts': {
                    message: 'Added user profile management features',
                    description: 'Created user data models and validation',
                    confidence: 0.8,
                  },
                },
              },
      },
    };

    return {
      prompt: JSON.stringify(promptData, null, 2),
      sanitizedDiffs
    };
  };

  private readonly parseBatchResponse = (
    response: string,
    diffs: GitDiff[],
    sanitizedDiffs: SanitizedDiff[]
  ): { [filename: string]: CommitSuggestion[] } => {
    const results: { [filename: string]: CommitSuggestion[] } = {};

    try {
      const jsonMatch = response.match(COMMIT_MESSAGE_PATTERNS.JSON_PATTERN);
      if (!jsonMatch) {
        console.warn('🔍 DEBUG: No JSON pattern found in AI response');
        console.warn('🔍 DEBUG: Response preview:', response.substring(0, 200) + '...');
        throw new Error(ERROR_MESSAGES.JSON_NOT_FOUND);
      }

      const parsed = JSON.parse(jsonMatch[0]);
      console.warn('🔍 DEBUG: Parsed AI response:', JSON.stringify(parsed, null, 2));

      // Handle different response formats
      if (parsed.files && typeof parsed.files === 'object') {
        // Batch format: { files: { filename: { message, description, confidence } } }
        for (let i = 0; i < diffs.length; i++) {
          const diff = diffs[i];
          const sanitizedDiff = sanitizedDiffs[i];
          const fileResult = parsed.files[sanitizedDiff.file];
          if (fileResult && fileResult.message) {
            const suggestion: CommitSuggestion = {
              message: fileResult.message,
              description: fileResult.description || '',
              type: fileResult.type || '',
              scope: fileResult.scope || '',
              confidence:
                typeof fileResult.confidence === 'number'
                  ? fileResult.confidence
                  : parseFloat(fileResult.confidence) || UI_CONSTANTS.CONFIDENCE_DEFAULT,
            };
            results[diff.file] = this.validateAndImprove([suggestion]);
          } else {
            // Fallback if specific file not found in response
            results[diff.file] = [
              {
                message: this.generateFallbackMessage(diff),
                description: 'Generated fallback commit message',
                confidence: UI_CONSTANTS.CONFIDENCE_FALLBACK,
              },
            ];
          }
        }
      } else if (parsed.suggestions && Array.isArray(parsed.suggestions)) {
        // Single file format: { suggestions: [{ message, description, confidence }] }
        // Apply the same suggestion to all files
        const suggestions = parsed.suggestions.map((suggestion: any) => ({
          message: suggestion.message || '',
          description: suggestion.description || '',
          type: suggestion.type || '',
          scope: suggestion.scope || '',
          confidence:
            typeof suggestion.confidence === 'number'
              ? suggestion.confidence
              : parseFloat(suggestion.confidence) || UI_CONSTANTS.CONFIDENCE_DEFAULT,
        }));

        for (const diff of diffs) {
          results[diff.file] = this.validateAndImprove(suggestions);
        }
      } else {
        // Try to extract any commit messages from the response text
        const textSuggestions = this.parseTextResponse(response);
        for (const diff of diffs) {
          results[diff.file] =
            textSuggestions.length > 0
              ? textSuggestions
              : [
                  {
                    message: this.generateFallbackMessage(diff),
                    description: 'Generated fallback commit message',
                    confidence: UI_CONSTANTS.CONFIDENCE_FALLBACK,
                  },
                ];
        }
      }
    } catch (error) {
      console.warn(ERROR_MESSAGES.FAILED_PARSE_BATCH_JSON, error);
      // Generate fallback messages for all files
      for (const diff of diffs) {
        results[diff.file] = [
          {
            message: this.generateFallbackMessage(diff),
            description: 'Generated fallback commit message due to parsing error',
            confidence: UI_CONSTANTS.CONFIDENCE_FALLBACK,
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

        // Validate word count - reject messages that are too short/long
        const wordCount = improvedMessage.split(/\s+/).length;
        let confidence = result.data.confidence;

        if (wordCount < UI_CONSTANTS.MIN_WORD_COUNT) {
          // Don't add filler words - mark as low confidence instead
          confidence = Math.max(
            UI_CONSTANTS.CONFIDENCE_MIN,
            confidence - UI_CONSTANTS.CONFIDENCE_DECREASE
          );
        } else if (wordCount > UI_CONSTANTS.MAX_WORD_COUNT) {
          // Truncate to exactly max words without adding filler
          const words = improvedMessage.split(/\s+/);
          improvedMessage = words.slice(0, UI_CONSTANTS.MAX_WORD_COUNT).join(' ');
          confidence = Math.max(0.6, confidence - 0.1);
        }

        if (improvedMessage.length > UI_CONSTANTS.MESSAGE_MAX_LENGTH) {
          improvedMessage = `${improvedMessage.substring(0, UI_CONSTANTS.MESSAGE_MAX_LENGTH)}...`;
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
      const jsonMatch = response.match(COMMIT_MESSAGE_PATTERNS.JSON_PATTERN);
      if (!jsonMatch) {
        throw new Error(ERROR_MESSAGES.JSON_NOT_FOUND);
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
        line.match(COMMIT_MESSAGE_PATTERNS.NUMBERED_PATTERN) ||
        COMMIT_MESSAGE_PATTERNS.AVOID_PREFIXES.some((prefix: string) => line.includes(prefix))
      ) {
        const message = line.replace(COMMIT_MESSAGE_PATTERNS.NUMBERED_PATTERN, '').trim();
        if (message && message.length > 5) {
          suggestions.push({
            message,
            confidence: UI_CONSTANTS.CONFIDENCE_DEFAULT,
          });
        }
      }
    }

    if (suggestions.length === 0) {
      suggestions.push({
        message: COMMIT_MESSAGES.FALLBACK_IMPLEMENT,
        description: COMMIT_MESSAGES.FALLBACK_DESCRIPTION,
        confidence: UI_CONSTANTS.CONFIDENCE_FALLBACK,
      });
    }

    return suggestions.slice(0, AI_MAX_SUGGESTIONS);
  };
}
