import { GoogleGenerativeAI } from '@google/generative-ai';
import { CommitSuggestion, CommitConfig, GitDiff, CommitType } from '../types/common.js';
import { ConfigManager } from '../config.js';
import {
  analyzeCommitType,
  extractScope,
  generateDescription,
  validateCommitMessage as validateMessage
} from '../utils/commit-helpers.js';
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
        const model = this.genAI.getGenerativeModel({ model: config.model || AI_DEFAULT_MODEL });

        const analysisContext = this.analyzeChanges(diffs);
        const prompt = this.buildEnhancedPrompt(diffs, config, analysisContext);

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
        const suggestions = this.parseResponse(text, config);

        return this.validateAndImprove(suggestions, analysisContext);
      }, { operation: 'generateCommitMessage' });
    }, AI_RETRY_ATTEMPTS, AI_RETRY_DELAY_MS, { operation: 'generateCommitMessage' });
  }

  private buildPrompt = (diffs: GitDiff[], config: CommitConfig): string => {
    let prompt = this.getDefaultPrompt(config);
    prompt += '\n\nCode changes to analyze:\n\n';

    diffs.forEach((diff, index) => {
      prompt += `File ${index + 1}: ${diff.file}\n`;

      let status = 'Modified';
      if (diff.isNew) status = 'New file';
      else if (diff.isDeleted) status = 'Deleted file';
      else if (diff.isRenamed) status = `Renamed from ${diff.oldPath}`;

      prompt += `Status: ${status}\n`;

      prompt += `Changes: +${diff.additions} -${diff.deletions}\n`;

      if (diff.changes) {
        const diffPreview = diff.changes.substring(0, AI_DIFF_PREVIEW_LENGTH);
        prompt += `Diff preview:\n${diffPreview}\n`;
        if (diff.changes.length > AI_DIFF_PREVIEW_LENGTH) {
          prompt += '... (truncated)\n';
        }
      }

      prompt += '\n';
    });

    prompt += `\nPlease provide ${AI_MAX_SUGGESTIONS} commit message suggestions in JSON format with the following structure:\n`;
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

  private getMaxLengthForStyle = (style: 'conventional' | 'descriptive' | 'minimal'): number => {
    switch (style) {
      case 'conventional':
        return 72; // Standard for conventional commits with type(scope): format
      case 'descriptive':
        return 96; // Longer for detailed descriptions
      case 'minimal':
        return 50; // Shorter for concise messages
      default:
        return 72;
    }
  }

  private getDefaultPrompt = (config: CommitConfig): string => {
    let prompt = 'You are an expert Git commit message generator. ';

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
        prompt += 'Generate highly descriptive commit messages in past tense with capital letters:\n';
        prompt += '- Clearly explain WHAT was changed, WHY it was changed, and HOW it impacts the system\n';
        prompt += '- Be specific about the functionality, methods, or business logic involved\n';
        prompt += '- Include context about the problem being solved or feature being added\n';
        prompt += '- Examples:\n';
        prompt += '  * "Implemented comprehensive error handling with retry logic for API requests to prevent timeout failures"\n';
        prompt += '  * "Refactored user authentication system to use JWT tokens instead of session cookies for better scalability"\n';
        prompt += '  * "Added E2E test spec for complete user registration flow including email verification"\n';
        prompt += '  * "Updated page object model with new CSS selectors after login UI redesign"\n';
        prompt += '  * "Fixed memory leak in WebSocket event listener cleanup that caused browser crashes"\n';
        prompt += '  * "Enhanced form validation to include real-time feedback and accessibility improvements"\n';
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

    const maxLength = this.getMaxLengthForStyle(config.style || 'conventional');
    prompt += `\nKeep first line under ${maxLength} characters. `;
    prompt += 'Avoid vague terms like "updated", "changed", "modified" without context. ';
    prompt += 'Be specific about the actual functionality or improvement implemented. ';

    return prompt;
  }

  private analyzeChanges = (diffs: GitDiff[]) => {
    const primaryDiff = diffs[0];

    return {
      commitType: analyzeCommitType(diffs),
      scope: extractScope(primaryDiff.file),
      description: generateDescription(primaryDiff),
      fileCount: diffs.length,
      totalAdditions: diffs.reduce((sum, diff) => sum + diff.additions, 0),
      totalDeletions: diffs.reduce((sum, diff) => sum + diff.deletions, 0)
    };
  }

  private buildEnhancedPrompt = (diffs: GitDiff[], config: CommitConfig, analysis: any): string => {
    let prompt = this.getDefaultPrompt(config);

    prompt += `\n\nChange Analysis Context:\n`;
    prompt += `- Suggested commit type: ${analysis.commitType}\n`;
    prompt += `- File scope: ${analysis.scope || 'general'}\n`;
    prompt += `- Suggested description: ${analysis.description}\n`;
    prompt += `- Total changes: +${analysis.totalAdditions}/-${analysis.totalDeletions}\n`;

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

  private validateAndImprove = (suggestions: CommitSuggestion[], analysis: any): CommitSuggestion[] => {
    return suggestions.map(suggestion => {
      const validation = validateMessage(suggestion.message);

      if (!validation.valid) {
        let improvedMessage = suggestion.message;

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

  private parseResponse = (response: string, config: CommitConfig): CommitSuggestion[] => {
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
    } catch (error) {
      console.warn('Failed to parse JSON response, falling back to text parsing');
    }

    return this.parseTextResponse(response, config);
  }

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

    if (suggestions.length === 0) {
      suggestions.push({
        message: 'Update files',
        description: 'Generated fallback commit message',
        confidence: 0.3
      });
    }

    return suggestions.slice(0, AI_MAX_SUGGESTIONS);
  }

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
