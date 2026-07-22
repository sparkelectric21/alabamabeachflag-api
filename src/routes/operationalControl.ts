import type { AdminIdentity } from "../services/admin/auth";
import type { Env } from "../types";
import { AUDIT_PREFIX, SNAPSHOT_PREFIX, actorLabel, defaultOperationalControl, evaluateFlagControl, parseOperationalControl, persistTransition, readOperationalControl } from "../operationalControl/store";
import { CONTROL_IDS, type ControlId, type ControlState, type OperationalControlAudit, type OperationalControlDocument, type OperationalControlValue } from "../operationalControl/types";

const REASONS = new Set(["source_format_change", "verification_failed", "provider_outage", "data_integrity", "incident_response", "manual_restore", "rollback"]);
const headers = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" };
const respond = (body: unknown, status = 200) => Response.json(body, { status, headers });

function publicConfig(doc: OperationalControlDocument, now: Date) {
	const gulf = evaluateFlagControl(doc, "gulfShoresFlags", now);
	const orange = evaluateFlagControl(doc, "orangeBeachFlags", now);
	const status = gulf.state === "disabled" && orange.state === "disabled" ? "unavailable" : gulf.state === "disabled" || orange.state === "disabled" ? "partial" : "available";
	return { schemaVersion: 1, controlRevision: doc.revision, generatedAt: now.toISOString(), cacheUntil: new Date(now.valueOf() + 30_000).toISOString(), domains: { beachFlags: status }, providers: { gulfShoresFlags: gulf.state, orangeBeachFlags: orange.state }, versionPolicy: doc.versionPolicy };
}

export async function handleAppConfiguration(env: Env, now = new Date()): Promise<Response> {
	return respond(publicConfig(await readOperationalControl(env, now), now));
}

export async function handleOperationalControlGet(env: Env, now = new Date()): Promise<Response> {
	const doc = await readOperationalControl(env, now);
	return respond({ configuration: doc, effective: { gulfShoresFlags: evaluateFlagControl(doc, "gulfShoresFlags", now), orangeBeachFlags: evaluateFlagControl(doc, "orangeBeachFlags", now) } });
}

function validText(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[<>\u0000-\u001f\u007f]/.test(value); }

export async function handleOperationalControlPatch(request: Request, env: Env, identity: AdminIdentity, now = new Date()): Promise<Response> {
	const current = await readOperationalControl(env, now);
	if (request.headers.get("If-Match") !== current.revision) return respond({ error: "revision_conflict", currentRevision: current.revision }, 412);
	let input: Record<string, unknown>; try { input = await request.json(); } catch { return respond({ error: "invalid_json" }, 400); }
	if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["controlId", "state", "reasonCode", "operatorReason", "incidentId", "expiresAt", "onExpiry"].includes(key))) return respond({ error: "invalid_transition" }, 400);
	if (!CONTROL_IDS.includes(input.controlId as ControlId) || !(["enabled", "disabled", "monitorOnly"] as unknown[]).includes(input.state)) return respond({ error: "invalid_transition" }, 400);
	if (!REASONS.has(String(input.reasonCode)) || !validText(input.operatorReason, 500)) return respond({ error: "reason_required" }, 400);
	const controlId = input.controlId as ControlId; const state = input.state as ControlState;
	if (state !== "enabled" && input.expiresAt === undefined) return respond({ error: "expiry_required" }, 400);
	if (input.expiresAt !== undefined && (typeof input.expiresAt !== "string" || Number.isNaN(Date.parse(input.expiresAt)) || new Date(input.expiresAt) <= now)) return respond({ error: "invalid_expiry" }, 400);
	if (input.onExpiry !== undefined && input.onExpiry !== "require_review" && input.onExpiry !== "enable") return respond({ error: "invalid_expiry_behavior" }, 400);
	const previous = current.controls[controlId];
	const nextValue: OperationalControlValue = state === "enabled" ? { state } : { state, reasonCode: String(input.reasonCode), operatorReason: input.operatorReason.trim(), activatedAt: now.toISOString(), expiresAt: input.expiresAt as string, onExpiry: (input.onExpiry as "enable" | "require_review") ?? "require_review", ...(validText(input.incidentId, 128) ? { incidentId: input.incidentId.trim() } : {}) };
	const next: OperationalControlDocument = { ...current, revision: crypto.randomUUID(), updatedAt: now.toISOString(), updatedBy: actorLabel(identity), controls: { ...current.controls, [controlId]: nextValue } };
	const audit: OperationalControlAudit = { schemaVersion: 1, auditId: crypto.randomUUID(), requestId: request.headers.get("cf-ray")?.slice(0, 128) ?? crypto.randomUUID(), timestamp: now.toISOString(), actor: actorLabel(identity), authenticationMethod: identity.method, action: "transition", controlId, previousState: previous.state, nextState: state, reasonCode: String(input.reasonCode), operatorReason: input.operatorReason.trim(), incidentId: validText(input.incidentId, 128) ? input.incidentId.trim() : null, resultingRevision: next.revision };
	await persistTransition(env, current, next, audit);
	return respond({ configuration: next });
}

export async function handleOperationalControlRollback(request: Request, env: Env, identity: AdminIdentity, now = new Date()): Promise<Response> {
	const current = await readOperationalControl(env, now);
	if (request.headers.get("If-Match") !== current.revision) return respond({ error: "revision_conflict", currentRevision: current.revision }, 412);
	let input: Record<string, unknown>; try { input = await request.json(); } catch { return respond({ error: "invalid_json" }, 400); }
	if (Object.keys(input).some((key) => !["revision", "operatorReason"].includes(key)) || !validText(input.revision, 128) || !validText(input.operatorReason, 500)) return respond({ error: "invalid_rollback" }, 400);
	const snapshot = parseOperationalControl(await env.BEACH_DATA.get<unknown>(`${SNAPSHOT_PREFIX}${input.revision}`, "json"));
	if (!snapshot) return respond({ error: "snapshot_not_found" }, 404);
	const next = { ...snapshot, revision: crypto.randomUUID(), updatedAt: now.toISOString(), updatedBy: actorLabel(identity) };
	const audit: OperationalControlAudit = { schemaVersion: 1, auditId: crypto.randomUUID(), requestId: request.headers.get("cf-ray")?.slice(0, 128) ?? crypto.randomUUID(), timestamp: now.toISOString(), actor: actorLabel(identity), authenticationMethod: identity.method, action: "rollback", controlId: null, previousState: null, nextState: null, reasonCode: "rollback", operatorReason: input.operatorReason.trim(), incidentId: null, resultingRevision: next.revision };
	await persistTransition(env, current, next, audit);
	return respond({ configuration: next });
}

export async function handleOperationalControlAudit(request: Request, env: Env): Promise<Response> {
	const cursor = new URL(request.url).searchParams.get("cursor") ?? undefined;
	const listed = await env.BEACH_DATA.list({ prefix: AUDIT_PREFIX, limit: 100, ...(cursor ? { cursor } : {}) });
	const records = (await Promise.all(listed.keys.map((key) => env.BEACH_DATA.get<OperationalControlAudit>(key.name, "json")))).filter(Boolean);
	return respond({ audit: records.sort((a, b) => String(b?.timestamp).localeCompare(String(a?.timestamp))), cursor: listed.list_complete ? null : listed.cursor });
}

export { defaultOperationalControl };
