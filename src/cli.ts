#!/usr/bin/env node

/// <reference path="./types/global.d.ts" />

import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import process from 'process';
import { CommitX } from './core/commitx.js';
import { ConfigManager } from './config/index.js';
import { CommitConfig } from './types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));

const program = new Command();

program
  .name('commit-x')
  .description('AI-powered Git commit assistant')
  .version(packageJson.version);

// Main commit command
program
  .command('commit')
  .alias('c')
  .description('Generate and create AI-powered commit messages (processes files individually by default)')
  .option('-m, --message <message>', 'Use provided commit message instead of generating one (uses traditional workflow)')
  .option('-p, --push', 'Push changes after committing (disabled in individual mode)')
  .option('-d, --dry-run', 'Show what would be committed without actually committing')
  .option('-i, --interactive', 'Use interactive mode (for traditional workflow only)')
  .option('--no-interactive', 'Use non-interactive mode (default for individual commits)')
  .option('--all', 'Stage all files and commit together (traditional workflow)')
  .action(async (options: { message?: string; push?: boolean; dryRun?: boolean; interactive?: boolean; all?: boolean }) => {
    try {
      const commitX = new CommitX();

      // Show warning if push is requested in individual mode
      if (options.push && !options.message && !options.all) {
        console.log(chalk.yellow('⚠️  Push option is disabled when processing files individually.'));
        console.log(chalk.gray('   Use --all flag to stage all files together, or push manually after committing.'));
        options.push = false;
      }

      await commitX.commit({
        message: options.message,
        push: options.push,
        dryRun: options.dryRun,
        interactive: options.interactive,
        all: options.all
      });
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
      process.exit(1);
    }
  });

// Status command
program
  .command('status')
  .alias('s')
  .description('Show repository status and changes')
  .action(async () => {
    try {
      const commitX = new CommitX();
      await commitX.status();
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
      process.exit(1);
    }
  });

// Diff command
program
  .command('diff')
  .alias('d')
  .description('Show changes summary')
  .action(async () => {
    try {
      const commitX = new CommitX();
      await commitX.diff();
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
      process.exit(1);
    }
  });

// Configuration commands
const configCmd = program
  .command('config')
  .description('Manage CommitX configuration');

configCmd
  .command('set <key> <value>')
  .description('Set configuration value')
  .action((key: string, value: string) => {
    try {
      const config = ConfigManager.getInstance();

      // Parse boolean values
      let parsedValue: any = value;
      if (value.toLowerCase() === 'true') parsedValue = true;
      else if (value.toLowerCase() === 'false') parsedValue = false;
      else if (!isNaN(Number(value))) parsedValue = Number(value);

      config.set(key as keyof CommitConfig, parsedValue);
      console.log(chalk.green(`✅ Set ${key} = ${parsedValue}`));
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
      process.exit(1);
    }
  });

configCmd
  .command('get [key]')
  .description('Get configuration value(s)')
  .action((key?: string) => {
    try {
      const config = ConfigManager.getInstance();

      if (key) {
        const value = config.get(key as keyof CommitConfig);
        console.log(`${key}: ${value}`);
      } else {
        const allConfig = config.getConfig();
        console.log(chalk.blue('Current configuration:'));
        Object.entries(allConfig).forEach(([k, v]) => {
          console.log(`  ${k}: ${v}`);
        });
      }
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
      process.exit(1);
    }
  });

configCmd
  .command('reset')
  .description('Reset configuration to defaults')
  .action(async () => {
    try {
      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: 'Are you sure you want to reset all configuration to defaults?',
          default: false
        }
      ]);

      if (confirm) {
        const config = ConfigManager.getInstance();
        config.reset();
        console.log(chalk.green('✅ Configuration reset to defaults'));
      } else {
        console.log(chalk.yellow('Reset cancelled'));
      }
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
      process.exit(1);
    }
  });

// Setup command for first-time configuration
program
  .command('setup')
  .description('Interactive setup for first-time users')
  .action(async () => {
    console.log(chalk.blue('🚀 Welcome to CommitX Setup!\n'));

    try {
      const config = ConfigManager.getInstance();

      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'apiKey',
          message: 'Enter your Gemini AI API key:',
          validate: (input: string) => {
            if (!input.trim()) {
              return 'API key is required. Get one from https://makersuite.google.com/app/apikey';
            }
            return true;
          }
        },
        {
          type: 'list',
          name: 'style',
          message: 'Choose your preferred commit message style:',
          choices: [
            { name: 'Conventional Commits (feat: add new feature)', value: 'conventional' },
            { name: 'Descriptive (Add user authentication system)', value: 'descriptive' },
            { name: 'Minimal (Add auth)', value: 'minimal' }
          ],
          default: 'conventional'
        },
        {
          type: 'number',
          name: 'maxLength',
          message: 'Maximum commit message length:',
          default: 72,
          validate: (input: number) => {
            if (input < 20 || input > 100) {
              return 'Length should be between 20 and 100 characters';
            }
            return true;
          }
        },
        {
          type: 'confirm',
          name: 'includeFiles',
          message: 'Include file diffs in AI analysis?',
          default: true
        },
        {
          type: 'confirm',
          name: 'autoPush',
          message: 'Automatically push after committing?',
          default: false
        }
      ]);

      config.saveConfig(answers);

      console.log(chalk.green('\n✅ Setup completed successfully!'));
      console.log(chalk.blue('You can now use "commit-x" or "cx" to start making AI-powered commits.'));
      console.log(chalk.gray('Use "commit-x config" to modify settings later.'));

    } catch (error) {
      console.error(chalk.red(`Setup failed: ${error}`));
      process.exit(1);
    }
  });

// Help command with examples
program
  .command('help-examples')
  .description('Show usage examples')
  .action(() => {
    console.log(chalk.blue('📚 CommitX Usage Examples:\n'));

    console.log(chalk.yellow('Basic usage (Individual commits):'));
    console.log('  commit-x commit                 # Process files individually');
    console.log('  cx c                            # Short alias');
    console.log('  commit-x commit --dry-run       # Preview individual commits');
    console.log('');

    console.log(chalk.yellow('Traditional workflow:'));
    console.log('  commit-x commit --all           # Stage all files and commit together');
    console.log('  commit-x commit --all --push    # Stage all, commit, and push');
    console.log('  commit-x commit -m "fix: bug"   # Use custom message (traditional)');
    console.log('');

    console.log(chalk.yellow('Status and information:'));
    console.log('  commit-x status                 # Show repository status');
    console.log('  commit-x diff                   # Show changes summary');
    console.log('');

    console.log(chalk.yellow('Configuration:'));
    console.log('  commit-x setup                  # Interactive setup');
    console.log('  commit-x config set style conventional');
    console.log('  commit-x config get apiKey');
    console.log('  commit-x config reset');
  });

// Default action for commit when no subcommand is provided
program
  .action(async () => {
    try {
      const commitX = new CommitX();
      await commitX.commit(); // Uses individual workflow by default
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
      process.exit(1);
    }
  });

// Error handling
program.on('command:*', () => {
  console.error(chalk.red(`Unknown command: ${program.args.join(' ')}`));
  console.log(chalk.blue('Use "commit-x --help" for available commands'));
  process.exit(1);
});

// Parse command line arguments
if (process.argv.length === 2) {
  // No arguments provided, run default commit
  (async () => {
    try {
      const commitX = new CommitX();
      await commitX.commit();
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
      process.exit(1);
    }
  })();
} else {
  program.parse(process.argv);
}
