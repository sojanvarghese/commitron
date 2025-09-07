import { ResourceLimits } from '../types/security.js';

export const DEFAULT_LIMITS: ResourceLimits = {
  maxFileSize: 10 * 1024 * 1024, // 10MB
  maxDiffSize: 50000, // 50KB
  maxApiRequestSize: 100000, // 100KB
  timeoutMs: 10000 // Reduced from 30 seconds to 10 seconds
};

export const ALLOWED_CONFIG_KEYS = [
    'apiKey', 'model', 'style'
  ];

export const ALLOWED_MODELS = [
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-1.0-pro',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite'
];

export const ALLOWED_STYLES = [
  'conventional',
  'descriptive',
  'minimal'
];

export const ALLOWED_AUTO_COMMIT = [
  'true',
  'false'
];

export const SUSPICIOUS_PATTERNS = [
  /\.\./, // Parent directory references
  /\/\.\./, // Parent directory references with slash
  /\\\.\./, // Windows parent directory references
  /\/\//, // Double slashes
  /\\\\/, // Double backslashes
  /[<>:"|?*]/, // Invalid characters
];

export const SUSPICIOUS_COMMIT_PATTERNS = [
    /[<>]/, // HTML tags
    /javascript:/i, // JavaScript protocol
    /data:/i, // Data protocol
    /vbscript:/i, // VBScript protocol
    /on\w+\s*=/i, // Event handlers
  ];
