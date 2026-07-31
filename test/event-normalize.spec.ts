import { describe, expect, it } from "vitest";
import { decodeHTMLEntities, normalizeDescription, resolveOfficialEventURL, sanitizeEventURL } from "../src/beachEvents/normalize";
import { buildSnapshot, normalizedEvent } from "../src/beachEvents/store";

const facts = (description: string) => ({ providerId: "gulfStatePark", externalId: "pier-1", title: "Guided Pier Walk", venue: "Gulf State Park Pier", startAt: "2026-07-31T14:00:00.000Z", endAt: "2026-07-31T15:00:00.000Z", allDay: false, recurring: false, sourceName: "Gulf State Park", sourceURL: "https://example.gov/calendar.ics", description });

describe("event public normalization", () => {
	it("decodes entities and preserves paragraphs and lists", () => {
		expect(decodeHTMLEntities("Pier &amp; beach &#8212; walk")).toBe("Pier & beach — walk");
		const result = normalizeDescription("<p>Meet a naturalist &amp; explore the pier.</p><ul><li>All ages</li><li>Wear shoes</li></ul>");
		expect(result.fullDescription).toBe("Meet a naturalist & explore the pier.\n\n• All ages\n• Wear shoes");
		expect(result.summary).toContain("Meet a naturalist");
	});

	it("drops hidden and malformed provider markup and removes visible URLs", () => {
		const result = normalizeDescription("<style>.x{}</style><p>Join the guided naturalist walk<script>alert(1)</script><br>Details https://tracker.test/x<p><span hidden>secret</span>");
		expect(result.fullDescription).toBe("Join the guided naturalist walk\nDetails");
		expect(result.fullDescription).not.toMatch(/[<>]|https?:/);
	});

	it("handles encoded markup, relative links, duplicate paragraphs, and ordinary angle brackets", () => {
		const result = normalizeDescription('&lt;p&gt;Explore marine life.&lt;/p&gt;<p>Explore marine life.</p><a href="/events/pier?id=7&utm_medium=email">Details</a><p>Children age 8+ compare 3 < 5 shells.</p>', [], "https://www.alapark.com/parks/gulf-state-park/");
		expect(result.fullDescription).toContain("Explore marine life.");
		expect(result.fullDescription?.match(/Explore marine life\./g)).toHaveLength(1);
		expect(result.fullDescription).toContain("3 < 5 shells");
		expect(result.extractedURLs).toEqual(["https://www.alapark.com/events/pier?id=7"]);
	});

	it("extracts registration links and rejects feeds, unsafe URLs, and trackers", () => {
		const result = normalizeDescription('<p>Reserve a place.</p><a href="https://park.gov/register?id=42&utm_source=x">Register</a>');
		expect(result.extractedURLs).toEqual(["https://park.gov/register?id=42"]);
		expect(sanitizeEventURL("javascript:alert(1)")).toBeUndefined();
		expect(sanitizeEventURL("https://park.gov/events.ics")).toBeUndefined();
		expect(resolveOfficialEventURL({ officialURL: "https://park.gov/events/pier-walk" })).toBe("https://park.gov/events/pier-walk");
	});

	it("unwraps safe Google redirect destinations without losing registration parameters", () => {
		expect(sanitizeEventURL("https://www.google.com/url?q=https://reserve.alapark.com/register/guided-pier-walk-GSP%3Fsession%3D42%26group%3Dfamily&sa=D"))
			.toBe("https://reserve.alapark.com/register/guided-pier-walk-GSP?session=42&group=family");
		expect(sanitizeEventURL("https://www.google.com/url?url=https%3A%2F%2Freserve.alapark.com%2Fregister%2Fguided-pier-walk%3Fid%3D7"))
			.toBe("https://reserve.alapark.com/register/guided-pier-walk?id=7");
		expect(sanitizeEventURL("https://www.google.com/url?q=http%3A%2F%2Funsafe.test%2Fregister")).toBeUndefined();
		expect(sanitizeEventURL("https://www.google.com/url?sa=D")).toBeUndefined();
		expect(sanitizeEventURL("https://www.google.com/url?q=https%3A%2F%2Fpark.gov%2Fevents.ics")).toBeUndefined();
		expect(sanitizeEventURL("https://www.google.com/url?q=https%3A%2F%2Fwww.google.com%2Furl%3Fq%3Dhttps%253A%252F%252Fpark.gov%252Fevent")).toBeUndefined();
	});

	it("removes only narrowly repeated summary labels", () => {
		const result = normalizeDescription("Registration: Registration is preferred but not required.\nLocation: Location: Gulf State Park Pier.\nParking: Parking: Use the pier lot.\nContact: Contact: Call the park office.");
		expect(result.fullDescription).toBe("Registration is preferred but not required.\nLocation: Gulf State Park Pier.\nParking: Use the pier lot.\nContact: Call the park office.");
		expect(result.summary).toContain("Registration is preferred but not required.");
	});

	it("uses the verified Orange Beach organizer fallback without exposing its calendar feeds", () => {
		for (const providerId of ["orangeBeachParks", "orangeBeachCoastalResources"]) {
			const event = normalizedEvent({ ...facts("Official city event."), providerId }, new Date("2026-07-30T12:00:00Z"), { beachId: "alabama-point", ruleId: "test", explanation: "test" })!;
			expect(event.organizerWebsiteURL).toBe("https://www.orangebeachal.gov/");
			expect(event.officialEventsPageURL).toBeUndefined();
		}
	});

	it("publishes sanitized fields without raw source or review data", () => {
		const event = normalizedEvent(facts("<p>A guided naturalist walk along the pier.</p>"), new Date("2026-07-30T12:00:00Z"), { beachId: "gulf-state-park-pavilion", ruleId: "test", explanation: "test" })!;
		const snapshot = buildSnapshot([{ ...event, status: "published", internalNotes: "private" }], new Date("2026-07-30T12:00:00Z"));
		const published = snapshot.beaches["gulf-state-park-pavilion"][0] as unknown as Record<string, unknown>;
		expect(published.eventDescription).toBe("A guided naturalist walk along the pier.");
		expect(published).not.toHaveProperty("sourceFacts");
		expect(published).not.toHaveProperty("internalNotes");
		expect(published).not.toHaveProperty("status");
		expect(published).not.toHaveProperty("sourceCalendarURL");
		expect(published).not.toHaveProperty("sourceURL");
	});

	it("uses a verified provider events page without exposing the Gulf State Park calendar feed", () => {
		const event = normalizedEvent({ ...facts("<p>Meet a naturalist and explore the pier.</p>"), sourceURL: "https://calendar.google.com/calendar/ical/public/basic.ics" }, new Date("2026-07-30T12:00:00Z"), { beachId: "gulf-state-park-pavilion", ruleId: "test", explanation: "test" })!;
		expect(event.officialEventsPageURL).toBe("https://www.alapark.com/parks/gulf-state-park/activities-calendar");
		const published = buildSnapshot([{ ...event, status: "published" }], new Date("2026-07-30T12:00:00Z")).beaches[event.beachId][0] as unknown as Record<string, unknown>;
		expect(published.officialEventsPageURL).toBe(event.officialEventsPageURL);
		expect(JSON.stringify(published)).not.toContain("calendar.google.com");
	});
});
