import { describe, expect, it, vi } from "vitest";
import { exactBeachMatch, explainBeachMatch } from "../src/beachEvents/matching";
import { ICalendarParseError, parseICalendar } from "../src/beachEvents/ical";
import { auditEventLocations, classifyEventLocation, sanitizeLocationEvidence } from "../src/beachEvents/location";
import { BEACH_ACTIVITY_NOTIFICATION_STATE_KEY } from "../src/beachEvents/notifications";
import { BEACH_EVENT_PROVIDERS } from "../src/beachEvents/providers";
import { EVENT_PREFIX, applyImportedEvents, archiveCompletedEvents, audit, auditAutomated, auditLegacyEventIdentities, buildSnapshot, effectiveEventEnd, importedEventId, isEventCompleted, isEventVisibleNow, legacyImportedEventId, normalizedEvent, validateManualEvent } from "../src/beachEvents/store";
import { readBeachEventRefreshStatus, refreshBeachEvents, REFRESH_STATUS_KEY } from "../src/beachEvents/refresh";
import { isBeachEventRefreshHour, nextBeachEventRefresh } from "../src/beachEvents/schedule";
import { CURRENT_KEY, defaultOperationalControl } from "../src/operationalControl/store";
import type { BeachEvent, BeachEventsSnapshot, SourceFacts } from "../src/beachEvents/types";
import type { Env } from "../src/types";
import { eventAdminRevision, handleBeachEventHistory, handleBeachEventsAdminGet, handleBeachEventsAdminUpdate, handleBeachEventsRequest } from "../src/routes/beachEvents";

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
	return { env: { BEACH_DATA: kv, AI: { toMarkdown: vi.fn(async () => ({ format: "markdown", data: "No dated events in this issue." })) }, BEACH_ACTIVITY_NOTIFICATIONS_ENABLED: "false", BEACH_ACTIVITY_NOTIFICATION_RECIPIENTS: "operations@alabamabeachflag.com" } as unknown as Env, values, kv };
}

const facts = (overrides: Partial<SourceFacts> = {}): SourceFacts => ({
	providerId: "gulfShoresCity", externalId: "1", title: "Coastal Cleanup", venue: "Gulf Place Town Green",
	startAt: "2026-08-01T13:00:00.000Z", endAt: "2026-08-01T15:00:00.000Z", allDay: false, recurring: false,
	sourceName: "City of Gulf Shores", sourceURL: "https://www.gulfshoresal.gov/", ...overrides,
});

