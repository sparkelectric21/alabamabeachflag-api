import { describe, expect, it, vi } from "vitest";
import { alertDeliveryEnabled, deliverAlert } from "../src/alerting/delivery";
import { processAlertObservation } from "../src/alerting/process";
import { dueVerificationSlot, reportKeyForSlot } from "../src/alerting/schedule";
import { evaluateAlert } from "../src/alerting/state";
import type { AlertObservation, AlertState } from "../src/alerting/types";
import type { Env } from "../src/types";

const pass: AlertObservation = {
	slot: "2026-07-17T07",
	reportTime: "2026-07-17T12:02:00.000Z",
	status: "pass",
	affected: [],
};

const warning: AlertObservation = {
	...pass,
	status: "warning",
	affected: [{ name: "freshness", status: "warning", detail: "60 minutes old" }],
};

const failure: AlertObservation = {
	...pass,
	status: "fail",
	affected: [{ name: "public_api", status: "fail", detail: "public_api_unavailable" }],
};

describe("alert incident state", () => {
	it("keeps a passing report silent without an active incident", () => {
		expect(evaluateAlert({}, pass)).toEqual({ state: {} });
	});

	it.each([[warning, "warning"], [failure, "fail"]] as const)(
		"notifies for a new %s incident",
		(observation, status) => {
			const result = evaluateAlert({}, observation);
			expect(result.notification).toMatchObject({ kind: "incident", status });
			expect(result.notification?.affected).toEqual(observation.affected);
		},
	);

	it("does not duplicate a continuing incident", () => {
		const first = evaluateAlert({}, warning);
		const continuing = evaluateAlert(first.state, {
			...warning,
			reportTime: "2026-07-17T12:10:00.000Z",
			affected: [{ name: "freshness", status: "warning", detail: "75 minutes old" }],
		});
		expect(continuing.notification).toBeUndefined();
		expect(continuing.state.active?.lastObservedAt).toBe("2026-07-17T12:10:00.000Z");
	});

	it("notifies when an incident changes or escalates", () => {
		const first = evaluateAlert({}, warning);
		const escalated = evaluateAlert(first.state, failure);
		expect(escalated.notification).toMatchObject({ kind: "update", status: "fail" });
		expect(escalated.state.active?.id).toBe(first.state.active?.id);
	});

	it("notifies once on recovery and clears the active incident", () => {
		const first = evaluateAlert({}, failure);
		const recovered = evaluateAlert(first.state, pass);
		expect(recovered.notification).toMatchObject({ kind: "recovery", status: "pass" });
		expect(recovered.state.active).toBeUndefined();
		expect(evaluateAlert(recovered.state, pass).notification).toBeUndefined();
	});
});

describe("missing scheduled reports", () => {
	it("honors the grace period and produces the correct report key", () => {
		expect(dueVerificationSlot(new Date("2026-07-17T12:29:00.000Z"))).toBeUndefined();
		expect(dueVerificationSlot(new Date("2026-07-17T12:30:00.000Z"))).toBe("2026-07-17T07");
		expect(reportKeyForSlot("2026-07-17T07")).toBe("verification:report:2026-07-17:07");
	});

	it("accounts for Central daylight-saving time", () => {
		expect(dueVerificationSlot(new Date("2026-01-17T13:30:00.000Z"))).toBe("2026-01-17T07");
		expect(dueVerificationSlot(new Date("2026-07-17T17:30:00.000Z"))).toBe("2026-07-17T12");
		expect(dueVerificationSlot(new Date("2026-01-17T18:29:00.000Z"))).toBe("2026-01-17T07");
	});

	it("represents a missing slot as a deduplicated incident", () => {
		const missing: AlertObservation = {
			...failure,
			affected: [{ name: "scheduled_report", status: "fail", detail: "missing report for 2026-07-17T07" }],
		};
		const first = evaluateAlert({}, missing);
		expect(first.notification?.affected[0].name).toBe("scheduled_report");
		expect(evaluateAlert(first.state, missing).notification).toBeUndefined();
	});
});

describe("delivery isolation and kill switch", () => {
	function storage(initial: AlertState = {}) {
		let state = initial;
		return {
			get: vi.fn(async () => state),
			put: vi.fn(async (_key: string, value: AlertState) => { state = value; }),
		} as unknown as DurableObjectStorage;
	}

	it("swallows delivery failure after persisting notification intent", async () => {
		const store = storage();
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await expect(processAlertObservation(store, {} as Env, failure, async () => {
			throw new Error("delivery failed");
		})).resolves.toBeUndefined();
		expect(store.put).toHaveBeenCalledOnce();
		expect(error).toHaveBeenCalledWith("[Verification alerts] delivery failed");
		error.mockRestore();
	});

	it("does not deliver when the feature is disabled", async () => {
		const env = { VERIFICATION_ALERTS_ENABLED: "false" } as Env;
		expect(alertDeliveryEnabled(env)).toBe(false);
		await expect(deliverAlert(env, evaluateAlert({}, warning).notification!)).resolves.toBeUndefined();
	});

	it("fails safely when enabled before a delivery adapter is configured", async () => {
		const env = { VERIFICATION_ALERTS_ENABLED: "true" } as Env;
		expect(alertDeliveryEnabled(env)).toBe(true);
		await expect(deliverAlert(env, evaluateAlert({}, warning).notification!))
			.rejects.toThrow("alert_delivery_not_configured");
	});
});
