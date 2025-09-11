import type { SimpleGit } from 'simple-git';
import simpleGit from 'simple-git';
import type { GitDiff, GitStatus } from '../types/common.js';
import {
  validateAndSanitizePath,
  validateDiffSize,
  withTimeout,
  validateGitRepository,
  validateCommitMessage,
} from '../utils/security.js';
import { ErrorType } from '../types/error-handler.js';
import { ErrorHandler, withErrorHandling, withRetry, SecureError } from '../utils/error-handler.js';
import { GIT_TIMEOUT_MS, GIT_RETRY_ATTEMPTS, GIT_RETRY_DELAY_MS } from '../constants/git.js';
import { ERROR_MESSAGES } from '../constants/messages.js';
import { UI_CONSTANTS } from '../constants/ui.js';

export class GitService {
  private git: SimpleGit;
  private readonly errorHandler: ErrorHandler;
  private repositoryPath: string;

  constructor() {
    this.git = simpleGit();
    this.errorHandler = ErrorHandler.getInstance();
    this.repositoryPath = process.cwd();
  }

  // Initialize the repository path by finding the actual git root
  private async initializeRepositoryPath(): Promise<void> {
    const validation = await validateGitRepository(this.repositoryPath);
    if (validation.isValid) {
      this.repositoryPath = validation.sanitizedValue!;
      // Change working directory to the git repository root
      process.chdir(this.repositoryPath);
    }
  }

  isGitRepository = async (): Promise<boolean> => {
    return withErrorHandling(
      async () => {
        // Initialize repository path to find the actual git root
        await this.initializeRepositoryPath();

        const validation = await validateGitRepository(this.repositoryPath);
        if (!validation.isValid) {
          // Provide more detailed error information
          const errorMessage = `Git repository validation failed for path: ${this.repositoryPath}\nError: ${validation.error}`;
          throw new SecureError(
            errorMessage,
            ErrorType.GIT_ERROR,
            { operation: 'isGitRepository' },
            false
          );
        }
        return true;
      },
      { operation: 'isGitRepository' }
    );
  };

  getStatus = async (): Promise<GitStatus> => {
    return withErrorHandling(
      async () => {
        const status = await withTimeout(this.git.status(), GIT_TIMEOUT_MS);

        const staged = this.validateFilePaths(status.staged);
        const unstaged = this.validateFilePaths(status.modified);
        const untracked = this.validateFilePaths(status.not_added);

        return {
          staged,
          unstaged,
          untracked,
          total: staged.length + unstaged.length + untracked.length,
        };
      },
      { operation: 'getStatus' }
    );
  };

