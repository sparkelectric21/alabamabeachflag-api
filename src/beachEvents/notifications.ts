import type { Env } from "../types";
import type { AdminIdentity } from "../services/admin/auth";
import { beaches } from "../config/BeachRegistry";
import { evaluateBeachActivityNotificationsControl, readOperationalControl } from "../operationalControl/store";
import { processProviderHealthObservations } from "../providerHealth/process";
import { AUDIT_PREFIX, listEvents } from "./store";
import type { BeachEvent } from "./types";

export const BEACH_ACTIVITY_NOTIFICATION_CONFIG_KEY = "beach-events:v1:notification-config";
export const BEACH_ACTIVITY_NOTIFICATION_STATE_KEY = "beach-events:v1:notification-state";
const SENDER = "alerts@alabamabeachflag.com";
const ADMIN_BASE = "https://www.alabamabeachflag.com/admin";

export interface BeachActivityNotificationConfig {
	schemaVersion: 1;
	enabled: boolean;
	dailyReminder: boolean;
	immediateChangeNotification: boolean;
	reminderTime: string;
	recipients: string[];
	updatedAt: string | null;
	updatedBy: string | null;
}

export interface BeachActivityNotificationState {
	schemaVersion: 1;
	lastNotificationAt: string | null;
	lastReminderAt: string | null;
	lastSuccessAt: string | null;
	lastFailureAt: string | null;
	lastProviderError: string | null;
	suppressedDuplicateCount: number;
	lastQueueRevision: string | null;
	lastNotificationRevision: string | null;
	lastEventRevision: string | null;
	lastPendingCount: number;
	lastPendingEventIds: string[];
	lastOutcome: "sent" | "empty" | "duplicate" | "disabled" | "monitorOnly" | "failed" | null;
	lastNotificationKind: "immediate" | "reminder" | "manual" | "test" | null;
}

export interface ReviewQueue {
	events: BeachEvent[];
	revision: string;
	eventRevision: string | null;
	pendingCount: number;
	highImpactCount: number;
	informationalCount: number;
	providers: Array<{ providerId: string; sourceName: string; count: number }>;
}

export interface BeachActivityEmail {
	subject: string;
	text: string;
	html: string;
}

const defaultState = (): BeachActivityNotificationState => ({
	schemaVersion: 1,
	lastNotificationAt: null,
	lastReminderAt: null,
	lastSuccessAt: null,
	lastFailureAt: null,
	lastProviderError: null,
	suppressedDuplicateCount: 0,
	lastQueueRevision: null,
	lastNotificationRevision: null,
	lastEventRevision: null,
	lastPendingCount: 0,
	lastPendingEventIds: [],
	lastOutcome: null,
	lastNotificationKind: null,
});

const csv = (value?: string) => [...new Set((value ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean))];
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const reminderTime = /^(?:0[0-9]|1[0-9]|2[0-3]):(?:00|15|30|45)$/;
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]!);

export function defaultBeachActivityNotificationConfig(env: Pick<Env, "BEACH_ACTIVITY_NOTIFICATIONS_ENABLED" | "BEACH_ACTIVITY_NOTIFICATION_RECIPIENTS">): BeachActivityNotificationConfig {
	return {
		schemaVersion: 1,
		enabled: env.BEACH_ACTIVITY_NOTIFICATIONS_ENABLED !== "false",
		dailyReminder: true,
		immediateChangeNotification: true,
		reminderTime: "07:15",
		recipients: csv(env.BEACH_ACTIVITY_NOTIFICATION_RECIPIENTS),
		updatedAt: null,
		updatedBy: null,
	};
}

