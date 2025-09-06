import simpleGit, { SimpleGit, DiffResult } from 'simple-git';
import { GitDiff, GitStatus } from '../types/index.js';
import {
  validateAndSanitizePath,
  validateFileSize,
  validateDiffSize,
  withTimeout,
  safeReadFile,
  validateGitRepository,
  validateCommitMessage,
  DEFAULT_LIMITS
} from '../utils/security.js';
import {
  ErrorHandler,
  ErrorType,
  withErrorHandling,
  withRetry,
  SecureError
} from '../utils/error-handler.js';
import * as path from 'path';

export class GitService {
  private git: SimpleGit;
  private errorHandler: ErrorHandler;
  private repositoryPath: string;

  constructor() {
    this.git = simpleGit();
    this.errorHandler = ErrorHandler.getInstance();
    this.repositoryPath = process.cwd();
  }

  /**
   * Check if we're in a git repository with security validation
   */
  isGitRepository = async (): Promise<boolean> => {
    return withErrorHandling(async () => {
      const validation = await validateGitRepository(this.repositoryPath);
      if (!validation.isValid) {
        throw new SecureError(
          validation.error!,
          ErrorType.GIT_ERROR,
          { operation: 'isGitRepository' },
          false
        );
      }
      return true;
    }, { operation: 'isGitRepository' });
  }

  /**
   * Get the current repository status with security validation
   */
  getStatus = async (): Promise<GitStatus> => {
    return withErrorHandling(async () => {
      const status = await withTimeout(
        this.git.status(),
        DEFAULT_LIMITS.timeoutMs
      );

      // Validate and sanitize file paths
      const staged = this.validateFilePaths(status.staged);
      const unstaged = this.validateFilePaths(status.modified);
      const untracked = this.validateFilePaths(status.not_added);

      return {
        staged,
        unstaged,
        untracked,
        total: staged.length + unstaged.length + untracked.length
      };
    }, { operation: 'getStatus' });
  }

  /**
   * Validate and sanitize file paths
   */
  private validateFilePaths = (filePaths: string[]): string[] => {
    const validPaths: string[] = [];

    for (const filePath of filePaths) {
      const validation = validateAndSanitizePath(filePath, this.repositoryPath);
      if (validation.isValid) {
        validPaths.push(validation.sanitizedValue!);
      } else {
        console.warn(`Skipping invalid file path: ${filePath} - ${validation.error}`);
      }
    }

    return validPaths;
  };

  /**
   * Get all unstaged and untracked files with security validation
   */
  getUnstagedFiles = async (): Promise<string[]> => {
    return withErrorHandling(async () => {
      const status = await withTimeout(
        this.git.status(),
        DEFAULT_LIMITS.timeoutMs
      );

      const allFiles = [...status.modified, ...status.not_added, ...status.deleted];
      return this.validateFilePaths(allFiles);
    }, { operation: 'getUnstagedFiles' });
  }

