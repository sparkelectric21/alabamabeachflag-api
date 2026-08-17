import { NWS_EVENT_POLICY } from "./policy";
import type { NormalizedOfficialAlert } from "./types";

const severity = { Extreme: 5, Severe: 4, Moderate: 3, Minor: 2, Unknown: 0 } as const;
const urgency = { Immediate: 4, Expected: 3, Future: 2, Past: 1, Unknown: 0 } as const;

export function compareOfficialAlerts(a: NormalizedOfficialAlert, b: NormalizedOfficialAlert): number {
	return severity[b.severity] - severity[a.severity]
		|| urgency[b.urgency] - urgency[a.urgency]
		|| (NWS_EVENT_POLICY[b.event as keyof typeof NWS_EVENT_POLICY]?.priority ?? 0) - (NWS_EVENT_POLICY[a.event as keyof typeof NWS_EVENT_POLICY]?.priority ?? 0)
		|| Date.parse(b.onsetAt ?? b.effectiveAt) - Date.parse(a.onsetAt ?? a.effectiveAt)
		|| a.id.localeCompare(b.id);
}
