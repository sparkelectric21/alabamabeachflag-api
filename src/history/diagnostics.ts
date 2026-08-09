import type { Env } from "../types";

export const HISTORICAL_JOB_HEALTH = {
	"beach-flags": { cadenceMinutes: 5, maximumSuccessAgeMinutes: 15 },
	"beach-conditions": { cadenceMinutes: 15, maximumSuccessAgeMinutes: 45 },
	"water-quality": { cadenceMinutes: 360, maximumSuccessAgeMinutes: 840 },
} as const;

type HistoryJob = keyof typeof HISTORICAL_JOB_HEALTH;

function jobHealth(row: Record<string, unknown> | undefined, job: HistoryJob, now: Date, scheduled: boolean) {
	const expectation = HISTORICAL_JOB_HEALTH[job];
	const lastSuccess = typeof row?.last_success_at === "string" ? row.last_success_at : null;
	const ageMinutes = lastSuccess === null ? null : Math.max(0, Math.round((now.valueOf() - Date.parse(lastSuccess)) / 60_000));
	let status: "healthy" | "late" | "never_succeeded" | "not_scheduled" = "healthy";
	if (!scheduled) status = "not_scheduled";
	else if (ageMinutes === null) status = "never_succeeded";
	else if (ageMinutes > expectation.maximumSuccessAgeMinutes) status = "late";
	return { job, ...expectation, scheduled, status, ageMinutesSinceSuccess: ageMinutes, ...(row ?? {}) };
}

export async function handleHistoricalDiagnostics(env: Env, now: Date = new Date()): Promise<Response> {
	const environment = env.HISTORICAL_DATA_ENVIRONMENT ?? env.VERIFICATION_ALERT_ENVIRONMENT ?? "unknown";
	if (!env.HISTORICAL_DATA) return Response.json({ status: "not_configured", configured: false, environment }, {
		status: 503, headers: { "Cache-Control": "no-store" },
	});

	const [summary, jobs, failures, last24Hours, datasets, latest] = await env.HISTORICAL_DATA.batch([
		env.HISTORICAL_DATA.prepare(`SELECT
			COUNT(*) AS beach_attributed_rows,
			COUNT(DISTINCT logical_key) AS logical_observations,
			COUNT(DISTINCT COALESCE(source_observation_key,
				observation_type || '|' || record_kind || '|' || provider || '|' || COALESCE(station_id, '') || '|' || observed_at
			)) AS unique_physical_source_observations,
			SUM(CASE WHEN revision_number > 1 THEN 1 ELSE 0 END) AS revision_count,
			MIN(stored_at) AS earliest_stored_at, MAX(stored_at) AS latest_stored_at,
			MIN(observed_at) AS earliest_observed_at, MAX(observed_at) AS latest_observed_at
			FROM historical_observations`),
		env.HISTORICAL_DATA.prepare(`SELECT job,
			MAX(stored_at) AS last_attempt_at,
			MAX(CASE WHEN status = 'completed' THEN stored_at END) AS last_success_at,
			MAX(CASE WHEN status = 'failed' THEN stored_at END) AS last_failure_at,
			SUM(attempted_count) AS lifetime_attempted,
			SUM(inserted_count) AS lifetime_inserted,
			SUM(duplicate_count) AS lifetime_duplicates,
			SUM(rejected_count) AS lifetime_rejected
			FROM historical_ingestion_runs GROUP BY job ORDER BY job`),
		env.HISTORICAL_DATA.prepare(`SELECT * FROM historical_ingestion_runs
			WHERE status = 'failed' ORDER BY stored_at DESC, id DESC LIMIT 25`),
		env.HISTORICAL_DATA.prepare(`SELECT job,
			SUM(attempted_count) AS attempted, SUM(inserted_count) AS inserted,
			SUM(duplicate_count) AS duplicates, SUM(rejected_count) AS rejected,
			MAX(stored_at) AS latest_run_at
			FROM historical_ingestion_runs WHERE julianday(stored_at) >= julianday('now', '-24 hours')
			GROUP BY job ORDER BY job`),
		env.HISTORICAL_DATA.prepare(`SELECT observation_type, provider,
			COUNT(*) AS beach_attributed_rows, COUNT(DISTINCT logical_key) AS logical_observations,
			COUNT(DISTINCT COALESCE(source_observation_key,
				observation_type || '|' || record_kind || '|' || provider || '|' || COALESCE(station_id, '') || '|' || observed_at
			)) AS unique_physical_source_observations,
			COUNT(DISTINCT beach_id) AS beach_count, COUNT(DISTINCT beach_area) AS area_count,
			COUNT(DISTINCT source_station_id) AS station_count,
			MIN(observed_at) AS earliest_observed_at, MAX(observed_at) AS latest_observed_at,
			MAX(stored_at) AS latest_stored_at
			FROM historical_observations GROUP BY observation_type, provider
			ORDER BY observation_type, provider`),
		env.HISTORICAL_DATA.prepare(`SELECT provider, source_station_id, observation_type, beach_area, beach_id,
			observed_at, fetched_at, stored_at, freshness_state, revision_number
			FROM (SELECT observation.*,
				ROW_NUMBER() OVER (PARTITION BY provider, source_station_id, observation_type, beach_id
					ORDER BY observed_at DESC, revision_number DESC, stored_at DESC, id DESC) AS rank
				FROM historical_observations AS observation)
			WHERE rank = 1 ORDER BY provider, source_station_id, observation_type, beach_id LIMIT 250`),
	]);

	const jobRows = jobs.results as Array<Record<string, unknown>>;
	const byJob = new Map(jobRows.map((row) => [String(row.job), row]));
	const production = environment === "production";
	const scheduledInEnvironment = (job: HistoryJob) => production || job === "beach-conditions";
	const health = (Object.keys(HISTORICAL_JOB_HEALTH) as HistoryJob[])
		.map((job) => jobHealth(byJob.get(job), job, now, scheduledInEnvironment(job)));
	const lastRun = [...jobRows]
		.sort((left, right) => String(right.last_attempt_at ?? "").localeCompare(String(left.last_attempt_at ?? "")))[0] ?? null;

	return Response.json({
		status: health.some((item) => item.status === "late" || item.status === "never_succeeded") ? "degraded" : "ok",
		configured: true,
		environment,
		generatedAt: now.toISOString(),
		summary: summary.results[0] ?? {},
		jobHealth: health,
		lastIngestionRun: lastRun,
		recentFailures: failures.results,
		last24Hours: last24Hours.results,
		datasets: datasets.results,
		latestByBeachSource: latest.results,
	}, { headers: { "Cache-Control": "no-store" } });
}
