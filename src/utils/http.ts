const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_USER_AGENT = "AlabamaBeachFlagAPI/1.0";

const RETRY_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

export interface FetchWithRetryOptions extends RequestInit {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  label?: string;
}

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function getRequestLabel(input: string | URL | Request, label?: string): string {
  if (label) {
    return label;
  }

  if (input instanceof Request) {
    return input.url;
  }

  return input.toString();
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function getRetryDelay(baseDelayMs: number, attempt: number): number {
  return baseDelayMs * 2 ** attempt;
}

export async function fetchWithRetry(
  input: string | URL | Request,
  options: FetchWithRetryOptions = {}
): Promise<Response> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    label,
    headers,
    ...requestOptions
  } = options;

  const requestLabel = getRequestLabel(input, label);
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(input, {
        ...requestOptions,
        signal: controller.signal,
        headers: {
          "User-Agent": DEFAULT_USER_AGENT,
          ...headers,
        },
      });

      clearTimeout(timeout);

      if (!RETRY_STATUS_CODES.has(response.status)) {
        return response;
      }

      if (attempt === retries) {
        return response;
      }
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;

      if (attempt === retries) {
        if (isAbortError(error)) {
          throw new Error(
            `[${requestLabel}] Request timed out after ${timeoutMs}ms`
          );
        }

        throw new Error(
          `[${requestLabel}] Request failed after ${attempt + 1} attempt(s): ${String(error)}`
        );
      }
    }

    await sleep(getRetryDelay(retryDelayMs, attempt));
  }

  throw new Error(
    `[${requestLabel}] Unexpected fetch retry failure: ${String(lastError)}`
  );
}