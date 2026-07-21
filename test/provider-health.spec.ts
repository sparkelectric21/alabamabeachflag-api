import { describe, expect, it, vi } from "vitest";
import { captureProviderAlertTransport, formatProviderAlertEmail } from "../src/providerHealth/delivery";
import { processProviderHealthObservations, processQualityGateRejection, PROVIDER_HEALTH_EVENT_PREFIX, PROVIDER_HEALTH_STATES_KEY } from "../src/providerHealth/process";
import { evaluateProviderHealth, evaluateQualityGateRejection } from "../src/providerHealth/state";
import type { ProviderAlertEvent, ProviderHealthObservation } from "../src/providerHealth/types";
import type { Env } from "../src/types";

const sharedFailure: ProviderHealthObservation = {
	provider: "nws",
	domain: "hourly_forecast",
	affectedBeachCount: 6,
	expectedBeachCount: 9,
	errorReason: "request_failed",
};

const isolatedFailure = { ...sharedFailure, domain: "hourly_forecast:station:MOB", affectedBeachCount: 1 };
const at = (minutes: number) => new Date(Date.parse("2026-07-21T18:00:00.000Z") + minutes * 60_000).toISOString();

describe("provider-health rules", () => {
	it("opens one shared incident after two two-thirds failures and suppresses duplicates", () => {
		const first = evaluateProviderHealth(undefined, sharedFailure, at(0));
		expect(first.event).toBeUndefined();
		expect(first.state.alertState).toBe("pending");
		const second = evaluateProviderHealth(first.state, sharedFailure, at(15));
		expect(second.event).toMatchObject({ type: "opened", incidentKind: "shared_provider" });
		const continuing = evaluateProviderHealth(second.state, sharedFailure, at(30));
		expect(continuing.event).toBeUndefined();
		expect(continuing.state.activeIncidentId).toBe(second.state.activeIncidentId);
	});

	it("requires four failures and two successes for an isolated incident", () => {
		let state = evaluateProviderHealth(undefined, isolatedFailure, at(0)).state;
		for (const minute of [15, 30]) {
			const decision = evaluateProviderHealth(state, isolatedFailure, at(minute));
			expect(decision.event).toBeUndefined();
			state = decision.state;
		}
		const opened = evaluateProviderHealth(state, isolatedFailure, at(45));
		expect(opened.event).toMatchObject({ type: "opened", incidentKind: "isolated" });
		const firstSuccess = evaluateProviderHealth(opened.state, { ...isolatedFailure, affectedBeachCount: 0 }, at(60));
		expect(firstSuccess.event).toBeUndefined();
		expect(firstSuccess.state.activeIncidentId).toBeTruthy();
		const recovered = evaluateProviderHealth(firstSuccess.state, { ...isolatedFailure, affectedBeachCount: 0 }, at(75));
		expect(recovered.event).toMatchObject({ type: "recovery" });
		expect(recovered.state.activeIncidentId).toBeUndefined();
	});

	it("recovers shared incidents after one complete success", () => {
		const first = evaluateProviderHealth(undefined, sharedFailure, at(0));
		const opened = evaluateProviderHealth(first.state, sharedFailure, at(15));
		const recovered = evaluateProviderHealth(opened.state, { ...sharedFailure, affectedBeachCount: 0 }, at(30));
		expect(recovered.event).toMatchObject({ type: "recovery" });
	});

	it("opens a quality-gate incident immediately and only once", () => {
		const opened = evaluateQualityGateRejection(undefined, at(0), "catastrophic_shared_provider_degradation", 9, 9);
		expect(opened.event).toMatchObject({ type: "opened", severity: "critical", incidentKind: "quality_gate" });
		expect(evaluateQualityGateRejection(opened.state, at(15), "catastrophic_shared_provider_degradation", 9, 9).event).toBeUndefined();
	});

	it("keeps reminders disabled by default and emits one after six hours when enabled", () => {
		const first = evaluateProviderHealth(undefined, sharedFailure, at(0));
		const opened = evaluateProviderHealth(first.state, sharedFailure, at(15));
		expect(evaluateProviderHealth(opened.state, sharedFailure, at(390)).event).toBeUndefined();
		expect(evaluateProviderHealth(opened.state, sharedFailure, at(390), { remindersEnabled: true }).event).toMatchObject({ type: "reminder" });
	});
});

describe("provider-health persistence and capture delivery", () => {
	function harness() {
		const values = new Map<string, string>();
		const get = vi.fn(async (key: string) => values.has(key) ? JSON.parse(values.get(key)!) : null);
		const put = vi.fn(async (key: string, value: string) => { values.set(key, value); });
		return { env: { BEACH_DATA: { get, put } } as unknown as Pick<Env, "BEACH_DATA">, values, put };
	}

	it("persists stable dashboard state and retained event records", async () => {
		const h = harness();
		const captured: Array<{ event: ProviderAlertEvent; preview: ReturnType<typeof formatProviderAlertEmail> }> = [];
		const transport = captureProviderAlertTransport(captured);
		await processProviderHealthObservations(h.env, [sharedFailure], at(0), transport);
		await processProviderHealthObservations(h.env, [sharedFailure], at(15), transport);
		expect(captured).toHaveLength(1);
		expect(JSON.parse(h.values.get(PROVIDER_HEALTH_STATES_KEY)!)).toMatchObject({ version: 1, states: [expect.objectContaining({ provider: "nws", alertState: "active" })] });
		expect([...h.values.keys()].some((key) => key.startsWith(PROVIDER_HEALTH_EVENT_PREFIX))).toBe(true);
		expect(h.put).toHaveBeenCalledWith(expect.stringContaining(PROVIDER_HEALTH_EVENT_PREFIX), expect.any(String), { expirationTtl: 7_776_000 });
	});

	it("handles malformed legacy state safely and captures quality-gate previews", async () => {
		const h = harness();
		h.values.set("provider-health:v1:state:publication_quality_gate:beach_conditions", JSON.stringify({ legacy: true }));
		const captured: Array<{ event: ProviderAlertEvent; preview: ReturnType<typeof formatProviderAlertEmail> }> = [];
		await processQualityGateRejection(h.env, at(0), "invalid_candidate", 9, 9, captureProviderAlertTransport(captured));
		expect(captured[0].preview.subject).toBe("Alabama Beach Flag: Critical — Publication Quality Gate / Beach Conditions");
		expect(captured[0].preview.text).toContain("Reason: invalid_candidate");
	});
});
