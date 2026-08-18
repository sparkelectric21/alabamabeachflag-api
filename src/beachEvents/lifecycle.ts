import type { BeachEvent, EventConfirmation } from "./types";

export interface EventCadencePolicy {
	id: string;
	kind: "daily" | "weekly" | "monthly" | "annualManual";
	suspectedChecks?: number;
	suspectedElapsedMs?: number;
	removedChecks?: number;
	removedElapsedMs?: number;
	automatedAbsence: boolean;
}
const DAY = 86_400_000;
export const EVENT_CADENCE_POLICIES: Record<string, EventCadencePolicy> = {
	dailyStructured: { id: "daily-structured-v1", kind: "daily", suspectedChecks: 2, suspectedElapsedMs: DAY, removedChecks: 3, removedElapsedMs: 3 * DAY, automatedAbsence: true },
	weekly: { id: "weekly-v1", kind: "weekly", suspectedChecks: 2, suspectedElapsedMs: 7 * DAY, removedChecks: 3, removedElapsedMs: 14 * DAY, automatedAbsence: true },
	monthly: { id: "monthly-no-omission-removal-v1", kind: "monthly", automatedAbsence: false },
	annualManual: { id: "annual-manual-review-v1", kind: "annualManual", automatedAbsence: false },
};

export function eventCadencePolicy(providerId: string): EventCadencePolicy {
	if (["gulfShoresCity", "orangeBeachParks", "orangeBeachCoastalResources", "gulfStatePark"].includes(providerId)) return EVENT_CADENCE_POLICIES.dailyStructured;
	if (providerId === "dauphinIslandTown") return EVENT_CADENCE_POLICIES.monthly;
	return EVENT_CADENCE_POLICIES.annualManual;
}

export function confirmationForObserved(event: Pick<BeachEvent, "confirmation" | "sourceMissingSince" | "sourceMissingCount" | "sourceRemovedAt">, providerId: string, now: Date, reason = "present_in_complete_observation"): EventConfirmation {
	const policy = eventCadencePolicy(providerId), prior = event.confirmation;
	const firstAbsentAt = prior?.firstAbsentAt ?? event.sourceMissingSince;
	const absentChecks = prior?.successfulChecksAbsent ?? event.sourceMissingCount ?? 0;
	const history = [...(prior?.absenceHistory ?? [])];
	if (firstAbsentAt && absentChecks > 0) history.push({ firstAbsentAt, restoredAt: now.toISOString(), ...(event.sourceRemovedAt ? { removedAt: event.sourceRemovedAt } : {}), successfulChecksAbsent: absentChecks, policyId: prior?.policyId ?? policy.id });
	return { status: "confirmed", reason, policyId: policy.id, lastConfirmedAt: now.toISOString(), successfulChecksAbsent: 0, lastCompleteObservationAt: now.toISOString(), observationCompleteness: "complete", ...(history.length ? { absenceHistory: history.slice(-12) } : {}) };
}

export function confirmationForAbsence(event: Pick<BeachEvent, "confirmation" | "lastSeenAt" | "sourceMissingSince" | "sourceMissingCount">, providerId: string, now: Date, policyOverride?: EventCadencePolicy): EventConfirmation {
	const policy = policyOverride ?? eventCadencePolicy(providerId), prior = event.confirmation;
	if (!policy.automatedAbsence) return prior ?? { status: policy.kind === "annualManual" ? "manualReviewDue" : "confirmed", reason: "omission_not_actionable_for_provider_cadence", policyId: policy.id, lastConfirmedAt: event.lastSeenAt, successfulChecksAbsent: 0, observationCompleteness: "complete" };
	const firstAbsentAt = prior?.firstAbsentAt ?? event.sourceMissingSince ?? now.toISOString();
	const checks = (prior?.successfulChecksAbsent ?? event.sourceMissingCount ?? 0) + 1;
	const elapsed = Math.max(0, now.getTime() - Date.parse(firstAbsentAt));
	const removed = checks >= policy.removedChecks! && elapsed >= policy.removedElapsedMs!;
	const suspected = checks >= policy.suspectedChecks! && elapsed >= policy.suspectedElapsedMs!;
	return { ...prior, status: removed ? "sourceRemoved" : suspected ? "suspectedMissing" : "aging", reason: removed ? "complete_observation_removal_threshold_met" : suspected ? "complete_observation_suspected_threshold_met" : "awaiting_count_and_elapsed_thresholds", policyId: policy.id, lastConfirmedAt: prior?.lastConfirmedAt ?? event.lastSeenAt, firstAbsentAt, successfulChecksAbsent: checks, lastCompleteObservationAt: now.toISOString(), observationCompleteness: "complete" };
}

export function auditConfirmationTransition(event: BeachEvent, providerObservation: "completeAbsent" | "completePresent" | "partial" | "failed" | "qualityRejected" | "confirmedUnchanged", now: Date, providerHealth: "healthy" | "degraded" | "unavailable" = "healthy") {
	const current = event.confirmation?.status ?? (event.sourceRemovedAt ? "sourceRemoved" : event.sourceMissingCount ? "aging" : "confirmed");
	const proposed = providerObservation === "completeAbsent" ? confirmationForAbsence(event, event.sourceFacts.providerId, now) : providerObservation === "completePresent" ? confirmationForObserved(event, event.sourceFacts.providerId, now) : event.confirmation;
	const qualifying = providerObservation === "completeAbsent";
	return { eventId: event.id, currentState: current, proposedState: proposed?.status ?? current, policy: eventCadencePolicy(event.sourceFacts.providerId), elapsedMs: proposed?.firstAbsentAt ? Math.max(0, now.getTime() - Date.parse(proposed.firstAbsentAt)) : 0, qualifyingCompleteObservation: qualifying, successfulChecksAbsent: proposed?.successfulChecksAbsent ?? event.sourceMissingCount ?? 0, providerHealth, recommendedOperatorReview: ["suspectedMissing", "sourceRemoved", "manualReviewDue"].includes(proposed?.status ?? current), automatedTransitionAllowed: qualifying && eventCadencePolicy(event.sourceFacts.providerId).automatedAbsence };
}
