/// <reference path="../types/global.d.ts" />

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import process from 'process';
import { CommitConfig } from '../types/index.js';

const CONFIG_DIR = path.join(os.homedir(), '.commit-x');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG: CommitConfig = {
  model: 'gemini-1.5-flash',
  style: 'conventional',
  maxLength: 72,
  includeFiles: true,
  autoCommit: false,
  autoPush: false,
  customPrompt: ''
};

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

  private loadConfig = (): CommitConfig => {
    try {
      // Create config directory if it doesn't exist
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
      }

      if (fs.existsSync(CONFIG_FILE)) {
        const configData = fs.readFileSync(CONFIG_FILE, 'utf-8');
        const userConfig = JSON.parse(configData);
        return { ...DEFAULT_CONFIG, ...userConfig };
      }
    } catch (error) {
      console.warn('Failed to load config, using defaults:', error);
    }

    return DEFAULT_CONFIG;
  }

  public saveConfig = (config: Partial<CommitConfig>): void => {
    try {
      this.config = { ...this.config, ...config };

      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
      }

      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
    } catch (error) {
      throw new Error(`Failed to save config: ${error}`);
    }
  }

  public getConfig(): CommitConfig {
    return { ...this.config };
  }

  public get(key: keyof CommitConfig): any {
    return this.config[key];
  }

  public set(key: keyof CommitConfig, value: any): void {
    this.config[key] = value;
    this.saveConfig({});
  }

  public getApiKey(): string {
    // Check environment variable first, then config
    return process.env.GEMINI_API_KEY || this.config.apiKey || '';
  }

  public reset(): void {
    this.config = { ...DEFAULT_CONFIG };
    this.saveConfig(this.config);
  }
}
