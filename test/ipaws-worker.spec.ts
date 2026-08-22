import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type IpawsStandaloneEnv } from "../src/ipaws/worker";

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

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("standalone IPAWS Worker", () => {
	it("routes callback POST requests to the disabled receiver", async () => {
		const response = await worker.fetch(request("/v1/ipaws/pubsub", "POST", "{}"), createEnvironment());
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ code: "ipaws_disabled" });
	});

	it.each(["GET", "PUT"])("rejects %s callback requests with Allow: POST", async (method) => {
		const response = await worker.fetch(request("/v1/ipaws/pubsub", method), createEnvironment());
		expect(response.status).toBe(405);
		expect(response.headers.get("Allow")).toBe("POST");
	});

	it.each(["/unknown", "/v1/beaches", "/admin/provider-health", "/v1/information-reports"])("does not expose %s", async (path) => {
		const response = await worker.fetch(request(path), createEnvironment());
		expect(response.status).toBe(404);
	});

	it("performs no network or KV activity while disabled", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const env = createEnvironment();
		const response = await worker.fetch(request("/v1/ipaws/pubsub", "POST", "{}"), env);
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
		expect(await worker.fetch(request("/v1/ipaws/pubsub", "POST", "{}"), env)).toHaveProperty("status", 503);
	});
});