export async function readBeachActivityNotificationConfig(env: Pick<Env, "BEACH_DATA" | "BEACH_ACTIVITY_NOTIFICATIONS_ENABLED" | "BEACH_ACTIVITY_NOTIFICATION_RECIPIENTS">): Promise<BeachActivityNotificationConfig> {
	const defaults = defaultBeachActivityNotificationConfig(env);
	const stored = await env.BEACH_DATA.get<Partial<BeachActivityNotificationConfig>>(BEACH_ACTIVITY_NOTIFICATION_CONFIG_KEY, "json");
	if (!stored || stored.schemaVersion !== 1) return defaults;
	const recipients = Array.isArray(stored.recipients) && stored.recipients.every((item) => typeof item === "string" && email.test(item)) ? [...new Set(stored.recipients.map((item) => item.toLowerCase()))] : defaults.recipients;
	return {
		...defaults,
		enabled: typeof stored.enabled === "boolean" ? stored.enabled : defaults.enabled,
		dailyReminder: typeof stored.dailyReminder === "boolean" ? stored.dailyReminder : defaults.dailyReminder,
		immediateChangeNotification: typeof stored.immediateChangeNotification === "boolean" ? stored.immediateChangeNotification : defaults.immediateChangeNotification,
		reminderTime: typeof stored.reminderTime === "string" && reminderTime.test(stored.reminderTime) ? stored.reminderTime : defaults.reminderTime,
		recipients,
		updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : null,
		updatedBy: typeof stored.updatedBy === "string" ? stored.updatedBy : null,
	};
}

export async function readBeachActivityNotificationState(env: Pick<Env, "BEACH_DATA">): Promise<BeachActivityNotificationState> {
	return { ...defaultState(), ...(await env.BEACH_DATA.get<BeachActivityNotificationState>(BEACH_ACTIVITY_NOTIFICATION_STATE_KEY, "json") ?? {}) };
}

function stableHash(value: string): string {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
	return (hash >>> 0).toString(16).padStart(8, "0");
}

export function buildReviewQueue(events: BeachEvent[]): ReviewQueue {
	const pending = events.filter((event) => event.status === "pendingReview").sort((a, b) =>
		(["major", "high"].includes(b.impactLevel) ? 1 : 0) - (["major", "high"].includes(a.impactLevel) ? 1 : 0)
		|| a.startAt.localeCompare(b.startAt)
		|| a.id.localeCompare(b.id));
	const identity = pending.map((event) => `${event.id}|${event.updatedAt}|${event.beachId}|${event.impactLevel}|${event.eventType}|${event.venue}|${event.startAt}|${event.endAt}`).join("\n");
	const grouped = new Map<string, { providerId: string; sourceName: string; count: number }>();
	for (const event of pending) {
		const id = event.sourceFacts.providerId;
		const group = grouped.get(id) ?? { providerId: id, sourceName: event.sourceName, count: 0 };
		group.count += 1;
		grouped.set(id, group);
	}
	return {
		events: pending,
		revision: stableHash(identity),
		eventRevision: pending.map((event) => event.updatedAt).sort().at(-1) ?? null,
		pendingCount: pending.length,
		highImpactCount: pending.filter((event) => ["major", "high"].includes(event.impactLevel)).length,
		informationalCount: pending.filter((event) => event.impactLevel === "informational").length,
		providers: [...grouped.values()].sort((a, b) => a.sourceName.localeCompare(b.sourceName)),
	};
}

const centralDate = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
const centralTime = (date: Date) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
export const isBeachActivityReminderTime = (date: Date, time: string) => centralTime(date) === time;
const sameCentralDay = (value: string | null, now: Date) => Boolean(value && centralDate(new Date(value)) === centralDate(now));

