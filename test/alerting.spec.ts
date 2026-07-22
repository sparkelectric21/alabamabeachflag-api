import { describe, expect, it, vi } from "vitest";
import { alertDeliveryEnabled, deliverAlert, formatAlertEmail } from "../src/alerting/delivery";
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
	affected: [],
};

const failure: AlertObservation = {
	...pass,
	status: "fail",
	affected: [{
		name: "public_api",
		status: "fail",
		detail: "public_api_unavailable",
		provider: "Alabama Beach Flag API",
		location: "gulf-shores-public-beach",
		expectedValue: "HTTP 2xx JSON beach-flag response",
		actualValue: "unavailable",
	}],
};

describe("alert incident state", () => {
	it("keeps a passing report silent without an active incident", () => {
		expect(evaluateAlert({}, pass)).toEqual({ state: {} });
	});

	it("keeps a non-actionable warning silent", () => {
		expect(evaluateAlert({}, warning)).toEqual({ state: {} });
	});

	it("notifies for a new failure incident", () => {
		const result = evaluateAlert({}, failure);
		expect(result.notification).toMatchObject({ kind: "incident", status: "fail" });
		expect(result.notification?.affected).toEqual(failure.affected);
	});

	it("does not duplicate a continuing incident", () => {
		const first = evaluateAlert({}, failure);
		const continuing = evaluateAlert(first.state, {
			...failure,
			reportTime: "2026-07-17T12:10:00.000Z",
			affected: [{ ...failure.affected[0], detail: "still unavailable" }],
		});
		expect(continuing.notification).toBeUndefined();
		expect(continuing.state.active?.lastObservedAt).toBe("2026-07-17T12:10:00.000Z");
	});

	it("notifies when an incident changes or escalates", () => {
		const first = evaluateAlert({}, failure);
		const changed = evaluateAlert(first.state, {
			...failure,
			affected: [{ ...failure.affected[0], name: "freshness" }],
		});
		expect(changed.notification).toMatchObject({ kind: "update", status: "fail" });
		expect(changed.state.active?.id).toBe(first.state.active?.id);
	});

	it("notifies once on recovery and clears the active incident", () => {
		const first = evaluateAlert({}, failure);
		const recovered = evaluateAlert(first.state, pass);
		expect(recovered.notification).toMatchObject({ kind: "recovery", status: "pass" });
		expect(recovered.notification?.affected).toEqual(failure.affected);
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
		expect(store.put).toHaveBeenCalledTimes(2);
		expect(store.put).toHaveBeenLastCalledWith("alert-state:delivery", expect.objectContaining({ outcome: "failed" }));
		expect(error).toHaveBeenCalledWith("[Verification alerts] delivery failed");
		error.mockRestore();
	});

	it("does not deliver when the feature is disabled", async () => {
		const env = { VERIFICATION_ALERTS_ENABLED: "false" } as Env;
		expect(alertDeliveryEnabled(env)).toBe(false);
		await expect(deliverAlert(env, evaluateAlert({}, warning).notification!)).resolves.toBe("disabled");
	});

	it("fails safely when delivery is enabled without an email binding", async () => {
		const env = {
			VERIFICATION_ALERTS_ENABLED: "true",
			VERIFICATION_ALERT_ENVIRONMENT: "staging",
		} as Env;
		await expect(deliverAlert(env, evaluateAlert({}, failure).notification!))
			.rejects.toThrow("verification_alert_email_not_configured");
	});

	it("sends through the native binding only when enabled", async () => {
		const send = vi.fn(async () => ({ messageId: "test-message" }));
		const env = {
			VERIFICATION_ALERTS_ENABLED: "true",
			VERIFICATION_ALERT_ENVIRONMENT: "staging",
			VERIFICATION_ALERT_EMAIL: { send },
		} as unknown as Env;
		await deliverAlert(env, evaluateAlert({}, failure).notification!);
		expect(send).toHaveBeenCalledWith(expect.objectContaining({
			from: "alerts@alabamabeachflag.com",
			to: "operations@alabamabeachflag.com",
			subject: "[Alabama Beach Flag] Verification Failure",
		}));
	});

	it.each([
		[failure, "[Alabama Beach Flag] Verification Failure", "Alert type: failure"],
		[{
			...failure,
			affected: [{ name: "scheduled_report", status: "fail" as const, detail: "missing report for 2026-07-17T07" }],
		}, "[Alabama Beach Flag] Verification Report Missing", "Alert type: missing report"],
	])("formats deterministic %s email content", (observation, subject, alertType) => {
		const notice = evaluateAlert({}, observation).notification!;
		const message = formatAlertEmail({ VERIFICATION_ALERT_ENVIRONMENT: "staging" } as Env, notice);
		expect(message.subject).toBe(subject);
		expect(message.text).toContain("Environment: staging");
		expect(message.text).toContain(alertType);
		expect(message.text).toContain("Report slot: 2026-07-17T07");
		expect(message.text).toContain("Central timestamp: Jul 17, 2026, 7:02:00 AM CDT");
		expect(message.text).toContain(`Overall status: ${observation.status}`);
		expect(message.text).toContain(observation.affected[0].detail);
		expect(message.text).toContain(`Provider: ${observation.affected[0].provider ?? "not applicable"}`);
		expect(message.text).toContain(`Location: ${observation.affected[0].location ?? "not applicable"}`);
		expect(message.text).toContain(`Expected: ${observation.affected[0].expectedValue ?? "not specified"}`);
		expect(message.text).toContain(`Actual: ${observation.affected[0].actualValue ?? "not specified"}`);
	});

	it("formats update and recovery messages", () => {
		const first = evaluateAlert({}, failure);
		const changedFailure = { ...failure, affected: [{ ...failure.affected[0], name: "freshness" }] };
		const update = evaluateAlert(first.state, changedFailure).notification!;
		const recovery = evaluateAlert(evaluateAlert(first.state, changedFailure).state, pass).notification!;
		const env = { VERIFICATION_ALERT_ENVIRONMENT: "production" } as Env;
		expect(formatAlertEmail(env, update).subject).toBe("[Alabama Beach Flag] Verification Update");
		expect(formatAlertEmail(env, update).text).toContain("Alert type: update");
		expect(formatAlertEmail(env, recovery).subject).toBe("[Alabama Beach Flag] Verification Recovered");
		expect(formatAlertEmail(env, recovery).text).toContain("Alert type: recovery");
	});
});
