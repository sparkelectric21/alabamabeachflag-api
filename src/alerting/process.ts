import type { Env } from "../types";
import type { VerificationReport } from "../verification/types";
import { deliverAlert } from "./delivery";
import { evaluateAlert } from "./state";
import type { AlertObservation, AlertState } from "./types";

export function observationFromReport(report: VerificationReport): AlertObservation {
	return {
		slot: report.slot,
		reportTime: report.completedAt,
		status: report.status,
		affected: report.checks
			.filter((check): check is typeof check & { status: "fail" } => check.status === "fail")
			.map((check) => ({
				name: check.name,
				status: check.status,
				detail: check.message,
				provider: check.provider,
				location: check.location,
				expectedValue: check.expectedValue,
				actualValue: check.actualValue,
			})),
	};
}

export async function processAlertObservation(
	storage: DurableObjectStorage,
	env: Env,
	observation: AlertObservation,
	delivery = deliverAlert,
	stateKey = "alert-state",
): Promise<void> {
	const current = await storage.get<AlertState>(stateKey) ?? {};
	const decision = evaluateAlert(current, observation);
	// Persist intent before external delivery: duplicate execution cannot send the same notification twice.
	await storage.put(stateKey, decision.state);
	if (!decision.notification) return;
	try {
		const outcome = await delivery(env, decision.notification);
		await storage.put(`${stateKey}:delivery`, { kind: decision.notification.kind, at: observation.reportTime, outcome: outcome === "disabled" ? "disabled" : "delivered" });
	} catch {
		await storage.put(`${stateKey}:delivery`, { kind: decision.notification.kind, at: observation.reportTime, outcome: "failed" });
		// Deliberately omit notification contents and environment values from logs.
		console.error("[Verification alerts] delivery failed");
	}
}
