import { GitDiff, CommitType, PlaywrightPatterns } from '../types/common.js';

export const analyzePlaywrightPatterns = (filePath: string): PlaywrightPatterns => {
  const lowerPath = filePath.toLowerCase();
  const fileName = filePath.split('/').pop()?.toLowerCase() || '';

  return {
    isPOM: lowerPath.includes('page') || lowerPath.includes('pom') ||
           fileName.includes('page.') || lowerPath.includes('pageobject'),
    isSpec: fileName.includes('.spec.') || fileName.includes('.test.') ||
            lowerPath.includes('/tests/') || lowerPath.includes('/specs/'),
    isFixture: lowerPath.includes('fixture') || fileName.includes('fixtures.') ||
               lowerPath.includes('test-data') || fileName.includes('setup.'),
    isConfig: fileName.includes('playwright.config') || fileName.includes('test.config') ||
              lowerPath.includes('playwright.config'),
    isUtil: lowerPath.includes('utils') || lowerPath.includes('helpers') ||
            lowerPath.includes('common') || fileName.includes('helper.'),
    testType: lowerPath.includes('e2e') || lowerPath.includes('playwright') ? 'e2e' :
              lowerPath.includes('integration') ? 'integration' :
              lowerPath.includes('unit') ? 'unit' : 'unknown'
  };
};


export const analyzeCommitType = (diffs: GitDiff[]): CommitType => {
  const filePatterns = diffs.map(diff => {
    const playwrightPatterns = analyzePlaywrightPatterns(diff.file);

    return {
      file: diff.file,
      isNew: diff.isNew,
      isDeleted: diff.isDeleted,
      hasTests: diff.file.includes('test') || diff.file.includes('spec'),
      isE2E: playwrightPatterns.testType === 'e2e' || diff.file.includes('playwright') ||
             diff.file.includes('e2e') || playwrightPatterns.isPOM || playwrightPatterns.isSpec,
      isDocs: diff.file.includes('README') || diff.file.endsWith('.md'),
      isConfig: diff.file.includes('config') || diff.file.includes('.json') || diff.file.includes('.yml'),
      isStyles: diff.file.endsWith('.css') || diff.file.endsWith('.scss') || diff.file.endsWith('.less'),
      isCI: diff.file.includes('.github') || diff.file.includes('workflow') || diff.file.includes('Dockerfile'),
      playwrightPatterns
    };
  });

  if (filePatterns.every(p => p.isE2E)) return CommitType.E2E;
  if (filePatterns.every(p => p.hasTests)) return CommitType.TEST;
  if (filePatterns.every(p => p.isDocs)) return CommitType.DOCS;
  if (filePatterns.every(p => p.isStyles)) return CommitType.STYLE;
  if (filePatterns.every(p => p.isConfig)) return CommitType.BUILD;
  if (filePatterns.every(p => p.isCI)) return CommitType.CI;
  if (filePatterns.some(p => p.isNew)) return CommitType.FEAT;

    return CommitType.CHORE;
};


export const extractScope = (filePath: string): string | undefined => {
  const pathParts = filePath.split('/');

  if (pathParts.includes('src')) {
    const srcIndex = pathParts.indexOf('src');
    if (pathParts[srcIndex + 1]) {
      return pathParts[srcIndex + 1];
    }
  }

  if (filePath.includes('auth')) return 'auth';
  if (filePath.includes('api')) return 'api';
  if (filePath.includes('ui') || filePath.includes('component')) return 'ui';
  if (filePath.includes('util')) return 'utils';
  if (filePath.includes('config')) return 'config';
  if (filePath.includes('playwright') || filePath.includes('e2e')) return 'playwright';
  if (filePath.includes('test')) return 'test';
  if (filePath.includes('doc')) return 'docs';

  return undefined;
};


