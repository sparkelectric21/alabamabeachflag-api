import { describe, expect, it, vi } from "vitest";
import { exactBeachMatch, explainBeachMatch } from "../src/beachEvents/matching";
import { parseICalendar } from "../src/beachEvents/ical";
import { BEACH_EVENT_PROVIDERS } from "../src/beachEvents/providers";
import { applyImportedEvents, buildSnapshot, isEventVisibleNow, normalizedEvent, validateManualEvent } from "../src/beachEvents/store";
import { readBeachEventRefreshStatus, refreshBeachEvents, REFRESH_STATUS_KEY } from "../src/beachEvents/refresh";
import { isBeachEventRefreshHour, nextBeachEventRefresh } from "../src/beachEvents/schedule";
import { CURRENT_KEY, defaultOperationalControl } from "../src/operationalControl/store";
import type { BeachEvent, SourceFacts } from "../src/beachEvents/types";
import type { Env } from "../src/types";
import { handleBeachEventsAdminUpdate, handleBeachEventsRequest } from "../src/routes/beachEvents";

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
	it("keeps the Town provider disabled while automated retrieval lacks permission", () => {
		expect(BEACH_EVENT_PROVIDERS.find((provider) => provider.id === "dauphinIslandTown")).toMatchObject({
			mode: "disabled",
			legalStatus: "permission-required",
			publicFeed: true,
			supportedBeachIds: ["dauphin-island-public-beach", "dauphin-island-east-end"],
		});
	});

	it("matches approved exact venue and address aliases", () => {
		expect(exactBeachMatch({ providerId: "gulfShoresCity", venue: "Gulf Place Town Green" })).toEqual({ beachId: "gulf-shores-public-beach", method: "sourceAlias" });
		expect(exactBeachMatch({ providerId: "x", address: "25900 Perdido Beach Blvd, Orange Beach, AL 36561" })).toEqual({ beachId: "cotton-bayou", method: "exactAddress" });
		expect(exactBeachMatch({ providerId: "dauphinIslandTown", venue: "East End Beach" })).toEqual({ beachId: "dauphin-island-east-end", method: "exactVenue" });
		expect(exactBeachMatch({ providerId: "dauphinIslandTown", venue: "Middle Beach" })).toEqual({ beachId: "dauphin-island-public-beach", method: "exactVenue" });
		expect(exactBeachMatch({ providerId: "dauphinIslandTown", venue: "Bienville Beach" })).toEqual({ beachId: "dauphin-island-public-beach", method: "exactVenue" });
		expect(exactBeachMatch({ providerId: "dauphinIslandTown", address: "1917 Bienville Boulevard, Dauphin Island, AL 36528" })).toEqual({ beachId: "dauphin-island-public-beach", method: "exactAddress" });
	});

	it("rejects citywide, excluded, nearby, and unsupported Flora-Bama locations", () => {
		for (const venue of ["Gulf Shores", "Meyer Park", "The Wharf", "Flora-Bama", "Orange Beach Waterfront Park"]) expect(exactBeachMatch({ providerId: "x", venue })).toBeNull();
	});

	it("matches Tier One exact locations and explains strict exclusions", () => {
		expect(exactBeachMatch({ providerId: "gulfStatePark", venue: "Beach Pavilion" })).toEqual({ beachId: "gulf-state-park-pavilion", method: "exactVenue" });
		expect(exactBeachMatch({ providerId: "gulfStatePark", venue: "Gulf State Park Pavillion, 22250 E Beach Blvd, Gulf Shores, AL 36542, USA" })).toEqual({ beachId: "gulf-state-park-pavilion", method: "sourceAlias" });
		expect(explainBeachMatch({ providerId: "gulfStatePark", venue: "Gulf State Park Nature Center" })).toMatchObject({ exclusionReason: "inlandVenue" });
		expect(explainBeachMatch({ providerId: "gulfStatePark", venue: "Gulf State Park Nature Center, 22120 Campground Rd, Orange Beach, AL 36561, USA" })).toMatchObject({ exclusionReason: "inlandVenue" });
		expect(exactBeachMatch({ providerId: "alabamaAudubon", venue: "Dauphin Island Middle Beach" })).toEqual({ beachId: "dauphin-island-public-beach", method: "sourceAlias" });
		expect(explainBeachMatch({ providerId: "alabamaAudubon", venue: "Dauphin Island" })).toMatchObject({ exclusionReason: "citywideOrBroadLocation" });
		expect(explainBeachMatch({ providerId: "dauphinIslandSeaLab", venue: "Dauphin Island Sea Lab" })).toMatchObject({ exclusionReason: "inlandVenue" });
		expect(explainBeachMatch({ providerId: "alabamaAudubon", venue: "Fort Morgan State Historic Site" })).toMatchObject({ exclusionReason: "inlandVenue" });
		expect(exactBeachMatch({ providerId: "alabamaCoastalCleanup", venue: "Fort Morgan Public Beach Cleanup Zone" })).toEqual({ beachId: "fort-morgan-public-beach", method: "sourceAlias" });
		expect(exactBeachMatch({ providerId: "orangeBeachCoastalResources", venue: "Alabama Point" })).toEqual({ beachId: "alabama-point", method: "sourceAlias" });
		expect(explainBeachMatch({ providerId: "dauphinIslandTown", venue: "West End Beach" })).toMatchObject({ reason: "Exact beach not represented in app", exclusionReason: "exactBeachNotRepresented" });
		for (const venue of ["Dauphin Island", "Dauphin Island Town Hall", "Dauphin Island Community Center", "Dauphin Island Sea Lab", "Alabama Aquarium", "Fort Gaines", "Audubon Bird Sanctuary", "Dauphin Island Campground", "Dauphin Island Marina"]) {
			expect(exactBeachMatch({ providerId: "dauphinIslandTown", venue })).toBeNull();
		}
	});

	it("maps only official exact Gulf State Park Pier aliases to Pavilion", () => {
		expect(exactBeachMatch({ providerId: "gulfStatePark", venue: "Gulf State Park Pier" })).toEqual({ beachId: "gulf-state-park-pavilion", method: "sourceAlias" });
		expect(exactBeachMatch({ providerId: "gulfStatePark", venue: "Gulf State Park Fishing and Education Pier, 20800 E Beach Blvd, Gulf Shores, AL 36542, USA" })).toEqual({ beachId: "gulf-state-park-pavilion", method: "sourceAlias" });
		expect(exactBeachMatch({ providerId: "x", venue: "Gulf State Park Pier" })).toBeNull();
		expect(exactBeachMatch({ providerId: "gulfStatePark", venue: "Pier" })).toBeNull();
		for (const venue of ["Gulf State Park Nature Center", "Gulf State Park Learning Campus", "Lake Shelby Picnic Area"]) {
			expect(explainBeachMatch({ providerId: "gulfStatePark", venue })).toMatchObject({ exclusionReason: "inlandVenue" });
		}
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

	it("reassesses a formerly excluded Pier candidate as pending review", async () => {
		const h = memoryEnv();
		const pier = facts({ providerId: "gulfStatePark", externalId: "pier-1", venue: "Gulf State Park Pier" });
		h.values.set("beach-events:v1:excluded:gulfStatePark-pier-1", JSON.stringify({ id: "gulfStatePark-pier-1" }));
		expect(await applyImportedEvents(h.env, [pier], new Date("2026-07-28T12:00:00Z"))).toMatchObject({ discovered: 1, pendingReview: 1 });
		expect(h.values.has("beach-events:v1:excluded:gulfStatePark-pier-1")).toBe(false);
		expect(JSON.parse(h.values.get("beach-events:v1:event:imported-gulfStatePark-pier-1")!)).toMatchObject({ beachId: "gulf-state-park-pavilion", status: "pendingReview", matchExplanation: "Exact source venue alias" });
	});

	it("expires ended items from the public snapshot and keeps active multi-day items", () => {
		const base = normalizedEvent(facts(), new Date("2026-07-28T12:00:00Z"))!;
		const active = { ...base, status: "published", endAt: "2026-08-02T12:00:00Z" } as BeachEvent;
		const expired = { ...base, id: "old", status: "published", endAt: "2026-07-27T12:00:00Z" } as BeachEvent;
		expect(buildSnapshot([active, expired], new Date("2026-08-01T12:00:00Z")).beaches["gulf-shores-public-beach"]).toEqual([active]);
	});

	it("uses the same Central-Time display window as iOS for active counts", () => {
		const base = normalizedEvent(facts(), new Date("2026-07-28T12:00:00Z"))!;
		const ordinaryTomorrow = { ...base, status: "published", startAt: "2026-08-02T15:00:00Z", endAt: "2026-08-02T16:00:00Z" } as BeachEvent;
		expect(isEventVisibleNow(ordinaryTomorrow, new Date("2026-08-01T18:00:00Z"))).toBe(false);
		expect(isEventVisibleNow({ ...ordinaryTomorrow, impactLevel: "high" }, new Date("2026-08-01T18:00:00Z"))).toBe(true);
		expect(isEventVisibleNow({ ...ordinaryTomorrow, displayFrom: "2026-08-01T17:00:00Z" }, new Date("2026-08-01T18:00:00Z"))).toBe(true);
		expect(isEventVisibleNow({ ...ordinaryTomorrow, startAt: "2026-08-01T20:00:00Z", endAt: "2026-08-03T01:00:00Z" }, new Date("2026-08-02T12:00:00Z"))).toBe(true);
	});

	it("validates manual types, impacts, dates, and HTTPS sources", () => {
		expect(validateManualEvent({ title: "x", beachId: "cotton-bayou", venue: "Cotton Bayou Public Beach", startAt: "2026-08-01T10:00:00Z", endAt: "2026-08-01T11:00:00Z", eventType: "unknown", impactLevel: "loud", status: "invalid", sourceName: "Organizer", sourceURL: "http://example.com", bannerTitle: "x", bannerMessage: "x" })).toEqual(expect.arrayContaining(["eventType", "impactLevel", "status", "sourceURL"]));
	});

	it("allows an ended event to transition to expired but rejects premature expiry", () => {
		const event = {
			title: "Cleanup", beachId: "cotton-bayou", venue: "Cotton Bayou Public Beach",
			startAt: "2026-08-01T10:00:00Z", endAt: "2026-08-01T11:00:00Z",
			eventType: "beachCleanup", impactLevel: "informational", status: "expired",
			sourceName: "Organizer", sourceURL: "https://example.com/event",
			bannerTitle: "Beach cleanup here today", bannerMessage: "Activity scheduled.",
		};
		expect(validateManualEvent(event, new Date("2026-08-01T12:00:00Z"))).toEqual([]);
		expect(validateManualEvent(event, new Date("2026-08-01T10:30:00Z"))).toContain("status");
	});

	it("edits imported app fields while preserving identity, source facts, and status", async () => {
		const h = memoryEnv();
		const original = { ...normalizedEvent(facts(), new Date("2026-07-28T12:00:00Z"))!, status: "pendingReview" } as BeachEvent;
		h.values.set(`beach-events:v1:event:${original.id}`, JSON.stringify(original));
		const response = await handleBeachEventsAdminUpdate(
			new Request(`https://example.com/admin/beach-events/${original.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: "Updated cleanup", bannerMessage: "Updated copy.", beachId: "dauphin-island-east-end" }),
			}),
			h.env,
			{ method: "access", subject: "operator@example.com" },
			original.id,
			new Date("2026-07-28T13:00:00Z"),
		);
		expect(response.status).toBe(200);
		const updated = (await response.json() as { event: BeachEvent }).event;
		expect(updated).toMatchObject({ id: original.id, title: "Updated cleanup", bannerMessage: "Updated copy.", beachId: "dauphin-island-east-end", status: "pendingReview", sourceFacts: original.sourceFacts, createdAt: original.createdAt });
		const auditRecord = [...h.values.entries()].find(([key]) => key.startsWith("beach-events:v1:audit:"))?.[1];
		expect(JSON.parse(auditRecord!)).toMatchObject({ changes: { title: "Updated cleanup", bannerMessage: "Updated copy.", beachId: "dauphin-island-east-end" } });
	});

	it("publishes a revision ETag and honors conditional revalidation", async () => {
		const h = memoryEnv();
		const event = { ...normalizedEvent(facts(), new Date("2026-07-28T12:00:00Z"))!, status: "published" } as BeachEvent;
		h.values.set(`beach-events:v1:event:${event.id}`, JSON.stringify(event));
		const snapshot = buildSnapshot([event], new Date("2026-07-28T12:00:00Z"));
		h.values.set("beach-events:v1:snapshot", JSON.stringify(snapshot));
		const first = await handleBeachEventsRequest(new Request("https://example.com/v1/beach-events"), h.env, new Date("2026-07-28T13:00:00Z"));
		expect(first.status).toBe(200);
		expect(first.headers.get("cache-control")).toContain("must-revalidate");
		const etag = first.headers.get("etag")!;
		const conditional = await handleBeachEventsRequest(new Request("https://example.com/v1/beach-events", { headers: { "If-None-Match": etag } }), h.env, new Date("2026-07-28T13:00:00Z"));
		expect(conditional.status).toBe(304);
	});

	it("expires a stored event at request time and changes the visible revision", async () => {
		const h = memoryEnv();
		const event = { ...normalizedEvent(facts(), new Date("2026-08-01T12:00:00Z"))!, status: "published" } as BeachEvent;
		const snapshot = buildSnapshot([event], new Date("2026-08-01T12:00:00Z"));
		h.values.set("beach-events:v1:snapshot", JSON.stringify(snapshot));
		const active = await handleBeachEventsRequest(new Request("https://example.com/v1/beach-events"), h.env, new Date("2026-08-01T14:00:00Z"));
		const activeBody = await active.json() as BeachEventsSnapshot;
		expect(activeBody.beaches[event.beachId]).toEqual([event]);
		const expired = await handleBeachEventsRequest(new Request("https://example.com/v1/beach-events", { headers: { "If-None-Match": active.headers.get("etag")! } }), h.env, new Date("2026-08-01T16:00:00Z"));
		expect(expired.status).toBe(200);
		expect((await expired.json() as BeachEventsSnapshot).beaches).toEqual({});
		expect(expired.headers.get("etag")).not.toBe(active.headers.get("etag"));
	});

	it("isolates provider failures and does not write a beach-condition key", async () => {
		const h = memoryEnv();
		const fetcher = vi.fn(async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
		const result = await refreshBeachEvents(h.env, new Date("2026-07-28T12:00:00Z"), fetcher);
		expect(result.outcome).toBe("failed");
		expect(h.kv.put.mock.calls.some(([key]) => key === "beach-conditions")).toBe(false);
	});
});

describe("event refresh observability", () => {
	const emptyFeed = "BEGIN:VCALENDAR\r\nEND:VCALENDAR";
	const inlandFeed = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:inland\r\nSUMMARY:Community event\r\nLOCATION:The Wharf\r\nDTSTART:20260801T130000Z\r\nDTEND:20260801T140000Z\r\nEND:VEVENT\r\nEND:VCALENDAR";
	const beachFeed = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:beach\r\nSUMMARY:Beach Cleanup\r\nLOCATION:Gulf Shores Public Beach\r\nDTSTART:20260801T130000Z\r\nDTEND:20260801T140000Z\r\nEND:VEVENT\r\nEND:VCALENDAR";
	const response = (body: string, status = 200) => Promise.resolve(new Response(body, { status }));

	it("returns an explicit never-run state and DST-safe next morning", async () => {
		const h = memoryEnv();
		expect(await readBeachEventRefreshStatus(h.env, new Date("2026-01-15T12:00:00Z"))).toMatchObject({ status: "neverRun", nextScheduledRefresh: "2026-01-15T13:00:00.000Z" });
		expect(nextBeachEventRefresh(new Date("2026-07-15T11:00:00Z"))).toBe("2026-07-15T12:00:00.000Z");
		expect(isBeachEventRefreshHour(new Date("2026-01-15T13:00:00Z"))).toBe(true);
		expect(isBeachEventRefreshHour(new Date("2026-07-15T12:00:00Z"))).toBe(true);
	});

	it("persists zero-raw and raw-with-zero-match results distinctly", async () => {
		const zero = memoryEnv();
		await refreshBeachEvents(zero.env, new Date("2026-07-28T12:00:00Z"), vi.fn(() => response(emptyFeed)) as unknown as typeof fetch);
		expect(JSON.parse(zero.values.get(REFRESH_STATUS_KEY)!)).toMatchObject({ status: "healthy", counts: { raw: 0, matched: 0, excluded: 0 }, lastAttempt: "2026-07-28T12:00:00.000Z" });
		const excluded = memoryEnv();
		await refreshBeachEvents(excluded.env, new Date("2026-07-28T12:00:00Z"), vi.fn(() => response(inlandFeed)) as unknown as typeof fetch);
		expect(JSON.parse(excluded.values.get(REFRESH_STATUS_KEY)!)).toMatchObject({ status: "healthy", counts: { raw: 4, matched: 0, excluded: 4, unsupportedOrAmbiguous: 4 } });
	});

	it("records pending review, success timestamps, failure, and partial failure", async () => {
		const healthy = memoryEnv();
		await refreshBeachEvents(healthy.env, new Date("2026-07-28T12:00:00Z"), vi.fn(() => response(beachFeed)) as unknown as typeof fetch);
		expect(JSON.parse(healthy.values.get(REFRESH_STATUS_KEY)!)).toMatchObject({ status: "healthy", counts: { raw: 4, matched: 4, pendingReview: 1, excluded: 3 }, lastSuccess: expect.any(String) });
		const failed = memoryEnv();
		await refreshBeachEvents(failed.env, new Date("2026-07-28T12:00:00Z"), vi.fn(() => response("down", 503)) as unknown as typeof fetch);
		expect(JSON.parse(failed.values.get(REFRESH_STATUS_KEY)!)).toMatchObject({ status: "failed", lastFailure: expect.any(String), providers: expect.arrayContaining([expect.objectContaining({ providerId: "gulfStatePark", status: "failed" }), expect.objectContaining({ providerId: "orangeBeachCoastalResources", status: "failed" })]) });
		const partial = memoryEnv();
		const fetcher = vi.fn((url: RequestInfo | URL) => String(url).includes("gulfshores") ? response(beachFeed) : response("down", 503));
		await refreshBeachEvents(partial.env, new Date("2026-07-28T12:00:00Z"), fetcher as unknown as typeof fetch);
		expect(JSON.parse(partial.values.get(REFRESH_STATUS_KEY)!)).toMatchObject({ status: "warning", lastSuccess: expect.any(String), lastFailure: expect.any(String) });
	});

	it("reports disabled and monitor-only controls without unsafe ingestion", async () => {
		const disabled = memoryEnv(), doc = defaultOperationalControl(new Date("2026-07-28T12:00:00Z"));
		doc.controls["domains.beachEvents"] = { state: "disabled" };
		disabled.values.set(CURRENT_KEY, JSON.stringify(doc));
		expect(await refreshBeachEvents(disabled.env, new Date("2026-07-28T12:00:00Z"))).toMatchObject({ outcome: "disabled", refresh: { status: "disabled" } });
		const providerDisabled = memoryEnv(), providerDoc = defaultOperationalControl(new Date("2026-07-28T12:00:00Z"));
		providerDoc.controls["providers.orangeBeachEvents"] = { state: "disabled" };
		providerDisabled.values.set(CURRENT_KEY, JSON.stringify(providerDoc));
		const result = await refreshBeachEvents(providerDisabled.env, new Date("2026-07-28T12:00:00Z"), vi.fn(() => response(emptyFeed)) as unknown as typeof fetch);
		expect(result.providers.find((item) => item.providerId === "orangeBeachParks")?.status).toBe("disabled");
		const monitored = memoryEnv(), monitorDoc = defaultOperationalControl(new Date("2026-07-28T12:00:00Z"));
		monitorDoc.controls["providers.gulfShoresEvents"] = { state: "monitorOnly" };
		monitored.values.set(CURRENT_KEY, JSON.stringify(monitorDoc));
		const monitorResult = await refreshBeachEvents(monitored.env, new Date("2026-07-28T12:00:00Z"), vi.fn(() => response(beachFeed)) as unknown as typeof fetch);
		expect(monitorResult.providers.find((item) => item.providerId === "gulfShoresCity")?.status).toBe("monitored");
	});

	it("prevents concurrent admin refreshes and records the manual audit", async () => {
		const h = memoryEnv();
		h.values.set(REFRESH_STATUS_KEY, JSON.stringify({ ...(await readBeachEventRefreshStatus(h.env)), status: "running", lastAttempt: "2026-07-28T12:00:00.000Z" }));
		expect(await refreshBeachEvents(h.env, new Date("2026-07-28T12:01:00Z"))).toMatchObject({ outcome: "duplicate" });
		h.values.delete(REFRESH_STATUS_KEY);
		await refreshBeachEvents(h.env, new Date("2026-07-28T12:00:00Z"), vi.fn(() => response(emptyFeed)) as unknown as typeof fetch, { trigger: "admin", identity: { method: "access", subject: "operator@example.com" } });
		expect([...h.values.keys()].some((key) => key.startsWith("beach-events:v1:audit:"))).toBe(true);
	});
});
