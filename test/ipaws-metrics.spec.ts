import { afterEach, describe, expect, it, vi } from "vitest";
import { IpawsIdempotencyCoordinator } from "../src/ipaws/idempotency";
import { buildSoakReport, capLifecycle, IPAWS_CORRELATION_ROTATION_MS, IPAWS_CORRELATION_TTL_MS, IPAWS_METRICS_MAX_REPORT_HOURS, IPAWS_METRICS_RETENTION_DAYS, recordIpawsMetrics, type IpawsMetricsEvent } from "../src/ipaws/metrics";

function storageHarness() {
	const values = new Map<string, unknown>();
	let transactionTail: Promise<unknown> = Promise.resolve();
	const storage = {
		get: async (keyOrKeys: string | string[]) => Array.isArray(keyOrKeys)
			? new Map(keyOrKeys.flatMap((key) => values.has(key) ? [[key, values.get(key)]] : []))
			: values.get(keyOrKeys),
		put: async (keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
			if (typeof keyOrEntries === "string") values.set(keyOrEntries, value);
			else for (const [key, item] of Object.entries(keyOrEntries)) values.set(key, item);
		},
		delete: async (keyOrKeys: string | string[]) => {
			for (const key of Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]) values.delete(key);
			return true;
		},
		transaction: async <T>(callback: (transaction: typeof storage) => Promise<T>) => {
			const run = transactionTail.then(() => callback(storage));
			transactionTail = run.catch(() => undefined);
			return run;
		},
	};
	return { values, storage: storage as unknown as DurableObjectStorage };
}

function event(overrides: Partial<IpawsMetricsEvent> = {}): IpawsMetricsEvent {
	return {
		httpStatus: "2xx", handlerOutcome: "accepted", snsType: "Notification", signature: "success",
		capParse: "success", capLifecycle: "Alert", idempotency: ["acquired", "completion"],
		normalizedRecord: ["success"], rejection: "none", latencyMs: 125, successfulDelivery: true,
		processingStages: ["envelope_validation", "security_validation", "certificate_retrieval", "initial_idempotency_claim", "cap_parsing", "persistence", "normalization", "completion"],
		...overrides,
	};
}

async function record(coordinator: IpawsIdempotencyCoordinator, value: IpawsMetricsEvent, correlation?: { action: "preclaim_failure" | "accepted"; messageId: string }): Promise<Response> {
	return coordinator.fetch(new Request("https://metrics.internal/metrics/record", {
		method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: value, correlation }),
	}));
}

function report(coordinator: IpawsIdempotencyCoordinator, start = "2026-09-24T00:00:00.000Z", end = "2026-10-01T00:00:00.000Z") {
	return coordinator.fetch(new Request(`https://metrics.internal/metrics/report?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`));
}

afterEach(() => vi.useRealTimers());

