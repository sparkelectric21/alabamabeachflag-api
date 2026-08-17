import { describe, expect, it, vi } from "vitest";
import {
	BEACH_ACTIVITY_NOTIFICATION_CONFIG_KEY,
	BEACH_ACTIVITY_NOTIFICATION_STATE_KEY,
	buildReviewQueue,
	defaultBeachActivityNotificationConfig,
	evaluateBeachActivityNotifications,
	formatBeachActivityReviewEmail,
	isBeachActivityReminderTime,
	updateBeachActivityNotificationConfig,
} from "../src/beachEvents/notifications";
import { EVENT_PREFIX, EXCLUSION_PREFIX } from "../src/beachEvents/store";
import { CURRENT_KEY, defaultOperationalControl } from "../src/operationalControl/store";
import { BEACH_EVENT_REFRESH_STATUS_KEY, type BeachEvent } from "../src/beachEvents/types";
import type { Env } from "../src/types";

function event(id: string, overrides: Partial<BeachEvent> = {}): BeachEvent {
	return {
		id,
		beachId: "gulf-state-park-pavilion",
		title: `Event ${id}`,
		venue: "Beach Pavilion",
		startAt: "2026-08-01T13:00:00.000Z",
		endAt: "2026-08-01T15:00:00.000Z",
		allDay: false,
		recurring: false,
		eventType: "beachCleanup",
		impactLevel: "informational",
		bannerTitle: "Beach cleanup here today",
		bannerMessage: "An activity is scheduled.",
		parkingImpact: false,
		trafficImpact: false,
		accessImpact: false,
		showCompareNearbyBeaches: false,
		status: "pendingReview",
		sourceName: "Gulf State Park",
		sourceURL: "https://example.gov/event",
		matchMethod: "exactVenue",
		matchConfidence: "exact",
		sourceFacts: {
			providerId: "gulfStatePark",
			externalId: id,
			title: `Event ${id}`,
			venue: "Beach Pavilion",
			startAt: "2026-08-01T13:00:00.000Z",
			endAt: "2026-08-01T15:00:00.000Z",
			allDay: false,
			recurring: false,
			sourceName: "Gulf State Park",
			sourceURL: "https://example.gov/event",
		},
		sourceRevision: `revision-${id}`,
		lastSeenAt: "2026-07-29T12:00:00.000Z",
		createdAt: "2026-07-29T12:00:00.000Z",
		updatedAt: "2026-07-29T12:00:00.000Z",
		...overrides,
	};
}

function harness(events: BeachEvent[] = []) {
	const values = new Map<string, string>(events.map((item) => [`${EVENT_PREFIX}${item.id}`, JSON.stringify(item)]));
	const send = vi.fn(async () => undefined);
	const kv = {
		get: vi.fn(async (key: string, type?: string) => {
			const value = values.get(key);
			return value === undefined ? null : type === "json" ? JSON.parse(value) : value;
		}),
		put: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
		delete: vi.fn(async (key: string) => { values.delete(key); }),
		list: vi.fn(async ({ prefix }: { prefix: string }) => ({ keys: [...values.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })), list_complete: true })),
	};
	const env = {
		BEACH_DATA: kv,
		VERIFICATION_ALERT_ENVIRONMENT: "production",
		HISTORICAL_DATA_ENVIRONMENT: "production",
		VERIFICATION_ALERT_EMAIL: { send },
		BEACH_ACTIVITY_NOTIFICATIONS_ENABLED: "true",
		BEACH_ACTIVITY_NOTIFICATION_RECIPIENTS: "operations@alabamabeachflag.com",
	} as unknown as Env;
	return { env, values, send, kv };
}

