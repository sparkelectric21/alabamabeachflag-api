import type { AdminIdentity } from "../services/admin/auth";
import type { Env } from "../types";
import { evaluateBeachEventsControl, readOperationalControl } from "../operationalControl/store";
import { BEACH_EVENT_PROVIDERS } from "../beachEvents/providers";
import { AUDIT_PREFIX, EVENT_PREFIX, EXCLUSION_PREFIX, RULE_PREFIX, SNAPSHOT_KEY, audit, eventNeedsReview, importedEventId, isEventVisibleNow, listEvents, listExcludedCandidates, listRules, renormalizeExistingEvents, saveSnapshot, suggestPresentation, validateManualEvent } from "../beachEvents/store";
import type { BeachEvent, BeachEventsSnapshot, DecisionRule, ExcludedEventCandidate } from "../beachEvents/types";
import { beaches } from "../config/BeachRegistry";
import { readBeachEventRefreshStatus } from "../beachEvents/refresh";
import { nextBeachEventRefresh } from "../beachEvents/schedule";
import { beachReferences } from "../beachEvents/beachReference";
import { buildReviewQueue, evaluateBeachActivityNotifications, readBeachActivityNotificationConfig, readBeachActivityNotificationState, updateBeachActivityNotificationConfig } from "../beachEvents/notifications";
import { normalizeDescription, sanitizeEventURL } from "../beachEvents/normalize";
import { sourceRevision, stableHash } from "../beachEvents/sourceChanges";
import { auditEventLocations } from "../beachEvents/location";
import { auditConfirmationTransition } from "../beachEvents/lifecycle";
import { SOURCE_OBSERVATION_PREFIX, observationIdentityHash } from "../beachEvents/observations";
import { auditDuplicateCandidates, selectDuplicateCandidates } from "../beachEvents/duplicates";

const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const respond = (body: unknown, status = 200) => Response.json(body, { status, headers });

export function eventAdminRevision(event: BeachEvent): string {
	const { lastSeenAt: _lastSeenAt, ...record } = event;
	return stableHash(JSON.stringify(record));
}

function adminEvent(event: BeachEvent): BeachEvent & { revision: string } {
	return { ...event, revision: eventAdminRevision(event) };
}

function visibleSnapshot(snapshot: BeachEventsSnapshot, now: Date): BeachEventsSnapshot {
	const beaches = Object.fromEntries(
		Object.entries(snapshot.beaches)
			.map(([beachId, events]) => [beachId, events.filter((event) => isEventVisibleNow({ ...event, status: "published" }, now))] as const)
			.filter(([, events]) => events.length),
	);
	return { ...snapshot, beaches };
}

function visibleRevision(revision: string, snapshot: BeachEventsSnapshot): string {
	const identity = Object.values(snapshot.beaches).flat().map((event) => `${event.id}:${event.updatedAt}`).sort().join("|");
	let hash = 2166136261;
	for (let index = 0; index < identity.length; index += 1) hash = Math.imul(hash ^ identity.charCodeAt(index), 16777619);
	return `${revision}-${(hash >>> 0).toString(16)}`;
}

export async function handleBeachEventsRequest(request: Request, env: Env, now = new Date()): Promise<Response> {
	const control = evaluateBeachEventsControl(await readOperationalControl(env, now), now);
	if (control.state === "disabled") return respond({ status: "disabled", generatedAt: now.toISOString(), beaches: {}, attribution: [] }, 200);
	const snapshot = await env.BEACH_DATA.get<BeachEventsSnapshot>(SNAPSHOT_KEY, "json");
	if (!snapshot) return respond({ status: "unavailable", generatedAt: now.toISOString(), beaches: {}, attribution: [] }, 503);
	if (Date.parse(snapshot.staleUntil) < now.getTime()) return respond({ status: "unavailable", generatedAt: now.toISOString(), beaches: {}, attribution: [], lastSuccessfulRefresh: snapshot.lastSuccessfulRefresh }, 503);
	const status = Date.parse(snapshot.generatedAt) + 6 * 60 * 60 * 1000 < now.getTime() ? "stale" : snapshot.status;
	const visible = visibleSnapshot(snapshot, now);
	const revision = visibleRevision(snapshot.revision ?? snapshot.generatedAt, visible);
	const etag = `"${revision}-${snapshot.lastSuccessfulRefresh}"`;
	const responseHeaders = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, no-cache, max-age=0, must-revalidate, stale-if-error=1800", ETag: etag };
	if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers: responseHeaders });
	return Response.json({ ...visible, revision, status }, { headers: responseHeaders });
}

