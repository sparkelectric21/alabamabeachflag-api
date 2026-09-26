import { afterEach, describe, expect, it, vi } from "vitest";
import { IpawsIdempotencyCoordinator } from "../src/ipaws/idempotency";
import { buildSoakReport, capLifecycle, IPAWS_METRICS_RETENTION_DAYS, newMetricsBucket, recordIpawsMetrics, type IpawsMetricsEvent } from "../src/ipaws/metrics";

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
		...overrides,
	};
}

async function record(coordinator: IpawsIdempotencyCoordinator, value: IpawsMetricsEvent): Promise<Response> {
	return coordinator.fetch(new Request("https://metrics.internal/metrics/record", {
		method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
	}));
}

afterEach(() => vi.useRealTimers());

describe("IPAWS durable metrics", () => {
	it("serializes concurrent updates without losing counts", async () => {
		const { storage } = storageHarness();
		const coordinator = new IpawsIdempotencyCoordinator({ storage } as unknown as DurableObjectState);
		await Promise.all(Array.from({ length: 50 }, () => record(coordinator, event())));
		const report = await (await coordinator.fetch(new Request("https://metrics.internal/metrics/report"))).json<ReturnType<typeof buildSoakReport>>();
		expect(report.counters.request.received).toBe(50);
		expect(report.counters.idempotency.acquired).toBe(50);
		expect(report.counters.idempotency.completion).toBe(50);
		expect(report.latency).toMatchObject({ count: 50, sumMs: 6_250, averageMs: 125 });
	});

	it("captures duplicate, recovery, partial-failure, rejection, and exception outcomes", async () => {
		const { storage } = storageHarness();
		const coordinator = new IpawsIdempotencyCoordinator({ storage } as unknown as DurableObjectState);
		await record(coordinator, event({ handlerOutcome: "duplicate", idempotency: ["completed_duplicate"], normalizedRecord: ["not_applicable"] }));
		await record(coordinator, event({ httpStatus: "5xx", handlerOutcome: "processing_failure", idempotency: ["lease_recovery", "failure"], normalizedRecord: ["reconstruction", "failure"], rejection: "retryable", successfulDelivery: undefined }));
		await record(coordinator, event({ httpStatus: "4xx", handlerOutcome: "security_rejection", signature: "failure", topicArnValidation: "failure", timestampValidation: "failure", capParse: "failure", capLifecycle: "other", idempotency: ["not_reached"], normalizedRecord: ["not_applicable"], rejection: "permanent", successfulDelivery: undefined }));
		await record(coordinator, event({ httpStatus: "5xx", handlerOutcome: "unexpected_exception", unexpectedException: true, idempotency: ["failure"], normalizedRecord: ["failure"], rejection: "retryable", successfulDelivery: undefined }));
		const report = await (await coordinator.fetch(new Request("https://metrics.internal/metrics/report"))).json<ReturnType<typeof buildSoakReport>>();
		expect(report.counters.idempotency).toMatchObject({ completed_duplicate: 1, lease_recovery: 1, failure: 2 });
		expect(report.counters.normalizedRecord).toMatchObject({ reconstruction: 1, failure: 2 });
		expect(report.counters.rejection).toMatchObject({ retryable: 2, permanent: 1 });
		expect(report.counters.exception.unexpected).toBe(1);
	});

	it("retains only the latest bounded set of UTC daily aggregates", async () => {
		vi.useFakeTimers();
		const { storage, values } = storageHarness();
		const coordinator = new IpawsIdempotencyCoordinator({ storage } as unknown as DurableObjectState);
		for (let offset = 0; offset < IPAWS_METRICS_RETENTION_DAYS + 5; offset++) {
			vi.setSystemTime(new Date(Date.UTC(2026, 0, 1 + offset)));
			await record(coordinator, event());
		}
		const days = values.get("metrics:days") as string[];
		expect(days).toHaveLength(IPAWS_METRICS_RETENTION_DAYS);
		expect([...values.keys()].filter((key) => key.startsWith("metrics:day:"))).toHaveLength(IPAWS_METRICS_RETENTION_DAYS);
		expect(days[0]).toBe("2026-01-06");
	});

	it("retains and orders UTC days deterministically across month and year boundaries", async () => {
		vi.useFakeTimers();
		const { storage, values } = storageHarness();
		const coordinator = new IpawsIdempotencyCoordinator({ storage } as unknown as DurableObjectState);
		for (const timestamp of ["2026-11-30T23:59:59Z", "2026-12-01T00:00:00Z", "2026-12-31T23:59:59Z", "2027-01-01T00:00:00Z"]) {
			vi.setSystemTime(new Date(timestamp));
			await record(coordinator, event());
		}
		expect(values.get("metrics:days")).toEqual(["2026-11-30", "2026-12-01", "2026-12-31", "2027-01-01"]);
		const report = await (await coordinator.fetch(new Request("https://metrics.internal/metrics/report"))).json<ReturnType<typeof buildSoakReport>>();
		expect(report).toMatchObject({ windowStart: "2026-11-30", windowEnd: "2027-01-01" });
		expect(report.counters.request.received).toBe(4);
	});

	it("expires populated buckets by calendar age after a long idle gap", async () => {
		vi.useFakeTimers();
		const { storage, values } = storageHarness();
		const coordinator = new IpawsIdempotencyCoordinator({ storage } as unknown as DurableObjectState);
		vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
		await record(coordinator, event());
		vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));
		const beforeWrite = await (await coordinator.fetch(new Request("https://metrics.internal/metrics/report"))).json<ReturnType<typeof buildSoakReport>>();
		expect(beforeWrite).toMatchObject({ windowStart: null, windowEnd: null });
		expect(beforeWrite.counters.request.received).toBeUndefined();
		await record(coordinator, event());
		expect(values.get("metrics:days")).toEqual(["2026-03-01"]);
		expect(values.has("metrics:day:2026-01-01")).toBe(false);
		const report = await (await coordinator.fetch(new Request("https://metrics.internal/metrics/report"))).json<ReturnType<typeof buildSoakReport>>();
		expect(report.counters.request.received).toBe(1);
		expect(report).toMatchObject({ windowStart: "2026-03-01", windowEnd: "2026-03-01" });
	});

	it("does not persist or report extra sensitive fields", async () => {
		const { storage, values } = storageHarness();
		const coordinator = new IpawsIdempotencyCoordinator({ storage } as unknown as DurableObjectState);
		const sensitive = "SECRET-PAYLOAD-MESSAGE-ID-TOKEN-SIGNATURE-CERTIFICATE-URL";
		await record(coordinator, { ...event(), rawPayload: sensitive, messageId: sensitive, claimToken: sensitive } as IpawsMetricsEvent);
		const reportText = await (await coordinator.fetch(new Request("https://metrics.internal/metrics/report"))).text();
		expect(JSON.stringify([...values.entries()])).not.toContain(sensitive);
		expect(reportText).not.toContain(sensitive);
		expect(reportText).not.toMatch(/messageId|claimToken|rawPayload|signatureValue|certificate|confirmationUrl/i);
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
