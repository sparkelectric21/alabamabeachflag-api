import { formatProviderAlertEmail } from "../providerHealth/delivery";
import { PROVIDER_HEALTH_EVENT_PREFIX, PROVIDER_HEALTH_STATES_KEY } from "../providerHealth/process";
import type { ProviderAlertEvent, ProviderHealthState } from "../providerHealth/types";
import { loadProviderCatalog, loadProviderCatalogAudit } from "../providerHealth/catalog";
import type { Env } from "../types";
import { evaluateJobHealth, JOB_HEALTH_CONFIG, jobHealthKey, type JobHeartbeat, type MonitoredJob } from "../monitoring/jobHealth";
import { BEACH_CONDITIONS_CACHE_KEY, BEACH_FLAGS_CACHE_KEY, RIP_CURRENT_OUTLOOK_CACHE_KEY, WATER_QUALITY_CACHE_KEY } from "../services/cache/kv";

const text = (value: unknown, max = 240): string | null => typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
const iso = (value: unknown): string | null => { const parsed = text(value, 64); return parsed && !Number.isNaN(Date.parse(parsed)) ? new Date(parsed).toISOString() : null; };
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
const safeName = (value: unknown): string | null => { const parsed = text(value, 80); return parsed && /^[a-z0-9._:-]+$/i.test(parsed) ? parsed : null; };
const safeReason = (value: unknown): string | null => {
	const parsed = text(value);
	if (!parsed) return null;
	return parsed.replace(/https?:\/\/\S+/gi, "[upstream URL redacted]").replace(/\b(?:bearer|token|secret|password|api[_-]?key)\s*[:=]?\s*\S+/gi, "[credential redacted]");
};

function sanitizeState(value: unknown) {
	if (!value || typeof value !== "object") return null;
	const state = value as Partial<ProviderHealthState>;
	const provider = safeName(state.provider), domain = safeName(state.domain), updatedAt = iso(state.updatedAt);
	if (!provider || !domain || !updatedAt || !["healthy", "degraded", "unavailable"].includes(state.currentStatus ?? "")) return null;
	return {
		provider, domain, status: state.currentStatus === "unavailable" ? "incident" : state.currentStatus,
		incidentKind: ["shared_provider", "isolated", "quality_gate"].includes(state.incidentKind ?? "") ? state.incidentKind : null,
		consecutiveFailures: count(state.consecutiveFailures), consecutiveSuccesses: count(state.consecutiveSuccesses),
		affectedBeachCount: count(state.affectedBeachCount), expectedBeachCount: count(state.expectedBeachCount),
		firstFailureAt: iso(state.firstFailureAt), lastFailureAt: iso(state.lastFailureAt), lastSuccessAt: iso(state.lastSuccessAt),
		lastErrorReason: safeReason(state.lastErrorReason), activeIncidentId: text(state.activeIncidentId, 180), alertState: text(state.alertState, 20),
		alertOpenedAt: iso(state.alertOpenedAt), recoveryAlertSentAt: iso(state.recoveryAlertSentAt), updatedAt,
	};
}

function sanitizeEvent(value: unknown) {
	if (!value || typeof value !== "object") return null;
	const event = value as Partial<ProviderAlertEvent>;
	const provider = safeName(event.provider), domain = safeName(event.domain), createdAt = iso(event.createdAt);
	if (!provider || !domain || !createdAt || !["opened", "recovery", "reminder"].includes(event.type ?? "")) return null;
	return {
		id: text(event.id, 220), type: event.type, incidentId: text(event.incidentId, 180), incidentKind: event.incidentKind,
		severity: event.severity, provider, domain, createdAt,
		affectedBeachCount: count(event.affectedBeachCount), expectedBeachCount: count(event.expectedBeachCount),
		consecutiveFailures: count(event.consecutiveFailures), reason: safeReason(event.errorReason), deliveryState: "captured", capturedOnly: true,
	};
}

