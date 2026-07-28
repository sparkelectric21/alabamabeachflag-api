import type { AdminIdentity } from "../services/admin/auth";
import type { Env } from "../types";
import { dedupeKey, exactBeachMatch } from "./matching";
import type { BeachEvent, BeachEventsSnapshot, DecisionRule, SourceFacts } from "./types";
import { EVENT_STATUSES, EVENT_TYPES, IMPACT_LEVELS } from "./types";

export const SNAPSHOT_KEY = "beach-events:v1:snapshot";
export const EVENT_PREFIX = "beach-events:v1:event:";
export const RULE_PREFIX = "beach-events:v1:rule:";
export const AUDIT_PREFIX = "beach-events:v1:audit:";
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

export function normalizedEvent(facts: SourceFacts, now: Date): BeachEvent | null {
	const match = exactBeachMatch({ providerId: facts.providerId, venue: facts.venue, address: facts.address });
	if (!match) return null;
	const suggested = suggestPresentation(facts.title, facts.description);
	const sourceURL = httpsURL(facts.officialURL) ? facts.officialURL : facts.sourceURL;
	return {
		id: `imported-${facts.providerId}-${encodeURIComponent(facts.externalId).slice(0, 120)}`,
		beachId: match.beachId,
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
		matchMethod: match.method,
		matchConfidence: "exact",
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

export async function applyImportedEvents(env: Pick<Env, "BEACH_DATA">, facts: SourceFacts[], now: Date): Promise<{ discovered: number; matched: number }> {
	const existing = await listEvents(env);
	const rules = await listRules(env);
	const existingById = new Map(existing.map((event) => [event.id, event]));
	const existingDedupe = new Set(existing.map(dedupeKey));
	let matched = 0, discovered = 0;
	for (const fact of facts) {
		const event = normalizedEvent(fact, now);
		if (!event) continue;
		matched += 1;
		const prior = existingById.get(event.id);
		if (prior) {
			await env.BEACH_DATA.put(`${EVENT_PREFIX}${event.id}`, JSON.stringify({ ...event, ...prior, sourceFacts: fact, updatedAt: now.toISOString() }));
			continue;
		}
		if (existingDedupe.has(dedupeKey(event))) continue;
		const rule = rules.find((candidate) => candidate.enabled && candidate.providerId === fact.providerId && (!candidate.venue || candidate.venue.toLowerCase() === fact.venue.toLowerCase()) && (!candidate.titlePattern || fact.title.toLowerCase().includes(candidate.titlePattern.toLowerCase())) && (!candidate.beachId || candidate.beachId === event.beachId));
		const status = rule?.action === "disregard" ? "disregarded" : rule?.action === "autoApprove" && event.matchConfidence === "exact" ? "approved" : "pendingReview";
		await env.BEACH_DATA.put(`${EVENT_PREFIX}${event.id}`, JSON.stringify({ ...event, status, ...(rule?.eventType ? { eventType: rule.eventType } : {}), ...(rule?.impactLevel ? { impactLevel: rule.impactLevel } : {}) }));
		existingDedupe.add(dedupeKey(event)); discovered += 1;
	}
	return { discovered, matched };
}

export function buildSnapshot(events: BeachEvent[], now: Date): BeachEventsSnapshot {
	const beaches: Record<string, BeachEvent[]> = {};
	const visible = events.filter((event) => event.status === "published" && Date.parse(event.endAt) > now.getTime());
	for (const event of visible) (beaches[event.beachId] ??= []).push(event);
	for (const items of Object.values(beaches)) items.sort((a, b) => a.startAt.localeCompare(b.startAt));
	const attribution = [...new Map(visible.map((event) => [event.sourceFacts.providerId, { providerId: event.sourceFacts.providerId, sourceName: event.sourceName, sourceURL: event.sourceFacts.sourceURL }])).values()];
	return { schemaVersion: 1, status: "ok", generatedAt: now.toISOString(), lastSuccessfulRefresh: now.toISOString(), staleUntil: new Date(now.getTime() + STALE_WINDOW_MS).toISOString(), attribution, beaches };
}

export async function saveSnapshot(env: Pick<Env, "BEACH_DATA">, now: Date): Promise<BeachEventsSnapshot> {
	const snapshot = buildSnapshot(await listEvents(env), now);
	await env.BEACH_DATA.put(SNAPSHOT_KEY, JSON.stringify(snapshot));
	return snapshot;
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
