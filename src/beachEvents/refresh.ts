import type { AdminIdentity } from "../services/admin/auth";
import type { Env } from "../types";
import { processProviderHealthObservations, reconcileProviderHealthModes } from "../providerHealth/process";
import { readOperationalControl, evaluateBeachEventsControl } from "../operationalControl/store";
import { iCalendarQualityFailure, parseICalendarResult } from "./ical";
import { fetchICalendar, ICalendarFetchError, type ICalendarFetchOptions, type ICalendarValidators } from "./icalFetch";
import { BEACH_EVENT_PROVIDERS } from "./providers";
import { BEACH_EVENT_SCHEDULE_DESCRIPTION, nextBeachEventRefresh } from "./schedule";
import { applyImportedEvents, archiveCompletedEvents, audit, confirmProviderUnchanged, effectiveEventEnd, eventNeedsReview, listEvents, normalizedEvent, reconcileProviderSource, saveSnapshot, SNAPSHOT_KEY } from "./store";
import { BEACH_EVENT_REFRESH_STATUS_KEY, type BeachEventProviderRefresh, type BeachEventRefreshStatus } from "./types";
import { fetchTownCrierFacts } from "./townCrier";
import { sanitizeProviderDiagnostics } from "../providerHealth/state";
import type { ProviderFetchDiagnostics } from "../providerHealth/types";

export const REFRESH_STATUS_KEY = BEACH_EVENT_REFRESH_STATUS_KEY;
const RUN_LOCK_MS = 10 * 60 * 1000;

export type BeachEventRefreshScope =
	| { mode: "all" }
	| { mode: "provider"; providerId: string };

interface RefreshOptions {
	trigger?: "scheduled" | "admin";
	identity?: AdminIdentity;
	icalFetch?: ICalendarFetchOptions;
	scope?: BeachEventRefreshScope;
}

interface ICalendarConditionalState {
	schemaVersion?: 2;
	validators?: ICalendarValidators;
	lastGoodValidCount?: number;
	lastCompleteValidCount?: number;
	lastPartialValidCount?: number;
	lastAcceptedCompleteness?: "complete" | "partial";
}