export const generateDescription = (diff: GitDiff): string => {
  const { file, isNew, isDeleted, isRenamed, additions, deletions } = diff;
  const fileName = file.split('/').pop() || file;
  const playwrightPatterns = analyzePlaywrightPatterns(file);

  const capitalize = (str: string) => str.charAt(0).toUpperCase() + str.slice(1);

  if (isDeleted) {
    if (playwrightPatterns.isPOM) {
      return capitalize(`Removed page object model for ${fileName}`);
    } else if (playwrightPatterns.isSpec) {
      return capitalize(`Removed E2E test spec ${fileName}`);
    } else if (playwrightPatterns.isFixture) {
      return capitalize(`Removed test fixture ${fileName}`);
    }
    return capitalize(`Removed ${fileName}`);
  }

  if (isNew) {
    if (playwrightPatterns.isPOM) {
      return capitalize(`Added page object model for ${fileName.replace('.page.', '').replace('.ts', '')}`);
    } else if (playwrightPatterns.isSpec) {
      return capitalize(`Added E2E test spec for ${fileName.replace('.spec.', '').replace('.test.', '').replace('.ts', '')}`);
    } else if (playwrightPatterns.isFixture) {
      return capitalize(`Added test fixture for ${fileName.replace('.fixture.', '').replace('.ts', '')}`);
    } else if (playwrightPatterns.isConfig) {
      return capitalize(`Added Playwright configuration ${fileName}`);
    } else if (playwrightPatterns.isUtil) {
      return capitalize(`Added test utility ${fileName}`);
    }
    return capitalize(`Added ${fileName} with ${additions} lines`);
  }

  if (isRenamed) {
    return capitalize(`Renamed ${diff.oldPath} to ${file}`);
  }

  const netChange = additions - deletions;

  if (playwrightPatterns.isPOM) {
    if (netChange > 10) {
      return capitalize(`Enhanced page object model with new methods`);
    } else {
      return capitalize(`Updated page object model selectors`);
    }
  } else if (playwrightPatterns.isSpec) {
    if (netChange > 20) {
      return capitalize(`Expanded E2E test coverage with new scenarios`);
    } else if (deletions > additions) {
      return capitalize(`Refactored E2E test and removed redundant checks`);
    } else {
      return capitalize(`Updated E2E test assertions`);
    }
  } else if (playwrightPatterns.isFixture) {
    return capitalize(`Updated test fixtures and data setup`);
  } else if (playwrightPatterns.isConfig) {
    return capitalize(`Updated Playwright configuration settings`);
  }

  if (netChange > 50) {
    return capitalize(`Significantly enhanced ${fileName}`);
  } else if (netChange > 10) {
    return capitalize(`Updated ${fileName} with new functionality`);
  } else if (deletions > additions) {
    return capitalize(`Refactored ${fileName} and removed unused code`);
  } else {
    return capitalize(`Improved ${fileName}`);
  }
};


export const formatConventionalCommit = (
  type: CommitType,
  scope: string | undefined,
  description: string
): string => {
  const scopeStr = scope ? `(${scope})` : '';
  return `${type}${scopeStr}: ${description}`;
};


export const validateCommitMessage = (message: string): { valid: boolean; suggestions: string[] } => {
  const suggestions: string[] = [];

  const firstWord = message.split(' ')[0].toLowerCase();
  const pastTenseWords = ['added', 'fixed', 'updated', 'removed', 'refactored', 'improved', 'enhanced'];
  const presentTenseWords = ['add', 'fix', 'update', 'remove', 'refactor', 'improve', 'enhance'];

  if (presentTenseWords.includes(firstWord)) {
    suggestions.push(`Use past tense: "${firstWord}ed" instead of "${firstWord} eg: ${pastTenseWords.join(', ')}"`);
  }

  const vagueWords = ['updated', 'changed', 'modified', 'fixed'];
  if (vagueWords.some(word => message.toLowerCase().includes(word)) && message.length < 30) {
    suggestions.push('Be more specific about what was updated/changed/fixed');
  }

  if (message.length > 72) {
    suggestions.push('Keep first line under 72 characters');
  }

  return {
    valid: suggestions.length === 0,
    suggestions
  };
};