describe("exact beach event matching", () => {
	it("keeps Dauphin Island automation disabled pending written permission", () => {
		expect(BEACH_EVENT_PROVIDERS.find((provider) => provider.id === "dauphinIslandTown")).toMatchObject({
			mode: "disabled",
			feedType: "Web page",
			feedURL: "https://www.townofdauphinisland.org/calendar-of-events",
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
		expect(exactBeachMatch({ providerId: "manual", venue: "West End Beach" })).toEqual({ beachId: "dauphin-island-public-beach", method: "exactVenue" });
		expect(exactBeachMatch({ providerId: "dauphinIslandTown", address: "1917 Bienville Boulevard, Dauphin Island, AL 36528" })).toEqual({ beachId: "dauphin-island-public-beach", method: "exactAddress" });
		expect(exactBeachMatch({ providerId: "manual", address: "3000 Bienville Blvd, Dauphin Island, AL 36528" })).toEqual({ beachId: "dauphin-island-public-beach", method: "exactAddress" });
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
		expect(explainBeachMatch({ providerId: "dauphinIslandTown", venue: "West End Beach" })).toMatchObject({ beachId: "dauphin-island-public-beach", method: "exactVenue", confidence: "exact" });
		for (const venue of ["Dauphin Island", "Dauphin Island Town Hall", "Dauphin Island Community Center", "Dauphin Island Sea Lab", "Alabama Aquarium", "Fort Gaines", "Audubon Bird Sanctuary", "Dauphin Island Campground", "Dauphin Island Marina"]) {
			expect(exactBeachMatch({ providerId: "dauphinIslandTown", venue })).toBeNull();
		}
	});

	it("keeps Gulf State Park Pier nearby rather than fabricating Pavilion precision", () => {
		expect(exactBeachMatch({ providerId: "gulfStatePark", venue: "Gulf State Park Pier" })).toBeNull();
		expect(exactBeachMatch({ providerId: "gulfStatePark", venue: "Gulf State Park Fishing and Education Pier, 20800 E Beach Blvd, Gulf Shores, AL 36542, USA" })).toBeNull();
		expect(exactBeachMatch({ providerId: "x", venue: "Gulf State Park Pier" })).toBeNull();
		expect(exactBeachMatch({ providerId: "gulfStatePark", venue: "Pier" })).toBeNull();
		for (const venue of ["Gulf State Park Nature Center", "Gulf State Park Learning Campus", "Lake Shelby Picnic Area"]) {
			expect(explainBeachMatch({ providerId: "gulfStatePark", venue })).toMatchObject({ exclusionReason: "inlandVenue" });
		}
	});
});

describe("event location classification", () => {
	it("classifies exact, nearby, regional, and irrelevant locations using affirmative evidence", () => {
		expect(classifyEventLocation(facts({ venue: "Gulf Shores Public Beach" }))).toMatchObject({ classification: "beachSpecific", proposedBeachId: "gulf-shores-public-beach", exactAssignmentSupported: true, precisionLabel: "At this beach" });
		expect(classifyEventLocation(facts({ providerId: "orangeBeachParks", venue: "The Wharf", title: "Freedom Fest" }))).toMatchObject({ classification: "nearbyCoastal", proposedBeachId: "cotton-bayou", exactAssignmentSupported: false, precisionLabel: "Nearby coastal" });
		expect(classifyEventLocation(facts({ providerId: "alabamaCoastalCleanup", venue: "Various locations" }))).toMatchObject({ classification: "regional", exactAssignmentSupported: false, precisionLabel: "Regional" });
		expect(classifyEventLocation(facts({ providerId: "gulfStatePark", venue: "Gulf State Park Nature Center" }))).toMatchObject({ classification: "irrelevant", exactAssignmentSupported: false, precisionLabel: "Not beach relevant" });
	});

	it("supports approved aliases and normalized addresses but rejects provider-only precision", () => {
		expect(classifyEventLocation(facts({ providerId: "alabamaCoastalCleanup", venue: "Fort Morgan Public Beach Cleanup Zone" }))).toMatchObject({ classification: "beachSpecific", proposedBeachId: "fort-morgan-public-beach" });
		expect(classifyEventLocation(facts({ venue: "", address: "101 East Beach Boulevard, Gulf Shores, AL 36542" }))).toMatchObject({ classification: "beachSpecific", proposedBeachId: "gulf-shores-public-beach" });
		expect(classifyEventLocation(facts({ providerId: "orangeBeachParks", venue: "Unknown Orange Beach venue" }))).toMatchObject({ classification: "irrelevant", exactAssignmentSupported: false });
	});

	it("flags a retained administrator assignment when exclusion evidence conflicts", () => {
		const assessment = classifyEventLocation(facts({ providerId: "orangeBeachParks", venue: "The Wharf", title: "Freedom Fest" }), "cotton-bayou");
		expect(assessment).toMatchObject({ classification: "nearbyCoastal", assignmentOrigin: "administrator", exactAssignmentSupported: false });
		expect(assessment.conflicts[0]).toContain("lacks affirmative exact-location evidence");
	});

	it("represents conflicting positive address and negative venue evidence without exact assignment", () => {
		const assessment = classifyEventLocation(facts({ providerId: "orangeBeachParks", venue: "The Wharf", address: "25900 Perdido Beach Blvd, Orange Beach, AL 36561" }));
		expect(assessment).toMatchObject({ classification: "nearbyCoastal", exactAssignmentSupported: false });
		expect(assessment.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "exactAddress", supportsExact: true }), expect.objectContaining({ kind: "knownExclusion", supportsExact: false })]));
		expect(assessment.conflicts[0]).toContain("conflicts with excluded venue");
	});

	it("bounds and sanitizes evidence", () => {
		const evidence = sanitizeLocationEvidence(Array.from({ length: 20 }, () => ({ kind: "knownExclusion" as const, origin: "rule" as const, value: `unsafe\n${"x".repeat(200)}`, supportsExact: false })));
		expect(evidence).toHaveLength(12);
		expect(evidence[0].value).toHaveLength(120);
		expect(evidence[0].value).not.toContain("\n");
	});

	it("produces stable read-only audit output for The Wharf, Various locations, and distinct occurrences", () => {
		const at = new Date("2026-07-28T12:00:00Z");
		const makeLegacy = (externalId: string, title: string, venue: string, startAt: string) => ({ ...normalizedEvent(facts({ externalId, title, venue: "Cotton Bayou Public Beach", startAt }), at)!, venue, sourceFacts: facts({ providerId: title.includes("Freedom") ? "orangeBeachParks" : "alabamaCoastalCleanup", externalId, title, venue, startAt }), beachId: "cotton-bayou", matchMethod: "adminOverride" as const });
		const records = [makeLegacy("freedom-1", "Freedom Fest", "The Wharf", "2026-09-19T14:00:00Z"), makeLegacy("freedom-2", "Freedom Fest", "The Wharf", "2026-09-20T15:00:00Z"), makeLegacy("cleanup", "Alabama Coastal Cleanup", "Various locations", "2026-09-19T13:00:00Z")];
		const before = JSON.stringify(records), first = auditEventLocations(records), second = auditEventLocations(records);
		expect(first).toEqual(second);
		expect(JSON.stringify(records)).toBe(before);
		expect(first.records.map((item) => item.id)).toHaveLength(3);
		expect(first.records.filter((item) => item.title === "Freedom Fest")).toHaveLength(2);
		expect(first.records.map((item) => item.assessment.classification)).toEqual(expect.arrayContaining(["nearbyCoastal", "regional"]));
		expect(first.summary).toMatchObject({ total: 3, review: 3 });
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

	it("reports bounded malformed component diagnostics with a deterministic UID hash", () => {
		const data = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:first\r\nSUMMARY:Valid\r\nDTSTART:20260801T130000Z\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:known-uid\r\nSUMMARY:Broken\r\nDTSTART:not-a-date\r\nEND:VEVENT\r\nEND:VCALENDAR";
		try { parseICalendar(data, { id: "gulfStatePark", name: "Gulf State Park", feedURL: "https://example.gov/feed.ics" }); expect.fail("expected parse failure"); }
		catch (error) { expect(error).toBeInstanceOf(ICalendarParseError); expect((error as ICalendarParseError).diagnostics).toEqual({ componentIndex: 2, uidHash: "6efcd97f", fieldCategory: "dtstart_invalid", totalVEventCount: 2, validVEventCount: 1, rejectedVEventCount: 1 }); }
	});

	it("reports a missing UID without deriving or exposing an identifier", () => {
		const data = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Broken\r\nDTSTART:20260801T130000Z\r\nEND:VEVENT\r\nEND:VCALENDAR";
		try { parseICalendar(data, { id: "gulfStatePark", name: "Gulf State Park", feedURL: "https://example.gov/feed.ics" }); expect.fail("expected parse failure"); }
		catch (error) { expect((error as ICalendarParseError).diagnostics).toEqual({ componentIndex: 1, fieldCategory: "uid_missing", totalVEventCount: 1, validVEventCount: 0, rejectedVEventCount: 1 }); }
	});
});

