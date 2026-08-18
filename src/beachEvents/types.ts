export const EVENT_TYPES = ["festival", "raceOrSport", "beachCleanup", "wildlife", "conservation", "educational", "community", "fireworksOrHoliday", "accessOrParkingImpact", "other"] as const;
export const IMPACT_LEVELS = ["informational", "noticeable", "high", "major"] as const;
export const EVENT_STATUSES = ["draft", "discovered", "pendingReview", "approved", "scheduled", "published", "completed", "disregarded", "cancelled", "expired", "hidden"] as const;
export const BEACH_EVENT_REFRESH_STATUS_KEY = "beach-events:v1:refresh-status";

export type BeachEventType = typeof EVENT_TYPES[number];
export type BeachEventImpact = typeof IMPACT_LEVELS[number];
export type BeachEventStatus = typeof EVENT_STATUSES[number];
export type MatchMethod = "exactVenue" | "exactAddress" | "sourceAlias" | "adminOverride" | "ambiguousSourceChange";
export type SourceEventStatus = "confirmed" | "tentative" | "cancelled" | "postponed";
export type EventLocationClass = "beachSpecific" | "nearbyCoastal" | "regional" | "irrelevant";
export type LocationEvidenceOrigin = "source" | "rule" | "administrator";
export interface LocationEvidenceItem {
	kind: "exactVenue" | "exactAddress" | "explicitBeachToken" | "providerCoverage" | "knownExclusion" | "broadLocation" | "nearbyVenue" | "administratorOverride" | "missingLocation";
	origin: LocationEvidenceOrigin;
	value: string;
	supportsExact: boolean;
}
export interface EventLocationAssessment {
	classification: EventLocationClass;
	precisionLabel: "At this beach" | "Nearby coastal" | "Regional" | "Not beach relevant";
	proposedBeachId?: string;
	region?: string;
	evidence: LocationEvidenceItem[];
	conflicts: string[];
	exactAssignmentSupported: boolean;
	assignmentOrigin: LocationEvidenceOrigin;
}
export type EventAttentionFlag = "materialSourceChange" | "sourceCancelled" | "sourcePostponed" | "sourceMissing" | "sourceRemoved" | "sourceRestored" | "ambiguousMatch" | "possibleDuplicate" | "normalizationWarning" | "identityCompatibilityReview";
export type EventConfirmationStatus = "confirmed" | "aging" | "suspectedMissing" | "sourceRemoved" | "cancelled" | "postponed" | "completed" | "archived" | "manualReviewDue";
export type SourceChangeSeverity = "cosmetic" | "informational" | "material" | "critical";

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
	organizerEventId?: string;
	seriesId?: string;
}

export type DuplicateClassification = "sameSourceRecord" | "strongDuplicate" | "likelyDuplicate" | "possibleDuplicate" | "distinctOccurrence" | "unrelated";
export type DuplicateRelationship = "sameCanonicalEvent" | "relatedOccurrences" | "keepSeparate" | "suppressDuplicate";
export interface DuplicateAssessment { pairId: string; eventIds: string[]; classification: DuplicateClassification; blockingReasons: string[]; positiveEvidence: string[]; conflictingEvidence: string[]; titleTokens: Record<string, string[]>; proposedCanonicalEventId?: string; proposedRelationship: DuplicateRelationship; recommendedAction: "reviewCanonicalLink" | "reviewPossibleDuplicate" | "keepSeparate" }
export interface DuplicateResolution { decision: DuplicateRelationship; relatedEventId: string; canonicalEventId?: string; evidenceRevision: string; decidedAt: string; decidedBy: string }

export interface SourceChange {
	detectedAt: string;
	previousRevision: string;
	currentRevision: string;
	materialFields: string[];
	cosmeticFields: string[];
	previousStatus: BeachEventStatus;
	previous: SourceFacts;
	current: SourceFacts | null;
	severity?: SourceChangeSeverity;
	explanations?: string[];
	observedAt?: string;
}

export interface EventAbsenceInterval { firstAbsentAt: string; restoredAt?: string; removedAt?: string; successfulChecksAbsent: number; policyId: string }
export interface EventConfirmation {
	status: EventConfirmationStatus;
	reason: string;
	policyId: string;
	lastConfirmedAt?: string;
	firstAbsentAt?: string;
	successfulChecksAbsent: number;
	lastCompleteObservationAt?: string;
	observationCompleteness?: "complete" | "partial" | "confirmedUnchanged" | "failed" | "qualityRejected";
	absenceHistory?: EventAbsenceInterval[];
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
	location?: EventLocationAssessment;
	locationReviewRequired?: boolean;
	confirmation?: EventConfirmation;
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
	duplicateAssessment?: DuplicateAssessment;
	duplicateAcknowledgment?: { acknowledgedAt: string; assessmentRevision: string; reason: "reviewed" };
	duplicateResolution?: DuplicateResolution;
	identityCompatibility?: { status: "legacyCompatible" | "legacyCollision"; legacyId: string; preferredId: string };
	manualOverrideFields?: string[];
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
	archivedAt?: string;
	priorPublicationStatus?: "published";
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
	locationClass?: EventLocationClass;
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
	location?: EventLocationAssessment;
	firstSeenAt: string;
	lastSeenAt: string;
}

export interface BeachEventProviderRefresh {
	providerId: string;
	status: "ok" | "partial" | "failed" | "disabled" | "monitored";
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
	diagnostics?: import("../providerHealth/types").ProviderFetchDiagnostics;
	completeness?: "complete" | "partial" | "confirmedUnchanged";
}

export interface BeachEventRefreshStatus {
	schemaVersion: 1;
	runId?: string;
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
	scope?: {
		mode: "all" | "provider";
		selectedProviderId?: string;
		requestedProviderCount: number;
		attemptedProviderCount: number;
		skipReason?: string;
	};
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
