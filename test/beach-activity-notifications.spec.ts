import { describe, expect, it, vi } from "vitest";
import {
	BEACH_ACTIVITY_NOTIFICATION_CONFIG_KEY,
	buildReviewQueue,
	defaultBeachActivityNotificationConfig,
	evaluateBeachActivityNotifications,
	formatBeachActivityReviewEmail,
	isBeachActivityReminderTime,
	updateBeachActivityNotificationConfig,
} from "../src/beachEvents/notifications";
import { EVENT_PREFIX } from "../src/beachEvents/store";
import { CURRENT_KEY, defaultOperationalControl } from "../src/operationalControl/store";
import type { BeachEvent } from "../src/beachEvents/types";
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
		VERIFICATION_ALERT_EMAIL: { send },
		BEACH_ACTIVITY_NOTIFICATIONS_ENABLED: "true",
		BEACH_ACTIVITY_NOTIFICATION_RECIPIENTS: "operations@alabamabeachflag.com",
	} as unknown as Env;
	return { env, values, send, kv };
}

describe("beach activity review notifications", () => {
	it("stays quiet for an empty queue", async () => {
		const h = harness();
		const result = await evaluateBeachActivityNotifications(h.env, new Date("2026-07-29T12:00:00Z"));
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

	it("sends immediately for a changed queue and suppresses an identical queue", async () => {
		const h = harness([event("one")]);
		expect((await evaluateBeachActivityNotifications(h.env, new Date("2026-07-29T12:00:00Z"))).outcome).toBe("sent");
		expect((await evaluateBeachActivityNotifications(h.env, new Date("2026-07-29T12:05:00Z"))).outcome).toBe("duplicate");
		expect(h.send).toHaveBeenCalledTimes(1);
		expect([...h.values.values()].some((value) => value.includes("notification_suppressed_duplicate"))).toBe(true);
	});

	it("sends again after a material event revision change", async () => {
		const h = harness([event("one")]);
		await evaluateBeachActivityNotifications(h.env, new Date("2026-07-29T12:00:00Z"));
		h.values.set(`${EVENT_PREFIX}one`, JSON.stringify(event("one", { updatedAt: "2026-07-29T12:10:00.000Z", venue: "Updated exact venue" })));
		expect((await evaluateBeachActivityNotifications(h.env, new Date("2026-07-29T12:15:00Z"))).outcome).toBe("sent");
		expect(h.send).toHaveBeenCalledTimes(2);
	});

	it("sends one morning reminder on the next Central day and suppresses a same-morning duplicate", async () => {
		const h = harness([event("one")]);
		await evaluateBeachActivityNotifications(h.env, new Date("2026-07-29T12:00:00Z"));
		expect((await evaluateBeachActivityNotifications(h.env, new Date("2026-07-29T12:15:00Z"), { kind: "reminder" })).outcome).toBe("duplicate");
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
		expect((await evaluateBeachActivityNotifications(disabled.env)).outcome).toBe("disabled");
		const domain = harness([event("one")]);
		const domainControl = defaultOperationalControl();
		domainControl.controls["domains.beachEvents"] = { state: "disabled" };
		domain.values.set(CURRENT_KEY, JSON.stringify(domainControl));
		expect((await evaluateBeachActivityNotifications(domain.env)).outcome).toBe("disabled");
		const monitored = harness([event("one")]);
		const monitorControl = defaultOperationalControl();
		monitorControl.controls["notifications.beachActivity"] = { state: "monitorOnly" };
		monitored.values.set(CURRENT_KEY, JSON.stringify(monitorControl));
		expect((await evaluateBeachActivityNotifications(monitored.env)).outcome).toBe("monitorOnly");
		expect(disabled.send).not.toHaveBeenCalled();
		expect(domain.send).not.toHaveBeenCalled();
		expect(monitored.send).not.toHaveBeenCalled();
	});

	it("supports authenticated manual and test sends without changing event status", async () => {
		const h = harness([event("one")]);
		expect((await evaluateBeachActivityNotifications(h.env, new Date(), { kind: "manual", identity: { method: "access", subject: "admin@example.com" } })).outcome).toBe("sent");
		expect((await evaluateBeachActivityNotifications(h.env, new Date(), { kind: "test", identity: { method: "access", subject: "admin@example.com" } })).outcome).toBe("sent");
		expect(JSON.parse(h.values.get(`${EVENT_PREFIX}one`)!)).toMatchObject({ status: "pendingReview" });
		expect(h.send).toHaveBeenCalledTimes(2);
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
		expect((await evaluateBeachActivityNotifications(recovered.env)).outcome).toBe("sent");
		expect(recovered.send).toHaveBeenCalledTimes(2);
		expect([...recovered.values.values()].some((value) => value.includes("notification_retry"))).toBe(true);
		const failed = harness([event("one")]);
		failed.send.mockRejectedValue(new Error("provider unavailable"));
		const result = await evaluateBeachActivityNotifications(failed.env);
		expect(result.outcome).toBe("failed");
		expect(result.state.lastProviderError).toBe("provider unavailable");
		expect(failed.send).toHaveBeenCalledTimes(2);
	});
});