export async function handleBeachEventsAdminGet(request: Request, env: Env, now = new Date()): Promise<Response> {
	const url = new URL(request.url);
	const events = await listEvents(env);
	const status = url.searchParams.get("status");
	const archived = events.filter((event) => event.status === "completed" || event.status === "expired" || Boolean(event.archivedAt));
	const active = events.filter((event) => event.status !== "completed" && event.status !== "expired" && !event.archivedAt);
	const filtered = status ? active.filter((event) => event.status === status) : active;
	const auditKeys = await env.BEACH_DATA.list({ prefix: AUDIT_PREFIX, limit: 25 });
	const history = (await Promise.all(auditKeys.keys.map((key) => env.BEACH_DATA.get(key.name, "json")))).filter(Boolean);
	const exclusions = await listExcludedCandidates(env);
	const refreshStatus = await readBeachEventRefreshStatus(env, now);
	const observationKeys = await env.BEACH_DATA.list({ prefix: SOURCE_OBSERVATION_PREFIX, limit: 25 });
	const sourceObservations = (await Promise.all(observationKeys.keys.map((key) => env.BEACH_DATA.get<any>(key.name, "json")))).filter(Boolean).map((observation) => ({ ...observation, eventId: events.find((event) => event.sourceFacts.providerId === observation.providerId && [stableHash(event.sourceFacts.externalId), observationIdentityHash(event.sourceFacts.externalId)].includes(observation.externalIdHash))?.id }));
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
			pendingCandidates: beachEvents.filter(eventNeedsReview).length,
			lastMatchedEventAt: beachEvents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.updatedAt ?? null,
			coverageState: supportedProviders.some((provider) => provider.mode === "enabled") ? "active" : supportedProviders.length ? "partial" : "none",
			providerIds: supportedProviders.map((provider) => provider.id),
		};
	});
	return respond({
		events: filtered.sort((a, b) => a.startAt.localeCompare(b.startAt)).map(adminEvent),
		archive: archived.sort((a, b) => String(b.archivedAt ?? b.completedAt ?? b.endAt).localeCompare(String(a.archivedAt ?? a.completedAt ?? a.endAt))).map(adminEvent),
		rules: await listRules(env),
		providers: BEACH_EVENT_PROVIDERS,
		beaches: beaches.map(({ id, displayName }) => ({ id, displayName })),
		beachReferences,
		audit: history.sort((a: any, b: any) => String(b.timestamp).localeCompare(String(a.timestamp))),
		historyPage: { audit: { hasMore: !auditKeys.list_complete, cursor: auditKeys.list_complete ? null : auditKeys.cursor, count: history.length }, observations: { hasMore: !observationKeys.list_complete, cursor: observationKeys.list_complete ? null : observationKeys.cursor, count: sourceObservations.length } },
		exclusions: exclusions.sort((a, b) => a.startAt.localeCompare(b.startAt)),
		coverage,
		locationAudit: auditEventLocations(events),
		confirmationAudit: events.map((event) => {
			const provider = refreshStatus.providers.find((item) => item.providerId === event.sourceFacts.providerId);
			return auditConfirmationTransition(event, provider?.status === "partial" ? "partial" : provider?.status === "failed" ? "failed" : "confirmedUnchanged", now, provider?.status === "failed" ? "unavailable" : provider?.status === "partial" ? "degraded" : "healthy");
		}),
		sourceObservations,
		duplicateAudit: auditDuplicateCandidates(events),
		notifications: {
			configuration: await readBeachActivityNotificationConfig(env),
			state: await readBeachActivityNotificationState(env),
			bindingReady: Boolean(env.VERIFICATION_ALERT_EMAIL),
			queue: buildReviewQueue(events, { exclusions, refresh: refreshStatus, now }),
		},
		refresh: {
			...refreshStatus,
			nextScheduledRefresh: nextBeachEventRefresh(now),
			operationalState: evaluateBeachEventsControl(await readOperationalControl(env, now), now).state,
			staleCache: Boolean(await env.BEACH_DATA.get<BeachEventsSnapshot>(SNAPSHOT_KEY, "json").then((snapshot) => snapshot && Date.parse(snapshot.generatedAt) + 6 * 60 * 60 * 1000 < now.getTime())),
		},
	});
}

