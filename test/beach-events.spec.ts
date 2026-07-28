import { describe, expect, it, vi } from "vitest";
import { exactBeachMatch } from "../src/beachEvents/matching";
import { parseICalendar } from "../src/beachEvents/ical";
import { applyImportedEvents, buildSnapshot, normalizedEvent, validateManualEvent } from "../src/beachEvents/store";
import { refreshBeachEvents } from "../src/beachEvents/refresh";
import type { BeachEvent, SourceFacts } from "../src/beachEvents/types";
import type { Env } from "../src/types";

function memoryEnv() {
	const values = new Map<string, string>();
	const kv = {
		get: vi.fn(async (key: string, type?: string) => {
			const value = values.get(key);
			return value === undefined ? null : type === "json" ? JSON.parse(value) : value;
		}),
		put: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
		delete: vi.fn(async (key: string) => { values.delete(key); }),
		list: vi.fn(async ({ prefix }: { prefix: string }) => ({ keys: [...values.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })), list_complete: true })),
	};
	return { env: { BEACH_DATA: kv } as unknown as Env, values, kv };
}

const facts = (overrides: Partial<SourceFacts> = {}): SourceFacts => ({
	providerId: "gulfShoresCity", externalId: "1", title: "Coastal Cleanup", venue: "Gulf Place Town Green",
	startAt: "2026-08-01T13:00:00.000Z", endAt: "2026-08-01T15:00:00.000Z", allDay: false, recurring: false,
	sourceName: "City of Gulf Shores", sourceURL: "https://www.gulfshoresal.gov/", ...overrides,
});

describe("exact beach event matching", () => {
	it("matches approved exact venue and address aliases", () => {
		expect(exactBeachMatch({ providerId: "gulfShoresCity", venue: "Gulf Place Town Green" })).toEqual({ beachId: "gulf-shores-public-beach", method: "sourceAlias" });
		expect(exactBeachMatch({ providerId: "x", address: "25900 Perdido Beach Blvd, Orange Beach, AL 36561" })).toEqual({ beachId: "cotton-bayou", method: "exactAddress" });
	});

	it("rejects citywide, excluded, nearby, and unsupported Flora-Bama locations", () => {
		for (const venue of ["Gulf Shores", "Meyer Park", "The Wharf", "Flora-Bama", "Orange Beach Waterfront Park"]) expect(exactBeachMatch({ providerId: "x", venue })).toBeNull();
	});
});

describe("iCalendar normalization", () => {
	it("parses Central floating times, recurrence, all-day, and multi-day events", () => {
		const data = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:abc\r\nSUMMARY:Beach Cleanup\r\nLOCATION:Gulf Shores Public Beach\r\nDTSTART;TZID=America/Chicago:20260308T013000\r\nDTEND;TZID=America/Chicago:20260309T020000\r\nRRULE:FREQ=YEARLY\r\nURL:https://example.gov/event\r\nEND:VEVENT\r\nEND:VCALENDAR";
		const [event] = parseICalendar(data, { id: "x", name: "Official", feedURL: "https://example.gov/feed.ics" });
		expect(event.recurring).toBe(true);
		expect(Date.parse(event.endAt)).toBeGreaterThan(Date.parse(event.startAt));
		expect(event.officialURL).toBe("https://example.gov/event");
	});
});

describe("event lifecycle", () => {
	it("deduplicates recurring imports and preserves source facts when local edits exist", async () => {
		const h = memoryEnv();
		expect(await applyImportedEvents(h.env, [facts(), facts()], new Date("2026-07-28T12:00:00Z"))).toMatchObject({ discovered: 1, matched: 2 });
		expect([...h.values.keys()].filter((key) => key.includes(":event:"))).toHaveLength(1);
	});

	it("expires ended items from the public snapshot and keeps active multi-day items", () => {
		const base = normalizedEvent(facts(), new Date("2026-07-28T12:00:00Z"))!;
		const active = { ...base, status: "published", endAt: "2026-08-02T12:00:00Z" } as BeachEvent;
		const expired = { ...base, id: "old", status: "published", endAt: "2026-07-27T12:00:00Z" } as BeachEvent;
		expect(buildSnapshot([active, expired], new Date("2026-08-01T12:00:00Z")).beaches["gulf-shores-public-beach"]).toEqual([active]);
	});

	it("validates manual types, impacts, dates, and HTTPS sources", () => {
		expect(validateManualEvent({ title: "x", beachId: "cotton-bayou", venue: "Cotton Bayou Public Beach", startAt: "2026-08-01T10:00:00Z", endAt: "2026-08-01T11:00:00Z", eventType: "unknown", impactLevel: "loud", status: "invalid", sourceName: "Organizer", sourceURL: "http://example.com", bannerTitle: "x", bannerMessage: "x" })).toEqual(expect.arrayContaining(["eventType", "impactLevel", "status", "sourceURL"]));
	});

	it("isolates provider failures and does not write a beach-condition key", async () => {
		const h = memoryEnv();
		const fetcher = vi.fn(async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
		const result = await refreshBeachEvents(h.env, new Date("2026-07-28T12:00:00Z"), fetcher);
		expect(result.outcome).toBe("partial");
		expect(h.kv.put.mock.calls.some(([key]) => key === "beach-conditions")).toBe(false);
	});
});
