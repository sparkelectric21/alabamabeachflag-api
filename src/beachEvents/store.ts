import type { AdminIdentity } from "../services/admin/auth";
import type { Env } from "../types";
import { dedupeKey, explainBeachMatch } from "./matching";
import type { BeachEvent, BeachEventsSnapshot, DecisionRule, ExcludedEventCandidate, SourceFacts } from "./types";
import { EVENT_STATUSES, EVENT_TYPES, IMPACT_LEVELS } from "./types";
import { normalizeDescription, resolveOfficialEventURL, sanitizeEventURL } from "./normalize";
import { BEACH_EVENT_PROVIDERS } from "./providers";

export const SNAPSHOT_KEY = "beach-events:v1:snapshot";
export const EVENT_PREFIX = "beach-events:v1:event:";
export const RULE_PREFIX = "beach-events:v1:rule:";
export const AUDIT_PREFIX = "beach-events:v1:audit:";
export const EXCLUSION_PREFIX = "beach-events:v1:excluded:";
export const STALE_WINDOW_MS = 12 * 60 * 60 * 1000;

const safeText = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
const httpsURL = (value: unknown): value is string => safeText(value, 1000) && (() => { try { return new URL(value).protocol === "https:"; } catch { return false; } })();
const iso = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));

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

export function normalizedEvent(facts: SourceFacts, now: Date, override?: { beachId: string; ruleId: string; explanation: string }): BeachEvent | null {
	const match = explainBeachMatch({ providerId: facts.providerId, venue: facts.venue, address: facts.address });
	if ((!match.beachId || !match.method) && !override) return null;
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
		id: `imported-${facts.providerId}-${encodeURIComponent(facts.externalId).slice(0, 120)}`,
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
		matchMethod: override ? "adminOverride" : match.method!,
		matchConfidence: override ? "admin" : "exact",
		matchRuleId: override?.ruleId ?? match.ruleId,
		matchExplanation: override?.explanation ?? match.reason,
		sourceFacts: facts,
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

async function saveExclusion(env: Pick<Env, "BEACH_DATA">, fact: SourceFacts, reason: ExcludedEventCandidate["reason"], reasonDetail: string, ruleId: string, now: Date): Promise<void> {
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
		matchConfidence: "none",
		ruleId,
		decision: "automatic",
		sourceFacts: fact,
		firstSeenAt: prior?.firstSeenAt ?? now.toISOString(),
		lastSeenAt: now.toISOString(),
	};
	await env.BEACH_DATA.put(key, JSON.stringify(candidate), { expirationTtl: 90 * 24 * 60 * 60 });
}

const exclusionKey = (fact: SourceFacts) => `${EXCLUSION_PREFIX}${fact.providerId}-${encodeURIComponent(fact.externalId).slice(0, 150)}`;

export async function applyImportedEvents(env: Pick<Env, "BEACH_DATA">, facts: SourceFacts[], now: Date): Promise<{ discovered: number; matched: number; excluded: number; pendingReview: number; ruleSuppressed: number; unsupportedOrAmbiguous: number }> {
	const existing = await listEvents(env);
	const rules = await listRules(env);
	const existingById = new Map(existing.map((event) => [event.id, event]));
	const existingDedupe = new Set(existing.map(dedupeKey));
	let matched = 0, discovered = 0, excluded = 0, pendingReview = 0, ruleSuppressed = 0, unsupportedOrAmbiguous = 0;
	for (const fact of facts) {
		if (Date.parse(fact.endAt) <= now.getTime()) {
			excluded += 1;
			await saveExclusion(env, fact, "expiredBeforeDiscovery", "Event ended before this discovery window", "expired-before-discovery", now);
			continue;
		}
		const explanation = explainBeachMatch({ providerId: fact.providerId, venue: fact.venue, address: fact.address });
		const aliasRule = rules.find((candidate) => candidate.enabled && candidate.action === "suggest" && candidate.providerId === fact.providerId && candidate.beachId && ((!candidate.venue || candidate.venue.toLowerCase() === fact.venue.toLowerCase()) && (!candidate.address || candidate.address.toLowerCase() === (fact.address ?? "").toLowerCase())));
		const event = normalizedEvent(fact, now, aliasRule?.beachId ? { beachId: aliasRule.beachId, ruleId: aliasRule.id, explanation: aliasRule.address ? "Exact administrator-approved address alias" : "Exact administrator-approved venue alias" } : undefined);
		if (!event) {
			excluded += 1;
			unsupportedOrAmbiguous += 1;
			await saveExclusion(env, fact, explanation.exclusionReason ?? "unknownVenue", explanation.reason, explanation.ruleId, now);
			continue;
		}
		matched += 1;
		await env.BEACH_DATA.delete(exclusionKey(fact));
		const prior = existingById.get(event.id);
		if (prior) {
			await env.BEACH_DATA.put(`${EVENT_PREFIX}${event.id}`, JSON.stringify({ ...event, ...prior, sourceFacts: fact, updatedAt: now.toISOString() }));
			continue;
		}
		if (existingDedupe.has(dedupeKey(event))) {
			excluded += 1;
			await saveExclusion(env, fact, "duplicate", "A matching event from this or another provider already exists", "cross-provider-deduplication", now);
			continue;
		}
		const rule = rules.find((candidate) => candidate.enabled && candidate.providerId === fact.providerId && (!candidate.venue || candidate.venue.toLowerCase() === fact.venue.toLowerCase()) && (!candidate.titlePattern || fact.title.toLowerCase().includes(candidate.titlePattern.toLowerCase())) && (!candidate.beachId || candidate.beachId === event.beachId));
		const status = rule?.action === "disregard" ? "disregarded" : rule?.action === "autoApprove" && event.matchConfidence === "exact" ? "approved" : "pendingReview";
		if (status === "pendingReview") pendingReview += 1;
		if (status === "disregarded") ruleSuppressed += 1;
		await env.BEACH_DATA.put(`${EVENT_PREFIX}${event.id}`, JSON.stringify({ ...event, status, ...(rule?.eventType ? { eventType: rule.eventType } : {}), ...(rule?.impactLevel ? { impactLevel: rule.impactLevel } : {}) }));
		existingDedupe.add(dedupeKey(event)); discovered += 1;
	}
	return { discovered, matched, excluded, pendingReview, ruleSuppressed, unsupportedOrAmbiguous };
}

