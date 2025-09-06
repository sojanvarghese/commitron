/// <reference path="../types/global.d.ts" />

import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import process from 'process';
import { GitService } from '../services/git.js';
import { AIService } from '../services/ai.js';
import { ConfigManager } from '../config/index.js';
import { CommitOptions, CommitSuggestion } from '../types/index.js';

export class CommitX {
  private gitService: GitService;
  private aiService: AIService | null = null;
  private config: ConfigManager;

  constructor() {
    this.gitService = new GitService();
    this.config = ConfigManager.getInstance();
    // AIService will be lazily loaded when needed
  }

  /**
   * Get AI service instance (lazy loading)
   */
  private getAIService(): AIService {
    if (!this.aiService) {
      try {
        this.aiService = new AIService();
      } catch (error) {
        throw new Error(`Failed to initialize AI service: ${error}`);
      }
    }
    return this.aiService;
  }

  /**
   * Main commit flow - now processes files individually
   */
  async commit(options: CommitOptions = {}): Promise<void> {
    try {
      // Check if we're in a git repository
      if (!(await this.gitService.isGitRepository())) {
        throw new Error('Not a git repository. Please run this command from within a git repository.');
      }

      // If a specific message is provided or --all flag is used, use traditional workflow
      if (options.message || options.all) {
        return this.commitTraditional(options);
      }

      // Get unstaged files for individual processing
      const unstagedFiles = await this.gitService.getUnstagedFiles();

      if (unstagedFiles.length === 0) {
        console.log(chalk.yellow('No changes detected. Working directory is clean.'));
        return;
      }

      // Process each file individually (non-interactive by default)
      let processedCount = 0;
      for (const file of unstagedFiles) {
        try {
          const success = await this.commitIndividualFile(file, options);
          if (success) {
            processedCount++;
          }
        } catch (error) {
          const fileName = file.split('/').pop() || file;
          console.error(chalk.red(`Failed to process ${fileName}: ${error}`));
        }
      }

      if (processedCount > 0) {
        console.log(chalk.green(`\n✅ Successfully processed ${processedCount} of ${unstagedFiles.length} files`));
      }

    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
      process.exit(1);
    }
  }

  /**
   * Traditional commit workflow when message is provided or --all flag is used
   */
  private async commitTraditional(options: CommitOptions): Promise<void> {
    const status = await this.gitService.getStatus();

    if (status.staged.length === 0) {
      if (status.unstaged.length > 0 || status.untracked.length > 0) {
        const shouldStage = await this.promptStageFiles(status);
        if (shouldStage) {
          const spinner = ora('Staging files...').start();
          await this.gitService.stageAll();
          spinner.succeed('Files staged successfully');
        } else {
          console.log(chalk.yellow('No files staged. Aborting commit.'));
          return;
        }
      } else {
        console.log(chalk.yellow('No changes detected. Working directory is clean.'));
        return;
      }
    }

    // Generate commit message if not provided (when using --all flag)
    let commitMessage: string;

    if (options.message) {
      commitMessage = options.message;
    } else {
      commitMessage = await this.generateCommitMessage(options.interactive);
    }

    if (!commitMessage) {
      console.log(chalk.yellow('No commit message provided. Aborting commit.'));
      return;
    }

    // Dry run check
    if (options.dryRun) {
      console.log(chalk.blue('Dry run - would commit with message:'));
      console.log(chalk.white(`"${commitMessage}"`));
      return;
    }

    // Commit changes
    const commitSpinner = ora('Creating commit...').start();
    await this.gitService.commit(commitMessage);
    commitSpinner.succeed(`Committed: ${chalk.green(commitMessage)}`);

    // Push if explicitly requested (disabled autoPush to prevent unwanted pushes)
    if (options.push === true) {
      const pushSpinner = ora('Pushing to remote...').start();
      try {
        await this.gitService.push();
        pushSpinner.succeed('Changes pushed successfully');
      } catch (error) {
        pushSpinner.fail(`Failed to push: ${error}`);
      }
    }
  }

  /**
   * Process and commit an individual file
   */
  private commitIndividualFile = async (file: string, options: CommitOptions): Promise<boolean> => {
    try {
      // Extract just the filename from the full path
      const fileName = file.split('/').pop() || file;
      console.log(chalk.cyan(`Processing: ${fileName}`));

      // Get diff for this specific file
      const fileDiff = await this.gitService.getFileDiff(file, false);

      // Dry run check
      if (options.dryRun) {
        console.log(chalk.blue(`  Would stage and commit: ${fileName}`));
        console.log(chalk.gray(`  Changes: +${fileDiff.additions}/-${fileDiff.deletions}`));
        return true;
      }

      // Stage the file (silent)
      await this.gitService.stageFile(file);

      // Generate commit message for this file (silent)
      const suggestions = await this.getAIService().generateCommitMessage([fileDiff]);

      // Automatically use the best AI-generated commit message
      const commitMessage = suggestions[0]?.message || `Update ${fileName}`;

      // Commit the file (silent)
      await this.gitService.commit(commitMessage);
      console.log(chalk.green(`✅ Committed: ${commitMessage}`));

      return true;

    } catch (error) {
      console.error(chalk.red(`  Failed to process ${file.split('/').pop()}: ${error}`));
      return false;
    }
  }

