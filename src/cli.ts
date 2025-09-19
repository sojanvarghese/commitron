#!/usr/bin/env node

// Track startup performance from the very beginning
const startupStart = performance.now();

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import process from 'process';
import chalk from 'chalk';
import { ConfigManager } from './config.js';
import type { CommitConfig } from './types/common.js';
import { CommitMessageSchema, CommitConfigSchema } from './schemas/validation.js';
import { ErrorType } from './types/error-handler.js';
import { withErrorHandling, SecureError } from './utils/error-handler.js';
import { PerformanceMonitor, withPerformanceTracking } from './utils/performance.js';
import { PERFORMANCE_FLAGS } from './constants/performance.js';

// Log startup time
if (PERFORMANCE_FLAGS.ENABLE_PERFORMANCE_MONITORING) {
  process.nextTick(() => {
    const startupTime = performance.now() - startupStart;
    if (startupTime > 500) { // Only log if startup is slow
      console.log(`🚀 Startup time: ${startupTime.toFixed(2)}ms`);
    }
  });
}

// Type definitions for dynamic imports
type InquirerModule = typeof import('inquirer');
type GradientStringModule = typeof import('gradient-string');

let inquirerCache: InquirerModule | null = null;
let gradientStringCache: GradientStringModule | null = null;

const loadInquirer = async (): Promise<InquirerModule> => {
  inquirerCache ??= await import('inquirer');
  return inquirerCache;
};

const loadGradientString = async (): Promise<GradientStringModule> => {
  gradientStringCache ??= await import('gradient-string');
  return gradientStringCache;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));

const program = new Command();

// Helper function to parse configuration values
const parseConfigValue = (value: string): string | number | boolean => {
  const lowerValue = value.toLowerCase();

  switch (lowerValue) {
    case 'true':
      return true;
    case 'false':
      return false;
    default:
      return !isNaN(Number(value)) ? Number(value) : value;
  }
};

program
  .name('cx')
  .description('🚀 AI-powered Git commit assistant')
  .version(packageJson.version);

// Main commit command
program
  .command('commit')
  .alias('c')
  .description(
    'Generate and create AI-powered commit messages'
  )
  .option(
    '-m, --message <message>',
    'Use provided commit message instead of generating one (uses traditional workflow)'
  )
  .option('-d, --dry-run', 'Show what would be committed without actually committing')
  .option('-i, --interactive', 'Use interactive mode (for traditional workflow only)')
  .option('--all', 'Stage all files and commit together (traditional workflow)')
  .action(
    async (options: {
      message?: string;
      dryRun?: boolean;
      interactive?: boolean;
      all?: boolean;
    }): Promise<void> => {
      return withErrorHandling(
        async (): Promise<void> => {
          // Validate command combinations
          if (options.interactive && !options.all) {
            console.error(chalk.red('❌ Error: --interactive option can only be used with --all flag'));
            console.log(chalk.yellow('\n💡 Correct usage:'));
            console.log(chalk.blue('  cx commit --all --interactive    # Interactive traditional workflow'));
            console.log(chalk.blue('  cx commit --all                  # Non-interactive traditional workflow'));
            console.log(chalk.blue('  cx commit                        # Batch processing (default)'));
            console.log(chalk.blue('  cx commit --help                 # Show all options'));
            process.exit(1);
          }

          // Validate commit message if provided
          if (options.message) {
            const result = CommitMessageSchema.safeParse(options.message);
            if (!result.success) {
              throw new SecureError(
                `Invalid commit message: ${result.error.issues.map((e: { message: string }) => e.message).join(', ')}`,
                ErrorType.VALIDATION_ERROR,
                { operation: 'commit' },
                true
              );
            }
            options.message = result.data;
          }

          // Import only when needed to avoid loading heavy dependencies
          const operation = options.all ? 'commit-traditional' : 'commit-ai';

          await withPerformanceTracking(operation, async () => {
            const { CommitX } = await import('./core/commitx.js');
            const commitX = new CommitX();


            await commitX.commit({
              message: options.message,
              dryRun: options.dryRun,
              interactive: options.interactive,
              all: options.all,
            });
          });
        },
        { operation: 'commit' }
      );
    }
  );

