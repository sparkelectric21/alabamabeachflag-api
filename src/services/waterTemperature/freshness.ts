export const DIRECT_OBSERVATION_MAX_AGE_MS = 2 * 60 * 60 * 1_000;
export const DIRECT_OBSERVATION_UNAVAILABLE_AFTER_MS = 6 * 60 * 60 * 1_000;
export const DIRECT_OBSERVATION_FUTURE_TOLERANCE_MS = 10 * 60 * 1_000;

export type DirectObservationFreshness = "current" | "stale" | "unavailable" | "invalid" | "future";

export function directObservationMaxAgeMs(_provider: string, _stationId: string): number {
	return DIRECT_OBSERVATION_MAX_AGE_MS;
}

export function directObservationAgeMs(observedAt: string, now: Date): number | undefined {
	const observedMs = new Date(observedAt).getTime();
	return Number.isFinite(observedMs) ? now.getTime() - observedMs : undefined;
}

export function classifyDirectObservation(
	observedAt: string,
	now: Date,
	staleAfterMs = DIRECT_OBSERVATION_MAX_AGE_MS,
	unavailableAfterMs = DIRECT_OBSERVATION_UNAVAILABLE_AFTER_MS,
	futureToleranceMs = DIRECT_OBSERVATION_FUTURE_TOLERANCE_MS,
): DirectObservationFreshness {
	const ageMs = directObservationAgeMs(observedAt, now);
	if (ageMs === undefined) return "invalid";
	if (ageMs < -futureToleranceMs) return "future";
	if (ageMs <= staleAfterMs) return "current";
	if (ageMs <= unavailableAfterMs) return "stale";
	return "unavailable";
}

export function isFreshDirectObservation(
	observedAt: string,
	now: Date,
	maxAgeMs = DIRECT_OBSERVATION_MAX_AGE_MS,
	futureToleranceMs = DIRECT_OBSERVATION_FUTURE_TOLERANCE_MS,
): boolean {
	const ageMs = directObservationAgeMs(observedAt, now);
	return ageMs !== undefined && ageMs <= maxAgeMs && ageMs >= -futureToleranceMs;
}
