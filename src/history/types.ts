export type HistoricalRecordKind = "observation" | "forecast" | "prediction" | "state" | "result";
export type HistoricalBeachArea = "gulfShores" | "orangeBeach" | "fortMorgan" | "dauphinIsland";
export type ObservationTimeBasis = "provider_observation" | "predicted_event" | "sample_date" | "inferred_snapshot";

export interface HistoricalObservationInput {
	observationType: string;
	recordKind: HistoricalRecordKind;
	beachArea?: HistoricalBeachArea;
	beachId?: string;
	provider: string;
	stationId?: string;
	sourceStationId?: string;
	observedAt: string;
	fetchedAt: string;
	valueNumeric?: number;
	valueText?: string;
	unit?: string;
	normalizedValueNumeric?: number;
	qualityFlag?: string;
	freshnessState?: string;
	sourceIdentifier?: string;
	observationTimeBasis: ObservationTimeBasis;
	sourceConfigurationVersion: string;
	providerMetadata?: Record<string, unknown>;
	/** Stable source/provenance fields that represent meaningful content changes. */
	revisionMetadata?: Record<string, unknown>;
}

export interface HistoricalIngestionResult {
	attempted: number;
	inserted: number;
	duplicates: number;
	rejected: number;
}
