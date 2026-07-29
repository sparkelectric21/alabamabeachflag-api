import type { AdminIdentity } from "../services/admin/auth";
import type { Env } from "../types";
import { evaluateBeachEventsControl, readOperationalControl } from "../operationalControl/store";
import { BEACH_EVENT_PROVIDERS } from "../beachEvents/providers";
import { AUDIT_PREFIX, EVENT_PREFIX, EXCLUSION_PREFIX, RULE_PREFIX, SNAPSHOT_KEY, audit, isEventVisibleNow, listEvents, listExcludedCandidates, listRules, saveSnapshot, suggestPresentation, validateManualEvent } from "../beachEvents/store";
import type { BeachEvent, BeachEventsSnapshot, DecisionRule, ExcludedEventCandidate } from "../beachEvents/types";
import { beaches } from "../config/BeachRegistry";
import { readBeachEventRefreshStatus } from "../beachEvents/refresh";
import { nextBeachEventRefresh } from "../beachEvents/schedule";
import { beachReferences } from "../beachEvents/beachReference";

const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const respond = (body: unknown, status = 200) => Response.json(body, { status, headers });

function visibleSnapshot(snapshot: BeachEventsSnapshot, now: Date): BeachEventsSnapshot {
	const beaches = Object.fromEntries(
		Object.entries(snapshot.beaches)
			.map(([beachId, events]) => [beachId, events.filter((event) => isEventVisibleNow(event, now))] as const)
			.filter(([, events]) => events.length),
	);
	const providerIds = new Set(Object.values(beaches).flat().map((event) => event.sourceFacts.providerId));
	return { ...snapshot, beaches, attribution: snapshot.attribution.filter((source) => providerIds.has(source.providerId)) };
}

function visibleRevision(revision: string, snapshot: BeachEventsSnapshot): string {
	const identity = Object.values(snapshot.beaches).flat().map((event) => `${event.id}:${event.updatedAt}`).sort().join("|");
	let hash = 2166136261;
	for (let index = 0; index < identity.length; index += 1) hash = Math.imul(hash ^ identity.charCodeAt(index), 16777619);
	return `${revision}-${(hash >>> 0).toString(16)}`;
}

export async function handleBeachEventsRequest(request: Request, env: Env, now = new Date()): Promise<Response> {
	const control = evaluateBeachEventsControl(await readOperationalControl(env, now), now);
	if (control.state === "disabled") return respond({ status: "disabled", generatedAt: now.toISOString(), beaches: {}, attribution: [], control }, 200);
	const snapshot = await env.BEACH_DATA.get<BeachEventsSnapshot>(SNAPSHOT_KEY, "json");
	if (!snapshot) return respond({ status: "unavailable", generatedAt: now.toISOString(), beaches: {}, attribution: [] }, 503);
	if (Date.parse(snapshot.staleUntil) < now.getTime()) return respond({ status: "unavailable", generatedAt: now.toISOString(), beaches: {}, attribution: [], lastSuccessfulRefresh: snapshot.lastSuccessfulRefresh }, 503);
	const status = Date.parse(snapshot.generatedAt) + 6 * 60 * 60 * 1000 < now.getTime() ? "stale" : snapshot.status;
	const visible = visibleSnapshot(snapshot, now);
	const revision = visibleRevision(snapshot.revision ?? snapshot.generatedAt, visible);
	const etag = `"${revision}"`;
	const responseHeaders = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, no-cache, max-age=0, must-revalidate, stale-if-error=1800", ETag: etag };
	if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers: responseHeaders });
	return Response.json({ ...visible, revision, status }, { headers: responseHeaders });
}

