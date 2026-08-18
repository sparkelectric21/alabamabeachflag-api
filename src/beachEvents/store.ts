import type { AdminIdentity } from "../services/admin/auth";
import type { Env } from "../types";
import { explainBeachMatch } from "./matching";
import type { BeachEvent, BeachEventsSnapshot, DecisionRule, EventAttentionFlag, ExcludedEventCandidate, PublicBeachEvent, SourceFacts } from "./types";
import { EVENT_STATUSES, EVENT_TYPES, IMPACT_LEVELS } from "./types";
import { normalizeDescription, resolveOfficialEventURL, sanitizeEventURL } from "./normalize";
import { BEACH_EVENT_PROVIDERS } from "./providers";
import { compareSourceFacts, eventSourceStatus, sourceRevision, stableHash } from "./sourceChanges";
import { classifyEventLocation } from "./location";
import { confirmationForAbsence, confirmationForObserved, eventCadencePolicy } from "./lifecycle";
import { persistSourceObservation } from "./observations";
import { selectDuplicateCandidates } from "./duplicates";

export const SNAPSHOT_KEY = "beach-events:v1:snapshot";
export const EVENT_PREFIX = "beach-events:v1:event:";
export const RULE_PREFIX = "beach-events:v1:rule:";
export const AUDIT_PREFIX = "beach-events:v1:audit:";
export const EXCLUSION_PREFIX = "beach-events:v1:excluded:";
export const STALE_WINDOW_MS = 12 * 60 * 60 * 1000;
export const AUTOMATED_AUDIT_RETENTION_SECONDS = 400 * 24 * 60 * 60;
const AUDIT_RECORD_MAX_BYTES = 12_000;

const safeText = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
const httpsURL = (value: unknown): value is string => safeText(value, 1000) && (() => { try { return new URL(value).protocol === "https:"; } catch { return false; } })();
const iso = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));

export const PUBLIC_BEACH_EVENT_FIELDS = ["id", "beachId", "title", "venue", "address", "startAt", "endAt", "displayFrom", "allDay", "recurring", "eventType", "impactLevel", "bannerTitle", "bannerMessage", "parkingImpact", "trafficImpact", "accessImpact", "showCompareNearbyBeaches", "sourceName", "summary", "eventDescription", "fullDescription", "officialEventURL", "registrationURL", "officialEventsPageURL", "organizerWebsiteURL", "sourceNote", "contactInformation", "sourceNewsletterMonth", "endTimeUnavailable", "locationClass", "updatedAt"] as const;

export function legacyImportedEventId(facts: Pick<SourceFacts, "providerId" | "externalId">): string {
	return `imported-${facts.providerId}-${encodeURIComponent(facts.externalId).slice(0, 120)}`;
}

