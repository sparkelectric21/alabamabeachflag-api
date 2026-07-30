import type { AdminIdentity } from "../services/admin/auth";
import type { Env } from "../types";
import type { ProviderAlertTransport, ProviderAlertPreview } from "./delivery";
import type { ProviderAlertEvent } from "./types";

export const PROVIDER_HEALTH_NOTIFICATION_CONFIG_KEY = "provider-health:v1:notification-config";
export const PROVIDER_HEALTH_NOTIFICATION_STATE_KEY = "provider-health:v1:notification-state";
export const PROVIDER_HEALTH_DELIVERY_PREFIX = "provider-health:v1:delivery:";

const SENDER = "alerts@alabamabeachflag.com";
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const csv = (value?: string) => (value ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);

export interface ProviderHealthNotificationConfig {
	enabled: boolean;
	recipients: string[];
	updatedAt: string | null;
	updatedBy: string | null;
}

export interface ProviderHealthNotificationState {
	lastNotificationAt: string | null;
	lastSuccessAt: string | null;
	lastFailureAt: string | null;
	lastProviderError: string | null;
	lastEventId: string | null;
	lastOutcome: "sent" | "failed" | "disabled" | null;
}

const initialState: ProviderHealthNotificationState = {
	lastNotificationAt: null,
	lastSuccessAt: null,
	lastFailureAt: null,
	lastProviderError: null,
	lastEventId: null,
	lastOutcome: null,
};

export async function readProviderHealthNotificationConfig(env: Pick<Env, "BEACH_DATA" | "PROVIDER_HEALTH_NOTIFICATIONS_ENABLED" | "PROVIDER_HEALTH_NOTIFICATION_RECIPIENTS">): Promise<ProviderHealthNotificationConfig> {
	const stored = await env.BEACH_DATA.get<ProviderHealthNotificationConfig>(PROVIDER_HEALTH_NOTIFICATION_CONFIG_KEY, "json");
	if (stored) return stored;
	return {
		enabled: env.PROVIDER_HEALTH_NOTIFICATIONS_ENABLED === "true",
		recipients: csv(env.PROVIDER_HEALTH_NOTIFICATION_RECIPIENTS),
		updatedAt: null,
		updatedBy: null,
	};
}

export async function readProviderHealthNotificationState(env: Pick<Env, "BEACH_DATA">): Promise<ProviderHealthNotificationState> {
	return { ...initialState, ...(await env.BEACH_DATA.get<Partial<ProviderHealthNotificationState>>(PROVIDER_HEALTH_NOTIFICATION_STATE_KEY, "json")) };
}

async function persistState(env: Pick<Env, "BEACH_DATA">, state: ProviderHealthNotificationState): Promise<void> {
	await env.BEACH_DATA.put(PROVIDER_HEALTH_NOTIFICATION_STATE_KEY, JSON.stringify(state));
}

async function send(env: Env, event: ProviderAlertEvent, preview: ProviderAlertPreview, force = false): Promise<"sent" | "disabled"> {
	const config = await readProviderHealthNotificationConfig(env);
	if (!force && !config.enabled) return "disabled";
	if (!env.VERIFICATION_ALERT_EMAIL?.send) throw new Error("notification_email_binding_not_configured");
	if (config.recipients.length === 0) throw new Error("notification_recipients_not_configured");
	for (const recipient of config.recipients) {
		await env.VERIFICATION_ALERT_EMAIL.send({ from: SENDER, to: recipient, subject: preview.subject, text: preview.text });
	}
	const sentAt = new Date().toISOString();
	await env.BEACH_DATA.put(`${PROVIDER_HEALTH_DELIVERY_PREFIX}${encodeURIComponent(event.id)}`, JSON.stringify({ eventId: event.id, outcome: "sent", sentAt }), { expirationTtl: 90 * 24 * 60 * 60 });
	await persistState(env, { lastNotificationAt: sentAt, lastSuccessAt: sentAt, lastFailureAt: null, lastProviderError: null, lastEventId: event.id, lastOutcome: "sent" });
	return "sent";
}

export function providerHealthAlertTransport(env: Env): ProviderAlertTransport {
	return {
		async send(event, preview) {
			try {
				const outcome = await send(env, event, preview);
				if (outcome === "disabled") {
					const state = await readProviderHealthNotificationState(env);
					await persistState(env, { ...state, lastEventId: event.id, lastOutcome: "disabled" });
				}
			} catch (error) {
				const failedAt = new Date().toISOString();
				const message = error instanceof Error ? error.message.slice(0, 300) : "notification_delivery_failed";
				const state = await readProviderHealthNotificationState(env);
				await persistState(env, { ...state, lastFailureAt: failedAt, lastProviderError: message, lastEventId: event.id, lastOutcome: "failed" });
				console.error("Provider-health notification failed", error);
			}
		},
	};
}

export async function updateProviderHealthNotificationConfig(request: Request, env: Env, identity: AdminIdentity, now = new Date()): Promise<Response> {
	let input: Record<string, unknown>;
	try { input = await request.json(); } catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }
	const current = await readProviderHealthNotificationConfig(env);
	const allowedRecipients = csv(env.PROVIDER_HEALTH_NOTIFICATION_RECIPIENTS);
	const recipients = input.recipients === undefined ? current.recipients : Array.isArray(input.recipients) ? input.recipients.map(String).map((item) => item.trim().toLowerCase()) : [];
	if (recipients.length === 0 || recipients.some((item) => !email.test(item) || !allowedRecipients.includes(item))) {
		return Response.json({ error: "invalid_recipients", allowedRecipients }, { status: 400 });
	}
	const next: ProviderHealthNotificationConfig = {
		enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled,
		recipients: [...new Set(recipients)],
		updatedAt: now.toISOString(),
		updatedBy: identity.subject.slice(0, 200),
	};
	await env.BEACH_DATA.put(PROVIDER_HEALTH_NOTIFICATION_CONFIG_KEY, JSON.stringify(next));
	return Response.json({ configuration: next }, { headers: { "Cache-Control": "no-store" } });
}

export async function sendProviderHealthNotificationTest(env: Env, identity: AdminIdentity, now = new Date()): Promise<Response> {
	const event: ProviderAlertEvent = {
		id: `test:${crypto.randomUUID()}`,
		type: "reminder",
		incidentId: "provider-health-notification-test",
		incidentKind: "shared_provider",
		severity: "warning",
		provider: "notification_test",
		domain: "provider_health",
		createdAt: now.toISOString(),
		affectedBeachCount: 0,
		expectedBeachCount: 9,
		consecutiveFailures: 0,
		errorReason: `Requested by ${identity.subject.slice(0, 120)}`,
	};
	const preview = {
		subject: "Alabama Beach Flag: Provider health notification test",
		text: `Provider-health email delivery is working.\n\nRequested: ${now.toISOString()}\nAdministrator: ${identity.subject.slice(0, 120)}`,
	};
	try {
		await send(env, event, preview, true);
		return Response.json({ outcome: "sent", state: await readProviderHealthNotificationState(env) });
	} catch (error) {
		const failedAt = now.toISOString();
		const message = error instanceof Error ? error.message.slice(0, 300) : "notification_delivery_failed";
		const state = { ...(await readProviderHealthNotificationState(env)), lastFailureAt: failedAt, lastProviderError: message, lastEventId: event.id, lastOutcome: "failed" as const };
		await persistState(env, state);
		return Response.json({ error: "notification_delivery_failed", message, state }, { status: 502 });
	}
}
