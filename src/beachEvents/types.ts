export const EVENT_TYPES = ["festival", "raceOrSport", "beachCleanup", "wildlife", "conservation", "educational", "community", "fireworksOrHoliday", "accessOrParkingImpact", "other"] as const;
export const IMPACT_LEVELS = ["informational", "noticeable", "high", "major"] as const;
export const EVENT_STATUSES = ["draft", "discovered", "pendingReview", "approved", "scheduled", "published", "disregarded", "cancelled", "expired", "hidden"] as const;
export const BEACH_EVENT_REFRESH_STATUS_KEY = "beach-events:v1:refresh-status";

export type BeachEventType = typeof EVENT_TYPES[number];
export type BeachEventImpact = typeof IMPACT_LEVELS[number];
export type BeachEventStatus = typeof EVENT_STATUSES[number];
export type MatchMethod = "exactVenue" | "exactAddress" | "sourceAlias" | "adminOverride" | "ambiguousSourceChange";
export type SourceEventStatus = "confirmed" | "tentative" | "cancelled" | "postponed";
export type EventAttentionFlag = "materialSourceChange" | "sourceCancelled" | "sourcePostponed" | "sourceMissing" | "sourceRemoved" | "sourceRestored" | "ambiguousMatch" | "possibleDuplicate" | "normalizationWarning";

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
	sourceNote?: string;
	officialURL?: string;
	registrationURL?: string;
	organizerWebsiteURL?: string;
	officialEventsPageURL?: string;
	description?: string;
	sourceNewsletterMonth?: string;
	contactInformation?: string;
	endTimeUnavailable?: boolean;
	sourceStatus?: SourceEventStatus;
	recurrenceId?: string;
	sequence?: number;
	lastModified?: string;
}

export interface SourceChange {
	detectedAt: string;
	previousRevision: string;
	currentRevision: string;
	materialFields: string[];
	cosmeticFields: string[];
	previousStatus: BeachEventStatus;
	previous: SourceFacts;
	current: SourceFacts | null;
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
	sourceNote?: string;
	eventDescription?: string;
	summary?: string;
	fullDescription?: string;
	officialEventURL?: string;
	registrationURL?: string;
	officialEventsPageURL?: string;
	organizerWebsiteURL?: string;
	sourceCalendarURL?: string;
	sourceProvider?: string;
	normalizationWarnings?: string[];
	contactInformation?: string;
	sourceNewsletterMonth?: string;
	endTimeUnavailable?: boolean;
	matchMethod: MatchMethod;
	matchConfidence: "exact" | "admin" | "ambiguous";
	matchRuleId?: string;
	matchExplanation?: string;
	internalNotes?: string;
	sourceFacts: SourceFacts;
	sourceRevision: string;
	reviewedSourceRevision?: string;
	lastSeenAt: string;
	sourceMissingSince?: string;
	sourceMissingCount?: number;
	sourceRemovedAt?: string;
	sourceChange?: SourceChange;
	attentionFlags?: EventAttentionFlag[];
	possibleDuplicateOf?: string;
	manualOverrideFields?: string[];
	createdAt: string;
	updatedAt: string;
}

export interface PublicBeachEvent {
	id: string;
	beachId: string;
	title: string;
	venue: string;
	address?: string;
	startAt: string;
	endAt: string;
	displayFrom?: string;
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
	sourceName: string;
	summary?: string;
	eventDescription?: string;
	fullDescription?: string;
	officialEventURL?: string;
	registrationURL?: string;
	officialEventsPageURL?: string;
	organizerWebsiteURL?: string;
	sourceNote?: string;
	contactInformation?: string;
	sourceNewsletterMonth?: string;
	endTimeUnavailable?: boolean;
	updatedAt: string;
}

export interface BeachEventsSnapshot {
	schemaVersion: 1;
	revision: string;
	status: "ok" | "stale" | "disabled";
	generatedAt: string;
	lastSuccessfulRefresh: string;
	staleUntil: string;
	attribution: Array<{ providerId: string; sourceName: string; sourceURL: string }>;
	beaches: Record<string, PublicBeachEvent[]>;
}

export interface DecisionRule {
	id: string;
	action: "disregard" | "autoApprove" | "suggest";
	providerId: string;
	venue?: string;
	address?: string;
	titlePattern?: string;
	beachId?: string;
	eventType?: BeachEventType;
	impactLevel?: BeachEventImpact;
	enabled: boolean;
	createdAt: string;
	createdBy: string;
}

export interface ExcludedEventCandidate {
	id: string;
	providerId: string;
	title: string;
	venue: string;
	address?: string;
	startAt: string;
	endAt: string;
	sourceName: string;
	sourceURL: string;
	reason: "inlandVenue" | "citywideOrBroadLocation" | "nearbyNotAtBeach" | "unsupportedVenue" | "unsupportedBeach" | "unknownVenue" | "ambiguousLocation" | "providerDisabled" | "providerMonitorOnly" | "disregardRule" | "duplicate" | "expiredBeforeDiscovery" | "invalidSourceRecord" | "nonBeachEventType" | "exactBeachNotRepresented";
	reasonDetail: string;
	suggestedBeachId?: string;
	matchConfidence: "none" | "possible";
	possibleDuplicateOf?: string;
	ruleId: string;
	decision: "automatic" | "admin";
	sourceFacts: SourceFacts;
	firstSeenAt: string;
	lastSeenAt: string;
}

export interface BeachEventProviderRefresh {
	providerId: string;
	status: "ok" | "failed" | "disabled" | "monitored";
	fetched: number;
	matched: number;
	excluded: number;
	pendingReview: number;
	published: number;
	ruleSuppressed: number;
	unsupportedOrAmbiguous: number;
	newEvents?: number;
	changed?: number;
	unchanged?: number;
	possibleDuplicates?: number;
	warnings?: number;
	missingFromSource?: number;
	restored?: number;
	freshness: "fresh" | "stale" | "never";
	lastAttempt: string;
	lastSuccess?: string;
	lastFailure?: string;
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
		newEvents?: number;
		changed?: number;
		unchanged?: number;
		possibleDuplicates?: number;
		warnings?: number;
		missingFromSource?: number;
		restored?: number;
	};
	publicRevisionChanged?: boolean;
	snapshotGeneratedAt?: string;
	staleUntil?: string;
}