function identityDigest(value: string): string {
	const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
	return seeds.map((seed) => {
		let hash = seed >>> 0;
		for (let index = 0; index < value.length; index += 1) {
			hash ^= value.charCodeAt(index);
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		return hash.toString(16).padStart(8, "0");
	}).join("");
}

export function importedEventId(facts: Pick<SourceFacts, "providerId" | "externalId">): string {
	const encoded = encodeURIComponent(facts.externalId);
	if (encoded.length <= 120) return legacyImportedEventId(facts);
	return `imported-${facts.providerId}-${encoded.slice(0, 64)}--${identityDigest(`${facts.providerId}\u0000${facts.externalId}`)}`;
}

export function auditLegacyEventIdentities(events: BeachEvent[]) {
	const records = events.filter((event) => event.sourceFacts?.providerId && event.sourceFacts?.externalId).map((event) => {
		const legacyId = legacyImportedEventId(event.sourceFacts);
		const preferredId = importedEventId(event.sourceFacts);
		return { eventId: event.id, providerId: event.sourceFacts.providerId, externalId: event.sourceFacts.externalId, legacyId, preferredId, status: event.id === legacyId && legacyId !== preferredId ? "legacyCompatible" as const : "current" as const };
	});
	const collisions = [...new Map(records.filter((record) => record.status === "legacyCompatible").map((record) => [record.legacyId, records.filter((candidate) => candidate.legacyId === record.legacyId && candidate.externalId !== record.externalId)])).entries()]
		.filter(([, candidates]) => candidates.length).map(([legacyId, candidates]) => ({ legacyId, eventIds: candidates.map((candidate) => candidate.eventId).sort() }));
	return { records, collisions };
}

const attention = (values: Array<EventAttentionFlag | undefined>) => [...new Set(values.filter((value): value is EventAttentionFlag => Boolean(value)))];
const publicPresentationChanged = (previous: BeachEvent, next: BeachEvent) => PUBLIC_BEACH_EVENT_FIELDS
	.filter((field) => field !== "updatedAt" && field !== "locationClass")
	.some((field) => JSON.stringify(previous[field] ?? null) !== JSON.stringify(next[field] ?? null))
	|| previous.location?.classification !== next.location?.classification;

export function suggestPresentation(title: string, description = ""): Pick<BeachEvent, "eventType" | "impactLevel" | "bannerTitle" | "bannerMessage" | "parkingImpact" | "trafficImpact" | "accessImpact" | "showCompareNearbyBeaches"> {
	const text = `${title} ${description}`.toLowerCase();
	const eventType = /clean ?up/.test(text) ? "beachCleanup" : /turtle|bird|wildlife|nature/.test(text) ? "wildlife" : /conservation|habitat/.test(text) ? "conservation" : /class|program|learn|education/.test(text) ? "educational" : /firework|fourth of july|holiday/.test(text) ? "fireworksOrHoliday" : /race|run|triathlon|volleyball|sport/.test(text) ? "raceOrSport" : /festival|concert/.test(text) ? "festival" : "community";
	const impactLevel = /festival|triathlon|marathon|firework|road closure|parking closure/.test(text) ? "high" : "informational";
	const disruptive = impactLevel === "high";
	const bannerTitle = eventType === "beachCleanup" ? "Beach cleanup here today" : eventType === "wildlife" ? "Wildlife program at this beach today" : disruptive ? "Large event at this beach today" : "Community event here today";
	return {
		eventType,
		impactLevel,
		bannerTitle,
		bannerMessage: disruptive ? "Parking and beach access may be affected." : "An activity is scheduled at this beach.",
		parkingImpact: disruptive,
		trafficImpact: disruptive,
		accessImpact: false,
		showCompareNearbyBeaches: disruptive,
	};
}

export function normalizedEvent(facts: SourceFacts, now: Date, override?: { beachId: string; ruleId: string; explanation: string; method?: BeachEvent["matchMethod"]; confidence?: BeachEvent["matchConfidence"] }): BeachEvent | null {
	const match = explainBeachMatch({ providerId: facts.providerId, venue: facts.venue, address: facts.address });
	if ((!match.beachId || !match.method) && !override) return null;
	const location = classifyEventLocation(facts, override?.beachId);
	const suggested = suggestPresentation(facts.title, facts.description);
	const provider = BEACH_EVENT_PROVIDERS.find((item) => item.id === facts.providerId);
	const normalized = normalizeDescription(facts.description, [facts.title, facts.venue, facts.address ?? "", facts.sourceName], facts.sourceURL);
	const sourceCalendarURL = httpsURL(facts.sourceURL) ? facts.sourceURL : undefined;
	const registrationURL = sanitizeEventURL(facts.registrationURL) ?? normalized.extractedURLs.find((url) => /register|registration|ticket|reserve|booking|signup|sign-up/i.test(url));
	const officialEventURL = resolveOfficialEventURL({ officialURL: facts.officialURL, extractedURLs: normalized.extractedURLs.filter((url) => url !== registrationURL) });
	const officialEventsPageURL = sanitizeEventURL(facts.officialEventsPageURL ?? provider?.officialEventsPageURL);
	const organizerWebsiteURL = sanitizeEventURL(facts.organizerWebsiteURL ?? provider?.organizerWebsiteURL);
	const sourceURL = sourceCalendarURL ?? facts.sourceURL;
	return {
		id: importedEventId(facts),
		beachId: override?.beachId ?? match.beachId!,
		title: facts.title,
		venue: facts.venue,
		address: facts.address,
		startAt: facts.startAt,
		endAt: facts.endAt,
		allDay: facts.allDay,
		recurring: facts.recurring,
		...suggested,
		status: "pendingReview",
		sourceName: facts.sourceName,
		sourceURL,
		...(facts.sourceNote ? { sourceNote: facts.sourceNote } : {}),
		...(normalized.summary ? { summary: normalized.summary } : {}),
		...(normalized.fullDescription ? { eventDescription: normalized.fullDescription, fullDescription: normalized.fullDescription } : {}),
		...(officialEventURL ? { officialEventURL } : {}),
		...(registrationURL ? { registrationURL } : {}),
		...(officialEventsPageURL ? { officialEventsPageURL } : {}),
		...(organizerWebsiteURL ? { organizerWebsiteURL } : {}),
		...(sourceCalendarURL ? { sourceCalendarURL } : {}),
		...(normalized.warnings.length ? { normalizationWarnings: normalized.warnings } : {}),
		...(facts.contactInformation ? { contactInformation: facts.contactInformation } : {}),
		...(facts.sourceNewsletterMonth ? { sourceNewsletterMonth: facts.sourceNewsletterMonth } : {}),
		...(facts.endTimeUnavailable ? { endTimeUnavailable: true } : {}),
		matchMethod: override?.method ?? (override ? "adminOverride" : match.method!),
		matchConfidence: override?.confidence ?? (override ? "admin" : "exact"),
		matchRuleId: override?.ruleId ?? match.ruleId,
		matchExplanation: override?.explanation ?? match.reason,
		location,
		...(override && !location.exactAssignmentSupported ? { locationReviewRequired: true } : {}),
		confirmation: { status: facts.sourceStatus === "cancelled" ? "cancelled" : facts.sourceStatus === "postponed" ? "postponed" : "confirmed", reason: facts.sourceStatus === "cancelled" ? "explicit_source_cancellation" : facts.sourceStatus === "postponed" ? "explicit_source_postponement" : "present_in_complete_observation", policyId: eventCadencePolicy(facts.providerId).id, lastConfirmedAt: now.toISOString(), successfulChecksAbsent: 0, lastCompleteObservationAt: now.toISOString(), observationCompleteness: "complete" },
		sourceFacts: facts,
		sourceRevision: sourceRevision(facts),
		lastSeenAt: now.toISOString(),
		...(normalized.warnings.length ? { attentionFlags: ["normalizationWarning"] } : {}),
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
	};
}

export async function listEvents(env: Pick<Env, "BEACH_DATA">): Promise<BeachEvent[]> {
	const listed = await env.BEACH_DATA.list({ prefix: EVENT_PREFIX, limit: 1000 });
	return (await Promise.all(listed.keys.map((key) => env.BEACH_DATA.get<BeachEvent>(key.name, "json")))).filter((item): item is BeachEvent => Boolean(item));
}

export async function listRules(env: Pick<Env, "BEACH_DATA">): Promise<DecisionRule[]> {
	const listed = await env.BEACH_DATA.list({ prefix: RULE_PREFIX, limit: 500 });
	return (await Promise.all(listed.keys.map((key) => env.BEACH_DATA.get<DecisionRule>(key.name, "json")))).filter((item): item is DecisionRule => Boolean(item));
}

export async function listExcludedCandidates(env: Pick<Env, "BEACH_DATA">): Promise<ExcludedEventCandidate[]> {
	const listed = await env.BEACH_DATA.list({ prefix: EXCLUSION_PREFIX, limit: 1000 });
	return (await Promise.all(listed.keys.map((key) => env.BEACH_DATA.get<ExcludedEventCandidate>(key.name, "json")))).filter((item): item is ExcludedEventCandidate => Boolean(item));
}

async function saveExclusion(env: Pick<Env, "BEACH_DATA">, fact: SourceFacts, reason: ExcludedEventCandidate["reason"], reasonDetail: string, ruleId: string, now: Date, options: { possibleDuplicateOf?: string; matchConfidence?: ExcludedEventCandidate["matchConfidence"] } = {}): Promise<void> {
	const id = `${fact.providerId}-${encodeURIComponent(fact.externalId).slice(0, 150)}`;
	const key = `${EXCLUSION_PREFIX}${id}`;
	const prior = await env.BEACH_DATA.get<ExcludedEventCandidate>(key, "json");
	const candidate: ExcludedEventCandidate = {
		id,
		providerId: fact.providerId,
		title: fact.title,
		venue: fact.venue,
		...(fact.address ? { address: fact.address } : {}),
		startAt: fact.startAt,
		endAt: fact.endAt,
		sourceName: fact.sourceName,
		sourceURL: fact.officialURL ?? fact.sourceURL,
		reason,
		reasonDetail,
		matchConfidence: options.matchConfidence ?? "none",
		...(options.possibleDuplicateOf ? { possibleDuplicateOf: options.possibleDuplicateOf } : {}),
		ruleId,
		decision: "automatic",
		sourceFacts: fact,
		location: classifyEventLocation(fact),
		firstSeenAt: prior?.firstSeenAt ?? now.toISOString(),
		lastSeenAt: now.toISOString(),
	};
	await env.BEACH_DATA.put(key, JSON.stringify(candidate), { expirationTtl: 90 * 24 * 60 * 60 });
}

const exclusionKey = (fact: SourceFacts) => `${EXCLUSION_PREFIX}${fact.providerId}-${encodeURIComponent(fact.externalId).slice(0, 150)}`;

export interface ApplyImportedEventsResult {
	discovered: number;
	newEvents: number;
	changed: number;
	unchanged: number;
	matched: number;
	excluded: number;
	pendingReview: number;
	ruleSuppressed: number;
	unsupportedOrAmbiguous: number;
	possibleDuplicates: number;
	warnings: number;
	restored: number;
}

const SOURCE_MANAGED_FIELDS: Array<keyof BeachEvent> = [
	"beachId", "title", "venue", "address", "startAt", "endAt", "allDay", "recurring", "sourceName", "sourceURL", "sourceNote",
	"eventDescription", "summary", "fullDescription", "officialEventURL", "registrationURL", "officialEventsPageURL", "organizerWebsiteURL",
	"sourceCalendarURL", "normalizationWarnings", "contactInformation", "sourceNewsletterMonth", "endTimeUnavailable", "matchMethod", "matchConfidence", "matchRuleId", "matchExplanation", "location", "locationReviewRequired",
	"identityCompatibility",
];
const ADMIN_OVERRIDABLE_SOURCE_FIELDS = new Set<keyof BeachEvent>(["beachId", "title", "venue", "address", "startAt", "endAt", "allDay", "summary", "fullDescription", "officialEventURL", "registrationURL", "officialEventsPageURL", "organizerWebsiteURL", "sourceName", "sourceURL"]);

function normalizedPrior(event: BeachEvent): BeachEvent | null {
	const override = event.matchMethod === "adminOverride"
		? { beachId: event.beachId, ruleId: event.matchRuleId ?? "admin-existing-assignment", explanation: event.matchExplanation ?? "Administrator assigned beach" }
		: undefined;
	return normalizedEvent(event.sourceFacts, new Date(event.createdAt), override);
}

function mergeSourceManagedFields(prior: BeachEvent, candidate: BeachEvent): { event: BeachEvent; manualOverrideFields: string[] } {
	const oldCandidate = normalizedPrior(prior);
	const overrides = new Set(prior.manualOverrideFields ?? []);
	if (oldCandidate) {
		for (const field of SOURCE_MANAGED_FIELDS) {
			if (ADMIN_OVERRIDABLE_SOURCE_FIELDS.has(field) && JSON.stringify(prior[field] ?? null) !== JSON.stringify(oldCandidate[field] ?? null)) overrides.add(field);
		}
	}
	if (prior.matchMethod === "adminOverride") for (const field of ["beachId", "matchMethod", "matchConfidence", "matchRuleId", "matchExplanation"] as const) overrides.add(field);
	const result = { ...prior } as unknown as Record<string, unknown>;
	for (const field of SOURCE_MANAGED_FIELDS) {
		if (overrides.has(field)) continue;
		if (candidate[field] === undefined) delete result[field];
		else result[field] = candidate[field];
	}
	return { event: result as unknown as BeachEvent, manualOverrideFields: [...overrides].sort() };
}

function reviewedStatus(status: BeachEvent["status"]): boolean {
	return status === "approved" || status === "scheduled" || status === "published";
}

export function eventNeedsReview(event: BeachEvent): boolean {
	return event.status === "pendingReview" || Boolean(event.attentionFlags?.length);
}

export async function applyImportedEvents(env: Pick<Env, "BEACH_DATA">, facts: SourceFacts[], now: Date, origin: "scheduled" | "admin" = "scheduled", auditIdGenerator?: EventAuditIdGenerator): Promise<ApplyImportedEventsResult> {
	const existing = await listEvents(env);
	const rules = await listRules(env);
	const existingById = new Map(existing.map((event) => [event.id, event]));
	const working = [...existing];
	let matched = 0, discovered = 0, changed = 0, unchanged = 0, excluded = 0, pendingReview = 0, ruleSuppressed = 0, unsupportedOrAmbiguous = 0, possibleDuplicates = 0, warnings = 0, restored = 0;
	for (const fact of facts) {
		const id = importedEventId(fact);
		const legacyId = legacyImportedEventId(fact);
		const legacyPrior = legacyId === id ? undefined : existingById.get(legacyId);
		const compatibleLegacy = legacyPrior?.sourceFacts?.providerId === fact.providerId && legacyPrior.sourceFacts.externalId === fact.externalId ? legacyPrior : undefined;
		const legacyCollision = Boolean(legacyPrior && !compatibleLegacy);
		const prior = existingById.get(id) ?? compatibleLegacy;
		if (!prior && Date.parse(fact.endAt) <= now.getTime()) {
			excluded += 1;
			await saveExclusion(env, fact, "expiredBeforeDiscovery", "Event ended before this discovery window", "expired-before-discovery", now);
			continue;
		}
		const explanation = explainBeachMatch({ providerId: fact.providerId, venue: fact.venue, address: fact.address });
		const aliasRule = rules.find((candidate) => candidate.enabled && candidate.action === "suggest" && candidate.providerId === fact.providerId && candidate.beachId && ((!candidate.venue || candidate.venue.toLowerCase() === fact.venue.toLowerCase()) && (!candidate.address || candidate.address.toLowerCase() === (fact.address ?? "").toLowerCase())));
		const priorOverride = prior?.matchMethod === "adminOverride"
			? { beachId: prior.beachId, ruleId: prior.matchRuleId ?? "admin-existing-assignment", explanation: prior.matchExplanation ?? "Administrator assigned beach" }
			: undefined;
		const fallbackOverride = prior && !explanation.beachId
			? { beachId: prior.beachId, ruleId: "source-location-no-longer-matches", explanation: explanation.reason, method: "ambiguousSourceChange" as const, confidence: "ambiguous" as const }
			: undefined;
		const ruleOverride = aliasRule?.beachId ? { beachId: aliasRule.beachId, ruleId: aliasRule.id, explanation: aliasRule.address ? "Exact administrator-approved address alias" : "Exact administrator-approved venue alias" } : undefined;
		const event = normalizedEvent(fact, now, priorOverride ?? ruleOverride ?? fallbackOverride);
		if (!event) {
			excluded += 1;
			unsupportedOrAmbiguous += 1;
			await saveExclusion(env, fact, explanation.exclusionReason ?? "unknownVenue", explanation.reason, explanation.ruleId, now);
			continue;
		}
		if (prior) event.id = prior.id;
		if (legacyCollision) {
			event.attentionFlags = attention([...(event.attentionFlags ?? []), "identityCompatibilityReview"]);
			event.identityCompatibility = { status: "legacyCollision", legacyId, preferredId: id };
		} else if (compatibleLegacy) {
			event.identityCompatibility = { status: "legacyCompatible", legacyId, preferredId: id };
		}
		if (explanation.beachId || priorOverride || ruleOverride) matched += 1;
		await env.BEACH_DATA.delete(exclusionKey(fact));
		if (prior) {
			const diff = compareSourceFacts(prior.sourceFacts, fact);
			const priorRevision = prior.sourceRevision ?? sourceRevision(prior.sourceFacts);
			const currentRevision = sourceRevision(fact);
			const wasMissing = Boolean(prior.sourceMissingCount || prior.sourceRemovedAt);
			const wasRemoved = Boolean(prior.sourceRemovedAt);
			if (!diff.changedFields.length && !wasMissing) {
				const next = { ...prior, sourceFacts: fact, sourceRevision: currentRevision, lastSeenAt: now.toISOString(), confirmation: confirmationForObserved(prior, fact.providerId, now) };
				await env.BEACH_DATA.put(`${EVENT_PREFIX}${event.id}`, JSON.stringify(next));
				await persistSourceObservation(env, { providerId: fact.providerId, observedAt: now.toISOString(), sourceRevision: currentRevision, facts: fact, completeness: "complete", confirmationOutcome: next.confirmation.status, severity: "cosmetic", materialFields: [], cosmeticFields: [], sourceReference: fact.officialURL ?? fact.sourceURL, approvedRevision: prior.reviewedSourceRevision });
				unchanged += 1;
				continue;
			}
			const merged = mergeSourceManagedFields(prior, event);
			const noLongerMatches = !explanation.beachId && !priorOverride && !ruleOverride;
			const locationConflict = Boolean(event.locationReviewRequired);
			const unresolvedChange = prior.attentionFlags?.includes("materialSourceChange") ? prior.sourceChange : undefined;
			const materialFields = [...new Set([...(unresolvedChange?.materialFields ?? []), ...diff.materialFields, ...(noLongerMatches ? ["beachId"] : []), ...(locationConflict ? ["location"] : []), ...(wasRemoved ? ["sourcePresence"] : [])])];
			const statusFromSource = eventSourceStatus(fact);
			const isMaterial = materialFields.length > 0 || Boolean(statusFromSource) || wasRemoved || Boolean(unresolvedChange);
			let status = prior.status;
			if (statusFromSource === "cancelled") status = "cancelled";
			else if (Date.parse(fact.endAt) <= now.getTime()) status = "expired";
			else if (isMaterial && (reviewedStatus(prior.status) || prior.status === "cancelled" || prior.status === "hidden")) status = "pendingReview";
			const retainedFlags = (prior.attentionFlags ?? []).filter((flag) => flag === "possibleDuplicate" || flag === "materialSourceChange" || flag === "sourceRestored");
			const materialReviewRequired = isMaterial && (
				reviewedStatus(prior.status)
				|| prior.status === "cancelled"
				|| prior.status === "hidden"
				|| prior.attentionFlags?.includes("materialSourceChange")
			);
			const flags = attention([
				...retainedFlags,
				event.normalizationWarnings?.length ? "normalizationWarning" : undefined,
				noLongerMatches || locationConflict ? "ambiguousMatch" : undefined,
				statusFromSource === "cancelled" ? "sourceCancelled" : undefined,
				statusFromSource === "postponed" ? "sourcePostponed" : undefined,
				materialReviewRequired ? "materialSourceChange" : undefined,
				wasRemoved ? "sourceRestored" : undefined,
			]);
			const presentationChanged = publicPresentationChanged(prior, merged.event);
			const next: BeachEvent = {
				...merged.event,
				status,
				sourceFacts: fact,
				sourceRevision: currentRevision,
				lastSeenAt: now.toISOString(),
				confirmation: statusFromSource === "cancelled"
					? { ...confirmationForObserved(prior, fact.providerId, now, "explicit_source_cancellation"), status: "cancelled" }
					: statusFromSource === "postponed"
						? { ...confirmationForObserved(prior, fact.providerId, now, "explicit_source_postponement"), status: "postponed" }
						: confirmationForObserved(prior, fact.providerId, now, wasMissing ? "restored_after_absence" : "present_in_complete_observation"),
				manualOverrideFields: merged.manualOverrideFields,
				...(flags.length ? { attentionFlags: flags } : { attentionFlags: undefined }),
				...(isMaterial ? { sourceChange: {
					detectedAt: unresolvedChange?.detectedAt ?? now.toISOString(),
					previousRevision: unresolvedChange?.previousRevision ?? priorRevision,
					currentRevision,
					materialFields,
					cosmeticFields: [...new Set([...(unresolvedChange?.cosmeticFields ?? []), ...diff.cosmeticFields])].filter((field) => !materialFields.includes(field)),
					previousStatus: unresolvedChange?.previousStatus ?? prior.status,
					previous: unresolvedChange?.previous ?? prior.sourceFacts,
					current: fact,
					severity: locationConflict || statusFromSource ? "critical" : diff.severity,
					explanations: [...diff.explanations, ...(locationConflict ? ["Loss of valid exact-beach evidence"] : [])],
					observedAt: now.toISOString(),
				} } : {}),
				...(!isMaterial && reviewedStatus(prior.status) ? { reviewedSourceRevision: currentRevision } : {}),
				updatedAt: presentationChanged || status !== prior.status ? now.toISOString() : prior.updatedAt,
			};
			delete next.sourceMissingSince;
			delete next.sourceMissingCount;
			delete next.sourceRemovedAt;
			if (!isMaterial) delete next.sourceChange;
			await env.BEACH_DATA.put(`${EVENT_PREFIX}${event.id}`, JSON.stringify(next));
			await persistSourceObservation(env, { providerId: fact.providerId, observedAt: now.toISOString(), sourceRevision: currentRevision, facts: fact, completeness: "complete", confirmationOutcome: next.confirmation?.status ?? "confirmed", severity: locationConflict || statusFromSource ? "critical" : diff.severity, materialFields, cosmeticFields: diff.cosmeticFields, sourceReference: fact.officialURL ?? fact.sourceURL, approvedRevision: prior.reviewedSourceRevision });
			await auditAutomated(env, origin, wasRemoved ? "source_event_restored" : isMaterial ? "source_event_changed" : wasMissing ? "source_event_restored" : "source_event_cosmetic_change", event.id, {
				previousSourceFacts: prior.sourceFacts,
				nextSourceFacts: fact,
				materialFields,
				cosmeticFields: diff.cosmeticFields,
			}, now, { previousState: prior.status, newState: next.status, changedFields: [...new Set([...diff.changedFields, ...(wasMissing ? ["sourcePresence"] : [])])], sourceRevision: currentRevision, publicOutputAffected: (presentationChanged && (prior.status === "published" || next.status === "published")) || (prior.status !== next.status && (prior.status === "published" || next.status === "published")), reason: wasRemoved ? "source_restored_after_confirmed_removal" : wasMissing ? "source_restored_after_transient_absence" : undefined }, auditIdGenerator);
			changed += 1;
			warnings += flags.length;
			if (wasMissing) restored += 1;
			existingById.set(event.id, next);
			const index = working.findIndex((item) => item.id === event.id);
			if (index >= 0) working[index] = next;
			continue;
		}
		const duplicateAssessments = selectDuplicateCandidates(event, working).candidates;
		const duplicate = duplicateAssessments[0];
		if (duplicate) possibleDuplicates += 1;
		const rule = rules.find((candidate) => candidate.enabled && candidate.providerId === fact.providerId && (!candidate.venue || candidate.venue.toLowerCase() === fact.venue.toLowerCase()) && (!candidate.titlePattern || fact.title.toLowerCase().includes(candidate.titlePattern.toLowerCase())) && (!candidate.beachId || candidate.beachId === event.beachId));
		const sourceStatus = eventSourceStatus(fact);
		const status = sourceStatus === "cancelled" ? "cancelled" : rule?.action === "disregard" ? "disregarded" : rule?.action === "autoApprove" && event.matchConfidence === "exact" ? "approved" : "pendingReview";
		if (status === "pendingReview" || duplicate) pendingReview += 1;
		if (status === "disregarded") ruleSuppressed += 1;
		const flags = attention([...(event.attentionFlags ?? []), duplicate ? "possibleDuplicate" : undefined, sourceStatus === "cancelled" ? "sourceCancelled" : sourceStatus === "postponed" ? "sourcePostponed" : undefined]);
		const next = { ...event, status: duplicate ? "pendingReview" as const : status, ...(reviewedStatus(status) && !duplicate ? { reviewedSourceRevision: event.sourceRevision } : {}), ...(flags.length ? { attentionFlags: flags } : {}), ...(duplicate ? { possibleDuplicateOf: duplicate.candidate.id, duplicateAssessment: duplicate.assessment } : {}), ...(rule?.eventType ? { eventType: rule.eventType } : {}), ...(rule?.impactLevel ? { impactLevel: rule.impactLevel } : {}) } as BeachEvent;
		await env.BEACH_DATA.put(`${EVENT_PREFIX}${event.id}`, JSON.stringify(next));
		await persistSourceObservation(env, { providerId: fact.providerId, observedAt: now.toISOString(), sourceRevision: event.sourceRevision, facts: fact, completeness: "complete", confirmationOutcome: event.confirmation?.status ?? "confirmed", severity: "material", materialFields: Object.keys(fact), cosmeticFields: [], sourceReference: fact.officialURL ?? fact.sourceURL, approvedRevision: next.reviewedSourceRevision });
		await auditAutomated(env, origin, "discover_source_event", event.id, { sourceFacts: fact }, now, { previousState: null, newState: status, changedFields: Object.keys(fact), sourceRevision: event.sourceRevision, publicOutputAffected: false }, auditIdGenerator);
		existingById.set(event.id, next);
		working.push(next);
		warnings += flags.length;
		discovered += 1;
	}
	return { discovered, newEvents: discovered, changed, unchanged, matched, excluded, pendingReview, ruleSuppressed, unsupportedOrAmbiguous, possibleDuplicates, warnings, restored };
}

export async function reconcileProviderSource(
	env: Pick<Env, "BEACH_DATA">,
	providerId: string,
	seenExternalIds: ReadonlySet<string>,
	now: Date,
	origin: "scheduled" | "admin" = "scheduled",
	auditIdGenerator?: EventAuditIdGenerator,
): Promise<{ missingFromSource: number; newlyRemoved: number }> {
	const events = (await listEvents(env)).filter((event) =>
		event.sourceFacts?.providerId === providerId
		&& event.sourceFacts.providerId !== "manual"
		&& Date.parse(event.endAt) > now.getTime()
		&& event.status !== "expired"
		&& event.status !== "disregarded");
	let missingFromSource = 0, newlyRemoved = 0;
	for (const event of events) {
		if (seenExternalIds.has(event.sourceFacts.externalId)) continue;
		const policy = eventCadencePolicy(providerId);
		if (!policy.automatedAbsence) continue;
		missingFromSource += 1;
		// A confirmed removal is already a stable actionable condition. Avoid
		// rewriting its timestamp, source diff, and audit record on every poll.
		if (event.sourceRemovedAt) continue;
		const confirmation = confirmationForAbsence(event, providerId, now);
		const missingCount = confirmation.successfulChecksAbsent;
		const confirmedRemoved = confirmation.status === "sourceRemoved";
		const suspected = confirmation.status === "suspectedMissing";
		const flags = attention([...(event.attentionFlags ?? []).filter((flag) => flag !== "sourceMissing" && flag !== "sourceRemoved"), confirmedRemoved ? "sourceRemoved" : suspected ? "sourceMissing" : undefined]);
		let status = event.status;
		if (confirmedRemoved && reviewedStatus(status)) status = "pendingReview";
		const revision = event.sourceRevision ?? sourceRevision(event.sourceFacts);
		const unresolvedChange = event.attentionFlags?.includes("materialSourceChange") ? event.sourceChange : undefined;
		const next: BeachEvent = {
			...event,
			status,
			sourceRevision: revision,
			sourceMissingSince: event.sourceMissingSince ?? now.toISOString(),
			sourceMissingCount: missingCount,
			attentionFlags: flags,
			confirmation,
			...(confirmedRemoved ? {
				sourceRemovedAt: event.sourceRemovedAt ?? now.toISOString(),
				sourceChange: {
					detectedAt: unresolvedChange?.detectedAt ?? now.toISOString(),
					previousRevision: unresolvedChange?.previousRevision ?? revision,
					currentRevision: revision,
					materialFields: [...new Set([...(unresolvedChange?.materialFields ?? []), "sourcePresence"])],
					cosmeticFields: unresolvedChange?.cosmeticFields ?? [],
					previousStatus: unresolvedChange?.previousStatus ?? event.status,
					previous: unresolvedChange?.previous ?? event.sourceFacts,
					current: null,
				},
				updatedAt: now.toISOString(),
			} : {}),
		};
		await env.BEACH_DATA.put(`${EVENT_PREFIX}${event.id}`, JSON.stringify(next));
		await persistSourceObservation(env, { providerId, observedAt: now.toISOString(), sourceRevision: revision, facts: event.sourceFacts, completeness: "complete", confirmationOutcome: confirmation.status, severity: confirmedRemoved ? "critical" : suspected ? "material" : "informational", materialFields: confirmedRemoved ? ["sourcePresence"] : [], cosmeticFields: [], sourceReference: event.sourceFacts.officialURL ?? event.sourceFacts.sourceURL, approvedRevision: event.reviewedSourceRevision });
		await auditAutomated(env, origin, confirmedRemoved ? "source_event_removed" : "source_event_missing", event.id, { missingCount, sourceFacts: event.sourceFacts }, now, {
			previousState: event.status,
			newState: next.status,
			changedFields: confirmedRemoved ? ["sourcePresence", ...(event.status !== next.status ? ["status"] : [])] : ["sourcePresence"],
			sourceRevision: revision,
			publicOutputAffected: confirmedRemoved && event.status === "published",
			reason: confirmation.reason,
		}, auditIdGenerator);
		if (confirmedRemoved && !event.sourceRemovedAt) newlyRemoved += 1;
	}
	return { missingFromSource, newlyRemoved };
}

export async function confirmProviderUnchanged(env: Pick<Env, "BEACH_DATA">, providerId: string, now: Date): Promise<number> {
	const events = (await listEvents(env)).filter((event) => event.sourceFacts.providerId === providerId && !event.archivedAt);
	for (const event of events) {
		const confirmation = event.confirmation
			? {
				...event.confirmation,
				reason: "http_304_confirmed_unchanged_no_absence_evidence",
				...(event.confirmation.status === "confirmed" ? { lastConfirmedAt: now.toISOString() } : {}),
				lastCompleteObservationAt: now.toISOString(),
				observationCompleteness: "confirmedUnchanged" as const,
			}
			: { ...confirmationForObserved(event, providerId, now, "http_304_confirmed_unchanged"), observationCompleteness: "confirmedUnchanged" as const };
		await env.BEACH_DATA.put(`${EVENT_PREFIX}${event.id}`, JSON.stringify({ ...event, confirmation }));
		await persistSourceObservation(env, { providerId, observedAt: now.toISOString(), sourceRevision: event.sourceRevision ?? sourceRevision(event.sourceFacts), facts: event.sourceFacts, completeness: "confirmedUnchanged", confirmationOutcome: confirmation.status, severity: "cosmetic", materialFields: [], cosmeticFields: [], sourceReference: event.sourceFacts.officialURL ?? event.sourceFacts.sourceURL, approvedRevision: event.reviewedSourceRevision });
	}
	return events.length;
}

function centralDayOrdinal(value: Date): number {
	const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" })
		.formatToParts(value).reduce<Record<string, number>>((result, part) => {
			if (part.type === "year" || part.type === "month" || part.type === "day") result[part.type] = Number(part.value);
			return result;
		}, {});
	return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000);
}

