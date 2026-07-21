import type { Env } from "../types";
import type { AlertNotification } from "./types";

const ALERT_SENDER = "alerts@alabamabeachflag.com";
const ALERT_RECIPIENT = "operations@alabamabeachflag.com";

export interface AlertDelivery {
	send(notification: AlertNotification): Promise<void>;
}

export function alertDeliveryEnabled(env: Env): boolean {
	return env.VERIFICATION_ALERTS_ENABLED === "true";
}

function alertLabel(notification: AlertNotification): string {
	if (notification.kind === "recovery") return "Recovery";
	if (notification.affected.some((item) => item.name === "scheduled_report")) return "Missing Report";
	if (notification.kind === "update") return "Update";
	return notification.status === "warning" ? "Warning" : "Failure";
}

function subjectFor(notification: AlertNotification): string {
	const label = alertLabel(notification);
	const subjectLabel = label === "Recovery" ? "Recovered" : label === "Missing Report" ? "Report Missing" : label;
	return `[Alabama Beach Flag] Verification ${subjectLabel}`;
}

function centralTimestamp(value: string): string {
	return new Intl.DateTimeFormat("en-US", {
		timeZone: "America/Chicago",
		dateStyle: "medium",
		timeStyle: "long",
	}).format(new Date(value));
}

export function formatAlertEmail(env: Env, notification: AlertNotification): { subject: string; text: string } {
	const affected = notification.affected.length === 0
		? "none"
		: notification.affected.map((item) => item.name).join(", ");
	const diagnostics = notification.affected.length === 0
		? "none"
		: notification.affected.map((item) => [
			`- Check: ${item.name}`,
			`  Provider: ${item.provider ?? "not applicable"}`,
			`  Location: ${item.location ?? "not applicable"}`,
			`  Expected: ${item.expectedValue ?? "not specified"}`,
			`  Actual: ${item.actualValue ?? "not specified"}`,
			`  Failure reason: ${item.detail}`,
		].join("\n")).join("\n");
	return {
		subject: subjectFor(notification),
		text: [
			"Alabama Beach Flag factual verification alert",
			"",
			`Environment: ${env.VERIFICATION_ALERT_ENVIRONMENT}`,
			`Alert type: ${alertLabel(notification).toLowerCase()}`,
			`Report slot: ${notification.slot}`,
			`Central timestamp: ${centralTimestamp(notification.reportTime)}`,
			`Overall status: ${notification.status}`,
			`Affected checks or locations: ${affected}`,
			"Diagnostics:",
			diagnostics,
		].join("\n"),
	};
}

export async function deliverAlert(env: Env, notification: AlertNotification): Promise<void> {
	if (!alertDeliveryEnabled(env)) return;
	if (!env.VERIFICATION_ALERT_EMAIL?.send) throw new Error("verification_alert_email_not_configured");
	const message = formatAlertEmail(env, notification);
	await env.VERIFICATION_ALERT_EMAIL.send({
		from: ALERT_SENDER,
		to: ALERT_RECIPIENT,
		subject: message.subject,
		text: message.text,
	});
}
