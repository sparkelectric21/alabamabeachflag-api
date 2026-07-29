import type { AdminIdentity } from "../services/admin/auth";
import type { Env } from "../types";
import { evaluateBeachEventsControl, readOperationalControl } from "../operationalControl/store";
import { BEACH_EVENT_PROVIDERS } from "../beachEvents/providers";
import { AUDIT_PREFIX, EVENT_PREFIX, RULE_PREFIX, SNAPSHOT_KEY, audit, listEvents, listRules, saveSnapshot, suggestPresentation, validateManualEvent } from "../beachEvents/store";
import type { BeachEvent, BeachEventsSnapshot, DecisionRule } from "../beachEvents/types";
import { beaches } from "../config/BeachRegistry";
import { readBeachEventRefreshStatus } from "../beachEvents/refresh";
import { nextBeachEventRefresh } from "../beachEvents/schedule";

const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const respond = (body: unknown, status = 200) => Response.json(body, { status, headers });

export async function handleBeachEventsRequest(env: Env, now = new Date()): Promise<Response> {
	const control = evaluateBeachEventsControl(await readOperationalControl(env, now), now);
	if (control.state === "disabled") return respond({ status: "disabled", generatedAt: now.toISOString(), beaches: {}, attribution: [], control }, 200);
	const snapshot = await env.BEACH_DATA.get<BeachEventsSnapshot>(SNAPSHOT_KEY, "json");
	if (!snapshot) return respond({ status: "unavailable", generatedAt: now.toISOString(), beaches: {}, attribution: [] }, 503);
	if (Date.parse(snapshot.staleUntil) < now.getTime()) return respond({ status: "unavailable", generatedAt: now.toISOString(), beaches: {}, attribution: [], lastSuccessfulRefresh: snapshot.lastSuccessfulRefresh }, 503);
	const status = Date.parse(snapshot.generatedAt) + 6 * 60 * 60 * 1000 < now.getTime() ? "stale" : snapshot.status;
	return Response.json({ ...snapshot, status }, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300, stale-if-error=1800" } });
}

export async function handleBeachEventsAdminGet(request: Request, env: Env): Promise<Response> {
	const now = new Date();
	const url = new URL(request.url);
	const events = await listEvents(env);
	const status = url.searchParams.get("status");
	const filtered = status ? events.filter((event) => event.status === status) : events;
	const auditKeys = await env.BEACH_DATA.list({ prefix: AUDIT_PREFIX, limit: 100 });
	const history = (await Promise.all(auditKeys.keys.map((key) => env.BEACH_DATA.get(key.name, "json")))).filter(Boolean);
	return respond({
		events: filtered.sort((a, b) => a.startAt.localeCompare(b.startAt)),
		rules: await listRules(env),
		providers: BEACH_EVENT_PROVIDERS,
		beaches: beaches.map(({ id, displayName }) => ({ id, displayName })),
		audit: history.sort((a: any, b: any) => String(b.timestamp).localeCompare(String(a.timestamp))),
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
	const candidate = { ...current, ...changes };
	const errors = validateManualEvent(candidate, now);
	if (errors.length) return respond({ error: "invalid_event", fields: errors }, 400);
	if (!beaches.some((beach) => beach.id === candidate.beachId)) return respond({ error: "unknown_beach" }, 400);
	const next = { ...candidate, updatedAt: now.toISOString() } as BeachEvent;
	await env.BEACH_DATA.put(`${EVENT_PREFIX}${id}`, JSON.stringify(next));
	await audit(env, identity, "update_event", id, changes, now);
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
	if (!["disregard", "autoApprove", "suggest"].includes(String(input.action)) || typeof input.providerId !== "string" || !input.providerId || (!input.venue && !input.titlePattern)) return respond({ error: "invalid_rule" }, 400);
	if (input.action === "autoApprove" && (!input.venue || !input.beachId)) return respond({ error: "auto_approve_requires_exact_venue_and_beach" }, 400);
	const rule: DecisionRule = { id: crypto.randomUUID(), action: input.action as DecisionRule["action"], providerId: input.providerId.slice(0, 80), ...(typeof input.venue === "string" ? { venue: input.venue.slice(0, 200) } : {}), ...(typeof input.titlePattern === "string" ? { titlePattern: input.titlePattern.slice(0, 160) } : {}), ...(typeof input.beachId === "string" ? { beachId: input.beachId.slice(0, 80) } : {}), enabled: true, createdAt: now.toISOString(), createdBy: identity.subject.slice(0, 200) };
	await env.BEACH_DATA.put(`${RULE_PREFIX}${rule.id}`, JSON.stringify(rule));
	await audit(env, identity, "create_rule", rule.id, rule, now);
	return respond({ rule }, 201);
}

export async function handleBeachEventSuggest(request: Request): Promise<Response> {
	let input: Record<string, unknown>; try { input = await request.json(); } catch { return respond({ error: "invalid_json" }, 400); }
	return respond(suggestPresentation(String(input.title ?? ""), String(input.description ?? "")));
}