export async function handleBeachEventHistory(request: Request, env: Env, eventId: string): Promise<Response> {
	if (!eventId || eventId.length > 240) return respond({ error: "invalid_event_id" }, 400);
	const event = await env.BEACH_DATA.get<BeachEvent>(`${EVENT_PREFIX}${eventId}`, "json");
	if (!event) return respond({ error: "not_found" }, 404);
	const url = new URL(request.url), kind = url.searchParams.get("kind") ?? "audit", cursor = url.searchParams.get("cursor") ?? undefined;
	if (!/^(audit|observations)$/.test(kind) || (cursor && cursor.length > 512)) return respond({ error: "invalid_history_query" }, 400);
	const prefix = kind === "audit" ? AUDIT_PREFIX : `${SOURCE_OBSERVATION_PREFIX}${encodeURIComponent(event.sourceFacts.providerId)}:`;
	const page = await env.BEACH_DATA.list({ prefix, limit: 50, ...(cursor ? { cursor } : {}) });
	const values = (await Promise.all(page.keys.map((key) => env.BEACH_DATA.get<any>(key.name, "json")))).filter(Boolean);
	const hashes = new Set([stableHash(event.sourceFacts.externalId), observationIdentityHash(event.sourceFacts.externalId)]);
	const items = kind === "audit" ? values.filter((item) => item.targetId === eventId) : values.filter((item) => hashes.has(item.externalIdHash));
	return respond({ schemaVersion: 1, eventId, kind, items: items.slice(0, 50), hasMore: !page.list_complete, cursor: page.list_complete ? null : page.cursor, scanned: values.length, truncated: items.length > 50 });
}

export async function handleBeachActivityNotificationPreferences(request: Request, env: Env, identity: AdminIdentity): Promise<Response> {
	return updateBeachActivityNotificationConfig(request, env, identity);
}

export async function handleBeachActivityNotificationSend(request: Request, env: Env, identity: AdminIdentity, kind: "manual" | "test"): Promise<Response> {
	const result = await evaluateBeachActivityNotifications(env, new Date(), { kind, identity });
	const status = result.outcome === "failed" ? 502 : result.outcome === "disabled" || result.outcome === "monitorOnly" ? 409 : result.outcome === "empty" ? 422 : 200;
	return respond(result, status);
}