function centralDateParts(value: Date): { year: number; month: number; day: number } {
	const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" })
		.formatToParts(value).reduce<Record<string, number>>((result, part) => {
			if (part.type === "year" || part.type === "month" || part.type === "day") result[part.type] = Number(part.value);
			return result;
		}, {});
	return { year: parts.year, month: parts.month, day: parts.day };
}

function centralMidnightUtc(year: number, month: number, day: number): Date {
	const target = Date.UTC(year, month - 1, day);
	let guess = target;
	const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const represented = Object.fromEntries(formatter.formatToParts(new Date(guess)).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
		const delta = target - Date.UTC(represented.year, represented.month - 1, represented.day, represented.hour, represented.minute, represented.second);
		guess += delta;
		if (!delta) break;
	}
	return new Date(guess);
}

export function effectiveEventEnd(event: Pick<BeachEvent, "startAt" | "endAt" | "allDay" | "endTimeUnavailable">): Date {
	if (!event.endTimeUnavailable) return new Date(event.endAt);
	const startDay = centralDateParts(new Date(event.startAt));
	const following = new Date(Date.UTC(startDay.year, startDay.month - 1, startDay.day + 1));
	return centralMidnightUtc(following.getUTCFullYear(), following.getUTCMonth() + 1, following.getUTCDate());
}