describe("IPAWS durable metrics", () => {
	it("serializes concurrent updates without losing counts", async () => {
		const { storage } = storageHarness();
		const coordinator = new IpawsIdempotencyCoordinator({ storage } as unknown as DurableObjectState);
		await Promise.all(Array.from({ length: 50 }, () => record(coordinator, event())));
		const result = await (await report(coordinator)).json<ReturnType<typeof buildSoakReport>>();
		expect(result.counters.request.received).toBe(50);
		expect(result.counters.idempotency.acquired).toBe(50);
		expect(result.counters.idempotency.completion).toBe(50);
		expect(result.latency).toMatchObject({ count: 50, sumMs: 6_250, averageMs: 125 });
	});

	it("captures duplicate, recovery, partial-failure, rejection, and exception outcomes", async () => {
		const { storage } = storageHarness();
		const coordinator = new IpawsIdempotencyCoordinator({ storage } as unknown as DurableObjectState);
		await record(coordinator, event({ handlerOutcome: "duplicate", idempotency: ["completed_duplicate"], normalizedRecord: ["not_applicable"] }));
		await record(coordinator, event({ httpStatus: "5xx", handlerOutcome: "processing_failure", idempotency: ["lease_recovery", "failure"], normalizedRecord: ["reconstruction", "failure"], rejection: "retryable", successfulDelivery: undefined }));
		await record(coordinator, event({ httpStatus: "4xx", handlerOutcome: "security_rejection", signature: "failure", topicArnValidation: "failure", timestampValidation: "failure", capParse: "failure", capLifecycle: "other", idempotency: ["not_reached"], normalizedRecord: ["not_applicable"], rejection: "permanent", successfulDelivery: undefined }));
		await record(coordinator, event({ httpStatus: "5xx", handlerOutcome: "unexpected_exception", unexpectedException: true, idempotency: ["failure"], normalizedRecord: ["failure"], rejection: "retryable", successfulDelivery: undefined }));
		const result = await (await report(coordinator)).json<ReturnType<typeof buildSoakReport>>();
		expect(result.counters.idempotency).toMatchObject({ completed_duplicate: 1, lease_recovery: 1, failure: 2 });
		expect(result.counters.normalizedRecord).toMatchObject({ reconstruction: 1, failure: 2 });
		expect(result.counters.rejection).toMatchObject({ retryable: 2, permanent: 1 });
		expect(result.counters.exception.unexpected).toBe(1);
	});

	it("records fixed failure stage/class and the latest in-window failure timestamp", async () => {
		vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-30T12:34:56.000Z"));
		const { storage } = storageHarness(); const coordinator = new IpawsIdempotencyCoordinator({ storage } as unknown as DurableObjectState);
		await record(coordinator, event({ httpStatus: "5xx", handlerOutcome: "processing_failure", rejection: "retryable", successfulDelivery: undefined, processingStages: ["envelope_validation", "security_validation", "certificate_retrieval", "initial_idempotency_claim"], failureStage: "initial_idempotency_claim", failureClass: "idempotency_unavailable" }));
		vi.setSystemTime(new Date("2026-09-30T13:05:00.000Z"));
		await record(coordinator, event({ httpStatus: "4xx", handlerOutcome: "invalid_request", rejection: "permanent", successfulDelivery: undefined, failureStage: "envelope_validation", failureClass: "invalid_request" }));
		const result = await (await report(coordinator, "2026-09-30T12:00:00.000Z", "2026-09-30T13:00:00.000Z")).json<ReturnType<typeof buildSoakReport>>();
		expect(result.counters.processingStage.initial_idempotency_claim).toBe(1);
		expect(result.counters.failureClass.idempotency_unavailable).toBe(1);
		expect(result.latestFailure).toEqual({ timestamp: "2026-09-30T12:34:56.000Z", stage: "initial_idempotency_claim", failureClass: "idempotency_unavailable" });
	});

	it("resolves a short-lived preclaim marker across key rotation without persisting the identifier", async () => {
		vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-30T10:00:00.000Z"));
		const { storage, values } = storageHarness(); const coordinator = new IpawsIdempotencyCoordinator({ storage } as unknown as DurableObjectState); const sensitive = "PRIVATE-SNS-ID";
		await record(coordinator, event({ httpStatus: "5xx", handlerOutcome: "processing_failure", rejection: "retryable", successfulDelivery: undefined, failureStage: "initial_idempotency_claim", failureClass: "idempotency_unavailable" }), { action: "preclaim_failure", messageId: sensitive });
		vi.advanceTimersByTime(IPAWS_CORRELATION_ROTATION_MS + 1);
		await record(coordinator, event(), { action: "accepted", messageId: sensitive });
		const result = await (await report(coordinator, "2026-09-30T10:00:00.000Z", "2026-09-30T12:00:00.000Z")).json<ReturnType<typeof buildSoakReport>>();
		expect(result.counters.retryResolution.resolved_after_preclaim_failure).toBe(1);
		expect(JSON.stringify([...values.entries()])).not.toContain(sensitive);
	});

	it("expires unresolved correlation markers and rejects oversized report windows", async () => {
		vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-30T10:00:00.000Z"));
		const { storage } = storageHarness(); const coordinator = new IpawsIdempotencyCoordinator({ storage } as unknown as DurableObjectState);
		await record(coordinator, event({ httpStatus: "5xx", handlerOutcome: "processing_failure", rejection: "retryable", successfulDelivery: undefined, failureStage: "initial_idempotency_claim", failureClass: "idempotency_unavailable" }), { action: "preclaim_failure", messageId: "expired" });
		vi.advanceTimersByTime(IPAWS_CORRELATION_TTL_MS + 1); await record(coordinator, event(), { action: "accepted", messageId: "expired" });
		const result = await (await report(coordinator, "2026-09-30T10:00:00.000Z", "2026-09-30T13:00:00.000Z")).json<ReturnType<typeof buildSoakReport>>();
		expect(result.counters.retryResolution.resolved_after_preclaim_failure).toBeUndefined();
		const tooLongEnd = new Date(Date.parse("2026-09-01T00:00:00.000Z") + (IPAWS_METRICS_MAX_REPORT_HOURS + 1) * 3_600_000).toISOString();
		expect((await report(coordinator, "2026-09-01T00:00:00.000Z", tooLongEnd)).status).toBe(400);
	});

	it("retains only the latest bounded set of UTC hourly aggregates", async () => {
		vi.useFakeTimers();
		const { storage, values } = storageHarness();
		const coordinator = new IpawsIdempotencyCoordinator({ storage } as unknown as DurableObjectState);
		for (let offset = 0; offset < IPAWS_METRICS_RETENTION_DAYS * 24 + 5; offset++) {
			vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, offset)));
			await record(coordinator, event());
		}
		const hours = values.get("metrics:hours") as string[];
		expect(hours).toHaveLength(IPAWS_METRICS_RETENTION_DAYS * 24);
		expect([...values.keys()].filter((key) => key.startsWith("metrics:hour:"))).toHaveLength(IPAWS_METRICS_RETENTION_DAYS * 24);
	});

	it("retains and orders UTC days deterministically across month and year boundaries", async () => {
		vi.useFakeTimers();
		const { storage, values } = storageHarness();
		const coordinator = new IpawsIdempotencyCoordinator({ storage } as unknown as DurableObjectState);
		for (const timestamp of ["2026-11-30T23:59:59Z", "2026-12-01T00:00:00Z", "2026-12-31T23:59:59Z", "2027-01-01T00:00:00Z"]) {
			vi.setSystemTime(new Date(timestamp));
			await record(coordinator, event());
		}
		expect(values.get("metrics:hours")).toEqual(["2026-11-30T23:00:00.000Z", "2026-12-01T00:00:00.000Z", "2026-12-31T23:00:00.000Z", "2027-01-01T00:00:00.000Z"]);
	});

	it("expires populated buckets by calendar age after a long idle gap", async () => {
		vi.useFakeTimers();
		const { storage, values } = storageHarness();
		const coordinator = new IpawsIdempotencyCoordinator({ storage } as unknown as DurableObjectState);
		vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
		await record(coordinator, event());
		vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));
		const beforeWrite = await (await report(coordinator, "2026-02-22T01:00:00.000Z", "2026-03-01T01:00:00.000Z")).json<ReturnType<typeof buildSoakReport>>();
		expect(beforeWrite).toMatchObject({ windowStart: "2026-02-22T01:00:00.000Z", windowEnd: "2026-03-01T01:00:00.000Z" });
		expect(beforeWrite.counters.request.received).toBeUndefined();
		await record(coordinator, event());
		expect(values.get("metrics:hours")).toEqual(["2026-03-01T12:00:00.000Z"]);
		expect(values.has("metrics:hour:2026-01-01T12:00:00.000Z")).toBe(false);
		const result = await (await report(coordinator, "2026-03-01T12:00:00.000Z", "2026-03-01T13:00:00.000Z")).json<ReturnType<typeof buildSoakReport>>();
		expect(result.counters.request.received).toBe(1);
	});

	it("does not persist or report extra sensitive fields", async () => {
		const { storage, values } = storageHarness();
		const coordinator = new IpawsIdempotencyCoordinator({ storage } as unknown as DurableObjectState);
		const sensitive = "SECRET-PAYLOAD-MESSAGE-ID-TOKEN-SIGNATURE-CERTIFICATE-URL";
		await record(coordinator, { ...event(), rawPayload: sensitive, messageId: sensitive, claimToken: sensitive } as IpawsMetricsEvent);
		const reportText = await (await report(coordinator)).text();
		expect(JSON.stringify([...values.entries()])).not.toContain(sensitive);
		expect(reportText).not.toContain(sensitive);
		expect(reportText).not.toMatch(/messageId|claimToken|rawPayload|signatureValue|certificateUrl|certificateContents|confirmationUrl/i);
	});

	it("rejects sensitive or unbounded values in metric dimensions", async () => {
		const { storage, values } = storageHarness();
		const coordinator = new IpawsIdempotencyCoordinator({ storage } as unknown as DurableObjectState);
		const result = await record(coordinator, { ...event(), handlerOutcome: "SECRET-MESSAGE-ID" } as IpawsMetricsEvent);
		expect(result.status).toBe(400);
		expect(JSON.stringify([...values.entries()])).not.toContain("SECRET-MESSAGE-ID");
	});

	it("swallows metrics namespace and write failures", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const namespace = {
			idFromName: () => { throw new Error("SECRET-message-id-token-signature"); },
		} as unknown as DurableObjectNamespace;
		await expect(recordIpawsMetrics(namespace, event())).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(warn.mock.calls)).toContain("Durable metrics write unavailable");
		expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET-message-id-token-signature");
	});

	it("observes rejected writes with only a bounded status class", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const namespace = {
			idFromName: () => "metrics-id",
			get: () => ({ fetch: async () => new Response("secret error details", { status: 503 }) }),
		} as unknown as DurableObjectNamespace;
		await recordIpawsMetrics(namespace, event());
		expect(JSON.stringify(warn.mock.calls)).toContain("statusClass=5xx");
		expect(JSON.stringify(warn.mock.calls)).not.toContain("secret error details");
	});

	it.each([
		[{ status: "parsed", message: { source: "json", parsed: { status: "Actual", msgType: "Alert" } } }, "Alert"],
		[{ status: "parsed", message: { source: "json", parsed: { status: "Actual", msgType: "Update" } } }, "Update"],
		[{ status: "parsed", message: { source: "json", parsed: { status: "Actual", msgType: "Cancel" } } }, "Cancel"],
		[{ status: "parsed", message: { source: "json", parsed: { status: "Test", msgType: "Alert" } } }, "Test"],
		[{ status: "parsed", message: { source: "json", parsed: { status: "Actual", msgType: "Ack" } } }, "other"],
	] as const)("classifies CAP lifecycle without retaining CAP fields", (parseResult, expected) => {
		expect(capLifecycle(parseResult)).toBe(expected);
	});
});