  private readonly validateFilePaths = (filePaths: string[]): string[] => {
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

  getUnstagedFiles = async (): Promise<string[]> => {
    return withErrorHandling(
      async () => {
        const status = await withTimeout(this.git.status(), GIT_TIMEOUT_MS);

        const allFiles = [...status.modified, ...status.not_added, ...status.deleted];
        return this.validateFilePaths(allFiles);
      },
      { operation: 'getUnstagedFiles' }
    );
  };

  getFileDiff = async (file: string, staged: boolean = false): Promise<GitDiff> => {
    return withErrorHandling(
      async () => {
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
        const status = await withTimeout(this.git.status(), GIT_TIMEOUT_MS);

        // Convert absolute path to relative path for comparison with git status
        const relativeFile = file.startsWith(this.repositoryPath)
          ? file.substring(this.repositoryPath.length + 1)
          : file;

        try {
          const isDeleted = status.deleted.includes(relativeFile);

          if (isDeleted && !staged) {
            return {
              file: validatedFile,
              additions: 0,
              deletions: 1,
              changes: `File deleted: ${validatedFile}`,
              isNew: false,
              isDeleted: true,
              isRenamed: false,
              oldPath: undefined,
            };
          }

          const isUntracked = status.not_added.includes(relativeFile);

          if (isUntracked && !staged) {
            // For untracked files, read the file content directly
            const { readFile } = await import('fs/promises');
            const fileContent = await readFile(validatedFile, 'utf-8');
            const lines = fileContent.split('\n').length;

            return {
              file: validatedFile,
              additions: lines,
              deletions: 0,
              changes: `+${fileContent}`,
              isNew: true,
              isDeleted: false,
              isRenamed: false,
              oldPath: undefined,
            };
          }

          const diffArgs = staged ? ['--cached', validatedFile] : [validatedFile];
          const diff = await withTimeout(this.git.diff(diffArgs), GIT_TIMEOUT_MS);
          const diffSummary = await withTimeout(this.git.diffSummary(diffArgs), GIT_TIMEOUT_MS);

          const diffValidation = validateDiffSize(diff);
          if (!diffValidation.isValid) {
            // For lock files, use summary data instead of full diff content
            const isLockFile =
              relativeFile.includes('yarn.lock') ||
              relativeFile.includes('package-lock.json') ||
              relativeFile.includes('pnpm-lock.yaml');

            if (isLockFile) {
              const fileSummary = diffSummary.files.find((f: any) => f.file === relativeFile);
              return {
                file: validatedFile,
                additions: fileSummary?.insertions || 0,
                deletions: fileSummary?.deletions || 0,
                changes: `Lock file updated: ${fileSummary?.insertions || 0} additions, ${fileSummary?.deletions || 0} deletions`,
                isNew:
                  status.created.includes(relativeFile) || status.not_added.includes(relativeFile),
                isDeleted: status.deleted.includes(relativeFile),
                isRenamed: status.renamed.some((r: any) => r.to === relativeFile),
                oldPath: status.renamed.find((r: any) => r.to === relativeFile)?.from,
              };
            }

            throw new SecureError(
              diffValidation.error!,
              ErrorType.VALIDATION_ERROR,
              { operation: 'getFileDiff', file: validatedFile },
              true
            );
          }

          const fileSummary = diffSummary.files.find((f: any) => f.file === relativeFile);

          return {
            file: validatedFile,
            additions: fileSummary?.insertions || 0,
            deletions: fileSummary?.deletions || 0,
            changes: diffValidation.sanitizedValue!,
            isNew: status.created.includes(relativeFile) || status.not_added.includes(relativeFile),
            isDeleted: status.deleted.includes(relativeFile),
            isRenamed: status.renamed.some((r: any) => r.to === relativeFile),
            oldPath: status.renamed.find((r: any) => r.to === relativeFile)?.from,
          };
        } catch {
          return {
            file: validatedFile,
            additions: 0,
            deletions: 0,
            changes: '',
            isNew: status.created.includes(relativeFile) || status.not_added.includes(relativeFile),
            isDeleted: status.deleted.includes(relativeFile),
            isRenamed: status.renamed.some((r: any) => r.to === relativeFile),
            oldPath: status.renamed.find((r: any) => r.to === relativeFile)?.from,
          };
        }
      },
      { operation: 'getFileDiff', file }
    );
  };

  getStagedDiff = async (): Promise<GitDiff[]> => {
    return withErrorHandling(
      async () => {
        const status = await withTimeout(this.git.status(), GIT_TIMEOUT_MS);

        if (status.staged.length === 0) {
          throw new SecureError(
            ERROR_MESSAGES.NO_STAGED_CHANGES,
            ErrorType.GIT_ERROR,
            { operation: 'getStagedDiff' },
            true
          );
        }

        const diffs: GitDiff[] = [];
        const validatedFiles = this.validateFilePaths(status.staged);

        for (const file of validatedFiles) {
          try {
            const diff = await withTimeout(this.git.diff(['--cached', file]), GIT_TIMEOUT_MS);
            const diffSummary = await withTimeout(
              this.git.diffSummary(['--cached', file]),
              GIT_TIMEOUT_MS
            );

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
              oldPath: status.renamed.find((r: any) => r.to === file)?.from,
            });
          } catch (error) {
            console.warn(`Failed to get diff for ${file}:`, error);
          }
        }

        return diffs;
      },
      { operation: 'getStagedDiff' }
    );
  };

  getChangesSummary = async (): Promise<string> => {
    const diffs = await this.getStagedDiff();

    if (diffs.length === 0) {
      return ERROR_MESSAGES.NO_STAGED_CHANGES_DIFF;
    }

    let summary = `Changes summary:\n`;
    summary += `- ${diffs.length} file(s) modified\n`;

    const totalAdditions = diffs.reduce((sum, diff) => sum + diff.additions, 0);
    const totalDeletions = diffs.reduce((sum, diff) => sum + diff.deletions, 0);

    summary += `- ${totalAdditions} line(s) added\n`;
    summary += `- ${totalDeletions} line(s) deleted\n\n`;

    summary += `Files:\n`;
    diffs.forEach((diff) => {
      const status = this.getFileStatus(diff);

      summary += `- ${status} ${diff.file} (+${diff.additions}/-${diff.deletions})\n`;
    });

    return summary;
  };

  stageAll = async (): Promise<void> => {
    return withErrorHandling(
      async () => {
        await withTimeout(this.git.add('.'), GIT_TIMEOUT_MS);
      },
      { operation: 'stageAll' }
    );
  };

  stageFiles = async (files: string[]): Promise<void> => {
    return withErrorHandling(
      async () => {
        const validatedFiles = this.validateFilePaths(files);
        if (validatedFiles.length === 0) {
          throw new SecureError(
            ERROR_MESSAGES.NO_VALID_FILES,
            ErrorType.VALIDATION_ERROR,
            { operation: 'stageFiles' },
            true
          );
        }
        await withTimeout(this.git.add(validatedFiles), GIT_TIMEOUT_MS);
      },
      { operation: 'stageFiles' }
    );
  };

  stageFile = async (file: string): Promise<void> => {
    return withErrorHandling(
      async () => {
        const pathValidation = validateAndSanitizePath(file, this.repositoryPath);
        if (!pathValidation.isValid) {
          throw new SecureError(
            pathValidation.error!,
            ErrorType.SECURITY_ERROR,
            { operation: 'stageFile', file },
            false
          );
        }
        await withTimeout(this.git.add(pathValidation.sanitizedValue!), GIT_TIMEOUT_MS);
      },
      { operation: 'stageFile', file }
    );
  };

  commit = async (message: string): Promise<void> => {
    return withErrorHandling(
      async () => {
        const messageValidation = validateCommitMessage(message);
        if (!messageValidation.isValid) {
          throw new SecureError(
            messageValidation.error!,
            ErrorType.VALIDATION_ERROR,
            { operation: 'commit' },
            true
          );
        }

        await withTimeout(this.git.commit(messageValidation.sanitizedValue!), GIT_TIMEOUT_MS);
      },
      { operation: 'commit' }
    );
  };

  push = async (): Promise<void> => {
    return withRetry(
      async () => {
        return withErrorHandling(
          async () => {
            const status = await withTimeout(this.git.status(), GIT_TIMEOUT_MS);
            const branch = status.current;

            await withTimeout(this.git.push('origin', branch), GIT_TIMEOUT_MS);
          },
          { operation: 'push' }
        );
      },
      GIT_RETRY_ATTEMPTS,
      GIT_RETRY_DELAY_MS,
      { operation: 'push' }
    );
  };

  getLastCommitMessage = async (): Promise<string | null> => {
    try {
      const log = await this.git.log({ maxCount: 1 });
      return log.latest?.message || null;
    } catch {
      return null;
    }
  };

  getRepoInfo = async (): Promise<{ name: string; branch: string }> => {
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
      branch: status.current,
    };
  };

  private readonly getFileStatus = (diff: GitDiff): string => {
    switch (true) {
      case diff.isNew:
        return UI_CONSTANTS.FILE_STATUS.NEW;
      case diff.isDeleted:
        return UI_CONSTANTS.FILE_STATUS.DELETED;
      case diff.isRenamed:
        return UI_CONSTANTS.FILE_STATUS.RENAMED;
      default:
        return UI_CONSTANTS.FILE_STATUS.MODIFIED;
    }
  };
}