function displayDate(value: string): string {
	return new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function beachName(id: string): string {
	return beaches.find((beach) => beach.id === id)?.displayName ?? id;
}

function confidence(event: BeachEvent): string {
	return event.matchConfidence === "admin" ? "Administrator assigned" : event.matchMethod === "exactVenue" ? "Exact venue" : event.matchMethod === "exactAddress" ? "Exact address" : event.matchMethod === "sourceAlias" ? "Exact source alias" : "Exact match";
}

export function formatBeachActivityReviewEmail(queue: ReviewQueue, kind: "immediate" | "reminder" | "manual" | "test"): BeachActivityEmail {
	const subject = kind === "test"
		? "Alabama Beach Flag: Beach activity notification test"
		: kind === "immediate"
			? "Alabama Beach Flag: Review queue updated"
			: `Alabama Beach Flag: ${queue.pendingCount} event${queue.pendingCount === 1 ? "" : "s"} awaiting review`;
	const providers = queue.providers.length ? queue.providers.map((provider) => `${provider.sourceName}: ${provider.count}`).join("\n") : "No providers in the current queue.";
	const lines = queue.events.map((event) => [
		event.title,
		`Beach: ${beachName(event.beachId)}`,
		`Venue: ${event.venue}`,
		`Date: ${displayDate(event.startAt)}`,
		`Event type: ${event.eventType}`,
		`Impact: ${event.impactLevel}`,
		`Provider: ${event.sourceName}`,
		`Confidence: ${confidence(event)}`,
		`Source: ${event.sourceURL}`,
		"Status: Pending Review",
	].join("\n")).join("\n\n");
	const card = (event: BeachEvent) => `<article style="border:1px solid #d9e5e8;border-radius:14px;padding:16px;margin:12px 0;background:#fff"><h3 style="margin:0 0 10px;font-size:17px;color:#102f38">${escapeHtml(event.title)}</h3><table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;line-height:1.5;color:#31545d"><tr><td><strong>Beach</strong><br>${escapeHtml(beachName(event.beachId))}</td><td><strong>Date</strong><br>${escapeHtml(displayDate(event.startAt))}</td></tr><tr><td><strong>Venue</strong><br>${escapeHtml(event.venue)}</td><td><strong>Impact</strong><br>${escapeHtml(event.impactLevel)}</td></tr><tr><td><strong>Provider</strong><br>${escapeHtml(event.sourceName)}</td><td><strong>Confidence</strong><br>${escapeHtml(confidence(event))}</td></tr></table><p style="margin:12px 0 0"><a href="${escapeHtml(event.sourceURL)}" style="color:#08738a">Official source</a> · Pending Review</p></article>`;
	const high = queue.events.filter((event) => ["major", "high"].includes(event.impactLevel));
	const standard = queue.events.filter((event) => !["major", "high"].includes(event.impactLevel));
	const html = `<!doctype html><html><body style="margin:0;background:#f4f8f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#173a43"><main style="max-width:680px;margin:0 auto;padding:24px"><section style="background:#0b7186;color:#fff;border-radius:18px;padding:22px"><p style="margin:0 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.08em">Beach Activity &amp; Event Impact</p><h1 style="margin:0;font-size:25px">${queue.pendingCount} event${queue.pendingCount === 1 ? "" : "s"} awaiting review</h1><p style="margin:10px 0 0">${queue.highImpactCount} high priority · ${queue.informationalCount} informational</p></section>${high.length ? `<section style="margin-top:18px;border-left:5px solid #c24b35;padding-left:14px"><h2 style="font-size:19px;color:#9b3020">High-priority review needed</h2>${high.map(card).join("")}</section>` : ""}<section style="margin-top:18px"><h2 style="font-size:19px">Pending review</h2>${standard.map(card).join("") || (high.length ? "" : "<p>No events in this section.</p>")}</section><section style="margin-top:20px;padding:16px;background:#e8f2f4;border-radius:14px"><h2 style="font-size:17px;margin-top:0">Provider summary</h2>${queue.providers.map((provider) => `<p style="margin:5px 0">${escapeHtml(provider.sourceName)}: <strong>${provider.count}</strong></p>`).join("") || "<p>No providers in the current queue.</p>"}</section><nav style="margin-top:22px;text-align:center"><a href="${ADMIN_BASE}/events/" style="display:inline-block;margin:4px;padding:11px 14px;border-radius:9px;background:#0b7186;color:#fff;text-decoration:none">Review Events</a><a href="${ADMIN_BASE}/provider-health/" style="display:inline-block;margin:4px;padding:11px 14px;color:#0b7186">Provider Health</a><a href="${ADMIN_BASE}/operational-control/" style="display:inline-block;margin:4px;padding:11px 14px;color:#0b7186">Operational Control</a></nav></main></body></html>`;
	return {
		subject,
		text: ["Alabama Beach Flag — Beach Activity & Event Impact", "", `Pending review: ${queue.pendingCount}`, `High-impact: ${queue.highImpactCount}`, `Informational: ${queue.informationalCount}`, "", "Provider summary", providers, "", ...(lines ? ["Pending events", lines, ""] : []), `Review Events: ${ADMIN_BASE}/events/`, `Provider Health: ${ADMIN_BASE}/provider-health/`, `Operational Control: ${ADMIN_BASE}/operational-control/`].join("\n"),
		html,
	};
}

async function writeAudit(env: Pick<Env, "BEACH_DATA">, actor: string, method: string, action: string, changes: unknown, now: Date): Promise<void> {
	const record = { schemaVersion: 1, id: crypto.randomUUID(), timestamp: now.toISOString(), actor: actor.slice(0, 200), authenticationMethod: method, action, targetId: "beach-activity-notifications", changes };
	await env.BEACH_DATA.put(`${AUDIT_PREFIX}${record.timestamp}:${record.id}`, JSON.stringify(record));
}

async function recordHealth(env: Env, now: Date, error?: string): Promise<void> {
	await processProviderHealthObservations(env, [{ provider: "beach_activity_notifications", domain: "beach_events", affectedBeachCount: error ? 1 : 0, expectedBeachCount: 1, ...(error ? { errorReason: error } : {}) }], now.toISOString());
}

async function sendEmail(env: Env, config: BeachActivityNotificationConfig, message: BeachActivityEmail): Promise<void> {
	if (!env.VERIFICATION_ALERT_EMAIL?.send) throw new Error("notification_email_binding_not_configured");
	if (config.recipients.length === 0) throw new Error("notification_recipients_not_configured");
	for (const recipient of config.recipients) {
		await env.VERIFICATION_ALERT_EMAIL.send({ from: SENDER, to: recipient, subject: message.subject, text: message.text, html: message.html });
	}
}

async function persistState(env: Pick<Env, "BEACH_DATA">, state: BeachActivityNotificationState): Promise<void> {
	await env.BEACH_DATA.put(BEACH_ACTIVITY_NOTIFICATION_STATE_KEY, JSON.stringify(state));
}

export async function evaluateBeachActivityNotifications(
	env: Env,
	now = new Date(),
	options: { kind: "immediate" | "reminder" | "manual" | "test"; identity?: AdminIdentity } = { kind: "immediate" },
): Promise<{ outcome: BeachActivityNotificationState["lastOutcome"]; queue: ReviewQueue; state: BeachActivityNotificationState }> {
	const [config, prior, events, controls] = await Promise.all([readBeachActivityNotificationConfig(env), readBeachActivityNotificationState(env), listEvents(env), readOperationalControl(env, now)]);
	const queue = buildReviewQueue(events);
	const actor = options.identity?.subject ?? "system-beach-events";
	const method = options.identity?.method ?? "scheduled";
	let state: BeachActivityNotificationState = { ...prior, lastQueueRevision: queue.revision, lastEventRevision: queue.eventRevision, lastPendingCount: queue.pendingCount, lastPendingEventIds: queue.events.map((event) => event.id) };
	if (options.kind !== "test" && queue.pendingCount === 0) {
		state = { ...state, lastOutcome: "empty" };
		await persistState(env, state);
		return { outcome: "empty", queue, state };
	}
	const control = evaluateBeachActivityNotificationsControl(controls, now);
	const disabled = !config.enabled || control.state === "disabled";
	const monitorOnly = control.state === "monitorOnly";
	if (disabled || monitorOnly) {
		state = { ...state, lastOutcome: monitorOnly ? "monitorOnly" : "disabled" };
		await persistState(env, state);
		await writeAudit(env, actor, method, monitorOnly ? "notification_monitor_only" : "notification_disabled", { kind: options.kind, controlId: control.controlId, pendingCount: queue.pendingCount, revision: queue.revision }, now);
		return { outcome: state.lastOutcome, queue, state };
	}
	if (options.kind === "immediate" && !config.immediateChangeNotification) {
		state = { ...state, lastOutcome: "disabled" };
		await persistState(env, state);
		await writeAudit(env, actor, method, "notification_disabled", { kind: options.kind, reason: "immediate_notifications_disabled", pendingCount: queue.pendingCount }, now);
		return { outcome: "disabled", queue, state };
	}
	if (options.kind === "reminder") {
		if (!config.dailyReminder || !isBeachActivityReminderTime(now, config.reminderTime)) return { outcome: null, queue, state };
		if (sameCentralDay(prior.lastNotificationAt, now) && prior.lastNotificationRevision === queue.revision) {
			state = { ...state, suppressedDuplicateCount: prior.suppressedDuplicateCount + 1, lastOutcome: "duplicate" };
			await persistState(env, state);
			await writeAudit(env, actor, method, "notification_suppressed_duplicate", { kind: options.kind, pendingCount: queue.pendingCount, revision: queue.revision }, now);
			return { outcome: "duplicate", queue, state };
		}
	}
	if (options.kind === "immediate" && prior.lastQueueRevision === queue.revision) {
		state = { ...state, suppressedDuplicateCount: prior.suppressedDuplicateCount + 1, lastOutcome: "duplicate" };
		await persistState(env, state);
		await writeAudit(env, actor, method, "notification_suppressed_duplicate", { kind: options.kind, pendingCount: queue.pendingCount, revision: queue.revision }, now);
		return { outcome: "duplicate", queue, state };
	}
	const message = options.kind === "test" ? formatBeachActivityReviewEmail({ ...queue, events: [], pendingCount: 0, highImpactCount: 0, informationalCount: 0, providers: [] }, "test") : formatBeachActivityReviewEmail(queue, options.kind);
	const intentRevision = `${options.kind}:${queue.revision}:${options.kind === "reminder" ? centralDate(now) : now.toISOString()}`;
	state = { ...state, lastNotificationRevision: intentRevision, lastNotificationKind: options.kind };
	await persistState(env, state);
	let error: unknown;
	for (let attempt = 1; attempt <= 2; attempt += 1) {
		try {
			await sendEmail(env, config, message);
			const sentAt = now.toISOString();
			state = { ...state, lastNotificationAt: sentAt, lastSuccessAt: sentAt, lastFailureAt: null, lastProviderError: null, lastNotificationRevision: queue.revision, lastNotificationKind: options.kind, lastOutcome: "sent", ...(options.kind === "reminder" ? { lastReminderAt: sentAt } : {}) };
			await persistState(env, state);
			await writeAudit(env, actor, method, options.kind === "manual" ? "notification_manual_send" : options.kind === "test" ? "notification_test" : options.kind === "reminder" ? "notification_morning_reminder" : "notification_automatic", { pendingCount: queue.pendingCount, highImpactCount: queue.highImpactCount, revision: queue.revision, recipients: config.recipients, attempt }, now);
			await recordHealth(env, now);
			return { outcome: "sent", queue, state };
		} catch (caught) {
			error = caught;
			if (attempt === 1) await writeAudit(env, actor, method, "notification_retry", { kind: options.kind, revision: queue.revision, attempt: 2 }, now);
		}
	}
	const providerError = error instanceof Error ? error.message.slice(0, 300) : "notification_delivery_failed";
	state = { ...state, lastFailureAt: now.toISOString(), lastProviderError: providerError, lastOutcome: "failed" };
	await persistState(env, state);
	await writeAudit(env, actor, method, "notification_failure", { kind: options.kind, revision: queue.revision, error: providerError }, now);
	await recordHealth(env, now, providerError);
	return { outcome: "failed", queue, state };
}

export async function updateBeachActivityNotificationConfig(request: Request, env: Env, identity: AdminIdentity, now = new Date()): Promise<Response> {
	let input: Record<string, unknown>; try { input = await request.json(); } catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }
	const current = await readBeachActivityNotificationConfig(env);
	const allowedRecipients = csv(env.BEACH_ACTIVITY_NOTIFICATION_RECIPIENTS);
	const recipients = input.recipients === undefined ? current.recipients : Array.isArray(input.recipients) ? input.recipients.map(String).map((item) => item.trim().toLowerCase()) : [];
	if (recipients.length === 0 || recipients.some((item) => !email.test(item) || !allowedRecipients.includes(item))) return Response.json({ error: "invalid_recipients", allowedRecipients }, { status: 400 });
	const next: BeachActivityNotificationConfig = {
		...current,
		enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled,
		dailyReminder: typeof input.dailyReminder === "boolean" ? input.dailyReminder : current.dailyReminder,
		immediateChangeNotification: typeof input.immediateChangeNotification === "boolean" ? input.immediateChangeNotification : current.immediateChangeNotification,
		reminderTime: typeof input.reminderTime === "string" ? input.reminderTime : current.reminderTime,
		recipients: [...new Set(recipients)],
		updatedAt: now.toISOString(),
		updatedBy: identity.subject.slice(0, 200),
	};
	if (!reminderTime.test(next.reminderTime)) return Response.json({ error: "invalid_reminder_time", message: "Use a 15-minute Central time boundary." }, { status: 400 });
	await env.BEACH_DATA.put(BEACH_ACTIVITY_NOTIFICATION_CONFIG_KEY, JSON.stringify(next));
	await writeAudit(env, identity.subject, identity.method, "notification_preferences_updated", { previous: current, next }, now);
	return Response.json({ configuration: next }, { headers: { "Cache-Control": "no-store" } });
}