  /**
   * Generate commit message using AI
   */
  private generateCommitMessage = async (interactive: boolean = true): Promise<string> => {
    const spinner = ora('Analyzing changes...').start();

    try {
      // Get staged changes
      const diffs = await this.gitService.getStagedDiff();

      if (diffs.length === 0) {
        spinner.fail('No staged changes found');
        return '';
      }

      spinner.text = 'Generating commit messages...';

      const suggestions = await this.getAIService().generateCommitMessage(diffs);

      spinner.succeed(`Generated ${suggestions.length} commit message suggestions`);

      if (!interactive || !process.stdin.isTTY) {
        // Non-interactive mode - return the best suggestion
        return suggestions[0]?.message || '';
      }

      // Interactive mode - let user choose
      return await this.promptCommitSelection(suggestions);

    } catch (error) {
      spinner.fail(`Failed to generate commit message: ${error}`);
      throw error;
    }
  }

  /**
   * Prompt user to select a commit message
   */
  private promptCommitSelection = async (suggestions: CommitSuggestion[], file?: string): Promise<string> => {
    const choices = suggestions.map((suggestion, index) => ({
      name: `${chalk.green(suggestion.message)}${suggestion.description ? chalk.gray(` - ${suggestion.description}`) : ''}`,
      value: suggestion.message,
      short: suggestion.message
    }));

    choices.push(
      { name: chalk.blue('✏️  Write custom message'), value: 'custom', short: 'Custom' }
    );

    // Add skip option for individual file processing
    if (file) {
      choices.push({ name: chalk.yellow('⏭️  Skip this file'), value: 'skip', short: 'Skip' });
    }

    choices.push({ name: chalk.red('❌ Cancel'), value: 'cancel', short: 'Cancel' });

    const message = file ? `Select commit message for ${chalk.cyan(file)}:` : 'Select a commit message:';

    const { selected } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selected',
        message,
        choices,
        pageSize: 10
      }
    ]);

    if (selected === 'cancel') {
      return '';
    }

    if (selected === 'skip') {
      return '';
    }

    if (selected === 'custom') {
      const { customMessage } = await inquirer.prompt([
        {
          type: 'input',
          name: 'customMessage',
          message: `Enter commit message${file ? ` for ${chalk.cyan(file)}` : ''}:`,
          validate: (input: string) => {
            if (!input.trim()) {
              return 'Commit message cannot be empty';
            }
            if (input.length > 72) {
              return 'First line should be 72 characters or less';
            }
            return true;
          }
        }
      ]);
      return customMessage;
    }

    return selected;
  }

  /**
   * Prompt user to stage files
   */
  private async promptStageFiles(status: { unstaged: string[]; untracked: string[] }): Promise<boolean> {
    console.log(chalk.yellow('\nUnstaged changes detected:'));

    if (status.unstaged.length > 0) {
      console.log(chalk.yellow('Modified files:'));
      status.unstaged.forEach((file: string) => console.log(`  ${chalk.red('M')} ${file}`));
    }

    if (status.untracked.length > 0) {
      console.log(chalk.yellow('Untracked files:'));
      status.untracked.forEach((file: string) => console.log(`  ${chalk.red('??')} ${file}`));
    }

    const { shouldStage } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'shouldStage',
        message: 'Stage all changes and continue?',
        default: true
      }
    ]);

    return shouldStage;
  }

  /**
   * Show repository status
   */
  async status(): Promise<void> {
    try {
      if (!(await this.gitService.isGitRepository())) {
        console.log(chalk.red('Not a git repository'));
        return;
      }

      const status = await this.gitService.getStatus();
      const repoInfo = await this.gitService.getRepoInfo();

      console.log(chalk.bold(`\n📁 Repository: ${repoInfo.name}`));
      console.log(chalk.bold(`🌿 Branch: ${repoInfo.branch}`));
      console.log();

      if (status.staged.length > 0) {
        console.log(chalk.green('✅ Staged changes:'));
        status.staged.forEach(file => console.log(`  ${chalk.green('A')} ${file}`));
        console.log();
      }

      if (status.unstaged.length > 0) {
        console.log(chalk.yellow('📝 Unstaged changes:'));
        status.unstaged.forEach(file => console.log(`  ${chalk.yellow('M')} ${file}`));
        console.log();
      }

      if (status.untracked.length > 0) {
        console.log(chalk.red('❓ Untracked files:'));
        status.untracked.forEach(file => console.log(`  ${chalk.red('??')} ${file}`));
        console.log();
      }

      if (status.total === 0) {
        console.log(chalk.green('✨ Working directory is clean'));
      } else {
        console.log(chalk.blue(`📊 Total changes: ${status.total}`));
      }

      // Show last commit
      const lastCommit = await this.gitService.getLastCommitMessage();
      if (lastCommit) {
        console.log(chalk.gray(`\n💬 Last commit: "${lastCommit}"`));
      }

    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
    }
  }

  /**
   * Show changes summary
   */
  async diff(): Promise<void> {
    try {
      if (!(await this.gitService.isGitRepository())) {
        console.log(chalk.red('Not a git repository'));
        return;
      }

      const summary = await this.gitService.getChangesSummary();
      console.log(chalk.blue('📋 Changes Summary:'));
      console.log();
      console.log(summary);

    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
    }
  }
}
