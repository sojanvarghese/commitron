// UI and display constants
export const UI_CONSTANTS = {
  // Timeouts and delays
  EXIT_DELAY_MS: 100,

  // Text limits
  COMMIT_MESSAGE_MAX_LENGTH: 72,
  MESSAGE_MAX_LENGTH: 120,
  MAX_WORD_COUNT: 25,
  MIN_WORD_COUNT: 7,
  DIFF_CONTENT_TRUNCATE_LIMIT: 3000,

  // Display settings
  PAGE_SIZE: 10,
  CONFIDENCE_DECREASE: 0.4,
  CONFIDENCE_MIN: 0.3,
  CONFIDENCE_DEFAULT: 0.8,
  CONFIDENCE_FALLBACK: 0.3,

  // File status indicators
  FILE_STATUS: {
    NEW: '[NEW]',
    DELETED: '[DELETED]',
    RENAMED: '[RENAMED]',
    MODIFIED: '[MODIFIED]',
  },

  // Git status indicators
  GIT_STATUS: {
    STAGED: 'A',
    MODIFIED: 'M',
    UNTRACKED: '??',
  },

  // Spinner messages
  SPINNER_MESSAGES: {
    STAGING: 'Staging files...',
    COMMITTING: 'Creating commit...',
    PUSHING: 'Pushing to remote...',
    ANALYZING: 'Analyzing files for batch processing...',
    GENERATING_AI: 'Generating commit messages for',
    GENERATING_MESSAGE: 'Generating commit message...',
    ANALYZING_CHANGES: 'Analyzing changes...',
  },
} as const;

export const FILE_PATTERNS = {
  // Lock files
  LOCK_FILES: [
    'yarn.lock',
    'package-lock.json',
    'pnpm-lock.yaml',
    'composer.lock',
    'Gemfile.lock',
    'Podfile.lock',
    'go.sum',
    'Cargo.lock',
    'Pipfile.lock',
  ],

  // Generated files
  GENERATED_FILES: ['.generated.', '.auto.', '.min.', '.bundle.', '.chunk.'],

  // Build directories
  BUILD_DIRECTORIES: [
    '/dist/',
    '/build/',
    '/.next/',
    '/coverage/',
    '/out/',
    '/target/',
    '/node_modules/',
    '/vendor/',
    '/.nuxt/',
    '/.vuepress/',
    '/.docusaurus/',
  ],

  // Package files
  PACKAGE_FILES: [
    'package.json',
    'composer.json',
    'Gemfile',
    'Podfile',
    'go.mod',
    'Cargo.toml',
    'Pipfile',
    'build.gradle',
    'pom.xml',
    'requirements.txt',
    'pyproject.toml',
  ],

  // Documentation files
  DOCUMENTATION_FILES: ['changelog', 'history', 'release-notes'],

  // Log and temporary files
  LOG_FILES: ['.log', '/logs/', '.cache', '.tmp', '.temp'],

  // Source maps and bundled files
  BUNDLED_FILES: ['.map', '.bundle', '.chunk', '.vendor'],

  // File extensions for specific handling
  STYLE_EXTENSIONS: ['css', 'scss', 'less'],
  DOCUMENTATION_EXTENSIONS: ['md', 'txt', 'rst'],
} as const;

export const COMMIT_MESSAGE_PATTERNS = {
  // Conventional commit prefixes to avoid
  AVOID_PREFIXES: ['feat:', 'fix:', 'chore:'],

  // Numbered list pattern
  NUMBERED_PATTERN: /^\d+\./,

  // JSON pattern for parsing
  JSON_PATTERN: /\{[\s\S]*\}/,
} as const;
