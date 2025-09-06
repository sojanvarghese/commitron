import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import process from 'process';
import { CommitConfig } from './types/common.js';
import {
  validateConfigKey,
  validateConfigValue,
  validateApiKey,
  sanitizeError
} from './utils/security.js';
import { ErrorType } from './types/error-handler.js';
import {
  ErrorHandler,
  withErrorHandling,
  SecureError
} from './utils/error-handler.js';
import { CONFIG_DIR as CONFIG_DIR_NAME, CONFIG_FILE as CONFIG_FILE_NAME, CONFIG_FILE_MODE, CONFIG_DIR_MODE, DEFAULT_CONFIG } from './constants/config.js';

const CONFIG_DIR = path.join(os.homedir(), CONFIG_DIR_NAME);
const CONFIG_FILE = path.join(CONFIG_DIR, CONFIG_FILE_NAME);

export class ConfigManager {
  private static instance: ConfigManager;
  private config: CommitConfig;
  private errorHandler: ErrorHandler;

  private constructor() {
    this.errorHandler = ErrorHandler.getInstance();
    this.config = this.loadConfig();
  }

  public static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  private loadConfig = (): CommitConfig => {
    try {
      // Create config directory if it doesn't exist
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: CONFIG_DIR_MODE }); // Secure permissions
      }

      if (fs.existsSync(CONFIG_FILE)) {
        const configData = fs.readFileSync(CONFIG_FILE, 'utf-8');
        const userConfig = JSON.parse(configData);

        // Validate loaded configuration
        const validatedConfig = this.validateConfig(userConfig);
        return { ...DEFAULT_CONFIG, ...validatedConfig };
      }
    } catch (error) {
      console.warn('Failed to load config, using defaults:', sanitizeError(error));
    }

    return DEFAULT_CONFIG;
  }

  public saveConfig = (config: Partial<CommitConfig>): void => {
    withErrorHandling(() => {
      // Validate configuration before saving
      const validatedConfig = this.validateConfig(config);
      this.config = { ...this.config, ...validatedConfig };

      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: CONFIG_DIR_MODE });
      }

      // Create a safe config object without sensitive data
      const safeConfig = { ...this.config };
      // Never save API key to file - always use environment variable
      delete safeConfig.apiKey;

      fs.writeFileSync(CONFIG_FILE, JSON.stringify(safeConfig, null, 2), { mode: CONFIG_FILE_MODE });
    }, { operation: 'saveConfig' });
  }

  public getConfig(): CommitConfig {
    return { ...this.config };
  }

  public get(key: keyof CommitConfig): any {
    return this.config[key];
  }

  public set(key: keyof CommitConfig, value: any): void {
    withErrorHandling(() => {
      // Validate key
      const keyValidation = validateConfigKey(key);
      if (!keyValidation.isValid) {
        throw new SecureError(
          keyValidation.error!,
          ErrorType.VALIDATION_ERROR,
          { operation: 'setConfig', key },
          true
        );
      }

      // Validate value
      const valueValidation = validateConfigValue(key, value);
      if (!valueValidation.isValid) {
        throw new SecureError(
          valueValidation.error!,
          ErrorType.VALIDATION_ERROR,
          { operation: 'setConfig', key },
          true
        );
      }

      this.config[key] = valueValidation.sanitizedValue as any;
      this.saveConfig({});
    }, { operation: 'setConfig', key });
  }

  public getApiKey(): string {
    // Always prioritize environment variable for security
    const envKey = process.env.GEMINI_API_KEY;
    if (envKey) {
      const validation = validateApiKey(envKey);
      if (validation.isValid) {
        return validation.sanitizedValue!;
      }
    }

    // Fallback to config (less secure)
    const configKey = this.config.apiKey;
    if (configKey) {
      const validation = validateApiKey(configKey);
      if (validation.isValid) {
        return validation.sanitizedValue!;
      }
    }

    return '';
  }

  public reset(): void {
    this.config = { ...DEFAULT_CONFIG };
    this.saveConfig(this.config);
  }

  /**
   * Validates configuration object
   */
  private validateConfig = (config: Partial<CommitConfig>): Partial<CommitConfig> => {
    const validatedConfig: Partial<CommitConfig> = {};

    for (const [key, value] of Object.entries(config)) {
      const keyValidation = validateConfigKey(key);
      if (keyValidation.isValid) {
        const valueValidation = validateConfigValue(key, value);
        if (valueValidation.isValid) {
          validatedConfig[key as keyof CommitConfig] = valueValidation.sanitizedValue as any;
        } else {
          console.warn(`Invalid config value for ${key}: ${valueValidation.error}`);
        }
      } else {
        console.warn(`Invalid config key: ${key}`);
      }
    }

    return validatedConfig;
  };
}