function centralDayOrdinal(value: Date): number {
	const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" })
		.formatToParts(value).reduce<Record<string, number>>((result, part) => {
			if (part.type === "year" || part.type === "month" || part.type === "day") result[part.type] = Number(part.value);
			return result;
		}, {});
	return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000);
}

export function isEventVisibleNow(event: BeachEvent, now: Date): boolean {
	if (event.status !== "published" || Date.parse(event.endAt) <= now.getTime()) return false;
	if (event.displayFrom && Date.parse(event.displayFrom) <= now.getTime()) return true;
	const today = centralDayOrdinal(now);
	const firstDay = centralDayOrdinal(new Date(event.startAt));
	const lastDay = centralDayOrdinal(new Date(Date.parse(event.endAt) - 1));
	if (firstDay <= today && lastDay >= today) return true;
	return ["high", "major"].includes(event.impactLevel) && firstDay <= today + 1 && lastDay >= today + 1;
}

export function buildSnapshot(events: BeachEvent[], now: Date): BeachEventsSnapshot {
	const beaches: Record<string, BeachEvent[]> = {};
	const visible = events.filter((event) => event.status === "published" && Date.parse(event.endAt) > now.getTime());
	for (const event of visible) {
		const publicEvent = {
			id: event.id, beachId: event.beachId, title: event.title, venue: event.venue, address: event.address,
			startAt: event.startAt, endAt: event.endAt, displayFrom: event.displayFrom, allDay: event.allDay, recurring: event.recurring,
			eventType: event.eventType, impactLevel: event.impactLevel, bannerTitle: event.bannerTitle, bannerMessage: event.bannerMessage,
			parkingImpact: event.parkingImpact, trafficImpact: event.trafficImpact, accessImpact: event.accessImpact,
			showCompareNearbyBeaches: event.showCompareNearbyBeaches, sourceName: event.sourceName,
			summary: event.summary, eventDescription: event.fullDescription ?? event.eventDescription, fullDescription: event.fullDescription ?? event.eventDescription,
			officialEventURL: event.officialEventURL, registrationURL: event.registrationURL,
			officialEventsPageURL: event.officialEventsPageURL, organizerWebsiteURL: event.organizerWebsiteURL,
			sourceNote: event.sourceNote, contactInformation: event.contactInformation, sourceNewsletterMonth: event.sourceNewsletterMonth,
			endTimeUnavailable: event.endTimeUnavailable, updatedAt: event.updatedAt,
		} as unknown as BeachEvent;
		(beaches[event.beachId] ??= []).push(publicEvent);
	}
	for (const items of Object.values(beaches)) items.sort((a, b) => a.startAt.localeCompare(b.startAt));
	const attribution = [...new Map(visible.map((event) => [event.sourceFacts.providerId, { providerId: event.sourceFacts.providerId, sourceName: event.sourceName, sourceURL: event.officialEventURL ?? event.officialEventsPageURL ?? event.organizerWebsiteURL ?? "" }])).values()].filter((item) => item.sourceURL);
	return { schemaVersion: 1, revision: crypto.randomUUID(), status: "ok", generatedAt: now.toISOString(), lastSuccessfulRefresh: now.toISOString(), staleUntil: new Date(now.getTime() + STALE_WINDOW_MS).toISOString(), attribution, beaches };
}

export async function saveSnapshot(env: Pick<Env, "BEACH_DATA">, now: Date): Promise<BeachEventsSnapshot> {
	const snapshot = buildSnapshot(await listEvents(env), now);
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
			const candidate = { ...event, ...(normalized.summary ? { summary: normalized.summary } : {}), ...(normalized.fullDescription ? { eventDescription: normalized.fullDescription, fullDescription: normalized.fullDescription } : {}), ...(officialEventURL ? { officialEventURL } : {}), ...(registrationURL ? { registrationURL } : {}), ...(provider?.officialEventsPageURL ? { officialEventsPageURL: provider.officialEventsPageURL } : {}), ...(provider?.organizerWebsiteURL ? { organizerWebsiteURL: provider.organizerWebsiteURL } : {}), sourceCalendarURL: event.sourceFacts.sourceURL, normalizationWarnings: normalized.warnings };
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

export async function audit(env: Pick<Env, "BEACH_DATA">, identity: AdminIdentity, action: string, targetId: string, changes: unknown, now = new Date()): Promise<void> {
	const record = { schemaVersion: 1, id: crypto.randomUUID(), timestamp: now.toISOString(), actor: identity.subject.slice(0, 200), authenticationMethod: identity.method, action, targetId, changes };
	await env.BEACH_DATA.put(`${AUDIT_PREFIX}${record.timestamp}:${record.id}`, JSON.stringify(record));
}
