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
      if (!(await this.gitService.isGitRepository())) {
        throw new Error(
          'Not a git repository. Please run this command from within a git repository.'
        );
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

      // Optimize for multiple files: use batch processing when beneficial
      if (unstagedFiles.length > 1 && !options.dryRun) {
        processedCount = await this.commitFilesBatch(unstagedFiles, options);
      } else {
        // Fall back to individual processing for dry runs or single files
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
      }

      if (processedCount > 0) {
        console.log(
          chalk.green(
            `\n✅ Successfully processed ${processedCount} of ${unstagedFiles.length} files`
          )
        );
      }

      // Force exit to prevent delay from lingering HTTP connections
      if (options.dryRun || processedCount > 0) {
        setTimeout(() => process.exit(0), 100);
      }
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
      process.exit(1);
    }
  };

  private readonly commitTraditional = async (options: CommitOptions): Promise<void> => {
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

    const commitMessage: string =
      options.message ?? (await this.generateCommitMessage(options.interactive));

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

    // Force exit to prevent delay from lingering HTTP connections
    setTimeout(() => process.exit(0), 100);
  };

  private readonly commitFilesBatch = async (
    files: string[],
    options: CommitOptions
  ): Promise<number> => {
    let processedCount = 0;
    const spinner = ora('Analyzing files for batch processing...').start();

    try {
      // Collect all file diffs and categorize them
      const aiEligibleFiles: { file: string; diff: GitDiff }[] = [];
      const summaryFiles: { file: string; diff: GitDiff }[] = [];
      const skippedFiles: string[] = [];

      for (const file of files) {
        try {
          const fileName = file.split('/').pop() || file;
          const fileDiff = await this.gitService.getFileDiff(file, false);
          const totalChanges = fileDiff.additions + fileDiff.deletions;

          // Skip truly empty files
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

      spinner.succeed(
        `Analyzed ${files.length} files: ${aiEligibleFiles.length} for AI processing, ${summaryFiles.length} for summary messages`
      );

      // Process files requiring AI-generated messages in batch
      let aiCommitMessages: { [filename: string]: string } = {};
      if (aiEligibleFiles.length > 0) {
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
      }

      // Process all files (staging and committing)
      const commitSpinner = ora('Committing files...').start();

      // Process AI-eligible files
      for (const { file, diff } of aiEligibleFiles) {
        try {
          await this.gitService.stageFile(file);
          const commitMessage = aiCommitMessages[file];
          await this.gitService.commit(commitMessage);

          const fileName = file.split('/').pop() || file;
          console.log(chalk.green(`✅ ${fileName}: ${commitMessage}`));
          processedCount++;
        } catch (error) {
          const fileName = file.split('/').pop() || file;
          console.error(chalk.red(`  Failed to commit ${fileName}: ${error}`));
        }
      }

      // Process summary files
      for (const { file, diff } of summaryFiles) {
        try {
          await this.gitService.stageFile(file);
          const commitMessage = this.generateSummaryCommitMessage(file, diff);
          await this.gitService.commit(commitMessage);

          const fileName = file.split('/').pop() || file;
          console.log(chalk.green(`✅ ${fileName}: ${commitMessage}`));
          processedCount++;
        } catch (error) {
          const fileName = file.split('/').pop() || file;
          console.error(chalk.red(`  Failed to commit ${fileName}: ${error}`));
        }
      }

      commitSpinner.succeed(`Committed ${processedCount} files successfully`);

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

  private readonly commitIndividualFile = async (
    file: string,
    options: CommitOptions
  ): Promise<boolean> => {
    try {
      const fileName = file.split('/').pop() || file;
      console.log(chalk.cyan(`Processing: ${fileName}`));

      const fileDiff = await this.gitService.getFileDiff(file, false);
      const totalChanges = fileDiff.additions + fileDiff.deletions;

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
        return false;
      }

      if (options.dryRun) {
        console.log(chalk.blue(`  Would stage and commit: ${fileName}`));
        console.log(chalk.gray(`  Changes: +${fileDiff.additions}/-${fileDiff.deletions}`));

        // Generate and show the commit message that would be used
        try {
          const spinner = ora('  Generating commit message...').start();
          const commitMessage = this.shouldUseSummaryMessage(file, totalChanges)
            ? this.generateSummaryCommitMessage(file, fileDiff)
            : ((await this.getAIService().generateCommitMessage([fileDiff]))[0]?.message ??
              `Updated ${fileName}`);
          spinner.succeed();
          console.log(chalk.blue(`  Message: "${commitMessage}"`));
        } catch {
          const fallbackMessage = this.shouldUseSummaryMessage(file, totalChanges)
            ? this.generateSummaryCommitMessage(file, fileDiff)
            : this.generateFallbackCommitMessage(file, fileDiff);
          console.log(chalk.gray(`  Message: "${fallbackMessage}" (AI generation failed)`));
        }

        return true;
      }

      await this.gitService.stageFile(file);

      let commitMessage: string;

      // For files with many changes or specific file types, use summary message
      if (this.shouldUseSummaryMessage(file, totalChanges)) {
        commitMessage = this.generateSummaryCommitMessage(file, fileDiff);
      } else {
        try {
          const suggestions = await this.getAIService().generateCommitMessage([fileDiff]);
          commitMessage =
            suggestions[0]?.message ?? this.generateFallbackCommitMessage(file, fileDiff);
        } catch {
          commitMessage = this.generateFallbackCommitMessage(file, fileDiff);
        }
      }

      await this.gitService.commit(commitMessage);
      console.log(chalk.green(`✅ Committed: ${commitMessage}`));

      return true;
    } catch (error) {
      console.error(chalk.red(`  Failed to process ${file.split('/').pop()}: ${error}`));
      return false;
    }
  };

  private readonly shouldUseSummaryMessage = (file: string, totalChanges: number): boolean => {
    const fileName = file.toLowerCase();
    const baseName = file.split('/').pop()?.toLowerCase() ?? '';
    const fileType = getFileTypeFromExtension(fileName);

    return match(fileName)
      .when(
        (name) =>
          name.includes('yarn.lock') ||
          name.includes('package-lock.json') ||
          name.includes('pnpm-lock.yaml') ||
          name.includes('composer.lock') ||
          name.includes('Gemfile.lock') ||
          name.includes('Podfile.lock') ||
          name.includes('go.sum') ||
          name.includes('Cargo.lock') ||
          name.includes('Pipfile.lock'),
        () => true // Lock files from various package managers
      )
      .when(
        (name) =>
          name.includes('.generated.') ||
          name.includes('.auto.') ||
          name.includes('.min.') ||
          name.includes('.bundle.') ||
          name.includes('.chunk.'),
        () => true // Generated files
      )
      .when(
        (name) =>
          name.includes('/dist/') ||
          name.includes('/build/') ||
          name.includes('/.next/') ||
          name.includes('/coverage/') ||
          name.includes('/out/') ||
          name.includes('/target/') ||
          name.includes('/node_modules/') ||
          name.includes('/vendor/') ||
          name.includes('/.nuxt/') ||
          name.includes('/.vuepress/') ||
          name.includes('/.docusaurus/'),
        () => true // Build artifacts and dependencies
      )
      .when(
        (name) =>
          name.includes('package.json') ||
          name.includes('composer.json') ||
          name.includes('Gemfile') ||
          name.includes('Podfile') ||
          name.includes('go.mod') ||
          name.includes('Cargo.toml') ||
          name.includes('Pipfile') ||
          name.includes('build.gradle') ||
          name.includes('pom.xml') ||
          name.includes('requirements.txt') ||
          name.includes('pyproject.toml'),
        () => totalChanges > 20 // Package/dependency files with significant changes
      )
      .when(
        (name) =>
          name.toLowerCase().includes('changelog') ||
          name.toLowerCase().includes('history') ||
          name.toLowerCase().includes('release-notes'),
        () => true // Changelog and release files
      )
      .when(
        () => totalChanges > LARGE_FILE_THRESHOLD,
        () => true // Large files
      )
      .when(
        () => totalChanges > 50 && ['json', 'xml', 'css', 'scss', 'less'].includes(fileType),
        () => true // Certain file types with many changes
      )
      .when(
        (name) =>
          baseName.includes('.log') ||
          name.includes('/logs/') ||
          baseName.includes('.cache') ||
          baseName.includes('.tmp') ||
          baseName.includes('.temp'),
        () => true // Log and temporary files
      )
      .when(
        () =>
          totalChanges > 30 &&
          ['markdown', 'unknown'].includes(fileType) &&
          (fileName.endsWith('.md') || fileName.endsWith('.txt') || fileName.endsWith('.rst')),
        () => true // Documentation files with many changes
      )
      .when(
        (name) =>
          name.includes('.map') ||
          name.includes('.bundle') ||
          name.includes('.chunk') ||
          name.includes('.vendor'),
        () => true // Source maps and bundled files
      )
      .otherwise(() => false);
  };

  private readonly generateSummaryCommitMessage = (file: string, fileDiff: GitDiff): string => {
    const fileName = file.split('/').pop() ?? file;
    const baseName = fileName.toLowerCase();
    const totalChanges = fileDiff.additions + fileDiff.deletions;

    return match(baseName)
      .when(
        (name) => name.includes('yarn.lock'),
        () =>
          match(fileDiff.additions > fileDiff.deletions * 2)
            .with(true, () => 'Added new dependencies to yarn.lock')
            .with(false, () =>
              match(fileDiff.deletions > fileDiff.additions * 2)
                .with(true, () => 'Removed dependencies from yarn.lock')
                .with(false, () => 'Updated dependencies in yarn.lock')
                .exhaustive()
            )
            .exhaustive()
      )
      .when(
        (name) => name.includes('package-lock.json'),
        () =>
          match(fileDiff.additions > fileDiff.deletions * 2)
            .with(true, () => 'Added new dependencies to package-lock.json')
            .with(false, () =>
              match(fileDiff.deletions > fileDiff.additions * 2)
                .with(true, () => 'Removed dependencies from package-lock.json')
                .with(false, () => 'Updated dependencies in package-lock.json')
                .exhaustive()
            )
            .exhaustive()
      )
      .when(
        (name) => name.includes('pnpm-lock.yaml'),
        () =>
          match(fileDiff.additions > fileDiff.deletions * 2)
            .with(true, () => 'Added new dependencies to pnpm-lock.yaml')
            .with(false, () =>
              match(fileDiff.deletions > fileDiff.additions * 2)
                .with(true, () => 'Removed dependencies from pnpm-lock.yaml')
                .with(false, () => 'Updated dependencies in pnpm-lock.yaml')
                .exhaustive()
            )
            .exhaustive()
      )
      .when(
        (name) => name.includes('composer.lock'),
        () =>
          match(fileDiff.additions > fileDiff.deletions * 2)
            .with(true, () => 'Added new dependencies to composer.lock')
            .with(false, () =>
              match(fileDiff.deletions > fileDiff.additions * 2)
                .with(true, () => 'Removed dependencies from composer.lock')
                .with(false, () => 'Updated dependencies in composer.lock')
                .exhaustive()
            )
            .exhaustive()
      )
      .when(
        (name) => name.includes('gemfile.lock'),
        () =>
          match(fileDiff.additions > fileDiff.deletions * 2)
            .with(true, () => 'Added new gems to Gemfile.lock')
            .with(false, () =>
              match(fileDiff.deletions > fileDiff.additions * 2)
                .with(true, () => 'Removed gems from Gemfile.lock')
                .with(false, () => 'Updated gems in Gemfile.lock')
                .exhaustive()
            )
            .exhaustive()
      )
      .when(
        (name) => name.includes('podfile.lock'),
        () =>
          match(fileDiff.additions > fileDiff.deletions * 2)
            .with(true, () => 'Added new pods to Podfile.lock')
            .with(false, () =>
              match(fileDiff.deletions > fileDiff.additions * 2)
                .with(true, () => 'Removed pods from Podfile.lock')
                .with(false, () => 'Updated pods in Podfile.lock')
                .exhaustive()
            )
            .exhaustive()
      )
      .when(
        (name) => name.includes('go.sum'),
        () =>
          match(fileDiff.additions > fileDiff.deletions * 2)
            .with(true, () => 'Added new module checksums to go.sum')
            .with(false, () =>
              match(fileDiff.deletions > fileDiff.additions * 2)
                .with(true, () => 'Removed module checksums from go.sum')
                .with(false, () => 'Updated module checksums in go.sum')
                .exhaustive()
            )
            .exhaustive()
      )
      .when(
        (name) => name.includes('cargo.lock'),
        () =>
          match(fileDiff.additions > fileDiff.deletions * 2)
            .with(true, () => 'Added new dependencies to Cargo.lock')
            .with(false, () =>
              match(fileDiff.deletions > fileDiff.additions * 2)
                .with(true, () => 'Removed dependencies from Cargo.lock')
                .with(false, () => 'Updated dependencies in Cargo.lock')
                .exhaustive()
            )
            .exhaustive()
      )
      .when(
        (name) => name.includes('pipfile.lock'),
        () =>
          match(fileDiff.additions > fileDiff.deletions * 2)
            .with(true, () => 'Added new packages to Pipfile.lock')
            .with(false, () =>
              match(fileDiff.deletions > fileDiff.additions * 2)
                .with(true, () => 'Removed packages from Pipfile.lock')
                .with(false, () => 'Updated packages in Pipfile.lock')
                .exhaustive()
            )
            .exhaustive()
      )
      .when(
        (name) => name.includes('package.json'),
        () =>
          match(fileDiff.additions > fileDiff.deletions * 2)
            .with(true, () => 'Added new dependencies to package.json')
            .with(false, () =>
              match(fileDiff.deletions > fileDiff.additions * 2)
                .with(true, () => 'Removed dependencies from package.json')
                .with(false, () => 'Updated package.json dependencies and metadata')
                .exhaustive()
            )
            .exhaustive()
      )
      .when(
        (name) => name.includes('composer.json'),
        () =>
          match(fileDiff.additions > fileDiff.deletions * 2)
            .with(true, () => 'Added new dependencies to composer.json')
            .with(false, () =>
              match(fileDiff.deletions > fileDiff.additions * 2)
                .with(true, () => 'Removed dependencies from composer.json')
                .with(false, () => 'Updated composer.json dependencies')
                .exhaustive()
            )
            .exhaustive()
      )
      .when(
        (name) => name.includes('gemfile'),
        () =>
          match(fileDiff.additions > fileDiff.deletions * 2)
            .with(true, () => 'Added new gems to Gemfile')
            .with(false, () =>
              match(fileDiff.deletions > fileDiff.additions * 2)
                .with(true, () => 'Removed gems from Gemfile')
                .with(false, () => 'Updated Gemfile dependencies')
                .exhaustive()
            )
            .exhaustive()
      )
      .when(
        (name) => name.includes('podfile'),
        () =>
          match(fileDiff.additions > fileDiff.deletions * 2)
            .with(true, () => 'Added new pods to Podfile')
            .with(false, () =>
              match(fileDiff.deletions > fileDiff.additions * 2)
                .with(true, () => 'Removed pods from Podfile')
                .with(false, () => 'Updated Podfile dependencies')
                .exhaustive()
            )
            .exhaustive()
      )
      .when(
        (name) => name.includes('go.mod'),
        () =>
          match(fileDiff.additions > fileDiff.deletions * 2)
            .with(true, () => 'Added new modules to go.mod')
            .with(false, () =>
              match(fileDiff.deletions > fileDiff.additions * 2)
                .with(true, () => 'Removed modules from go.mod')
                .with(false, () => 'Updated go.mod module dependencies')
                .exhaustive()
            )
            .exhaustive()
      )
      .when(
        (name) => name.includes('cargo.toml'),
        () =>
          match(fileDiff.additions > fileDiff.deletions * 2)
            .with(true, () => 'Added new dependencies to Cargo.toml')
            .with(false, () =>
              match(fileDiff.deletions > fileDiff.additions * 2)
                .with(true, () => 'Removed dependencies from Cargo.toml')
                .with(false, () => 'Updated Cargo.toml dependencies')
                .exhaustive()
            )
            .exhaustive()
      )
      .when(
        (name) => name.includes('pipfile'),
        () =>
          match(fileDiff.additions > fileDiff.deletions * 2)
            .with(true, () => 'Added new packages to Pipfile')
            .with(false, () =>
              match(fileDiff.deletions > fileDiff.additions * 2)
                .with(true, () => 'Removed packages from Pipfile')
                .with(false, () => 'Updated Pipfile dependencies')
                .exhaustive()
            )
            .exhaustive()
      )
      .when(
        (name) => name.includes('build.gradle'),
        () =>
          match(fileDiff.additions > fileDiff.deletions * 2)
            .with(true, () => 'Added new dependencies to build.gradle')
            .with(false, () =>
              match(fileDiff.deletions > fileDiff.additions * 2)
                .with(true, () => 'Removed dependencies from build.gradle')
                .with(false, () => 'Updated build.gradle configuration')
                .exhaustive()
            )
            .exhaustive()
      )
      .when(
        (name) => name.includes('pom.xml'),
        () =>
          match(fileDiff.additions > fileDiff.deletions * 2)
            .with(true, () => 'Added new dependencies to pom.xml')
            .with(false, () =>
              match(fileDiff.deletions > fileDiff.additions * 2)
                .with(true, () => 'Removed dependencies from pom.xml')
                .with(false, () => 'Updated pom.xml Maven configuration')
                .exhaustive()
            )
            .exhaustive()
      )
      .when(
        (name) => name.includes('requirements.txt'),
        () =>
          match(fileDiff.additions > fileDiff.deletions * 2)
            .with(true, () => 'Added new packages to requirements.txt')
            .with(false, () =>
              match(fileDiff.deletions > fileDiff.additions * 2)
                .with(true, () => 'Removed packages from requirements.txt')
                .with(false, () => 'Updated requirements.txt Python dependencies')
                .exhaustive()
            )
            .exhaustive()
      )
      .when(
        (name) => name.includes('pyproject.toml'),
        () =>
          match(fileDiff.additions > fileDiff.deletions * 2)
            .with(true, () => 'Added new dependencies to pyproject.toml')
            .with(false, () =>
              match(fileDiff.deletions > fileDiff.additions * 2)
                .with(true, () => 'Removed dependencies from pyproject.toml')
                .with(false, () => 'Updated pyproject.toml Python configuration')
                .exhaustive()
            )
            .exhaustive()
      )
      .when(
        (name) => name.toLowerCase().includes('changelog'),
        () => 'Updated changelog with new features and fixes'
      )
      .when(
        (name) => name.toLowerCase().includes('history'),
        () => 'Updated project history documentation'
      )
      .when(
        (name) => name.toLowerCase().includes('release-notes'),
        () => 'Updated release notes documentation'
      )
      .when(
        () =>
          file.includes('.generated.') ||
          file.includes('.auto.') ||
          file.includes('.min.') ||
          file.includes('.bundle.') ||
          file.includes('.chunk.'),
        () => `Updated generated file ${fileName}`
      )
      .when(
        () =>
          file.includes('/dist/') ||
          file.includes('/build/') ||
          file.includes('/out/') ||
          file.includes('/target/'),
        () => `Updated compiled ${fileName}`
      )
      .when(
        () => file.includes('/.next/'),
        () => 'Updated Next.js build artifacts'
      )
      .when(
        () => file.includes('/.nuxt/'),
        () => 'Updated Nuxt.js build artifacts'
      )
      .when(
        () => file.includes('/.vuepress/'),
        () => 'Updated VuePress build artifacts'
      )
      .when(
        () => file.includes('/.docusaurus/'),
        () => 'Updated Docusaurus build artifacts'
      )
      .when(
        () => file.includes('/coverage/'),
        () => 'Updated code coverage reports'
      )
      .when(
        () => file.includes('/node_modules/') || file.includes('/vendor/'),
        () => 'Updated third-party dependencies'
      )
      .when(
        (name) =>
          name.includes('.map') ||
          name.includes('.bundle') ||
          name.includes('.chunk') ||
          name.includes('.vendor'),
        () => `Updated bundled ${fileName}`
      )
      .when(
        (name) =>
          name.includes('.log') ||
          file.includes('/logs/') ||
          name.includes('.cache') ||
          name.includes('.tmp') ||
          name.includes('.temp'),
        () => `Updated ${fileName}`
      )
      .when(
        () => totalChanges > LARGE_FILE_THRESHOLD,
        () => `Implemented comprehensive functionality in ${fileName}`
      )
      .when(
        () => baseName.endsWith('.json') && totalChanges > 50,
        () => `Updated ${fileName} configuration`
      )
      .when(
        () =>
          (baseName.endsWith('.css') || baseName.endsWith('.scss') || baseName.endsWith('.less')) &&
          totalChanges > 50,
        () => `Updated ${fileName} styles`
      )
      .when(
        () =>
          (baseName.endsWith('.md') || baseName.endsWith('.txt') || baseName.endsWith('.rst')) &&
          totalChanges > 30,
        () => `Updated ${fileName} documentation`
      )
      .otherwise(() => `Updated ${fileName} functionality`);
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
