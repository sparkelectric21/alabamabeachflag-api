import type { Env } from "../types";
import { processProviderHealthObservations } from "../providerHealth/process";
import { readOperationalControl, evaluateBeachEventsControl } from "../operationalControl/store";
import { parseICalendar } from "./ical";
import { BEACH_EVENT_PROVIDERS } from "./providers";
import { applyImportedEvents, saveSnapshot } from "./store";

export async function refreshBeachEvents(env: Env, now = new Date(), fetcher: typeof fetch = fetch) {
	const operational = evaluateBeachEventsControl(await readOperationalControl(env, now), now);
	if (operational.state === "disabled") return { outcome: "disabled" as const, providers: [], snapshot: null };
	const observations = [], providerResults = [];
	for (const provider of BEACH_EVENT_PROVIDERS) {
		if (provider.mode !== "enabled") continue;
		const providerControl = evaluateBeachEventsControl(
			await readOperationalControl(env, now),
			now,
			provider.id === "gulfShoresCity" ? "gulfShoresEvents" : "orangeBeachEvents",
		);
		if (providerControl.state === "disabled") {
			providerResults.push({ providerId: provider.id, status: "disabled" });
			continue;
		}
		try {
			const response = await fetcher(provider.feedURL, { headers: { Accept: "text/calendar, text/plain;q=0.8", "User-Agent": "AlabamaBeachFlag/1.0 beach-events" } });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const facts = parseICalendar(await response.text(), provider);
			const monitored = operational.state === "monitorOnly" || providerControl.state === "monitorOnly";
			const result = monitored ? { discovered: 0, matched: 0 } : await applyImportedEvents(env, facts, now);
			providerResults.push({ providerId: provider.id, status: monitored ? "monitored" : "ok", fetched: facts.length, ...result });
			observations.push({ provider: provider.id, domain: "beach_events", affectedBeachCount: 0, expectedBeachCount: 1 });
		} catch (error) {
			providerResults.push({ providerId: provider.id, status: "failed", error: error instanceof Error ? error.message : "provider_failure" });
			observations.push({ provider: provider.id, domain: "beach_events", affectedBeachCount: 1, expectedBeachCount: 1, errorReason: error instanceof Error ? error.message : "provider_failure" });
		}
	}
	await processProviderHealthObservations(env, observations, now.toISOString());
	const snapshot = operational.state === "monitorOnly" ? null : await saveSnapshot(env, now);
	return { outcome: providerResults.some((item) => item.status === "failed") ? "partial" as const : "completed" as const, providers: providerResults, snapshot };
}