export async function handleBeachEventsAdminCreate(request: Request, env: Env, identity: AdminIdentity, now = new Date()): Promise<Response> {
	let input: Record<string, unknown>; try { input = await request.json(); } catch { return respond({ error: "invalid_json" }, 400); }
	if (input.status !== "pendingReview") return respond({ error: "manual_creation_requires_review" }, 409);
	const errors = validateManualEvent(input, now);
	if (errors.length) return respond({ error: "invalid_event", fields: errors }, 400);
	if (!beaches.some((beach) => beach.id === input.beachId)) return respond({ error: "unknown_beach" }, 400);
	const id = `manual-${crypto.randomUUID()}`, timestamp = now.toISOString();
	const sourceFacts = {
		providerId: "manual",
		externalId: id,
		title: String(input.title).trim(),
		venue: String(input.venue).trim(),
		...(typeof input.address === "string" && input.address.trim() ? { address: input.address.trim() } : {}),
		startAt: new Date(String(input.startAt)).toISOString(),
		endAt: new Date(String(input.endAt)).toISOString(),
		allDay: input.allDay === true,
		recurring: false,
		sourceName: String(input.sourceName).trim(),
		sourceURL: String(input.sourceURL),
	} as const;
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
		status: "pendingReview",
		sourceName: String(input.sourceName).trim(),
		sourceURL: String(input.sourceURL),
		...(typeof input.summary === "string" && input.summary.trim() ? { summary: normalizeDescription(input.summary, [String(input.title), String(input.venue)]).fullDescription } : {}),
		...(typeof input.fullDescription === "string" && input.fullDescription.trim() ? { fullDescription: normalizeDescription(input.fullDescription, [String(input.title), String(input.venue)]).fullDescription, eventDescription: normalizeDescription(input.fullDescription).fullDescription } : {}),
		...(sanitizeEventURL(input.officialEventURL) ? { officialEventURL: sanitizeEventURL(input.officialEventURL) } : {}),
		...(sanitizeEventURL(input.registrationURL) ? { registrationURL: sanitizeEventURL(input.registrationURL) } : {}),
		...(sanitizeEventURL(input.officialEventsPageURL) ? { officialEventsPageURL: sanitizeEventURL(input.officialEventsPageURL) } : {}),
		...(sanitizeEventURL(input.organizerWebsiteURL) ? { organizerWebsiteURL: sanitizeEventURL(input.organizerWebsiteURL) } : {}),
		...(typeof input.sourceCalendarURL === "string" ? { sourceCalendarURL: input.sourceCalendarURL } : {}),
		matchMethod: "adminOverride",
		matchConfidence: "admin",
		matchRuleId: "manual-event-assignment",
		matchExplanation: "Administrator assigned the manual event to an exact beach",
		...(typeof input.internalNotes === "string" && input.internalNotes.trim() ? { internalNotes: input.internalNotes.trim().slice(0, 2000) } : {}),
		sourceFacts,
		sourceRevision: sourceRevision(sourceFacts),
		lastSeenAt: timestamp,
		createdAt: timestamp,
		updatedAt: timestamp,
	};
	const existingEvents = await listEvents(env);
	const duplicate = selectDuplicateCandidates(event, existingEvents).candidates[0];
	const next = duplicate ? { ...event, status: "pendingReview" as const, possibleDuplicateOf: duplicate.candidate.id, duplicateAssessment: duplicate.assessment, attentionFlags: ["possibleDuplicate" as const] } : event;
	await env.BEACH_DATA.put(`${EVENT_PREFIX}${id}`, JSON.stringify(next));
	await audit(env, identity, "create_event", id, next, now, { previousState: null, newState: next.status, changedFields: Object.keys(next), sourceRevision: next.sourceRevision, publicOutputAffected: false, ...(duplicate ? { reason: `possible_duplicate_of:${duplicate.candidate.id}` } : {}) });
	await saveSnapshot(env, now);
	return respond({ event: next }, 201);
}

const EDITABLE = new Set(["beachId", "title", "venue", "address", "startAt", "endAt", "allDay", "eventType", "impactLevel", "summary", "fullDescription", "officialEventURL", "registrationURL", "officialEventsPageURL", "organizerWebsiteURL", "sourceCalendarURL", "bannerTitle", "bannerMessage", "parkingImpact", "trafficImpact", "accessImpact", "showCompareNearbyBeaches", "displayFrom", "status", "internalNotes", "sourceName", "sourceURL", "acknowledgeAttention"]);
const SOURCE_OVERRIDE_FIELDS = new Set(["beachId", "title", "venue", "address", "startAt", "endAt", "allDay", "summary", "fullDescription", "officialEventURL", "registrationURL", "officialEventsPageURL", "organizerWebsiteURL", "sourceName", "sourceURL"]);
const PUBLIC_EVENT_FIELDS = new Set(["beachId", "title", "venue", "address", "startAt", "endAt", "allDay", "eventType", "impactLevel", "summary", "fullDescription", "officialEventURL", "registrationURL", "officialEventsPageURL", "organizerWebsiteURL", "bannerTitle", "bannerMessage", "parkingImpact", "trafficImpact", "accessImpact", "showCompareNearbyBeaches", "displayFrom", "sourceName", "status"]);

