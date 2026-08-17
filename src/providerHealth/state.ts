import type { ProviderAlertEvent, ProviderFetchDiagnostics, ProviderHealthDecision, ProviderHealthObservation, ProviderHealthOptions, ProviderHealthState, ProviderIncidentKind, ProviderIngestionMode } from "./types";

const DEFAULT_REMINDER_AFTER_MS = 6 * 60 * 60 * 1_000;
const ACTIONABLE_MODES = new Set<ProviderIngestionMode>(["enabled", "monitorOnly"]);
const MAX_DIAGNOSTIC_TEXT = 120;

const boundedText = (value: unknown): string | undefined => typeof value === "string" && value.trim()
	? value.trim().replace(/[\r\n\t]+/g, " ").slice(0, MAX_DIAGNOSTIC_TEXT)
	: undefined;
const boundedInteger = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | undefined => typeof value === "number" && Number.isFinite(value)
	? Math.min(maximum, Math.max(0, Math.floor(value)))
	: undefined;

export function sanitizeProviderDiagnostics(value: unknown): ProviderFetchDiagnostics | undefined {
	if (!value || typeof value !== "object") return undefined;
	const input = value as Record<string, unknown>;
	const output: ProviderFetchDiagnostics = {};
	const httpStatus = boundedInteger(input.httpStatus, 999); if (httpStatus !== undefined) output.httpStatus = httpStatus;
	const contentType = boundedText(input.contentType); if (contentType) output.contentType = contentType;
	const responseBytes = boundedInteger(input.responseBytes); if (responseBytes !== undefined) output.responseBytes = responseBytes;
	const fetchDurationMs = boundedInteger(input.fetchDurationMs, 86_400_000); if (fetchDurationMs !== undefined) output.fetchDurationMs = fetchDurationMs;
	const componentIndex = boundedInteger(input.componentIndex, 1_000_000); if (componentIndex !== undefined) output.componentIndex = componentIndex;
	const uidHash = boundedText(input.uidHash); if (uidHash && /^[a-f0-9]{8,64}$/i.test(uidHash)) output.uidHash = uidHash;
	const fieldCategory = boundedText(input.fieldCategory); if (fieldCategory && /^[a-z0-9_-]+$/i.test(fieldCategory)) output.fieldCategory = fieldCategory;
	const failureCategory = boundedText(input.failureCategory); if (failureCategory && /^[a-z0-9_-]+$/i.test(failureCategory)) output.failureCategory = failureCategory;
	const attemptCount = boundedInteger(input.attemptCount, 2); if (attemptCount !== undefined) output.attemptCount = attemptCount;
	if (typeof input.partial === "boolean") output.partial = input.partial;
	for (const field of ["totalVEventCount", "validVEventCount", "rejectedVEventCount"] as const) {
		const parsed = boundedInteger(input[field], 1_000_000); if (parsed !== undefined) output[field] = parsed;
	}
	return Object.keys(output).length ? output : undefined;
}

export const providerModeIsActionable = (mode: ProviderIngestionMode | undefined): boolean => mode === undefined || ACTIONABLE_MODES.has(mode);

export function reconcileProviderMonitoringState(previous: ProviderHealthState, mode: ProviderIngestionMode, now: string): ProviderHealthState {
	if (providerModeIsActionable(mode)) {
		return { ...previous, ingestionMode: mode, monitoringStatus: mode === "monitorOnly" ? "monitoring" : "actionable", incidentActionable: Boolean(previous.activeIncidentId) };
	}
	const reason = mode === "disabled" ? "provider_disabled" as const : mode === "manualOnly" ? "manual_only" as const : mode === "retired" ? "provider_retired" as const : "monitoring_ended" as const;
	if (previous.ingestionMode === mode && previous.monitoringStatus === "ended" && previous.incidentActionable === false && previous.monitoringEndedReason === reason) return previous;
	return {
		...previous,
		ingestionMode: mode,
		monitoringStatus: previous.activeIncidentId ? "ended" : "excluded",
		incidentActionable: false,
		monitoringEndedAt: previous.monitoringEndedAt ?? now,
		monitoringEndedReason: reason,
		updatedAt: now,
	};
}

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
		ingestionMode: observation.ingestionMode ?? "enabled",
		monitoringStatus: observation.ingestionMode === "monitorOnly" ? "monitoring" : "actionable",
		incidentActionable: false,
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
	const mode = observation.ingestionMode ?? base.ingestionMode ?? "enabled";
	if (!providerModeIsActionable(mode)) return { state: reconcileProviderMonitoringState(base, mode, now) };

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
			ingestionMode: mode,
			monitoringStatus: mode === "monitorOnly" ? "monitoring" : "actionable",
			incidentActionable: Boolean(base.activeIncidentId),
			...(sanitizeProviderDiagnostics(observation.diagnostics) ? { lastDiagnostics: sanitizeProviderDiagnostics(observation.diagnostics) } : {}),
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
				incidentActionable: false,
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
		ingestionMode: mode,
		monitoringStatus: mode === "monitorOnly" ? "monitoring" : "actionable",
		incidentActionable: Boolean(base.activeIncidentId),
		...(sanitizeProviderDiagnostics(observation.diagnostics) ? { lastDiagnostics: sanitizeProviderDiagnostics(observation.diagnostics) } : {}),
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
		incidentActionable: true,
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