export async function handleBeachEventsAdminGet(request: Request, env: Env): Promise<Response> {
	const now = new Date();
	const url = new URL(request.url);
	const events = await listEvents(env);
	const status = url.searchParams.get("status");
	const filtered = status ? events.filter((event) => event.status === status) : events;
	const auditKeys = await env.BEACH_DATA.list({ prefix: AUDIT_PREFIX, limit: 100 });
	const history = (await Promise.all(auditKeys.keys.map((key) => env.BEACH_DATA.get(key.name, "json")))).filter(Boolean);
	const exclusions = await listExcludedCandidates(env);
	const activeEvents = events.filter((event) => isEventVisibleNow(event, now));
	const coverage = beaches.map(({ id, displayName }) => {
		const beachEvents = events.filter((event) => event.beachId === id);
		const active = activeEvents.filter((event) => event.beachId === id);
		const supportedProviders = BEACH_EVENT_PROVIDERS.filter((provider) => provider.supportedBeachIds.includes(id));
		return {
			beachId: id,
			beachName: displayName,
			activeEvents: active.length,
			upcomingHighImpact: beachEvents.filter((event) => ["high", "major"].includes(event.impactLevel) && Date.parse(event.endAt) > now.getTime()).sort((a, b) => a.startAt.localeCompare(b.startAt))[0] ?? null,
			pendingCandidates: beachEvents.filter((event) => event.status === "pendingReview").length,
			lastMatchedEventAt: beachEvents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.updatedAt ?? null,
			coverageState: supportedProviders.some((provider) => provider.mode === "enabled") ? "active" : supportedProviders.length ? "partial" : "none",
			providerIds: supportedProviders.map((provider) => provider.id),
		};
	});
	return respond({
		events: filtered.sort((a, b) => a.startAt.localeCompare(b.startAt)),
		rules: await listRules(env),
		providers: BEACH_EVENT_PROVIDERS,
		beaches: beaches.map(({ id, displayName }) => ({ id, displayName })),
		beachReferences,
		audit: history.sort((a: any, b: any) => String(b.timestamp).localeCompare(String(a.timestamp))),
		exclusions: exclusions.sort((a, b) => a.startAt.localeCompare(b.startAt)),
		coverage,
		refresh: {
			...await readBeachEventRefreshStatus(env, now),
			nextScheduledRefresh: nextBeachEventRefresh(now),
			operationalState: evaluateBeachEventsControl(await readOperationalControl(env, now), now).state,
			staleCache: Boolean(await env.BEACH_DATA.get<BeachEventsSnapshot>(SNAPSHOT_KEY, "json").then((snapshot) => snapshot && Date.parse(snapshot.generatedAt) + 6 * 60 * 60 * 1000 < now.getTime())),
		},
	});
}

export async function handleBeachEventsAdminCreate(request: Request, env: Env, identity: AdminIdentity, now = new Date()): Promise<Response> {
	let input: Record<string, unknown>; try { input = await request.json(); } catch { return respond({ error: "invalid_json" }, 400); }
	const errors = validateManualEvent(input, now);
	if (errors.length) return respond({ error: "invalid_event", fields: errors }, 400);
	if (!beaches.some((beach) => beach.id === input.beachId)) return respond({ error: "unknown_beach" }, 400);
	const id = `manual-${crypto.randomUUID()}`, timestamp = now.toISOString();
	const event: BeachEvent = {
		id,
		beachId: String(input.beachId),
		title: String(input.title).trim(),
		venue: String(input.venue).trim(),
		...(typeof input.address === "string" && input.address.trim() ? { address: input.address.trim() } : {}),
		startAt: new Date(String(input.startAt)).toISOString(),
		endAt: new Date(String(input.endAt)).toISOString(),
		allDay: input.allDay === true,
		recurring: false,
		eventType: input.eventType as BeachEvent["eventType"],
		impactLevel: input.impactLevel as BeachEvent["impactLevel"],
		bannerTitle: String(input.bannerTitle).trim(),
		bannerMessage: String(input.bannerMessage).trim(),
		parkingImpact: input.parkingImpact === true,
		trafficImpact: input.trafficImpact === true,
		accessImpact: input.accessImpact === true,
		showCompareNearbyBeaches: input.showCompareNearbyBeaches === true,
		...(typeof input.displayFrom === "string" && !Number.isNaN(Date.parse(input.displayFrom)) ? { displayFrom: new Date(input.displayFrom).toISOString() } : {}),
		status: input.status as BeachEvent["status"],
		sourceName: String(input.sourceName).trim(),
		sourceURL: String(input.sourceURL),
		matchMethod: "adminOverride",
		matchConfidence: "admin",
		...(typeof input.internalNotes === "string" && input.internalNotes.trim() ? { internalNotes: input.internalNotes.trim().slice(0, 2000) } : {}),
		sourceFacts: {
			providerId: "manual",
			externalId: id,
			title: String(input.title).trim(),
			venue: String(input.venue).trim(),
			startAt: new Date(String(input.startAt)).toISOString(),
			endAt: new Date(String(input.endAt)).toISOString(),
			allDay: input.allDay === true,
			recurring: false,
			sourceName: String(input.sourceName).trim(),
			sourceURL: String(input.sourceURL),
		},
		createdAt: timestamp,
		updatedAt: timestamp,
	};
	await env.BEACH_DATA.put(`${EVENT_PREFIX}${id}`, JSON.stringify(event));
	await audit(env, identity, "create_event", id, event, now);
	await saveSnapshot(env, now);
	return respond({ event }, 201);
}

