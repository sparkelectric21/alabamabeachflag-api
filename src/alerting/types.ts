import type { VerificationStatus } from "../verification/types";

export type AlertKind = "incident" | "update" | "recovery";

export interface AlertObservation {
	slot: string;
	reportTime: string;
	status: VerificationStatus;
	affected: Array<{
		name: string;
		status: "fail";
		detail: string;
		provider?: string;
		location?: string;
		expectedValue?: string;
		actualValue?: string;
	}>;
}

export interface AlertIncident {
	id: string;
	openedAt: string;
	lastObservedAt: string;
	signature: string;
	status: Exclude<VerificationStatus, "pass">;
	affected?: AlertObservation["affected"];
}

export interface AlertState {
	active?: AlertIncident;
	lastNotificationKey?: string;
}

export interface AlertNotification {
	key: string;
	kind: AlertKind;
	incidentId: string;
	reportTime: string;
	slot: string;
	status: VerificationStatus;
	affected: AlertObservation["affected"];
	summary: string;
}

export interface AlertDecision {
	state: AlertState;
	notification?: AlertNotification;
}
