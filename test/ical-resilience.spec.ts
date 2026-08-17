import { describe, expect, it, vi } from "vitest";
import { iCalendarQualityFailure, parseICalendarResult } from "../src/beachEvents/ical";
import { fetchICalendar, ICalendarFetchError, MAX_RETRY_AFTER_MS, sanitizeValidators } from "../src/beachEvents/icalFetch";
import { sanitizeStoredRefreshError } from "../src/beachEvents/refresh";

const provider = { id: "gulfStatePark", name: "Gulf State Park", feedURL: "https://example.gov/feed.ics" };
const event = (uid: string, extra = "") => `BEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:Event ${uid}\r\nDTSTART:20260801T130000Z\r\n${extra}END:VEVENT`;
const calendar = (...events: string[]) => `BEGIN:VCALENDAR\r\n${events.join("\r\n")}\r\nEND:VCALENDAR`;
const response = (body: BodyInit | null, init: ResponseInit = {}) => new Response(body, { status: 200, headers: { "Content-Type": "text/calendar", ...init.headers }, ...init });

describe("bounded iCalendar fetching", () => {
	it("redacts sensitive refresh errors before storage while retaining fixed diagnostics", () => {
		const safe=sanitizeStoredRefreshError(new Error(`Failed https://example.gov/feed?token=secret Authorization: Bearer abc operator@example.com ${"x".repeat(500)}`));expect(safe).not.toMatch(/secret|abc|operator@example\.com/);expect(safe.length).toBeLessThanOrEqual(180);expect(safe).toContain("example.gov");expect(sanitizeStoredRefreshError(new ICalendarFetchError("timeout",{},true))).toBe("ical_timeout");
	});
	it("aborts a timed-out request and exhausts one deterministic retry", async () => {
		const fetcher = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
		await expect(fetchICalendar("https://example.gov", fetcher, {}, { timeoutMs: 2, sleep: async () => {}, random: () => 0 })).rejects.toMatchObject({ category: "timeout", diagnostics: { attemptCount: 2 } });
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("accepts a streamed body exactly at the limit and rejects one byte above without Content-Length", async () => {
		const exact = new TextEncoder().encode("12345");
		expect(await fetchICalendar("x", vi.fn(async () => response(new ReadableStream({ start(c) { c.enqueue(exact); c.close(); } }))) as unknown as typeof fetch, {}, { maxBytes: 5 })).toMatchObject({ status: "fetched", body: "12345", diagnostics: { responseBytes: 5 } });
		await expect(fetchICalendar("x", vi.fn(async () => response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("123456")); c.close(); } }))) as unknown as typeof fetch, {}, { maxBytes: 5 })).rejects.toMatchObject({ category: "response_too_large" });
	});

	it("rejects invalid content types without retry", async () => {
		const fetcher = vi.fn(async () => new Response("html", { headers: { "Content-Type": "text/html" } })) as unknown as typeof fetch;
		await expect(fetchICalendar("x", fetcher)).rejects.toMatchObject({ category: "invalid_content_type", retryable: false });
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it("retries a transient stream failure and keeps bounded response diagnostics", async () => {
		const broken = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("part")); controller.error(new Error("private upstream detail")); } });
		const fetcher = vi.fn().mockResolvedValueOnce(response(broken)).mockResolvedValueOnce(response(calendar(event("ok")))) as unknown as typeof fetch;
		const result = await fetchICalendar("x", fetcher, {}, { sleep: async () => {}, random: () => 0 });
		expect(result).toMatchObject({ status: "fetched", diagnostics: { httpStatus: 200, attemptCount: 2 } });
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it.each([408, 429, 500, 503])("retries HTTP %s once", async (status) => {
		const fetcher = vi.fn().mockResolvedValueOnce(response("down", { status })).mockResolvedValueOnce(response(calendar(event("ok")))) as unknown as typeof fetch;
		const result = await fetchICalendar("x", fetcher, {}, { sleep: async () => {}, random: () => 0 });
		expect(result.diagnostics.attemptCount).toBe(2);
	});

	it.each([400, 401, 404])("does not retry deterministic HTTP %s", async (status) => {
		const fetcher = vi.fn(async () => response("bad", { status })) as unknown as typeof fetch;
		await expect(fetchICalendar("x", fetcher)).rejects.toBeInstanceOf(ICalendarFetchError);
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it("bounds Retry-After and exhausts retryable failures", async () => {
		const waits: number[] = [];
		const fetcher = vi.fn(async () => response("busy", { status: 429, headers: { "Content-Type": "text/calendar", "Retry-After": "999" } })) as unknown as typeof fetch;
		await expect(fetchICalendar("x", fetcher, {}, { sleep: async (ms) => { waits.push(ms); }, random: () => 0 })).rejects.toMatchObject({ category: "http_429", diagnostics: { attemptCount: 2 } });
		expect(waits).toEqual([MAX_RETRY_AFTER_MS]);
	});

	it("sends validators, handles 304, and bounds stored validator values", async () => {
		const fetcher = vi.fn(async (_url, init) => { const headers = new Headers(init?.headers); expect(headers.get("If-None-Match")).toBe('"abc"'); expect(headers.get("If-Modified-Since")).toBe("Tue, 01 Jan 2030 00:00:00 GMT"); return new Response(null, { status: 304 }); }) as unknown as typeof fetch;
		expect(await fetchICalendar("x", fetcher, { etag: '"abc"', lastModified: "Tue, 01 Jan 2030 00:00:00 GMT" })).toMatchObject({ status: "notModified" });
		expect(sanitizeValidators({ etag: `x\n${"y".repeat(300)}` }).etag).toHaveLength(256);
	});
});