const EDITABLE = new Set(["beachId", "title", "venue", "address", "startAt", "endAt", "allDay", "eventType", "impactLevel", "bannerTitle", "bannerMessage", "parkingImpact", "trafficImpact", "accessImpact", "showCompareNearbyBeaches", "displayFrom", "status", "internalNotes", "sourceName", "sourceURL"]);

export async function handleBeachEventsAdminUpdate(request: Request, env: Env, identity: AdminIdentity, id: string, now = new Date()): Promise<Response> {
	const current = await env.BEACH_DATA.get<BeachEvent>(`${EVENT_PREFIX}${id}`, "json");
	if (!current) return respond({ error: "not_found" }, 404);
	let changes: Record<string, unknown>; try { changes = await request.json(); } catch { return respond({ error: "invalid_json" }, 400); }
	if (!changes || Object.keys(changes).some((key) => !EDITABLE.has(key))) return respond({ error: "invalid_changes" }, 400);
	const candidate = { ...current, ...changes, id: current.id, createdAt: current.createdAt, sourceFacts: current.sourceFacts };
	const errors = validateManualEvent(candidate, now);
	if (errors.length) return respond({ error: "invalid_event", fields: errors }, 400);
	if (!beaches.some((beach) => beach.id === candidate.beachId)) return respond({ error: "unknown_beach" }, 400);
	const changedFields = Object.fromEntries(Object.entries(changes).filter(([key, value]) => JSON.stringify((current as unknown as Record<string, unknown>)[key]) !== JSON.stringify(value)));
	const next = { ...candidate, updatedAt: now.toISOString() } as BeachEvent;
	await env.BEACH_DATA.put(`${EVENT_PREFIX}${id}`, JSON.stringify(next));
	await audit(env, identity, "update_event", id, changedFields, now);
	await saveSnapshot(env, now);
	return respond({ event: next });
}

export async function handleBeachEventsAdminDelete(env: Env, identity: AdminIdentity, id: string, now = new Date()): Promise<Response> {
	const current = await env.BEACH_DATA.get<BeachEvent>(`${EVENT_PREFIX}${id}`, "json");
	if (!current) return respond({ error: "not_found" }, 404);
	if (current.sourceFacts.providerId !== "manual" && current.status !== "disregarded" && current.status !== "expired") return respond({ error: "delete_not_allowed" }, 409);
	await env.BEACH_DATA.delete(`${EVENT_PREFIX}${id}`);
	await audit(env, identity, "delete_event", id, { title: current.title }, now);
	await saveSnapshot(env, now);
	return respond({ status: "deleted" });
}