export function isEventCompleted(event: Pick<BeachEvent, "startAt" | "endAt" | "allDay" | "endTimeUnavailable" | "sourceFacts" | "attentionFlags">, now: Date): boolean {
	if (event.sourceFacts?.sourceStatus === "postponed" || event.attentionFlags?.includes("sourcePostponed")) return false;
	return effectiveEventEnd(event).getTime() <= now.getTime();
}

export function isEventVisibleNow(event: Pick<BeachEvent, "status" | "startAt" | "endAt" | "allDay" | "endTimeUnavailable" | "displayFrom" | "impactLevel">, now: Date): boolean {
	if (event.status !== "published" || effectiveEventEnd(event).getTime() <= now.getTime()) return false;
	if (event.displayFrom && Date.parse(event.displayFrom) <= now.getTime()) return true;
	const today = centralDayOrdinal(now);
	const firstDay = centralDayOrdinal(new Date(event.startAt));
	const lastDay = centralDayOrdinal(new Date(Date.parse(event.endAt) - 1));
	if (firstDay <= today && lastDay >= today) return true;
	return ["high", "major"].includes(event.impactLevel) && firstDay <= today + 1 && lastDay >= today + 1;
}

export function serializePublicEvent(event: BeachEvent): PublicBeachEvent {
	return {
		id: event.id,
		beachId: event.beachId,
		title: event.title,
		venue: event.venue,
		...(event.address ? { address: event.address } : {}),
		startAt: event.startAt,
		endAt: event.endAt,
		...(event.displayFrom ? { displayFrom: event.displayFrom } : {}),
		allDay: event.allDay,
		recurring: event.recurring,
		eventType: event.eventType,
		impactLevel: event.impactLevel,
		bannerTitle: event.bannerTitle,
		bannerMessage: event.bannerMessage,
		parkingImpact: event.parkingImpact,
		trafficImpact: event.trafficImpact,
		accessImpact: event.accessImpact,
		showCompareNearbyBeaches: event.showCompareNearbyBeaches,
		sourceName: event.sourceName,
		...(event.summary ? { summary: event.summary } : {}),
		...(event.fullDescription ?? event.eventDescription ? { eventDescription: event.fullDescription ?? event.eventDescription, fullDescription: event.fullDescription ?? event.eventDescription } : {}),
		...(event.officialEventURL ? { officialEventURL: event.officialEventURL } : {}),
		...(event.registrationURL ? { registrationURL: event.registrationURL } : {}),
		...(event.officialEventsPageURL ? { officialEventsPageURL: event.officialEventsPageURL } : {}),
		...(event.organizerWebsiteURL ? { organizerWebsiteURL: event.organizerWebsiteURL } : {}),
		...(event.sourceNote ? { sourceNote: event.sourceNote } : {}),
		...(event.contactInformation ? { contactInformation: event.contactInformation } : {}),
		...(event.sourceNewsletterMonth ? { sourceNewsletterMonth: event.sourceNewsletterMonth } : {}),
		...(event.endTimeUnavailable ? { endTimeUnavailable: true } : {}),
		...(event.location ? { locationClass: event.location.classification } : {}),
		updatedAt: event.updatedAt,
	};
}