export async function handleProviderHealthAdminRequest(env: Pick<Env, "BEACH_DATA">): Promise<Response> {
	const now = new Date().toISOString();
	const index = await env.BEACH_DATA.get<unknown>(PROVIDER_HEALTH_STATES_KEY, "json");
	const rawStates = index && typeof index === "object" && Array.isArray((index as { states?: unknown[] }).states) ? (index as { states: unknown[] }).states : [];
	const providers = rawStates.map(sanitizeState).filter((value): value is NonNullable<typeof value> => Boolean(value));
	const keys = await env.BEACH_DATA.list({ prefix: PROVIDER_HEALTH_EVENT_PREFIX, limit: 100 });
	const recentAlerts = (await Promise.all(keys.keys.map((item) => env.BEACH_DATA.get<unknown>(item.name, "json"))))
		.map(sanitizeEvent).filter((value): value is NonNullable<typeof value> => Boolean(value))
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 25);
	const activeIncidents = providers.filter((provider) => provider.activeIncidentId).map((provider) => ({
		...provider, severity: provider.incidentKind === "quality_gate" ? "critical" : "warning",
		qualityGateTriggered: provider.incidentKind === "quality_gate",
		expectedAlertBehavior: provider.alertState === "active" ? "Alert opened; recovery will be captured after the required successful refreshes." : "Alert pending threshold.",
	}));
	const recentQualityGateRejections = recentAlerts.filter((event) => event.incidentKind === "quality_gate" && event.type === "opened").map((event) => ({
		timestamp: event.createdAt, candidateBeachCount: Math.max(0, event.expectedBeachCount - event.affectedBeachCount), priorBeachCount: event.expectedBeachCount,
		expectedBeachCount: event.expectedBeachCount, provider: event.provider, domain: event.domain, reason: event.reason,
	}));
	const emailPreviews = recentAlerts.slice(0, 10).map((event) => {
		const preview = formatProviderAlertEmail({ ...event, id: event.id ?? "", incidentId: event.incidentId ?? "", errorReason: event.reason ?? undefined } as ProviderAlertEvent);
		return { eventType: event.type, createdAt: event.createdAt, subject: preview.subject, body: preview.text, capturedOnly: true };
	});
	const degradedProviderCount = providers.filter((provider) => provider.status !== "healthy").length;
	const expectedBeachCount = providers.reduce((maximum, provider) => Math.max(maximum, provider.expectedBeachCount), 0);
	const lastRefreshAt = providers.map((provider) => provider.lastSuccessAt).filter(Boolean).sort().at(-1) ?? null;
	const catalog = await loadProviderCatalog(env);
	const catalogAudit = await loadProviderCatalogAudit(env);
	const providersByKey = new Map(providers.map((provider) => [`${provider.provider}:${provider.domain}`, provider]));
	const providerCatalog = catalog.map((record) => ({ ...record, health: providersByKey.get(`${record.provider}:${record.domain}`) ?? null }));
	const jobs = Object.keys(JOB_HEALTH_CONFIG) as MonitoredJob[];
	const heartbeats = await Promise.all(jobs.map((job) => env.BEACH_DATA.get<JobHeartbeat>(jobHealthKey(job), "json")));
	const jobHealth = jobs.map((job, index) => ({ job, ...JOB_HEALTH_CONFIG[job], heartbeat: heartbeats[index], ...evaluateJobHealth(heartbeats[index], new Date(now)) }));
	const freshnessSources = [["beach-flag publication", BEACH_FLAGS_CACHE_KEY, 900_000], ["beach-condition publication", BEACH_CONDITIONS_CACHE_KEY, 2_700_000], ["water-quality refresh", WATER_QUALITY_CACHE_KEY, 25_200_000], ["rip-current metadata", RIP_CURRENT_OUTLOOK_CACHE_KEY, 25_200_000]] as const;
	const freshnessPayloads = await Promise.all(freshnessSources.map(([, key]) => env.BEACH_DATA.get<{ generatedAt?: string; observedAt?: string; beachConditions?: Array<{ waterTemperature?: { observedAt?: string } }> }>(key, "json")));
	const providerFreshness: Array<{ dataset: string; observedAt: string | null; freshForMs: number; status: string; ageMs: number | null; precision: string }> = freshnessSources.map(([dataset, , freshForMs], index) => { const payload = freshnessPayloads[index]; const observedAt = iso(payload?.observedAt ?? payload?.generatedAt); const ageMs = observedAt ? Math.max(0, Date.parse(now) - Date.parse(observedAt)) : null; return { dataset, observedAt, freshForMs, status: ageMs === null ? "unknown" : ageMs <= freshForMs ? "fresh" : "stale", ageMs, precision: payload?.observedAt ? "provider_observation" : "publication_or_refresh" }; });
	const waterTemperatureObservedAt = freshnessPayloads[1]?.beachConditions?.map((item) => iso(item.waterTemperature?.observedAt)).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
	const waterTemperatureAgeMs = waterTemperatureObservedAt ? Math.max(0, Date.parse(now) - Date.parse(waterTemperatureObservedAt)) : null;
	providerFreshness.push({ dataset: "water-temperature observation", observedAt: waterTemperatureObservedAt, freshForMs: 7_200_000, status: waterTemperatureAgeMs === null ? "unknown" : waterTemperatureAgeMs <= 7_200_000 ? "fresh" : "stale", ageMs: waterTemperatureAgeMs, precision: "provider_observation" });
	return Response.json({ status: "ok", schemaVersion: 2, generatedAt: now, overall: {
		status: activeIncidents.some((item) => item.severity === "critical") ? "critical" : degradedProviderCount > 0 ? "degraded" : "healthy",
		activeIncidentCount: activeIncidents.length, degradedProviderCount, lastRefreshAt, expectedBeachCount,
	}, catalogSummary: {
		primaryProviderCount: catalog.filter((item) => item.role === "Primary").length,
		standbyProviderCount: catalog.filter((item) => item.role === "Standby").length,
		monitoringOnlyProviderCount: catalog.filter((item) => item.role === "Monitoring Only").length,
		internalProtectionCount: catalog.filter((item) => item.role === "Internal Protection").length,
		officialProviderCount: catalog.filter((item) => item.officialSource).length,
	}, jobHealth, providerFreshness, providerCatalog, catalogAudit, providers, activeIncidents, recentAlerts, recentQualityGateRejections, emailPreviews }, { headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" } });
}