// Status command
program
  .command('status')
  .alias('s')
  .description('Show repository status and changes')
  .action(async () => {
    return withErrorHandling(
      async (): Promise<void> => {
        // Import only when needed to avoid loading heavy dependencies
        const { CommitX } = await import('./core/commitx.js');
        const commitX = new CommitX();
        await commitX.status();
      },
      { operation: 'status' }
    );
  });

// Diff command
program
  .command('diff')
  .alias('d')
  .description('Show unstaged changes summary')
  .action(async () => {
    return withErrorHandling(
      async (): Promise<void> => {
        // Import only when needed to avoid loading heavy dependencies
        const { CommitX } = await import('./core/commitx.js');
        const commitX = new CommitX();
        await commitX.diff();
      },
      { operation: 'diff' }
    );
  });

// Configuration commands
const configCmd = program.command('config').description('Manage Commitron configuration');

configCmd
  .command('set <key> <value>')
  .description('Set configuration value')
  .action(async (key: string, value: string): Promise<void> => {
    await withErrorHandling(
      async (): Promise<void> => {
        // Validate that the key is a valid config key
        if (!(key in CommitConfigSchema.shape)) {
          throw new SecureError(
            `Invalid configuration key: ${key}. Allowed keys: ${Object.keys(CommitConfigSchema.shape).join(', ')}`,
            ErrorType.VALIDATION_ERROR,
            { operation: 'configSet', key },
            true
          );
        }

        const config = ConfigManager.getInstance();

        // Parse boolean values
        const parsedValue = parseConfigValue(value);

        await config.set(key as keyof CommitConfig, parsedValue);
        console.log(chalk.green(`✅ Set ${key} = ${parsedValue}`));
      },
      { operation: 'configSet', key }
    );
  });

configCmd
  .command('get [key]')
  .description('Get configuration value(s)')
  .action(async (key?: string): Promise<void> => {
    await withErrorHandling(
      async (): Promise<void> => {
        const config = ConfigManager.getInstance();
        const allKeys = Object.keys(CommitConfigSchema.shape);

        const isValidKey = (k: string): k is keyof CommitConfig => allKeys.includes(k);

        if (key) {
          if (!isValidKey(key)) {
            throw new SecureError(
              `Invalid configuration key: ${key}. Allowed keys: ${allKeys.join(', ')}`,
              ErrorType.VALIDATION_ERROR,
              { operation: 'configGet', key },
              true
            );
          }

          const value = key === 'apiKey' ? config.getApiKey() : config.get(key);
          console.log(`${key}: ${key === 'apiKey' && value ? '********' : value}`);
        } else {
          const allConfig = config.getConfig();
          const apiKey = config.getApiKey();

          console.log(chalk.blue('Current configuration:'));
          for (const [k, v] of Object.entries(allConfig)) {
            const isSensitive = k === 'apiKey';
            const displayValue = isSensitive ? '********' : v;
            console.log(`  ${k}: ${displayValue}`);
          }

          if (!('apiKey' in allConfig)) {
            console.log(`  apiKey: ${apiKey ? '********' : 'Not set'}`);
          }
        }
      },
      { operation: 'configGet', key }
    );
  });