export function buildSnapshot(events: BeachEvent[], now: Date, lastSuccessfulRefresh = now): BeachEventsSnapshot {
	const beaches: Record<string, PublicBeachEvent[]> = {};
	const visible = events.filter((event) => event.status === "published" && effectiveEventEnd(event).getTime() > now.getTime());
	for (const event of visible) {
		(beaches[event.beachId] ??= []).push(serializePublicEvent(event));
	}
	for (const items of Object.values(beaches)) items.sort((a, b) => a.startAt.localeCompare(b.startAt));
	const attribution = [...new Map(visible.map((event) => [event.sourceFacts.providerId, { providerId: event.sourceFacts.providerId, sourceName: event.sourceName, sourceURL: event.officialEventURL ?? event.officialEventsPageURL ?? event.organizerWebsiteURL ?? "" }])).values()].filter((item) => item.sourceURL).sort((a, b) => a.providerId.localeCompare(b.providerId));
	const revision = stableHash(JSON.stringify({ attribution, beaches }));
	return { schemaVersion: 1, revision, status: "ok", generatedAt: now.toISOString(), lastSuccessfulRefresh: lastSuccessfulRefresh.toISOString(), staleUntil: new Date(now.getTime() + STALE_WINDOW_MS).toISOString(), attribution, beaches };
}