export async function handleBeachEventRuleCreate(request: Request, env: Env, identity: AdminIdentity, now = new Date()): Promise<Response> {
	let input: Record<string, unknown>; try { input = await request.json(); } catch { return respond({ error: "invalid_json" }, 400); }
	if (!["disregard", "autoApprove", "suggest"].includes(String(input.action)) || typeof input.providerId !== "string" || !input.providerId || (!input.venue && !input.address && !input.titlePattern)) return respond({ error: "invalid_rule" }, 400);
	if (input.action === "autoApprove" && (!input.venue || !input.beachId)) return respond({ error: "auto_approve_requires_exact_venue_and_beach" }, 400);
	if (input.action === "suggest" && ((!input.venue && !input.address) || !input.beachId)) return respond({ error: "alias_requires_exact_location_and_beach" }, 400);
	const rule: DecisionRule = { id: crypto.randomUUID(), action: input.action as DecisionRule["action"], providerId: input.providerId.slice(0, 80), ...(typeof input.venue === "string" ? { venue: input.venue.slice(0, 200) } : {}), ...(typeof input.address === "string" ? { address: input.address.slice(0, 240) } : {}), ...(typeof input.titlePattern === "string" ? { titlePattern: input.titlePattern.slice(0, 160) } : {}), ...(typeof input.beachId === "string" ? { beachId: input.beachId.slice(0, 80) } : {}), enabled: true, createdAt: now.toISOString(), createdBy: identity.subject.slice(0, 200) };
	await env.BEACH_DATA.put(`${RULE_PREFIX}${rule.id}`, JSON.stringify(rule));
	await audit(env, identity, "create_rule", rule.id, rule, now);
	return respond({ rule }, 201);
}

export async function handleExcludedEventAssign(request: Request, env: Env, identity: AdminIdentity, id: string, now = new Date()): Promise<Response> {
	const key = `${EXCLUSION_PREFIX}${id}`;
	const candidate = await env.BEACH_DATA.get<ExcludedEventCandidate>(key, "json");
	if (!candidate) return respond({ error: "not_found" }, 404);
	let input: Record<string, unknown>; try { input = await request.json(); } catch { return respond({ error: "invalid_json" }, 400); }
	const beachId = String(input.beachId ?? "");
	if (!beaches.some((beach) => beach.id === beachId)) return respond({ error: "unknown_beach" }, 400);
	const presentation = suggestPresentation(candidate.title, candidate.sourceFacts.description);
	const eventId = `imported-${candidate.providerId}-${encodeURIComponent(candidate.sourceFacts.externalId).slice(0, 120)}`;
	const event: BeachEvent = {
		id: eventId, beachId, title: candidate.title, venue: candidate.venue, ...(candidate.address ? { address: candidate.address } : {}),
		startAt: candidate.startAt, endAt: candidate.endAt, allDay: candidate.sourceFacts.allDay, recurring: candidate.sourceFacts.recurring,
		...presentation, status: "pendingReview", sourceName: candidate.sourceName, sourceURL: candidate.sourceURL,
		matchMethod: "adminOverride", matchConfidence: "admin", matchRuleId: "admin-candidate-assignment", matchExplanation: "Administrator assigned the excluded candidate to an exact beach",
		sourceFacts: candidate.sourceFacts, createdAt: now.toISOString(), updatedAt: now.toISOString(),
	};
	await env.BEACH_DATA.put(`${EVENT_PREFIX}${eventId}`, JSON.stringify(event));
	await env.BEACH_DATA.put(key, JSON.stringify({ ...candidate, suggestedBeachId: beachId, decision: "admin", lastSeenAt: now.toISOString() }), { expirationTtl: 90 * 24 * 60 * 60 });
	await audit(env, identity, "assign_excluded_candidate", id, { beachId, eventId }, now);
	await saveSnapshot(env, now);
	return respond({ event }, 201);
}

export async function handleBeachEventSuggest(request: Request): Promise<Response> {
	let input: Record<string, unknown>; try { input = await request.json(); } catch { return respond({ error: "invalid_json" }, 400); }
	return respond(suggestPresentation(String(input.title ?? ""), String(input.description ?? "")));
}
