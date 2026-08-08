import type { Env } from "../types";

export async function handleHistoricalDiagnostics(env: Env): Promise<Response> {
	if (!env.HISTORICAL_DATA) return Response.json({ status: "not_configured" }, {
		status: 503, headers: { "Cache-Control": "no-store" },
	});
	const [latest, counts, lastRun, failures] = await env.HISTORICAL_DATA.batch([
		env.HISTORICAL_DATA.prepare(`SELECT provider, station_id, observation_type, beach_id, observed_at, fetched_at, stored_at, freshness_state
			FROM historical_observations AS observation
			WHERE id = (SELECT id FROM historical_observations AS candidate
				WHERE candidate.provider = observation.provider
				AND candidate.station_id IS observation.station_id
				AND candidate.observation_type = observation.observation_type
				ORDER BY candidate.observed_at DESC, candidate.revision_number DESC LIMIT 1)
			ORDER BY provider, station_id, observation_type LIMIT 250`),
		env.HISTORICAL_DATA.prepare(`SELECT observation_type, provider, COUNT(*) AS count
			FROM historical_observations WHERE julianday(stored_at) >= julianday('now', '-24 hours')
			GROUP BY observation_type, provider ORDER BY observation_type, provider`),
		env.HISTORICAL_DATA.prepare(`SELECT * FROM historical_ingestion_runs ORDER BY stored_at DESC LIMIT 1`),
		env.HISTORICAL_DATA.prepare(`SELECT * FROM historical_ingestion_runs WHERE status = 'failed' ORDER BY stored_at DESC LIMIT 25`),
	]);
	return Response.json({
		status: "ok",
		latestBySource: latest.results,
		countsLast24Hours: counts.results,
		lastIngestionRun: lastRun.results[0] ?? null,
		recentFailures: failures.results,
	}, { headers: { "Cache-Control": "no-store" } });
}
