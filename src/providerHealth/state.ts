import type { ProviderAlertEvent, ProviderHealthDecision, ProviderHealthObservation, ProviderHealthOptions, ProviderHealthState, ProviderIncidentKind } from "./types";

const DEFAULT_REMINDER_AFTER_MS = 6 * 60 * 60 * 1_000;

function normalizedCount(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function isShared(affected: number, expected: number): boolean {
	return expected > 0 && affected >= Math.ceil(expected * 2 / 3);
}

function incidentId(observation: ProviderHealthObservation, now: string): string {
	return `${encodeURIComponent(observation.provider)}:${encodeURIComponent(observation.domain)}:${now}`;
}

function event(state: ProviderHealthState, type: ProviderAlertEvent["type"], now: string): ProviderAlertEvent {
	const id = state.activeIncidentId!;
	return {
		id: `${id}:${type}:${now}`,
		type,
		incidentId: id,
		incidentKind: state.incidentKind!,
		severity: type === "recovery" ? "recovery" : state.incidentKind === "quality_gate" ? "critical" : "warning",
		provider: state.provider,
		domain: state.domain,
		createdAt: now,
		affectedBeachCount: state.affectedBeachCount,
		expectedBeachCount: state.expectedBeachCount,
		consecutiveFailures: state.consecutiveFailures,
		...(state.lastErrorReason ? { errorReason: state.lastErrorReason } : {}),
	};
}

function initial(observation: ProviderHealthObservation, now: string): ProviderHealthState {
	return {
		provider: observation.provider,
		domain: observation.domain,
		currentStatus: "healthy",
		consecutiveFailures: 0,
		consecutiveSuccesses: 0,
		affectedBeachCount: 0,
		expectedBeachCount: normalizedCount(observation.expectedBeachCount),
		alertState: "clear",
		updatedAt: now,
	};
}

export function evaluateProviderHealth(
	previous: ProviderHealthState | undefined,
	observation: ProviderHealthObservation,
	now: string,
	options: ProviderHealthOptions = {},
): ProviderHealthDecision {
	const affected = normalizedCount(observation.affectedBeachCount);
	const expected = normalizedCount(observation.expectedBeachCount);
	const failed = affected > 0;
	const base = previous?.provider === observation.provider && previous.domain === observation.domain
		? previous
		: initial(observation, now);

	if (!failed) {
		const successes = base.consecutiveSuccesses + 1;
		const next: ProviderHealthState = {
			...base,
			currentStatus: "healthy",
			consecutiveFailures: 0,
			consecutiveSuccesses: successes,
			affectedBeachCount: 0,
			expectedBeachCount: expected,
			lastSuccessAt: now,
			updatedAt: now,
		};
		if (!base.activeIncidentId) return { state: { ...next, alertState: "clear" } };
		const recoveryThreshold = base.incidentKind === "isolated" ? 2 : 1;
		if (successes < recoveryThreshold) return { state: next };
		const recovery = event(next, "recovery", now);
		return {
			state: {
				...next,
				activeIncidentId: undefined,
				incidentKind: undefined,
				alertState: "clear",
				alertOpenedAt: undefined,
				recoveryAlertSentAt: now,
				lastReminderAt: undefined,
				lastErrorReason: undefined,
				firstFailureAt: undefined,
			},
			event: recovery,
		};
	}

	const failures = base.consecutiveFailures + 1;
	const shared = isShared(affected, expected);
	const next: ProviderHealthState = {
		...base,
		currentStatus: shared ? "unavailable" : "degraded",
		consecutiveFailures: failures,
		consecutiveSuccesses: 0,
		affectedBeachCount: affected,
		expectedBeachCount: expected,
		firstFailureAt: base.consecutiveFailures > 0 ? base.firstFailureAt ?? now : now,
		lastFailureAt: now,
		lastErrorReason: observation.errorReason ?? "provider_failure",
		alertState: base.activeIncidentId ? "active" : "pending",
		updatedAt: now,
	};

	if (base.activeIncidentId) {
		const reminderAfter = options.reminderAfterMs ?? DEFAULT_REMINDER_AFTER_MS;
		const reference = Date.parse(base.lastReminderAt ?? base.alertOpenedAt ?? now);
		if (options.remindersEnabled && Date.parse(now) - reference >= reminderAfter) {
			const reminded = { ...next, lastReminderAt: now };
			return { state: reminded, event: event(reminded, "reminder", now) };
		}
		return { state: next };
	}

	const kind: ProviderIncidentKind = shared ? "shared_provider" : "isolated";
	const threshold = shared ? 2 : 4;
	if (failures < threshold) return { state: next };
	const opened = {
		...next,
		activeIncidentId: incidentId(observation, now),
		incidentKind: kind,
		alertState: "active" as const,
		alertOpenedAt: now,
	};
	return { state: opened, event: event(opened, "opened", now) };
}

export function evaluateQualityGateRejection(
	previous: ProviderHealthState | undefined,
	now: string,
	errorReason: string,
	expectedBeachCount: number,
	affectedBeachCount: number,
): ProviderHealthDecision {
	const observation = { provider: "publication_quality_gate", domain: "beach_conditions", expectedBeachCount, affectedBeachCount, errorReason };
	const base = previous?.provider === observation.provider && previous.domain === observation.domain ? previous : initial(observation, now);
	const next: ProviderHealthState = {
		...base,
		currentStatus: "unavailable",
		consecutiveFailures: base.consecutiveFailures + 1,
		consecutiveSuccesses: 0,
		affectedBeachCount: normalizedCount(affectedBeachCount),
		expectedBeachCount: normalizedCount(expectedBeachCount),
		firstFailureAt: base.consecutiveFailures > 0 ? base.firstFailureAt ?? now : now,
		lastFailureAt: now,
		lastErrorReason: errorReason,
		alertState: "active",
		updatedAt: now,
	};
	if (base.activeIncidentId) return { state: next };
	const opened = { ...next, activeIncidentId: incidentId(observation, now), incidentKind: "quality_gate" as const, alertOpenedAt: now };
	return { state: opened, event: event(opened, "opened", now) };
}
