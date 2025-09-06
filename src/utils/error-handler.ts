import chalk from 'chalk';
import { sanitizeError } from './security.js';
import { ERROR_LOG_LIMIT, RECENT_ERROR_THRESHOLD_MS, DEFAULT_RETRY_ATTEMPTS, DEFAULT_RETRY_DELAY_MS } from '../constants/error-handler.js';
import { ErrorType, ErrorContext } from '../types/error-handler.js';

export class SecureError extends Error {
  public readonly type: ErrorType;
  public readonly context: ErrorContext;
  public readonly isRecoverable: boolean;
  public readonly userMessage: string;

  constructor(
    message: string,
    type: ErrorType = ErrorType.UNKNOWN_ERROR,
    context: ErrorContext = {},
    isRecoverable: boolean = false,
    userMessage?: string
  ) {
    super(sanitizeError(message));
    this.name = 'SecureError';
    this.type = type;
    this.context = { ...context, timestamp: new Date() };
    this.isRecoverable = isRecoverable;
    this.userMessage = userMessage || this.getDefaultUserMessage();
  }

  private getDefaultUserMessage(): string {
    switch (this.type) {
      case ErrorType.VALIDATION_ERROR:
        return 'Invalid input provided. Please check your input and try again.';
      case ErrorType.SECURITY_ERROR:
        return 'Security validation failed. Please check your input for suspicious content.';
      case ErrorType.NETWORK_ERROR:
        return 'Network connection failed. Please check your internet connection and try again.';
      case ErrorType.FILE_SYSTEM_ERROR:
        return 'File operation failed. Please check file permissions and try again.';
      case ErrorType.GIT_ERROR:
        return 'Git operation failed. Please ensure you are in a valid git repository.';
      case ErrorType.AI_SERVICE_ERROR:
        return 'AI service failed. Please check your API key and try again.';
      case ErrorType.CONFIG_ERROR:
        return 'Configuration error. Please run setup again or check your configuration.';
      case ErrorType.TIMEOUT_ERROR:
        return 'Operation timed out. Please try again with a smaller file or check your connection.';
      default:
        return 'An unexpected error occurred. Please try again.';
    }
  }
}

export class ErrorHandler {
  private static instance: ErrorHandler;
  private errorLog: Array<{ error: SecureError; timestamp: Date }> = [];

  private constructor() {}

  public static getInstance(): ErrorHandler {
    if (!ErrorHandler.instance) {
      ErrorHandler.instance = new ErrorHandler();
    }
    return ErrorHandler.instance;
  }

  public handleError = (error: any, context: ErrorContext = {}): SecureError => {
    let secureError: SecureError;

    if (error instanceof SecureError) {
      secureError = error;
    } else {
      secureError = this.createSecureError(error, context);
    }

    this.logError(secureError);
    this.displayError(secureError);

    return secureError;
  };

  private createSecureError = (error: any, context: ErrorContext): SecureError => {
    const message = error?.message || 'Unknown error occurred';
    const sanitizedMessage = sanitizeError(message);

    let type = ErrorType.UNKNOWN_ERROR;
    let isRecoverable = false;

    if (error?.code) {
      switch (error.code) {
        case 'ENOENT':
        case 'EACCES':
        case 'EPERM':
          type = ErrorType.FILE_SYSTEM_ERROR;
          isRecoverable = true;
          break;
        case 'ECONNREFUSED':
        case 'ENOTFOUND':
        case 'ETIMEDOUT':
          type = ErrorType.NETWORK_ERROR;
          isRecoverable = true;
          break;
        case 'ENOTDIR':
        case 'EISDIR':
          type = ErrorType.FILE_SYSTEM_ERROR;
          isRecoverable = true;
          break;
      }
    }

    if (message.includes('timeout') || message.includes('timed out')) {
      type = ErrorType.TIMEOUT_ERROR;
      isRecoverable = true;
    }

    if (message.includes('validation') || message.includes('invalid')) {
      type = ErrorType.VALIDATION_ERROR;
      isRecoverable = true;
    }

    if (message.includes('security') || message.includes('path traversal') || message.includes('suspicious')) {
      type = ErrorType.SECURITY_ERROR;
      isRecoverable = false;
    }

    if (message.includes('git') || message.includes('repository')) {
      type = ErrorType.GIT_ERROR;
      isRecoverable = true;
    }

    if (message.includes('api') || message.includes('gemini') || message.includes('ai')) {
      type = ErrorType.AI_SERVICE_ERROR;
      isRecoverable = true;
    }

    if (message.includes('config') || message.includes('configuration')) {
      type = ErrorType.CONFIG_ERROR;
      isRecoverable = true;
    }

    return new SecureError(sanitizedMessage, type, context, isRecoverable);
  };

