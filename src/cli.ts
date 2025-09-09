import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import process from 'process';
import gradient from 'gradient-string';
import { ConfigManager } from './config.js';
import type { CommitConfig } from './types/common.js';
import { CommitMessageSchema, CommitConfigSchema } from './schemas/validation.js';
import { ErrorType } from './types/error-handler.js';
import { withErrorHandling, SecureError } from './utils/error-handler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));

const program = new Command();

// Helper function to parse configuration values
const parseConfigValue = (value: string): any => {
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
  .name('commit-x')
  .description(gradient.rainbow('🚀 AI-powered Git commit assistant'))
  .version(packageJson.version);

// Main commit command
program
  .command('commit')
  .alias('c')
  .description(
    'Generate and create AI-powered commit messages (processes files individually by default)'
  )
  .option(
    '-m, --message <message>',
    'Use provided commit message instead of generating one (uses traditional workflow)'
  )
  .option('-p, --push', 'Push changes after committing (disabled in individual mode)')
  .option('-d, --dry-run', 'Show what would be committed without actually committing')
  .option('-i, --interactive', 'Use interactive mode (for traditional workflow only)')
  .option('--no-interactive', 'Use non-interactive mode (default for individual commits)')
  .option('--all', 'Stage all files and commit together (traditional workflow)')
  .action(
    async (options: {
      message?: string;
      push?: boolean;
      dryRun?: boolean;
      interactive?: boolean;
      all?: boolean;
    }): Promise<void> => {
      return withErrorHandling(
        async (): Promise<void> => {
          // Validate commit message if provided
          if (options.message) {
            const result = CommitMessageSchema.safeParse(options.message);
            if (!result.success) {
              throw new SecureError(
                `Invalid commit message: ${result.error.issues.map((e: any) => e.message).join(', ')}`,
                ErrorType.VALIDATION_ERROR,
                { operation: 'commit' },
                true
              );
            }
            options.message = result.data;
          }

          // Import only when needed to avoid loading heavy dependencies
          const { CommitX } = await import('./core/commitx.js');
          const commitX = new CommitX();

          // Show warning if push is requested in individual mode
          if (options.push && !options.message && !options.all) {
            console.log(
              chalk.yellow('⚠️  Push option is disabled when processing files individually.')
            );
            console.log(
              chalk.gray(
                '   Use --all flag to stage all files together, or push manually after committing.'
              )
            );
            options.push = false;
          }

          await commitX.commit({
            message: options.message,
            push: options.push,
            dryRun: options.dryRun,
            interactive: options.interactive,
            all: options.all,
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
  .description('Show changes summary')
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
const configCmd = program.command('config').description('Manage CommitX configuration');

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

        if (key) {
          // Validate that the key is a valid config key
          if (!(key in CommitConfigSchema.shape)) {
            throw new SecureError(
              `Invalid configuration key: ${key}. Allowed keys: ${Object.keys(CommitConfigSchema.shape).join(', ')}`,
              ErrorType.VALIDATION_ERROR,
              { operation: 'configGet', key },
              true
            );
          }

          const value = config.get(key as keyof CommitConfig);
          console.log(`${key}: ${value}`);
        } else {
          const allConfig = config.getConfig();
          console.log(chalk.blue('Current configuration:'));
          Object.entries(allConfig).forEach(([k, v]) => {
            // Don't show sensitive information
            const displayValue = k === 'apiKey' ? '***' : v;
            console.log(`  ${k}: ${displayValue}`);
          });
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
          },
        },
      ]);

      config.saveConfig(answers);

      console.log(chalk.green('\n✅ Setup completed successfully!'));
      console.log(
        chalk.blue('You can now use "commit-x" or "cx" to start making AI-powered commits.')
      );
      console.log(chalk.gray('Use "commit-x config" to modify settings later.'));
    } catch (error) {
      console.error(chalk.red(`Setup failed: ${error}`));
      process.exit(1);
    }
  });

// Privacy command
program
  .command('privacy')
  .description('Show privacy settings and data handling information')
  .action((): void => {
    console.log(chalk.blue('🔒 CommitX Privacy Information:\n'));

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
      chalk.gray('For more information, visit: https://github.com/sojanvarghese/commit-x#privacy')
    );
  });

// Help command with examples
program
  .command('help-examples')
  .description('Show usage examples')
  .action((): void => {
    console.log(gradient.rainbow('📚 CommitX Usage Examples:\n'));

    console.log(chalk.yellow('Basic usage (Individual commits):'));
    console.log('  yarn commit                     # Process files individually');
    console.log('  yarn commit:dry                 # Preview individual commits');
    console.log('  yarn cx                         # Direct CLI access');
    console.log('');

    console.log(chalk.yellow('Traditional workflow:'));
    console.log('  yarn commit:all                 # Stage all files and commit together');
    console.log('  yarn commit:all --push          # Stage all, commit, and push');
    console.log('  yarn cx commit -m "fix: bug"    # Use custom message (traditional)');
    console.log('');

    console.log(chalk.yellow('Status and information:'));
    console.log('  yarn status                     # Show repository status');
    console.log('  yarn diff                       # Show changes summary');
    console.log('');

    console.log(chalk.yellow('Configuration:'));
    console.log('  yarn setup                     # Interactive setup');
    console.log('  yarn config                    # View configuration');
    console.log('  yarn config:set                # Set configuration values');
    console.log('  yarn config:reset              # Reset configuration');
    console.log('  yarn privacy                   # Show privacy information');
  });

// Default action for commit when no subcommand is provided
program.action(async (): Promise<void> => {
  try {
    // Import only when needed to avoid loading heavy dependencies
    const { CommitX } = await import('./core/commitx.js');
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
      // Import only when needed to avoid loading heavy dependencies
      const { CommitX } = await import('./core/commitx.js');
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
