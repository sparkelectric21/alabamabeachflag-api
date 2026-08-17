import type { Env } from "../types";
import { fetchNwsRegion } from "./nwsAdapter";
import { compareOfficialAlerts } from "./order";
import { ABF_ALERT_REGIONS } from "./regions";
import { readOfficialAlertSnapshot, writeOfficialAlertSnapshot } from "./store";
import type { AbfRegionId, NormalizedOfficialAlert, OfficialAlertSnapshot, RegionSourceState, SourceFreshness } from "./types";

const STALE_AFTER_MS = 20 * 60_000;
const UNAVAILABLE_AFTER_MS = 60 * 60_000;
const HISTORY_LIMIT = 200;

function freshness(states: RegionSourceState[], now: Date): SourceFreshness {
	const ages = states.map((state) => state.lastSuccessAt ? now.getTime() - Date.parse(state.lastSuccessAt) : Number.POSITIVE_INFINITY);
	if (ages.every((age) => age <= STALE_AFTER_MS)) return "fresh";
	if (ages.some((age) => age > UNAVAILABLE_AFTER_MS)) return "unavailable";
	return "stale";
}
function combine(alerts: NormalizedOfficialAlert[]): NormalizedOfficialAlert[] {
	const byId = new Map<string, NormalizedOfficialAlert>();
	for (const alert of alerts) {
		const current = byId.get(alert.id);
		if (!current) byId.set(alert.id, alert);
		else current.affectedRegions = [...new Set([...current.affectedRegions, ...alert.affectedRegions])].sort() as AbfRegionId[];
	}
	return [...byId.values()];
}

export async function refreshOfficialAlerts(env: Env, now = new Date()): Promise<OfficialAlertSnapshot> {
	const previous = await readOfficialAlertSnapshot(env);
	const results = await Promise.all(ABF_ALERT_REGIONS.map((region) => fetchNwsRegion(region.id, region.queryPoint, previous?.regions[region.id], now)));
	const successfulRegions = new Set(results.filter((result) => result.alerts !== null).map((result) => result.state.region));
	const nextPieces = results.flatMap((result) => result.alerts ?? []);
	for (const alert of previous?.alerts ?? []) {
		const retainedRegions = alert.affectedRegions.filter((region) => !successfulRegions.has(region));
		if (retainedRegions.length) nextPieces.push({ ...alert, affectedRegions: retainedRegions });
	}
	const nowIso = now.toISOString();
	const active = combine(nextPieces)
		.filter((alert) => alert.lifecycleState === "active" && Date.parse(alert.expiresAt) > now.getTime())
		.map((alert) => ({ ...alert, updatedAt: nowIso }))
		.sort(compareOfficialAlerts);
	const activeIds = new Set(active.map((alert) => alert.id));
	const transitions = (previous?.alerts ?? []).filter((alert) => !activeIds.has(alert.id)).map((alert) => ({
		...alert,
		lifecycleState: Date.parse(alert.expiresAt) <= now.getTime() ? "expired" as const : "superseded" as const,
		updatedAt: nowIso,
	}));
	const changed = JSON.stringify((previous?.alerts ?? []).map((a) => [a.id, a.affectedRegions, a.lifecycleState])) !== JSON.stringify(active.map((a) => [a.id, a.affectedRegions, a.lifecycleState]));
	const regionStates = Object.fromEntries(results.map((result) => [result.state.region, result.state])) as Record<AbfRegionId, RegionSourceState>;
	const anySuccess = results.some((result) => result.state.status !== "failed");
	const snapshot: OfficialAlertSnapshot = {
		schemaVersion: 1, generatedAt: nowIso,
		lastSuccessfulIngestionAt: anySuccess ? nowIso : previous?.lastSuccessfulIngestionAt ?? null,
		lastDataChangeAt: changed ? nowIso : previous?.lastDataChangeAt ?? null,
		sourceFreshness: freshness(Object.values(regionStates), now), alerts: active,
		history: [...transitions, ...(previous?.history ?? [])].slice(0, HISTORY_LIMIT), regions: regionStates,
	};
	await writeOfficialAlertSnapshot(env, snapshot);
	return snapshot;
}
