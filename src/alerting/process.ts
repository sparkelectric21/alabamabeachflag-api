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
			.filter((check): check is typeof check & { status: "warning" | "fail" } => check.status !== "pass")
			.map((check) => ({ name: check.name, status: check.status, detail: check.message })),
	};
}

export async function processAlertObservation(
	storage: DurableObjectStorage,
	env: Env,
	observation: AlertObservation,
	delivery = deliverAlert,
): Promise<void> {
	const current = await storage.get<AlertState>("alert-state") ?? {};
	const decision = evaluateAlert(current, observation);
	// Persist intent before external delivery: duplicate execution cannot send the same notification twice.
	await storage.put("alert-state", decision.state);
	if (!decision.notification) return;
	try {
		await delivery(env, decision.notification);
	} catch {
		// Deliberately omit notification contents and environment values from logs.
		console.error("[Verification alerts] delivery failed");
	}
}
