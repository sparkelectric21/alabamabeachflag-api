import type { AdminIdentity } from "../services/admin/auth";
import type { Env } from "../types";
import { CONTROL_IDS, type ControlId, type ControlState, type EffectiveControl, type FlagProvider, type OperationalControlAudit, type OperationalControlDocument, type OperationalControlValue } from "./types";

export const CURRENT_KEY = "operational-control:v1:current";
export const AUDIT_PREFIX = "operational-control:v1:audit:";
export const SNAPSHOT_PREFIX = "operational-control:v1:snapshot:";

const STATE_RANK: Record<ControlState, number> = { enabled: 0, monitorOnly: 1, disabled: 2 };

export function defaultOperationalControl(now = new Date()): OperationalControlDocument {
	return {
		schemaVersion: 1,
		revision: "default",
		updatedAt: now.toISOString(),
		updatedBy: "system-default",
		controls: Object.fromEntries(CONTROL_IDS.map((id) => [id, { state: "enabled" }])) as OperationalControlDocument["controls"],
		versionPolicy: { mode: "none", minimumSupported: null, recommended: null, revision: null },
	};
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validControl(value: unknown): value is OperationalControlValue {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const item = value as Record<string, unknown>;
	if (Object.keys(item).some((key) => !["state", "reasonCode", "operatorReason", "activatedAt", "expiresAt", "onExpiry", "incidentId"].includes(key))) return false;
	if (!(["enabled", "disabled", "monitorOnly"] as unknown[]).includes(item.state)) return false;
	for (const key of ["reasonCode", "operatorReason", "incidentId"] as const) if (item[key] !== undefined && (typeof item[key] !== "string" || item[key].length > 500)) return false;
	for (const key of ["activatedAt", "expiresAt"] as const) if (item[key] !== undefined && !isTimestamp(item[key])) return false;
	if (item.onExpiry !== undefined && item.onExpiry !== "require_review" && item.onExpiry !== "enable") return false;
	return true;
}

export function parseOperationalControl(value: unknown): OperationalControlDocument | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const doc = value as Record<string, unknown>;
	if (Object.keys(doc).some((key) => !["schemaVersion", "revision", "updatedAt", "updatedBy", "controls", "versionPolicy"].includes(key))) return null;
	if (doc.schemaVersion !== 1 || typeof doc.revision !== "string" || !doc.revision || !isTimestamp(doc.updatedAt) || typeof doc.updatedBy !== "string") return null;
	if (!doc.controls || typeof doc.controls !== "object" || Array.isArray(doc.controls)) return null;
	const controls = doc.controls as Record<string, unknown>;
	if (Object.keys(controls).length !== CONTROL_IDS.length || CONTROL_IDS.some((id) => !validControl(controls[id]))) return null;
	const policy = doc.versionPolicy as Record<string, unknown> | null;
	if (!policy || typeof policy !== "object" || !["none", "recommended", "required"].includes(String(policy.mode))) return null;
	return doc as unknown as OperationalControlDocument;
}

export async function readOperationalControl(env: Env, now = new Date()): Promise<OperationalControlDocument> {
	const stored = await env.BEACH_DATA.get<unknown>(CURRENT_KEY, "json");
	return parseOperationalControl(stored) ?? defaultOperationalControl(now);
}

function effectiveValue(value: OperationalControlValue, now: Date): OperationalControlValue {
	if (!value.expiresAt || now < new Date(value.expiresAt)) return value;
	return value.onExpiry === "enable" ? { state: "enabled" } : { ...value, state: "disabled" };
}

export function evaluateFlagControl(doc: OperationalControlDocument, provider: FlagProvider, now = new Date()): EffectiveControl {
	const ids: ControlId[] = ["global.liveData", "domains.beachFlags", provider === "gulfShoresFlags" ? "providers.gulfShoresFlags" : "providers.orangeBeachFlags"];
	let selected: { id: ControlId; value: OperationalControlValue } | null = null;
	for (const id of ids) {
		const value = effectiveValue(doc.controls[id], now);
		if (!selected || STATE_RANK[value.state] > STATE_RANK[selected.value.state]) selected = { id, value };
	}
	return {
		state: selected?.value.state ?? "enabled",
		controlId: selected?.value.state === "enabled" ? null : selected?.id ?? null,
		revision: doc.revision,
		effectiveAt: selected?.value.activatedAt ?? null,
		retryAfter: selected?.value.expiresAt ?? null,
		wouldBlock: selected?.value.state === "disabled",
	};
}

export async function persistTransition(env: Env, current: OperationalControlDocument, next: OperationalControlDocument, audit: OperationalControlAudit): Promise<void> {
	await env.BEACH_DATA.put(`${SNAPSHOT_PREFIX}${current.revision}`, JSON.stringify(current));
	await env.BEACH_DATA.put(`${SNAPSHOT_PREFIX}${next.revision}`, JSON.stringify(next));
	await env.BEACH_DATA.put(`${AUDIT_PREFIX}${audit.timestamp}:${audit.auditId}`, JSON.stringify(audit));
	await env.BEACH_DATA.put(CURRENT_KEY, JSON.stringify(next));
}

export function actorLabel(identity: AdminIdentity): string {
	return identity.subject.slice(0, 200);
}