configCmd
  .command('reset')
  .description('Reset configuration to defaults')
  .action(async () => {
    try {
      const inquirer = await loadInquirer();
      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: 'Are you sure you want to reset all configuration to defaults?',
          default: false,
        },
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
    const inquirer = await loadInquirer();
    console.log(chalk.blue('🚀 Welcome to Commitron Setup!\n'));

    try {
      const config = ConfigManager.getInstance();

      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'apiKey',
          message: 'Enter your Gemini AI API key:',
          validate: (input: string): string | boolean => {
            if (!input.trim()) {
              return 'API key is required. Get one from https://makersuite.google.com/app/apikey';
            }
            return true;
          },
        },
      ]);

      await config.saveConfig(answers);

      console.log(chalk.green('\n✅ Setup completed successfully!'));
      console.log(chalk.blue('You can now use "cx" to start making AI-powered commits.'));
      console.log(chalk.gray('Use "cx config" to modify settings later.'));
    } catch (error) {
      console.error(chalk.red(`Setup failed: ${error}`));
      process.exit(1);
    }
  });

// Privacy command
program
  .command('privacy')
  .description('Show privacy settings and data handling information')
  .action(async (): Promise<void> => {
    console.log(chalk.blue('🔒 Commitron Privacy Information:\n'));

    console.log(chalk.yellow('Data Sent to AI:'));
    console.log('  • File paths (sanitized to remove usernames)');
    console.log('  • Code changes (up to 3000 characters per file)');
    console.log('  • File metadata (additions/deletions counts)');
    console.log('  • File status (new/modified/deleted/renamed)\n');
    console.log(chalk.yellow('Data NOT Sent to AI:'));
    console.log('  • API keys or authentication tokens');
    console.log('  • Personal information (names, emails)');
    console.log('  • System information (OS, hardware)');
    console.log('  • Repository metadata (URLs, branch names)\n');

    console.log(chalk.yellow('Privacy Protections:'));
    console.log('  • Sensitive files are automatically skipped');
    console.log('  • File paths are sanitized to remove usernames');
    console.log('  • Potential secrets are redacted from content');
    console.log('  • Content is limited to 3000 characters per file');
    console.log('  • Total request size is capped at 100KB\n');

    console.log(chalk.yellow('Sensitive File Types (Auto-skipped):'));
    console.log('  • .env, .key, .pem, .p12, .pfx, .p8 files');
    console.log('  • Files in secrets/, keys/, credentials/ directories');
    console.log('  • Files containing API keys, passwords, or tokens\n');

    console.log(chalk.yellow('Common Warning Types:'));
    console.log('  • Potential sensitive data detected');
    console.log('  • Sensitive file pattern detected');
    console.log('  • Potential secrets detected in comments');
    console.log('  • Sensitive file type');
    console.log('  • Located in sensitive directory\n');

    console.log(
      chalk.gray('For more information, visit: https://github.com/sojanvarghese/commitx#privacy')
    );
  });

// Help command with examples
program
  .command('help-examples')
  .description('Show usage examples')
  .action(async (): Promise<void> => {
    const { pastel } = await loadGradientString();
    console.log(pastel('📚 Commitron Usage Examples:\n'));

    console.log(chalk.yellow('Basic usage:'));
    console.log('  cx                             # Process files with AI');
    console.log('  cx commit --dry-run            # Preview commits');
    console.log('  cx commit                      # Direct CLI access');
    console.log('');

    console.log(chalk.yellow('Traditional workflow:'));
    console.log('  cx commit --all                # Stage all files and commit together');
    console.log('  cx commit -m "fix: bug"        # Use custom message (traditional)');
    console.log('');

    console.log(chalk.yellow('Status and information:'));
    console.log('  cx status                      # Show repository status');
    console.log('  cx diff                        # Show changes summary');
    console.log('');

    console.log(chalk.yellow('Configuration:'));
    console.log('  cx setup                       # Interactive setup');
    console.log('  cx config                      # View configuration');
    console.log('  cx config set <key> <value>    # Set configuration values');
    console.log('  cx config reset                # Reset configuration');
    console.log('  cx privacy                     # Show privacy information');
  });

