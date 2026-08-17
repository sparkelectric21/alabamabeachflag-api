import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";
import { externalEmailAllowed, liveProviderFetchAllowed, runtimeEnvironment, stagingIsolationDiagnostics, syntheticFixturesAllowed } from "../src/config/stagingIsolation";
import { deliverAlert } from "../src/alerting/delivery";
import { providerHealthAlertTransport, readProviderHealthNotificationState } from "../src/providerHealth/notifications";
import { cleanupEventStagingFixture, EVENT_STAGING_FIXTURE_PREFIX, runEventStagingFixture } from "../src/local/eventStagingFixture";

function memoryEnv(overrides: Partial<Env> = {}) {
	const values = new Map<string, string>();
	const kv = {
		get: async (key: string, type?: string) => { const value = values.get(key); return value === undefined ? null : type === "json" ? JSON.parse(value) : value; },
		getWithMetadata: async (key: string, type?: string) => ({ value: await kv.get(key, type), metadata: null }),
		put: async (key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream) => { values.set(key, typeof value === "string" ? value : "binary"); },
		delete: async (key: string) => { values.delete(key); },
		list: async ({ prefix = "", cursor }: { prefix?: string; cursor?: string } = {}) => ({ keys: [...values.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })), list_complete: true, cursor }),
	};
	return { env: { BEACH_DATA: kv, APP_ENVIRONMENT: "staging", VERIFICATION_ALERT_ENVIRONMENT: "staging", HISTORICAL_DATA_ENVIRONMENT: "staging", ...overrides } as unknown as Env, values };
}

const notice = { id: "n1", kind: "incident", slot: "2026-08-17-am", reportTime: "2026-08-17T12:00:00Z", status: "fail", affected: [] } as const;
const providerEvent = { id: "event-1", type: "opened", incidentId: "incident-1", incidentKind: "isolated", severity: "warning", provider: "fixture", domain: "beach_events", createdAt: "2026-08-17T12:00:00Z", affectedBeachCount: 1, expectedBeachCount: 1, consecutiveFailures: 1 } as const;

