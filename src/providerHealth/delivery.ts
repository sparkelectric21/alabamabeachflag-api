import type { ProviderAlertEvent } from "./types";

export interface ProviderAlertPreview {
	subject: string;
	text: string;
}

export interface ProviderAlertTransport {
	send(event: ProviderAlertEvent, preview: ProviderAlertPreview): Promise<void>;
}

const title = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());

export function formatProviderAlertEmail(event: ProviderAlertEvent): ProviderAlertPreview {
	const label = event.type === "opened" ? (event.severity === "critical" ? "Critical" : "Provider Alert") : event.type === "recovery" ? "Recovered" : "Reminder";
	return {
		subject: `Alabama Beach Flag: ${label} — ${title(event.provider)} / ${title(event.domain)}`,
		text: [
			"Alabama Beach Flag provider-health alert",
			"",
			`Event: ${event.type}`,
			`Severity: ${event.severity}`,
			`Provider: ${event.provider}`,
			`Domain: ${event.domain}`,
			`Incident: ${event.incidentId}`,
			`Timestamp: ${event.createdAt}`,
			`Affected beaches: ${event.affectedBeachCount} of ${event.expectedBeachCount}`,
			`Consecutive failures: ${event.consecutiveFailures}`,
			`Reason: ${event.errorReason ?? "not applicable"}`,
		].join("\n"),
	};
}

export const consoleProviderAlertTransport: ProviderAlertTransport = {
	async send(event, preview): Promise<void> {
		console.info("[Provider health capture]", JSON.stringify({ event, preview }));
	},
};

export function captureProviderAlertTransport(captured: Array<{ event: ProviderAlertEvent; preview: ProviderAlertPreview }>): ProviderAlertTransport {
	return { async send(event, preview) { captured.push(structuredClone({ event, preview })); } };
}
