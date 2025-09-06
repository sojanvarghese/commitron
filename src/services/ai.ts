import { GoogleGenerativeAI } from '@google/generative-ai';
import { CommitSuggestion, CommitConfig, GitDiff, CommitType } from '../types/index.js';
import { ConfigManager } from '../config/index.js';

export class AIService {
  private genAI: GoogleGenerativeAI;
  private config: ConfigManager;

  constructor() {
    this.config = ConfigManager.getInstance();
    const apiKey = this.config.getApiKey();

    if (!apiKey) {
      throw new Error('Gemini API key not found. Please set GEMINI_API_KEY environment variable or configure it with "commit-x config set apiKey YOUR_API_KEY"');
    }

    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  /**
   * Generate commit message suggestions based on git diffs
   */
  async generateCommitMessage(diffs: GitDiff[]): Promise<CommitSuggestion[]> {
    const config = this.config.getConfig();
    const model = this.genAI.getGenerativeModel({ model: config.model || 'gemini-1.5-flash' });

    const prompt = this.buildPrompt(diffs, config);

    try {
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();

      return this.parseResponse(text, config);
    } catch (error) {
      throw new Error(`Failed to generate commit message: ${error}`);
    }
  }

  /**
   * Build the prompt for AI based on configuration and changes
   */
  private buildPrompt(diffs: GitDiff[], config: CommitConfig): string {
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
  private getDefaultPrompt(config: CommitConfig): string {
    let prompt = 'You are an expert Git commit message generator. ';

    switch (config.style) {
      case 'conventional':
        prompt += 'Generate commit messages following the Conventional Commits specification (https://conventionalcommits.org/). ';
        prompt += 'Use types like feat, fix, docs, style, refactor, perf, test, build, ci, chore. ';
        prompt += 'Format: type(scope): description. ';
        break;

      case 'descriptive':
        prompt += 'Generate descriptive commit messages that clearly explain what was changed and why. ';
        prompt += 'Use imperative mood and be specific about the changes. ';
        break;

      case 'minimal':
        prompt += 'Generate concise, minimal commit messages that capture the essence of the change. ';
        prompt += 'Keep messages short but meaningful. ';
        break;
    }

    prompt += `Keep messages under ${config.maxLength || 72} characters for the first line. `;
    prompt += 'Focus on the "what" and "why" of the changes. ';
    prompt += 'Be specific and avoid generic messages like "update files" or "fix bug". ';

    return prompt;
  }

  /**
   * Parse AI response and extract commit suggestions
   */
  private parseResponse(response: string, config: CommitConfig): CommitSuggestion[] {
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
  private parseTextResponse(response: string, config: CommitConfig): CommitSuggestion[] {
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
  validateCommitMessage(message: string, style: string): { valid: boolean; errors: string[] } {
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