export async function handleBeachEventsAdminUpdate(request: Request, env: Env, identity: AdminIdentity, id: string, now = new Date()): Promise<Response> {
	const current = await env.BEACH_DATA.get<BeachEvent>(`${EVENT_PREFIX}${id}`, "json");
	if (!current) return respond({ error: "not_found" }, 404);
	const currentRevision = eventAdminRevision(current);
	if (request.headers.get("If-Match") !== currentRevision) return respond({ error: "revision_conflict", currentRevision }, 412);
	if (current.status === "completed" || current.status === "expired" || current.archivedAt) return respond({ error: "archived_event_read_only" }, 409);
	let changes: Record<string, unknown>; try { changes = await request.json(); } catch { return respond({ error: "invalid_json" }, 400); }
	if (!changes || Object.keys(changes).some((key) => !EDITABLE.has(key))) return respond({ error: "invalid_changes" }, 400);
	if (changes.status === "completed") return respond({ error: "completion_is_automatic" }, 409);
	const acknowledgeAttention = changes.acknowledgeAttention === true;
	delete changes.acknowledgeAttention;
	if (changes.status === "published" && !["approved", "scheduled", "hidden", "published"].includes(current.status)) return respond({ error: "publication_requires_approval" }, 409);
	if (typeof changes.summary === "string") changes.summary = normalizeDescription(changes.summary, [String(changes.title ?? current.title), String(changes.venue ?? current.venue)]).fullDescription;
	if (typeof changes.fullDescription === "string") { changes.fullDescription = normalizeDescription(changes.fullDescription).fullDescription; changes.eventDescription = changes.fullDescription; }
	for (const key of ["officialEventURL", "registrationURL", "officialEventsPageURL", "organizerWebsiteURL"] as const) if (key in changes && changes[key]) changes[key] = sanitizeEventURL(changes[key]);
	const acceptedReview = ["approved", "scheduled", "published", "disregarded"].includes(String(changes.status));
	const beachAssignmentChanged = current.sourceFacts.providerId !== "manual" && typeof changes.beachId === "string" && changes.beachId !== current.beachId;
	const confirmsAmbiguousAssignment = current.sourceFacts.providerId !== "manual" && acceptedReview && current.matchConfidence === "ambiguous";
	const assignmentChanges = beachAssignmentChanged || confirmsAmbiguousAssignment ? {
		matchMethod: "adminOverride" as const,
		matchConfidence: "admin" as const,
		matchRuleId: confirmsAmbiguousAssignment ? "admin-reviewed-ambiguous-source-location" : "admin-event-beach-assignment",
		matchExplanation: confirmsAmbiguousAssignment ? "Administrator confirmed the beach after an ambiguous source-location change" : "Administrator changed the imported event's exact beach assignment",
	} : {};
	const candidate = { ...current, ...changes, ...assignmentChanges, id: current.id, createdAt: current.createdAt, sourceFacts: current.sourceFacts };
	const errors = validateManualEvent(candidate, now);
	if (errors.length) return respond({ error: "invalid_event", fields: errors }, 400);
	if (!beaches.some((beach) => beach.id === candidate.beachId)) return respond({ error: "unknown_beach" }, 400);
	const changedFields = Object.fromEntries(Object.entries({ ...changes, ...assignmentChanges }).filter(([key, value]) => JSON.stringify((current as unknown as Record<string, unknown>)[key]) !== JSON.stringify(value)));
	const clearedReviewFields = acceptedReview || acknowledgeAttention
		? ["attentionFlags", "sourceChange", "possibleDuplicateOf", "duplicateAssessment"].filter((key) => (current as unknown as Record<string, unknown>)[key] !== undefined)
		: [];
	const changedFieldNames = [...Object.keys(changedFields), ...clearedReviewFields];
	const previousValues = Object.fromEntries(changedFieldNames.map((key) => [key, (current as unknown as Record<string, unknown>)[key]]));
	const nextValues = { ...changedFields, ...Object.fromEntries(clearedReviewFields.map((key) => [key, null])) };
	const overrideFields = new Set(current.manualOverrideFields ?? []);
	if (current.sourceFacts.providerId !== "manual") for (const key of Object.keys(changedFields)) if (SOURCE_OVERRIDE_FIELDS.has(key)) overrideFields.add(key);
	if (!Object.keys(changedFields).length && !acknowledgeAttention && !acceptedReview) return respond({ event: current });
	const next = {
		...candidate,
		sourceRevision: current.sourceRevision ?? sourceRevision(current.sourceFacts),
		lastSeenAt: current.lastSeenAt ?? current.updatedAt,
		manualOverrideFields: [...overrideFields].sort(),
		updatedAt: now.toISOString(),
	} as BeachEvent;
	if (acceptedReview || acknowledgeAttention) {
		next.reviewedSourceRevision = current.sourceRevision ?? sourceRevision(current.sourceFacts);
		delete next.attentionFlags;
		delete next.sourceChange;
		delete next.possibleDuplicateOf;
		if (current.duplicateAssessment) next.duplicateAcknowledgment = { acknowledgedAt: current.duplicateAcknowledgment?.assessmentRevision === stableHash(JSON.stringify(current.duplicateAssessment)) ? current.duplicateAcknowledgment.acknowledgedAt : now.toISOString(), assessmentRevision: stableHash(JSON.stringify(current.duplicateAssessment)), reason: "reviewed" };
		delete next.duplicateAssessment;
	}
	await env.BEACH_DATA.put(`${EVENT_PREFIX}${id}`, JSON.stringify(next));
	const publicOutputAffected = changedFieldNames.some((key) => PUBLIC_EVENT_FIELDS.has(key)) && (current.status === "published" || next.status === "published");
	await audit(env, identity, acknowledgeAttention ? "acknowledge_event_attention" : "update_event", id, { previous: previousValues, next: nextValues }, now, { previousState: current.status, newState: next.status, changedFields: changedFieldNames, sourceRevision: next.sourceRevision ?? sourceRevision(next.sourceFacts), publicOutputAffected });
	await saveSnapshot(env, now);
	return respond({ event: next });
}

