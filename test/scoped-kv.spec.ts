import { describe, expect, it } from "vitest";
import { createScopedKV } from "../src/local/scopedKV";
import { EVENT_STAGING_FIXTURE_PREFIX, cleanupEventStagingFixture } from "../src/local/eventStagingFixture";
import type { Env } from "../src/types";

function memoryKV(pageSize = 1000) {
	const values = new Map<string, { value: string; metadata?: unknown; expiration?: number }>();
	const kv = {
		get: async (key: string, type?: string) => { const item = values.get(key); return !item ? null : type === "json" ? JSON.parse(item.value) : item.value; },
		getWithMetadata: async (key: string, type?: string) => { const item = values.get(key); return { value: !item ? null : type === "json" ? JSON.parse(item.value) : item.value, metadata: item?.metadata ?? null }; },
		put: async (key: string, value: string, options?: KVNamespacePutOptions) => { values.set(key, { value, metadata: options?.metadata, expiration: options?.expiration }); },
		delete: async (key: string) => { values.delete(key); },
		list: async ({ prefix = "", cursor, limit }: KVNamespaceListOptions = {}) => {
			const names = [...values.keys()].filter((key) => key.startsWith(prefix)).sort();
			const offset = cursor ? Number(cursor.slice(2)) : 0;
			const count = Math.min(limit ?? 1000, pageSize), page = names.slice(offset, offset + count), next = offset + page.length;
			return { keys: page.map((name) => ({ name, ...(values.get(name)?.metadata !== undefined ? { metadata: values.get(name)?.metadata } : {}), ...(values.get(name)?.expiration !== undefined ? { expiration: values.get(name)?.expiration } : {}) })), list_complete: next >= names.length, ...(next < names.length ? { cursor: `c:${next}` } : {}) };
		},
	} as unknown as KVNamespace;
	return { kv, values };
}

describe("fixed-prefix scoped KV", () => {
	it("round-trips relative keys and list names without double-prefixing", async () => {
		const base = memoryKV(), scoped = createScopedKV(base.kv, EVENT_STAGING_FIXTURE_PREFIX);
		await scoped.put("records:one", "first");
		expect(await scoped.get("records:one")).toBe("first");
		const listed = await scoped.list();
		expect(listed.keys.map(({ name }) => name)).toEqual(["records:one"]);
		expect(await scoped.get(listed.keys[0].name)).toBe("first");
		expect([...base.values.keys()]).toEqual([`${EVENT_STAGING_FIXTURE_PREFIX}records:one`]);
		await scoped.delete(listed.keys[0].name);
		expect(base.values.size).toBe(0);
	});

	it("preserves prefix filtering, opaque cursors, pagination, metadata, and expiration", async () => {
		const base = memoryKV(2), scoped = createScopedKV(base.kv, EVENT_STAGING_FIXTURE_PREFIX);
		await scoped.put("event:a", "a", { metadata: { kind: "event" }, expiration: 2_000_000_000 });
		await scoped.put("event:b", "b"); await scoped.put("event:c", "c"); await scoped.put("other:a", "x");
		const first = await scoped.list({ prefix: "event:", limit: 2 });
		expect(first).toMatchObject({ list_complete: false, cursor: "c:2" });
		expect(first.keys[0]).toEqual({ name: "event:a", metadata: { kind: "event" }, expiration: 2_000_000_000 });
		const second = await scoped.list({ prefix: "event:", limit: 2, cursor: first.cursor });
		expect(second).toMatchObject({ list_complete: true });
		expect(second.keys.map(({ name }) => name)).toEqual(["event:c"]);
	});

	it("fails closed for invalid, already-physical, oversized, and ambiguous inputs", async () => {
		const base = memoryKV(), scoped = createScopedKV(base.kv, EVENT_STAGING_FIXTURE_PREFIX);
		for (const key of ["", ".", "..", `${EVENT_STAGING_FIXTURE_PREFIX}event:a`, "x".repeat(513)]) {
			expect(() => scoped.put(key, "x")).toThrow("invalid_scoped_kv_key");
		}
		expect(() => scoped.get(`${EVENT_STAGING_FIXTURE_PREFIX}event:a`)).toThrow("invalid_scoped_kv_key");
		await expect(scoped.list({ prefix: EVENT_STAGING_FIXTURE_PREFIX })).rejects.toThrow("invalid_scoped_kv_prefix");
		for (const key of ["/absolute", "../escape", "%2e%2e%2fescape", "a::b"]) await scoped.put(key, "safe");
		expect([...base.values.keys()].every((key) => key.startsWith(EVENT_STAGING_FIXTURE_PREFIX))).toBe(true);
	});

	it("cleanup remains physical-prefix-only and preserves ordinary records", async () => {
		const base = memoryKV(1), scoped = createScopedKV(base.kv, EVENT_STAGING_FIXTURE_PREFIX);
		base.values.set("ordinary:event", { value: "sentinel" });
		await scoped.put("event:a", "a"); await scoped.put("event:b", "b");
		const env = { BEACH_DATA: base.kv, APP_ENVIRONMENT: "staging", VERIFICATION_ALERT_ENVIRONMENT: "staging", HISTORICAL_DATA_ENVIRONMENT: "staging", STAGING_SYNTHETIC_FIXTURES_ENABLED: "true" } as unknown as Env;
		expect(await cleanupEventStagingFixture(env)).toBe(2);
		expect(await cleanupEventStagingFixture(env)).toBe(0);
		expect([...base.values.entries()]).toEqual([["ordinary:event", { value: "sentinel" }]]);
	});
});
