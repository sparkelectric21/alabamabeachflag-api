import type { Env } from "../types";
import { syntheticFixturesAllowed } from "../config/stagingIsolation";
import { parseICalendarResult } from "../beachEvents/ical";
import { applyImportedEvents, archiveCompletedEvents, listEvents, saveSnapshot } from "../beachEvents/store";
import { processProviderHealthObservations, reconcileProviderHealthModes } from "../providerHealth/process";

export const EVENT_STAGING_FIXTURE_VERSION = "events-isolation-v1";
export const EVENT_STAGING_FIXTURE_PREFIX = `synthetic:${EVENT_STAGING_FIXTURE_VERSION}:`;

const fixtureCalendar = `BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
UID:synthetic-long-identity-${"x".repeat(180)}\r
SUMMARY:Synthetic Pavilion Cleanup\r
LOCATION:Gulf State Park Beach Pavilion\r
DTSTART:20260818T140000Z\r
DTEND:20260818T160000Z\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:synthetic-recurrence\r
RECURRENCE-ID:20260819T140000Z\r
SUMMARY:Synthetic Recurrence Exception\r
LOCATION:Gulf State Park Beach Pavilion\r
DTSTART:20260819T150000Z\r
DTEND:20260819T160000Z\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:synthetic-rejected\r
SUMMARY:Rejected missing start\r
END:VEVENT\r
END:VCALENDAR`;

function scopedKV(base: KVNamespace): KVNamespace {
	const key = (value: string) => `${EVENT_STAGING_FIXTURE_PREFIX}${value}`;
	return {
		get: ((value: string, ...args: unknown[]) => base.get(key(value), ...(args as [never]))) as KVNamespace["get"],
		getWithMetadata: ((value: string, ...args: unknown[]) => base.getWithMetadata(key(value), ...(args as [never]))) as KVNamespace["getWithMetadata"],
		put: ((value: string, body: string | ArrayBuffer | ArrayBufferView | ReadableStream, options?: KVNamespacePutOptions) => base.put(key(value), body, options)) as KVNamespace["put"],
		delete: (value: string) => base.delete(key(value)),
		list: (options?: KVNamespaceListOptions) => base.list({ ...options, prefix: key(options?.prefix ?? "") }),
	} as KVNamespace;
}

export async function runEventStagingFixture(env: Env, now = new Date("2026-08-17T12:00:00.000Z")) {
	if (!syntheticFixturesAllowed(env)) throw new Error("synthetic_fixture_mode_disabled");
	const isolatedEnv = { ...env, BEACH_DATA: scopedKV(env.BEACH_DATA) };
	const provider = { id: "syntheticGulfStatePark", name: "Synthetic Gulf State Park", feedURL: "fixture://events-isolation-v1" };
	const parsed = parseICalendarResult(fixtureCalendar, provider);
	// Reuse the existing non-scheduled audit/lifecycle branch inside the isolated namespace.
	const imported = await applyImportedEvents(isolatedEnv, parsed.events, now, "admin");
	await reconcileProviderHealthModes(isolatedEnv, new Map([[`${provider.id}:beach_events`, "enabled"]]), now.toISOString());
	await processProviderHealthObservations(isolatedEnv, [{ provider: provider.id, domain: "beach_events", affectedBeachCount: parsed.rejectedVEventCount ? 1 : 0, expectedBeachCount: 1, errorReason: parsed.rejectedVEventCount ? "synthetic_partial_calendar" : undefined, ingestionMode: "enabled" }], now.toISOString());
	await archiveCompletedEvents(isolatedEnv, now, "admin");
	const snapshot = await saveSnapshot(isolatedEnv, now);
	const runId = `fixture-${EVENT_STAGING_FIXTURE_VERSION}-${now.toISOString()}`;
	await isolatedEnv.BEACH_DATA.put("manifest", JSON.stringify({ schemaVersion: 1, fixtureSetVersion: EVENT_STAGING_FIXTURE_VERSION, runId, createdAt: now.toISOString() }));
	return { fixtureSetVersion: EVENT_STAGING_FIXTURE_VERSION, runId, parsed: { total: parsed.totalVEventCount, valid: parsed.validVEventCount, rejected: parsed.rejectedVEventCount }, imported, eventCount: (await listEvents(isolatedEnv)).length, snapshotRevision: snapshot.revision };
}

export async function cleanupEventStagingFixture(env: Env): Promise<number> {
	if (!syntheticFixturesAllowed(env)) throw new Error("synthetic_fixture_mode_disabled");
	let cursor: string | undefined, removed = 0;
	do {
		const page = await env.BEACH_DATA.list({ prefix: EVENT_STAGING_FIXTURE_PREFIX, ...(cursor ? { cursor } : {}) });
		for (const item of page.keys) { await env.BEACH_DATA.delete(item.name); removed += 1; }
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	return removed;
}
