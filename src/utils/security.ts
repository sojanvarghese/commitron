/// <reference path="../types/global.d.ts" />

import * as path from 'path';
import * as fs from 'fs';
import { promisify } from 'util';

const stat = promisify(fs.stat);
const access = promisify(fs.access);

/**
 * Security utility functions for input validation, path sanitization, and resource management
 */

export interface ValidationResult {
  isValid: boolean;
  error?: string;
  sanitizedValue?: string;
}

export interface ResourceLimits {
  maxFileSize: number; // in bytes
  maxDiffSize: number; // in characters
  maxApiRequestSize: number; // in characters
  timeoutMs: number; // in milliseconds
}

export const DEFAULT_LIMITS: ResourceLimits = {
  maxFileSize: 10 * 1024 * 1024, // 10MB
  maxDiffSize: 50000, // 50KB
  maxApiRequestSize: 100000, // 100KB
  timeoutMs: 30000 // 30 seconds
};

/**
 * Validates and sanitizes file paths to prevent path traversal attacks
 */
export const validateAndSanitizePath = (filePath: string, baseDir: string): ValidationResult => {
  try {
    // Normalize the path and resolve it relative to base directory
    const normalizedPath = path.normalize(filePath);
    const resolvedPath = path.resolve(baseDir, normalizedPath);
    const baseResolved = path.resolve(baseDir);

    // Check if the resolved path is within the base directory
    if (!resolvedPath.startsWith(baseResolved)) {
      return {
        isValid: false,
        error: 'Path traversal detected: file path is outside allowed directory'
      };
    }

    // Check for suspicious patterns
    const suspiciousPatterns = [
      /\.\./, // Parent directory references
      /\/\.\./, // Parent directory references with slash
      /\\\.\./, // Windows parent directory references
      /\/\//, // Double slashes
      /\\\\/, // Double backslashes
      /[<>:"|?*]/, // Invalid characters
      // Note: Removed /^\./ pattern to allow legitimate hidden files like .eslintrc.cjs
    ];

    for (const pattern of suspiciousPatterns) {
      if (pattern.test(normalizedPath)) {
        return {
          isValid: false,
          error: `Suspicious path pattern detected: ${pattern.source}`
        };
      }
    }

    return {
      isValid: true,
      sanitizedValue: resolvedPath
    };
  } catch (error) {
    return {
      isValid: false,
      error: `Path validation error: ${error}`
    };
  }
};

/**
 * Validates file size against limits
 */
export const validateFileSize = async (filePath: string, maxSize: number = DEFAULT_LIMITS.maxFileSize): Promise<ValidationResult> => {
  try {
    const stats = await stat(filePath);

    if (stats.size > maxSize) {
      return {
        isValid: false,
        error: `File size ${stats.size} bytes exceeds limit of ${maxSize} bytes`
      };
    }

    return {
      isValid: true,
      sanitizedValue: filePath
    };
  } catch (error) {
    return {
      isValid: false,
      error: `File size validation error: ${error}`
    };
  }
};

/**
 * Validates and sanitizes user input for configuration keys
 */
export const validateConfigKey = (key: string): ValidationResult => {
  // Allowed configuration keys
  const allowedKeys = [
    'apiKey', 'model', 'style', 'maxLength', 'includeFiles',
    'autoCommit', 'autoPush', 'customPrompt'
  ];

  if (!key || typeof key !== 'string') {
    return {
      isValid: false,
      error: 'Configuration key must be a non-empty string'
    };
  }

  if (!allowedKeys.includes(key)) {
    return {
      isValid: false,
      error: `Invalid configuration key: ${key}. Allowed keys: ${allowedKeys.join(', ')}`
    };
  }

  return {
    isValid: true,
    sanitizedValue: key
  };
};

/**
 * Validates and sanitizes configuration values
 */
export const validateConfigValue = (key: string, value: any): ValidationResult => {
  switch (key) {
    case 'apiKey':
      if (typeof value !== 'string' || value.length < 10) {
        return {
          isValid: false,
          error: 'API key must be a string with at least 10 characters'
        };
      }
      // Remove any whitespace
      return {
        isValid: true,
        sanitizedValue: value.trim()
      };

    case 'model':
      const allowedModels = [
        'gemini-1.5-flash',
        'gemini-1.5-pro',
        'gemini-1.0-pro',
        'gemini-2.0-flash',
        'gemini-2.0-flash-lite',
        'gemini-2.5-pro',
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite'
      ];
      if (!allowedModels.includes(value)) {
        return {
          isValid: false,
          error: `Invalid model: ${value}. Allowed models: ${allowedModels.join(', ')}`
        };
      }
      return { isValid: true, sanitizedValue: value };

    case 'style':
      const allowedStyles = ['conventional', 'descriptive', 'minimal'];
      if (!allowedStyles.includes(value)) {
        return {
          isValid: false,
          error: `Invalid style: ${value}. Allowed styles: ${allowedStyles.join(', ')}`
        };
      }
      return { isValid: true, sanitizedValue: value };

    case 'maxLength':
      const numValue = Number(value);
      if (isNaN(numValue) || numValue < 20 || numValue > 200) {
        return {
          isValid: false,
          error: 'Max length must be a number between 20 and 200'
        };
      }
      return { isValid: true, sanitizedValue: numValue.toString() };

    case 'includeFiles':
    case 'autoCommit':
    case 'autoPush':
      if (typeof value !== 'boolean' && value !== 'true' && value !== 'false') {
        return {
          isValid: false,
          error: `${key} must be a boolean value (true/false)`
        };
      }
      return {
        isValid: true,
        sanitizedValue: (value === 'true' || value === true).toString()
      };

    case 'customPrompt':
      if (typeof value !== 'string') {
        return {
          isValid: false,
          error: 'Custom prompt must be a string'
        };
      }
      // Limit custom prompt length
      if (value.length > 1000) {
        return {
          isValid: false,
          error: 'Custom prompt must be 1000 characters or less'
        };
      }
      return { isValid: true, sanitizedValue: value.trim() };

    default:
      return {
        isValid: false,
        error: `Unknown configuration key: ${key}`
      };
  }
};

/**
 * Validates commit message input
 */
export const validateCommitMessage = (message: string): ValidationResult => {
  if (!message || typeof message !== 'string') {
    return {
      isValid: false,
      error: 'Commit message must be a non-empty string'
    };
  }

  const trimmed = message.trim();

  if (trimmed.length === 0) {
    return {
      isValid: false,
      error: 'Commit message cannot be empty'
    };
  }

  if (trimmed.length > 200) {
    return {
      isValid: false,
      error: 'Commit message must be 200 characters or less'
    };
  }

  // Check for potentially malicious content
  const suspiciousPatterns = [
    /[<>]/, // HTML tags
    /javascript:/i, // JavaScript protocol
    /data:/i, // Data protocol
    /vbscript:/i, // VBScript protocol
    /on\w+\s*=/i, // Event handlers
  ];

  for (const pattern of suspiciousPatterns) {
    if (pattern.test(trimmed)) {
      return {
        isValid: false,
        error: 'Commit message contains potentially malicious content'
      };
    }
  }

  return {
    isValid: true,
    sanitizedValue: trimmed
  };
};

/**
 * Validates diff content size
 */
export const validateDiffSize = (diff: string, maxSize: number = DEFAULT_LIMITS.maxDiffSize): ValidationResult => {
  if (typeof diff !== 'string') {
    return {
      isValid: false,
      error: 'Diff content must be a string'
    };
  }

  if (diff.length > maxSize) {
    return {
      isValid: false,
      error: `Diff content size ${diff.length} characters exceeds limit of ${maxSize} characters`
    };
  }

  return {
    isValid: true,
    sanitizedValue: diff
  };
};

/**
 * Creates a timeout promise for operations
 */
export const withTimeout = <T>(promise: Promise<T>, timeoutMs: number = DEFAULT_LIMITS.timeoutMs): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
};

