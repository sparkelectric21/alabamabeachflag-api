import { CONTENT_TYPES, UPSTREAM_LIMITS, validateNwsUrl } from "../config/upstreamSecurity";
import { fetchWithRetry, readResponseJson } from "../utils/http";
import { policyFor } from "./policy";
import type { AbfRegionId, AlertGeometry, NormalizedOfficialAlert, RegionSourceState } from "./types";

interface NwsFeature { id?: unknown; geometry?: unknown; properties?: Record<string, unknown> }
interface NwsCollection { features?: unknown }

const textOrNull = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const validDate = (value: unknown): string | null => {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
	return new Date(value).toISOString();
};
const enumValue = <T extends string>(value: unknown, allowed: readonly T[]): T | "Unknown" =>
	typeof value === "string" && allowed.includes(value as T) ? value as T : "Unknown";
const stringList = (value: unknown): string[] => Array.isArray(value)
	? value.filter((item): item is string => typeof item === "string" && item.length > 0)
	: typeof value === "string" ? value.split(/\s+/).filter(Boolean) : [];

function eventCodes(properties: Record<string, unknown>): Record<string, string[]> {
	const output: Record<string, string[]> = {};
	const raw = properties.eventCode;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return output;
	for (const [key, value] of Object.entries(raw)) {
		const values = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
		if (values.length) output[key] = values;
	}
	return output;
}

function geometry(value: unknown): AlertGeometry | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = value as Record<string, unknown>;
	if ((candidate.type !== "Polygon" && candidate.type !== "MultiPolygon") || !Array.isArray(candidate.coordinates)) return null;
	return { type: candidate.type, coordinates: candidate.coordinates };
}

async function stableId(sourceIdentifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`nws\0${sourceIdentifier}`));
	return `nws_${[...new Uint8Array(digest)].slice(0, 16).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function normalizeNwsFeature(feature: NwsFeature, region: AbfRegionId, receivedAt: string): Promise<NormalizedOfficialAlert | null> {
	const properties = feature.properties;
	if (!properties) return null;
	const sourceIdentifier = textOrNull(feature.id) ?? textOrNull(properties.id);
	const event = textOrNull(properties.event);
	const policy = event ? policyFor(event) : null;
	const sentAt = validDate(properties.sent);
	const effectiveAt = validDate(properties.effective) ?? sentAt;
	const expiresAt = validDate(properties.expires);
	if (!sourceIdentifier || !event || !policy || !sentAt || !effectiveAt || !expiresAt || properties.status !== "Actual") return null;
	const issuer = textOrNull(properties.senderName) ?? "National Weather Service";
	return {
		id: await stableId(sourceIdentifier), source: "nws", sourceIdentifier,
		sourceSender: textOrNull(properties.sender), issuer, event, eventCodes: eventCodes(properties), category: policy.category,
		severity: enumValue(properties.severity, ["Minor", "Moderate", "Severe", "Extreme"] as const),
		urgency: enumValue(properties.urgency, ["Immediate", "Expected", "Future", "Past"] as const),
		certainty: enumValue(properties.certainty, ["Observed", "Likely", "Possible", "Unlikely"] as const),
		headline: textOrNull(properties.headline) ?? event, description: textOrNull(properties.description), instruction: textOrNull(properties.instruction),
		effectiveAt, onsetAt: validDate(properties.onset), expiresAt, sentAt, receivedAt, updatedAt: receivedAt,
		sourceStatus: textOrNull(properties.status) ?? "Actual", messageType: textOrNull(properties.messageType) ?? "Alert",
		references: stringList(properties.references), incidents: stringList(properties.incidents), affectedRegions: [region],
		geometry: geometry(feature.geometry), sourceURL: textOrNull(properties.web), lifecycleState: "active",
		correlationKey: `nws:${sourceIdentifier}`,
	};
}

export interface NwsRegionResult { state: RegionSourceState; alerts: NormalizedOfficialAlert[] | null }

export async function fetchNwsRegion(
	region: AbfRegionId,
	point: { latitude: number; longitude: number },
	previous: RegionSourceState | undefined,
	now: Date,
): Promise<NwsRegionResult> {
	const attemptedAt = now.toISOString();
	const url = new URL("https://api.weather.gov/alerts/active");
	url.searchParams.set("point", `${point.latitude},${point.longitude}`);
	const headers = new Headers({ Accept: "application/geo+json", "User-Agent": "AlabamaBeachFlagAPI/1.0 (support@alabamabeachflag.com)" });
	if (previous?.etag) headers.set("If-None-Match", previous.etag);
	if (previous?.lastModified) headers.set("If-Modified-Since", previous.lastModified);
	try {
		const response = await fetchWithRetry(url, { headers, validateUrl: validateNwsUrl, label: `NWS alerts ${region}`, timeoutMs: 10_000, retries: 1 });
		if (response.status === 304) return { alerts: null, state: { region, status: "notModified", lastAttemptAt: attemptedAt, lastSuccessAt: attemptedAt, httpStatus: 304, etag: previous?.etag ?? null, lastModified: previous?.lastModified ?? null, parseFailures: 0, error: null, sourceIdentifiers: previous?.sourceIdentifiers ?? [] } };
		if (!response.ok) throw new Error(`http_${response.status}`);
		const payload = await readResponseJson<NwsCollection>(response, { maxBytes: UPSTREAM_LIMITS.nwsJsonBytes, contentTypes: CONTENT_TYPES.nwsJson });
		if (!Array.isArray(payload.features)) throw new Error("invalid_feature_collection");
		let parseFailures = 0;
		const alerts: NormalizedOfficialAlert[] = [];
		for (const raw of payload.features) {
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) { parseFailures++; continue; }
			const normalized = await normalizeNwsFeature(raw as NwsFeature, region, attemptedAt);
			if (normalized) alerts.push(normalized);
			else {
				const event = (raw as NwsFeature).properties?.event;
				if (typeof event !== "string" || policyFor(event)) parseFailures++;
			}
		}
		if (parseFailures > 0) return { alerts: null, state: { region, status: "failed", lastAttemptAt: attemptedAt, lastSuccessAt: previous?.lastSuccessAt ?? null, httpStatus: response.status, etag: previous?.etag ?? null, lastModified: previous?.lastModified ?? null, parseFailures, error: "parse_failure", sourceIdentifiers: previous?.sourceIdentifiers ?? [] } };
		return { alerts, state: { region, status: "success", lastAttemptAt: attemptedAt, lastSuccessAt: attemptedAt, httpStatus: response.status, etag: response.headers.get("ETag"), lastModified: response.headers.get("Last-Modified"), parseFailures, error: null, sourceIdentifiers: alerts.map((alert) => alert.sourceIdentifier) } };
	} catch (error) {
		return { alerts: null, state: { region, status: "failed", lastAttemptAt: attemptedAt, lastSuccessAt: previous?.lastSuccessAt ?? null, httpStatus: null, etag: previous?.etag ?? null, lastModified: previous?.lastModified ?? null, parseFailures: 0, error: error instanceof Error ? error.message.slice(0, 120) : "fetch_failed", sourceIdentifiers: previous?.sourceIdentifiers ?? [] } };
	}
}
