export type Sleep = (delayMs: number) => Promise<void>;

export type RpcRetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: Sleep;
};

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 2_000;

export async function retryTransientRpc<T>(
  operation: () => Promise<T>,
  options: RpcRetryOptions = {},
): Promise<T> {
  const maxAttempts = boundedInteger(
    options.maxAttempts,
    DEFAULT_MAX_ATTEMPTS,
    1,
    5,
    "maxAttempts",
  );
  const baseDelayMs = boundedInteger(
    options.baseDelayMs,
    DEFAULT_BASE_DELAY_MS,
    0,
    10_000,
    "baseDelayMs",
  );
  const maxDelayMs = boundedInteger(
    options.maxDelayMs,
    DEFAULT_MAX_DELAY_MS,
    0,
    30_000,
    "maxDelayMs",
  );
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientRpcError(error) || attempt >= maxAttempts) {
        throw error;
      }

      const exponentialDelay = baseDelayMs * 2 ** (attempt - 1);
      const retryAfterMs = findRetryAfterMs(error);
      const delayMs = Math.min(
        Math.max(exponentialDelay, retryAfterMs ?? 0),
        maxDelayMs,
      );
      await sleep(delayMs);
    }
  }
}

export function isTransientRpcError(error: unknown): boolean {
  for (const candidate of errorChain(error)) {
    const status =
      numericProperty(candidate, "status") ??
      numericProperty(candidate, "statusCode");
    if (status === 429 || (status !== undefined && status >= 500)) {
      return true;
    }

    const code = stringProperty(candidate, "code")?.toUpperCase();
    if (
      code !== undefined &&
      [
        "NETWORK_ERROR",
        "SERVER_ERROR",
        "TIMEOUT",
        "ECONNRESET",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "EAI_AGAIN",
      ].includes(code)
    ) {
      return true;
    }

    const message = stringProperty(candidate, "message")?.toLowerCase();
    if (
      message !== undefined &&
      [
        "429",
        "rate limit",
        "too many requests",
        "request timed out",
        "rpc request timed out",
        "temporarily unavailable",
        "socket hang up",
        "econnreset",
        "etimedout",
      ].some((fragment) => message.includes(fragment))
    ) {
      return true;
    }
  }

  return false;
}

function findRetryAfterMs(error: unknown): number | undefined {
  for (const candidate of errorChain(error)) {
    const direct = property(candidate, "retryAfter");
    const header = headerValue(property(candidate, "headers"), "retry-after");
    const responseHeaders = headerValue(
      property(property(candidate, "response"), "headers"),
      "retry-after",
    );
    const parsed = parseRetryAfter(direct ?? header ?? responseHeaders);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  return undefined;
}

function parseRetryAfter(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.ceil(value * 1_000);
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }

  const date = Date.parse(value);
  if (!Number.isFinite(date)) {
    return undefined;
  }

  return Math.max(0, date - Date.now());
}

function headerValue(headers: unknown, name: string): unknown {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  if (!headers || typeof headers !== "object") {
    return undefined;
  }

  const record = headers as Record<string, unknown>;
  return (
    record[name] ?? record[name.toLowerCase()] ?? record[name.toUpperCase()]
  );
}

function* errorChain(error: unknown): Generator<Record<string, unknown>> {
  const seen = new Set<unknown>();
  let candidate: unknown = error;

  while (candidate && typeof candidate === "object" && !seen.has(candidate)) {
    seen.add(candidate);
    const record = candidate as Record<string, unknown>;
    yield record;
    candidate = record.cause ?? record.error ?? record.info;
  }
}

function property(value: unknown, name: string): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return (value as Record<string, unknown>)[name];
}

function stringProperty(
  value: Record<string, unknown>,
  name: string,
): string | undefined {
  const result = value[name];
  return typeof result === "string" ? result : undefined;
}

function numericProperty(
  value: Record<string, unknown>,
  name: string,
): number | undefined {
  const result = value[name];
  return typeof result === "number" ? result : undefined;
}

function boundedInteger(
  value: number | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const result = value ?? defaultValue;
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return result;
}

async function defaultSleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
