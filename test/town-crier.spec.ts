import { describe, expect, it, vi } from "vitest";
import { discoverNewestTownCrier, extractTownCrierEvents, fetchTownCrierFacts, TOWN_CRIER_SOURCE_NOTE, townCrierFacts } from "../src/beachEvents/townCrier";
import { BEACH_EVENT_PROVIDERS } from "../src/beachEvents/providers";

const provider = BEACH_EVENT_PROVIDERS.find((item) => item.id === "dauphinIslandTown")!;
const issue = {
	month: "July 2026",
	monthNumber: 7,
	year: 2026,
	pdfURL: "https://www.townofdauphinisland.org/_files/ugd/222868_latest.pdf",
};

describe("Town Crier newsletter discovery", () => {
	it("selects the newest official Town PDF without relying on document order", () => {
		const html = `
			<a href="/_files/ugd/222868_old.pdf">June 2026</a>
			<a href="https://example.com/not-official.pdf">August 2026</a>
			<a href="/_files/ugd/222868_latest.pdf">July 2026</a>`;
		expect(discoverNewestTownCrier(html)).toEqual(issue);
	});

	it("fails closed when no official issue link exists", () => {
		expect(() => discoverNewestTownCrier('<a href="https://example.com/a.pdf">July 2026</a>')).toThrow("town_crier_issue_not_found");
	});
});

describe("Town Crier event extraction", () => {
	const markdown = `
		CALENDAR OF EVENTS
		JULY 30 Family Movie Night
		JULY 30 Family Movie Night
		JULY 31 Family Movie Night
		AUG 1 Summer Splash Event 12pm-4pm
		AUG 8 Island Luau 6pm-9pm
		SEPT 19 Coastal Cleanup
		General office hours are Monday through Friday.
		Beach Movies Return! Free Family Movie Nights are held at East End Beach beginning at dusk.
		Back to School Summer Splash! The event will be held at Water Tower Plaza from 12pm-4pm.
		Let's Luau! The Island Luau is at the DI Community Center from 6pm-9pm. Call (251) 861-5525.
		Coastal Cleanup volunteers should confirm the meeting location in the newsletter.
	`;

	it("normalizes, sorts, deduplicates, and preserves missing fields", () => {
		const events = extractTownCrierEvents(markdown, issue, new Date("2026-07-29T18:00:00Z"));
		expect(events.map((event) => `${event.date}:${event.name}`)).toEqual([
			"2026-07-30:Family Movie Night",
			"2026-07-31:Family Movie Night",
			"2026-08-01:Summer Splash Event",
			"2026-08-08:Island Luau",
			"2026-09-19:Coastal Cleanup",
		]);
		expect(events[0]).toMatchObject({ location: "East End Beach", sourceNewsletterMonth: "July 2026", sourcePDFURL: issue.pdfURL });
		expect(events[2]).toMatchObject({ startTime: "12pm", endTime: "4pm", location: "Water Tower Plaza" });
		expect(events[3].contact).toContain("(251) 861-5525");
		expect(events[4].startTime).toBeUndefined();
		expect(events[4].location).toBeUndefined();
	});

	it("retains valid multi-day ranges and rejects impossible dates", () => {
		const events = extractTownCrierEvents("JULY 16-19 Fishing Rodeo\nFEB 31 Impossible Event", issue, new Date("2026-07-01T00:00:00Z"));
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ date: "2026-07-16", endDate: "2026-07-19" });
		const facts = townCrierFacts(events, provider);
		expect(Date.parse(facts[0].endAt)).toBe(Date.parse("2026-07-20T05:00:00.000Z"));
	});

	it("excludes passed dates and non-event prose", () => {
		const events = extractTownCrierEvents(markdown, issue, new Date("2026-08-02T05:01:00Z"));
		expect(events.map((event) => event.name)).toEqual(["Island Luau", "Coastal Cleanup"]);
		expect(events.some((event) => event.name.includes("office"))).toBe(false);
	});

	it("converts extracted facts without inventing an unavailable end time", () => {
		const facts = townCrierFacts([{
			name: "Family Movie Night", date: "2026-07-30", startTime: "7pm", location: "East End Beach",
			description: "The Town Crier lists this movie screening.", sourceNewsletterMonth: issue.month, sourcePDFURL: issue.pdfURL,
		}], provider);
		expect(facts[0]).toMatchObject({
			venue: "East End Beach",
			sourceNote: TOWN_CRIER_SOURCE_NOTE,
			sourceNewsletterMonth: "July 2026",
			endTimeUnavailable: true,
			allDay: false,
		});
		expect(Date.parse(facts[0].endAt) - Date.parse(facts[0].startAt)).toBe(60_000);
	});
});

describe("Town Crier retrieval", () => {
	it("discovers, converts, and links the current issue", async () => {
		const fetcher = vi.fn()
			.mockResolvedValueOnce(new Response(`<a href="${issue.pdfURL}">July 2026</a>`, { headers: { "Content-Type": "text/html" } }))
			.mockResolvedValueOnce(new Response(new Uint8Array([37, 80, 68, 70]), { headers: { "Content-Type": "application/pdf" } }));
		const AI = { toMarkdown: vi.fn().mockResolvedValue({ format: "markdown", data: "JULY 30 Family Movie Night\nFamily Movie Night is held at East End Beach." }) };
		const facts = await fetchTownCrierFacts({ AI } as any, provider, new Date("2026-07-29T18:00:00Z"), fetcher);
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(AI.toMarkdown).toHaveBeenCalledOnce();
		expect(facts[0]).toMatchObject({ title: "Family Movie Night", venue: "East End Beach", sourceURL: issue.pdfURL });
	});

	it("reports conversion failure so refresh can retain last-good records", async () => {
		const fetcher = vi.fn()
			.mockResolvedValueOnce(new Response(`<a href="${issue.pdfURL}">July 2026</a>`))
			.mockResolvedValueOnce(new Response(new Uint8Array([37, 80, 68, 70])));
		const AI = { toMarkdown: vi.fn().mockResolvedValue({ format: "error", error: "OCR unavailable" }) };
		await expect(fetchTownCrierFacts({ AI } as any, provider, new Date(), fetcher)).rejects.toThrow("town_crier_pdf_conversion_failed");
	});

	it("rejects a non-PDF response before document conversion", async () => {
		const fetcher = vi.fn()
			.mockResolvedValueOnce(new Response(`<a href="${issue.pdfURL}">July 2026</a>`))
			.mockResolvedValueOnce(new Response("<html>upstream error</html>"));
		const AI = { toMarkdown: vi.fn() };
		await expect(fetchTownCrierFacts({ AI } as any, provider, new Date(), fetcher)).rejects.toThrow("town_crier_invalid_pdf");
		expect(AI.toMarkdown).not.toHaveBeenCalled();
	});
});