export async function archiveCompletedEvents(env: Pick<Env, "BEACH_DATA">, now = new Date(), origin: "scheduled" | "admin" = "scheduled", auditIdGenerator?: EventAuditIdGenerator): Promise<{ scanned: number; archived: number }> {
	const events = await listEvents(env);
	let archived = 0;
	for (const event of events) {
		if (event.status !== "published" || !isEventCompleted(event, now)) continue;
		const timestamp = now.toISOString();
		const next: BeachEvent = { ...event, status: "completed", completedAt: timestamp, archivedAt: timestamp, priorPublicationStatus: "published", updatedAt: timestamp, confirmation: { ...(event.confirmation ?? { reason: "effective_end_passed", policyId: eventCadencePolicy(event.sourceFacts.providerId).id, successfulChecksAbsent: 0 }), status: "archived", reason: "effective_end_passed" } };
		await env.BEACH_DATA.put(`${EVENT_PREFIX}${event.id}`, JSON.stringify(next));
		await auditAutomated(env, origin, "complete_and_archive_event", event.id, { effectiveEndAt: effectiveEventEnd(event).toISOString(), completedAt: timestamp, archivedAt: timestamp }, now, { previousState: "published", newState: "completed", changedFields: ["status", "completedAt", "archivedAt", "priorPublicationStatus"], sourceRevision: event.sourceRevision ?? sourceRevision(event.sourceFacts), publicOutputAffected: true, reason: "effective_end_passed" }, auditIdGenerator);
		archived += 1;
	}
	return { scanned: events.length, archived };
}