  private logError = (error: SecureError): void => {
    this.errorLog.push({ error, timestamp: new Date() });

    if (this.errorLog.length > ERROR_LOG_LIMIT) {
      this.errorLog = this.errorLog.slice(-ERROR_LOG_LIMIT);
    }

    if (process.env.NODE_ENV === 'development') {
      console.error('Error logged:', {
        type: error.type,
        message: error.message,
        context: error.context,
        isRecoverable: error.isRecoverable
      });
    }
  };

  private displayError = (error: SecureError): void => {
    const color = this.getErrorColor(error.type);
    console.error(color(`❌ ${error.userMessage}`));

    if (error.context.operation) {
      console.error(chalk.gray(`   Operation: ${error.context.operation}`));
    }

    if (error.context.file) {
      console.error(chalk.gray(`   File: ${error.context.file}`));
    }

    if (error.isRecoverable) {
      console.error(chalk.yellow('   💡 This error might be recoverable. Please try again.'));
    }
  };

  private getErrorColor = (type: ErrorType): (text: string) => string => {
    switch (type) {
      case ErrorType.SECURITY_ERROR:
        return chalk.red;
      case ErrorType.VALIDATION_ERROR:
        return chalk.yellow;
      case ErrorType.NETWORK_ERROR:
        return chalk.blue;
      case ErrorType.TIMEOUT_ERROR:
        return chalk.blue;
      case ErrorType.FILE_SYSTEM_ERROR:
        return chalk.cyan;
      case ErrorType.GIT_ERROR:
        return chalk.green;
      case ErrorType.AI_SERVICE_ERROR:
        return chalk.blue;
      case ErrorType.CONFIG_ERROR:
        return chalk.yellow;
      default:
        return chalk.red;
    }
  };

  public getErrorStats = (): { total: number; byType: Record<string, number>; recent: number } => {
    const byType: Record<string, number> = {};
    const recent = this.errorLog.filter(
      entry => Date.now() - entry.timestamp.getTime() < RECENT_ERROR_THRESHOLD_MS // Last 24 hours
    ).length;

    this.errorLog.forEach(entry => {
      byType[entry.error.type] = (byType[entry.error.type] || 0) + 1;
    });

    return {
      total: this.errorLog.length,
      byType,
      recent
    };
  };

  public clearErrorLog = (): void => {
    this.errorLog = [];
  };

  public handleProcessExit = (code: number = 1): void => {
    if (this.errorLog.length > 0) {
      console.error(chalk.gray(`\n📊 Error Summary: ${this.errorLog.length} errors logged`));
    }
    process.exit(code);
  };
}

export const withErrorHandling = <T>(
  operation: () => T | Promise<T>,
  context: ErrorContext = {}
): T | Promise<T> => {
  const errorHandler = ErrorHandler.getInstance();

  try {
    const result = operation();

    if (result instanceof Promise) {
      return result.catch((error) => {
        const secureError = errorHandler.handleError(error, context);

        if (!secureError.isRecoverable) {
          errorHandler.handleProcessExit(1);
        }

        throw secureError;
      });
    }

    return result;
  } catch (error) {
    const secureError = errorHandler.handleError(error, context);

    if (!secureError.isRecoverable) {
      errorHandler.handleProcessExit(1);
    }

    throw secureError;
  }
};

export const withRetry = async <T>(
  operation: () => Promise<T>,
  maxRetries: number = DEFAULT_RETRY_ATTEMPTS,
  baseDelay: number = DEFAULT_RETRY_DELAY_MS,
  context: ErrorContext = {}
): Promise<T> => {
  const errorHandler = ErrorHandler.getInstance();
  let lastError: SecureError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = errorHandler.handleError(error, {
        ...context,
        attempt,
        maxRetries
      });

      if (!lastError.isRecoverable || attempt === maxRetries) {
        break;
      }

      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.log(chalk.yellow(`⏳ Retrying in ${delay}ms... (attempt ${attempt}/${maxRetries})`));
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError!;
};