/**
 * Safely reads a file with size validation
 */
export const safeReadFile = async (filePath: string, baseDir: string, maxSize: number = DEFAULT_LIMITS.maxFileSize): Promise<{ content: string; error?: string }> => {
  try {
    // Validate path
    const pathValidation = validateAndSanitizePath(filePath, baseDir);
    if (!pathValidation.isValid) {
      return { content: '', error: pathValidation.error };
    }

    // Validate file size
    const sizeValidation = await validateFileSize(pathValidation.sanitizedValue!, maxSize);
    if (!sizeValidation.isValid) {
      return { content: '', error: sizeValidation.error };
    }

    // Read file with timeout
    const content = await withTimeout(
      promisify(fs.readFile)(pathValidation.sanitizedValue!, 'utf-8'),
      DEFAULT_LIMITS.timeoutMs
    );

    return { content };
  } catch (error) {
    return {
      content: '',
      error: `Failed to read file: ${error}`
    };
  }
};

/**
 * Validates API key format (basic validation)
 */
export const validateApiKey = (apiKey: string): ValidationResult => {
  if (!apiKey || typeof apiKey !== 'string') {
    return {
      isValid: false,
      error: 'API key must be a non-empty string'
    };
  }

  const trimmed = apiKey.trim();

  if (trimmed.length < 10) {
    return {
      isValid: false,
      error: 'API key must be at least 10 characters long'
    };
  }

  if (trimmed.length > 200) {
    return {
      isValid: false,
      error: 'API key must be 200 characters or less'
    };
  }

  // Basic format validation for Gemini API keys
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    return {
      isValid: false,
      error: 'API key contains invalid characters'
    };
  }

  return {
    isValid: true,
    sanitizedValue: trimmed
  };
};

/**
 * Sanitizes error messages to prevent information leakage
 */
export const sanitizeError = (error: any): string => {
  if (typeof error === 'string') {
    // Remove potential sensitive information
    return error
      .replace(/api[_-]?key[=:]\s*[^\s]+/gi, 'api_key=***')
      .replace(/token[=:]\s*[^\s]+/gi, 'token=***')
      .replace(/password[=:]\s*[^\s]+/gi, 'password=***')
      .replace(/secret[=:]\s*[^\s]+/gi, 'secret=***');
  }

  if (error instanceof Error) {
    return sanitizeError(error.message);
  }

  return 'An unknown error occurred';
};

/**
 * Validates that a directory is a git repository safely
 */
export const validateGitRepository = async (dir: string): Promise<ValidationResult> => {
  try {
    const gitDir = path.join(dir, '.git');

    // Check if .git directory exists and is accessible
    await access(gitDir, fs.constants.R_OK);

    // Check if it's actually a git repository by looking for HEAD file
    const headFile = path.join(gitDir, 'HEAD');
    await access(headFile, fs.constants.R_OK);

    return {
      isValid: true,
      sanitizedValue: dir
    };
  } catch (error) {
    return {
      isValid: false,
      error: `Not a valid git repository: ${error}`
    };
  }
};
