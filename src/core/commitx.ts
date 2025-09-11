import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import process from 'process';
import { match } from 'ts-pattern';
import { GitService } from '../services/git.js';
import { AIService } from '../services/ai.js';
import type { CommitOptions, CommitSuggestion, GitDiff } from '../types/common.js';
import { getFileTypeFromExtension } from '../schemas/validation.js';
import { LARGE_FILE_THRESHOLD } from '../constants/ai.js';
import { WARNING_MESSAGES, SUCCESS_MESSAGES, INFO_MESSAGES } from '../constants/messages.js';
import { UI_CONSTANTS } from '../constants/ui.js';
import { FILE_TYPE_CONFIGS, PATTERNS } from '../constants/commitx.js';

export class CommitX {
  private readonly gitService: GitService;
  private aiService: AIService | null = null;

  constructor() {
    this.gitService = new GitService();
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

  commit = async (options: CommitOptions = {}): Promise<void> => {
    try {
      // DEBUG: Log commit options and environment
      console.log(chalk.gray(`🔍 DEBUG: Starting commit with options: ${JSON.stringify(options, null, 2)}`));
      console.log(chalk.gray(`🔍 DEBUG: Current working directory: ${process.cwd()}`));
      console.log(chalk.gray(`🔍 DEBUG: Process arguments: ${process.argv.join(' ')}`));

      if (!(await this.gitService.isGitRepository())) {
        throw new Error(
          'Not a git repository. Please run this command from within a git repository.'
        );
      }

      console.log(chalk.gray(`🔍 DEBUG: Git repository validation passed`));

      if (options.message || options.all) {
        console.log(chalk.gray(`🔍 DEBUG: Using traditional commit workflow`));
        return this.commitTraditional(options);
      }

      const unstagedFiles = await this.gitService.getUnstagedFiles();
      console.log(chalk.gray(`🔍 DEBUG: Found ${unstagedFiles.length} unstaged files: ${JSON.stringify(unstagedFiles)}`));

      if (unstagedFiles.length === 0) {
        console.log(chalk.yellow(WARNING_MESSAGES.NO_CHANGES_DETECTED));
        return;
      }

      let processedCount = 0;

      // Optimize for multiple files: use batch processing when beneficial
      if (unstagedFiles.length > 1) {
        console.log(chalk.gray(`🔍 DEBUG: Using batch processing for ${unstagedFiles.length} files`));
        processedCount = await this.commitFilesBatch(unstagedFiles, options);
      } else {
        console.log(chalk.gray(`🔍 DEBUG: Using individual processing for single file`));
        // Fall back to individual processing for single files
        for (const file of unstagedFiles) {
          try {
            console.log(chalk.gray(`🔍 DEBUG: Processing individual file: ${file}`));
            const success = await this.commitIndividualFile(file, options);
            if (success) {
              processedCount++;
              console.log(chalk.gray(`🔍 DEBUG: Successfully processed file: ${file}`));
            } else {
              console.log(chalk.gray(`🔍 DEBUG: Failed to process file: ${file}`));
            }
          } catch (error) {
            const fileName = file.split('/').pop() || file;
            console.error(chalk.red(`Failed to process ${fileName}: ${error}`));
            console.log(chalk.gray(`🔍 DEBUG: Error details for ${fileName}: ${error}`));
          }
        }
      }

      if (processedCount > 0) {
        console.log(
          chalk.green(
            `\n✅ Successfully processed ${processedCount} of ${unstagedFiles.length} files`
          )
        );
      }

      console.log(chalk.gray(`🔍 DEBUG: Commit process completed. Processed: ${processedCount}, Dry run: ${options.dryRun}`));

      // Force exit to prevent delay from lingering HTTP connections
      if (options.dryRun || processedCount > 0) {
        console.log(chalk.gray(`🔍 DEBUG: Scheduling process exit in ${UI_CONSTANTS.EXIT_DELAY_MS}ms`));
        setTimeout(() => process.exit(0), UI_CONSTANTS.EXIT_DELAY_MS);
      }
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
      console.log(chalk.gray(`🔍 DEBUG: Fatal error in commit process: ${error}`));
      process.exit(1);
    }
  };

  private readonly commitTraditional = async (options: CommitOptions): Promise<void> => {
    const status = await this.gitService.getStatus();

    if (status.staged.length === 0) {
      if (status.unstaged.length > 0 || status.untracked.length > 0) {
        const shouldStage = await this.promptStageFiles(status);
        if (shouldStage) {
          const spinner = ora(UI_CONSTANTS.SPINNER_MESSAGES.STAGING).start();
          await this.gitService.stageAll();
          spinner.succeed(SUCCESS_MESSAGES.FILES_STAGED);
        } else {
          console.log(chalk.yellow(WARNING_MESSAGES.NO_FILES_STAGED));
          return;
        }
      } else {
        console.log(chalk.yellow(WARNING_MESSAGES.NO_CHANGES_DETECTED));
        return;
      }
    }

    const commitMessage: string =
      options.message ?? (await this.generateCommitMessage(options.interactive));

    if (!commitMessage) {
      console.log(chalk.yellow(WARNING_MESSAGES.NO_COMMIT_MESSAGE));
      return;
    }

    if (options.dryRun) {
      console.log(chalk.blue(INFO_MESSAGES.DRY_RUN_COMMIT));
      console.log(chalk.white(`"${commitMessage}"`));
      return;
    }

    const commitSpinner = ora(UI_CONSTANTS.SPINNER_MESSAGES.COMMITTING).start();
    await this.gitService.commit(commitMessage);
    commitSpinner.succeed(`Committed: ${chalk.green(commitMessage)}`);

    if (options.push === true) {
      const pushSpinner = ora(UI_CONSTANTS.SPINNER_MESSAGES.PUSHING).start();
      try {
        await this.gitService.push();
        pushSpinner.succeed(SUCCESS_MESSAGES.CHANGES_PUSHED);
      } catch (error) {
        pushSpinner.fail(`${WARNING_MESSAGES.FAILED_TO_PUSH} ${error}`);
      }
    }

    // Force exit to prevent delay from lingering HTTP connections
    setTimeout(() => process.exit(0), UI_CONSTANTS.EXIT_DELAY_MS);
  };

  private readonly commitFilesBatch = async (
    files: string[],
    options: CommitOptions
  ): Promise<number> => {
    const spinner = ora('Analyzing files for batch processing...').start();

    try {
      // Analyze and categorize files
      const { aiEligibleFiles, summaryFiles, skippedFiles } =
        await this.analyzeFilesForBatch(files);

      spinner.succeed(
        `Analyzed ${files.length} files: ${aiEligibleFiles.length} for AI processing, ${summaryFiles.length} for summary messages`
      );

      // Generate AI commit messages
      const aiCommitMessages = await this.generateBatchCommitMessages(aiEligibleFiles);
      const processedCount = await this.processBatchCommits(
        aiEligibleFiles,
        summaryFiles,
        aiCommitMessages,
        options
      );

      if (skippedFiles.length > 0) {
        console.log(
          chalk.yellow(`Skipped ${skippedFiles.length} files (empty or failed analysis)`)
        );
      }

      return processedCount;
    } catch (error) {
      spinner.fail('Batch processing failed');
      console.error(chalk.red(`Batch processing error: ${error}`));
      return 0;
    }
  };

  private readonly analyzeFilesForBatch = async (files: string[]) => {
      const aiEligibleFiles: { file: string; diff: GitDiff }[] = [];
      const summaryFiles: { file: string; diff: GitDiff }[] = [];
      const skippedFiles: string[] = [];

      for (const file of files) {
        try {
          const fileName = file.split('/').pop() || file;
          const fileDiff = await this.gitService.getFileDiff(file, false);
          const totalChanges = fileDiff.additions + fileDiff.deletions;

          // Skip truly empty files
        if (this.shouldSkipFile(fileDiff, totalChanges)) {
          this.logSkippedFile(fileName, fileDiff);
            skippedFiles.push(file);
            continue;
          }

          // Categorize files
          if (this.shouldUseSummaryMessage(file, totalChanges)) {
            summaryFiles.push({ file, diff: fileDiff });
          } else {
            aiEligibleFiles.push({ file, diff: fileDiff });
          }
        } catch (error) {
          const fileName = file.split('/').pop() || file;
          console.error(chalk.red(`  Failed to analyze ${fileName}: ${error}`));
          skippedFiles.push(file);
        }
      }

    return { aiEligibleFiles, summaryFiles, skippedFiles };
  };

  private readonly shouldSkipFile = (fileDiff: GitDiff, totalChanges: number): boolean => {
    return (
      totalChanges === 0 &&
      (!fileDiff.changes || fileDiff.changes.trim() === '') &&
      !fileDiff.isDeleted
    );
  };

  private readonly logSkippedFile = (fileName: string, fileDiff: GitDiff): void => {
    if (fileDiff.isNew) {
      console.log(chalk.yellow(`  Skipping empty new file: ${fileName}`));
    } else {
      console.log(chalk.yellow(`  Skipping file with no changes: ${fileName}`));
    }
  };

  private readonly generateBatchCommitMessages = async (
    aiEligibleFiles: { file: string; diff: GitDiff }[]
  ) => {
    const aiCommitMessages: { [filename: string]: string } = {};

    if (aiEligibleFiles.length === 0) {
      return aiCommitMessages;
    }

        const aiSpinner = ora(
          `Generating commit messages for ${aiEligibleFiles.length} files...`
        ).start();

        try {
          const aiDiffs = aiEligibleFiles.map((item) => item.diff);
          const batchResults = await this.getAIService().generateBatchCommitMessages(aiDiffs);

          // Extract the first (best) commit message for each file
          for (const { file } of aiEligibleFiles) {
            const suggestions = batchResults[file];
            aiCommitMessages[file] =
              suggestions?.[0]?.message ??
              this.generateFallbackCommitMessage(
                file,
                aiEligibleFiles.find((item) => item.file === file)!.diff
              );
          }
          aiSpinner.succeed(`Generated ${Object.keys(aiCommitMessages).length} AI commit messages`);
        } catch (error) {
          aiSpinner.fail('AI generation failed, using fallback messages');
          console.warn(chalk.yellow('Using fallback messages due to AI error:'), error);

          // Generate fallback messages for all AI-eligible files
          for (const { file, diff } of aiEligibleFiles) {
            aiCommitMessages[file] = this.generateFallbackCommitMessage(file, diff);
      }
    }

    return aiCommitMessages;
  };

  private readonly processBatchCommits = async (
    aiEligibleFiles: { file: string; diff: GitDiff }[],
    summaryFiles: { file: string; diff: GitDiff }[],
    aiCommitMessages: { [filename: string]: string },
    options: CommitOptions
  ): Promise<number> => {
    console.log(chalk.gray(`🔍 DEBUG: Starting batch commit processing`));
    console.log(chalk.gray(`🔍 DEBUG: AI eligible files: ${aiEligibleFiles.length}, Summary files: ${summaryFiles.length}`));
    console.log(chalk.gray(`🔍 DEBUG: Options: ${JSON.stringify(options, null, 2)}`));

    const commitSpinner = ora(
      options.dryRun ? 'Analyzing files...' : 'Committing files...'
    ).start();
    let processedCount = 0;

      // Process AI-eligible files
    console.log(chalk.gray(`🔍 DEBUG: Processing ${aiEligibleFiles.length} AI-eligible files`));
      for (const { file, diff } of aiEligibleFiles) {
        try {
        const fileName = file.split('/').pop() || file;
          const commitMessage = aiCommitMessages[file];
        console.log(chalk.gray(`🔍 DEBUG: Processing AI file: ${fileName}, message: "${commitMessage}"`));

        if (options.dryRun) {
          console.log(chalk.blue(`  Would stage and commit: ${fileName}`));
          console.log(chalk.gray(`  Changes: +${diff.additions}/-${diff.deletions}`));
          console.log(chalk.blue(`  Message: "${commitMessage}"`));
          console.log(chalk.gray(`🔍 DEBUG: Dry run - not actually committing ${fileName}`));
        } else {
          console.log(chalk.gray(`🔍 DEBUG: Staging AI file: ${file}`));
          await this.gitService.stageFile(file);
          console.log(chalk.gray(`🔍 DEBUG: Committing AI file: ${file} with message: "${commitMessage}"`));
          await this.gitService.commit(commitMessage);
          console.log(chalk.green(`✅ ${fileName}: ${commitMessage}`));
          console.log(chalk.gray(`🔍 DEBUG: Successfully committed AI file: ${fileName}`));
        }
          processedCount++;
        } catch (error) {
          const fileName = file.split('/').pop() || file;
        console.error(chalk.red(`  Failed to process ${fileName}: ${error}`));
        console.log(chalk.gray(`🔍 DEBUG: Error processing AI file ${fileName}: ${error}`));
        }
      }

      // Process summary files
    console.log(chalk.gray(`🔍 DEBUG: Processing ${summaryFiles.length} summary files`));
      for (const { file, diff } of summaryFiles) {
        try {
        const fileName = file.split('/').pop() || file;
          const commitMessage = this.generateSummaryCommitMessage(file, diff);
        console.log(chalk.gray(`🔍 DEBUG: Processing summary file: ${fileName}, message: "${commitMessage}"`));

        if (options.dryRun) {
          console.log(chalk.blue(`  Would stage and commit: ${fileName}`));
          console.log(chalk.gray(`  Changes: +${diff.additions}/-${diff.deletions}`));
          console.log(chalk.blue(`  Message: "${commitMessage}"`));
          console.log(chalk.gray(`🔍 DEBUG: Dry run - not actually committing ${fileName}`));
        } else {
          console.log(chalk.gray(`🔍 DEBUG: Staging summary file: ${file}`));
          await this.gitService.stageFile(file);
          console.log(chalk.gray(`🔍 DEBUG: Committing summary file: ${file} with message: "${commitMessage}"`));
          await this.gitService.commit(commitMessage);
          console.log(chalk.green(`✅ ${fileName}: ${commitMessage}`));
          console.log(chalk.gray(`🔍 DEBUG: Successfully committed summary file: ${fileName}`));
        }
          processedCount++;
        } catch (error) {
          const fileName = file.split('/').pop() || file;
        console.error(chalk.red(`  Failed to process ${fileName}: ${error}`));
        console.log(chalk.gray(`🔍 DEBUG: Error processing summary file ${fileName}: ${error}`));
        }
      }

    console.log(chalk.gray(`🔍 DEBUG: Batch processing completed. Processed: ${processedCount} files`));
      commitSpinner.succeed(`Committed ${processedCount} files successfully`);
      return processedCount;
  };

  private readonly commitIndividualFile = async (
    file: string,
    options: CommitOptions
  ): Promise<boolean> => {
    try {
      const fileName = file.split('/').pop() || file;
      console.log(chalk.cyan(`Processing: ${fileName}`));
      console.log(chalk.gray(`🔍 DEBUG: Processing file: ${file}, options: ${JSON.stringify(options, null, 2)}`));

      const fileDiff = await this.gitService.getFileDiff(file, false);
      const totalChanges = fileDiff.additions + fileDiff.deletions;
      console.log(chalk.gray(`🔍 DEBUG: File diff for ${fileName}: ${JSON.stringify({
        additions: fileDiff.additions,
        deletions: fileDiff.deletions,
        totalChanges,
        isNew: fileDiff.isNew,
        isDeleted: fileDiff.isDeleted,
        changesLength: fileDiff.changes?.length || 0
      })}`));

      // Skip truly empty files (no changes and no content) - but NOT deleted files
      if (
        totalChanges === 0 &&
        (!fileDiff.changes || fileDiff.changes.trim() === '') &&
        !fileDiff.isDeleted
      ) {
        if (fileDiff.isNew) {
          console.log(chalk.yellow(`  Skipping empty new file: ${fileName}`));
        } else {
          console.log(chalk.yellow(`  Skipping file with no changes: ${fileName}`));
        }
        console.log(chalk.gray(`🔍 DEBUG: Skipped file ${fileName} - no changes`));
        return false;
      }

      if (options.dryRun) {
        console.log(chalk.blue(`  Would stage and commit: ${fileName}`));
        console.log(chalk.gray(`  Changes: +${fileDiff.additions}/-${fileDiff.deletions}`));
        console.log(chalk.gray(`🔍 DEBUG: Dry run mode - not actually committing`));

        // Generate and show the commit message that would be used
        try {
          const spinner = ora('  Generating commit message...').start();
          const shouldUseSummary = this.shouldUseSummaryMessage(file, totalChanges);
          console.log(chalk.gray(`🔍 DEBUG: Should use summary message: ${shouldUseSummary}`));
          
          const commitMessage = shouldUseSummary
            ? this.generateSummaryCommitMessage(file, fileDiff)
            : ((await this.getAIService().generateCommitMessage([fileDiff]))[0]?.message ??
              `Updated ${fileName}`);
          spinner.succeed();
          console.log(chalk.blue(`  Message: "${commitMessage}"`));
          console.log(chalk.gray(`🔍 DEBUG: Generated commit message: "${commitMessage}"`));
        } catch (error) {
          console.log(chalk.gray(`🔍 DEBUG: AI generation failed, using fallback: ${error}`));
          const fallbackMessage = this.shouldUseSummaryMessage(file, totalChanges)
            ? this.generateSummaryCommitMessage(file, fileDiff)
            : this.generateFallbackCommitMessage(file, fileDiff);
          console.log(chalk.gray(`  Message: "${fallbackMessage}" (AI generation failed)`));
        }

        return true;
      }

      console.log(chalk.gray(`🔍 DEBUG: Staging file: ${file}`));
      await this.gitService.stageFile(file);
      console.log(chalk.gray(`🔍 DEBUG: Successfully staged file: ${file}`));

      let commitMessage: string;

      // For files with many changes or specific file types, use summary message
      const shouldUseSummary = this.shouldUseSummaryMessage(file, totalChanges);
      console.log(chalk.gray(`🔍 DEBUG: Should use summary message: ${shouldUseSummary}`));
      
      if (shouldUseSummary) {
        commitMessage = this.generateSummaryCommitMessage(file, fileDiff);
        console.log(chalk.gray(`🔍 DEBUG: Using summary message: "${commitMessage}"`));
      } else {
        try {
          console.log(chalk.gray(`🔍 DEBUG: Generating AI commit message for: ${file}`));
          const suggestions = await this.getAIService().generateCommitMessage([fileDiff]);
          commitMessage =
            suggestions[0]?.message ?? this.generateFallbackCommitMessage(file, fileDiff);
          console.log(chalk.gray(`🔍 DEBUG: AI generated message: "${commitMessage}"`));
        } catch (error) {
          console.log(chalk.gray(`🔍 DEBUG: AI generation failed, using fallback: ${error}`));
          commitMessage = this.generateFallbackCommitMessage(file, fileDiff);
          console.log(chalk.gray(`🔍 DEBUG: Using fallback message: "${commitMessage}"`));
        }
      }

      console.log(chalk.gray(`🔍 DEBUG: About to commit with message: "${commitMessage}"`));
      await this.gitService.commit(commitMessage);
      console.log(chalk.green(`✅ Committed: ${commitMessage}`));
      console.log(chalk.gray(`🔍 DEBUG: Successfully committed file: ${file}`));

      return true;
    } catch (error) {
      console.error(chalk.red(`  Failed to process ${file.split('/').pop()}: ${error}`));
      console.log(chalk.gray(`🔍 DEBUG: Error processing file ${file}: ${error}`));
      return false;
    }
  };

  private readonly shouldUseSummaryMessage = (file: string, totalChanges: number): boolean => {
    const fileName = file.toLowerCase();
    const baseName = file.split('/').pop()?.toLowerCase() ?? '';
    const fileType = getFileTypeFromExtension(fileName);

    // Check for lock files (always use summary)
    if (PATTERNS.lockFiles.some((pattern) => fileName.includes(pattern))) {
      return true;
    }

    // Check for generated files (always use summary)
    if (PATTERNS.generatedFiles.some((pattern) => fileName.includes(pattern))) {
      return true;
    }

    // Check for build directories (always use summary)
    if (PATTERNS.buildDirs.some((pattern) => fileName.includes(pattern))) {
      return true;
    }

    // Check for changelog files (always use summary)
    if (PATTERNS.changelogFiles.some((pattern) => fileName.toLowerCase().includes(pattern))) {
      return true;
    }

    // Check for log and temporary files (always use summary)
    if (
      PATTERNS.logFiles.some((pattern) => baseName.includes(pattern) || fileName.includes(pattern))
    ) {
      return true;
    }

    // Check for bundle files (always use summary)
    if (PATTERNS.bundleFiles.some((pattern) => fileName.includes(pattern))) {
      return true;
    }

    // Check for package files with significant changes
    if (PATTERNS.packageFiles.some((pattern) => fileName.includes(pattern)) && totalChanges > 20) {
      return true;
    }

    // Check for large files
    if (totalChanges > LARGE_FILE_THRESHOLD) {
      return true;
    }

    // Check for certain file types with many changes
    if (totalChanges > 50 && ['json', 'xml', 'css', 'scss', 'less'].includes(fileType)) {
      return true;
    }

    // Check for documentation files with many changes
    if (
          totalChanges > 30 &&
          ['markdown', 'unknown'].includes(fileType) &&
      (fileName.endsWith('.md') || fileName.endsWith('.txt') || fileName.endsWith('.rst'))
    ) {
      return true;
    }

    return false;
  };

  private readonly generateSummaryCommitMessage = (file: string, fileDiff: GitDiff): string => {
    const fileName = file.split('/').pop() ?? file;
    const baseName = fileName.toLowerCase();
    const totalChanges = fileDiff.additions + fileDiff.deletions;

    // Helper function to generate dependency change message
    const getDependencyChangeMessage = (config: { name: string; type: string }) => {
      const isAdding = fileDiff.additions > fileDiff.deletions * 2;
      const isRemoving = fileDiff.deletions > fileDiff.additions * 2;

      if (isAdding) return `Added new ${config.type} to ${config.name}`;
      if (isRemoving) return `Removed ${config.type} from ${config.name}`;
      return `Updated ${config.type} in ${config.name}`;
    };

    // Check for lock files
    for (const [pattern, config] of Object.entries(FILE_TYPE_CONFIGS.lockFiles)) {
      if (baseName.includes(pattern)) {
        return getDependencyChangeMessage(config);
      }
    }

    // Check for package files
    for (const [pattern, config] of Object.entries(FILE_TYPE_CONFIGS.packageFiles)) {
      if (baseName.includes(pattern)) {
        return getDependencyChangeMessage(config);
      }
    }

    // Check for changelog files
    for (const [pattern, message] of Object.entries(FILE_TYPE_CONFIGS.changelogFiles)) {
      if (baseName.includes(pattern)) {
        return message;
      }
    }

    // Check for build directories
    for (const [pattern, message] of Object.entries(FILE_TYPE_CONFIGS.buildDirs)) {
      if (file.includes(pattern)) {
        return message;
      }
    }

    // Check for generated files
    if (
          file.includes('.generated.') ||
          file.includes('.auto.') ||
          file.includes('.min.') ||
          file.includes('.bundle.') ||
      file.includes('.chunk.')
    ) {
      return `Updated generated file ${fileName}`;
    }

    // Check for compiled files
    if (
          file.includes('/dist/') ||
          file.includes('/build/') ||
          file.includes('/out/') ||
      file.includes('/target/')
    ) {
      return `Updated compiled ${fileName}`;
    }

    // Check for bundle files
    if (
      baseName.includes('.map') ||
      baseName.includes('.bundle') ||
      baseName.includes('.chunk') ||
      baseName.includes('.vendor')
    ) {
      return `Updated bundled ${fileName}`;
    }

    // Check for log and temporary files
    if (
      baseName.includes('.log') ||
          file.includes('/logs/') ||
      baseName.includes('.cache') ||
      baseName.includes('.tmp') ||
      baseName.includes('.temp')
    ) {
      return `Updated ${fileName}`;
    }

    // Check for large files
    if (totalChanges > LARGE_FILE_THRESHOLD) {
      return `Implemented comprehensive functionality in ${fileName}`;
    }

    // Check for configuration files
    if (baseName.endsWith('.json') && totalChanges > 50) {
      return `Updated ${fileName} configuration`;
    }

    // Check for style files
    if (
          (baseName.endsWith('.css') || baseName.endsWith('.scss') || baseName.endsWith('.less')) &&
      totalChanges > 50
    ) {
      return `Updated ${fileName} styles`;
    }

    // Check for documentation files
    if (
          (baseName.endsWith('.md') || baseName.endsWith('.txt') || baseName.endsWith('.rst')) &&
      totalChanges > 30
    ) {
      return `Updated ${fileName} documentation`;
    }

    return `Updated ${fileName} functionality`;
  };

  private readonly generateFallbackCommitMessage = (file: string, fileDiff: GitDiff): string => {
    const fileName = file.split('/').pop() ?? file;

    return match(fileDiff)
      .when(
        (diff) => diff.isNew,
        () => `Created new ${fileName} file with initial implementation`
      )
      .when(
        (diff) => diff.isDeleted,
        () => `Removed ${fileName} file as it is no longer needed`
      )
      .when(
        (diff) => diff.additions > diff.deletions * 2,
        () => `Added new functionality and features to ${fileName} file`
      )
      .when(
        (diff) => diff.deletions > diff.additions * 2,
        () => `Removed unused code and functions from ${fileName} file`
      )
      .otherwise(() => `Modified ${fileName} file with code improvements and updates`);
  };

  private readonly generateCommitMessage = async (interactive: boolean = true): Promise<string> => {
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
  };

  private readonly promptCommitSelection = async (
    suggestions: CommitSuggestion[],
    file?: string
  ): Promise<string> => {
    const choices = suggestions.map((suggestion) => ({
      name: `${chalk.green(suggestion.message)}${suggestion.description ? chalk.gray(` - ${suggestion.description}`) : ''}`,
      value: suggestion.message,
      short: suggestion.message,
    }));

    choices.push({
      name: chalk.blue('✏️  Write custom message'),
      value: 'custom',
      short: 'Custom',
    });

    if (file) {
      choices.push({ name: chalk.yellow('⏭️  Skip this file'), value: 'skip', short: 'Skip' });
    }

    choices.push({ name: chalk.red('❌ Cancel'), value: 'cancel', short: 'Cancel' });

    const message = file
      ? `Select commit message for ${chalk.cyan(file)}:`
      : 'Select a commit message:';

    const { selected } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selected',
        message,
        choices,
        pageSize: 10,
      },
    ]);

    switch (selected) {
      case 'cancel':
      case 'skip':
        return '';

      case 'custom':
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
            },
          },
        ]);
        return customMessage;

      default:
        return selected;
    }
  };

  private readonly promptStageFiles = async (status: {
    unstaged: string[];
    untracked: string[];
  }): Promise<boolean> => {
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
        default: true,
      },
    ]);

    return shouldStage;
  };

  status = async (): Promise<void> => {
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
        status.staged.forEach((file) => console.log(`  ${chalk.green('A')} ${file}`));
        console.log();
      }

      if (status.unstaged.length > 0) {
        console.log(chalk.yellow('📝 Unstaged changes:'));
        status.unstaged.forEach((file) => console.log(`  ${chalk.yellow('M')} ${file}`));
        console.log();
      }

      if (status.untracked.length > 0) {
        console.log(chalk.red('❓ Untracked files:'));
        status.untracked.forEach((file) => console.log(`  ${chalk.red('??')} ${file}`));
        console.log();
      }

      console.log(
        status.total === 0
          ? chalk.green('✨ Working directory is clean')
          : chalk.blue(`📊 Total changes: ${status.total}`)
      );

      // Show last commit
      const lastCommit = await this.gitService.getLastCommitMessage();
      if (lastCommit) {
        console.log(chalk.gray(`\n💬 Last commit: "${lastCommit}"`));
      }

      // Force exit to prevent delay
      setTimeout(() => process.exit(0), 100);
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
      process.exit(1);
    }
  };

  diff = async (): Promise<void> => {
    try {
      if (!(await this.gitService.isGitRepository())) {
        console.log(chalk.red('Not a git repository'));
        setTimeout(() => process.exit(1), 100);
        return;
      }

      const summary = await this.gitService.getChangesSummary();
      console.log(chalk.blue('📋 Changes Summary:'));
      console.log();
      console.log(summary);

      // Force exit to prevent delay
      setTimeout(() => process.exit(0), 100);
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
      process.exit(1);
    }
  };
}