export async function handleBeachEventsAdminDelete(env: Env, identity: AdminIdentity, id: string, now = new Date()): Promise<Response> {
	const current = await env.BEACH_DATA.get<BeachEvent>(`${EVENT_PREFIX}${id}`, "json");
	if (!current) return respond({ error: "not_found" }, 404);
	if (current.status === "completed" || current.status === "expired" || current.archivedAt) return respond({ error: "delete_not_allowed" }, 409);
	if (current.sourceFacts.providerId !== "manual" && current.status !== "disregarded") return respond({ error: "delete_not_allowed" }, 409);
	await env.BEACH_DATA.delete(`${EVENT_PREFIX}${id}`);
	await audit(env, identity, "delete_event", id, { title: current.title }, now, { previousState: current.status, newState: null, changedFields: ["deleted"], sourceRevision: current.sourceRevision ?? sourceRevision(current.sourceFacts), publicOutputAffected: current.status === "published" });
	await saveSnapshot(env, now);
	return respond({ status: "deleted" });
}

export async function handleBeachEventsAdminNormalize(request: Request, env: Env, identity: AdminIdentity, now = new Date()): Promise<Response> {
	const dryRun = new URL(request.url).searchParams.get("dryRun") === "true";
	const result = await renormalizeExistingEvents(env, now, dryRun);
	if (dryRun) return respond({ ...result, dryRun: true, publicSnapshotChanged: false });
	if (result.failed) return respond({ ...result, error: "partial_normalization_failure", publicSnapshotChanged: false }, 500);
	if (!result.changed) return respond({ ...result, dryRun: false, publicSnapshotChanged: false });
	await audit(env, identity, "renormalize_events", "all", result, now, { changedFields: ["normalization"], publicOutputAffected: true });
	const snapshot = await saveSnapshot(env, now);
	return respond({ ...result, dryRun: false, newRevision: snapshot.revision, publicSnapshotChanged: true });
}

