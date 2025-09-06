import { GoogleGenerativeAI } from '@google/generative-ai';
import { CommitSuggestion, CommitConfig, GitDiff, CommitType } from '../types/index.js';
import { ConfigManager } from '../config/index.js';
import {
  analyzeCommitType,
  extractScope,
  formatConventionalCommit,
  generateDescription,
  validateCommitMessage as validateMessage
} from '../utils/commit-helpers.js';
import {
  validateDiffSize,
  validateApiKey,
  withTimeout,
  DEFAULT_LIMITS,
  sanitizeError
} from '../utils/security.js';
import {
  ErrorHandler,
  ErrorType,
  withErrorHandling,
  withRetry,
  SecureError
} from '../utils/error-handler.js';

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

  /**
   * Generate commit message suggestions based on git diffs with security validation
   */
  generateCommitMessage = async (diffs: GitDiff[]): Promise<CommitSuggestion[]> => {
    return withRetry(async () => {
      return withErrorHandling(async () => {
        // Validate input diffs
        if (!diffs || diffs.length === 0) {
          throw new SecureError(
            'No diffs provided for commit message generation',
            ErrorType.VALIDATION_ERROR,
            { operation: 'generateCommitMessage' },
            true
          );
        }

        // Validate diff sizes
        for (const diff of diffs) {
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
        const model = this.genAI.getGenerativeModel({ model: config.model || 'gemini-1.5-flash' });

        // Enhanced analysis using helper functions
        const analysisContext = this.analyzeChanges(diffs);
        const prompt = this.buildEnhancedPrompt(diffs, config, analysisContext);

        // Validate prompt size
        if (prompt.length > DEFAULT_LIMITS.maxApiRequestSize) {
          throw new SecureError(
            `Prompt size ${prompt.length} exceeds limit of ${DEFAULT_LIMITS.maxApiRequestSize} characters`,
            ErrorType.VALIDATION_ERROR,
            { operation: 'generateCommitMessage' },
            true
          );
        }

        const result = await withTimeout(
          model.generateContent(prompt),
          DEFAULT_LIMITS.timeoutMs
        );
        const response = await result.response;
        const text = response.text();

        const suggestions = this.parseResponse(text, config);

        // Validate and improve suggestions
        return this.validateAndImprove(suggestions, analysisContext);
      }, { operation: 'generateCommitMessage' });
    }, 3, 2000, { operation: 'generateCommitMessage' });
  }

  /**
   * Build the prompt for AI based on configuration and changes
   */
  private buildPrompt = (diffs: GitDiff[], config: CommitConfig): string => {
    let prompt = '';

    if (config.customPrompt) {
      prompt = config.customPrompt + '\n\n';
    } else {
      prompt = this.getDefaultPrompt(config);
    }

    // Add changes context
    prompt += '\n\nCode changes to analyze:\n\n';

    diffs.forEach((diff, index) => {
      prompt += `File ${index + 1}: ${diff.file}\n`;

      if (diff.isNew) {
        prompt += 'Status: New file\n';
      } else if (diff.isDeleted) {
        prompt += 'Status: Deleted file\n';
      } else if (diff.isRenamed) {
        prompt += `Status: Renamed from ${diff.oldPath}\n`;
      } else {
        prompt += 'Status: Modified\n';
      }

      prompt += `Changes: +${diff.additions} -${diff.deletions}\n`;

      if (config.includeFiles && diff.changes) {
        // Include first 500 characters of diff to avoid token limits
        const diffPreview = diff.changes.substring(0, 500);
        prompt += `Diff preview:\n${diffPreview}\n`;
        if (diff.changes.length > 500) {
          prompt += '... (truncated)\n';
        }
      }

      prompt += '\n';
    });

    prompt += '\nPlease provide 3 commit message suggestions in JSON format with the following structure:\n';
    prompt += '{\n';
    prompt += '  "suggestions": [\n';
    prompt += '    {\n';
    prompt += '      "message": "commit message",\n';
    prompt += '      "description": "brief explanation",\n';
    prompt += '      "type": "commit type if conventional",\n';
    prompt += '      "scope": "scope if applicable",\n';
    prompt += '      "confidence": 0.95\n';
    prompt += '    }\n';
    prompt += '  ]\n';
    prompt += '}\n';

    return prompt;
  }

  /**
   * Get default prompt based on configuration
   */
  private getDefaultPrompt = (config: CommitConfig): string => {
    let prompt = 'You are an expert Git commit message generator. ';

    // Core principles for all commit messages
    prompt += 'IMPORTANT GUIDELINES:\n';
    prompt += '1. ALWAYS start with CAPITAL LETTER (e.g., "Added", "Fixed", "Updated", "Refactored")\n';
    prompt += '2. Use PAST TENSE (e.g., "Added", "Fixed", "Updated", "Refactored")\n';
    prompt += '3. Be SPECIFIC and MEANINGFUL (avoid generic messages like "Updated files" or "Fixed bug")\n';
    prompt += '4. Focus on WHAT was changed and WHY it was necessary\n';
    prompt += '5. Use ATOMIC approach - describe the specific change in this file\n\n';

    switch (config.style) {
      case 'conventional':
        prompt += 'Generate commit messages following Conventional Commits specification:\n';
        prompt += '- Format: type(scope): Past-tense description starting with capital letter\n';
        prompt += '- Types: feat, fix, docs, style, refactor, perf, test, e2e, build, ci, chore\n';
        prompt += '- Examples:\n';
        prompt += '  * "feat(auth): Added OAuth2 integration with Google provider"\n';
        prompt += '  * "fix(api): Resolved null pointer exception in user validation"\n';
        prompt += '  * "e2e(playwright): Added page object model for login flow"\n';
        prompt += '  * "e2e(spec): Updated E2E test assertions for checkout process"\n';
        prompt += '  * "refactor(utils): Extracted validation logic into separate module"\n';
        break;

      case 'descriptive':
        prompt += 'Generate descriptive commit messages in past tense with capital letters:\n';
        prompt += '- Clearly explain what was changed and why\n';
        prompt += '- Examples:\n';
        prompt += '  * "Added comprehensive error handling for API requests"\n';
        prompt += '  * "Refactored user authentication to use JWT tokens"\n';
        prompt += '  * "Added E2E test spec for user registration flow"\n';
        prompt += '  * "Updated page object model with new login selectors"\n';
        prompt += '  * "Fixed memory leak in event listener cleanup"\n';
        break;

      case 'minimal':
        prompt += 'Generate concise commit messages in past tense with capital letters:\n';
        prompt += '- Short but meaningful descriptions\n';
        prompt += '- Examples:\n';
        prompt += '  * "Added user validation"\n';
        prompt += '  * "Fixed login bug"\n';
        prompt += '  * "Added E2E tests"\n';
        prompt += '  * "Updated page objects"\n';
        prompt += '  * "Updated dependencies"\n';
        break;
    }

    prompt += `\nKeep first line under ${config.maxLength || 72} characters. `;
    prompt += 'Avoid vague terms like "updated", "changed", "modified" without context. ';
    prompt += 'Be specific about the actual functionality or improvement implemented. ';

    return prompt;
  }

  /**
   * Analyze changes to provide context for better commit messages
   */
  private analyzeChanges = (diffs: GitDiff[]) => {
    const primaryDiff = diffs[0]; // For individual commits, we have one file

    return {
      commitType: analyzeCommitType(diffs),
      scope: extractScope(primaryDiff.file),
      description: generateDescription(primaryDiff),
      fileCount: diffs.length,
      totalAdditions: diffs.reduce((sum, diff) => sum + diff.additions, 0),
      totalDeletions: diffs.reduce((sum, diff) => sum + diff.deletions, 0)
    };
  }

  /**
   * Build enhanced prompt with analysis context
   */
  private buildEnhancedPrompt = (diffs: GitDiff[], config: CommitConfig, analysis: any): string => {
    let prompt = this.getDefaultPrompt(config);

    // Add analysis context to help AI generate better messages
    prompt += `\n\nChange Analysis Context:\n`;
    prompt += `- Suggested commit type: ${analysis.commitType}\n`;
    prompt += `- File scope: ${analysis.scope || 'general'}\n`;
    prompt += `- Suggested description: ${analysis.description}\n`;
    prompt += `- Total changes: +${analysis.totalAdditions}/-${analysis.totalDeletions}\n`;

    // Add file details
    prompt += '\n\nFile Details:\n';
    diffs.forEach((diff, index) => {
      prompt += `File ${index + 1}: ${diff.file}\n`;
      if (diff.isNew) prompt += 'Status: New file\n';
      else if (diff.isDeleted) prompt += 'Status: Deleted file\n';
      else if (diff.isRenamed) prompt += `Status: Renamed from ${diff.oldPath}\n`;
      else prompt += 'Status: Modified\n';
      prompt += `Changes: +${diff.additions} -${diff.deletions}\n\n`;
    });

    prompt += 'Generate 3 commit message suggestions following the guidelines above.\n';
    prompt += 'Return as JSON: {"suggestions": [{"message": "...", "description": "...", "confidence": 0.95}]}\n';

    return prompt;
  }

  /**
   * Validate and improve commit message suggestions
   */
  private validateAndImprove = (suggestions: CommitSuggestion[], analysis: any): CommitSuggestion[] => {
    return suggestions.map(suggestion => {
      const validation = validateMessage(suggestion.message);

      if (!validation.valid) {
        // Try to improve the message based on validation feedback
        let improvedMessage = suggestion.message;

        // Apply automatic improvements based on analysis
        if (suggestion.message.length > 72) {
          improvedMessage = improvedMessage.substring(0, 69) + '...';
        }

        return {
          ...suggestion,
          message: improvedMessage,
          description: suggestion.description + ' (auto-improved)',
          confidence: Math.max(0.7, (suggestion.confidence || 0.8) - 0.1)
        };
      }

      return suggestion;
    });
  }

  /**
   * Parse AI response and extract commit suggestions
   */
  private parseResponse = (response: string, config: CommitConfig): CommitSuggestion[] => {
    try {
      // Try to extract JSON from the response
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
    } catch (error) {
      console.warn('Failed to parse JSON response, falling back to text parsing');
    }

    // Fallback: try to extract messages from text
    return this.parseTextResponse(response, config);
  }

  /**
   * Fallback parser for text responses
   */
  private parseTextResponse = (response: string, config: CommitConfig): CommitSuggestion[] => {
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

    // If we still don't have suggestions, create a generic one
    if (suggestions.length === 0) {
      suggestions.push({
        message: 'Update files',
        description: 'Generated fallback commit message',
        confidence: 0.3
      });
    }

    return suggestions.slice(0, 3); // Limit to 3 suggestions
  }

  /**
   * Validate commit message format
   */
  validateCommitMessage = (message: string, style: string): { valid: boolean; errors: string[] } => {
    const errors: string[] = [];

    if (!message || message.trim().length === 0) {
      errors.push('Commit message cannot be empty');
    }

    if (message.length > 72) {
      errors.push('First line should be 72 characters or less');
    }

    if (style === 'conventional') {
      const conventionalPattern = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(.+\))?: .+/;
      if (!conventionalPattern.test(message)) {
        errors.push('Message does not follow conventional commit format');
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}
