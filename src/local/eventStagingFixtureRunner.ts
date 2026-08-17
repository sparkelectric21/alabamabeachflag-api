import type { Env } from "../types";
import { syntheticFixturesAllowed } from "../config/stagingIsolation";
import { parseICalendarResult } from "../beachEvents/ical";
import { AUDIT_PREFIX, EVENT_PREFIX, SNAPSHOT_KEY, applyImportedEvents, archiveCompletedEvents, listEvents, reconcileProviderSource, saveSnapshot, type EventAuditIdGenerator } from "../beachEvents/store";
import { assessDuplicate, auditDuplicateCandidates } from "../beachEvents/duplicates";
import { classifyEventLocation } from "../beachEvents/location";
import { listSourceObservations, observationIdentityHash } from "../beachEvents/observations";
import type { EventLocationClass } from "../beachEvents/types";
import { processProviderHealthObservations, PROVIDER_HEALTH_STATES_KEY, reconcileProviderHealthModes } from "../providerHealth/process";
import type { ProviderHealthState } from "../providerHealth/types";
import { createScopedKV } from "./scopedKV";

export const EVENT_STAGING_FIXTURE_VERSION = "events-isolation-v1";
export const EVENT_STAGING_FIXTURE_PREFIX = `synthetic:${EVENT_STAGING_FIXTURE_VERSION}:`;
const longPrefix = `synthetic-${"x".repeat(150)}`;
const vevent = (lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");
const fixtureCalendar = ["BEGIN:VCALENDAR", "VERSION:2.0",
	vevent([`UID:${longPrefix}-alpha`, "SUMMARY:Synthetic Identity Alpha", "LOCATION:Gulf State Park Beach Pavilion", "DTSTART:20260818T140000Z", "DTEND:20260818T150000Z"]),
	vevent([`UID:${longPrefix}-bravo`, "SUMMARY:Synthetic Identity Bravo", "LOCATION:Gulf State Park Beach Pavilion", "DTSTART:20260818T160000Z", "DTEND:20260818T170000Z"]),
	vevent([`UID:${longPrefix}-recurrence`, "RECURRENCE-ID:20260819T140000Z", "SUMMARY:Synthetic Recurrence", "LOCATION:Gulf State Park Beach Pavilion", "DTSTART:20260819T150000Z", "DTEND:20260819T160000Z"]),
	vevent([`UID:${longPrefix}-recurrence`, "RECURRENCE-ID:20260820T140000Z", "SUMMARY:Synthetic Recurrence", "LOCATION:Gulf State Park Beach Pavilion", "DTSTART:20260820T150000Z", "DTEND:20260820T160000Z"]),
	vevent(["UID:synthetic-short", "SUMMARY:Synthetic Short Identity", "LOCATION:Gulf State Park Beach Pavilion", "DTSTART:20260821T140000Z", "DTEND:20260821T150000Z"]),
	vevent(["UID:synthetic-duplicate-a", "SUMMARY:Synthetic Shoreline Workshop", "LOCATION:Gulf State Park Beach Pavilion", "DTSTART:20260822T140000Z", "DTEND:20260822T160000Z"]),
	vevent(["UID:synthetic-duplicate-b", "SUMMARY:Synthetic Shoreline Workshop", "LOCATION:Gulf State Park Beach Pavilion", "DTSTART:20260822T143000Z", "DTEND:20260822T160000Z"]),
	vevent(["UID:synthetic-cancelled", "SUMMARY:Synthetic Cancelled Program", "STATUS:CANCELLED", "LOCATION:Gulf State Park Beach Pavilion", "DTSTART:20260823T140000Z", "DTEND:20260823T150000Z"]),
	vevent(["UID:synthetic-postponed", "SUMMARY:Postponed: Synthetic Program", "LOCATION:Gulf State Park Beach Pavilion", "DTSTART:20260824T140000Z", "DTEND:20260824T150000Z"]),
	vevent(["UID:synthetic-nearby", "SUMMARY:Synthetic Nearby Program", "LOCATION:Gulf State Park Pier", "DTSTART:20260825T140000Z", "DTEND:20260825T150000Z"]),
	vevent(["UID:synthetic-regional", "SUMMARY:Synthetic Regional Program", "LOCATION:Various locations", "DTSTART:20260826T140000Z", "DTEND:20260826T150000Z"]),
	vevent(["UID:synthetic-irrelevant", "SUMMARY:Synthetic Inland Program", "LOCATION:Gulf State Park Nature Center", "DTSTART:20260827T140000Z", "DTEND:20260827T150000Z"]),
	vevent(["UID:synthetic-rejected", "SUMMARY:Synthetic Rejected Record"]), "END:VCALENDAR"].join("\r\n");

const countBy = (values: string[]) => Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((candidate) => candidate === value).length]));
const totalPublicEvents = (snapshot: { beaches: Record<string, unknown[]> }) => Object.values(snapshot.beaches).reduce((sum, events) => sum + events.length, 0);
const protectedFields = new Set(["sourceFacts", "sourceRevision", "confirmation", "locationReviewRequired", "possibleDuplicateOf", "duplicateAssessment", "internalNotes"]);
const createDeterministicAuditIdGenerator = (): EventAuditIdGenerator => {
	const occurrences = new Map<string, number>();
	return async (input) => {
		const logicalIdentity = `${EVENT_STAGING_FIXTURE_VERSION}\u0000${input.timestamp}\u0000${input.targetId}\u0000${input.action}\u0000${input.sourceRevision ?? "none"}`;
		const occurrence = occurrences.get(logicalIdentity) ?? 0; occurrences.set(logicalIdentity, occurrence + 1);
		const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${logicalIdentity}\u0000${occurrence}`));
		return `fixture_${[...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 40)}`;
	};
};
async function allListed(namespace: KVNamespace, prefix = "") {
	let cursor: string | undefined, keys: Array<{ name: string; expiration?: number; metadata?: unknown }> = [];
	do { const page = await namespace.list({ prefix, ...(cursor ? { cursor } : {}) }); keys = keys.concat(page.keys); cursor = page.list_complete ? undefined : page.cursor; } while (cursor);
	return keys;
}

export async function runEventStagingFixture(env: Env, now = new Date("2026-08-17T12:00:00.000Z")) {
	if (!syntheticFixturesAllowed(env)) throw new Error("synthetic_fixture_mode_disabled");
	const scoped = createScopedKV(env.BEACH_DATA, EVENT_STAGING_FIXTURE_PREFIX), isolatedEnv = { ...env, BEACH_DATA: scoped };
	if ((await allListed(scoped)).length) throw new Error("synthetic_fixture_namespace_not_empty");
	const auditIdGenerator = createDeterministicAuditIdGenerator();
	const provider = { id: "gulfStatePark", name: "Synthetic State Park", feedURL: "fixture://events-isolation-v1" };
	const parsed = parseICalendarResult(fixtureCalendar, provider), locationClasses = parsed.events.map((facts) => classifyEventLocation(facts).classification);
	const imported = await applyImportedEvents(isolatedEnv, parsed.events, now, "admin", auditIdGenerator);
	let importedEvents = await listEvents(isolatedEnv);
	const absenceCandidates = importedEvents.filter((event) => event.confirmation?.status === "confirmed" && !event.possibleDuplicateOf).sort((a, b) => b.endAt.localeCompare(a.endAt)).slice(0, 2);
	if (absenceCandidates.length !== 2) throw new Error("synthetic_fixture_absence_setup_failed");
	const seenExcept = (eventId: string) => new Set(importedEvents.filter((event) => event.id !== eventId).map((event) => event.sourceFacts.externalId));
	for (const offset of [0, 1, 3]) await reconcileProviderSource(isolatedEnv, provider.id, seenExcept(absenceCandidates[0].id), new Date(now.getTime() + offset * 86_400_000), "admin", auditIdGenerator);
	for (const offset of [0, 1]) await reconcileProviderSource(isolatedEnv, provider.id, seenExcept(absenceCandidates[1].id), new Date(now.getTime() + offset * 86_400_000), "admin", auditIdGenerator);
	importedEvents = await listEvents(isolatedEnv);
	const publishable = importedEvents.find((event) => event.confirmation?.status === "confirmed" && !event.possibleDuplicateOf);
	const archivable = importedEvents.find((event) => event.id !== publishable?.id && event.confirmation?.status === "confirmed" && !event.possibleDuplicateOf);
	if (!publishable || !archivable) throw new Error("synthetic_fixture_setup_failed");
	await scoped.put(`${EVENT_PREFIX}${publishable.id}`, JSON.stringify({ ...publishable, status: "published" }));
	await scoped.put(`${EVENT_PREFIX}${archivable.id}`, JSON.stringify({ ...archivable, status: "published", startAt: "2026-08-16T10:00:00.000Z", endAt: "2026-08-16T11:00:00.000Z" }));
	const archival = await archiveCompletedEvents(isolatedEnv, now, "admin", auditIdGenerator), events = await listEvents(isolatedEnv);
	const snapshot = await saveSnapshot(isolatedEnv, now), snapshotRead = await scoped.get<typeof snapshot>(SNAPSHOT_KEY, "json");
	const observations = await listSourceObservations(isolatedEnv, provider.id);
	const auditKeys = await allListed(scoped, AUDIT_PREFIX), audits = (await Promise.all(auditKeys.map((key) => scoped.get<{ targetId?: string }>(key.name, "json")))).filter((value): value is { targetId?: string } => Boolean(value));
	const eventIds = new Set(events.map((event) => event.id)), eventHashes = new Set(events.map((event) => observationIdentityHash(event.sourceFacts.externalId)));
	const duplicateAudit = auditDuplicateCandidates(events), duplicateAssessments = events.flatMap((event, index) => events.slice(index + 1).map((candidate) => assessDuplicate(event, candidate))), transport = { send: async () => undefined };
	await processProviderHealthObservations(isolatedEnv, [{ provider: "syntheticHealthy", domain: "beach_events", affectedBeachCount: 0, expectedBeachCount: 3, ingestionMode: "enabled" }], now.toISOString(), transport);
	for (const providerId of ["syntheticDegraded", "syntheticEnded"]) for (let index = 0; index < 2; index += 1) await processProviderHealthObservations(isolatedEnv, [{ provider: providerId, domain: "beach_events", affectedBeachCount: 2, expectedBeachCount: 3, errorReason: "synthetic_failure", ingestionMode: "enabled" }], new Date(now.getTime() + index * 1000).toISOString(), transport);
	await reconcileProviderHealthModes(isolatedEnv, new Map([["syntheticHealthy:beach_events", "enabled"], ["syntheticDegraded:beach_events", "enabled"], ["syntheticEnded:beach_events", "disabled"]]), new Date(now.getTime() + 2000).toISOString());
	const health = await scoped.get<{ states: ProviderHealthState[] }>(PROVIDER_HEALTH_STATES_KEY, "json"), healthStates = health?.states ?? [];
	const runId = `fixture-${EVENT_STAGING_FIXTURE_VERSION}-${now.toISOString()}`;
	await scoped.put("manifest", JSON.stringify({ schemaVersion: 2, fixtureSetVersion: EVENT_STAGING_FIXTURE_VERSION, runId, createdAt: now.toISOString() }));
	const logicalKeys = await allListed(scoped), physicalKeys = await allListed(env.BEACH_DATA, EVENT_STAGING_FIXTURE_PREFIX);
	const publicEvents = snapshotRead ? Object.values(snapshotRead.beaches).flat() : [], locationMatrix = (["beachSpecific", "nearbyCoastal", "regional", "irrelevant"] as EventLocationClass[]).every((value) => locationClasses.includes(value));
	const identityCaseCounts = { longDistinct: parsed.events.filter((fact) => fact.externalId.startsWith(longPrefix) && !fact.recurrenceId).length, recurrenceExceptions: parsed.events.filter((fact) => fact.recurrenceId).length, shortIdentity: parsed.events.filter((fact) => fact.externalId === "synthetic-short").length };
	const assertions = {
		allPhysicalKeysScoped: physicalKeys.every((key) => key.name.startsWith(EVENT_STAGING_FIXTURE_PREFIX)), applicationReadsPopulated: events.length === importedEvents.length,
		populatedSnapshot: publicEvents.length > 0, publicPayloadProtectedFieldsAbsent: publicEvents.every((event) => Object.keys(event as object).every((key) => !protectedFields.has(key))),
		observationsAssociated: observations.length >= events.length && observations.every((observation) => eventHashes.has(observation.externalIdHash)), auditsAssociated: audits.length > 0 && audits.every((audit) => !audit.targetId || eventIds.has(audit.targetId)),
		archivalReadPath: archival.archived === 1 && events.some((event) => event.status === "completed"), duplicateReadPath: duplicateAudit.candidates.length > 0,
		healthMatrix: healthStates.some((state) => state.currentStatus === "healthy") && healthStates.some((state) => state.incidentActionable) && healthStates.some((state) => state.monitoringStatus === "ended" && state.incidentActionable === false), locationMatrix,
		identityMatrix: identityCaseCounts.longDistinct === 2 && identityCaseCounts.recurrenceExceptions === 2 && identityCaseCounts.shortIdentity === 1 && new Set(events.map((event) => event.id)).size === events.length,
	};
	const failed = Object.entries(assertions).filter(([, passed]) => !passed).map(([name]) => name);
	return { fixtureSetVersion: EVENT_STAGING_FIXTURE_VERSION, runId, physicalKeyPrefix: EVENT_STAGING_FIXTURE_PREFIX,
		parsed: { total: parsed.totalVEventCount, valid: parsed.validVEventCount, rejected: parsed.rejectedVEventCount }, imported,
		logicalKeyCount: logicalKeys.length, physicalKeyCount: physicalKeys.length, logicalKeyCountsByCategory: countBy(logicalKeys.map((key) => key.name.split(":")[0])), physicalKeyCountsByCategory: countBy(physicalKeys.map((key) => key.name.slice(EVENT_STAGING_FIXTURE_PREFIX.length).split(":")[0])),
		eventCount: events.length, publicSnapshotEventCount: snapshotRead ? totalPublicEvents(snapshotRead) : 0, snapshotRevision: snapshot.revision,
		providerHealthStateCounts: countBy(healthStates.map((state) => `${state.ingestionMode ?? "legacy"}:${state.currentStatus}:${state.monitoringStatus ?? "legacy"}`)), providerHealthActionableTotals: { activeIncidents: healthStates.filter((state) => state.incidentActionable && state.activeIncidentId).length, degradedProviders: healthStates.filter((state) => state.incidentActionable && state.currentStatus !== "healthy").length },
		locationClassCounts: countBy(locationClasses), identityCaseCounts, lifecycleStateCounts: countBy(events.map((event) => event.confirmation?.status ?? event.status)), duplicateClassificationCounts: countBy(duplicateAssessments.map((candidate) => candidate.classification)),
		observationCount: observations.length, auditCount: audits.length, cleanupCount: physicalKeys.length, verification: { passed: Object.keys(assertions).filter((name) => !failed.includes(name)), failed } };
}

export async function cleanupEventStagingFixture(env: Env): Promise<number> {
	if (!syntheticFixturesAllowed(env)) throw new Error("synthetic_fixture_mode_disabled");
	let cursor: string | undefined; const names: string[] = [];
	do { const page = await env.BEACH_DATA.list({ prefix: EVENT_STAGING_FIXTURE_PREFIX, ...(cursor ? { cursor } : {}) }); names.push(...page.keys.map((item) => item.name)); cursor = page.list_complete ? undefined : page.cursor; } while (cursor);
	for (const name of names) await env.BEACH_DATA.delete(name);
	return names.length;
}
