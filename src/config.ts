import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import process from "process";
import * as v from "valibot";
import { CommitConfigSchema, ApiKeySchema } from "./schemas/validation.js";
import type { CommitConfig } from "./types/common.js";
import { sanitizeError } from "./utils/security.js";
import { ErrorType } from "./types/error-handler.js";
import { withErrorHandling, SecureError } from "./utils/error-handler.js";
import {
  CONFIG_DIR as CONFIG_DIR_NAME,
  CONFIG_FILE as CONFIG_FILE_NAME,
  CONFIG_FILE_MODE,
  CONFIG_DIR_MODE,
} from "./constants/config.js";

const CONFIG_DIR = path.join(os.homedir(), CONFIG_DIR_NAME);
const CONFIG_FILE = path.join(CONFIG_DIR, CONFIG_FILE_NAME);

export class ConfigManager {
  private static instance: ConfigManager;
  private config: CommitConfig;

  private constructor() {
    this.config = this.loadConfig();
  }

  public static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  private readonly loadConfig = (): CommitConfig => {
    try {
      // Create config directory if it doesn't exist
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true }); // Create directory recursively
        fs.chmodSync(CONFIG_DIR, CONFIG_DIR_MODE); // Secure permissions
      }

      if (fs.existsSync(CONFIG_FILE)) {
        const configData = fs.readFileSync(CONFIG_FILE, "utf-8");
        const userConfig = JSON.parse(configData);

        const result = v.safeParse(CommitConfigSchema, userConfig);
        if (result.success) {
          return { ...result.output };
        } else {
          console.warn(
            "Invalid config data, using defaults:",
            result.issues
          );
        }
      }
    } catch (error) {
      console.warn(
        "Failed to load config, using defaults:",
        sanitizeError(error)
      );
    }

    return {};
  };

  public saveConfig = async (config: Partial<CommitConfig>): Promise<void> => {
    await withErrorHandling(
      async (): Promise<void> => {
        const result = v.safeParse(v.partial(CommitConfigSchema), config);
        if (!result.success) {
          throw new SecureError(
            `Invalid configuration: ${result.issues.map((e: { message: string }) => e.message).join(", ")}`,
            ErrorType.VALIDATION_ERROR,
            { operation: "saveConfig" },
            true
          );
        }

        this.config = { ...this.config, ...result.output };

        if (!fs.existsSync(CONFIG_DIR)) {
          fs.mkdirSync(CONFIG_DIR, { recursive: true });
          fs.chmodSync(CONFIG_DIR, CONFIG_DIR_MODE);
        }

        // Create a safe config object without sensitive data
        const safeConfig = { ...this.config };
        // Never save API key to file - always use environment variable
        delete safeConfig.apiKey;

        fs.writeFileSync(CONFIG_FILE, JSON.stringify(safeConfig, null, 2));
        fs.chmodSync(CONFIG_FILE, CONFIG_FILE_MODE);
      },
      { operation: "saveConfig" }
    );
  };

  public getConfig = (): CommitConfig => {
    return { ...this.config };
  };

  public get = (key: keyof CommitConfig): unknown => {
    return this.config[key];
  };

  public set = async (
    key: keyof CommitConfig,
    value: unknown
  ): Promise<void> => {
    await withErrorHandling(
      async (): Promise<void> => {
        const result = v.safeParse(CommitConfigSchema.entries[key], value);

        if (!result.success) {
          throw new SecureError(
            `Invalid value for ${key}: ${result.issues.map((e: { message: string }) => e.message).join(", ")}`,
            ErrorType.VALIDATION_ERROR,
            { operation: "setConfig", key },
            true
          );
        }

        this.config[key] = result.output;
        void this.saveConfig({});
      },
      { operation: "setConfig", key }
    );
  };

  public getApiKey = (): string => {
    // Always prioritize environment variable for security
    const envKey = process.env.GEMINI_API_KEY;
    if (envKey) {
      const result = v.safeParse(ApiKeySchema, envKey);
      if (result.success) {
        return result.output;
      }
    }

    // Fallback to config (less secure)
    const configKey = this.config.apiKey;
    if (configKey) {
      const result = v.safeParse(ApiKeySchema, configKey);
      if (result.success) {
        return result.output;
      }
    }

    return "";
  };

  public reset = (): void => {
    this.config = {};
    void this.saveConfig({});
  };
}
