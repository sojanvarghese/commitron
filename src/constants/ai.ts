export const AI_RETRY_ATTEMPTS = 1;
export const AI_RETRY_DELAY_MS = 2000;

export const AI_DEFAULT_MODEL = "gemini-3.1-flash-lite";
const AI_FALLBACK_MODELS_AFTER_DEFAULT = [
  "gemini-3.5-flash",
  "gemini-3-flash",
] as const;

export const AI_MODEL_FALLBACK_CHAIN: readonly string[] = Array.from(
  new Set<string>([AI_DEFAULT_MODEL, ...AI_FALLBACK_MODELS_AFTER_DEFAULT])
);