export async function saveSnapshot(env: Pick<Env, "BEACH_DATA">, now: Date, options: { sourceRefresh?: boolean } = {}): Promise<BeachEventsSnapshot> {
	const prior = options.sourceRefresh ? null : await env.BEACH_DATA.get<BeachEventsSnapshot>(SNAPSHOT_KEY, "json");
	const lastSuccessfulRefresh = prior?.lastSuccessfulRefresh && !Number.isNaN(Date.parse(prior.lastSuccessfulRefresh))
		? new Date(prior.lastSuccessfulRefresh)
		: now;
	const snapshot = buildSnapshot(await listEvents(env), now, lastSuccessfulRefresh);
	await env.BEACH_DATA.put(SNAPSHOT_KEY, JSON.stringify(snapshot));
	return snapshot;
}

export async function renormalizeExistingEvents(env: Pick<Env, "BEACH_DATA">, now = new Date(), dryRun = false): Promise<{ scanned: number; changed: number; unchanged: number; skipped: number; failed: number; warnings: number }> {
	const events = await listEvents(env);
	let changed = 0, unchanged = 0, skipped = 0, failed = 0, warnings = 0;
	for (const event of events) {
		try {
			if (!event.sourceFacts) { skipped += 1; continue; }
			const normalized = normalizeDescription(event.sourceFacts.description ?? event.fullDescription ?? event.eventDescription, [event.title, event.venue, event.address ?? ""], event.sourceFacts.sourceURL);
			const provider = BEACH_EVENT_PROVIDERS.find((item) => item.id === event.sourceFacts.providerId);
			const registrationURL = event.registrationURL ?? sanitizeEventURL(event.sourceFacts.registrationURL) ?? normalized.extractedURLs.find((url) => /register|registration|ticket|reserve|booking|signup|sign-up/i.test(url));
			const officialEventURL = event.officialEventURL ?? resolveOfficialEventURL({ officialURL: event.sourceFacts.officialURL, extractedURLs: normalized.extractedURLs.filter((url) => url !== registrationURL) });
			const candidate = { ...event, ...(normalized.summary ? { summary: normalized.summary } : {}), ...(normalized.fullDescription ? { eventDescription: normalized.fullDescription, fullDescription: normalized.fullDescription } : {}), ...(officialEventURL ? { officialEventURL } : {}), ...(registrationURL ? { registrationURL } : {}), ...(provider?.officialEventsPageURL ? { officialEventsPageURL: provider.officialEventsPageURL } : {}), ...(provider?.organizerWebsiteURL ? { organizerWebsiteURL: provider.organizerWebsiteURL } : {}), sourceCalendarURL: event.sourceFacts.sourceURL, normalizationWarnings: normalized.warnings, sourceRevision: event.sourceRevision ?? sourceRevision(event.sourceFacts), lastSeenAt: event.lastSeenAt ?? event.updatedAt };
			warnings += normalized.warnings.length + (officialEventURL || candidate.officialEventsPageURL || candidate.organizerWebsiteURL ? 0 : 1);
			if (JSON.stringify(candidate) === JSON.stringify(event)) { unchanged += 1; continue; }
			changed += 1;
			if (!dryRun) await env.BEACH_DATA.put(`${EVENT_PREFIX}${event.id}`, JSON.stringify({ ...candidate, updatedAt: now.toISOString() }));
		} catch { failed += 1; }
	}
	return { scanned: events.length, changed, unchanged, skipped, failed, warnings };
}