export async function handleBeachEventRuleCreate(request: Request, env: Env, identity: AdminIdentity, now = new Date()): Promise<Response> {
	let input: Record<string, unknown>; try { input = await request.json(); } catch { return respond({ error: "invalid_json" }, 400); }
	if (!["disregard", "autoApprove", "suggest"].includes(String(input.action)) || typeof input.providerId !== "string" || !input.providerId || (!input.venue && !input.address && !input.titlePattern)) return respond({ error: "invalid_rule" }, 400);
	if (input.action === "autoApprove" && (!input.venue || !input.beachId)) return respond({ error: "auto_approve_requires_exact_venue_and_beach" }, 400);
	if (input.action === "suggest" && ((!input.venue && !input.address) || !input.beachId)) return respond({ error: "alias_requires_exact_location_and_beach" }, 400);
	const rule: DecisionRule = { id: crypto.randomUUID(), action: input.action as DecisionRule["action"], providerId: input.providerId.slice(0, 80), ...(typeof input.venue === "string" ? { venue: input.venue.slice(0, 200) } : {}), ...(typeof input.address === "string" ? { address: input.address.slice(0, 240) } : {}), ...(typeof input.titlePattern === "string" ? { titlePattern: input.titlePattern.slice(0, 160) } : {}), ...(typeof input.beachId === "string" ? { beachId: input.beachId.slice(0, 80) } : {}), enabled: true, createdAt: now.toISOString(), createdBy: identity.subject.slice(0, 200) };
	await env.BEACH_DATA.put(`${RULE_PREFIX}${rule.id}`, JSON.stringify(rule));
	await audit(env, identity, "create_rule", rule.id, rule, now, { changedFields: Object.keys(rule), publicOutputAffected: false });
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
	const eventId = importedEventId(candidate.sourceFacts);
	const revision = sourceRevision(candidate.sourceFacts);
	const event: BeachEvent = {
		id: eventId, beachId, title: candidate.title, venue: candidate.venue, ...(candidate.address ? { address: candidate.address } : {}),
		startAt: candidate.startAt, endAt: candidate.endAt, allDay: candidate.sourceFacts.allDay, recurring: candidate.sourceFacts.recurring,
		...presentation, status: "pendingReview", sourceName: candidate.sourceName, sourceURL: candidate.sourceURL,
		matchMethod: "adminOverride", matchConfidence: "admin", matchRuleId: "admin-candidate-assignment", matchExplanation: "Administrator assigned the excluded candidate to an exact beach",
		sourceFacts: candidate.sourceFacts, sourceRevision: revision, lastSeenAt: now.toISOString(), createdAt: now.toISOString(), updatedAt: now.toISOString(),
	};
	const duplicate = selectDuplicateCandidates(event, await listEvents(env)).candidates[0];
	const next = duplicate ? { ...event, possibleDuplicateOf: duplicate.candidate.id, duplicateAssessment: duplicate.assessment, attentionFlags: ["possibleDuplicate" as const] } : event;
	await env.BEACH_DATA.put(`${EVENT_PREFIX}${eventId}`, JSON.stringify(next));
	await env.BEACH_DATA.put(key, JSON.stringify({ ...candidate, suggestedBeachId: beachId, decision: "admin", lastSeenAt: now.toISOString() }), { expirationTtl: 90 * 24 * 60 * 60 });
	await audit(env, identity, "assign_excluded_candidate", id, { beachId, eventId, ...(duplicate ? { possibleDuplicateOf: duplicate.candidate.id, duplicateAssessment: duplicate.assessment } : {}) }, now, { previousState: null, newState: "pendingReview", changedFields: ["beachId", "matchMethod", ...(duplicate ? ["possibleDuplicateOf", "duplicateAssessment"] : [])], sourceRevision: revision, publicOutputAffected: false });
	await saveSnapshot(env, now);
	return respond({ event: next }, 201);
}

export async function handleBeachEventSuggest(request: Request): Promise<Response> {
	let input: Record<string, unknown>; try { input = await request.json(); } catch { return respond({ error: "invalid_json" }, 400); }
	return respond(suggestPresentation(String(input.title ?? ""), String(input.description ?? "")));
}