describe("staging isolation", () => {
	it("removes staging schedules while leaving production schedules intact", () => {
		const staging = readFileSync("wrangler.staging.jsonc", "utf8"), production = readFileSync("wrangler.jsonc", "utf8");
		expect(staging).toMatch(/"triggers"\s*:\s*\{\s*"crons"\s*:\s*\[\s*\]/);
		expect(staging).toMatch(/"preview_urls"\s*:\s*false/);
		expect(staging).not.toContain("operations@alabamabeachflag.com");
		expect(production).not.toContain('"preview_urls": false');
		expect(production).toContain('"*/5 * * * *"');
	});

	it("fails closed for ambiguous and default staging provider access", async () => {
		expect(runtimeEnvironment({})).toBe("ambiguous");
		expect(runtimeEnvironment({ VERIFICATION_ALERT_ENVIRONMENT: "staging", HISTORICAL_DATA_ENVIRONMENT: "staging" })).toBe("ambiguous");
		expect(runtimeEnvironment({ APP_ENVIRONMENT: "staging", VERIFICATION_ALERT_ENVIRONMENT: "staging" })).toBe("ambiguous");
		expect(runtimeEnvironment({ APP_ENVIRONMENT: "staging", VERIFICATION_ALERT_ENVIRONMENT: "staging", HISTORICAL_DATA_ENVIRONMENT: "production" })).toBe("ambiguous");
		expect(liveProviderFetchAllowed({} as Env)).toBe(false);
		expect(liveProviderFetchAllowed(memoryEnv().env)).toBe(false);
		expect(liveProviderFetchAllowed(memoryEnv({ STAGING_LIVE_PROVIDER_FETCH_ENABLED: "true" }).env)).toBe(true);
		expect(liveProviderFetchAllowed(memoryEnv({ APP_ENVIRONMENT: "production", VERIFICATION_ALERT_ENVIRONMENT: "production", HISTORICAL_DATA_ENVIRONMENT: "production" }).env)).toBe(true);
		const fetcher = vi.spyOn(globalThis, "fetch");
		await worker.scheduled!({ cron: "*/15 * * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController, memoryEnv().env, {} as ExecutionContext);
		expect(fetcher).not.toHaveBeenCalled();
		fetcher.mockRestore();
	});

	it("blocks authenticated staging manual/internal refreshes before coordination", async () => {
		const idFromName = vi.fn(), h = memoryEnv({
			REFRESH_SECRET: "fixture-secret",
			ALLOW_LEGACY_REFRESH_SECRET: "true",
			REFRESH_COORDINATOR: { idFromName, get: vi.fn() } as unknown as DurableObjectNamespace,
		});
		const response = await worker.fetch(new Request("https://staging.example/internal/refresh/beach-flags", { method: "POST", headers: { "x-refresh-secret": "fixture-secret", "Idempotency-Key": "fixture-request-1" } }), h.env);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "staging_provider_fetch_disabled" });
		expect(idFromName).not.toHaveBeenCalled();
	});

	it("suppresses all staging email even when bindings and enable flags are present", async () => {
		const send = vi.fn(), h = memoryEnv({ VERIFICATION_ALERT_EMAIL: { send } as SendEmail, VERIFICATION_ALERTS_ENABLED: "true", PROVIDER_HEALTH_NOTIFICATIONS_ENABLED: "true", PROVIDER_HEALTH_NOTIFICATION_RECIPIENTS: "operator@example.test", STAGING_EXTERNAL_EMAIL_ENABLED: "true" });
		expect(externalEmailAllowed(h.env)).toBe(false);
		expect(await deliverAlert(h.env, notice as never)).toBe("disabled");
		await providerHealthAlertTransport(h.env).send(providerEvent, { subject: "safe", text: "safe" });
		expect(send).not.toHaveBeenCalled();
		expect(await readProviderHealthNotificationState(h.env)).toMatchObject({ lastEventId: "event-1", lastOutcome: "disabled" });
		expect([...h.values.values()].join(" ")).toContain("delivery_suppressed");
	});

	it("runs and cleans only namespaced deterministic fixtures", async () => {
		const h = memoryEnv({ STAGING_SYNTHETIC_FIXTURES_ENABLED: "true" });
		h.values.set("ordinary:event", "keep");
		expect(syntheticFixturesAllowed(h.env)).toBe(true);
		const result = await runEventStagingFixture(h.env);
		expect(result).toMatchObject({ fixtureSetVersion: "events-isolation-v1", parsed: { total: 3, valid: 2, rejected: 1 } });
		expect([...h.values.keys()].filter((key) => key !== "ordinary:event").every((key) => key.startsWith(EVENT_STAGING_FIXTURE_PREFIX))).toBe(true);
		await cleanupEventStagingFixture(h.env);
		expect([...h.values.entries()]).toEqual([["ordinary:event", "keep"]]);
		await expect(runEventStagingFixture(memoryEnv().env)).rejects.toThrow("synthetic_fixture_mode_disabled");
		await expect(runEventStagingFixture(memoryEnv({ APP_ENVIRONMENT: "production", VERIFICATION_ALERT_ENVIRONMENT: "production", HISTORICAL_DATA_ENVIRONMENT: "production", STAGING_SYNTHETIC_FIXTURES_ENABLED: "true" }).env)).rejects.toThrow("synthetic_fixture_mode_disabled");
	});

	it("exposes only safe diagnostic labels", () => {
		const diagnostics = stagingIsolationDiagnostics(memoryEnv().env);
		expect(diagnostics).toMatchObject({ environment: "staging", schedulesExpected: false, emailDeliverySuppressed: true });
		expect(JSON.stringify(diagnostics)).not.toMatch(/60f732|701101|operations@|ACCESS|token/i);
	});

	it("protects the runtime diagnostics route", async () => {
		const h = memoryEnv({ REFRESH_SECRET: "fixture-secret", ALLOW_LEGACY_REFRESH_SECRET: "true" });
		expect((await worker.fetch(new Request("https://staging.example/admin/environment-diagnostics"), h.env)).status).toBe(403);
		const response = await worker.fetch(new Request("https://staging.example/admin/environment-diagnostics", { headers: { "x-refresh-secret": "fixture-secret" } }), h.env);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ environment: "staging", emailDeliverySuppressed: true });
	});
});
