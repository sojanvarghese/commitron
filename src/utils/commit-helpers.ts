/// <reference path="../types/global.d.ts" />

import { GitDiff, CommitType } from '../types/index.js';

/**
 * Utility functions for commit message processing and analysis
 */

/**
 * Determines the most appropriate commit type based on file changes
 */
export const analyzeCommitType = (diffs: GitDiff[]): CommitType => {
  const filePatterns = diffs.map(diff => ({
    file: diff.file,
    isNew: diff.isNew,
    isDeleted: diff.isDeleted,
    hasTests: diff.file.includes('test') || diff.file.includes('spec'),
    isDocs: diff.file.includes('README') || diff.file.endsWith('.md'),
    isConfig: diff.file.includes('config') || diff.file.includes('.json') || diff.file.includes('.yml'),
    isStyles: diff.file.endsWith('.css') || diff.file.endsWith('.scss') || diff.file.endsWith('.less'),
    isCI: diff.file.includes('.github') || diff.file.includes('workflow') || diff.file.includes('Dockerfile')
  }));

  // Determine commit type based on file patterns
  if (filePatterns.every(p => p.hasTests)) return CommitType.TEST;
  if (filePatterns.every(p => p.isDocs)) return CommitType.DOCS;
  if (filePatterns.every(p => p.isStyles)) return CommitType.STYLE;
  if (filePatterns.every(p => p.isConfig)) return CommitType.BUILD;
  if (filePatterns.every(p => p.isCI)) return CommitType.CI;
  if (filePatterns.some(p => p.isNew)) return CommitType.FEAT;

  return CommitType.CHORE; // Default fallback
};

/**
 * Extracts scope from file path for conventional commits
 */
export const extractScope = (filePath: string): string | undefined => {
  const pathParts = filePath.split('/');

  // Extract meaningful scope from path
  if (pathParts.includes('src')) {
    const srcIndex = pathParts.indexOf('src');
    if (pathParts[srcIndex + 1]) {
      return pathParts[srcIndex + 1];
    }
  }

  // Common scope patterns
  if (filePath.includes('auth')) return 'auth';
  if (filePath.includes('api')) return 'api';
  if (filePath.includes('ui') || filePath.includes('component')) return 'ui';
  if (filePath.includes('util')) return 'utils';
  if (filePath.includes('config')) return 'config';
  if (filePath.includes('test')) return 'test';
  if (filePath.includes('doc')) return 'docs';

  return undefined;
};

/**
 * Generates a meaningful description based on file changes
 */
export const generateDescription = (diff: GitDiff): string => {
  const { file, isNew, isDeleted, isRenamed, additions, deletions } = diff;
  const fileName = file.split('/').pop() || file;

  if (isDeleted) {
    return `removed ${fileName}`;
  }

  if (isNew) {
    return `added ${fileName} with ${additions} lines`;
  }

  if (isRenamed) {
    return `renamed ${diff.oldPath} to ${file}`;
  }

  // Analyze the nature of changes
  const netChange = additions - deletions;
  if (netChange > 50) {
    return `significantly enhanced ${fileName}`;
  } else if (netChange > 10) {
    return `updated ${fileName} with new functionality`;
  } else if (deletions > additions) {
    return `refactored ${fileName} and removed unused code`;
  } else {
    return `improved ${fileName}`;
  }
};

/**
 * Formats commit message according to conventional commits
 */
export const formatConventionalCommit = (
  type: CommitType,
  scope: string | undefined,
  description: string
): string => {
  const scopeStr = scope ? `(${scope})` : '';
  return `${type}${scopeStr}: ${description}`;
};

/**
 * Validates if a commit message follows best practices
 */
export const validateCommitMessage = (message: string): { valid: boolean; suggestions: string[] } => {
  const suggestions: string[] = [];

  // Check for past tense
  const firstWord = message.split(' ')[0].toLowerCase();
  const pastTenseWords = ['added', 'fixed', 'updated', 'removed', 'refactored', 'improved', 'enhanced'];
  const presentTenseWords = ['add', 'fix', 'update', 'remove', 'refactor', 'improve', 'enhance'];

  if (presentTenseWords.includes(firstWord)) {
    suggestions.push(`Use past tense: "${firstWord}ed" instead of "${firstWord}"`);
  }

  // Check for specificity
  const vagueWords = ['updated', 'changed', 'modified', 'fixed'];
  if (vagueWords.some(word => message.toLowerCase().includes(word)) && message.length < 30) {
    suggestions.push('Be more specific about what was updated/changed/fixed');
  }

  // Check length
  if (message.length > 72) {
    suggestions.push('Keep first line under 72 characters');
  }

  return {
    valid: suggestions.length === 0,
    suggestions
  };
};