describe("isolated VEVENT parsing and quality", () => {
	it("rejects an unusable envelope but quarantines one malformed component", () => {
		expect(() => parseICalendarResult("BEGIN:VCALENDAR", provider)).toThrow(/envelope/);
		const result = parseICalendarResult(calendar(event("good"), event("known-uid").replace("20260801T130000Z", "invalid")), provider);
		expect(result).toMatchObject({ totalVEventCount: 2, validVEventCount: 1, rejectedVEventCount: 1, complete: false, rejected: [{ componentIndex: 2, uidHash: "6efcd97f", fieldCategory: "dtstart_invalid" }] });
		expect(JSON.stringify(result.rejected)).not.toContain("known-uid");
	});

	it("allows at most five percent malformed components and guards a formerly healthy feed from zero valid events", () => {
		expect(iCalendarQualityFailure({ totalVEventCount: 20, validVEventCount: 19, rejectedVEventCount: 1 })).toBeUndefined();
		expect(iCalendarQualityFailure({ totalVEventCount: 19, validVEventCount: 18, rejectedVEventCount: 1 })).toBe("malformed_ratio_quality_gate");
		expect(iCalendarQualityFailure({ totalVEventCount: 1, validVEventCount: 0, rejectedVEventCount: 1 }, 4)).toBe("zero_valid_quality_gate");
	});

	it("preserves recurrence exception and cancellation identity without expanding RRULE/RDATE/EXDATE", () => {
		const recurring = event("series", "RRULE:FREQ=DAILY\r\nRDATE:20260802T130000Z\r\nEXDATE:20260803T130000Z\r\n");
		const exception = event("series", "RECURRENCE-ID:20260802T130000Z\r\nSTATUS:CANCELLED\r\n");
		const result = parseICalendarResult(calendar(recurring, exception), provider);
		expect(result.events).toEqual(expect.arrayContaining([
			expect.objectContaining({ externalId: "series", recurring: true }),
			expect.objectContaining({ externalId: "series::2026-08-02T13:00:00.000Z", recurrenceId: "2026-08-02T13:00:00.000Z", sourceStatus: "cancelled" }),
		]));
		expect(result.events).toHaveLength(2);
	});
});
