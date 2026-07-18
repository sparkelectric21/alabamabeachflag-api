import {
	DIRECT_OBSERVATION_FUTURE_TOLERANCE_MS,
	DIRECT_OBSERVATION_MAX_AGE_MS,
} from "../waterTemperature/freshness";

export type VibrioConditionsStatus = "unavailable" | "seasonalAwareness";
export type VibrioDiagnosticCode =
	| "missing_observation"
	| "missing_temperature"
	| "stale_observation"
	| "future_observation"
	| "invalid_temperature"
	| "invalid_salinity"
	| "parser_failure";

export interface VibrioConditionsObservation {
	waterTemperature: number;
	waterTemperatureUnit: "F";
	observedAt: string;
	provider: "coops" | "ndbc" | "fixture";
	stationId: string;
	salinity?: number;
	salinityUnit?: "psu";
}

export interface VibrioConditionsResult {
	status: VibrioConditionsStatus;
	waterTemperature?: { value: number; unit: "F" };
	salinity?: { value: number; unit: "psu" };
	dataTimestamp?: string;
	generatedAt: string;
	source: {
		name: string;
		provider?: VibrioConditionsObservation["provider"];
		stationId?: string;
		kind: "education" | "observation";
	};
	provenance: string;
	limitations: string[];
	/** Internal refresh diagnostic. Strip before writing the public payload. */
	diagnosticCode?: VibrioDiagnosticCode;
}

export interface VibrioConditionsEstimatorOptions {
	enabled: boolean;
	now: Date;
	observation?: VibrioConditionsObservation | null;
	maxObservationAgeMs?: number;
	futureToleranceMs?: number;
}

const LIMITATIONS = [
	"Educational seasonal context only; this is not a live bacterial estimate.",
	"Alabama Beach Flag does not test the water, confirm Vibrio is present, predict personal medical risk, or declare swimming safe.",
	"Follow official beach closures, advisories, flags, rip-current warnings, and weather alerts.",
];

function unavailable(now: Date, reason: string, diagnosticCode?: VibrioDiagnosticCode): VibrioConditionsResult {
	return {
		status: "unavailable",
		generatedAt: now.toISOString(),
		source: { name: "CDC", kind: "education" },
		provenance: reason,
		limitations: LIMITATIONS,
		...(diagnosticCode ? { diagnosticCode } : {}),
	};
}

export function estimateVibrioConditions(
	options: VibrioConditionsEstimatorOptions,
): VibrioConditionsResult {
	const { enabled, now, observation } = options;
	if (!enabled) return unavailable(now, "Feature disabled.");
	if (!Number.isFinite(now.getTime())) return unavailable(new Date(0), "Generation time is invalid.");

	const month = now.getUTCMonth() + 1;
	if (month < 5 || month > 10) {
		return unavailable(now, "Outside the May–October CDC seasonal-awareness period.");
	}
	if (!observation || typeof observation !== "object") {
		return unavailable(now, "A current direct observation is unavailable; no climatology fallback was used.", "missing_observation");
	}
	if (typeof observation.observedAt !== "string") {
		return unavailable(now, "Observation could not be parsed.", "parser_failure");
	}
	if (observation.waterTemperatureUnit !== "F" ||
		!(["coops", "ndbc", "fixture"] as const).includes(observation.provider) ||
		typeof observation.stationId !== "string" || observation.stationId.length === 0) {
		return unavailable(now, "Observation metadata could not be parsed.", "parser_failure");
	}

	const observedAt = new Date(observation.observedAt);
	const observedMs = observedAt.getTime();
	if (!Number.isFinite(observedMs)) return unavailable(now, "Observation timestamp is invalid.", "parser_failure");
	if (observedMs - now.getTime() > (options.futureToleranceMs ?? DIRECT_OBSERVATION_FUTURE_TOLERANCE_MS)) {
		return unavailable(now, "Observation is future-dated.", "future_observation");
	}
	if (now.getTime() - observedMs > (options.maxObservationAgeMs ?? DIRECT_OBSERVATION_MAX_AGE_MS)) {
		return unavailable(now, "Observation is stale; no climatology fallback was used.", "stale_observation");
	}
	if (typeof observation.waterTemperature !== "number") {
		return unavailable(now, "Water temperature is missing.", "missing_temperature");
	}
	if (!Number.isFinite(observation.waterTemperature) || observation.waterTemperature < 28 || observation.waterTemperature > 104) {
		return unavailable(now, "Water temperature is physically invalid.", "invalid_temperature");
	}
	if (observation.salinity !== undefined &&
		(!Number.isFinite(observation.salinity) || observation.salinity < 0 || observation.salinity > 45)) {
		return unavailable(now, "Salinity is physically invalid.", "invalid_salinity");
	}

	return {
		status: "seasonalAwareness",
		waterTemperature: { value: observation.waterTemperature, unit: "F" },
		...(observation.salinity === undefined ? {} : { salinity: { value: observation.salinity, unit: "psu" as const } }),
		dataTimestamp: observedAt.toISOString(),
		generatedAt: now.toISOString(),
		source: {
			name: observation.provider === "fixture" ? "Prototype fixture" : "NOAA",
			provider: observation.provider,
			stationId: observation.stationId,
			kind: "observation",
		},
		provenance: "CDC May–October seasonal education paired with a direct water-temperature observation. Temperature does not estimate Vibrio concentration.",
		limitations: LIMITATIONS,
	};
}
