import { describe, expect, it } from "vitest";
import { applyDuplicateResolution, assessDuplicate, auditDuplicateCandidates, canonicalEventURL, DUPLICATE_CANDIDATE_LIMIT, DUPLICATE_EVIDENCE_LIMIT, selectDuplicateCandidates } from "../src/beachEvents/duplicates";
import type { BeachEvent } from "../src/beachEvents/types";

const event = (id: string, overrides: Partial<BeachEvent> = {}): BeachEvent => ({ id, beachId: "gulf-shores-public-beach", title: "Freedom Fest", venue: "Gulf Place", startAt: "2026-09-01T18:00:00Z", endAt: "2026-09-01T21:00:00Z", allDay: false, recurring: false, eventType: "festival", impactLevel: "informational", bannerTitle: "Event", bannerMessage: "Event", parkingImpact: false, trafficImpact: false, accessImpact: false, showCompareNearbyBeaches: false, status: "pendingReview", sourceName: "City of Gulf Shores", sourceURL: "https://example.gov/calendar", officialEventURL: "https://example.gov/events/freedom-fest", matchMethod: "exactVenue", matchConfidence: "exact", sourceFacts: { providerId: "city", externalId: id, title: "Freedom Fest", venue: "Gulf Place", startAt: "2026-09-01T18:00:00Z", endAt: "2026-09-01T21:00:00Z", allDay: false, recurring: false, sourceName: "City of Gulf Shores", sourceURL: "https://example.gov/calendar" }, sourceRevision: id, lastSeenAt: "2026-08-01T00:00:00Z", createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", ...overrides });

describe("evidence-based duplicate intelligence", () => {
	it("keeps stable source identity authoritative", () => expect(assessDuplicate(event("a"), event("b", { sourceFacts: { ...event("a").sourceFacts, externalId: "a" } }))).toMatchObject({ classification: "sameSourceRecord" }));
	it("uses canonical URLs and organizer IDs as strong evidence", () => {
		expect(canonicalEventURL("https://EXAMPLE.gov/events/x/?utm_source=test#top")).toBe("https://example.gov/events/x");
		expect(assessDuplicate(event("a"), event("b", { sourceName: "Other official source", sourceFacts: { ...event("b").sourceFacts, providerId: "parks", organizerEventId: "official-42" } }))).toMatchObject({ classification: "strongDuplicate", positiveEvidence: expect.arrayContaining(["Equal canonical official event URL"]) });
		const a = event("a", { officialEventURL: undefined, sourceFacts: { ...event("a").sourceFacts, organizerEventId: "official-42" } });
		const b = event("b", { officialEventURL: undefined, sourceFacts: { ...event("b").sourceFacts, providerId: "parks", organizerEventId: "official-42" } });
		expect(assessDuplicate(a, b).classification).toBe("strongDuplicate");
	});
	it("distinguishes cosmetic/revised titles, generic unrelated organizers, and time tolerance", () => {
		expect(assessDuplicate(event("a"), event("b", { title: "The Freedom Fest!" })).classification).toBe("strongDuplicate");
		const generic = event("b", { title: "Beach Festival", sourceName: "Unrelated Club", officialEventURL: undefined, sourceFacts: { ...event("b").sourceFacts, providerId: "club", sourceName: "Unrelated Club" } });
		expect(assessDuplicate(event("a", { officialEventURL: undefined }), generic).classification).toBe("unrelated");
		expect(assessDuplicate(event("a", { officialEventURL: undefined }), event("b", { officialEventURL: undefined, startAt: "2026-09-01T20:00:00Z", endAt: "2026-09-01T22:00:00Z" })).classification).toBe("likelyDuplicate");
	});
	it("keeps separate dates, recurrence exceptions, and regional umbrellas distinct", () => {
		const secondDay = event("freedom-2", { startAt: "2026-09-02T18:00:00Z", endAt: "2026-09-02T21:00:00Z", sourceFacts: { ...event("x").sourceFacts, externalId: "freedom-2", seriesId: "freedom-fest" } });
		const firstDay = event("freedom-1", { sourceFacts: { ...event("x").sourceFacts, externalId: "freedom-1", seriesId: "freedom-fest" } });
		expect(assessDuplicate(firstDay, secondDay)).toMatchObject({ classification: "distinctOccurrence", proposedRelationship: "relatedOccurrences" });
		expect(assessDuplicate(event("master", { recurring: true }), event("exception", { sourceFacts: { ...event("exception").sourceFacts, recurrenceId: "20260901T180000Z" } })).classification).toBe("distinctOccurrence");
		const umbrella = event("umbrella", { location: { classification: "regional", precisionLabel: "Regional", region: "Alabama coast", evidence: [], conflicts: [], exactAssignmentSupported: false, assignmentOrigin: "source" } });
		const exact = event("zone", { location: { classification: "beachSpecific", precisionLabel: "At this beach", proposedBeachId: "gulf-shores-public-beach", evidence: [], conflicts: [], exactAssignmentSupported: true, assignmentOrigin: "source" } });
		expect(assessDuplicate(umbrella, exact).classification).toBe("distinctOccurrence");
	});
	it("is bounded, deterministic, read-only, and supports reversible idempotent decisions", () => {
		const records = Array.from({ length: DUPLICATE_CANDIDATE_LIMIT + 5 }, (_, index) => event(String(index)));
		const before = JSON.stringify(records), first = auditDuplicateCandidates(records), second = auditDuplicateCandidates(records);
		expect(first).toEqual(second); expect(first.truncated).toBe(true); expect(JSON.stringify(records)).toBe(before);
		expect(first.candidates.every((item) => item.positiveEvidence.length <= DUPLICATE_EVIDENCE_LIMIT)).toBe(true);
		const resolution = { decision: "keepSeparate" as const, relatedEventId: "b", evidenceRevision: "rev-1", decidedAt: "2026-08-17T00:00:00Z", decidedBy: "operator" };
		const resolved = applyDuplicateResolution(event("a"), resolution); expect(applyDuplicateResolution(resolved, resolution)).toBe(resolved); expect(applyDuplicateResolution(resolved, undefined).duplicateResolution).toBeUndefined();
	});
	it("blocks by relevance before applying caps and reports deterministic omissions", () => {
		const target=event("target",{startAt:"2026-10-01T18:00:00Z",endAt:"2026-10-01T21:00:00Z"}),old=Array.from({length:60},(_,index)=>event(`old-${index}`,{officialEventURL:undefined,startAt:`2025-01-${String(index%28+1).padStart(2,"0")}T18:00:00Z`,endAt:`2025-01-${String(index%28+1).padStart(2,"0")}T20:00:00Z`})),match=event("match",{startAt:target.startAt,endAt:target.endAt});
		const selected=selectDuplicateCandidates(target,[...old,match],1);expect(selected.candidates[0].candidate.id).toBe("match");expect(selected.truncated).toBe(true);expect(selected.omittedCount).toBeGreaterThan(0);expect(selectDuplicateCandidates(target,[...old,match],1)).toEqual(selected);
		const farUrl=event("far-url",{startAt:"2027-10-01T18:00:00Z",endAt:"2027-10-01T21:00:00Z"});expect(selectDuplicateCandidates(target,[farUrl]).eligibleCount).toBe(1);
		const organizer=event("organizer",{title:"Different Words",officialEventURL:undefined,startAt:"2027-11-01T18:00:00Z",endAt:"2027-11-01T21:00:00Z",sourceFacts:{...event("organizer").sourceFacts,organizerEventId:"shared"}}),targetOrganizer=event("target-organizer",{officialEventURL:undefined,sourceFacts:{...target.sourceFacts,organizerEventId:"shared"}});expect(selectDuplicateCandidates(targetOrganizer,[organizer]).eligibleCount).toBe(1);
	});
});
