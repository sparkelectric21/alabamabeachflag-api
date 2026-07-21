export type ProviderHealthStatus = "healthy" | "degraded" | "unavailable";
export type ProviderIncidentKind = "shared_provider" | "isolated" | "quality_gate";
export type ProviderAlertState = "clear" | "pending" | "active";
export type ProviderAlertEventType = "opened" | "recovery" | "reminder";

export interface ProviderHealthObservation {
	provider: string;
	domain: string;
	affectedBeachCount: number;
	expectedBeachCount: number;
	errorReason?: string;
}

export interface ProviderHealthState {
	provider: string;
	domain: string;
	currentStatus: ProviderHealthStatus;
	consecutiveFailures: number;
	consecutiveSuccesses: number;
	affectedBeachCount: number;
	expectedBeachCount: number;
	firstFailureAt?: string;
	lastFailureAt?: string;
	lastSuccessAt?: string;
	lastErrorReason?: string;
	activeIncidentId?: string;
	incidentKind?: ProviderIncidentKind;
	alertState: ProviderAlertState;
	alertOpenedAt?: string;
	recoveryAlertSentAt?: string;
	lastReminderAt?: string;
	updatedAt: string;
}

export interface ProviderAlertEvent {
	id: string;
	type: ProviderAlertEventType;
	incidentId: string;
	incidentKind: ProviderIncidentKind;
	severity: "warning" | "critical" | "recovery";
	provider: string;
	domain: string;
	createdAt: string;
	affectedBeachCount: number;
	expectedBeachCount: number;
	consecutiveFailures: number;
	errorReason?: string;
}

export interface ProviderHealthDecision {
	state: ProviderHealthState;
	event?: ProviderAlertEvent;
}

export interface ProviderHealthOptions {
	remindersEnabled?: boolean;
	reminderAfterMs?: number;
}
