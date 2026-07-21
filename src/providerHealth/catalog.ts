import type { AdminIdentity } from "../services/admin/auth";
import type { Env } from "../types";

export const PROVIDER_CATALOG_PREFIX = "provider-catalog:v1:";
export const PROVIDER_CATALOG_AUDIT_PREFIX = "provider-catalog:v1:audit:";
export const PROVIDER_CATALOG_ROLES = ["Primary", "Secondary", "Standby", "Automatic Fallback", "Monitoring Only", "Internal Protection", "Disabled"] as const;
export type ProviderCatalogRole = typeof PROVIDER_CATALOG_ROLES[number];

export interface ProviderCatalogRecord {
	schemaVersion: 1;
	provider: string;
	domain: string;
	displayName: string;
	category: string;
	role: ProviderCatalogRole;
	description: string;
	usedFor: string[];
	productionUsage: string;
	internalNotes: string;
	officialSource: boolean;
	websiteVisible: boolean;
	editable: boolean;
	updatedAt: string | null;
	updatedBy: string | null;
}

type EditableCatalogFields = Pick<ProviderCatalogRecord, "role" | "description" | "usedFor" | "productionUsage" | "internalNotes">;

const defaults: ProviderCatalogRecord[] = [
	{ provider: "weatherkit", domain: "ios_current_weather", displayName: "WeatherKit", category: "Weather", role: "Primary", description: "Apple WeatherKit provides current weather conditions for the iOS application.", usedFor: ["Current weather", "Temperature", "Wind", "Humidity", "Hourly forecast"], productionUsage: "Currently serving production users.", internalNotes: "Primary weather source for iOS.", officialSource: true, websiteVisible: true, editable: true },
	{ provider: "nws", domain: "hourly_forecast", displayName: "NWS Hourly Forecast", category: "Weather", role: "Primary", description: "Official National Weather Service forecast used by backend services.", usedFor: ["Forecast enrichment", "Weather verification", "Rip current support", "Severe weather support"], productionUsage: "Actively used.", internalNotes: "", officialSource: true, websiteVisible: true, editable: true },
	{ provider: "noaa", domain: "tide_predictions", displayName: "NOAA Tide Predictions", category: "Tide", role: "Primary", description: "Official NOAA tide prediction service.", usedFor: ["High/low tides", "Tide curves", "Tide detail", "Widgets"], productionUsage: "Active.", internalNotes: "", officialSource: true, websiteVisible: true, editable: true },
	{ provider: "noaa", domain: "marine_beach_forecast", displayName: "NOAA Marine Forecast", category: "Marine", role: "Primary", description: "Official marine forecast.", usedFor: ["Marine forecast", "Beach conditions"], productionUsage: "Active.", internalNotes: "", officialSource: true, websiteVisible: true, editable: true },
	{ provider: "water_temperature_sources", domain: "general_selection", displayName: "Water Temperature Providers", category: "Water Temperature", role: "Primary", description: "Approved Gulf water-temperature observations.", usedFor: ["Water temperature", "Beach details", "Widgets"], productionUsage: "Active where configured.", internalNotes: "", officialSource: true, websiteVisible: true, editable: true },
	{ provider: "open_meteo", domain: "current_uv:orangeBeach", displayName: "Open-Meteo UV · Orange Beach", category: "UV", role: "Standby", description: "Independent UV provider maintained for operational readiness.", usedFor: ["Future backup", "Monitoring", "Operational comparison"], productionUsage: "Standby only. Not currently used automatically.", internalNotes: "WeatherKit currently provides production UV.", officialSource: false, websiteVisible: true, editable: true },
	{ provider: "open_meteo", domain: "current_uv:fortMorgan", displayName: "Open-Meteo UV · Fort Morgan", category: "UV", role: "Standby", description: "Independent UV provider maintained for operational readiness.", usedFor: ["Future backup", "Monitoring", "Operational comparison"], productionUsage: "Standby only. Not currently used automatically.", internalNotes: "WeatherKit currently provides production UV.", officialSource: false, websiteVisible: true, editable: true },
	{ provider: "open_meteo", domain: "current_uv:dauphinIsland", displayName: "Open-Meteo UV · Dauphin Island", category: "UV", role: "Standby", description: "Independent UV provider maintained for operational readiness.", usedFor: ["Future backup", "Monitoring", "Operational comparison"], productionUsage: "Standby only. Not currently used automatically.", internalNotes: "WeatherKit currently provides production UV.", officialSource: false, websiteVisible: true, editable: true },
	{ provider: "publication_quality_gate", domain: "beach_conditions", displayName: "Publication Quality Gate", category: "System", role: "Internal Protection", description: "Protects production against catastrophic refresh degradation.", usedFor: ["Snapshot validation", "Last-known-good preservation", "Refresh protection"], productionUsage: "Always active.", internalNotes: "", officialSource: false, websiteVisible: false, editable: true },
].map((record) => ({ schemaVersion: 1, updatedAt: null, updatedBy: null, ...record, role: record.role as ProviderCatalogRole }));

