export const EVENT_TYPES = ["festival", "raceOrSport", "beachCleanup", "wildlife", "conservation", "educational", "community", "fireworksOrHoliday", "accessOrParkingImpact", "other"] as const;
export const IMPACT_LEVELS = ["informational", "noticeable", "high", "major"] as const;
export const EVENT_STATUSES = ["draft", "discovered", "pendingReview", "approved", "scheduled", "published", "disregarded", "cancelled", "expired", "hidden"] as const;

export type BeachEventType = typeof EVENT_TYPES[number];
export type BeachEventImpact = typeof IMPACT_LEVELS[number];
export type BeachEventStatus = typeof EVENT_STATUSES[number];
export type MatchMethod = "exactVenue" | "exactAddress" | "sourceAlias" | "adminOverride";

export interface SourceFacts {
	providerId: string;
	externalId: string;
	title: string;
	venue: string;
	address?: string;
	startAt: string;
	endAt: string;
	allDay: boolean;
	recurring: boolean;
	sourceName: string;
	sourceURL: string;
	officialURL?: string;
	description?: string;
}

export interface BeachEvent {
	id: string;
	beachId: string;
	title: string;
	venue: string;
	address?: string;
	startAt: string;
	endAt: string;
	allDay: boolean;
	recurring: boolean;
	eventType: BeachEventType;
	impactLevel: BeachEventImpact;
	bannerTitle: string;
	bannerMessage: string;
	parkingImpact: boolean;
	trafficImpact: boolean;
	accessImpact: boolean;
	showCompareNearbyBeaches: boolean;
	displayFrom?: string;
	status: BeachEventStatus;
	sourceName: string;
	sourceURL: string;
	matchMethod: MatchMethod;
	matchConfidence: "exact" | "admin";
	internalNotes?: string;
	sourceFacts: SourceFacts;
	createdAt: string;
	updatedAt: string;
}

export interface BeachEventsSnapshot {
	schemaVersion: 1;
	status: "ok" | "stale" | "disabled";
	generatedAt: string;
	lastSuccessfulRefresh: string;
	staleUntil: string;
	attribution: Array<{ providerId: string; sourceName: string; sourceURL: string }>;
	beaches: Record<string, BeachEvent[]>;
}

export interface DecisionRule {
	id: string;
	action: "disregard" | "autoApprove" | "suggest";
	providerId: string;
	venue?: string;
	titlePattern?: string;
	beachId?: string;
	eventType?: BeachEventType;
	impactLevel?: BeachEventImpact;
	enabled: boolean;
	createdAt: string;
	createdBy: string;
}

export interface BeachEventProviderRefresh {
	providerId: string;
	status: "ok" | "failed" | "disabled" | "monitored";
	fetched: number;
	matched: number;
	excluded: number;
	pendingReview: number;
	ruleSuppressed: number;
	error?: string;
}

export interface BeachEventRefreshStatus {
	schemaVersion: 1;
	status: "running" | "healthy" | "warning" | "failed" | "disabled" | "monitorOnly" | "neverRun";
	trigger: "scheduled" | "admin";
	lastAttempt: string;
	lastSuccess?: string;
	lastFailure?: string;
	lastFailureMessage?: string;
	completedAt?: string;
	nextScheduledRefresh: string;
	scheduleDescription: string;
	operationalState: "enabled" | "disabled" | "monitorOnly";
	providers: BeachEventProviderRefresh[];
	counts: {
		raw: number;
		matched: number;
		excluded: number;
		pendingReview: number;
		published: number;
		ruleSuppressed: number;
		unsupportedOrAmbiguous: number;
	};
	snapshotGeneratedAt?: string;
	staleUntil?: string;
}
