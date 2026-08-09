import type { Env } from "../types";

const PAGE_SIZES = new Set([10, 25, 50, 100]);
const TYPES = new Set(["beach_flag", "water_temperature", "tide_high", "tide_low", "water_quality_enterococcus", "water_quality_advisory"]);
const AREAS = new Set(["gulfShores", "orangeBeach", "fortMorgan", "dauphinIsland"]);
const FRESHNESS = new Set(["current", "stale", "unknown", "unavailable"]);
const SAFE_IDENTIFIER = /^[a-zA-Z0-9_.:-]{1,128}$/;
const headers = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" };

function invalid(message: string): Response {
	return Response.json({ error: "invalid_parameters", message }, { status: 400, headers });
}

function iso(value: string | null, name: string): string | null | Response {
	if (!value) return null;
	const date = new Date(value);
	if (!Number.isFinite(date.valueOf())) return invalid(`${name} must be an ISO-8601 date/time.`);
	return date.toISOString();
}

function encodeCursor(storedAt: string, id: string): string {
	return btoa(JSON.stringify([storedAt, id]));
}

function decodeCursor(value: string): [string, string] | null {
	try {
		const parsed = JSON.parse(atob(value));
		return Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "string" && typeof parsed[1] === "string" ? [parsed[0], parsed[1]] : null;
	} catch { return null; }
}

export async function handleHistoricalObservations(request: Request, env: Env): Promise<Response> {
	if (!env.HISTORICAL_DATA) return Response.json({ status: "not_configured", configured: false }, { status: 503, headers });
	const search = new URL(request.url).searchParams;
	const allowed = new Set(["type", "area", "beach", "provider", "station", "observedFrom", "observedTo", "storedFrom", "storedTo", "freshness", "quality", "revisions", "pageSize", "cursor"]);
	for (const key of search.keys()) if (!allowed.has(key)) return invalid(`Unsupported parameter: ${key}`);

	const pageSizeText = search.get("pageSize") ?? "25";
	const pageSize = Number(pageSizeText);
	if (!PAGE_SIZES.has(pageSize)) return invalid("pageSize must be 10, 25, 50, or 100.");
	const type = search.get("type"); if (type && !TYPES.has(type)) return invalid("Unsupported observation type.");
	const area = search.get("area"); if (area && !AREAS.has(area)) return invalid("Unsupported beach area.");
	const freshness = search.get("freshness"); if (freshness && !FRESHNESS.has(freshness)) return invalid("Unsupported freshness state.");
	const revisions = search.get("revisions") ?? "current"; if (revisions !== "current" && revisions !== "all") return invalid("revisions must be current or all.");
	for (const name of ["beach", "provider", "station", "quality"] as const) {
		const value = search.get(name); if (value && !SAFE_IDENTIFIER.test(value)) return invalid(`${name} contains unsupported characters.`);
	}
	const dateNames = ["observedFrom", "observedTo", "storedFrom", "storedTo"] as const;
	const dates: Record<string, string | null> = {};
	for (const name of dateNames) { const parsed = iso(search.get(name), name); if (parsed instanceof Response) return parsed; dates[name] = parsed; }
	if (dates.observedFrom && dates.observedTo && dates.observedFrom > dates.observedTo) return invalid("observedFrom must not be after observedTo.");
	if (dates.storedFrom && dates.storedTo && dates.storedFrom > dates.storedTo) return invalid("storedFrom must not be after storedTo.");

	const where: string[] = []; const values: unknown[] = [];
	const add = (sql: string, value: unknown) => { where.push(sql); values.push(value); };
	if (type) add("o.observation_type = ?", type); if (area) add("o.beach_area = ?", area);
	if (search.get("beach")) add("o.beach_id = ?", search.get("beach"));
	if (search.get("provider")) add("o.provider = ?", search.get("provider"));
	if (search.get("station")) add("COALESCE(o.source_station_id, o.station_id) = ?", search.get("station"));
	if (freshness) add("COALESCE(o.freshness_state, 'unknown') = ?", freshness);
	if (search.get("quality")) add("o.quality_flag = ?", search.get("quality"));
	if (dates.observedFrom) add("o.observed_at >= ?", dates.observedFrom); if (dates.observedTo) add("o.observed_at <= ?", dates.observedTo);
	if (dates.storedFrom) add("o.stored_at >= ?", dates.storedFrom); if (dates.storedTo) add("o.stored_at <= ?", dates.storedTo);
	if (revisions === "current") where.push("NOT EXISTS (SELECT 1 FROM historical_observations newer WHERE newer.logical_key = o.logical_key AND newer.revision_number > o.revision_number)");
	const cursorValue = search.get("cursor");
	if (cursorValue) { const cursor = decodeCursor(cursorValue); if (!cursor) return invalid("cursor is invalid."); where.push("(o.stored_at < ? OR (o.stored_at = ? AND o.id < ?))"); values.push(cursor[0], cursor[0], cursor[1]); }
	const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
	const sql = `SELECT o.id, o.logical_key, o.source_observation_key, o.observation_type, o.record_kind,
		o.beach_area, o.beach_id, o.provider, o.station_id, o.source_station_id, o.observed_at,
		o.observation_time_basis, o.fetched_at, o.stored_at, o.value_numeric, o.value_text, o.unit,
		o.quality_flag, o.freshness_state, o.source_identifier, o.source_configuration_version,
		o.provider_metadata, o.revision_number,
		EXISTS(SELECT 1 FROM historical_observations other WHERE other.logical_key = o.logical_key AND other.id <> o.id) AS has_revision_history
		FROM historical_observations o ${clause} ORDER BY o.stored_at DESC, o.id DESC LIMIT ?`;
	const result = await env.HISTORICAL_DATA.prepare(sql).bind(...values, pageSize + 1).all<Record<string, unknown> & { id: string; stored_at: string; provider_metadata?: unknown }>();
	const rows = result.results.slice(0, pageSize).map((row) => ({ ...row, provider_metadata: safeJson(row.provider_metadata) }));
	const hasMore = result.results.length > pageSize;
	const last = rows.at(-1);
	return Response.json({ configured: true, rows, pageSize, hasMore, nextCursor: hasMore && last ? encodeCursor(String(last.stored_at), String(last.id)) : null }, { headers });
}

function safeJson(value: unknown): unknown {
	if (typeof value !== "string") return value ?? {};
	try { return JSON.parse(value); } catch { return {}; }
}
