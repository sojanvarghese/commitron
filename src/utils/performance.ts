// Performance monitoring and optimization utilities

export class PerformanceMonitor {
  private static instance: PerformanceMonitor;
  private readonly startTimes = new Map<string, number>();
  private readonly metrics = new Map<string, { count: number; totalTime: number; avgTime: number }>();

  private constructor() {}

  public static getInstance(): PerformanceMonitor {
    if (!PerformanceMonitor.instance) {
      PerformanceMonitor.instance = new PerformanceMonitor();
    }
    return PerformanceMonitor.instance;
  }

  public startTimer(operation: string): void {
    this.startTimes.set(operation, performance.now());
  }

  public endTimer(operation: string): number {
    const startTime = this.startTimes.get(operation);
    if (!startTime) {
      console.warn(`No start time found for operation: ${operation}`);
      return 0;
    }

    const endTime = performance.now();
    const duration = endTime - startTime;

    // Update metrics
      const existing = this.metrics.get(operation) ?? { count: 0, totalTime: 0, avgTime: 0 };
    existing.count++;
    existing.totalTime += duration;
    existing.avgTime = existing.totalTime / existing.count;
    this.metrics.set(operation, existing);

    this.startTimes.delete(operation);
    return duration;
  }

  public getMetrics(): Map<string, { count: number; totalTime: number; avgTime: number }> {
    return new Map(this.metrics);
  }

  public getOperationTime(operation: string): number | undefined {
    return this.metrics.get(operation)?.avgTime;
  }

  public logMetrics(): void {
    if (process.env.NODE_ENV === 'development') {
      console.log('\n📊 Performance Metrics:');
      for (const [operation, metrics] of this.metrics) {
        console.log(`  ${operation}: ${metrics.avgTime.toFixed(2)}ms (${metrics.count} calls)`);
      }
    }
  }

  public clear(): void {
    this.startTimes.clear();
    this.metrics.clear();
  }
}

// Wrapper for timing async operations
export const withPerformanceTracking = async <T>(
  operation: string,
  fn: () => Promise<T>
): Promise<T> => {
  const monitor = PerformanceMonitor.getInstance();
  monitor.startTimer(operation);
  try {
    const result = await fn();
    const duration = monitor.endTimer(operation);

    // Log slow operations in development
    if (process.env.NODE_ENV === 'development' && duration > 1000) {
      console.warn(`⚠️  Slow operation detected: ${operation} took ${duration.toFixed(2)}ms`);
    }

    return result;
  } catch (error) {
    monitor.endTimer(operation);
    throw error;
  }
};

// Memory usage monitoring
export const logMemoryUsage = (label?: string): void => {
  if (process.env.NODE_ENV === 'development') {
    const used = process.memoryUsage();
    const formatMB = (bytes: number): number => Math.round(bytes / 1024 / 1024 * 100) / 100;

    console.log(`📊 Memory Usage${label ? ` (${label})` : ''}:`);
    console.log(`  RSS: ${formatMB(used.rss)} MB`);
    console.log(`  Heap Used: ${formatMB(used.heapUsed)} MB`);
    console.log(`  Heap Total: ${formatMB(used.heapTotal)} MB`);
    console.log(`  External: ${formatMB(used.external)} MB`);
  }
};

// Force garbage collection if available
export const forceGarbageCollection = (): void => {
  if (global.gc && process.env.NODE_ENV === 'development') {
    global.gc();
  }
};
