import type { ProviderFetchDiagnostics } from "../providerHealth/types";

/** Five MiB bounds memory use while accommodating current municipal/Google calendar feeds. */
export const DEFAULT_ICAL_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_ICAL_TIMEOUT_MS = 12_000;
export const MAX_RETRY_AFTER_MS = 2_000;
export interface ICalendarValidators { etag?: string; lastModified?: string }
export interface ICalendarFetchOptions { timeoutMs?: number; maxBytes?: number; sleep?: (ms: number) => Promise<void>; random?: () => number }
export interface ICalendarFetchResult { status: "fetched" | "notModified"; body?: string; validators: ICalendarValidators; diagnostics: ProviderFetchDiagnostics }

export class ICalendarFetchError extends Error {
	constructor(readonly category: string, readonly diagnostics: ProviderFetchDiagnostics, readonly retryable = false) { super(category); this.name = "ICalendarFetchError"; }
}

export const sanitizeValidators = (value: ICalendarValidators): ICalendarValidators => {
	const clean = (input: string | undefined) => input?.replace(/[\r\n\0]/g, "").trim().slice(0, 256) || undefined;
	return { etag: clean(value.etag), lastModified: clean(value.lastModified) };
};
const acceptedContentType = (value: string | null) => value ? ["text/calendar", "application/calendar", "application/ics", "text/plain", "application/octet-stream"].includes(value.split(";", 1)[0].trim().toLowerCase()) : false;
const retryDelay = (response: Response | undefined, random: () => number) => {
	const raw = response?.headers.get("Retry-After")?.trim();
	let stated = Number.NaN;
	if (raw && /^\d+$/.test(raw)) stated = Number(raw) * 1000;
	else if (raw) stated = Date.parse(raw) - Date.now();
	const base = Number.isFinite(stated) ? Math.max(0, Math.min(stated, MAX_RETRY_AFTER_MS)) : 100;
	return Math.min(MAX_RETRY_AFTER_MS, base + Math.floor(random() * 100));
};

async function readBounded(response: Response, maxBytes: number): Promise<{ body: string; bytes: number }> {
	const declared = Number(response.headers.get("Content-Length"));
	if (response.headers.has("Content-Length") && Number.isFinite(declared) && declared > maxBytes) throw new ICalendarFetchError("response_too_large", { responseBytes: declared, failureCategory: "response_too_large" });
	if (!response.body) return { body: "", bytes: 0 };
	const reader = response.body.getReader(), chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const item = await reader.read(); if (item.done) break;
			bytes += item.value.byteLength;
			if (bytes > maxBytes) { await reader.cancel(); throw new ICalendarFetchError("response_too_large", { responseBytes: bytes, failureCategory: "response_too_large" }); }
			chunks.push(item.value);
		}
	} catch (error) {
		if (error instanceof ICalendarFetchError) throw error;
		throw new ICalendarFetchError("stream_failure", { responseBytes: bytes, failureCategory: "stream_failure" }, true);
	}
	const combined = new Uint8Array(bytes); let offset = 0;
	for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
	return { body: new TextDecoder().decode(combined), bytes };
}

export async function fetchICalendar(url: string, fetcher: typeof fetch, validators: ICalendarValidators = {}, options: ICalendarFetchOptions = {}): Promise<ICalendarFetchResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_ICAL_TIMEOUT_MS, maxBytes = options.maxBytes ?? DEFAULT_ICAL_MAX_BYTES;
	const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))), random = options.random ?? Math.random;
	validators = sanitizeValidators(validators);
	let lastError: ICalendarFetchError | undefined;
	for (let attempt = 1; attempt <= 2; attempt++) {
		const started = performance.now(), controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
		let response: Response | undefined;
		try {
			const headers: Record<string, string> = { Accept: "text/calendar, application/ics;q=0.9, text/plain;q=0.8", "User-Agent": "AlabamaBeachFlag/1.0 beach-events" };
			if (validators.etag) headers["If-None-Match"] = validators.etag;
			if (validators.lastModified) headers["If-Modified-Since"] = validators.lastModified;
			response = await fetcher(url, { headers, signal: controller.signal });
			const base = { httpStatus: response.status, contentType: response.headers.get("Content-Type") ?? undefined, fetchDurationMs: performance.now() - started, attemptCount: attempt };
			if (response.status === 304) return { status: "notModified", validators, diagnostics: base };
			if (!response.ok) { const retryable = response.status === 408 || response.status === 429 || response.status >= 500; throw new ICalendarFetchError(`http_${response.status}`, { ...base, failureCategory: `http_${response.status}` }, retryable); }
			if (!acceptedContentType(response.headers.get("Content-Type"))) throw new ICalendarFetchError("invalid_content_type", { ...base, failureCategory: "invalid_content_type" });
			let read: { body: string; bytes: number };
			try { read = await readBounded(response, maxBytes); }
			catch (error) {
				if (error instanceof ICalendarFetchError) throw new ICalendarFetchError(error.category, { ...base, ...error.diagnostics, fetchDurationMs: performance.now() - started }, error.retryable);
				throw error;
			}
			return { status: "fetched", body: read.body, validators: sanitizeValidators({ etag: response.headers.get("ETag") ?? undefined, lastModified: response.headers.get("Last-Modified") ?? undefined }), diagnostics: { ...base, responseBytes: read.bytes } };
		} catch (error) {
			lastError = controller.signal.aborted ? new ICalendarFetchError("timeout", { fetchDurationMs: performance.now() - started, failureCategory: "timeout", attemptCount: attempt }, true)
				: error instanceof ICalendarFetchError ? new ICalendarFetchError(error.category, { ...error.diagnostics, attemptCount: attempt }, error.retryable)
				: new ICalendarFetchError("network_failure", { fetchDurationMs: performance.now() - started, failureCategory: "network_failure", attemptCount: attempt }, true);
			if (attempt === 2 || !lastError.retryable) throw lastError;
			await sleep(retryDelay(response, random));
		} finally { clearTimeout(timer); }
	}
	throw lastError!;
}
