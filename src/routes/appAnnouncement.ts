import type { Env } from "../types";
import { APP_ANNOUNCEMENT_CACHE_KEY, deleteCache, readCache, writeCache } from "../services/cache/kv";
import { ANNOUNCEMENT_ACTION_URL_ERROR, isApprovedAnnouncementActionUrl } from "../security/announcementActionUrl";

export const ANNOUNCEMENT_SEVERITIES = ["information", "notice", "important", "critical"] as const;
export type AppAnnouncementSeverity = typeof ANNOUNCEMENT_SEVERITIES[number];
export const ANNOUNCEMENT_BEACH_IDS = ["gulf-shores", "orange-beach", "fort-morgan", "dauphin-island"] as const;
export type AppAnnouncementBeachId = typeof ANNOUNCEMENT_BEACH_IDS[number];
export type AppAnnouncementScope = "all" | "beaches";

export interface StoredAppAnnouncement {
	id: string;
	revision: string;
	title: string;
	message: string;
	severity: AppAnnouncementSeverity;
	startsAt: string;
	expiresAt: string;
	actionTitle: string | null;
	actionUrl: string | null;
	scope: AppAnnouncementScope;
	beachIds: AppAnnouncementBeachId[];
}

const ALLOWED_FIELDS = new Set(["id", "title", "message", "severity", "startsAt", "expiresAt", "actionTitle", "actionUrl", "scope", "beachIds"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CONTROL_OR_MARKUP_PATTERN = /[<>\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const AUTHORITY_IMPERSONATION_PATTERN = /\b(apple|national weather service|nws|noaa|police|sheriff|law enforcement|emergency services?|emergency management|fema|government|coast guard|fire department|city of|county of|state of)\b/i;
const CACHE_CONTROL = "public, max-age=60, s-maxage=180";
export const APP_ANNOUNCEMENT_ADMIN_ORIGINS = new Set([
	"https://alabamabeachflag.com",
	"https://www.alabamabeachflag.com",
]);

export function announcementCorsHeaders(request: Request): HeadersInit {
	const origin = request.headers.get("Origin");
	if (!origin || !APP_ANNOUNCEMENT_ADMIN_ORIGINS.has(origin)) return {};
	return {
		"Access-Control-Allow-Origin": origin,
		"Access-Control-Allow-Credentials": "true",
		"Vary": "Origin",
	};
}

export function withAnnouncementCors(response: Response, request: Request): Response {
	const wrapped = new Response(response.body, response);
	for (const [key, value] of Object.entries(announcementCorsHeaders(request))) wrapped.headers.set(key, value);
	return wrapped;
}

export function handleAnnouncementOptions(request: Request): Response {
	const origin = request.headers.get("Origin");
	const method = request.headers.get("Access-Control-Request-Method")?.toUpperCase();
	if (!origin || !APP_ANNOUNCEMENT_ADMIN_ORIGINS.has(origin) || !method || !["PUT", "DELETE"].includes(method)) {
		return response({ error: "Forbidden" }, { status: 403, headers: { "Cache-Control": "no-store" } });
	}
	return new Response(null, {
		status: 204,
		headers: {
			...announcementCorsHeaders(request),
			"Access-Control-Allow-Methods": "PUT, DELETE, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type, Accept",
			"Access-Control-Max-Age": "600",
			"Cache-Control": "no-store",
		},
	});
}

export function hasTrustedAnnouncementOrigin(request: Request): boolean {
	const origin = request.headers.get("Origin");
	// Non-browser service-token clients do not send Origin and remain supported.
	return origin === null || APP_ANNOUNCEMENT_ADMIN_ORIGINS.has(origin);
}

function response(body: unknown, init: ResponseInit = {}): Response {
	return Response.json(body, { ...init, headers: { "Content-Type": "application/json; charset=utf-8", ...init.headers } });
}

function error(message: string): Response {
	return response({ error: "invalid_app_announcement", message }, { status: 400, headers: { "Cache-Control": "no-store" } });
}

function validPlainText(value: unknown, maximum: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !CONTROL_OR_MARKUP_PATTERN.test(value);
}

function timestamp(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
	if (!match) return null;
	const date = new Date(value);
	if (Number.isNaN(date.valueOf())) return null;
	const canonicalInput = `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
	return date.toISOString() === canonicalInput ? date.toISOString() : null;
}

export function validateAnnouncementInput(value: unknown, _env: Env, now = new Date()): StoredAppAnnouncement | Response {
	if (!value || typeof value !== "object" || Array.isArray(value)) return error("A JSON object is required.");
	const input = value as Record<string, unknown>;
	if (Object.keys(input).some((key) => !ALLOWED_FIELDS.has(key))) return error("Unexpected fields are not allowed.");
	if (typeof input.id !== "string" || !ID_PATTERN.test(input.id)) return error("id must be a stable 1-128 character identifier.");
	if (!validPlainText(input.title, 80)) return error("title must be 1-80 plain-text characters.");
	if (!validPlainText(input.message, 500)) return error("message must be 1-500 plain-text characters.");
	const authorityText = `${input.title} ${input.message}`.replace(/\bNWS data\b/gi, "weather-provider data");
	if (AUTHORITY_IMPERSONATION_PATTERN.test(authorityText)) return error("App notices cannot present themselves as an external authority.");
	if (!ANNOUNCEMENT_SEVERITIES.includes(input.severity as AppAnnouncementSeverity)) return error("severity is unsupported.");
	const startsAt = timestamp(input.startsAt);
	const expiresAt = timestamp(input.expiresAt);
	if (!startsAt || !expiresAt) return error("startsAt and expiresAt must be ISO-8601 UTC timestamps.");
	if (new Date(expiresAt) <= new Date(startsAt)) return error("expiresAt must be later than startsAt.");

	const actionTitle = input.actionTitle ?? null;
	const actionUrl = input.actionUrl ?? null;
	if ((actionTitle === null) !== (actionUrl === null)) return error("actionTitle and actionUrl must be supplied together.");
	if (actionTitle !== null && !validPlainText(actionTitle, 40)) return error("actionTitle must be 1-40 plain-text characters.");
	if (actionUrl !== null) {
		if (typeof actionUrl !== "string" || actionUrl.length > 2048) return error("actionUrl is invalid.");
		if (!isApprovedAnnouncementActionUrl(actionUrl)) return error(ANNOUNCEMENT_ACTION_URL_ERROR);
	}
	const scope = input.scope ?? "all";
	if (scope !== "all" && scope !== "beaches") return error("scope must be all or beaches.");
	const beachIds = input.beachIds ?? [];
	if (!Array.isArray(beachIds) || beachIds.some((id) => typeof id !== "string" || !ANNOUNCEMENT_BEACH_IDS.includes(id as AppAnnouncementBeachId))) {
		return error("beachIds contains an unsupported beach ID.");
	}
	if (new Set(beachIds).size !== beachIds.length) return error("beachIds must not contain duplicates.");
	if (scope === "all" && beachIds.length > 0) return error("beachIds must be empty when scope is all.");
	if (scope === "beaches" && beachIds.length === 0) return error("Select at least one beach when scope is beaches.");

	return {
		id: input.id,
		revision: now.toISOString(),
		title: input.title.trim(),
		message: input.message.trim(),
		severity: input.severity as AppAnnouncementSeverity,
		startsAt,
		expiresAt,
		actionTitle: actionTitle === null ? null : actionTitle.trim(),
		actionUrl: actionUrl as string | null,
		scope,
		beachIds: beachIds as AppAnnouncementBeachId[],
	};
}

export function isAnnouncementActive(announcement: StoredAppAnnouncement, now = new Date()): boolean {
	return now >= new Date(announcement.startsAt) && now < new Date(announcement.expiresAt);
}

function storedAnnouncementRevision(announcement: StoredAppAnnouncement): string {
	return typeof announcement.revision === "string" && announcement.revision ? announcement.revision : `legacy-${announcement.id}-${announcement.startsAt}-${announcement.expiresAt}`;
}

export async function handleAppAnnouncementAdminRequest(env: Env, now = new Date()): Promise<Response> {
	const stored = await readCache<StoredAppAnnouncement>(env.BEACH_DATA, APP_ANNOUNCEMENT_CACHE_KEY);
	if (!stored) return response({ status: "none", announcement: null }, { headers: { "Cache-Control": "no-store" } });
	const announcement = { ...publicAnnouncement(stored), revision: storedAnnouncementRevision(stored) };
	const status = now < new Date(announcement.startsAt) ? "scheduled" : now >= new Date(announcement.expiresAt) ? "expired" : "active";
	return response({ status, announcement }, { headers: { "Cache-Control": "no-store" } });
}

function publicAnnouncement(announcement: StoredAppAnnouncement): StoredAppAnnouncement {
	const { id, revision, title, message, severity, startsAt, expiresAt, actionTitle, actionUrl } = announcement;
	const scope = announcement.scope === "beaches" ? "beaches" : "all";
	const beachIds = scope === "beaches" && Array.isArray(announcement.beachIds) ? announcement.beachIds : [];
	return { id, revision, title, message, severity, startsAt, expiresAt, actionTitle, actionUrl, scope, beachIds };
}

export async function handleAppAnnouncementRequest(request: Request, env: Env, now = new Date()): Promise<Response> {
	const stored = await readCache<StoredAppAnnouncement>(env.BEACH_DATA, APP_ANNOUNCEMENT_CACHE_KEY);
	const announcement = stored && isAnnouncementActive(stored, now) ? publicAnnouncement(stored) : null;
	const revision = announcement?.revision ?? "inactive";
	const etag = `\"app-announcement-${revision}\"`;
	const headers = { "Cache-Control": CACHE_CONTROL, ETag: etag };
	if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });
	return response({ status: "ok", announcement }, { headers });
}

export async function handlePutAppAnnouncementRequest(request: Request, env: Env): Promise<Response> {
	const current = await readCache<StoredAppAnnouncement>(env.BEACH_DATA, APP_ANNOUNCEMENT_CACHE_KEY);
	if (current && request.headers.get("If-Match") !== storedAnnouncementRevision(current)) return response({ error: "revision_conflict", currentRevision: storedAnnouncementRevision(current) }, { status: 412, headers: { "Cache-Control": "no-store" } });
	let input: unknown;
	try { input = await request.json(); } catch { return error("Valid JSON is required."); }
	const announcement = validateAnnouncementInput(input, env);
	if (announcement instanceof Response) return announcement;
	announcement.revision = crypto.randomUUID();
	await writeCache(env.BEACH_DATA, APP_ANNOUNCEMENT_CACHE_KEY, announcement);
	return response({ status: "ok", announcement }, { headers: { "Cache-Control": "no-store" } });
}

export async function handleDeleteAppAnnouncementRequest(request: Request, env: Env): Promise<Response> {
	const current = await readCache<StoredAppAnnouncement>(env.BEACH_DATA, APP_ANNOUNCEMENT_CACHE_KEY);
	if (!current) return response({ status: "ok", announcement: null }, { headers: { "Cache-Control": "no-store" } });
	if (request.headers.get("If-Match") !== storedAnnouncementRevision(current)) return response({ error: "revision_conflict", currentRevision: storedAnnouncementRevision(current) }, { status: 412, headers: { "Cache-Control": "no-store" } });
	await deleteCache(env.BEACH_DATA, APP_ANNOUNCEMENT_CACHE_KEY);
	return response({ status: "ok", announcement: null }, { headers: { "Cache-Control": "no-store" } });
}
