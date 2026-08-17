import type { Env } from "../types";
import { compareOfficialAlerts } from "../officialAlerts/order";
import { isAbfRegionId } from "../officialAlerts/regions";
import { readOfficialAlertSnapshot } from "../officialAlerts/store";

export async function handleOfficialAlertsRequest(request: Request, env: Env, now = new Date()): Promise<Response> {
	const url = new URL(request.url);
	const requestedRegion = url.searchParams.get("region") ?? url.searchParams.get("beach");
	if (requestedRegion && !isAbfRegionId(requestedRegion)) return Response.json({ error: "invalid_region" }, { status: 400 });
	const region = requestedRegion && isAbfRegionId(requestedRegion) ? requestedRegion : null;
	const snapshot = await readOfficialAlertSnapshot(env);
	if (!snapshot) return Response.json({ schemaVersion: 1, generatedAt: now.toISOString(), sourceFreshness: "unavailable", alerts: [] }, { status: 503, headers: { "Cache-Control": "no-store" } });
	const alerts = snapshot.alerts
		.filter((alert) => alert.lifecycleState === "active" && Date.parse(alert.expiresAt) > now.getTime())
		.filter((alert) => !region || alert.affectedRegions.includes(region))
		.sort(compareOfficialAlerts)
		.map(({ sourceIdentifier: _sourceIdentifier, sourceSender: _sourceSender, eventCodes: _eventCodes, references: _references, incidents: _incidents, geometry: _geometry, correlationKey: _correlationKey, receivedAt: _receivedAt, updatedAt: _updatedAt, sourceStatus: _sourceStatus, messageType: _messageType, ...publicAlert }) => publicAlert);
	return Response.json({ schemaVersion: 1, generatedAt: snapshot.generatedAt, sourceFreshness: snapshot.sourceFreshness, alerts }, { headers: { "Cache-Control": "public, max-age=60, stale-if-error=300" } });
}

export async function handleOfficialAlertHealthRequest(env: Env, now = new Date()): Promise<Response> {
	const snapshot = await readOfficialAlertSnapshot(env);
	if (!snapshot) return Response.json({ schemaVersion: 1, source: "nws", freshness: "unavailable", activeAlertCount: 0, regions: [] }, { status: 503, headers: { "Cache-Control": "no-store" } });
	return Response.json({
		schemaVersion: 1, source: "nws", freshness: snapshot.sourceFreshness, generatedAt: snapshot.generatedAt,
		lastSuccessfulIngestionAt: snapshot.lastSuccessfulIngestionAt, lastDataChangeAt: snapshot.lastDataChangeAt,
		activeAlertCount: snapshot.alerts.filter((alert) => Date.parse(alert.expiresAt) > now.getTime()).length,
		regions: Object.values(snapshot.regions).map(({ sourceIdentifiers: _sourceIdentifiers, etag: _etag, lastModified: _lastModified, ...state }) => state),
	}, { headers: { "Cache-Control": "no-store" } });
}
