import { describe, expect, it } from "vitest";
import { parseICalendar } from "../src/beachEvents/ical";
import { buildReviewQueue } from "../src/beachEvents/notifications";
import { compareSourceFacts, sourceRevision } from "../src/beachEvents/sourceChanges";
import {
	EVENT_PREFIX,
	EXCLUSION_PREFIX,
	PUBLIC_BEACH_EVENT_FIELDS,
	SNAPSHOT_KEY,
	applyImportedEvents,
	buildSnapshot,
	importedEventId,
	normalizedEvent,
	reconcileProviderSource,
	serializePublicEvent,
} from "../src/beachEvents/store";
import { eventAdminRevision, handleBeachEventsAdminCreate, handleBeachEventsAdminUpdate, handleBeachEventsRequest } from "../src/routes/beachEvents";
import { CURRENT_KEY, defaultOperationalControl } from "../src/operationalControl/store";
import type { BeachEvent, SourceFacts } from "../src/beachEvents/types";
import type { Env } from "../src/types";
import { beachEventEdgeCaseCalendar } from "./fixtures/beach-event-edge-cases";

function memoryEnv() {
	const values = new Map<string, string>();
	const kv = {
		get: async (key: string, type?: string) => {
			const value = values.get(key);
			return value === undefined ? null : type === "json" ? JSON.parse(value) : value;
		},
		put: async (key: string, value: string) => { values.set(key, value); },
		delete: async (key: string) => { values.delete(key); },
		list: async ({ prefix }: { prefix: string }) => ({ keys: [...values.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
	};
	const env = {
		BEACH_DATA: kv,
		BEACH_ACTIVITY_NOTIFICATIONS_ENABLED: "false",
		BEACH_ACTIVITY_NOTIFICATION_RECIPIENTS: "operations@alabamabeachflag.com",
	} as unknown as Env;
	return { env, values };
}

const facts = (overrides: Partial<SourceFacts> = {}): SourceFacts => ({
	providerId: "gulfShoresCity",
	externalId: "stable-uid-1",
	title: "Coastal Cleanup",
	venue: "Gulf Place Town Green",
	address: "101 East Beach Boulevard, Gulf Shores, AL 36542",
	startAt: "2026-08-10T13:00:00.000Z",
	endAt: "2026-08-10T15:00:00.000Z",
	allDay: false,
	recurring: false,
	sourceName: "City of Gulf Shores",
	sourceURL: "https://www.gulfshoresal.gov/calendar.ics",
	officialURL: "https://www.gulfshoresal.gov/events/coastal-cleanup",
	description: "Cleanup at the beach.",
	...overrides,
});

const manualInput = (status: string, overrides: Record<string, unknown> = {}) => ({
	title: "Manual Beach Cleanup",
	beachId: "gulf-shores-public-beach",
	venue: "Gulf Shores Public Beach",
	startAt: "2026-08-10T13:00:00.000Z",
	endAt: "2026-08-10T15:00:00.000Z",
	allDay: false,
	eventType: "beachCleanup",
	impactLevel: "informational",
	status,
	sourceName: "Official manual source",
	sourceURL: "https://example.gov/events/manual-cleanup",
	bannerTitle: "Beach cleanup here today",
	bannerMessage: "An activity is scheduled.",
	...overrides,
});

const keyFor = (fact: SourceFacts) => `${EVENT_PREFIX}${importedEventId(fact)}`;
const readEvent = (values: Map<string, string>, fact: SourceFacts) => JSON.parse(values.get(keyFor(fact))!) as BeachEvent;

async function seedPublished(fact = facts()) {
	const harness = memoryEnv();
	await applyImportedEvents(harness.env, [fact], new Date("2026-08-01T12:00:00.000Z"));
	const event = readEvent(harness.values, fact);
	const published = { ...event, status: "published", reviewedSourceRevision: event.sourceRevision } as BeachEvent;
	harness.values.set(keyFor(fact), JSON.stringify(published));
	return { ...harness, fact, published };
}

describe("official event provider edge cases", () => {
	it("normalizes provider markup, addresses, time zones, recurrence, all-day spans, and source status", () => {
		const parsed = parseICalendar(beachEventEdgeCaseCalendar, { id: "gulfStatePark", name: "Official State Park", feedURL: "https://example.gov/feed.ics" });
		const registration = parsed.find((event) => event.externalId === "registration-url")!;
		expect(registration).toMatchObject({
			title: "Pier & Beach Cleanup",
			venue: "Gulf State Park Pier",
			address: "20800 E Beach Blvd, Gulf Shores, AL 36542",
			startAt: "2026-08-01T13:00:00.000Z",
			endAt: "2026-08-01T14:30:00.000Z",
			officialURL: "https://city.example.gov/events/pier-cleanup",
			registrationURL: "https://tickets.example.gov/register/pier-cleanup?session=morning",
			sequence: 4,
			lastModified: "2026-07-20T15:00:00.000Z",
		});
		const occurrences = parsed.filter((event) => event.externalId.startsWith("recurring-program::"));
		expect(occurrences).toHaveLength(2);
		expect(new Set(occurrences.map((event) => event.externalId)).size).toBe(2);
		expect(occurrences.every((event) => event.recurring && event.recurrenceId && event.address === "101 E Beach Blvd, Gulf Shores, AL 36542")).toBe(true);
		expect(parsed.find((event) => event.externalId === "all-day-dst")).toMatchObject({ allDay: true, startAt: "2026-03-08T06:00:00.000Z", endAt: "2026-03-09T05:00:00.000Z" });
		expect(parsed.find((event) => event.externalId === "multi-day")).toMatchObject({ allDay: true, startAt: "2026-03-08T06:00:00.000Z", endAt: "2026-03-10T05:00:00.000Z" });
		expect(parsed.find((event) => event.externalId === "cancelled-event")?.sourceStatus).toBe("cancelled");
		expect(parsed.find((event) => event.externalId === "postponed-event")?.sourceStatus).toBe("postponed");
		const noEnd = parsed.filter((event) => event.externalId === "no-end");
		expect(noEnd).toHaveLength(1);
		expect(noEnd[0]).toMatchObject({ endTimeUnavailable: true, startAt: "2026-08-05T23:00:00.000Z", endAt: "2026-08-06T00:00:00.000Z" });
	});

	it.each([
		["missing calendar envelope", "not a calendar"],
		["truncated event", "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:partial\r\nSUMMARY:Beach Cleanup\r\nDTSTART:20260801T130000Z"],
		["missing stable identity", "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Beach Cleanup\r\nDTSTART:20260801T130000Z\r\nEND:VEVENT\r\nEND:VCALENDAR"],
		["invalid start", "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:bad-date\r\nSUMMARY:Beach Cleanup\r\nDTSTART:not-a-date\r\nEND:VEVENT\r\nEND:VCALENDAR"],
		["invalid end", "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:bad-end\r\nSUMMARY:Beach Cleanup\r\nDTSTART:20260801T130000Z\r\nDTEND:not-a-date\r\nEND:VEVENT\r\nEND:VCALENDAR"],
		["reversed times", "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:reversed\r\nSUMMARY:Beach Cleanup\r\nDTSTART:20260801T140000Z\r\nDTEND:20260801T130000Z\r\nEND:VEVENT\r\nEND:VCALENDAR"],
		["event outside calendar", "BEGIN:VEVENT\r\nUID:outside\r\nSUMMARY:Beach Cleanup\r\nDTSTART:20260801T130000Z\r\nEND:VEVENT\r\nBEGIN:VCALENDAR\r\nEND:VCALENDAR"],
	])("rejects a malformed or partial provider response: %s", (_label, calendar) => {
		expect(() => parseICalendar(calendar, { id: "gulfShoresCity", name: "Official", feedURL: "https://example.gov/feed.ics" })).toThrow(/Malformed|requires/);
	});
});

describe("deterministic source-change materiality", () => {
	it("treats markup, entities, punctuation, minor wording, and URL tracking as cosmetic", () => {
		const previous = facts({
			title: "Coastal Cleanup",
			address: "101 East Beach Boulevard, Gulf Shores, Alabama 36542",
			description: "Please visit the official website for event details. Parking is free.",
			officialURL: "https://example.gov/events/coastal-cleanup/?utm_source=calendar&b=2&a=1",
		});
		const current = facts({
			title: "  COASTAL&nbsp; CLEANUP! Event ",
			address: "101 E. Beach Blvd., Gulf Shores, AL 36542",
			description: "<p>Parking is free!</p><p>Learn more on our website.</p>",
			officialURL: "https://example.gov/events/coastal-cleanup?a=1&b=2&fbclid=ignored",
		});
		const comparison = compareSourceFacts(previous, current);
		expect(comparison.changedFields).toEqual(["address", "description", "officialURL", "title"]);
		expect(comparison.materialFields).toEqual([]);
		expect(comparison.cosmeticFields).toEqual(["address", "description", "officialURL", "title"]);
	});

	it("treats the legacy missing source status as confirmed", () => {
		const legacy = facts();
		const explicit = facts({ sourceStatus: "confirmed" });
		expect(compareSourceFacts(legacy, explicit)).toMatchObject({ changedFields: ["sourceStatus"], materialFields: [], cosmeticFields: ["sourceStatus"] });
		expect(sourceRevision(explicit)).toBe(sourceRevision(legacy));
	});

	it.each([
		["start time", { startAt: "2026-08-10T14:00:00.000Z" }, "startAt"],
		["end time", { endAt: "2026-08-10T16:00:00.000Z" }, "endAt"],
		["venue", { venue: "Gulf Shores Public Beach" }, "venue"],
		["registration requirement", { registrationURL: "https://example.gov/register" }, "registrationURL"],
		["parking guidance", { description: "Parking is prohibited in the south lot." }, "description"],
		["beach-access guidance", { description: "Use the east beach-access gate." }, "description"],
		["visitor instructions", { description: "Visitors must check in at the pavilion." }, "description"],
		["event meaning", { title: "Coastal Cleanup and Wildlife Release" }, "title"],
		["cancellation", { sourceStatus: "cancelled" }, "sourceStatus"],
		["postponement", { sourceStatus: "postponed" }, "sourceStatus"],
	] as const)("requires review for a material %s change", (_label, overrides, field) => {
		expect(compareSourceFacts(facts(), facts(overrides)).materialFields).toContain(field);
	});
});

describe("stable source identity and reviewed changes", () => {
	it("keeps an unchanged stable source event and its reviewed timestamp stable", async () => {
		const h = await seedPublished();
		const result = await applyImportedEvents(h.env, [h.fact], new Date("2026-08-02T12:00:00.000Z"));
		const stored = readEvent(h.values, h.fact);
		expect(result).toMatchObject({ changed: 0, unchanged: 1, newEvents: 0 });
		expect(stored).toMatchObject({ status: "published", updatedAt: h.published.updatedAt, lastSeenAt: "2026-08-02T12:00:00.000Z" });
	});

	it.each([
		["title", { title: "Coastal Cleanup and Wildlife Walk" }],
		["time", { startAt: "2026-08-10T14:00:00.000Z", endAt: "2026-08-10T16:00:00.000Z" }],
		["venue", { venue: "Gulf Shores Public Beach" }],
	] as const)("updates the existing stable event and requires review for a material %s change", async (_label, overrides) => {
		const h = await seedPublished();
		const changed = facts(overrides);
		const result = await applyImportedEvents(h.env, [changed], new Date("2026-08-02T12:00:00.000Z"));
		const stored = readEvent(h.values, h.fact);
		expect(result).toMatchObject({ changed: 1, newEvents: 0 });
		expect(stored.id).toBe(h.published.id);
		expect(stored.status).toBe("pendingReview");
		expect(stored.attentionFlags).toContain("materialSourceChange");
		expect(stored.sourceChange).toMatchObject({ previousStatus: "published", previous: h.fact, current: changed });
		expect(buildSnapshot([stored], new Date("2026-08-02T12:00:00.000Z")).beaches).toEqual({});
	});

	it("updates cosmetic punctuation without forcing a published event out of public output", async () => {
		const h = await seedPublished();
		const cosmetic = facts({ title: "COASTAL CLEANUP!" });
		const result = await applyImportedEvents(h.env, [cosmetic], new Date("2026-08-02T12:00:00.000Z"));
		const stored = readEvent(h.values, h.fact);
		expect(result).toMatchObject({ changed: 1 });
		expect(stored).toMatchObject({ status: "published", title: "COASTAL CLEANUP!" });
		expect(stored.sourceChange).toBeUndefined();
		expect(stored.reviewedSourceRevision).toBe(stored.sourceRevision);
		expect(buildSnapshot([stored], new Date("2026-08-02T12:00:00.000Z")).beaches[stored.beachId]).toHaveLength(1);
	});

	it("preserves the original material diff through a later cosmetic source refresh", async () => {
		const h = await seedPublished();
		const materiallyChanged = facts({ startAt: "2026-08-10T14:00:00.000Z", endAt: "2026-08-10T16:00:00.000Z" });
		await applyImportedEvents(h.env, [materiallyChanged], new Date("2026-08-02T12:00:00.000Z"));
		await applyImportedEvents(h.env, [{ ...materiallyChanged, title: "COASTAL CLEANUP!" }], new Date("2026-08-03T12:00:00.000Z"));
		const stored = readEvent(h.values, h.fact);
		expect(stored).toMatchObject({ status: "pendingReview", attentionFlags: expect.arrayContaining(["materialSourceChange"]) });
		expect(stored.sourceChange).toMatchObject({
			previousStatus: "published",
			previous: h.fact,
			current: expect.objectContaining({ title: "COASTAL CLEANUP!", startAt: materiallyChanged.startAt }),
			materialFields: expect.arrayContaining(["startAt", "endAt"]),
			cosmeticFields: expect.arrayContaining(["title"]),
		});
	});

	it("records provider metadata revisions without changing public content or its revision", async () => {
		const h = await seedPublished();
		const before = buildSnapshot([h.published], new Date("2026-08-01T12:00:00.000Z"));
		const result = await applyImportedEvents(h.env, [facts({ sequence: 2, lastModified: "2026-08-02T11:00:00.000Z" })], new Date("2026-08-02T12:00:00.000Z"));
		const stored = readEvent(h.values, h.fact);
		expect(result).toMatchObject({ changed: 1 });
		expect(stored).toMatchObject({ status: "published", updatedAt: h.published.updatedAt });
		expect(stored.sourceFacts).toMatchObject({ sequence: 2, lastModified: "2026-08-02T11:00:00.000Z" });
		expect(buildSnapshot([stored], new Date("2026-08-02T12:00:00.000Z")).revision).toBe(before.revision);
		const audit = [...h.values.entries()].filter(([key]) => key.startsWith("beach-events:v1:audit:")).map(([, value]) => JSON.parse(value)).find((record) => record.action === "source_event_cosmetic_change");
		expect(audit).toMatchObject({ publicOutputAffected: false, changedFields: ["lastModified", "sequence"] });
	});

	it("removes cancellations immediately and sends postponements back to review", async () => {
		const cancelled = await seedPublished();
		await applyImportedEvents(cancelled.env, [facts({ sourceStatus: "cancelled" })], new Date("2026-08-02T12:00:00.000Z"));
		expect(readEvent(cancelled.values, cancelled.fact)).toMatchObject({ status: "cancelled", attentionFlags: expect.arrayContaining(["sourceCancelled", "materialSourceChange"]) });
		await applyImportedEvents(cancelled.env, [facts({ sourceStatus: "confirmed" })], new Date("2026-08-03T12:00:00.000Z"));
		const reinstated = readEvent(cancelled.values, cancelled.fact);
		expect(reinstated).toMatchObject({ status: "pendingReview", attentionFlags: ["materialSourceChange"] });
		expect(reinstated.attentionFlags).not.toContain("sourceCancelled");
		const postponed = await seedPublished();
		await applyImportedEvents(postponed.env, [facts({ sourceStatus: "postponed" })], new Date("2026-08-02T12:00:00.000Z"));
		expect(readEvent(postponed.values, postponed.fact)).toMatchObject({ status: "pendingReview", attentionFlags: expect.arrayContaining(["sourcePostponed", "materialSourceChange"]) });
	});

	it("confirms source removal twice, avoids repeated churn, restores to review, and preserves manual records", async () => {
		const h = await seedPublished();
		const manualFact = facts({ providerId: "manual", externalId: "manual-1", title: "Manual Cleanup" });
		const manual = { ...normalizedEvent(manualFact, new Date("2026-08-01T12:00:00.000Z"))!, status: "approved" } as BeachEvent;
		h.values.set(`${EVENT_PREFIX}${manual.id}`, JSON.stringify(manual));
		await reconcileProviderSource(h.env, h.fact.providerId, new Set(), new Date("2026-08-02T12:00:00.000Z"));
		expect(readEvent(h.values, h.fact)).toMatchObject({ status: "published", sourceMissingCount: 1, attentionFlags: ["sourceMissing"] });
		await reconcileProviderSource(h.env, h.fact.providerId, new Set(), new Date("2026-08-03T12:00:00.000Z"));
		const removed = readEvent(h.values, h.fact);
		expect(removed).toMatchObject({ status: "pendingReview", sourceMissingCount: 2, sourceRemovedAt: "2026-08-03T12:00:00.000Z", attentionFlags: ["sourceRemoved"] });
		const stableRemoved = JSON.stringify(removed);
		await reconcileProviderSource(h.env, h.fact.providerId, new Set(), new Date("2026-08-04T12:00:00.000Z"));
		expect(JSON.stringify(readEvent(h.values, h.fact))).toBe(stableRemoved);
		await applyImportedEvents(h.env, [h.fact], new Date("2026-08-05T12:00:00.000Z"));
		const restored = readEvent(h.values, h.fact);
		expect(restored).toMatchObject({ status: "pendingReview", attentionFlags: ["sourceRestored"] });
		expect(restored).not.toHaveProperty("sourceMissingCount");
		expect(restored).not.toHaveProperty("sourceRemovedAt");
		expect(restored.sourceChange?.materialFields).toContain("sourcePresence");
		expect(JSON.parse(h.values.get(`${EVENT_PREFIX}${manual.id}`)!)).toMatchObject({ status: "approved", title: "Manual Cleanup" });
	});

	it("keeps separate recurrence occurrences and a multi-day event stable by source identity", async () => {
		const parsed = parseICalendar(beachEventEdgeCaseCalendar, { id: "gulfShoresCity", name: "Official", feedURL: "https://example.gov/feed.ics" });
		const occurrences = parsed.filter((event) => event.externalId.startsWith("recurring-program::"));
		const h = memoryEnv();
		const occurrencesWithSharedPage = occurrences.map((occurrence) => ({ ...occurrence, officialURL: "https://example.gov/events/family-beach-program" }));
		expect(await applyImportedEvents(h.env, occurrencesWithSharedPage, new Date("2026-08-01T12:00:00.000Z"))).toMatchObject({ newEvents: 2, possibleDuplicates: 0 });
		const multi = parsed.find((event) => event.externalId === "multi-day")!;
		const freshMulti = { ...multi, startAt: "2026-08-08T05:00:00.000Z", endAt: "2026-08-10T05:00:00.000Z" };
		expect(await applyImportedEvents(h.env, [freshMulti], new Date("2026-08-01T12:00:00.000Z"))).toMatchObject({ newEvents: 1 });
		expect(await applyImportedEvents(h.env, [freshMulti], new Date("2026-08-02T12:00:00.000Z"))).toMatchObject({ unchanged: 1, newEvents: 0 });
	});
});

describe("duplicates, workflow, and auditability", () => {
	it("routes cross-provider and manual overlaps to review without silently merging", async () => {
		const h = memoryEnv();
		const original = facts({ venue: "Gulf Shores Public Beach" });
		await applyImportedEvents(h.env, [original], new Date("2026-08-01T12:00:00.000Z"));
		const unstableUid = { ...original, externalId: "replacement-calendar-uid" };
		expect(await applyImportedEvents(h.env, [unstableUid], new Date("2026-08-01T12:03:00.000Z"))).toMatchObject({ newEvents: 0, possibleDuplicates: 1 });
		expect(JSON.parse(h.values.get(`${EXCLUSION_PREFIX}gulfShoresCity-replacement-calendar-uid`)!)).toMatchObject({ reason: "duplicate", possibleDuplicateOf: importedEventId(original) });
		const duplicate = facts({ providerId: "orangeBeachParks", externalId: "other-feed-id", sourceName: "City of Orange Beach" });
		expect(await applyImportedEvents(h.env, [duplicate], new Date("2026-08-01T12:05:00.000Z"))).toMatchObject({ newEvents: 0, possibleDuplicates: 1 });
		const excluded = JSON.parse(h.values.get(`${EXCLUSION_PREFIX}orangeBeachParks-other-feed-id`)!);
		expect(excluded).toMatchObject({ reason: "duplicate", possibleDuplicateOf: importedEventId(original), matchConfidence: "possible" });

		const manualResponse = await handleBeachEventsAdminCreate(new Request("https://example.com/admin/beach-events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: original.title, beachId: "gulf-shores-public-beach", venue: original.venue, address: original.address,
				startAt: original.startAt, endAt: original.endAt, allDay: false, eventType: "beachCleanup", impactLevel: "informational",
				status: "pendingReview", sourceName: "Manual official entry", sourceURL: "https://example.gov/manual-event",
				bannerTitle: "Beach cleanup here today", bannerMessage: "An activity is scheduled.",
			}),
		}), h.env, { method: "access", subject: "operator@example.com" }, new Date("2026-08-01T12:10:00.000Z"));
		expect(manualResponse.status).toBe(201);
		expect((await manualResponse.json() as { event: BeachEvent }).event).toMatchObject({ status: "pendingReview", possibleDuplicateOf: importedEventId(original), attentionFlags: ["possibleDuplicate"] });
	});

	it("requires approval before publication and records structured state history", async () => {
		const h = memoryEnv();
		const event = normalizedEvent(facts(), new Date("2026-08-01T12:00:00.000Z"))!;
		h.values.set(`${EVENT_PREFIX}${event.id}`, JSON.stringify(event));
		const sourceRefreshSnapshot = buildSnapshot([], new Date("2026-08-01T11:00:00.000Z"));
		h.values.set(SNAPSHOT_KEY, JSON.stringify(sourceRefreshSnapshot));
		const request = (status: string) => new Request(`https://example.com/admin/beach-events/${event.id}`, { method: "PATCH", headers: { "Content-Type": "application/json", "If-Match": eventAdminRevision(JSON.parse(h.values.get(`${EVENT_PREFIX}${event.id}`)!)) }, body: JSON.stringify({ status }) });
		expect((await handleBeachEventsAdminUpdate(request("published"), h.env, { method: "access", subject: "operator@example.com" }, event.id, new Date("2026-08-01T12:05:00.000Z"))).status).toBe(409);
		expect((await handleBeachEventsAdminUpdate(request("approved"), h.env, { method: "access", subject: "operator@example.com" }, event.id, new Date("2026-08-01T12:10:00.000Z"))).status).toBe(200);
		expect(JSON.parse(h.values.get(SNAPSHOT_KEY)!)).toMatchObject({ beaches: {}, lastSuccessfulRefresh: sourceRefreshSnapshot.lastSuccessfulRefresh });
		expect((await handleBeachEventsAdminUpdate(request("scheduled"), h.env, { method: "access", subject: "operator@example.com" }, event.id, new Date("2026-08-01T12:12:00.000Z"))).status).toBe(200);
		expect(JSON.parse(h.values.get(SNAPSHOT_KEY)!)).toMatchObject({ beaches: {}, lastSuccessfulRefresh: sourceRefreshSnapshot.lastSuccessfulRefresh });
		expect((await handleBeachEventsAdminUpdate(request("published"), h.env, { method: "access", subject: "operator@example.com" }, event.id, new Date("2026-08-01T12:15:00.000Z"))).status).toBe(200);
		const publishedSnapshot = JSON.parse(h.values.get(SNAPSHOT_KEY)!);
		expect(publishedSnapshot.beaches[event.beachId]).toHaveLength(1);
		expect(publishedSnapshot.lastSuccessfulRefresh).toBe(sourceRefreshSnapshot.lastSuccessfulRefresh);
		const records = [...h.values.entries()].filter(([key]) => key.startsWith("beach-events:v1:audit:")).map(([, value]) => JSON.parse(value)).filter((record) => record.targetId === event.id);
		expect(records).toEqual(expect.arrayContaining([
			expect.objectContaining({ action: "update_event", previousState: "pendingReview", newState: "approved", changedFields: ["status"], sourceRevision: event.sourceRevision, origin: "manual", publicOutputAffected: false }),
			expect.objectContaining({ action: "update_event", previousState: "approved", newState: "scheduled", changedFields: ["status"], sourceRevision: event.sourceRevision, origin: "manual", publicOutputAffected: false }),
			expect.objectContaining({ action: "update_event", previousState: "scheduled", newState: "published", changedFields: ["status"], sourceRevision: event.sourceRevision, origin: "manual", publicOutputAffected: true }),
		]));
	});

	it("requires every manual creation to begin in pending review", async () => {
		const h = memoryEnv();
		for (const status of ["draft", "approved", "scheduled", "published"]) {
			const response = await handleBeachEventsAdminCreate(new Request("https://example.com/admin/beach-events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(manualInput(status)) }), h.env, { method: "access", subject: "operator@example.com" });
			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({ error: "manual_creation_requires_review" });
		}
		const accepted = await handleBeachEventsAdminCreate(new Request("https://example.com/admin/beach-events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(manualInput("pendingReview")) }), h.env, { method: "access", subject: "operator@example.com" }, new Date("2026-08-01T12:00:00.000Z"));
		expect(accepted.status).toBe(201);
		expect((await accepted.json() as { event: BeachEvent }).event.status).toBe("pendingReview");
	});

	it("turns approval of an ambiguous retained beach into an explicit admin assignment", async () => {
		const h = memoryEnv();
		const event = { ...normalizedEvent(facts(), new Date("2026-08-01T12:00:00.000Z"))!, status: "pendingReview", matchMethod: "ambiguousSourceChange", matchConfidence: "ambiguous", attentionFlags: ["ambiguousMatch", "materialSourceChange"] } as BeachEvent;
		h.values.set(`${EVENT_PREFIX}${event.id}`, JSON.stringify(event));
		const response = await handleBeachEventsAdminUpdate(new Request(`https://example.com/admin/beach-events/${event.id}`, { method: "PATCH", headers: { "Content-Type": "application/json", "If-Match": eventAdminRevision(event) }, body: JSON.stringify({ status: "approved" }) }), h.env, { method: "access", subject: "operator@example.com" }, event.id, new Date("2026-08-01T12:10:00.000Z"));
		expect(response.status).toBe(200);
		const approved = (await response.json() as { event: BeachEvent }).event;
		expect(approved).toMatchObject({ status: "approved", matchMethod: "adminOverride", matchConfidence: "admin", matchRuleId: "admin-reviewed-ambiguous-source-location" });
		expect(approved).not.toHaveProperty("attentionFlags");
	});

	it("rejects a stale approval without clearing newer source-change attention", async () => {
		const h = memoryEnv();
		const event = { ...normalizedEvent(facts(), new Date("2026-08-01T12:00:00.000Z"))!, status: "pendingReview", updatedAt: "2026-08-01T12:10:00.000Z", attentionFlags: ["materialSourceChange"] } as BeachEvent;
		h.values.set(`${EVENT_PREFIX}${event.id}`, JSON.stringify(event));
		const response = await handleBeachEventsAdminUpdate(new Request(`https://example.com/admin/beach-events/${event.id}`, { method: "PATCH", headers: { "Content-Type": "application/json", "If-Match": "2026-08-01T12:00:00.000Z" }, body: JSON.stringify({ status: "approved" }) }), h.env, { method: "access", subject: "operator@example.com" }, event.id);
		expect(response.status).toBe(412);
		expect(await response.json()).toEqual({ error: "revision_conflict", currentRevision: eventAdminRevision(event) });
		expect(JSON.parse(h.values.get(`${EVENT_PREFIX}${event.id}`)!)).toMatchObject({ status: "pendingReview", attentionFlags: ["materialSourceChange"] });
	});

	it("treats scheduled as reviewed while keeping it non-public", async () => {
		const h = memoryEnv();
		const event = {
			...normalizedEvent(facts(), new Date("2026-08-01T12:00:00.000Z"))!,
			status: "pendingReview",
			attentionFlags: ["materialSourceChange"],
			sourceChange: {
				detectedAt: "2026-08-01T12:00:00.000Z",
				previousRevision: "old",
				currentRevision: "new",
				materialFields: ["startAt"],
				cosmeticFields: [],
				previousStatus: "published",
				previous: facts(),
				current: facts({ startAt: "2026-08-10T14:00:00.000Z" }),
			},
		} as BeachEvent;
		h.values.set(`${EVENT_PREFIX}${event.id}`, JSON.stringify(event));
		const response = await handleBeachEventsAdminUpdate(new Request(`https://example.com/admin/beach-events/${event.id}`, { method: "PATCH", headers: { "Content-Type": "application/json", "If-Match": eventAdminRevision(event) }, body: JSON.stringify({ status: "scheduled" }) }), h.env, { method: "access", subject: "operator@example.com" }, event.id, new Date("2026-08-01T13:00:00.000Z"));
		expect(response.status).toBe(200);
		const scheduled = (await response.json() as { event: BeachEvent }).event;
		expect(scheduled).toMatchObject({ status: "scheduled", reviewedSourceRevision: event.sourceRevision });
		expect(scheduled).not.toHaveProperty("attentionFlags");
		expect(scheduled).not.toHaveProperty("sourceChange");
		expect(buildSnapshot([scheduled], new Date("2026-08-01T13:00:00.000Z")).beaches).toEqual({});
	});
});

describe("review queue and public API boundaries", () => {
	it("classifies changed, duplicate, cancelled/removed, approaching, and provider-failure work", () => {
		const base = normalizedEvent(facts(), new Date("2026-08-01T12:00:00.000Z"))!;
		const queue = buildReviewQueue([
			{ ...base, status: "pendingReview", attentionFlags: ["materialSourceChange"], sourceChange: { detectedAt: base.updatedAt, previousRevision: "old", currentRevision: base.sourceRevision, materialFields: ["startAt"], cosmeticFields: [], previousStatus: "published", previous: base.sourceFacts, current: base.sourceFacts } },
			{ ...base, id: "cancelled", status: "cancelled", attentionFlags: ["sourceCancelled"] },
		], {
			now: new Date("2026-08-09T12:00:00.000Z"),
			exclusions: [{ id: "dup", providerId: "orangeBeachParks", title: "Duplicate", venue: base.venue, startAt: base.startAt, endAt: base.endAt, sourceName: "Official", sourceURL: "https://example.gov", reason: "duplicate", reasonDetail: "Possible duplicate", matchConfidence: "possible", possibleDuplicateOf: base.id, ruleId: "dedupe", decision: "automatic", sourceFacts: base.sourceFacts, firstSeenAt: base.createdAt, lastSeenAt: base.updatedAt }],
			refresh: { schemaVersion: 1, status: "warning", trigger: "scheduled", lastAttempt: base.updatedAt, nextScheduledRefresh: base.updatedAt, scheduleDescription: "daily", operationalState: "enabled", counts: { raw: 0, matched: 0, excluded: 0, pendingReview: 0, published: 0, ruleSuppressed: 0, unsupportedOrAmbiguous: 0 }, providers: [{ providerId: "gulfStatePark", status: "failed", fetched: 0, matched: 0, excluded: 0, pendingReview: 0, published: 0, ruleSuppressed: 0, unsupportedOrAmbiguous: 0, freshness: "stale", lastAttempt: base.updatedAt, error: "HTTP 503" }] },
		});
		expect(queue).toMatchObject({ pendingCount: 4, changedEventCount: 1, possibleDuplicateCount: 1, providerFailureCount: 1, cancelledOrRemovedCount: 1, approachingCount: 2 });
		expect(queue.issues.map((issue) => issue.kind)).toEqual(["possibleDuplicate", "providerFailure"]);
	});

	it("serializes an exact allowlist and keeps internal review data private", () => {
		const base = normalizedEvent(facts({ sourceNote: "Public source note", contactInformation: "Park office", sourceNewsletterMonth: "August 2026", endTimeUnavailable: true }), new Date("2026-08-01T12:00:00.000Z"))!;
		const event = {
			...base,
			status: "published",
			displayFrom: "2026-08-09T23:00:00.000Z",
			registrationURL: "https://example.gov/register",
			officialEventsPageURL: "https://example.gov/events",
			organizerWebsiteURL: "https://example.gov",
			internalNotes: "private",
			attentionFlags: ["normalizationWarning"],
			possibleDuplicateOf: "private-id",
			sourceMissingCount: 1,
		} as BeachEvent;
		const serialized = serializePublicEvent(event) as unknown as Record<string, unknown>;
		expect(Object.keys(serialized).sort()).toEqual([...PUBLIC_BEACH_EVENT_FIELDS].sort());
		for (const forbidden of ["sourceFacts", "sourceRevision", "reviewedSourceRevision", "sourceURL", "sourceCalendarURL", "matchMethod", "matchConfidence", "matchRuleId", "matchExplanation", "internalNotes", "attentionFlags", "possibleDuplicateOf", "sourceMissingCount", "sourceChange", "status", "createdAt"]) expect(serialized).not.toHaveProperty(forbidden);
		const first = buildSnapshot([event], new Date("2026-08-01T12:00:00.000Z"));
		const second = buildSnapshot([event], new Date("2026-08-02T12:00:00.000Z"));
		expect(second.revision).toBe(first.revision);
		expect(second.generatedAt).not.toBe(first.generatedAt);
	});

	it("publishes West End under only the existing Dauphin Island destination", () => {
		const base = normalizedEvent(facts({
			providerId: "manual",
			externalId: "west-end-manual",
			title: "West End Beach Cleanup",
			venue: "West End Beach",
			address: "3000 Bienville Boulevard, Dauphin Island, AL 36528",
		}), new Date("2026-08-01T12:00:00.000Z"))!;
		expect(base).toMatchObject({ beachId: "dauphin-island-public-beach", venue: "West End Beach", matchMethod: "exactVenue" });
		const published = { ...base, status: "published" } as BeachEvent;
		const publicEvent = serializePublicEvent(published);
		expect(publicEvent).toMatchObject({ beachId: "dauphin-island-public-beach", venue: "West End Beach" });
		const snapshot = buildSnapshot([published], new Date("2026-08-01T12:00:00.000Z"));
		expect(Object.keys(snapshot.beaches)).toEqual(["dauphin-island-public-beach"]);
		expect(snapshot.beaches).not.toHaveProperty("west-end-beach");
	});

	it("does not expose operational controls when the public endpoint is disabled", async () => {
		const h = memoryEnv();
		const controls = defaultOperationalControl(new Date("2026-08-01T12:00:00.000Z"));
		controls.controls["domains.beachEvents"] = { state: "disabled", operatorReason: "private operator note" };
		h.values.set(CURRENT_KEY, JSON.stringify(controls));
		const response = await handleBeachEventsRequest(new Request("https://example.com/v1/beach-events"), h.env, new Date("2026-08-01T12:05:00.000Z"));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "disabled", generatedAt: "2026-08-01T12:05:00.000Z", beaches: {}, attribution: [] });
	});
});
