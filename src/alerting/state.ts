import type {
	AlertDecision,
	AlertNotification,
	AlertObservation,
	AlertState,
} from "./types";

function signature(observation: AlertObservation): string {
	return observation.affected
		.map((item) => `${item.name}:${item.status}`)
		.sort()
		.join("|");
}

function notification(
	observation: AlertObservation,
	kind: AlertNotification["kind"],
	incidentId: string,
	affected = observation.affected,
): AlertNotification {
	const affectedNames = affected.map((item) => item.name).join(", ") || "none";
	return {
		key: `${incidentId}:${kind}:${observation.slot}:${signature(observation)}`,
		kind,
		incidentId,
		reportTime: observation.reportTime,
		slot: observation.slot,
		status: observation.status,
		affected,
		summary: kind === "recovery"
			? `Verification recovered; previous incident ${incidentId} is passing.`
			: `Verification ${observation.status}; affected: ${affectedNames}.`,
	};
}

export function evaluateAlert(state: AlertState, observation: AlertObservation): AlertDecision {
	if (observation.status === "pass") {
		if (!state.active) return { state };
		const next = notification(observation, "recovery", state.active.id, state.active.affected ?? []);
		return {
			state: { lastNotificationKey: next.key },
			notification: next.key === state.lastNotificationKey ? undefined : next,
		};
	}

	// Warnings are diagnostic and not actionable. They neither open nor resolve an incident.
	if (observation.status === "warning") return { state };

	const nextSignature = signature(observation);
	if (!state.active) {
		const id = `${observation.slot}:${observation.status}`;
		const next = notification(observation, "incident", id);
		return {
			state: {
				active: {
					id,
					openedAt: observation.reportTime,
					lastObservedAt: observation.reportTime,
					signature: nextSignature,
					status: observation.status,
					affected: observation.affected,
				},
				lastNotificationKey: next.key,
			},
			notification: next,
		};
	}

	if (state.active.signature === nextSignature && state.active.status === observation.status) {
		return {
			state: {
				...state,
				active: { ...state.active, lastObservedAt: observation.reportTime },
			},
		};
	}

	const next = notification(observation, "update", state.active.id);
	return {
		state: {
			active: {
				...state.active,
				lastObservedAt: observation.reportTime,
				signature: nextSignature,
				status: observation.status,
				affected: observation.affected,
			},
			lastNotificationKey: next.key,
		},
		notification: next.key === state.lastNotificationKey ? undefined : next,
	};
}
