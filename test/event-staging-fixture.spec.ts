import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/types";
import { auditAutomated } from "../src/beachEvents/store";
import { cleanupEventStagingFixture, EVENT_STAGING_FIXTURE_PREFIX, runEventStagingFixture } from "../src/local/eventStagingFixture";

function memoryEnv() {
	const values = new Map<string, { value: string; metadata?: unknown; expiration?: number }>();
	const kv = {
		get: async (key: string, type?: string) => { const item = values.get(key); return !item ? null : type === "json" ? JSON.parse(item.value) : item.value; },
		getWithMetadata: async (key: string, type?: string) => ({ value: await kv.get(key, type), metadata: values.get(key)?.metadata ?? null }),
		put: async (key: string, value: string, options?: KVNamespacePutOptions) => { values.set(key, { value, metadata: options?.metadata, expiration: options?.expiration }); },
		delete: async (key: string) => { values.delete(key); },
		list: async ({ prefix = "", cursor, limit = 1000 }: KVNamespaceListOptions = {}) => {
			const all = [...values.keys()].filter((key) => key.startsWith(prefix)).sort(), offset = cursor ? Number(cursor.slice(2)) : 0, names = all.slice(offset, offset + limit), next = offset + names.length;
			return { keys: names.map((name) => ({ name, ...(values.get(name)?.metadata !== undefined ? { metadata: values.get(name)?.metadata } : {}), ...(values.get(name)?.expiration !== undefined ? { expiration: values.get(name)?.expiration } : {}) })), list_complete: next >= all.length, ...(next < all.length ? { cursor: `c:${next}` } : {}) };
		},
	} as unknown as KVNamespace;
	return { values, env: { BEACH_DATA: kv, APP_ENVIRONMENT: "staging", VERIFICATION_ALERT_ENVIRONMENT: "staging", HISTORICAL_DATA_ENVIRONMENT: "staging", STAGING_SYNTHETIC_FIXTURES_ENABLED: "true" } as unknown as Env };
}

const fixtureKeys = (values: Map<string, unknown>) => [...values.keys()].filter((key) => key.startsWith(EVENT_STAGING_FIXTURE_PREFIX)).sort();
const fingerprints = (keys: string[]) => keys.map((key) => createHash("sha256").update(key).digest("hex").slice(0, 16));

describe("expanded local event staging fixture", () => {
	it("repeats exact physical identities, summaries, classifications, and cleanup", async () => {
		const runs = [];
		for (let index = 0; index < 2; index += 1) {
			const h = memoryEnv(); h.values.set("ordinary:event", { value: "sentinel" });
			const summary = await runEventStagingFixture(h.env), keys = fixtureKeys(h.values);
			expect(summary.verification.failed).toEqual([]);
			expect(summary).toMatchObject({ eventCount: 9, publicSnapshotEventCount: 1, providerHealthActionableTotals: { activeIncidents: 1, degradedProviders: 1 }, locationClassCounts: { beachSpecific: 9, nearbyCoastal: 1, regional: 1, irrelevant: 1 } });
			expect(summary.duplicateClassificationCounts).toMatchObject({ distinctOccurrence: expect.any(Number), likelyDuplicate: expect.any(Number) });
			expect(summary.identityCaseCounts).toEqual({ longDistinct: 2, recurrenceExceptions: 2, shortIdentity: 1 });
			expect(summary.lifecycleStateCounts).toMatchObject({ archived: 1, cancelled: 1, postponed: 1, sourceRemoved: 1, suspectedMissing: 1 });
			expect(keys).toHaveLength(summary.cleanupCount);
			expect(keys.every((key) => key.startsWith(EVENT_STAGING_FIXTURE_PREFIX))).toBe(true);
			expect(keys.filter((key) => key.includes(":audit:")).every((key) => !key.includes("synthetic-long") && !key.includes("Synthetic"))).toBe(true);
			expect(await cleanupEventStagingFixture(h.env)).toBe(keys.length);
			expect(await cleanupEventStagingFixture(h.env)).toBe(0);
			expect([...h.values.entries()]).toEqual([["ordinary:event", { value: "sentinel" }]]);
			runs.push({ summary, keys, fingerprints: fingerprints(keys) });
		}
		expect(runs[1]).toEqual(runs[0]);
	});

	it("retains random production audit IDs for identical logical writes", async () => {
		const h = memoryEnv(), now = new Date("2026-08-17T12:00:00.000Z"), context = { sourceRevision: "revision", changedFields: ["status"] };
		await auditAutomated(h.env, "scheduled", "fixture_action", "event", {}, now, context);
		await auditAutomated(h.env, "scheduled", "fixture_action", "event", {}, now, context);
		const keys = [...h.values.keys()].filter((key) => key.includes(":audit:"));
		expect(keys).toHaveLength(2);
		expect(new Set(keys).size).toBe(2);
	});

	it("fails closed instead of duplicating a fixture in a non-empty namespace", async () => {
		const h = memoryEnv(); await runEventStagingFixture(h.env); const before = fixtureKeys(h.values);
		await expect(runEventStagingFixture(h.env)).rejects.toThrow("synthetic_fixture_namespace_not_empty");
		expect(fixtureKeys(h.values)).toEqual(before);
	});
});
