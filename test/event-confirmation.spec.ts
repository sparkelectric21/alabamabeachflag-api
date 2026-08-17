import { describe, expect, it, vi } from "vitest";
import { auditConfirmationTransition, confirmationForAbsence, confirmationForObserved, EVENT_CADENCE_POLICIES } from "../src/beachEvents/lifecycle";
import { persistSourceObservation, sanitizeObservationFacts, SOURCE_OBSERVATION_PREFIX, SOURCE_OBSERVATION_RETENTION_SECONDS } from "../src/beachEvents/observations";
import { compareSourceFacts, sourceRevision } from "../src/beachEvents/sourceChanges";
import { confirmProviderUnchanged, EVENT_PREFIX } from "../src/beachEvents/store";
import type { BeachEvent, SourceFacts } from "../src/beachEvents/types";

const fact = (overrides: Partial<SourceFacts> = {}): SourceFacts => ({ providerId: "gulfShoresCity", externalId: "event-1", title: "Beach Cleanup", venue: "Gulf Shores Public Beach", startAt: "2026-09-01T13:00:00Z", endAt: "2026-09-01T15:00:00Z", allDay: false, recurring: false, sourceName: "City", sourceURL: "https://example.gov/event?utm_source=x", ...overrides });
const event = (overrides: Partial<BeachEvent> = {}) => ({ id: "one", sourceFacts: fact(), lastSeenAt: "2026-08-01T12:00:00Z", sourceRevision: sourceRevision(fact()), reviewedSourceRevision: "approved-revision", ...overrides }) as BeachEvent;

describe("cadence confirmation policy", () => {
	it("requires both daily check counts and elapsed time", () => {
		const base = event({ confirmation: confirmationForObserved(event(), "gulfShoresCity", new Date("2026-08-01T12:00:00Z")) });
		const first = confirmationForAbsence(base, "gulfShoresCity", new Date("2026-08-02T12:00:00Z"));
		const tooSoon = confirmationForAbsence({ ...base, confirmation: first }, "gulfShoresCity", new Date("2026-08-02T18:00:00Z"));
		expect(tooSoon).toMatchObject({ status: "aging", successfulChecksAbsent: 2 });
		const suspected = confirmationForAbsence({ ...base, confirmation: first }, "gulfShoresCity", new Date("2026-08-03T12:00:00Z"));
		expect(suspected.status).toBe("suspectedMissing");
		const elapsedButFew = confirmationForAbsence(base, "gulfShoresCity", new Date("2026-08-06T12:00:00Z"));
		expect(elapsedButFew).toMatchObject({ status: "aging", successfulChecksAbsent: 1 });
		const removed = confirmationForAbsence({ ...base, confirmation: { ...suspected, successfulChecksAbsent: 2 } }, "gulfShoresCity", new Date("2026-08-05T12:00:00Z"));
		expect(removed.status).toBe("sourceRemoved");
	});

	it("supports weekly thresholds and blocks monthly/manual omission transitions", () => {
		const weeklyEvent = event({ sourceFacts: fact({ providerId: "weeklyProvider" }), confirmation: { status: "confirmed", reason: "seed", policyId: EVENT_CADENCE_POLICIES.weekly.id, lastConfirmedAt: "2026-08-01T12:00:00Z", successfulChecksAbsent: 0 } });
		expect(EVENT_CADENCE_POLICIES.weekly).toMatchObject({ suspectedChecks: 2, suspectedElapsedMs: 604800000, removedElapsedMs: 1209600000 });
		const weeklyFirst = confirmationForAbsence(weeklyEvent, "weeklyProvider", new Date("2026-08-02T12:00:00Z"), EVENT_CADENCE_POLICIES.weekly);
		const weeklySuspected = confirmationForAbsence({ ...weeklyEvent, confirmation: weeklyFirst }, "weeklyProvider", new Date("2026-08-09T12:00:00Z"), EVENT_CADENCE_POLICIES.weekly);
		expect(weeklySuspected.status).toBe("suspectedMissing");
		const weeklyRemoved = confirmationForAbsence({ ...weeklyEvent, confirmation: weeklySuspected }, "weeklyProvider", new Date("2026-08-16T12:00:00Z"), EVENT_CADENCE_POLICIES.weekly);
		expect(weeklyRemoved.status).toBe("sourceRemoved");
		const monthly = confirmationForAbsence(event({ sourceFacts: fact({ providerId: "dauphinIslandTown" }) }), "dauphinIslandTown", new Date("2026-09-01T12:00:00Z"));
		expect(monthly).toMatchObject({ status: "confirmed", successfulChecksAbsent: 0, reason: "omission_not_actionable_for_provider_cadence" });
		const manual = confirmationForAbsence(event({ sourceFacts: fact({ providerId: "manual" }) }), "manual", new Date("2026-09-01T12:00:00Z"));
		expect(manual.status).toBe("manualReviewDue");
		expect(weeklyEvent.confirmation?.policyId).toBe("weekly-v1");
	});

	it.each(["partial", "failed", "qualityRejected", "confirmedUnchanged"] as const)("read-only audit does not treat %s as absence evidence", (outcome) => {
		const record = event(); const before = JSON.stringify(record);
		const audit = auditConfirmationTransition(record, outcome, new Date("2026-08-05T12:00:00Z"), outcome === "failed" ? "unavailable" : "degraded");
		expect(audit).toMatchObject({ qualifyingCompleteObservation: false, automatedTransitionAllowed: false, proposedState: "confirmed" });
		expect(JSON.stringify(record)).toBe(before);
	});

	it("records an HTTP 304 confirmation without restoring or advancing an absence lifecycle", async () => {
		const prior = event({ confirmation: { status: "suspectedMissing", reason: "complete_observation_absent", policyId: "daily-structured-v1", lastConfirmedAt: "2026-08-01T12:00:00Z", firstAbsentAt: "2026-08-02T12:00:00Z", successfulChecksAbsent: 2 } });
		const values = new Map<string, string>([[`${EVENT_PREFIX}${prior.id}`, JSON.stringify(prior)]]);
		const kv = {
			get: vi.fn(async (key: string) => values.has(key) ? JSON.parse(values.get(key)!) : null),
			put: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
			list: vi.fn(async ({ prefix }: { prefix: string }) => ({ keys: [...values.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })) })),
		};
		expect(await confirmProviderUnchanged({ BEACH_DATA: kv } as any, "gulfShoresCity", new Date("2026-08-04T12:00:00Z"))).toBe(1);
		const stored = JSON.parse(values.get(`${EVENT_PREFIX}${prior.id}`)!);
		expect(stored.confirmation).toMatchObject({ status: "suspectedMissing", successfulChecksAbsent: 2, firstAbsentAt: "2026-08-02T12:00:00Z", observationCompleteness: "confirmedUnchanged", reason: "http_304_confirmed_unchanged_no_absence_evidence" });
	});
});

