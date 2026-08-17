import type { AdminIdentity } from "../services/admin/auth";
import type { Env } from "../types";
import { BEACH_EVENT_PROVIDERS } from "../beachEvents/providers";
import type { ProviderIngestionMode } from "./types";

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
	sourceType?: string;
	authority?: string;
	refreshCadence?: string;
	attributionNeeds?: string;
	legalUsageNotes?: string;
	sourceURL?: string;
	publicFeed?: boolean;
	automatedRetrieval?: string;
	cachingPolicy?: string;
	coverageArea?: string;
	supportedBeachMappings?: string[];
	knownLimitations?: string;
	ingestionMode: ProviderIngestionMode;
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
	{ provider: "ndbc", domain: "water_temperature:PPTA1", displayName: "NOAA NDBC PPTA1 · Perdido Pass", category: "Water Temperature", role: "Primary", description: "Direct inlet observation at Perdido Pass.", usedFor: ["Gulf Shores water temperature", "Orange Beach water temperature"], productionUsage: "Active when fresh.", internalNotes: "Ordinary card usage only. Fresh 90 min; unavailable after 180 min.", officialSource: true, websiteVisible: true, editable: true },
	{ provider: "ndbc", domain: "water_temperature:DPHA1", displayName: "NOAA NDBC DPHA1 · Dauphin Island", category: "Water Temperature", role: "Primary", description: "Direct observation near the Mobile Bay entrance.", usedFor: ["Fort Morgan water temperature", "Dauphin Island final fallback"], productionUsage: "Active when fresh and plausible.", internalNotes: "Ordinary card usage only. Fresh 90 min; unavailable after 180 min.", officialSource: true, websiteVisible: true, editable: true },
	{ provider: "ndbc", domain: "water_temperature:42012", displayName: "NOAA NDBC Buoy 42012", category: "Water Temperature", role: "Automatic Fallback", description: "Direct offshore Orange Beach buoy observation.", usedFor: ["Gulf Shores fallback", "Orange Beach fallback", "Fort Morgan final fallback"], productionUsage: "Active when fresh.", internalNotes: "Ordinary card usage only. Fresh 60 min; unavailable after 180 min.", officialSource: true, websiteVisible: true, editable: true },
	{ provider: "ndbc", domain: "water_temperature:42357", displayName: "DISL/NDBC Sofar 42357", category: "Water Temperature", role: "Automatic Fallback", description: "Direct Gulf-facing nearshore observation south of Dauphin Island.", usedFor: ["Gulf Shores final fallback", "Orange Beach final fallback", "Fort Morgan first fallback", "Dauphin Island first fallback"], productionUsage: "Active when the NDBC feed reports valid WTMP.", internalNotes: "Ordinary card usage only. Fresh 120 min; unavailable after 240 min.", officialSource: true, websiteVisible: true, editable: true },
	{ provider: "coops", domain: "water_temperature:8735180", displayName: "NOAA CO-OPS 8735180 · Dauphin Island", category: "Water Temperature", role: "Primary", description: "Direct coastal-station observation at Dauphin Island.", usedFor: ["Dauphin Island water temperature"], productionUsage: "Active when fresh.", internalNotes: "Ordinary card usage only. Fresh 30 min; unavailable after 90 min.", officialSource: true, websiteVisible: true, editable: true },
	{ provider: "gulf_state_park", domain: "water_temperature:pier", displayName: "Gulf State Park Pier Hydrographic Sensor", category: "Water Temperature", role: "Disabled", description: "Direct pier hydrographic observation candidate.", usedFor: ["Future Gulf Shores primary"], productionUsage: "Disabled until valid current WTMP reporting is confirmed.", internalNotes: "Do not infer cadence while offline.", officialSource: true, websiteVisible: true, editable: true },
	{ provider: "west_end_cp", domain: "water_temperature", displayName: "West End CP", category: "Water Temperature", role: "Disabled", description: "Direct observation candidate west of Dauphin Island.", usedFor: ["Future Fort Morgan fallback"], productionUsage: "Disabled until service and a stable machine-readable feed return.", internalNotes: "", officialSource: true, websiteVisible: true, editable: true },
	{ provider: "ngofs2", domain: "water_temperature_nowcast", displayName: "NOAA NGOFS2 Temperature Nowcast", category: "Water Temperature", role: "Disabled", description: "Official NOAA modeled coastal temperature nowcast.", usedFor: ["Future modeled fallback"], productionUsage: "Disabled pending completed-cycle, grid-point, and land-mask validation.", internalNotes: "Must always be labeled modeled; never observed.", officialSource: true, websiteVisible: true, editable: true },
	{ provider: "open_meteo", domain: "current_uv:orangeBeach", displayName: "Open-Meteo UV · Orange Beach", category: "UV", role: "Standby", description: "Independent UV provider maintained for operational readiness.", usedFor: ["Future backup", "Monitoring", "Operational comparison"], productionUsage: "Standby only. Not currently used automatically.", internalNotes: "WeatherKit currently provides production UV.", officialSource: false, websiteVisible: true, editable: true },
	{ provider: "open_meteo", domain: "current_uv:fortMorgan", displayName: "Open-Meteo UV · Fort Morgan", category: "UV", role: "Standby", description: "Independent UV provider maintained for operational readiness.", usedFor: ["Future backup", "Monitoring", "Operational comparison"], productionUsage: "Standby only. Not currently used automatically.", internalNotes: "WeatherKit currently provides production UV.", officialSource: false, websiteVisible: true, editable: true },
	{ provider: "open_meteo", domain: "current_uv:dauphinIsland", displayName: "Open-Meteo UV · Dauphin Island", category: "UV", role: "Standby", description: "Independent UV provider maintained for operational readiness.", usedFor: ["Future backup", "Monitoring", "Operational comparison"], productionUsage: "Standby only. Not currently used automatically.", internalNotes: "WeatherKit currently provides production UV.", officialSource: false, websiteVisible: true, editable: true },
	{ provider: "publication_quality_gate", domain: "beach_conditions", displayName: "Publication Quality Gate", category: "System", role: "Internal Protection", description: "Protects production against catastrophic refresh degradation.", usedFor: ["Snapshot validation", "Last-known-good preservation", "Refresh protection"], productionUsage: "Always active.", internalNotes: "", officialSource: false, websiteVisible: false, editable: true },
	{ provider: "beach_activity_notifications", domain: "beach_events", displayName: "Beach Activity Review Notifications", category: "System", role: "Internal Protection", description: "Delivers at most one actionable morning review-queue summary through the existing application email binding.", usedFor: ["Pending Review workflow", "Daily review reminder"], productionUsage: "Active when preferences and Operational Control allow delivery.", internalNotes: "Automatic delivery occurs only at the configured Central morning time; explicit manual and test sends remain separate.", officialSource: false, websiteVisible: true, editable: false },
	{ provider: "gulfShoresCity", domain: "beach_events", displayName: "City of Gulf Shores Special Events", category: "Beach Events", role: "Primary", description: "Official structured Special Events calendar; only exact approved beach venues are retained.", usedFor: ["Beach Activity & Event Impact"], productionUsage: "Enabled for discovery and review.", internalNotes: "No citywide inference. Venue matching is exact.", officialSource: true, websiteVisible: true, editable: true, sourceType: "iCalendar", authority: "City of Gulf Shores", refreshCadence: "Daily at 7:00 AM Central", attributionNeeds: "Display source name and official event URL.", legalUsageNotes: "Official public subscription feed; store normalized facts only.", sourceURL: "https://www.gulfshoresal.gov/common/modules/iCalendar/iCalendar.aspx?catID=44&feed=calendar", publicFeed: true, automatedRetrieval: "Intended", cachingPolicy: "12-hour public snapshot limit", coverageArea: "Gulf Shores", supportedBeachMappings: ["gulf-shores-public-beach", "little-lagoon-pass"], knownLimitations: "No citywide or nearby inference." },
	{ provider: "orangeBeachParks", domain: "beach_events", displayName: "City of Orange Beach Parks and Recreation", category: "Beach Events", role: "Primary", description: "Official structured Parks and Recreation calendar; inland and citywide entries are rejected.", usedFor: ["Beach Activity & Event Impact"], productionUsage: "Enabled for discovery and review.", internalNotes: "Exact approved beach venues only.", officialSource: true, websiteVisible: true, editable: true, sourceType: "iCalendar", authority: "City of Orange Beach", refreshCadence: "Daily at 7:00 AM Central", attributionNeeds: "Display source name and official event URL.", legalUsageNotes: "Official public subscription feed; store normalized facts only.", sourceURL: "https://www.orangebeachal.gov/common/modules/iCalendar/iCalendar.aspx?catID=34&feed=calendar", publicFeed: true, automatedRetrieval: "Intended", cachingPolicy: "12-hour public snapshot limit", coverageArea: "Orange Beach", supportedBeachMappings: ["cotton-bayou", "alabama-point", "florida-point"], knownLimitations: "Most Parks and Recreation events are inland and correctly excluded." },
	{ provider: "orangeBeachCoastalResources", domain: "beach_events", displayName: "City of Orange Beach Coastal Resources", category: "Beach Events", role: "Primary", description: "Distinct official Coastal Resources calendar for conservation, wildlife, cleanup, and education programs.", usedFor: ["Beach Activity & Event Impact"], productionUsage: "Enabled for exact-location discovery and review.", internalNotes: "Broad cleanup zones and inland programs remain excluded.", officialSource: true, websiteVisible: true, editable: true, sourceType: "iCalendar", authority: "City of Orange Beach", refreshCadence: "Daily at 7:00 AM Central", attributionNeeds: "Display Coastal Resources and official event URL.", legalUsageNotes: "Official public subscription feed.", sourceURL: "https://orangebeachal.gov/common/modules/iCalendar/iCalendar.aspx?catID=26&feed=calendar", publicFeed: true, automatedRetrieval: "Intended", cachingPolicy: "12-hour public snapshot limit", coverageArea: "Orange Beach coastal resources", supportedBeachMappings: ["cotton-bayou", "alabama-point", "florida-point"], knownLimitations: "Programs at Wind and Water Learning Center and Lake Shelby are not beach matches." },
	{ provider: "gulfStatePark", domain: "beach_events", displayName: "Gulf State Park Events", category: "Beach Events", role: "Primary", description: "Official public Google Calendar embedded by Alabama State Parks.", usedFor: ["Beach Pavilion wildlife", "Beach walks", "Official Pier programs affecting nearby beach visitors", "Educational and conservation programs"], productionUsage: "Enabled for exact Beach Pavilion and official Pier discovery and review.", internalNotes: "Only exact source-specific Pier aliases map to Pavilion. Nature Center, Learning Campus, campground, lake, and trail events remain excluded.", officialSource: true, websiteVisible: true, editable: true, sourceType: "Google iCalendar", authority: "Alabama State Parks", refreshCadence: "Daily at 7:00 AM Central", attributionNeeds: "Display Gulf State Park and official event URL.", legalUsageNotes: "Publisher-embedded public calendar feed; normalized facts only.", sourceURL: "https://www.alapark.com/parks/gulf-state-park/activities-calendar", publicFeed: true, automatedRetrieval: "Intended", cachingPolicy: "No creative descriptions or images; 12-hour public snapshot limit", coverageArea: "Gulf State Park Beach Pavilion", supportedBeachMappings: ["gulf-state-park-pavilion"], knownLimitations: "Archival calendar entries are bounded to the discovery window." },
	{ provider: "dauphinIslandTown", domain: "beach_events", displayName: "Town of Dauphin Island Events", category: "Beach Events", role: "Disabled", description: "Official Town calendar retained for manual event entry only.", usedFor: ["Manual exact-beach Dauphin Island records"], productionUsage: "Disabled; manual fallback only until written automated-access permission exists.", internalNotes: "Do not request the embedded calendar or automate Town event retrieval. Never infer a beach from Dauphin Island alone.", officialSource: true, websiteVisible: true, editable: true, sourceType: "Web page", authority: "Town of Dauphin Island", refreshCadence: "Not automated", attributionNeeds: "For manual records, display the Town and official calendar or event page.", legalUsageNotes: "The embedded calendar vendor prohibits automated and systematic retrieval without permission.", sourceURL: "https://www.townofdauphinisland.org/calendar-of-events", publicFeed: true, automatedRetrieval: "Unclear; permission required", cachingPolicy: "No automated caching; manual factual records only", coverageArea: "Dauphin Island", supportedBeachMappings: ["dauphin-island-public-beach", "dauphin-island-east-end"], knownLimitations: "West End Beach uses the existing dauphin-island-public-beach destination while retaining its venue name. Broad island locations do not match automatically." },
	{ provider: "alabamaCoastalCleanup", domain: "beach_events", displayName: "Alabama Coastal Cleanup", category: "Beach Events", role: "Disabled", description: "Official annual cleanup zones coordinated by ADCNR State Lands and Alabama PALS.", usedFor: ["Manual cleanup records"], productionUsage: "Manual-only pending an authorized structured feed.", internalNotes: "Classify as informational beach cleanup unless an administrator confirms access impact.", officialSource: true, websiteVisible: true, editable: true, sourceType: "Web page", authority: "ADCNR and Alabama PALS", refreshCadence: "Annual manual review", attributionNeeds: "Alabama Coastal Cleanup attribution.", legalUsageNotes: "No verified event feed.", sourceURL: "https://alabamacoastalcleanup.com/cleanupzones/", publicFeed: false, automatedRetrieval: "Unclear", coverageArea: "Coastal Alabama cleanup zones", supportedBeachMappings: ["gulf-shores-public-beach", "cotton-bayou", "gulf-state-park-pavilion", "fort-morgan-public-beach", "dauphin-island-public-beach", "dauphin-island-east-end"], knownLimitations: "Many cleanup zones are ramps, parks, streets, and waterways rather than supported beaches." },
	{ provider: "alabamaAudubon", domain: "beach_events", displayName: "Alabama Audubon Events", category: "Beach Events", role: "Disabled", description: "Public organization event RSS exists, but exact beach and commercial-use constraints require permission.", usedFor: ["Future birding and conservation events"], productionUsage: "Disabled; permission required.", internalNotes: "Fort Morgan Historic Site and Audubon Bird Sanctuary are not app beach locations.", officialSource: false, websiteVisible: true, editable: true, sourceType: "RSS", authority: "Alabama Audubon", refreshCadence: "None", attributionNeeds: "Alabama Audubon attribution.", legalUsageNotes: "Commercial-app reuse is unclear.", sourceURL: "https://alaudubon.org/event?format=rss", publicFeed: true, automatedRetrieval: "Intended for feed readers; app reuse unclear", coverageArea: "Alabama conservation events", supportedBeachMappings: ["fort-morgan-public-beach", "dauphin-island-public-beach", "dauphin-island-east-end", "alabama-point"], knownLimitations: "Broad coastal and sanctuary events do not match automatically." },
	{ provider: "dauphinIslandSeaLab", domain: "beach_events", displayName: "Dauphin Island Sea Lab Events", category: "Beach Events", role: "Disabled", description: "Official education and research programs without a verified structured feed.", usedFor: ["Manual beach-program records"], productionUsage: "Manual-only.", internalNotes: "Campus, aquarium, vessel, and lab events are excluded unless explicitly at a supported beach.", officialSource: true, websiteVisible: true, editable: true, sourceType: "Web page", authority: "Dauphin Island Sea Lab", refreshCadence: "Manual", attributionNeeds: "Sea Lab attribution and official URL.", legalUsageNotes: "Automated retrieval and commercial reuse unclear.", sourceURL: "https://www.disl.edu/events/", publicFeed: false, automatedRetrieval: "Unclear", coverageArea: "Dauphin Island", supportedBeachMappings: ["dauphin-island-public-beach", "dauphin-island-east-end"], knownLimitations: "Most programs are not located at an app-supported beach." },
	{ provider: "fortMorganOfficial", domain: "beach_events", displayName: "Fort Morgan Official Announcements", category: "Beach Events", role: "Disabled", description: "Manual official-announcement workflow for Fort Morgan beach activity.", usedFor: ["Manual Fort Morgan beach events"], productionUsage: "Manual-only.", internalNotes: "Historic site, museum, ferry, campground, and inland events never map automatically.", officialSource: true, websiteVisible: true, editable: true, sourceType: "Manual", authority: "Alabama Historical Commission and public agencies", refreshCadence: "Manual", attributionNeeds: "Issuing agency attribution.", legalUsageNotes: "No reliable beach-specific structured source verified.", sourceURL: "https://ahc.alabama.gov/properties/fortmorgan/fortmorgan.aspx", publicFeed: false, automatedRetrieval: "Not applicable", coverageArea: "Fort Morgan", supportedBeachMappings: ["fort-morgan-public-beach"], knownLimitations: "Strong manual workflow is required." },
	{ provider: "tourismCalendar", domain: "beach_events", displayName: "Gulf Shores & Orange Beach Tourism Calendar", category: "Beach Events", role: "Disabled", description: "Tourism calendar is outside the approved automated sources.", usedFor: [], productionUsage: "Disabled; permission required.", internalNotes: "Never scrape, use undocumented endpoints, or copy descriptions/images/deep links.", officialSource: false, websiteVisible: false, editable: false, sourceType: "Website", authority: "Tourism organization", refreshCadence: "None", attributionNeeds: "Not applicable while disabled.", legalUsageNotes: "Permission required before any integration." },
].map((record) => {
	const eventMode = BEACH_EVENT_PROVIDERS.find((provider) => provider.id === record.provider && record.domain === "beach_events")?.mode;
	const ingestionMode: ProviderIngestionMode = eventMode
		?? (record.role === "Monitoring Only" ? "monitorOnly" : record.role === "Disabled" ? "unmonitored" : "enabled");
	return { schemaVersion: 1, updatedAt: null, updatedBy: null, ...record, role: record.role as ProviderCatalogRole, ingestionMode };
});

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