describe("beach activity review notifications", () => {
	it("stays quiet for an empty queue", async () => {
		const h = harness();
		const result = await evaluateBeachActivityNotifications(h.env, new Date("2026-07-29T12:15:00Z"), { kind: "reminder" });
		expect(result.outcome).toBe("empty");
		expect(h.send).not.toHaveBeenCalled();
	});

	it("stays quiet when stored events are published and need no attention", async () => {
		const h = harness([event("published", { status: "published" })]);
		const result = await evaluateBeachActivityNotifications(h.env, new Date("2026-07-29T12:15:00Z"), { kind: "reminder" });
		expect(result.outcome).toBe("empty");
		expect(h.send).not.toHaveBeenCalled();
	});

	it("renders one and multiple events with high-impact items first", () => {
		const queue = buildReviewQueue([event("info"), event("major", { impactLevel: "major", title: "Major Event" })]);
		expect(queue.events.map((item) => item.id)).toEqual(["major", "info"]);
		expect(queue).toMatchObject({ pendingCount: 2, highImpactCount: 1, informationalCount: 1 });
		const message = formatBeachActivityReviewEmail(queue, "manual");
		expect(message.subject).toContain("2 events awaiting review");
		expect(message.text.indexOf("Major Event")).toBeLessThan(message.text.indexOf("Event info"));
		expect(message.html).toContain("High-priority review needed");
		expect(message.html).toContain("Review Events");
		expect(message.html).toContain("Provider Health");
		expect(message.html).toContain("Operational Control");
	});

	it("does not send the daily summary outside the configured morning window", async () => {
		const h = harness([event("one")]);
		expect((await evaluateBeachActivityNotifications(h.env, new Date("2026-07-29T12:00:00Z"), { kind: "reminder" })).outcome).toBeNull();
		expect(h.send).not.toHaveBeenCalled();
	});

	it("sends at most once per Central morning even when the queue changes", async () => {
		const h = harness([event("one")]);
		expect((await evaluateBeachActivityNotifications(h.env, new Date("2026-07-29T12:15:00Z"), { kind: "reminder" })).outcome).toBe("sent");
		h.values.set(`${EVENT_PREFIX}one`, JSON.stringify(event("one", { updatedAt: "2026-07-29T12:10:00.000Z", venue: "Updated exact venue" })));
		h.values.set(`${EVENT_PREFIX}two`, JSON.stringify(event("two")));
		expect((await evaluateBeachActivityNotifications(h.env, new Date("2026-07-29T12:15:30Z"), { kind: "reminder" })).outcome).toBe("duplicate");
		expect(h.send).toHaveBeenCalledTimes(1);
	});

	it("alerts for duplicate and provider-failure issues once until the issue meaning changes", async () => {
		const h = harness();
		h.values.set(`${EXCLUSION_PREFIX}candidate`, JSON.stringify({
			id: "candidate", providerId: "orangeBeachParks", title: "Beach Program", venue: "Cotton Bayou Public Beach",
			startAt: "2026-08-01T13:00:00.000Z", endAt: "2026-08-01T14:00:00.000Z", sourceName: "City of Orange Beach",
			sourceURL: "https://example.gov/event", reason: "duplicate", reasonDetail: "Possible duplicate", matchConfidence: "possible",
			possibleDuplicateOf: "existing", ruleId: "cross-provider-deduplication", decision: "automatic", sourceFacts: event("source").sourceFacts,
			firstSeenAt: "2026-07-29T12:00:00.000Z", lastSeenAt: "2026-07-29T12:00:00.000Z",
		}));
		const refresh = (lastAttempt: string, error = "HTTP 503") => ({
			schemaVersion: 1, status: "warning", trigger: "scheduled", lastAttempt, nextScheduledRefresh: lastAttempt,
			scheduleDescription: "Daily", operationalState: "enabled", counts: { raw: 0, matched: 0, excluded: 0, pendingReview: 0, published: 0, ruleSuppressed: 0, unsupportedOrAmbiguous: 0 },
			providers: [{ providerId: "gulfStatePark", status: "failed", fetched: 0, matched: 0, excluded: 0, pendingReview: 0, published: 0, ruleSuppressed: 0, unsupportedOrAmbiguous: 0, freshness: "stale", lastAttempt, error }],
		});
		h.values.set(BEACH_EVENT_REFRESH_STATUS_KEY, JSON.stringify(refresh("2026-07-29T12:00:00.000Z")));
		const first = await evaluateBeachActivityNotifications(h.env, new Date("2026-07-29T12:15:00Z"), { kind: "reminder" });
		expect(first).toMatchObject({ outcome: "sent", queue: { pendingCount: 2, possibleDuplicateCount: 1, providerFailureCount: 1 } });
		h.values.set(BEACH_EVENT_REFRESH_STATUS_KEY, JSON.stringify(refresh("2026-07-29T13:00:00.000Z")));
		expect((await evaluateBeachActivityNotifications(h.env, new Date("2026-07-29T12:15:30Z"), { kind: "reminder" })).outcome).toBe("duplicate");
		h.values.set(BEACH_EVENT_REFRESH_STATUS_KEY, JSON.stringify(refresh("2026-07-29T14:00:00.000Z", "HTTP 500")));
		expect((await evaluateBeachActivityNotifications(h.env, new Date("2026-07-29T12:15:45Z"), { kind: "reminder" })).outcome).toBe("duplicate");
		expect(h.send).toHaveBeenCalledTimes(1);
	});

	it("deduplicates an unchanged actionable set and sends again on the next Central morning", async () => {
		const h = harness([event("one")]);
		expect((await evaluateBeachActivityNotifications(h.env, new Date("2026-07-29T12:15:00Z"), { kind: "reminder" })).outcome).toBe("sent");
		expect((await evaluateBeachActivityNotifications(h.env, new Date("2026-07-29T12:15:30Z"), { kind: "reminder" })).outcome).toBe("duplicate");
		expect((await evaluateBeachActivityNotifications(h.env, new Date("2026-07-30T12:15:00Z"), { kind: "reminder" })).outcome).toBe("sent");
		expect(h.send).toHaveBeenCalledTimes(2);
	});

	it("handles Central reminder time in daylight and standard time", () => {
		expect(isBeachActivityReminderTime(new Date("2026-07-29T12:15:00Z"), "07:15")).toBe(true);
		expect(isBeachActivityReminderTime(new Date("2026-12-29T13:15:00Z"), "07:15")).toBe(true);
		expect(isBeachActivityReminderTime(new Date("2026-12-29T12:15:00Z"), "07:15")).toBe(false);
	});

	it("respects notification disabled, domain disabled, and monitor-only controls", async () => {
		const disabled = harness([event("one")]);
		disabled.values.set(BEACH_ACTIVITY_NOTIFICATION_CONFIG_KEY, JSON.stringify({ ...defaultBeachActivityNotificationConfig(disabled.env), enabled: false }));
		expect((await evaluateBeachActivityNotifications(disabled.env, new Date("2026-07-29T12:15:00Z"), { kind: "reminder" })).outcome).toBe("disabled");
		const domain = harness([event("one")]);
		const domainControl = defaultOperationalControl();
		domainControl.controls["domains.beachEvents"] = { state: "disabled" };
		domain.values.set(CURRENT_KEY, JSON.stringify(domainControl));
		expect((await evaluateBeachActivityNotifications(domain.env, new Date("2026-07-29T12:15:00Z"), { kind: "reminder" })).outcome).toBe("disabled");
		const monitored = harness([event("one")]);
		const monitorControl = defaultOperationalControl();
		monitorControl.controls["notifications.beachActivity"] = { state: "monitorOnly" };
		monitored.values.set(CURRENT_KEY, JSON.stringify(monitorControl));
		expect((await evaluateBeachActivityNotifications(monitored.env, new Date("2026-07-29T12:15:00Z"), { kind: "reminder" })).outcome).toBe("monitorOnly");
		expect(disabled.send).not.toHaveBeenCalled();
		expect(domain.send).not.toHaveBeenCalled();
		expect(monitored.send).not.toHaveBeenCalled();
	});

	it("keeps explicit test sends isolated from events and reminder deduplication state", async () => {
		const h = harness([event("one")]);
		expect((await evaluateBeachActivityNotifications(h.env, new Date("2026-07-29T12:15:00Z"), { kind: "reminder" })).outcome).toBe("sent");
		const priorState = h.values.get(BEACH_ACTIVITY_NOTIFICATION_STATE_KEY);
		const priorEvent = h.values.get(`${EVENT_PREFIX}one`);
		expect((await evaluateBeachActivityNotifications(h.env, new Date(), { kind: "test", identity: { method: "access", subject: "admin@example.com" } })).outcome).toBe("sent");
		expect(h.values.get(BEACH_ACTIVITY_NOTIFICATION_STATE_KEY)).toBe(priorState);
		expect(h.values.get(`${EVENT_PREFIX}one`)).toBe(priorEvent);
		expect(h.send).toHaveBeenCalledTimes(2);
	});

	it("supports an authenticated explicit manual summary without changing event status", async () => {
		const h = harness([event("one")]);
		expect((await evaluateBeachActivityNotifications(h.env, new Date(), { kind: "manual", identity: { method: "access", subject: "admin@example.com" } })).outcome).toBe("sent");
		expect(JSON.parse(h.values.get(`${EVENT_PREFIX}one`)!)).toMatchObject({ status: "pendingReview" });
	});

	it("validates recipient configuration against the Worker allowlist", async () => {
		const h = harness();
		const request = new Request("https://example.com", { method: "PATCH", body: JSON.stringify({ recipients: ["other@example.com"] }) });
		expect((await updateBeachActivityNotificationConfig(request, h.env, { method: "access", subject: "admin@example.com" })).status).toBe(400);
		const valid = new Request("https://example.com", { method: "PATCH", body: JSON.stringify({ recipients: ["operations@alabamabeachflag.com"], reminderTime: "07:30" }) });
		expect((await updateBeachActivityNotificationConfig(valid, h.env, { method: "access", subject: "admin@example.com" })).status).toBe(200);
	});

	it("retries once, records success, and records a terminal provider failure", async () => {
		const recovered = harness([event("one")]);
		recovered.send.mockRejectedValueOnce(new Error("temporary")).mockResolvedValueOnce(undefined);
		expect((await evaluateBeachActivityNotifications(recovered.env, new Date(), { kind: "manual" })).outcome).toBe("sent");
		expect(recovered.send).toHaveBeenCalledTimes(2);
		expect([...recovered.values.values()].some((value) => value.includes("notification_retry"))).toBe(true);
		const failed = harness([event("one")]);
		failed.send.mockRejectedValue(new Error("provider unavailable"));
		const result = await evaluateBeachActivityNotifications(failed.env, new Date(), { kind: "manual" });
		expect(result.outcome).toBe("failed");
		expect(result.state.lastProviderError).toBe("provider unavailable");
		expect(failed.send).toHaveBeenCalledTimes(2);
	});
});