describe("immutable bounded source observations", () => {
	it("suppresses duplicate revisions, bounds facts, and preserves approved revision separately", async () => {
		const values = new Map<string, string>();
		const kv = { get: vi.fn(async (key: string) => values.has(key) ? JSON.parse(values.get(key)!) : null), put: vi.fn(async (key: string, value: string) => { values.set(key, value); }), list: vi.fn() };
		const input = { providerId: "gulfShoresCity", observedAt: "2026-08-01T12:00:00Z", sourceRevision: "source-revision", facts: fact({ title: `Title\n${"x".repeat(300)}`, description: "private description must not persist" }), completeness: "complete" as const, confirmationOutcome: "confirmed", severity: "material" as const, materialFields: ["title"], cosmeticFields: [], sourceReference: "https://example.gov/event", approvedRevision: "approved-revision" };
		expect((await persistSourceObservation({ BEACH_DATA: kv } as any, input)).created).toBe(true);
		expect((await persistSourceObservation({ BEACH_DATA: kv } as any, { ...input, observedAt: "2026-08-02T12:00:00Z" })).created).toBe(false);
		expect(kv.put).toHaveBeenCalledTimes(1);
		expect(kv.put).toHaveBeenCalledWith(expect.stringContaining(SOURCE_OBSERVATION_PREFIX), expect.any(String), { expirationTtl: SOURCE_OBSERVATION_RETENTION_SECONDS });
		const stored = JSON.parse([...values.values()][0]);
		expect(stored).toMatchObject({ version: 2, sourceRevision: "source-revision", approvedRevision: "approved-revision", facts: { externalId: expect.stringMatching(/^[a-f0-9]{32}$/) } });
		expect(stored.facts.title.length).toBeLessThanOrEqual(180);
		expect(JSON.stringify(stored)).not.toContain("private description");
		expect(sanitizeObservationFacts(input.facts)).not.toHaveProperty("description");
	});
});

describe("semantic source severity", () => {
	it("classifies cosmetic tracking/title formatting and meaningful changes deterministically", () => {
		expect(compareSourceFacts(fact(), fact({ title: "The Beach Cleanup!", sourceURL: "https://example.gov/event?utm_campaign=y" }))).toMatchObject({ severity: "cosmetic", materialFields: [] });
		expect(compareSourceFacts(fact(), fact({ title: "Beach Concert" }))).toMatchObject({ severity: "material", materialFields: ["title"] });
		expect(compareSourceFacts(fact(), fact({ startAt: "2026-09-01T14:00:00Z" }))).toMatchObject({ severity: "material", explanations: expect.arrayContaining(["Semantic schedule change"]) });
		expect(compareSourceFacts(fact({ description: "Join us for fun" }), fact({ description: "Parking closed; registration required" }))).toMatchObject({ severity: "material", materialFields: ["description"] });
		expect(compareSourceFacts(fact(), fact({ sourceStatus: "cancelled" }))).toMatchObject({ severity: "critical" });
	});
});