describe("bounded event audit records", () => {
	it("removes raw source facts, redacts sensitive text, bounds records, and retains admin actions", async () => {
		const h=memoryEnv(),now=new Date("2026-08-17T12:00:00Z"),changes={sourceFacts:{description:"private body",contactInformation:"person@example.com"},url:"https://example.gov/path?token=secret",authorization:"Bearer abc123",huge:"x".repeat(20000)};await auditAutomated(h.env,"scheduled","source_event_changed","event-1",changes,now,{changedFields:Array.from({length:100},(_,index)=>`field-${index}`)});await audit(h.env,{method:"access",subject:"operator@example.com"},"publish_event","event-1",changes,new Date("2026-08-17T12:01:00Z"));const writes=h.kv.put.mock.calls.filter(([key])=>String(key).startsWith("beach-events:v1:audit:"));expect(writes).toHaveLength(2);expect(writes[0][2]).toMatchObject({expirationTtl:400*24*60*60});expect(writes[1][2]).toBeUndefined();for(const [,value] of writes){expect(new TextEncoder().encode(String(value)).byteLength).toBeLessThanOrEqual(12000);expect(value).not.toContain("private body");expect(value).not.toContain("person@example.com");expect(value).not.toContain("abc123");expect(value).not.toContain("token=secret")}
	});
	it("paginates event-specific protected history with opaque cursor metadata",async()=>{const base=normalizedEvent(facts(),new Date("2026-08-01T12:00:00Z"))!,values=new Map([[`${EVENT_PREFIX}${base.id}`,JSON.stringify(base)],...Array.from({length:60},(_,index)=>[`beach-events:v1:audit:${String(index).padStart(3,"0")}`,JSON.stringify({id:String(index),targetId:index%2?base.id:"other",timestamp:`2026-08-01T12:${String(index%60).padStart(2,"0")}:00Z`})] as [string,string])]),list=vi.fn(async({cursor}:{cursor?:string})=>{const keys=[...values.keys()].filter(key=>key.startsWith("beach-events:v1:audit:")).slice(cursor?50:0,cursor?60:50).map(name=>({name}));return{keys,list_complete:Boolean(cursor),...(cursor?{}:{cursor:"opaque-next"})}}),env={BEACH_DATA:{get:vi.fn(async(key:string,type?:string)=>{const value=values.get(key);return value&&type==="json"?JSON.parse(value):value??null}),list,put:vi.fn(),delete:vi.fn()}} as any;const first=await handleBeachEventHistory(new Request(`https://example.com/admin/beach-events/${base.id}/history?kind=audit`),env,base.id),body=await first.json() as any;expect(body).toMatchObject({eventId:base.id,kind:"audit",hasMore:true,cursor:"opaque-next",scanned:50});expect(body.items.every((item:any)=>item.targetId===base.id)).toBe(true);const second=await handleBeachEventHistory(new Request(`https://example.com/admin/beach-events/${base.id}/history?kind=audit&cursor=opaque-next`),env,base.id);expect(await second.json()).toMatchObject({hasMore:false,cursor:null,scanned:10});expect((await handleBeachEventHistory(new Request(`https://example.com/admin/beach-events/${base.id}/history?cursor=${"x".repeat(513)}`),env,base.id)).status).toBe(400)});
});

