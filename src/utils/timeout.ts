import { DEFAULT_LIMITS } from '../constants/security.js';

/**
 * Calculate dynamic timeout based on operation complexity
 */
export interface TimeoutCalculationOptions {
  fileSize?: number; // in bytes
  diffSize?: number; // in characters
  totalChanges?: number; // additions + deletions
  fileCount?: number; // number of files being processed
  operationType: 'git' | 'ai' | 'file';
}

/**
 * Calculate dynamic timeout based on file size and complexity
 */
export const calculateDynamicTimeout = (options: TimeoutCalculationOptions): number => {
  const { fileSize = 0, diffSize = 0, totalChanges = 0, fileCount = 1, operationType } = options;

  // Base timeouts by operation type
  const baseTimeouts = {
    git: 15000,  // 15 seconds for git operations
    ai: 20000,   // 20 seconds for AI operations
    file: 10000, // 10 seconds for file operations
  };

  // Maximum timeouts by operation type
  const maxTimeouts = {
    git: 60000,  // 60 seconds max for git operations
    ai: 90000,   // 90 seconds max for AI operations
    file: 30000, // 30 seconds max for file operations
  };

  let timeout = baseTimeouts[operationType];

  // Add time based on file size (1 second per MB)
  if (fileSize > 0) {
    const fileSizeMB = fileSize / (1024 * 1024);
    timeout += Math.floor(fileSizeMB * 1000);
  }

  // Add time based on diff size (1 second per 10KB of diff)
  if (diffSize > 0) {
    const diffSizeKB = diffSize / 1024;
    timeout += Math.floor(diffSizeKB / 10) * 1000;
  }

  // Add time based on total changes (100ms per change line, up to 30 seconds)
  if (totalChanges > 0) {
    const changeTimeout = Math.min(totalChanges * 100, 30000);
    timeout += changeTimeout;
  }

  // Add time based on file count for batch processing (2 seconds per additional file)
  if (fileCount > 1) {
    const batchTimeout = (fileCount - 1) * 2000; // 2s per additional file
    timeout += batchTimeout;
  }

  // Ensure we don't exceed maximum timeout for the operation type
  timeout = Math.min(timeout, maxTimeouts[operationType]);

  // Ensure we meet minimum timeout
  timeout = Math.max(timeout, baseTimeouts[operationType]);

  return timeout;
};

/**
 * Legacy timeout constant for backward compatibility during migration
 * @deprecated Use calculateDynamicTimeout instead
 */
export const GIT_TIMEOUT_MS = DEFAULT_LIMITS.timeoutMs;

/**
 * Calculate timeout for git operations based on operation complexity
 */
export const calculateGitTimeout = (options: Omit<TimeoutCalculationOptions, 'operationType'>): number => {
  return calculateDynamicTimeout({ ...options, operationType: 'git' });
};

/**
 * Calculate timeout for AI operations based on content size
 */
export const calculateAITimeout = (options: Omit<TimeoutCalculationOptions, 'operationType'>): number => {
  return calculateDynamicTimeout({ ...options, operationType: 'ai' });
};

/**
 * Calculate timeout for file operations based on file size
 */
export const calculateFileTimeout = (options: Omit<TimeoutCalculationOptions, 'operationType'>): number => {
  return calculateDynamicTimeout({ ...options, operationType: 'file' });
};
