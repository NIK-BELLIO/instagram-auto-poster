type D1Value = string | number | boolean | null;

interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
  meta: Record<string, unknown>;
  error?: string;
}

interface D1ExecResult {
  success: boolean;
  meta: Record<string, unknown>;
  error?: string;
}

interface D1PreparedStatement {
  bind(...values: D1Value[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1ExecResult>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

interface KVNamespace {
  get(key: string, options: { type: "stream" }): Promise<ReadableStream | null>;
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream | string,
    options?: {
      metadata?: Record<string, unknown>;
      expirationTtl?: number;
    }
  ): Promise<void>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface ScheduledEvent {
  scheduledTime: number;
  cron: string;
}