describe("event lifecycle", () => {
	it("keeps short IDs stable and disambiguates long provider identities with legacy compatibility", async () => {
		const short = facts({ externalId: "short-id" });
		expect(importedEventId(short)).toBe(legacyImportedEventId(short));
		const prefix = "x".repeat(121), first = facts({ externalId: `${prefix}A` }), second = facts({ externalId: `${prefix}B` });
		expect(legacyImportedEventId(first)).toBe(legacyImportedEventId(second));
		expect(importedEventId(first)).not.toBe(importedEventId(second));
		expect(importedEventId(first)).toBe(importedEventId(first));
		const h = memoryEnv(), legacy = { ...normalizedEvent(first, new Date("2026-07-28T12:00:00Z"))!, id: legacyImportedEventId(first), status: "approved" as const };
		h.values.set(`${EVENT_PREFIX}${legacy.id}`, JSON.stringify(legacy));
		await applyImportedEvents(h.env, [first], new Date("2026-07-29T12:00:00Z"));
		expect(h.values.has(`${EVENT_PREFIX}${legacy.id}`)).toBe(true);
		expect(h.values.has(`${EVENT_PREFIX}${importedEventId(first)}`)).toBe(false);
		expect(auditLegacyEventIdentities([legacy]).records[0]).toMatchObject({ status: "legacyCompatible", preferredId: importedEventId(first) });
		await applyImportedEvents(h.env, [second], new Date("2026-07-29T12:01:00Z"));
		expect(JSON.parse(h.values.get(`${EVENT_PREFIX}${importedEventId(second)}`)!)).toMatchObject({ attentionFlags: expect.arrayContaining(["identityCompatibilityReview"]), identityCompatibility: { status: "legacyCollision" } });
	});
	it("deduplicates recurring imports and preserves source facts when local edits exist", async () => {
		const h = memoryEnv();
		expect(await applyImportedEvents(h.env, [facts(), facts()], new Date("2026-07-28T12:00:00Z"))).toMatchObject({ discovered: 1, matched: 2 });
		expect([...h.values.keys()].filter((key) => key.includes(":event:"))).toHaveLength(1);
	});

	it("keeps a Pier candidate excluded as nearby coastal", async () => {
		const h = memoryEnv();
		const pier = facts({ providerId: "gulfStatePark", externalId: "pier-1", venue: "Gulf State Park Pier" });
		h.values.set("beach-events:v1:excluded:gulfStatePark-pier-1", JSON.stringify({ id: "gulfStatePark-pier-1" }));
		expect(await applyImportedEvents(h.env, [pier], new Date("2026-07-28T12:00:00Z"))).toMatchObject({ discovered: 0, excluded: 1 });
		expect(JSON.parse(h.values.get("beach-events:v1:excluded:gulfStatePark-pier-1")!)).toMatchObject({ location: { classification: "nearbyCoastal", proposedBeachId: "gulf-state-park-pavilion", exactAssignmentSupported: false } });
		expect(h.values.get("beach-events:v1:event:imported-gulfStatePark-pier-1")).toBeUndefined();
	});

	it("retains an administrator beach assignment but flags changed conflicting source evidence", async () => {
		const h = memoryEnv(), now = new Date("2026-07-28T12:00:00Z");
		const originalFact = facts({ providerId: "orangeBeachParks", externalId: "freedom", title: "Freedom Fest", venue: "Cotton Bayou Public Beach" });
		const prior = { ...normalizedEvent(originalFact, now, { beachId: "cotton-bayou", ruleId: "admin-existing", explanation: "Administrator retained assignment" })!, status: "approved" } as BeachEvent;
		h.values.set(`${EVENT_PREFIX}${prior.id}`, JSON.stringify(prior));
		await applyImportedEvents(h.env, [{ ...originalFact, venue: "The Wharf", startAt: "2026-08-02T13:00:00Z", endAt: "2026-08-02T15:00:00Z" }], new Date("2026-07-29T12:00:00Z"));
		const stored = JSON.parse(h.values.get(`${EVENT_PREFIX}${prior.id}`)!);
		expect(stored).toMatchObject({ beachId: "cotton-bayou", status: "pendingReview", locationReviewRequired: true, location: { classification: "nearbyCoastal", exactAssignmentSupported: false }, confirmation: { status: "confirmed" }, sourceChange: { severity: "critical", explanations: expect.arrayContaining(["Loss of valid exact-beach evidence"]) }, attentionFlags: expect.arrayContaining(["ambiguousMatch", "materialSourceChange"]) });
	});

	it("expires ended items from the public snapshot and keeps active multi-day items", () => {
		const base = normalizedEvent(facts(), new Date("2026-07-28T12:00:00Z"))!;
		const active = { ...base, status: "published", endAt: "2026-08-02T12:00:00Z" } as BeachEvent;
		const expired = { ...base, id: "old", status: "published", endAt: "2026-07-27T12:00:00Z" } as BeachEvent;
		expect(buildSnapshot([active, expired], new Date("2026-08-01T12:00:00Z")).beaches["gulf-shores-public-beach"]).toEqual([expect.objectContaining({ id: active.id, title: active.title })]);
	});

	it("uses explicit timed ends and Central end-of-day for missing end times", () => {
		const base = normalizedEvent(facts(), new Date("2026-07-28T12:00:00Z"))!;
		const timed = { ...base, status: "published", startAt: "2026-08-01T13:00:00Z", endAt: "2026-08-01T15:00:00Z" } as BeachEvent;
		expect(isEventCompleted(timed, new Date("2026-08-01T14:59:59Z"))).toBe(false);
		expect(isEventCompleted(timed, new Date("2026-08-01T15:00:00Z"))).toBe(true);
		const noEnd = { ...timed, startAt: "2026-08-01T15:00:00Z", endAt: "2026-08-01T16:00:00Z", endTimeUnavailable: true };
		expect(effectiveEventEnd(noEnd).toISOString()).toBe("2026-08-02T05:00:00.000Z");
		expect(isEventCompleted(noEnd, new Date("2026-08-02T04:59:59Z"))).toBe(false);
		expect(isEventCompleted(noEnd, new Date("2026-08-02T05:00:00Z"))).toBe(true);
	});

	it("keeps all-day and multi-day events active through their exclusive Central final-day boundary", () => {
		const base = normalizedEvent(facts(), new Date("2026-07-28T12:00:00Z"))!;
		const allDay = { ...base, status: "published", allDay: true, startAt: "2026-08-01T05:00:00Z", endAt: "2026-08-02T05:00:00Z" } as BeachEvent;
		expect(isEventCompleted(allDay, new Date("2026-08-02T04:59:59Z"))).toBe(false);
		expect(isEventCompleted(allDay, new Date("2026-08-02T05:00:00Z"))).toBe(true);
		const multiDay = { ...allDay, endAt: "2026-08-04T05:00:00Z" };
		expect(isEventCompleted(multiDay, new Date("2026-08-03T18:00:00Z"))).toBe(false);
		expect(isEventCompleted(multiDay, new Date("2026-08-04T05:00:00Z"))).toBe(true);
	});

	it("handles Central daylight-saving boundaries and leaves undated postponements uncompleted", () => {
		const base = normalizedEvent(facts(), new Date("2026-01-01T12:00:00Z"))!;
		const spring = { ...base, endTimeUnavailable: true, startAt: "2026-03-08T07:30:00Z", endAt: "2026-03-08T08:30:00Z" };
		const fall = { ...base, endTimeUnavailable: true, startAt: "2026-11-01T06:30:00Z", endAt: "2026-11-01T07:30:00Z" };
		expect(effectiveEventEnd(spring).toISOString()).toBe("2026-03-09T05:00:00.000Z");
		expect(effectiveEventEnd(fall).toISOString()).toBe("2026-11-02T06:00:00.000Z");
		expect(isEventCompleted({ ...spring, sourceFacts: { ...base.sourceFacts, sourceStatus: "postponed" } }, new Date("2026-03-10T00:00:00Z"))).toBe(false);
	});

	it("archives a completed publication once while preserving record and history", async () => {
		const h = memoryEnv();
		const event = { ...normalizedEvent(facts(), new Date("2026-07-28T12:00:00Z"))!, status: "published", reviewedSourceRevision: "reviewed-revision" } as BeachEvent;
		h.values.set(`${EVENT_PREFIX}${event.id}`, JSON.stringify(event));
		h.values.set("beach-events:v1:audit:2026-07-28T12:00:00.000Z:prior", JSON.stringify({ id: "prior", targetId: event.id, action: "publish_event", timestamp: "2026-07-28T12:00:00.000Z" }));
		expect(await archiveCompletedEvents(h.env, new Date("2026-08-01T15:00:00Z"), "scheduled")).toEqual({ scanned: 1, archived: 1 });
		expect(await archiveCompletedEvents(h.env, new Date("2026-08-02T15:00:00Z"), "scheduled")).toEqual({ scanned: 1, archived: 0 });
		const stored = JSON.parse(h.values.get(`${EVENT_PREFIX}${event.id}`)!);
		expect(stored).toMatchObject({ id: event.id, status: "completed", priorPublicationStatus: "published", completedAt: "2026-08-01T15:00:00.000Z", archivedAt: "2026-08-01T15:00:00.000Z", sourceFacts: event.sourceFacts, sourceRevision: event.sourceRevision, reviewedSourceRevision: "reviewed-revision" });
		expect([...h.values.keys()].filter((key) => key.includes(":audit:")).length).toBe(2);
		const admin = await handleBeachEventsAdminGet(new Request("https://example.com/admin/beach-events"), h.env, new Date("2026-08-02T15:00:00Z"));
		const body = await admin.json() as { events: BeachEvent[]; archive: BeachEvent[]; audit: Array<{ targetId: string }> };
		expect(body.events).toEqual([]);
		expect(body.archive).toEqual([expect.objectContaining({ id: event.id, status: "completed" })]);
		expect((body.archive[0] as BeachEvent & { revision: string }).revision).toBe(eventAdminRevision(stored));
		expect(body.audit.filter((record) => record.targetId === event.id)).toHaveLength(2);
		const mutation = await handleBeachEventsAdminUpdate(new Request(`https://example.com/admin/beach-events/${event.id}`, { method: "PATCH", headers: { "Content-Type": "application/json", "If-Match": eventAdminRevision(stored) }, body: JSON.stringify({ status: "published" }) }), h.env, { method: "access", subject: "operator@example.com" }, event.id, new Date("2026-08-02T15:00:00Z"));
		expect(mutation.status).toBe(409);
		expect(await mutation.json()).toEqual({ error: "archived_event_read_only" });
	});

	it("keeps a legacy expired publication unchanged, public-safe, in Archive, and read-only", async () => {
		const h = memoryEnv();
		const legacy = { ...normalizedEvent(facts({ externalId: "legacy-expired" }), new Date("2026-07-28T12:00:00Z"))!, status: "expired", reviewedSourceRevision: "legacy-reviewed" } as BeachEvent;
		h.values.set(`${EVENT_PREFIX}${legacy.id}`, JSON.stringify(legacy));
		h.values.set("beach-events:v1:audit:2026-07-28T12:00:00.000Z:legacy", JSON.stringify({ id: "legacy-audit", targetId: legacy.id, action: "expire_event", timestamp: "2026-07-28T12:00:00.000Z" }));
		h.values.set("beach-events:v1:snapshot", JSON.stringify(buildSnapshot([{ ...legacy, status: "published" }], new Date("2026-07-28T12:00:00Z"))));

		const publicResponse = await handleBeachEventsRequest(new Request("https://example.com/v1/beach-events"), h.env, new Date("2026-08-02T12:00:00Z"));
		expect((await publicResponse.json() as BeachEventsSnapshot).beaches).toEqual({});
		const putCount = h.kv.put.mock.calls.length;
		const adminResponse = await handleBeachEventsAdminGet(new Request("https://example.com/admin/beach-events"), h.env, new Date("2026-08-02T12:00:00Z"));
		const admin = await adminResponse.json() as { events: BeachEvent[]; archive: BeachEvent[]; audit: Array<{ targetId: string }>; locationAudit: ReturnType<typeof auditEventLocations> };
		expect(admin.events).toEqual([]);
		expect(admin.archive).toEqual([expect.objectContaining({ id: legacy.id, status: "expired", reviewedSourceRevision: "legacy-reviewed" })]);
		expect(admin.audit).toEqual(expect.arrayContaining([expect.objectContaining({ targetId: legacy.id, action: "expire_event" })]));
		expect(admin.locationAudit).toMatchObject({ version: 1, summary: { total: 1 } });
		expect(h.kv.put.mock.calls).toHaveLength(putCount);
		expect(JSON.parse(h.values.get(`${EVENT_PREFIX}${legacy.id}`)!)).toEqual(legacy);
		const mutation = await handleBeachEventsAdminUpdate(new Request(`https://example.com/admin/beach-events/${legacy.id}`, { method: "PATCH", headers: { "Content-Type": "application/json", "If-Match": eventAdminRevision(legacy) }, body: JSON.stringify({ status: "published" }) }), h.env, { method: "access", subject: "operator@example.com" }, legacy.id);
		expect(mutation.status).toBe(409);
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
				headers: { "Content-Type": "application/json", "If-Match": eventAdminRevision(original) },
				body: JSON.stringify({ title: "Updated cleanup", bannerMessage: "Updated copy.", beachId: "dauphin-island-east-end" }),
			}),
			h.env,
			{ method: "access", subject: "operator@example.com" },
			original.id,
			new Date("2026-07-28T13:00:00Z"),
		);
		expect(response.status).toBe(200);
		const updated = (await response.json() as { event: BeachEvent }).event;
		expect(updated).toMatchObject({ id: original.id, title: "Updated cleanup", bannerMessage: "Updated copy.", beachId: "dauphin-island-east-end", status: "pendingReview", sourceFacts: original.sourceFacts, createdAt: original.createdAt, matchMethod: "adminOverride", matchConfidence: "admin", manualOverrideFields: expect.arrayContaining(["beachId", "title"]) });
		const auditRecord = [...h.values.entries()].find(([key]) => key.startsWith("beach-events:v1:audit:"))?.[1];
		expect(JSON.parse(auditRecord!)).toMatchObject({
			changes: {
				previous: { title: original.title, bannerMessage: original.bannerMessage, beachId: original.beachId },
				next: { title: "Updated cleanup", bannerMessage: "Updated copy.", beachId: "dauphin-island-east-end" },
			},
			previousState: "pendingReview",
			newState: "pendingReview",
			changedFields: expect.arrayContaining(["title", "bannerMessage", "beachId", "matchMethod", "matchConfidence", "matchRuleId", "matchExplanation"]),
			origin: "manual",
		});
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
		expect(activeBody.beaches[event.beachId]).toEqual([expect.objectContaining({ id: event.id, title: event.title })]);
		const expired = await handleBeachEventsRequest(new Request("https://example.com/v1/beach-events", { headers: { "If-None-Match": active.headers.get("etag")! } }), h.env, new Date("2026-08-01T16:00:00Z"));
		expect(expired.status).toBe(200);
		expect((await expired.json() as BeachEventsSnapshot).beaches).toEqual({});
		expect(expired.headers.get("etag")).not.toBe(active.headers.get("etag"));
	});

	it("isolates provider failures and does not write a beach-condition key", async () => {
		const h = memoryEnv();
		const event = { ...normalizedEvent(facts(), new Date("2026-07-27T12:00:00Z"))!, status: "published" } as BeachEvent;
		const priorSnapshot = buildSnapshot([event], new Date("2026-07-27T12:00:00Z"));
		h.values.set("beach-events:v1:snapshot", JSON.stringify(priorSnapshot));
		const fetcher = vi.fn(async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
		const result = await refreshBeachEvents(h.env, new Date("2026-07-28T12:00:00Z"), fetcher);
		expect(result.outcome).toBe("failed");
		expect(result.refresh.publicRevisionChanged).toBe(false);
		expect(JSON.parse(h.values.get("beach-events:v1:snapshot")!)).toEqual(priorSnapshot);
		expect(h.kv.put.mock.calls.some(([key]) => key === "beach-conditions")).toBe(false);
	});
});

