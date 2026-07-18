import type { Env } from "../types";
import type { AlertNotification } from "./types";

export interface AlertDelivery {
	send(notification: AlertNotification): Promise<void>;
}

export function alertDeliveryEnabled(env: Env): boolean {
	return env.VERIFICATION_ALERTS_ENABLED === "true";
}

export async function deliverAlert(env: Env, notification: AlertNotification): Promise<void> {
	if (!alertDeliveryEnabled(env)) return;
	// Phase 2 state is delivery-neutral until an approved destination is configured.
	// Failing closed here keeps verification/reporting healthy if the flag is enabled prematurely.
	void notification;
	throw new Error("alert_delivery_not_configured");
}