export function validateManualEvent(input: Record<string, unknown>, now = new Date()): string[] {
	const errors: string[] = [];
	if (!safeText(input.title, 160)) errors.push("title");
	if (!safeText(input.beachId, 80)) errors.push("beachId");
	if (!safeText(input.venue, 200)) errors.push("venue");
	if (!iso(input.startAt) || !iso(input.endAt) || (iso(input.startAt) && iso(input.endAt) && Date.parse(input.endAt) <= Date.parse(input.startAt))) errors.push("dates");
	if (!EVENT_TYPES.includes(input.eventType as never)) errors.push("eventType");
	if (!IMPACT_LEVELS.includes(input.impactLevel as never)) errors.push("impactLevel");
	if (!EVENT_STATUSES.includes(input.status as never)) errors.push("status");
	if (!safeText(input.sourceName, 160)) errors.push("sourceName");
	if (!httpsURL(input.sourceURL)) errors.push("sourceURL");
	if (!safeText(input.bannerTitle, 100) || !safeText(input.bannerMessage, 300)) errors.push("banner");
	if (iso(input.endAt) && Date.parse(input.endAt) <= now.getTime() && input.status === "published") errors.push("expired");
	if (iso(input.endAt) && Date.parse(input.endAt) > now.getTime() && input.status === "expired") errors.push("status");
	return [...new Set(errors)];
}

export interface EventAuditContext {
	previousState?: BeachEvent["status"] | null;
	newState?: BeachEvent["status"] | null;
	changedFields?: string[];
	sourceRevision?: string;
	origin?: "manual" | "automated";
	publicOutputAffected?: boolean;
	reason?: string;
}

export interface EventAuditIdInput { timestamp: string; action: string; targetId: string; sourceRevision: string | null }
export type EventAuditIdGenerator = (input: EventAuditIdInput) => string | Promise<string>;

async function writeEventAudit(env: Pick<Env, "BEACH_DATA">, actor: string, authenticationMethod: string, action: string, targetId: string, changes: unknown, now: Date, context: EventAuditContext, auditIdGenerator?: EventAuditIdGenerator): Promise<void> {
	const clean = (value: unknown, depth = 0): unknown => {
		if (depth > 3) return "[truncated]";
		if (typeof value === "string") {
			const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]").replace(/([?&](?:token|key|secret|auth|signature|code)=)[^&#\s]+/gi, "$1[redacted]").replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[redacted-authorization]").replace(/\s+/g, " ").trim();
			return text.slice(0, 500);
		}
		if (Array.isArray(value)) return value.slice(0, 40).map((item) => clean(item, depth + 1));
		if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !/description|contactInformation|sourceFacts|body/i.test(key)).slice(0, 40).map(([key, item]) => [key.slice(0, 80), clean(item, depth + 1)]));
		return typeof value === "number" || typeof value === "boolean" || value === null ? value : undefined;
	};
	const auditId = auditIdGenerator ? await auditIdGenerator({ timestamp: now.toISOString(), action, targetId, sourceRevision: context.sourceRevision ?? null }) : crypto.randomUUID();
	if (!/^[a-zA-Z0-9_-]{1,128}$/.test(auditId)) throw new Error("invalid_event_audit_id");
	const record = {
		schemaVersion: 1,
		id: auditId,
		timestamp: now.toISOString(),
		actor: actor.slice(0, 200),
		authenticationMethod,
		action,
		targetId,
		changes: clean(changes),
		previousState: context.previousState ?? null,
		newState: context.newState ?? null,
		changedFields: (context.changedFields ?? []).slice(0, 40).map((field) => String(clean(field)).slice(0, 80)),
		sourceRevision: context.sourceRevision ?? null,
		origin: context.origin ?? "manual",
		publicOutputAffected: context.publicOutputAffected ?? false,
		...(context.reason ? { reason: context.reason } : {}),
	};
	let serialized = JSON.stringify(record);
	if (new TextEncoder().encode(serialized).byteLength > AUDIT_RECORD_MAX_BYTES) serialized = JSON.stringify({ ...record, changes: { summary: "Audit detail exceeded storage bound", truncated: true } });
	await env.BEACH_DATA.put(`${AUDIT_PREFIX}${record.timestamp}:${record.id}`, serialized, context.origin === "automated" ? { expirationTtl: AUTOMATED_AUDIT_RETENTION_SECONDS } : undefined);
}

export async function audit(env: Pick<Env, "BEACH_DATA">, identity: AdminIdentity, action: string, targetId: string, changes: unknown, now = new Date(), context: EventAuditContext = {}): Promise<void> {
	await writeEventAudit(env, identity.subject, identity.method, action, targetId, changes, now, { ...context, origin: context.origin ?? "manual" });
}

export async function auditAutomated(env: Pick<Env, "BEACH_DATA">, trigger: "scheduled" | "admin", action: string, targetId: string, changes: unknown, now = new Date(), context: EventAuditContext = {}, auditIdGenerator?: EventAuditIdGenerator): Promise<void> {
	await writeEventAudit(env, "system-beach-events", trigger, action, targetId, changes, now, { ...context, origin: "automated" }, auditIdGenerator);
}
