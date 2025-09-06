import simpleGit, { SimpleGit, DiffResult } from 'simple-git';
import { GitDiff, GitStatus } from '../types/index.js';

export class GitService {
  private git: SimpleGit;

  constructor() {
    this.git = simpleGit();
  }

  /**
   * Check if we're in a git repository
   */
  isGitRepository = async (): Promise<boolean> => {
    try {
      await this.git.status();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the current repository status
   */
  getStatus = async (): Promise<GitStatus> => {
    const status = await this.git.status();

    return {
      staged: status.staged,
      unstaged: status.modified,
      untracked: status.not_added,
      total: status.staged.length + status.modified.length + status.not_added.length
    };
  }

  /**
   * Get all unstaged and untracked files
   */
  getUnstagedFiles = async (): Promise<string[]> => {
    const status = await this.git.status();
    return [...status.modified, ...status.not_added, ...status.deleted];
  }

  /**
   * Get diff for a specific file (staged or unstaged)
   */
  getFileDiff = async (file: string, staged: boolean = false): Promise<GitDiff> => {
    const status = await this.git.status();

    try {
      const diffArgs = staged ? ['--cached', file] : [file];
      const diff = await this.git.diff(diffArgs);
      const diffSummary = await this.git.diffSummary(diffArgs);

      const fileSummary = diffSummary.files.find((f: any) => f.file === file);

      return {
        file,
        additions: fileSummary?.insertions || 0,
        deletions: fileSummary?.deletions || 0,
        changes: diff,
        isNew: status.created.includes(file) || status.not_added.includes(file),
        isDeleted: status.deleted.includes(file),
        isRenamed: status.renamed.some((r: any) => r.to === file),
        oldPath: status.renamed.find((r: any) => r.to === file)?.from
      };
    } catch (error) {
      console.warn(`Failed to get diff for ${file}:`, error);
      return {
        file,
        additions: 0,
        deletions: 0,
        changes: '',
        isNew: status.created.includes(file) || status.not_added.includes(file),
        isDeleted: status.deleted.includes(file),
        isRenamed: status.renamed.some((r: any) => r.to === file),
        oldPath: status.renamed.find((r: any) => r.to === file)?.from
      };
    }
  }

  /**
   * Get staged changes for commit message generation
   */
  async getStagedDiff(): Promise<GitDiff[]> {
    const status = await this.git.status();

    if (status.staged.length === 0) {
      throw new Error('No staged changes found. Please stage your changes with "git add" first.');
    }

    const diffs: GitDiff[] = [];

    for (const file of status.staged) {
      try {
        const diff = await this.git.diff(['--cached', file]);
        const diffSummary = await this.git.diffSummary(['--cached', file]);

        const fileSummary = diffSummary.files.find((f: any) => f.file === file);

        diffs.push({
          file,
          additions: fileSummary?.insertions || 0,
          deletions: fileSummary?.deletions || 0,
          changes: diff,
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
   * Stage all changes
   */
  async stageAll(): Promise<void> {
    await this.git.add('.');
  }

  /**
   * Stage specific files
   */
  async stageFiles(files: string[]): Promise<void> {
    await this.git.add(files);
  }

  /**
   * Stage a single file
   */
  async stageFile(file: string): Promise<void> {
    await this.git.add(file);
  }

  /**
   * Commit changes with message
   */
  async commit(message: string): Promise<void> {
    await this.git.commit(message);
  }

  /**
   * Push changes to remote
   */
  async push(): Promise<void> {
    const status = await this.git.status();
    const branch = status.current || 'main';
    await this.git.push('origin', branch);
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