// Debug command
program
  .command('debug')
  .description('Debug Git repository detection and environment')
  .action(async (): Promise<void> => {
    console.log(chalk.blue('\n🔍 Commitron Debug Information:\n'));

    console.log(chalk.gray('Environment:'));
    console.log(`  Current working directory: ${process.cwd()}`);
    console.log(`  Node.js version: ${process.version}`);
    console.log(`  Platform: ${process.platform}`);
    console.log(`  Architecture: ${process.arch}`);

    console.log(chalk.gray('\nGit repository detection:'));
    try {
      const { validateGitRepository } = await import('./utils/security.js');
      const validation = await validateGitRepository(process.cwd());
      console.log(`  Valid Git repository: ${validation.isValid ? '✅ Yes' : '❌ No'}`);
      if (!validation.isValid) {
        console.log(`  Error: ${validation.error}`);
      } else {
        console.log(`  Repository path: ${validation.sanitizedValue}`);
      }
    } catch (error) {
      console.log(`  Error during validation: ${error}`);
    }

    console.log(chalk.gray('\nGit directory structure:'));
    try {
      const fs = await import('fs');
      const path = await import('path');
      const gitDir = path.join(process.cwd(), '.git');
      console.log(`  .git directory exists: ${fs.existsSync(gitDir) ? '✅ Yes' : '❌ No'}`);
      if (fs.existsSync(gitDir)) {
        const headFile = path.join(gitDir, 'HEAD');
        console.log(`  HEAD file exists: ${fs.existsSync(headFile) ? '✅ Yes' : '❌ No'}`);
        if (fs.existsSync(headFile)) {
          const headContent = fs.readFileSync(headFile, 'utf8');
          console.log(`  HEAD content: ${headContent.trim()}`);
        }
      }
    } catch (error) {
      console.log(`  Error checking Git structure: ${error}`);
    }
  });

// Default action for commit when no subcommand is provided
program.action(async (): Promise<void> => {
  try {
    // Import only when needed to avoid loading heavy dependencies
    const { CommitX } = await import('./core/commitx.js');
    const commitX = new CommitX();
    await commitX.commit(); // Uses AI processing by default
  } catch (error) {
    console.error(chalk.red(`Error: ${error}`));
    process.exit(1);
  }
});

// Error handling for unknown commands
program.on('command:*', async (): Promise<void> => {
  console.error(chalk.red(`❌ Unknown command: ${program.args.join(' ')}`));
  console.log(chalk.yellow('\n💡 Available commands:'));
  console.log(chalk.blue('  cx --help              # Show all available commands'));
  console.log(chalk.blue('  cx commit --help       # Show commit command options'));
  console.log(chalk.blue('  cx help-examples       # Show usage examples'));
  console.log(chalk.gray('\nFor more information, visit: https://github.com/sojanvarghese/commitx'));
  process.exit(1);
});

// Error handling for invalid options
program.on('option:*', async (): Promise<void> => {
  console.error(chalk.red(`❌ Unknown option: ${program.args.join(' ')}`));
  console.log(chalk.yellow('\n💡 Available options:'));
  console.log(chalk.blue('  cx --help              # Show all available commands'));
  console.log(chalk.blue('  cx commit --help       # Show commit command options'));
  console.log(chalk.gray('\nFor more information, visit: https://github.com/sojanvarghese/commitx'));
  process.exit(1);
});

// Performance monitoring exit handler
if (PERFORMANCE_FLAGS.ENABLE_PERFORMANCE_MONITORING) {
  process.on('exit', () => {
    const monitor = PerformanceMonitor.getInstance();
    monitor.logMetrics();
  });
}

// Parse command line arguments
if (process.argv.length === 2) {
  // No arguments provided, run default commit
  void (async (): Promise<void> => {
    try {
      // Import only when needed to avoid loading heavy dependencies
      await withPerformanceTracking('default-commit', async () => {
        const { CommitX } = await import('./core/commitx.js');
        const commitX = new CommitX();
        await commitX.commit();
      });
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
      process.exit(1);
    }
  })();
} else {
  program.parse(process.argv);
}
