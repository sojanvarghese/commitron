import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import process from 'process';
import { GitService } from '../services/git.js';
import { AIService } from '../services/ai.js';
import { ConfigManager } from '../config.js';
import { CommitOptions, CommitSuggestion } from '../types/common.js';

export class CommitX {
  private gitService: GitService;
  private aiService: AIService | null = null;
  private config: ConfigManager;

  constructor() {
    this.gitService = new GitService();
    this.config = ConfigManager.getInstance();
  }

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


  async commit(options: CommitOptions = {}): Promise<void> {
    try {
      if (!(await this.gitService.isGitRepository())) {
        throw new Error('Not a git repository. Please run this command from within a git repository.');
      }

      if (options.message || options.all) {
        return this.commitTraditional(options);
      }

      const unstagedFiles = await this.gitService.getUnstagedFiles();

      if (unstagedFiles.length === 0) {
        console.log(chalk.yellow('No changes detected. Working directory is clean.'));
        return;
      }

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

    if (options.dryRun) {
      console.log(chalk.blue('Dry run - would commit with message:'));
      console.log(chalk.white(`"${commitMessage}"`));
      return;
    }

    const commitSpinner = ora('Creating commit...').start();
    await this.gitService.commit(commitMessage);
    commitSpinner.succeed(`Committed: ${chalk.green(commitMessage)}`);

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


  private commitIndividualFile = async (file: string, options: CommitOptions): Promise<boolean> => {
    try {
      const fileName = file.split('/').pop() || file;
      console.log(chalk.cyan(`Processing: ${fileName}`));

      const fileDiff = await this.gitService.getFileDiff(file, false);

      if (options.dryRun) {
        console.log(chalk.blue(`  Would stage and commit: ${fileName}`));
        console.log(chalk.gray(`  Changes: +${fileDiff.additions}/-${fileDiff.deletions}`));
        return true;
      }

      await this.gitService.stageFile(file);

      const suggestions = await this.getAIService().generateCommitMessage([fileDiff]);

      const commitMessage = suggestions[0]?.message || `Update ${fileName}`;

      await this.gitService.commit(commitMessage);
      console.log(chalk.green(`✅ Committed: ${commitMessage}`));

      return true;

    } catch (error) {
      console.error(chalk.red(`  Failed to process ${file.split('/').pop()}: ${error}`));
      return false;
    }
  }


  private generateCommitMessage = async (interactive: boolean = true): Promise<string> => {
    const spinner = ora('Analyzing changes...').start();

    try {
      const diffs = await this.gitService.getStagedDiff();

      if (diffs.length === 0) {
        spinner.fail('No staged changes found');
        return '';
      }

      spinner.text = 'Generating commit messages...';

      const suggestions = await this.getAIService().generateCommitMessage(diffs);

      spinner.succeed(`Generated ${suggestions.length} commit message suggestions`);

      if (!interactive || !process.stdin.isTTY) {
        return suggestions[0]?.message || '';
      }

      return await this.promptCommitSelection(suggestions);

    } catch (error) {
      spinner.fail(`Failed to generate commit message: ${error}`);
      throw error;
    }
  }


  private promptCommitSelection = async (suggestions: CommitSuggestion[], file?: string): Promise<string> => {
    const choices = suggestions.map((suggestion, index) => ({
      name: `${chalk.green(suggestion.message)}${suggestion.description ? chalk.gray(` - ${suggestion.description}`) : ''}`,
      value: suggestion.message,
      short: suggestion.message
    }));

    choices.push(
      { name: chalk.blue('✏️  Write custom message'), value: 'custom', short: 'Custom' }
    );

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
