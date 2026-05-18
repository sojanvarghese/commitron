import * as v from "valibot";

export const ApiKeySchema = v.pipe(
  v.string(),
  v.minLength(10, "API key must be at least 10 characters long"),
  v.maxLength(200, "API key must be 200 characters or less"),
  v.regex(/^[A-Za-z0-9_-]+$/, "API key contains invalid characters"),
  v.transform(val => val.trim())
);

export const CommitConfigSchema = v.object({
  apiKey: v.optional(ApiKeySchema),
});

export const GitDiffSchema = v.object({
  file: v.pipe(v.string(), v.minLength(1, "File path is required")),
  additions: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0, "Additions must be non-negative")
  ),
  deletions: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0, "Deletions must be non-negative")
  ),
  changes: v.string(),
  isNew: v.optional(v.boolean(), false),
  isDeleted: v.optional(v.boolean(), false),
  isRenamed: v.optional(v.boolean(), false),
  oldPath: v.optional(v.string()),
});

export const CommitMessageSchema = v.pipe(
  v.string(),
  v.minLength(1, "Commit message must be a non-empty string"),
  v.maxLength(200, "Commit message must be 200 characters or less"),
  v.check(msg => msg.trim().length > 0, "Commit message cannot be empty"),
  v.check(
    message =>
      [
        /<script/i,
        /javascript:/i,
        /data:/i,
        /vbscript:/i,
        /onload=/i,
        /onerror=/i,
        /onclick=/i,
        /<iframe/i,
      ].some(pattern => pattern.test(message)),
    "Commit message contains potentially malicious content"
  ),
  v.transform(val => val.trim())
);

// Validation result type
export type ValidationResult<T = unknown> = {
  isValid: boolean;
  error?: string;
  sanitizedValue?: T;
};