const safeId = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9._:-]{1,80}$/i.test(value);
const safeText = (value: unknown, max = 2000): string | null => typeof value === "string" && value.length <= max ? value.trim() : null;
const keyFor = (provider: string, domain: string) => `${PROVIDER_CATALOG_PREFIX}${provider}:${domain}`;

function sanitizeOverride(value: unknown): Partial<EditableCatalogFields> | null {
	if (!value || typeof value !== "object") return null;
	const input = value as Record<string, unknown>, result: Partial<EditableCatalogFields> = {};
	if (typeof input.role === "string" && PROVIDER_CATALOG_ROLES.includes(input.role as ProviderCatalogRole)) result.role = input.role as ProviderCatalogRole;
	for (const field of ["description", "productionUsage", "internalNotes"] as const) {
		const parsed = safeText(input[field]); if (parsed !== null) result[field] = parsed;
	}
	if (Array.isArray(input.usedFor) && input.usedFor.length <= 20) {
		const entries = input.usedFor.map((item) => safeText(item, 120));
		if (entries.every((item): item is string => item !== null && item.length > 0)) result.usedFor = entries;
	}
	return result;
}

export async function loadProviderCatalog(env: Pick<Env, "BEACH_DATA">): Promise<ProviderCatalogRecord[]> {
	return await Promise.all(defaults.map(async (record) => {
		try {
			const raw = await env.BEACH_DATA.get<unknown>(keyFor(record.provider, record.domain), "json");
			if (!raw || typeof raw !== "object") return { ...record };
			const override = sanitizeOverride(raw);
			const stored = raw as Record<string, unknown>;
			return { ...record, ...(override ?? {}), updatedAt: safeText(stored.updatedAt, 64), updatedBy: safeText(stored.updatedBy, 160) };
		} catch { return { ...record }; }
	}));
}

export async function loadProviderCatalogAudit(env: Pick<Env, "BEACH_DATA">): Promise<unknown[]> {
	const keys = await env.BEACH_DATA.list({ prefix: PROVIDER_CATALOG_AUDIT_PREFIX, limit: 100 });
	const records = await Promise.all(keys.keys.map((key) => env.BEACH_DATA.get<unknown>(key.name, "json")));
	return records.filter((record) => record && typeof record === "object").sort((a, b) => String((b as any).timestamp).localeCompare(String((a as any).timestamp))).slice(0, 50);
}

export async function handleProviderCatalogUpdate(request: Request, env: Pick<Env, "BEACH_DATA">, identity: AdminIdentity): Promise<Response> {
	let body: unknown;
	try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
	if (!body || typeof body !== "object") return Response.json({ error: "Invalid catalog update" }, { status: 400 });
	const input = body as Record<string, unknown>;
	if (!safeId(input.provider) || !safeId(input.domain)) return Response.json({ error: "Invalid provider or domain" }, { status: 400 });
	const catalog = await loadProviderCatalog(env);
	const current = catalog.find((record) => record.provider === input.provider && record.domain === input.domain);
	if (!current || !current.editable) return Response.json({ error: "Catalog record not found" }, { status: 404 });
	const changes = sanitizeOverride(input.changes);
	if (!changes || Object.keys(changes).length === 0) return Response.json({ error: "No valid editable fields" }, { status: 400 });
	const updatedAt = new Date().toISOString();
	const updatedBy = identity.subject.slice(0, 160);
	const next = { role: current.role, description: current.description, usedFor: current.usedFor, productionUsage: current.productionUsage, internalNotes: current.internalNotes, ...changes, updatedAt, updatedBy };
	const audit = Object.entries(changes).filter(([field, value]) => JSON.stringify(current[field as keyof ProviderCatalogRecord]) !== JSON.stringify(value)).map(([field, value]) => ({ schemaVersion: 1, timestamp: updatedAt, provider: current.provider, domain: current.domain, field, previousValue: current[field as keyof ProviderCatalogRecord], newValue: value, administrator: updatedBy }));
	if (audit.length === 0) return Response.json({ status: "ok", record: current, audit: [] }, { headers: { "Cache-Control": "no-store" } });
	await env.BEACH_DATA.put(keyFor(current.provider, current.domain), JSON.stringify(next));
	await Promise.all(audit.map((entry, index) => env.BEACH_DATA.put(`${PROVIDER_CATALOG_AUDIT_PREFIX}${updatedAt}:${crypto.randomUUID()}:${index}`, JSON.stringify(entry))));
	return Response.json({ status: "ok", record: { ...current, ...next }, audit }, { headers: { "Cache-Control": "no-store" } });
}
