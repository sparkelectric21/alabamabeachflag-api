import type { HistoricalIngestionResult, HistoricalObservationInput } from "./types";

const INGESTION_VERSION = 1;

function validInstant(value: string): string | null {
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function observationIdentity(input: HistoricalObservationInput): Promise<{ logicalKey: string; revisionHash: string }> {
	const logicalKey = await sha256(stableJson({
		type: input.observationType,
		kind: input.recordKind,
		beachId: input.beachId ?? null,
		provider: input.provider,
		stationId: input.stationId ?? null,
		observedAt: validInstant(input.observedAt),
	}));
	const revisionHash = await sha256(stableJson({
		valueNumeric: input.valueNumeric ?? null,
		valueText: input.valueText ?? null,
		unit: input.unit ?? null,
		normalizedValueNumeric: input.normalizedValueNumeric ?? null,
		qualityFlag: input.qualityFlag ?? null,
		// Retain the legacy serialized field shape for compatible hashes, but never
		// hash the time-derived current/stale classification itself.
		freshnessState: null,
		// Freshness and general provider metadata may include values derived at fetch
		// time (for example ageMinutes). Only explicitly stable source/provenance
		// metadata participates in revision identity.
		// Keep the serialized field name stable so already-correct hashes for records
		// whose full metadata was stable (for example tide predictions) still match.
		providerMetadata: input.revisionMetadata ?? {},
	}));
	return { logicalKey, revisionHash };
}

export async function sourceObservationIdentity(input: HistoricalObservationInput): Promise<string> {
	return sha256(stableJson({
		type: input.observationType,
		kind: input.recordKind,
		provider: input.provider,
		stationId: input.sourceStationId ?? input.stationId ?? null,
		observedAt: validInstant(input.observedAt),
	}));
}

function normalize(input: HistoricalObservationInput): HistoricalObservationInput | null {
	const observedAt = validInstant(input.observedAt);
	const fetchedAt = validInstant(input.fetchedAt);
	const numericValid = input.valueNumeric === undefined || Number.isFinite(input.valueNumeric);
	const normalizedValid = input.normalizedValueNumeric === undefined || Number.isFinite(input.normalizedValueNumeric);
	if (!observedAt || !fetchedAt || !input.observationType || !input.provider || !numericValid || !normalizedValid) return null;
	if (input.valueNumeric === undefined && (input.valueText === undefined || input.valueText.length === 0)) return null;
	return { ...input, observedAt, fetchedAt };
}

export async function appendHistoricalObservations(
	db: D1Database,
	job: string,
	inputs: HistoricalObservationInput[],
	now: Date = new Date(),
): Promise<HistoricalIngestionResult> {
	const storedAt = now.toISOString();
	const runId = crypto.randomUUID();
	const normalized = inputs.map(normalize);
	const rejected = normalized.filter((item) => !item).length;
	const validInputs = normalized.filter((item): item is HistoricalObservationInput => Boolean(item));
	const prepared = await Promise.all(validInputs.map(async (input) => ({
		input,
		...(await observationIdentity(input)),
		sourceObservationKey: await sourceObservationIdentity(input),
	})));
	let inserted = 0;
	let duplicates = 0;

	try {
		const existing = prepared.length === 0 ? [] : await db.batch(prepared.map(({ logicalKey, revisionHash }) =>
			db.prepare(`SELECT 1 AS present FROM historical_observations WHERE logical_key = ?1 AND revision_hash = ?2 LIMIT 1`)
				.bind(logicalKey, revisionHash),
		));
		const pending = prepared.filter((_, index) => (existing[index]?.results?.length ?? 0) === 0);
		inserted = pending.length;
		duplicates = prepared.length - inserted;

		const writes = pending.map(({ input, logicalKey, revisionHash, sourceObservationKey }) =>
			db.prepare(`
				INSERT OR IGNORE INTO historical_observations (
					id, logical_key, revision_hash, revision_number, observation_type, record_kind,
					beach_area, beach_id, provider, station_id, observed_at, fetched_at, stored_at,
					value_numeric, value_text, unit, normalized_value_numeric, quality_flag,
					freshness_state, source_identifier, provider_metadata, ingestion_version,
					source_observation_key, source_station_id, observation_time_basis, source_configuration_version
				) SELECT ?1, ?2, ?3, COALESCE(MAX(revision_number), 0) + 1, ?4, ?5,
					?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21
					, ?22, ?23, ?24, ?25
				FROM historical_observations WHERE logical_key = ?2
			`).bind(
				crypto.randomUUID(), logicalKey, revisionHash, input.observationType, input.recordKind,
				input.beachArea ?? null, input.beachId ?? null, input.provider, input.stationId ?? null,
				input.observedAt, input.fetchedAt, storedAt, input.valueNumeric ?? null,
				input.valueText ?? null, input.unit ?? null, input.normalizedValueNumeric ?? null,
				input.qualityFlag ?? null, input.freshnessState ?? null, input.sourceIdentifier ?? null,
				stableJson(input.providerMetadata ?? {}), INGESTION_VERSION,
				sourceObservationKey, input.sourceStationId ?? input.stationId ?? null,
				input.observationTimeBasis, input.sourceConfigurationVersion,
			));

		writes.push(db.prepare(`INSERT INTO historical_ingestion_runs
			(id, job, fetched_at, stored_at, attempted_count, inserted_count, duplicate_count, rejected_count, status)
			VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'completed')`)
			.bind(runId, job, inputs[0]?.fetchedAt ?? storedAt, storedAt, inputs.length, inserted, duplicates, rejected));
		await db.batch(writes);
		return { attempted: inputs.length, inserted, duplicates, rejected };
	} catch (error) {
		try {
			await db.prepare(`INSERT INTO historical_ingestion_runs
				(id, job, fetched_at, stored_at, attempted_count, inserted_count, duplicate_count, rejected_count, status, error_code)
				VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, ?6, 'failed', 'atomic_batch_failed')`)
				.bind(runId, job, inputs[0]?.fetchedAt ?? storedAt, storedAt, inputs.length, rejected).run();
		} catch { /* The original error is more useful and the live pipeline will isolate it. */ }
		throw error;
	}
}