  /**
   * Get diff for a specific file (staged or unstaged) with security validation
   */
  getFileDiff = async (file: string, staged: boolean = false): Promise<GitDiff> => {
    return withErrorHandling(async () => {
      // Validate file path first
      const pathValidation = validateAndSanitizePath(file, this.repositoryPath);
      if (!pathValidation.isValid) {
        throw new SecureError(
          pathValidation.error!,
          ErrorType.SECURITY_ERROR,
          { operation: 'getFileDiff', file },
          false
        );
      }

      const validatedFile = pathValidation.sanitizedValue!;
      const status = await withTimeout(
        this.git.status(),
        DEFAULT_LIMITS.timeoutMs
      );

      try {
        // Handle deleted files differently
        const isDeleted = status.deleted.includes(file);

        if (isDeleted && !staged) {
          // For deleted files, we can't get a normal diff, so provide basic info
          return {
            file: validatedFile,
            additions: 0,
            deletions: 1, // Assume at least one deletion (the file itself)
            changes: `File deleted: ${validatedFile}`,
            isNew: false,
            isDeleted: true,
            isRenamed: false,
            oldPath: undefined
          };
        }

        const diffArgs = staged ? ['--cached', validatedFile] : [validatedFile];
        const diff = await withTimeout(
          this.git.diff(diffArgs),
          DEFAULT_LIMITS.timeoutMs
        );
        const diffSummary = await withTimeout(
          this.git.diffSummary(diffArgs),
          DEFAULT_LIMITS.timeoutMs
        );

        // Validate diff size
        const diffValidation = validateDiffSize(diff);
        if (!diffValidation.isValid) {
          throw new SecureError(
            diffValidation.error!,
            ErrorType.VALIDATION_ERROR,
            { operation: 'getFileDiff', file: validatedFile },
            true
          );
        }

        const fileSummary = diffSummary.files.find((f: any) => f.file === validatedFile);

        return {
          file: validatedFile,
          additions: fileSummary?.insertions || 0,
          deletions: fileSummary?.deletions || 0,
          changes: diffValidation.sanitizedValue!,
          isNew: status.created.includes(file) || status.not_added.includes(file),
          isDeleted: status.deleted.includes(file),
          isRenamed: status.renamed.some((r: any) => r.to === file),
          oldPath: status.renamed.find((r: any) => r.to === file)?.from
        };
      } catch (error) {
        // Return minimal diff info for failed operations
        return {
          file: validatedFile,
          additions: 0,
          deletions: 0,
          changes: '',
          isNew: status.created.includes(file) || status.not_added.includes(file),
          isDeleted: status.deleted.includes(file),
          isRenamed: status.renamed.some((r: any) => r.to === file),
          oldPath: status.renamed.find((r: any) => r.to === file)?.from
        };
      }
    }, { operation: 'getFileDiff', file });
  }

  /**
   * Get staged changes for commit message generation with security validation
   */
  async getStagedDiff(): Promise<GitDiff[]> {
    return withErrorHandling(async () => {
      const status = await withTimeout(
        this.git.status(),
        DEFAULT_LIMITS.timeoutMs
      );

      if (status.staged.length === 0) {
        throw new SecureError(
          'No staged changes found. Please stage your changes with "git add" first.',
          ErrorType.GIT_ERROR,
          { operation: 'getStagedDiff' },
          true
        );
      }

      const diffs: GitDiff[] = [];
      const validatedFiles = this.validateFilePaths(status.staged);

      for (const file of validatedFiles) {
        try {
          const diff = await withTimeout(
            this.git.diff(['--cached', file]),
            DEFAULT_LIMITS.timeoutMs
          );
          const diffSummary = await withTimeout(
            this.git.diffSummary(['--cached', file]),
            DEFAULT_LIMITS.timeoutMs
          );

          // Validate diff size
          const diffValidation = validateDiffSize(diff);
          if (!diffValidation.isValid) {
            console.warn(`Diff too large for ${file}, skipping content`);
            continue;
          }

          const fileSummary = diffSummary.files.find((f: any) => f.file === file);

          diffs.push({
            file,
            additions: fileSummary?.insertions || 0,
            deletions: fileSummary?.deletions || 0,
            changes: diffValidation.sanitizedValue!,
            isNew: status.created.includes(file),
            isDeleted: status.deleted.includes(file),
            isRenamed: status.renamed.some((r: any) => r.to === file),
            oldPath: status.renamed.find((r: any) => r.to === file)?.from
          });
        } catch (error) {
          console.warn(`Failed to get diff for ${file}:`, error);
        }
      }

      return diffs;
    }, { operation: 'getStagedDiff' });
  }

