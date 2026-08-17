export type OfficialAlertSource = "nws";
export type OfficialAlertCategory = "ripCurrent" | "surf" | "coastalFlood" | "tropical" | "severeWeather" | "marineWeather" | "tsunami" | "heat";
export type OfficialAlertLifecycle = "active" | "superseded" | "cancelled" | "expired";
export type SourceFreshness = "fresh" | "stale" | "unavailable";
export type AbfRegionId = "gulfShores" | "orangeBeach" | "fortMorgan" | "dauphinIsland";

export interface AlertGeometry {
	type: "Polygon" | "MultiPolygon";
	coordinates: unknown;
}

export interface NormalizedOfficialAlert {
	id: string;
	source: OfficialAlertSource;
	sourceIdentifier: string;
	sourceSender: string | null;
	issuer: string;
	event: string;
	eventCodes: Record<string, string[]>;
	category: OfficialAlertCategory;
	severity: "Minor" | "Moderate" | "Severe" | "Extreme" | "Unknown";
	urgency: "Immediate" | "Expected" | "Future" | "Past" | "Unknown";
	certainty: "Observed" | "Likely" | "Possible" | "Unlikely" | "Unknown";
	headline: string;
	description: string | null;
	instruction: string | null;
	effectiveAt: string;
	onsetAt: string | null;
	expiresAt: string;
	sentAt: string;
	receivedAt: string;
	updatedAt: string;
	sourceStatus: string;
	messageType: string;
	references: string[];
	incidents: string[];
	affectedRegions: AbfRegionId[];
	geometry: AlertGeometry | null;
	sourceURL: string | null;
	lifecycleState: OfficialAlertLifecycle;
	correlationKey: string;
}

export interface RegionSourceState {
	region: AbfRegionId;
	status: "success" | "notModified" | "failed";
	lastAttemptAt: string;
	lastSuccessAt: string | null;
	httpStatus: number | null;
	etag: string | null;
	lastModified: string | null;
	parseFailures: number;
	error: string | null;
	sourceIdentifiers: string[];
}

export interface OfficialAlertSnapshot {
	schemaVersion: 1;
	generatedAt: string;
	lastSuccessfulIngestionAt: string | null;
	lastDataChangeAt: string | null;
	sourceFreshness: SourceFreshness;
	alerts: NormalizedOfficialAlert[];
	history: NormalizedOfficialAlert[];
	regions: Record<AbfRegionId, RegionSourceState>;
}
