// Performance-related constants
export const PERFORMANCE_CONSTANTS = {
  // Cache TTLs
  GIT_CACHE_TTL_MS: 5000,
  AI_CACHE_SIZE: 100,
  AI_BATCH_CACHE_SIZE: 50,

  // Batch processing
  FILE_BATCH_SIZE: 10,
  PARALLEL_PROCESSING_THRESHOLD: 3,

  // Memory optimization
  MAX_DIFF_SIZE_FOR_CACHE: 50000, // 50KB
  GARBAGE_COLLECTION_INTERVAL: 60000, // 1 minute

  // Performance monitoring
  SLOW_OPERATION_THRESHOLD_MS: 1000,
  MEMORY_LOG_INTERVAL_MS: 30000, // 30 seconds

  // Startup optimization
  LAZY_LOAD_THRESHOLD_MS: 100,

  // AI request optimization
  AI_REQUEST_DEBOUNCE_MS: 200,
  AI_BATCH_DELAY_MS: 50,
} as const;

// Performance flags
export const PERFORMANCE_FLAGS = {
  ENABLE_CACHING: true,
  ENABLE_PARALLEL_PROCESSING: true,
  ENABLE_PERFORMANCE_MONITORING: false, // Development mode removed
  ENABLE_MEMORY_OPTIMIZATION: true,
  ENABLE_LAZY_LOADING: true,
} as const;