  /**
   * Get a summary of changes for AI context
   */
  async getChangesSummary(): Promise<string> {
    const diffs = await this.getStagedDiff();

    if (diffs.length === 0) {
      return 'No staged changes found.';
    }

    let summary = `Changes summary:\n`;
    summary += `- ${diffs.length} file(s) modified\n`;

    const totalAdditions = diffs.reduce((sum, diff) => sum + diff.additions, 0);
    const totalDeletions = diffs.reduce((sum, diff) => sum + diff.deletions, 0);

    summary += `- ${totalAdditions} line(s) added\n`;
    summary += `- ${totalDeletions} line(s) deleted\n\n`;

    summary += `Files:\n`;
    diffs.forEach(diff => {
      let status = '';
      if (diff.isNew) status = '[NEW]';
      else if (diff.isDeleted) status = '[DELETED]';
      else if (diff.isRenamed) status = '[RENAMED]';
      else status = '[MODIFIED]';

      summary += `- ${status} ${diff.file} (+${diff.additions}/-${diff.deletions})\n`;
    });

    return summary;
  }

  /**
   * Stage all changes with security validation
   */
  async stageAll(): Promise<void> {
    return withErrorHandling(async () => {
      await withTimeout(
        this.git.add('.'),
        DEFAULT_LIMITS.timeoutMs
      );
    }, { operation: 'stageAll' });
  }

  /**
   * Stage specific files with security validation
   */
  async stageFiles(files: string[]): Promise<void> {
    return withErrorHandling(async () => {
      const validatedFiles = this.validateFilePaths(files);
      if (validatedFiles.length === 0) {
        throw new SecureError(
          'No valid files to stage',
          ErrorType.VALIDATION_ERROR,
          { operation: 'stageFiles' },
          true
        );
      }
      await withTimeout(
        this.git.add(validatedFiles),
        DEFAULT_LIMITS.timeoutMs
      );
    }, { operation: 'stageFiles' });
  }

  /**
   * Stage a single file with security validation
   */
  async stageFile(file: string): Promise<void> {
    return withErrorHandling(async () => {
      const pathValidation = validateAndSanitizePath(file, this.repositoryPath);
      if (!pathValidation.isValid) {
        throw new SecureError(
          pathValidation.error!,
          ErrorType.SECURITY_ERROR,
          { operation: 'stageFile', file },
          false
        );
      }
      await withTimeout(
        this.git.add(pathValidation.sanitizedValue!),
        DEFAULT_LIMITS.timeoutMs
      );
    }, { operation: 'stageFile', file });
  }

  /**
   * Commit changes with message and security validation
   */
  async commit(message: string): Promise<void> {
    return withErrorHandling(async () => {
      // Validate commit message
      const messageValidation = validateCommitMessage(message);
      if (!messageValidation.isValid) {
        throw new SecureError(
          messageValidation.error!,
          ErrorType.VALIDATION_ERROR,
          { operation: 'commit' },
          true
        );
      }

      await withTimeout(
        this.git.commit(messageValidation.sanitizedValue!),
        DEFAULT_LIMITS.timeoutMs
      );
    }, { operation: 'commit' });
  }

  /**
   * Push changes to remote with retry mechanism
   */
  async push(): Promise<void> {
    return withRetry(async () => {
      return withErrorHandling(async () => {
        const status = await withTimeout(
          this.git.status(),
          DEFAULT_LIMITS.timeoutMs
        );
        const branch = status.current || 'main';

        await withTimeout(
          this.git.push('origin', branch),
          DEFAULT_LIMITS.timeoutMs
        );
      }, { operation: 'push' });
    }, 3, 500, { operation: 'push' });
  }

  /**
   * Get the last commit message for context
   */
  async getLastCommitMessage(): Promise<string | null> {
    try {
      const log = await this.git.log({ maxCount: 1 });
      return log.latest?.message || null;
    } catch {
      return null;
    }
  }

  /**
   * Get repository information
   */
  async getRepoInfo(): Promise<{ name: string; branch: string }> {
    const status = await this.git.status();
    const remotes = await this.git.getRemotes(true);

    let repoName = 'unknown';
    if (remotes.length > 0) {
      const origin = remotes.find((r: any) => r.name === 'origin');
      if (origin?.refs?.fetch) {
        const match = origin.refs.fetch.match(/\/([^\/]+?)(?:\.git)?$/);
        if (match) {
          repoName = match[1];
        }
      }
    }

    return {
      name: repoName,
      branch: status.current || 'main'
    };
  }
}