export function sanitizeStoredRefreshError(error: unknown): string {
	if (error instanceof ICalendarFetchError) return `ical_${String(error.category).replace(/[^a-z0-9_-]/gi, "_").slice(0, 80)}`;
	const raw = error instanceof Error ? error.message : "provider_failure";
	return raw.replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[redacted-authorization]").replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]").replace(/([?&](?:token|key|secret|auth|signature|code)=)[^&#\s]+/gi, "$1[redacted]").replace(/https?:\/\/([^/?#\s]+)[^\s]*/gi, "https://$1/[redacted]").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 180) || "provider_failure";
}

const emptyCounts = () => ({ raw: 0, matched: 0, excluded: 0, pendingReview: 0, published: 0, ruleSuppressed: 0, unsupportedOrAmbiguous: 0, newEvents: 0, changed: 0, unchanged: 0, possibleDuplicates: 0, warnings: 0, missingFromSource: 0, restored: 0 });

export async function readBeachEventRefreshStatus(env: Pick<Env, "BEACH_DATA">, now = new Date()): Promise<BeachEventRefreshStatus> {
	const stored = await env.BEACH_DATA.get<BeachEventRefreshStatus>(REFRESH_STATUS_KEY, "json");
	return stored ?? {
		schemaVersion: 1,
		status: "neverRun",
		trigger: "scheduled",
		lastAttempt: "",
		nextScheduledRefresh: nextBeachEventRefresh(now),
		scheduleDescription: BEACH_EVENT_SCHEDULE_DESCRIPTION,
		operationalState: "enabled",
		providers: [],
		counts: emptyCounts(),
	};
}

export async function refreshBeachEvents(env: Env, now = new Date(), fetcher: typeof fetch = fetch, options: RefreshOptions = {}) {
	const trigger = options.trigger ?? "scheduled";
	const scope = options.scope ?? { mode: "all" as const };
	const selectedProvider = scope.mode === "provider"
		? BEACH_EVENT_PROVIDERS.find((provider) => provider.id === scope.providerId)
		: undefined;
	if (scope.mode === "provider" && (!selectedProvider || selectedProvider.mode === "disabled" || selectedProvider.mode === "manualOnly")) {
		return { outcome: "providerUnavailable" as const, providers: [], snapshot: null, refresh: null };
	}
	const runId = crypto.randomUUID();
	const prior = await env.BEACH_DATA.get<BeachEventRefreshStatus>(REFRESH_STATUS_KEY, "json");
	const priorSnapshot = await env.BEACH_DATA.get(SNAPSHOT_KEY, "json") as { revision?: string } | null;
	if (prior?.status === "running" && Date.parse(prior.lastAttempt) + RUN_LOCK_MS > now.getTime()) {
		return { outcome: "duplicate" as const, providers: prior.providers, snapshot: null, refresh: prior };
	}
	const operational = evaluateBeachEventsControl(await readOperationalControl(env, now), now);
	if (selectedProvider) {
		const selectedControl = evaluateBeachEventsControl(await readOperationalControl(env, now), now, selectedProvider.controlId);
		if (operational.state === "disabled" || selectedControl.state === "disabled") {
			return { outcome: "providerUnavailable" as const, providers: [], snapshot: null, refresh: null };
		}
	}
	const providersToRun = selectedProvider ? [selectedProvider] : BEACH_EVENT_PROVIDERS;
	const running: BeachEventRefreshStatus = {
		schemaVersion: 1, runId, status: "running", trigger, lastAttempt: now.toISOString(),
		...(prior?.lastSuccess ? { lastSuccess: prior.lastSuccess } : {}),
		...(prior?.lastFailure ? { lastFailure: prior.lastFailure, lastFailureMessage: prior.lastFailureMessage } : {}),
		nextScheduledRefresh: nextBeachEventRefresh(now),
		scheduleDescription: BEACH_EVENT_SCHEDULE_DESCRIPTION,
		operationalState: operational.state,
		scope: {
			mode: scope.mode,
			...(selectedProvider ? { selectedProviderId: selectedProvider.id } : {}),
			requestedProviderCount: selectedProvider ? 1 : providersToRun.length,
			attemptedProviderCount: 0,
		},
		providers: [],
		counts: emptyCounts(),
	};
	await env.BEACH_DATA.put(REFRESH_STATUS_KEY, JSON.stringify(running));

	if (operational.state === "disabled") {
		const refresh = { ...running, status: "disabled" as const, completedAt: now.toISOString() };
		await env.BEACH_DATA.put(REFRESH_STATUS_KEY, JSON.stringify(refresh));
		if (options.identity) await audit(env, options.identity, "refresh_event_sources", "beach-events", refresh, now);
		return { outcome: "disabled" as const, providers: [], snapshot: null, refresh };
	}

	const observations = [], providerResults: BeachEventProviderRefresh[] = [];
	const conditionalCommits: Array<{ key: string; state: ICalendarConditionalState }> = [];
	for (const provider of providersToRun) {
		const priorProvider = prior?.providers.find((item) => item.providerId === provider.id);
		let diagnostics: ProviderFetchDiagnostics | undefined;
		if (provider.mode === "disabled" || provider.mode === "manualOnly") {
			providerResults.push({
				providerId: provider.id, status: "disabled", fetched: 0, matched: 0, excluded: 0, pendingReview: 0, published: 0, ruleSuppressed: 0, unsupportedOrAmbiguous: 0,
				freshness: priorProvider?.lastSuccess ? "stale" : "never", lastAttempt: priorProvider?.lastAttempt ?? "",
				...(priorProvider?.lastSuccess ? { lastSuccess: priorProvider.lastSuccess } : {}),
			});
			continue;
		}
		const providerControl = evaluateBeachEventsControl(
			await readOperationalControl(env, now), now,
			provider.controlId,
		);
		if (providerControl.state === "disabled") {
			providerResults.push({ providerId: provider.id, status: "disabled", fetched: 0, matched: 0, excluded: 0, pendingReview: 0, published: 0, ruleSuppressed: 0, unsupportedOrAmbiguous: 0, freshness: priorProvider?.lastSuccess ? "stale" : "never", lastAttempt: now.toISOString(), ...(priorProvider?.lastSuccess ? { lastSuccess: priorProvider.lastSuccess } : {}) });
			continue;
		}
		try {
			let completeness: BeachEventProviderRefresh["completeness"] = "complete";
			let unchangedConfirmation = false;
			const validatorKey = `beach-events:v1:ical-state:${provider.id}`;
			const priorICalendar = provider.feedType.includes("iCalendar") ? await env.BEACH_DATA.get<ICalendarConditionalState>(validatorKey, "json") : null;
			let conditionalCommit: ICalendarConditionalState | undefined;
			const allFacts = provider.feedType === "PDF Newsletter"
				? await fetchTownCrierFacts(env, provider, now, fetcher)
				: await (async () => {
					const fetched = await fetchICalendar(provider.feedURL, fetcher, priorICalendar?.validators, options.icalFetch);
					diagnostics = sanitizeProviderDiagnostics(fetched.diagnostics);
					if (fetched.status === "notModified") {
						const priorCompleteness = priorICalendar?.lastAcceptedCompleteness ?? "complete";
						unchangedConfirmation = priorCompleteness === "complete";
						completeness = priorCompleteness === "complete" ? "confirmedUnchanged" : "partial";
						return [];
					}
					const parsed = parseICalendarResult(fetched.body!, provider);
					const firstRejected = parsed.rejected[0];
					diagnostics = sanitizeProviderDiagnostics({ ...diagnostics, totalVEventCount: parsed.totalVEventCount, validVEventCount: parsed.validVEventCount, rejectedVEventCount: parsed.rejectedVEventCount, partial: !parsed.complete, ...(firstRejected ?? {}) });
					const qualityFailure = iCalendarQualityFailure(parsed, priorICalendar?.lastCompleteValidCount ?? priorICalendar?.lastGoodValidCount);
					if (qualityFailure) {
						diagnostics = sanitizeProviderDiagnostics({ ...diagnostics, failureCategory: qualityFailure });
						throw new Error(diagnostics?.failureCategory ?? "calendar_quality_gate");
					}
					completeness = parsed.complete ? "complete" : "partial";
					conditionalCommit = {
						schemaVersion: 2,
						validators: fetched.validators,
						lastAcceptedCompleteness: completeness,
						...(parsed.complete
							? { lastCompleteValidCount: parsed.validVEventCount, lastGoodValidCount: parsed.validVEventCount }
							: { ...(priorICalendar?.lastCompleteValidCount !== undefined ? { lastCompleteValidCount: priorICalendar.lastCompleteValidCount } : {}), ...(priorICalendar?.lastGoodValidCount !== undefined ? { lastGoodValidCount: priorICalendar.lastGoodValidCount } : {}), lastPartialValidCount: parsed.validVEventCount }),
					};
					return parsed.events;
				})();
			const resolvedCompleteness = String(completeness) as NonNullable<BeachEventProviderRefresh["completeness"]>;
			if (unchangedConfirmation) await confirmProviderUnchanged(env, provider.id, now);
			const facts = allFacts.filter((fact) => Date.parse(fact.endAt) > now.getTime() - 24 * 60 * 60 * 1000 && Date.parse(fact.startAt) < now.getTime() + 400 * 24 * 60 * 60 * 1000);
			const monitored = provider.mode === "monitorOnly" || operational.state === "monitorOnly" || providerControl.state === "monitorOnly";
			const result = unchangedConfirmation ? { discovered: 0, newEvents: 0, changed: 0, unchanged: 0, matched: 0, excluded: 0, pendingReview: 0, ruleSuppressed: 0, unsupportedOrAmbiguous: 0, possibleDuplicates: 0, warnings: 0, restored: 0 } : monitored
				? { discovered: 0, newEvents: 0, changed: 0, unchanged: 0, matched: facts.filter((fact) => normalizedEvent(fact, now)).length, excluded: facts.filter((fact) => !normalizedEvent(fact, now)).length, pendingReview: 0, ruleSuppressed: 0, unsupportedOrAmbiguous: facts.filter((fact) => !normalizedEvent(fact, now)).length, possibleDuplicates: 0, warnings: 0, restored: 0 }
				: await applyImportedEvents(env, facts, now, trigger);
			const reconciliation = monitored || resolvedCompleteness !== "complete"
				? { missingFromSource: 0, newlyRemoved: 0 }
				: await reconcileProviderSource(env, provider.id, new Set(allFacts.map((fact) => fact.externalId)), now, trigger);
			const providerEvents = (await listEvents(env)).filter((event) => event.sourceFacts.providerId === provider.id);
			providerResults.push({
				providerId: provider.id,
				status: monitored ? "monitored" : resolvedCompleteness === "partial" ? "partial" : "ok",
				fetched: facts.length,
				matched: result.matched,
				excluded: result.excluded,
				pendingReview: providerEvents.filter(eventNeedsReview).length,
				published: providerEvents.filter((event) => event.status === "published" && effectiveEventEnd(event).getTime() > now.getTime()).length,
				ruleSuppressed: result.ruleSuppressed,
				unsupportedOrAmbiguous: result.unsupportedOrAmbiguous,
				newEvents: result.newEvents,
				changed: result.changed,
				unchanged: result.unchanged,
				possibleDuplicates: result.possibleDuplicates,
				warnings: result.warnings + reconciliation.newlyRemoved,
				missingFromSource: reconciliation.missingFromSource,
				restored: result.restored,
				freshness: "fresh",
				lastAttempt: now.toISOString(),
				lastSuccess: now.toISOString(),
				...(diagnostics ? { diagnostics } : {}),
				completeness: resolvedCompleteness,
			});
			observations.push({ provider: provider.id, domain: "beach_events", affectedBeachCount: resolvedCompleteness === "partial" ? 1 : 0, expectedBeachCount: 1, ingestionMode: provider.mode, ...(resolvedCompleteness === "partial" ? { errorReason: "partial_calendar_observation" } : {}), ...(diagnostics ? { diagnostics } : {}) });
			if (conditionalCommit) conditionalCommits.push({ key: validatorKey, state: conditionalCommit });
		} catch (error) {
			if (error instanceof ICalendarFetchError) diagnostics = sanitizeProviderDiagnostics(error.diagnostics);
			const message = sanitizeStoredRefreshError(error);
			providerResults.push({ providerId: provider.id, status: "failed", fetched: 0, matched: 0, excluded: 0, pendingReview: 0, published: 0, ruleSuppressed: 0, unsupportedOrAmbiguous: 0, freshness: priorProvider?.lastSuccess ? "stale" : "never", lastAttempt: now.toISOString(), ...(priorProvider?.lastSuccess ? { lastSuccess: priorProvider.lastSuccess } : {}), lastFailure: now.toISOString(), error: message, ...(diagnostics ? { diagnostics } : {}) });
			observations.push({ provider: provider.id, domain: "beach_events", affectedBeachCount: 1, expectedBeachCount: 1, errorReason: message, ingestionMode: provider.mode, ...(diagnostics ? { diagnostics } : {}) });
		}
	}
	await reconcileProviderHealthModes(env, new Map(providersToRun.map((provider) => [`${provider.id}:beach_events`, provider.mode])), now.toISOString());
	await processProviderHealthObservations(env, observations, now.toISOString());
	const archival = scope.mode === "provider" ? { archived: 0 } : await archiveCompletedEvents(env, now, trigger);
	// KV makes this an advisory ownership check, not an exclusive lock. It prevents
	// a run already known to be superseded from publishing final status/snapshot.
	const ownership = await env.BEACH_DATA.get<BeachEventRefreshStatus>(REFRESH_STATUS_KEY, "json");
	if (ownership?.runId && ownership.runId !== runId) return { outcome: "duplicate" as const, providers: providerResults, snapshot: null, refresh: ownership };
	const preCommitFailures = providerResults.filter((item) => item.status === "failed");
	const partials = providerResults.filter((item) => item.status === "partial");
	const attempted = providerResults.filter((item) => item.status !== "disabled");
	const allAttemptedProvidersFailed = attempted.length > 0 && preCommitFailures.length === attempted.length;
	// Never extend the last-known-good window when no source succeeded.
	// A partial source may have quarantined the component corresponding to an existing public event.
	// Keep the complete last-known-good snapshot until a complete observation can safely replace it.
	const snapshot = operational.state === "monitorOnly" || partials.length > 0 ? null : allAttemptedProvidersFailed && !archival.archived ? null : await saveSnapshot(env, now, { sourceRefresh: !allAttemptedProvidersFailed });
	// Validators describe an accepted observation, not merely a successful HTTP response.
	// Persist them only after imports, observations, reconciliation, health processing,
	// archival, and any public snapshot write have all succeeded.
	for (const commit of conditionalCommits) {
		try {
			await env.BEACH_DATA.put(commit.key, JSON.stringify(commit.state));
		} catch {
			const providerId = commit.key.slice(commit.key.lastIndexOf(":") + 1), result = providerResults.find((item) => item.providerId === providerId);
			if (result) { result.status = "failed"; result.lastFailure = now.toISOString(); result.error = "conditional_state_persistence_failed"; }
			await processProviderHealthObservations(env, [{ provider: providerId, domain: "beach_events", affectedBeachCount: 1, expectedBeachCount: 1, errorReason: "conditional_state_persistence_failed", ingestionMode: BEACH_EVENT_PROVIDERS.find((provider) => provider.id === providerId)?.mode }], now.toISOString());
		}
	}
	const failures = providerResults.filter((item) => item.status === "failed");
	const publicRevisionChanged = Boolean(snapshot && snapshot.revision !== priorSnapshot?.revision);
	const events = await listEvents(env);
	const counts = providerResults.reduce((total, provider) => ({
		raw: total.raw + provider.fetched,
		matched: total.matched + provider.matched,
		excluded: total.excluded + provider.excluded,
		pendingReview: total.pendingReview + provider.pendingReview,
		published: total.published,
		ruleSuppressed: total.ruleSuppressed + provider.ruleSuppressed,
		unsupportedOrAmbiguous: total.unsupportedOrAmbiguous + provider.unsupportedOrAmbiguous,
		newEvents: total.newEvents + (provider.newEvents ?? 0),
		changed: total.changed + (provider.changed ?? 0),
		unchanged: total.unchanged + (provider.unchanged ?? 0),
		possibleDuplicates: total.possibleDuplicates + (provider.possibleDuplicates ?? 0),
		warnings: total.warnings + (provider.warnings ?? 0),
		missingFromSource: total.missingFromSource + (provider.missingFromSource ?? 0),
		restored: total.restored + (provider.restored ?? 0),
	}), { ...emptyCounts(), published: events.filter((event) => event.status === "published" && effectiveEventEnd(event).getTime() > now.getTime()).length });
	const status = operational.state === "monitorOnly" ? "monitorOnly" : attempted.length > 0 && failures.length === attempted.length ? "failed" : failures.length || partials.length ? "warning" : "healthy";
	const completedAt = new Date().toISOString();
	const refresh: BeachEventRefreshStatus = {
		...running, status, completedAt, providers: providerResults, counts, publicRevisionChanged,
		scope: { ...running.scope!, attemptedProviderCount: attempted.length },
		...(failures.length ? { lastFailure: completedAt, lastFailureMessage: failures.map((item) => `${item.providerId}: ${item.error}`).join("; ") } : {}),
		...(status === "healthy" || status === "warning" ? { lastSuccess: completedAt } : {}),
		...(snapshot ? { snapshotGeneratedAt: snapshot.generatedAt, staleUntil: snapshot.staleUntil } : {}),
	};
	const finalOwnership = await env.BEACH_DATA.get<BeachEventRefreshStatus>(REFRESH_STATUS_KEY, "json");
	if (finalOwnership?.runId && finalOwnership.runId !== runId) return { outcome: "duplicate" as const, providers: providerResults, snapshot: null, refresh: finalOwnership };
	await env.BEACH_DATA.put(REFRESH_STATUS_KEY, JSON.stringify(refresh));
	if (options.identity) await audit(env, options.identity, "refresh_event_sources", "beach-events", refresh, now, { changedFields: ["refresh"], publicOutputAffected: publicRevisionChanged, reason: scope.mode === "provider" ? `${trigger}:provider:${scope.providerId}` : trigger });
	return { outcome: status === "failed" ? "failed" as const : status === "warning" ? "partial" as const : "completed" as const, providers: providerResults, snapshot, refresh };
}
