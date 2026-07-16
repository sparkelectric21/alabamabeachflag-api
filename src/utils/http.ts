const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_USER_AGENT = "AlabamaBeachFlagAPI/1.0";

const RETRY_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_HEADERS = ["authorization", "cookie", "proxy-authorization"];

export type UpstreamErrorCode =
	| "upstream_response_too_large"
	| "unexpected_content_type"
	| "unsafe_upstream_url"
	| "unsafe_redirect"
	| "redirect_limit_exceeded";

export class UpstreamError extends Error {
	constructor(public readonly code: UpstreamErrorCode) {
		super(code);
		this.name = "UpstreamError";
	}
}

export type UpstreamUrlValidator = (url: URL) => void;

export interface FetchWithRetryOptions extends RequestInit {
	timeoutMs?: number;
	retries?: number;
	retryDelayMs?: number;
	maxRedirects?: number;
	label?: string;
	validateUrl?: UpstreamUrlValidator;
}

export interface ReadResponseOptions {
	maxBytes: number;
	contentTypes: readonly string[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function getRequestLabel(input: string | URL | Request, label?: string): string {
	if (label) return label;
	return input instanceof Request ? input.url : input.toString();
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}

function getRetryDelay(baseDelayMs: number, attempt: number): number {
	return baseDelayMs * 2 ** attempt;
}

function isIpLiteral(hostname: string): boolean {
	const normalized = hostname.replace(/^\[|\]$/g, "");
	return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized) || normalized.includes(":");
}

export function validateSafeHttpsUrl(url: URL): void {
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.hash !== "" ||
		url.port !== "" ||
		isIpLiteral(url.hostname)
	) {
		throw new UpstreamError("unsafe_upstream_url");
	}
}

function validatedUrl(value: string | URL, validator?: UpstreamUrlValidator): URL {
	let url: URL;
	try {
		url = new URL(value.toString());
	} catch {
		throw new UpstreamError("unsafe_upstream_url");
	}
	validateSafeHttpsUrl(url);
	validator?.(url);
	return url;
}

function headersForRedirect(headers: Headers, from: URL, to: URL): Headers {
	const redirected = new Headers(headers);
	if (from.origin !== to.origin) {
		for (const name of SENSITIVE_HEADERS) redirected.delete(name);
	}
	return redirected;
}

async function fetchFollowingValidatedRedirects(
	initialUrl: URL,
	requestOptions: RequestInit,
	headers: Headers,
	maxRedirects: number,
	validator: UpstreamUrlValidator | undefined,
): Promise<Response> {
	let currentUrl = initialUrl;
	let currentHeaders = headers;
	const visited = new Set<string>();

	for (let redirectCount = 0; ; redirectCount++) {
		if (visited.has(currentUrl.href)) throw new UpstreamError("unsafe_redirect");
		visited.add(currentUrl.href);

		const response = await fetch(currentUrl, {
			...requestOptions,
			redirect: "manual",
			headers: currentHeaders,
		});

		if (!REDIRECT_STATUS_CODES.has(response.status)) return response;
		if (redirectCount >= maxRedirects) {
			await response.body?.cancel();
			throw new UpstreamError("redirect_limit_exceeded");
		}

		const location = response.headers.get("Location");
		if (!location) {
			await response.body?.cancel();
			throw new UpstreamError("unsafe_redirect");
		}

		let nextUrl: URL;
		try {
			nextUrl = new URL(location, currentUrl);
			validateSafeHttpsUrl(nextUrl);
			validator?.(nextUrl);
		} catch {
			await response.body?.cancel();
			throw new UpstreamError("unsafe_redirect");
		}

		await response.body?.cancel();
		currentHeaders = headersForRedirect(currentHeaders, currentUrl, nextUrl);
		currentUrl = nextUrl;
	}
}

export async function fetchWithRetry(
	input: string | URL | Request,
	options: FetchWithRetryOptions = {},
): Promise<Response> {
	const {
		timeoutMs = DEFAULT_TIMEOUT_MS,
		retries = DEFAULT_RETRIES,
		retryDelayMs = DEFAULT_RETRY_DELAY_MS,
		maxRedirects = DEFAULT_MAX_REDIRECTS,
		label,
		headers,
		validateUrl,
		...requestOptions
	} = options;
	const inputUrl = input instanceof Request ? input.url : input;
	const initialUrl = validatedUrl(inputUrl, validateUrl);
	const requestLabel = getRequestLabel(input, label);
	const baseHeaders = new Headers(input instanceof Request ? input.headers : undefined);
	new Headers(headers).forEach((value, key) => baseHeaders.set(key, value));
	if (!baseHeaders.has("User-Agent")) baseHeaders.set("User-Agent", DEFAULT_USER_AGENT);
	let lastError: unknown;

	for (let attempt = 0; attempt <= retries; attempt++) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetchFollowingValidatedRedirects(
				initialUrl,
				{ ...requestOptions, signal: controller.signal },
				baseHeaders,
				maxRedirects,
				validateUrl,
			);
			clearTimeout(timeout);
			if (!RETRY_STATUS_CODES.has(response.status) || attempt === retries) return response;
			await response.body?.cancel();
		} catch (error) {
			clearTimeout(timeout);
			lastError = error;
			if (error instanceof UpstreamError) throw error;
			if (attempt === retries) {
				if (isAbortError(error)) throw new Error(`[${requestLabel}] Request timed out after ${timeoutMs}ms`);
				throw new Error(`[${requestLabel}] Request failed after ${attempt + 1} attempt(s)`);
			}
		}
		await sleep(getRetryDelay(retryDelayMs, attempt));
	}

	throw new Error(`[${requestLabel}] Unexpected fetch retry failure: ${lastError instanceof Error ? lastError.name : "unknown"}`);
}

function validateContentType(response: Response, allowed: readonly string[]): void {
	const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (!contentType || !allowed.includes(contentType)) throw new UpstreamError("unexpected_content_type");
}

export async function readResponseBytes(response: Response, options: ReadResponseOptions): Promise<Uint8Array> {
	validateContentType(response, options.contentTypes);
	const contentLength = response.headers.get("Content-Length");
	if (contentLength !== null) {
		const declaredLength = Number(contentLength);
		if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > options.maxBytes) {
			throw new UpstreamError("upstream_response_too_large");
		}
	}

	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > options.maxBytes) {
				await reader.cancel();
				throw new UpstreamError("upstream_response_too_large");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const output = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

export async function readResponseText(response: Response, options: ReadResponseOptions): Promise<string> {
	return new TextDecoder().decode(await readResponseBytes(response, options));
}

export async function readResponseJson<T>(response: Response, options: ReadResponseOptions): Promise<T> {
	return JSON.parse(await readResponseText(response, options)) as T;
}
