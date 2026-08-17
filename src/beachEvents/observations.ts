import type { Env } from "../types";
import { stableHash } from "./sourceChanges";
import type { SourceChangeSeverity, SourceFacts } from "./types";

export const SOURCE_OBSERVATION_PREFIX = "beach-events:v1:source-observation:";
/** Newly written observations expire after 400 days; only additional transition/material compaction is deferred. */
export const SOURCE_OBSERVATION_RETENTION_SECONDS = 400 * 24 * 60 * 60;
export interface SourceObservation {
	version: 1 | 2; id: string; providerId: string; externalIdHash: string; observedAt: string; sourceRevision: string;
	facts: Partial<SourceFacts>; completeness: "complete" | "partial" | "confirmedUnchanged" | "failed" | "qualityRejected";
	confirmationOutcome: string; severity: SourceChangeSeverity; materialFields: string[]; cosmeticFields: string[];
	sourceReference?: string; approvedRevision?: string;
}
const bounded = (value: unknown, max: number) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : undefined;
export function observationIdentityHash(value: string): string {
	const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
	return seeds.map((seed) => { let hash = seed >>> 0; for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; } return hash.toString(16).padStart(8, "0"); }).join("");
}
export function sanitizeObservationFacts(facts: SourceFacts): Partial<SourceFacts> {
	return {
		providerId: bounded(facts.providerId, 80)!, externalId: observationIdentityHash(facts.externalId), title: bounded(facts.title, 180)!, venue: bounded(facts.venue, 180)!,
		...(facts.address ? { address: bounded(facts.address, 220) } : {}), startAt: facts.startAt, endAt: facts.endAt, allDay: Boolean(facts.allDay), recurring: Boolean(facts.recurring),
		sourceName: bounded(facts.sourceName, 120)!, sourceURL: bounded(facts.sourceURL, 500)!, ...(facts.sourceStatus ? { sourceStatus: facts.sourceStatus } : {}), ...(facts.recurrenceId ? { recurrenceId: facts.recurrenceId } : {}),
	};
}
export async function persistSourceObservation(env: Pick<Env, "BEACH_DATA">, input: Omit<SourceObservation, "version" | "id" | "externalIdHash" | "facts"> & { facts: SourceFacts }): Promise<{ observation: SourceObservation; created: boolean }> {
	const externalIdHash = observationIdentityHash(input.facts.externalId);
	const identity = observationIdentityHash(`${input.providerId}|${input.facts.externalId}|${input.sourceRevision}|${input.completeness}|${input.confirmationOutcome}`);
	const id = `${encodeURIComponent(input.providerId)}:${externalIdHash}:${identity}`, key = `${SOURCE_OBSERVATION_PREFIX}${id}`;
	const legacyExternalIdHash = stableHash(input.facts.externalId), legacyIdentity = stableHash(`${input.providerId}|${legacyExternalIdHash}|${input.sourceRevision}|${input.completeness}|${input.confirmationOutcome}`), legacyKey = `${SOURCE_OBSERVATION_PREFIX}${encodeURIComponent(input.providerId)}:${legacyExternalIdHash}:${legacyIdentity}`;
	const legacy = await env.BEACH_DATA.get<SourceObservation>(legacyKey, "json");
	if (legacy) return { observation: legacy, created: false };
	const prior = await env.BEACH_DATA.get<SourceObservation>(key, "json");
	if (prior) return { observation: prior, created: false };
	const observation: SourceObservation = { version: 2, id, providerId: bounded(input.providerId, 80)!, externalIdHash, observedAt: input.observedAt, sourceRevision: input.sourceRevision, facts: sanitizeObservationFacts(input.facts), completeness: input.completeness, confirmationOutcome: bounded(input.confirmationOutcome, 80)!, severity: input.severity, materialFields: input.materialFields.slice(0, 40).map((item) => bounded(item, 80)!), cosmeticFields: input.cosmeticFields.slice(0, 40).map((item) => bounded(item, 80)!), ...(input.sourceReference ? { sourceReference: bounded(input.sourceReference, 500) } : {}), ...(input.approvedRevision ? { approvedRevision: bounded(input.approvedRevision, 80) } : {}) };
	await env.BEACH_DATA.put(key, JSON.stringify(observation), { expirationTtl: SOURCE_OBSERVATION_RETENTION_SECONDS });
	return { observation, created: true };
}
export async function listSourceObservations(env: Pick<Env, "BEACH_DATA">, providerId?: string): Promise<SourceObservation[]> {
	const prefix = `${SOURCE_OBSERVATION_PREFIX}${providerId ? `${encodeURIComponent(providerId)}:` : ""}`;
	const listed = await env.BEACH_DATA.list({ prefix, limit: 1000 });
	return (await Promise.all(listed.keys.map((key) => env.BEACH_DATA.get<SourceObservation>(key.name, "json")))).filter((item): item is SourceObservation => Boolean(item)).sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id));
}