describe("event refresh observability", () => {
	const emptyFeed = "BEGIN:VCALENDAR\r\nEND:VCALENDAR";
	const inlandFeed = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:inland\r\nSUMMARY:Community event\r\nLOCATION:The Wharf\r\nDTSTART:20260801T130000Z\r\nDTEND:20260801T140000Z\r\nEND:VEVENT\r\nEND:VCALENDAR";
	const beachFeed = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:beach\r\nSUMMARY:Beach Cleanup\r\nLOCATION:Gulf Shores Public Beach\r\nDTSTART:20260801T130000Z\r\nDTEND:20260801T140000Z\r\nEND:VEVENT\r\nEND:VCALENDAR";
	const response = (body: string, status = 200) => Promise.resolve(new Response(body, { status }));
	const townIssueURL = "https://www.townofdauphinisland.org/_files/ugd/222868_test.pdf";
	const townPDF = new Uint8Array([
		...new TextEncoder().encode("%PDF\n1 0 obj\n<< /Subtype /Image /Filter [/FlateDecode/DCTDecode] /Width 1 /Height 1 >>\nstream\n"),
		120, 156, 251, 127, 227, 255, 77, 0, 9, 95, 3, 176,
		...new TextEncoder().encode("\nendstream\nendobj\n%%EOF"),
	]);
	const feedFetcher = (body: string, status = 200) => vi.fn((url: RequestInfo | URL) => {
		const value = String(url);
		if (value.endsWith("/newsletters")) return response(`<a href="${townIssueURL}">July 2026</a>`);
		if (value === townIssueURL) return Promise.resolve(new Response(townPDF));
		return response(body, status);
	}) as unknown as typeof fetch;

	it("returns an explicit never-run state and DST-safe next morning", async () => {
		const h = memoryEnv();
		expect(await readBeachEventRefreshStatus(h.env, new Date("2026-01-15T12:00:00Z"))).toMatchObject({ status: "neverRun", nextScheduledRefresh: "2026-01-15T13:00:00.000Z" });
		expect(nextBeachEventRefresh(new Date("2026-07-15T11:00:00Z"))).toBe("2026-07-15T12:00:00.000Z");
		expect(isBeachEventRefreshHour(new Date("2026-01-15T13:00:00Z"))).toBe(true);
		expect(isBeachEventRefreshHour(new Date("2026-07-15T12:00:00Z"))).toBe(true);
	});

	it("persists zero-raw and raw-with-zero-match results distinctly", async () => {
		const zero = memoryEnv();
		await refreshBeachEvents(zero.env, new Date("2026-07-28T12:00:00Z"), feedFetcher(emptyFeed));
		expect(JSON.parse(zero.values.get(REFRESH_STATUS_KEY)!)).toMatchObject({ status: "healthy", counts: { raw: 0, matched: 0, excluded: 0 }, lastAttempt: "2026-07-28T12:00:00.000Z" });
		const excluded = memoryEnv();
		await refreshBeachEvents(excluded.env, new Date("2026-07-28T12:00:00Z"), feedFetcher(inlandFeed));
		expect(JSON.parse(excluded.values.get(REFRESH_STATUS_KEY)!)).toMatchObject({ status: "healthy", counts: { raw: 4, matched: 0, excluded: 4, unsupportedOrAmbiguous: 4 } });
	});

	it("records pending review, success timestamps, failure, and partial failure", async () => {
		const healthy = memoryEnv();
		await refreshBeachEvents(healthy.env, new Date("2026-07-28T12:00:00Z"), feedFetcher(beachFeed));
		expect(JSON.parse(healthy.values.get(REFRESH_STATUS_KEY)!)).toMatchObject({ status: "healthy", counts: { raw: 4, matched: 4, pendingReview: 4, excluded: 0 }, lastSuccess: expect.any(String) });
		const failed = memoryEnv();
		await refreshBeachEvents(failed.env, new Date("2026-07-28T12:00:00Z"), vi.fn(() => response("down", 503)) as unknown as typeof fetch);
		expect(JSON.parse(failed.values.get(REFRESH_STATUS_KEY)!)).toMatchObject({ status: "failed", lastFailure: expect.any(String), providers: expect.arrayContaining([expect.objectContaining({ providerId: "gulfStatePark", status: "failed" }), expect.objectContaining({ providerId: "orangeBeachCoastalResources", status: "failed" })]) });
		const partial = memoryEnv();
		const fetcher = vi.fn((url: RequestInfo | URL) => String(url).includes("gulfshores") ? response(beachFeed) : response("down", 503));
		await refreshBeachEvents(partial.env, new Date("2026-07-28T12:00:00Z"), fetcher as unknown as typeof fetch);
		expect(JSON.parse(partial.values.get(REFRESH_STATUS_KEY)!)).toMatchObject({ status: "warning", lastSuccess: expect.any(String), lastFailure: expect.any(String) });
	});

	it.each(["HTTP failure", "timeout", "malformed feed"])("does not count an absent event when its provider has an unsuccessful %s refresh", async (failure) => {
		const h = memoryEnv();
		const sourceFact = facts();
		const event = normalizedEvent(sourceFact, new Date("2026-07-27T12:00:00.000Z"))!;
		h.values.set(`${EVENT_PREFIX}${event.id}`, JSON.stringify({ ...event, status: "published" }));
		const malformedFeed = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:partial\r\nSUMMARY:Partial Beach Event\r\nDTSTART:20260801T130000Z";
		const fetcher = vi.fn((url: RequestInfo | URL) => {
			if (!String(url).includes("gulfshoresal.gov")) return response(emptyFeed);
			if (failure === "HTTP failure") return response("down", 503);
			if (failure === "timeout") return Promise.reject(new Error("request timed out"));
			return response(malformedFeed);
		}) as unknown as typeof fetch;
		const result = await refreshBeachEvents(h.env, new Date("2026-07-28T12:00:00.000Z"), fetcher);
		expect(result.outcome).toBe("partial");
		const failedProvider = result.providers.find((provider) => provider.providerId === "gulfShoresCity");
		expect(failedProvider).toMatchObject({ status: "failed" });
		expect(failedProvider).not.toHaveProperty("missingFromSource");
		const stored = JSON.parse(h.values.get(`${EVENT_PREFIX}${event.id}`)!);
		expect(stored).toMatchObject({ status: "published" });
		expect(stored).not.toHaveProperty("sourceMissingCount");
		expect(stored).not.toHaveProperty("sourceRemovedAt");
	});

	it("persists bounded HTTP and parser diagnostics on a malformed provider observation", async () => {
		const h = memoryEnv();
		const malformed = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:known-uid\r\nSUMMARY:Broken\r\nDTSTART:invalid\r\nEND:VEVENT\r\nEND:VCALENDAR";
		const fetcher = vi.fn(() => Promise.resolve(new Response(malformed, { status: 200, headers: { "Content-Type": "text/calendar; charset=utf-8" } }))) as unknown as typeof fetch;
		const result = await refreshBeachEvents(h.env, new Date("2026-07-28T12:00:00.000Z"), fetcher);
		const gulfStatePark = result.providers.find((provider) => provider.providerId === "gulfStatePark");
		expect(gulfStatePark).toMatchObject({ status: "failed", diagnostics: { httpStatus: 200, contentType: "text/calendar; charset=utf-8", responseBytes: new TextEncoder().encode(malformed).byteLength, componentIndex: 1, uidHash: "6efcd97f", fieldCategory: "dtstart_invalid", totalVEventCount: 1, validVEventCount: 0, rejectedVEventCount: 1 } });
		expect(gulfStatePark?.diagnostics?.fetchDurationMs).toEqual(expect.any(Number));
		const index = JSON.parse(h.values.get("provider-health:v1:states")!);
		expect(index.states.find((state: any) => state.provider === "gulfStatePark").lastDiagnostics).toMatchObject({ uidHash: "6efcd97f", fieldCategory: "dtstart_invalid" });
		expect(JSON.stringify(index)).not.toContain("known-uid");
	});

	it("imports valid records from an allowed partial feed without absence reconciliation or snapshot replacement", async () => {
		const h = memoryEnv();
		const priorFact = facts({ externalId: "unseen-existing" });
		const priorEvent = { ...normalizedEvent(priorFact, new Date("2026-07-27T12:00:00Z"))!, status: "published" } as BeachEvent;
		h.values.set(`${EVENT_PREFIX}${priorEvent.id}`, JSON.stringify(priorEvent));
		const priorSnapshot = buildSnapshot([priorEvent], new Date("2026-07-27T12:00:00Z"));
		h.values.set("beach-events:v1:snapshot", JSON.stringify(priorSnapshot));
		const components = Array.from({ length: 20 }, (_, index) => `BEGIN:VEVENT\r\nUID:${index === 19 ? "known-uid" : `valid-${index}`}\r\nSUMMARY:Beach Cleanup ${index}\r\nLOCATION:Gulf Shores Public Beach\r\nDTSTART:${index === 19 ? "invalid" : "20260801T130000Z"}\r\nEND:VEVENT`).join("\r\n");
		const partialFeed = `BEGIN:VCALENDAR\r\n${components}\r\nEND:VCALENDAR`;
		const fetcher = vi.fn((url: RequestInfo | URL) => response(String(url).includes("gulfshoresal.gov") ? partialFeed : emptyFeed)) as unknown as typeof fetch;
		const result = await refreshBeachEvents(h.env, new Date("2026-07-28T12:00:00Z"), fetcher, { icalFetch: { sleep: async () => {}, random: () => 0 } });
		expect(result.refresh.status).toBe("warning");
		expect(result.providers.find((item) => item.providerId === "gulfShoresCity")).toMatchObject({ status: "partial", completeness: "partial", diagnostics: { validVEventCount: 19, rejectedVEventCount: 1, partial: true } });
		expect(JSON.parse(h.values.get(`${EVENT_PREFIX}${priorEvent.id}`)!)).not.toHaveProperty("sourceMissingCount");
		expect(JSON.parse(h.values.get("beach-events:v1:snapshot")!)).toEqual(priorSnapshot);
	});

	it("uses private conditional validators and treats 304 as last-known-good confirmation", async () => {
		const h = memoryEnv();
		const firstFetcher = vi.fn(async () => new Response(beachFeed, { headers: { "Content-Type": "text/calendar", ETag: '"feed-v1"', "Last-Modified": "Tue, 28 Jul 2026 12:00:00 GMT" } })) as unknown as typeof fetch;
		await refreshBeachEvents(h.env, new Date("2026-07-28T12:00:00Z"), firstFetcher);
		const snapshot = h.values.get("beach-events:v1:snapshot");
		const secondFetcher = vi.fn(async (_url, init) => {
			const headers = new Headers(init?.headers);
			expect(headers.get("If-None-Match")).toBe('"feed-v1"');
			expect(headers.get("If-Modified-Since")).toBe("Tue, 28 Jul 2026 12:00:00 GMT");
			return new Response(null, { status: 304 });
		}) as unknown as typeof fetch;
		const second = await refreshBeachEvents(h.env, new Date("2026-07-29T12:00:00Z"), secondFetcher);
		expect(second.refresh.status).toBe("healthy");
		expect(second.providers.filter((item) => item.status !== "disabled").every((item) => item.completeness === "confirmedUnchanged")).toBe(true);
		expect(JSON.parse(h.values.get("beach-events:v1:snapshot")!)).toMatchObject({ revision: JSON.parse(snapshot!).revision, beaches: JSON.parse(snapshot!).beaches });
		expect(second.refresh.publicRevisionChanged).toBe(false);
		expect(JSON.stringify(second.refresh)).not.toContain("feed-v1");
	});

	it("inherits committed partial completeness across 304 without reconciliation", async () => {
		const h = memoryEnv(), key = "beach-events:v1:ical-state:gulfStatePark";
		h.values.set(key, JSON.stringify({ schemaVersion: 2, validators: { etag: '"partial"' }, lastCompleteValidCount: 20, lastPartialValidCount: 19, lastAcceptedCompleteness: "partial" }));
		const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url).includes("calendar.google.com") ? new Response(null, { status: 304 }) : response(emptyFeed)) as unknown as typeof fetch;
		const result = await refreshBeachEvents(h.env, new Date("2026-07-29T12:00:00Z"), fetcher);
		expect(result.providers.find((item) => item.providerId === "gulfStatePark")).toMatchObject({ status: "partial", completeness: "partial", missingFromSource: 0 });
		expect(JSON.parse(h.values.get(key)!)).toMatchObject({ lastAcceptedCompleteness: "partial", lastCompleteValidCount: 20 });
	});

	it("does not advance validators when final snapshot publication fails", async () => {
		const h = memoryEnv(), key = "beach-events:v1:ical-state:gulfStatePark", originalPut = h.kv.put.getMockImplementation()!;
		h.values.set(key, JSON.stringify({ schemaVersion: 2, validators: { etag: '"old"' }, lastCompleteValidCount: 1, lastAcceptedCompleteness: "complete" }));
		h.kv.put.mockImplementation(async (writeKey: string, value: string) => { if (writeKey === "beach-events:v1:snapshot") throw new Error("injected snapshot failure"); return originalPut(writeKey, value); });
		await expect(refreshBeachEvents(h.env, new Date("2026-07-29T12:00:00Z"), vi.fn(async () => new Response(beachFeed, { headers: { "Content-Type": "text/calendar", ETag: '"new"' } })) as unknown as typeof fetch)).rejects.toThrow("injected snapshot failure");
		expect(JSON.parse(h.values.get(key)!)).toMatchObject({ validators: { etag: '"old"' }, lastAcceptedCompleteness: "complete" });
	});

	it("reports a conditional-state persistence failure without advancing the validator", async () => {
		const h = memoryEnv(), key = "beach-events:v1:ical-state:gulfStatePark", originalPut = h.kv.put.getMockImplementation()!;
		h.values.set(key, JSON.stringify({ schemaVersion: 2, validators: { etag: '"old"' }, lastCompleteValidCount: 1, lastAcceptedCompleteness: "complete" }));
		h.kv.put.mockImplementation(async (writeKey: string, value: string) => { if (writeKey === key) throw new Error("injected conditional failure"); return originalPut(writeKey, value); });
		const result = await refreshBeachEvents(h.env, new Date("2026-07-29T12:00:00Z"), vi.fn(async () => new Response(beachFeed, { headers: { "Content-Type": "text/calendar", ETag: '"new"' } })) as unknown as typeof fetch);
		expect(result).toMatchObject({ outcome: "partial", refresh: { status: "warning" } });
		expect(result.providers.find((item) => item.providerId === "gulfStatePark")).toMatchObject({ status: "failed", error: "conditional_state_persistence_failed" });
		expect(JSON.parse(h.values.get(key)!)).toMatchObject({ validators: { etag: '"old"' } });
	});

	it("does not retrieve the disabled Dauphin Island source and preserves manual review records", async () => {
		const retained = memoryEnv();
		const fact = facts({ providerId: "dauphinIslandTown", externalId: "July 2026:movie", title: "Family Movie Night", venue: "East End Beach", sourceName: "Town of Dauphin Island Events · July 2026", sourceURL: townIssueURL });
		const event = normalizedEvent(fact, new Date("2026-07-28T12:00:00Z"))!;
		retained.values.set(`beach-events:v1:event:${event.id}`, JSON.stringify({ ...event, status: "approved" }));
		const fetcher = feedFetcher(emptyFeed) as unknown as ReturnType<typeof vi.fn>;
		const result = await refreshBeachEvents(retained.env, new Date("2026-07-29T12:00:00Z"), fetcher as unknown as typeof fetch);
		expect(result.refresh.providers.find((item) => item.providerId === "dauphinIslandTown")).toMatchObject({ status: "disabled", freshness: "never", fetched: 0 });
		expect(fetcher.mock.calls.some(([url]) => String(url).includes("townofdauphinisland.org"))).toBe(false);
		expect(JSON.parse(retained.values.get(`beach-events:v1:event:${event.id}`)!)).toMatchObject({ title: "Family Movie Night", status: "approved" });
	});

	it("reports stable new/unchanged/duplicate counts and public revision changes", async () => {
		const h = memoryEnv();
		const fetcher = feedFetcher(beachFeed);
		const first = await refreshBeachEvents(h.env, new Date("2026-07-28T12:00:00Z"), fetcher);
		expect(first.refresh).toMatchObject({ publicRevisionChanged: true, counts: { newEvents: 4, possibleDuplicates: 0, unchanged: 0 } });
		const second = await refreshBeachEvents(h.env, new Date("2026-07-29T12:00:00Z"), fetcher);
		expect(second.refresh).toMatchObject({ publicRevisionChanged: false, counts: { newEvents: 0, possibleDuplicates: 0, unchanged: 4 } });
		expect(second.refresh.providers.find((provider) => provider.providerId === "gulfShoresCity")).toMatchObject({ newEvents: 0, changed: 0, unchanged: 1 });
	});

	it("reports disabled and monitor-only controls without unsafe ingestion", async () => {
		const disabled = memoryEnv(), doc = defaultOperationalControl(new Date("2026-07-28T12:00:00Z"));
		doc.controls["domains.beachEvents"] = { state: "disabled" };
		disabled.values.set(CURRENT_KEY, JSON.stringify(doc));
		expect(await refreshBeachEvents(disabled.env, new Date("2026-07-28T12:00:00Z"))).toMatchObject({ outcome: "disabled", refresh: { status: "disabled" } });
		const providerDisabled = memoryEnv(), providerDoc = defaultOperationalControl(new Date("2026-07-28T12:00:00Z"));
		providerDoc.controls["providers.orangeBeachEvents"] = { state: "disabled" };
		providerDisabled.values.set(CURRENT_KEY, JSON.stringify(providerDoc));
		const disabledFact = facts({ providerId: "orangeBeachParks", venue: "Cotton Bayou Public Beach", sourceName: "City of Orange Beach" });
		const disabledEvent = normalizedEvent(disabledFact, new Date("2026-07-27T12:00:00.000Z"))!;
		providerDisabled.values.set(`${EVENT_PREFIX}${disabledEvent.id}`, JSON.stringify({ ...disabledEvent, status: "published" }));
		const result = await refreshBeachEvents(providerDisabled.env, new Date("2026-07-28T12:00:00Z"), feedFetcher(emptyFeed));
		expect(result.providers.find((item) => item.providerId === "orangeBeachParks")?.status).toBe("disabled");
		expect(JSON.parse(providerDisabled.values.get(`${EVENT_PREFIX}${disabledEvent.id}`)!)).not.toHaveProperty("sourceMissingCount");
		const monitored = memoryEnv(), monitorDoc = defaultOperationalControl(new Date("2026-07-28T12:00:00Z"));
		monitorDoc.controls["providers.gulfShoresEvents"] = { state: "monitorOnly" };
		monitored.values.set(CURRENT_KEY, JSON.stringify(monitorDoc));
		const monitoredEvent = normalizedEvent(facts(), new Date("2026-07-27T12:00:00.000Z"))!;
		monitored.values.set(`${EVENT_PREFIX}${monitoredEvent.id}`, JSON.stringify({ ...monitoredEvent, status: "published" }));
		const monitorResult = await refreshBeachEvents(monitored.env, new Date("2026-07-28T12:00:00Z"), feedFetcher(emptyFeed));
		expect(monitorResult.providers.find((item) => item.providerId === "gulfShoresCity")?.status).toBe("monitored");
		expect(JSON.parse(monitored.values.get(`${EVENT_PREFIX}${monitoredEvent.id}`)!)).not.toHaveProperty("sourceMissingCount");
	});

	it("does not send a review summary as a side effect of an out-of-window refresh", async () => {
		const h = memoryEnv();
		const pending = normalizedEvent(facts({ providerId: "manual", venue: "Gulf Shores Public Beach" }), new Date("2026-07-27T12:00:00.000Z"))!;
		h.values.set(`${EVENT_PREFIX}${pending.id}`, JSON.stringify(pending));
		const send = vi.fn(async () => undefined);
		Object.assign(h.env, {
			BEACH_ACTIVITY_NOTIFICATIONS_ENABLED: "true",
			BEACH_ACTIVITY_NOTIFICATION_RECIPIENTS: "operations@alabamabeachflag.com",
			VERIFICATION_ALERT_EMAIL: { send },
		});
		await refreshBeachEvents(h.env, new Date("2026-07-28T20:00:00.000Z"), feedFetcher(emptyFeed));
		expect(send).not.toHaveBeenCalled();
		expect(h.values.has(BEACH_ACTIVITY_NOTIFICATION_STATE_KEY)).toBe(false);
		expect(JSON.parse(h.values.get(`${EVENT_PREFIX}${pending.id}`)!)).toMatchObject({ status: "pendingReview" });
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
