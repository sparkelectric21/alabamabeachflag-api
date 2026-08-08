export type HistoricalRecordKind = "observation" | "forecast" | "prediction" | "state" | "result";

export interface HistoricalObservationInput {
	observationType: string;
	recordKind: HistoricalRecordKind;
	beachArea?: string;
	beachId?: string;
	provider: string;
	stationId?: string;
	observedAt: string;
	fetchedAt: string;
	valueNumeric?: number;
	valueText?: string;
	unit?: string;
	normalizedValueNumeric?: number;
	qualityFlag?: string;
	freshnessState?: string;
	sourceIdentifier?: string;
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
