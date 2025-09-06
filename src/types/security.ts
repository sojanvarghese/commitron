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
