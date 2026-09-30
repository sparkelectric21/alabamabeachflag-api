import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type IpawsStandaloneEnv } from "../src/ipaws/worker";
import { readFileSync } from "node:fs";

function createEnvironment(): IpawsStandaloneEnv & { BEACH_DATA: { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> } } {
	const BEACH_DATA = {
		get: vi.fn(async () => null),
		put: vi.fn(async () => undefined),
	};
	return {
		BEACH_DATA: BEACH_DATA as unknown as KVNamespace,
		IPAWS_INGESTION_ENABLED: "false",
		IPAWS_ENVIRONMENT: "staging",
		IPAWS_AUTO_CONFIRM_SUBSCRIPTION: "false",
		IPAWS_HEALTH_TTL_SECONDS: "604800",
		IPAWS_RECORD_TTL_SECONDS: "604800",
		IPAWS_SUBSCRIPTION_TTL_SECONDS: "604800",
		IPAWS_PARSE_BYTE_LIMIT: "262144",
	} as IpawsStandaloneEnv & { BEACH_DATA: typeof BEACH_DATA };
}

function request(path: string, method = "GET", body?: string): Request {
	return new Request(`https://ipaws.example${path}`, { method, body });
}

const executionContext = { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext;

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("standalone IPAWS Worker", () => {
	it("routes callback POST requests to the disabled receiver", async () => {
		const response = await worker.fetch(request("/v1/ipaws/pubsub", "POST", "{}"), createEnvironment(), executionContext);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ code: "ipaws_disabled" });
	});

	it.each(["GET", "PUT"])("rejects %s callback requests with Allow: POST", async (method) => {
		const response = await worker.fetch(request("/v1/ipaws/pubsub", method), createEnvironment(), executionContext);
		expect(response.status).toBe(405);
		expect(response.headers.get("Allow")).toBe("POST");
	});

	it.each(["/unknown", "/v1/beaches", "/admin/provider-health", "/v1/information-reports"])("does not expose %s", async (path) => {
		const response = await worker.fetch(request(path), createEnvironment(), executionContext);
		expect(response.status).toBe(404);
	});

	it("performs no network or KV activity while disabled", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const env = createEnvironment();
		const response = await worker.fetch(request("/v1/ipaws/pubsub", "POST", "{}"), env, executionContext);
		expect(response.status).toBe(503);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(env.BEACH_DATA.get).not.toHaveBeenCalled();
		expect(env.BEACH_DATA.put).not.toHaveBeenCalled();
	});

	it("runs with only staging KV and IPAWS controls", async () => {
		const env = createEnvironment();
		expect("HISTORICAL_DATA" in env).toBe(false);
		expect("REFRESH_COORDINATOR" in env).toBe(false);
		expect("VERIFICATION_COORDINATOR" in env).toBe(false);
		expect("VERIFICATION_ALERT_EMAIL" in env).toBe(false);
		expect(await worker.fetch(request("/v1/ipaws/pubsub", "POST", "{}"), env, executionContext)).toHaveProperty("status", 503);
	});

	it("keeps the deployed staging configuration isolated from notification infrastructure", () => {
		const config = readFileSync(new URL("../wrangler.ipaws.staging.jsonc", import.meta.url), "utf8");
		expect(config).toContain('"name": "alabamabeachflag-ipaws-staging"');
		expect(config).toContain('"IPAWS_ENVIRONMENT": "staging"');
		expect(config).not.toMatch(/send_email|notification_recipient|production/i);
	});

	it("serves only a sanitized staging metrics report with no-store caching", async () => {
		const env = createEnvironment();
		const reportFetch = vi.fn(async () => Response.json({
			schemaVersion: 2, environment: "staging", retentionDays: 35, maxWindowHours: 168, windowStart: "2026-09-29T00:00:00.000Z", windowEnd: "2026-09-30T00:00:00.000Z",
			counters: {}, latency: { count: 0, sumMs: 0, maxMs: 0, buckets: {}, averageMs: null },
			lastSuccessfulDeliveryAt: null, latestFailure: null, limitations: [],
		}));
		env.IPAWS_IDEMPOTENCY = {
			idFromName: vi.fn(() => "metrics-id"),
			get: vi.fn(() => ({ fetch: reportFetch })),
		} as unknown as DurableObjectNamespace;
		let cached: Response | undefined;
		const cache = {
			match: vi.fn(async () => cached?.clone()),
			put: vi.fn(async (_key: RequestInfo | URL, value: Response) => { cached = value.clone(); }),
		};
		vi.stubGlobal("caches", { default: cache });
		const query = "start=2026-09-29T00%3A00%3A00.000Z&end=2026-09-30T00%3A00%3A00.000Z";
		const response = await worker.fetch(request(`/v1/ipaws/metrics?${query}`), env, executionContext);
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.get("X-IPAWS-Metrics-Cache")).toBe("miss");
		expect(await response.json()).toMatchObject({ schemaVersion: 2, environment: "staging", retentionDays: 35 });
		const cachedResponse = await worker.fetch(request("/v1/ipaws/metrics?end=2026-09-30T00%3A00%3A00.000Z&start=2026-09-29T00%3A00%3A00.000Z"), env, executionContext);
		expect(cachedResponse.headers.get("X-IPAWS-Metrics-Cache")).toBe("hit");
		expect(reportFetch).toHaveBeenCalledTimes(1);
		expect(String(cache.match.mock.calls[0]?.[0])).toContain("/v2/report?start=");
		expect(cache.match.mock.calls[0]?.[0]).toBe(cache.match.mock.calls[1]?.[0]);
		expect((await worker.fetch(request(`/v1/ipaws/metrics?${query}&attacker=cache-bypass`), env, executionContext)).status).toBe(400);
	});

	it("rejects partial, non-canonical, inverted, and oversized metrics windows", async () => {
		const env = createEnvironment();
		for (const query of [
			"start=2026-09-29T00%3A00%3A00.000Z",
			"start=2026-09-29T00%3A00%3A00.000Z&start=2026-09-29T01%3A00%3A00.000Z&end=2026-09-30T00%3A00%3A00.000Z",
			"start=2026-09-29T00%3A01%3A00.000Z&end=2026-09-30T00%3A00%3A00.000Z",
			"start=2026-09-30T00%3A00%3A00.000Z&end=2026-09-29T00%3A00%3A00.000Z",
			"start=2026-09-01T00%3A00%3A00.000Z&end=2026-09-30T00%3A00%3A00.000Z",
		]) expect((await worker.fetch(request(`/v1/ipaws/metrics?${query}`), env, executionContext)).status).toBe(400);
	});

	it("does not expose the metrics route outside staging", async () => {
		const env = createEnvironment();
		env.IPAWS_ENVIRONMENT = "production";
		expect(await worker.fetch(request("/v1/ipaws/metrics"), env, executionContext)).toHaveProperty("status", 404);
	});
});
