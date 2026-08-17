import { BEACH_EVENT_PROVIDERS } from "./providers";
import { explainBeachMatch, normalizeMatchText } from "./matching";
import type { BeachEvent, EventLocationAssessment, LocationEvidenceItem, SourceFacts } from "./types";

const MAX_EVIDENCE = 12, MAX_VALUE = 120;
const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_VALUE);
export function sanitizeLocationEvidence(items: LocationEvidenceItem[]): LocationEvidenceItem[] {
	return items.slice(0, MAX_EVIDENCE).map((item) => ({ kind: item.kind, origin: item.origin, value: clean(item.value), supportsExact: item.supportsExact }));
}

const broadPattern = /^(?:gulf shores|orange beach|dauphin island|fort morgan|alabama coast|gulf coast)$|\b(?:various (?:locations|sites)|multiple (?:locations|sites)|citywide|islandwide|countywide)\b/;
const nearby: Array<[RegExp, string | undefined]> = [
	[/\bthe wharf\b/, "cotton-bayou"], [/\bgulf state park (?:fishing and education )?pier\b|^pier$/, "gulf-state-park-pavilion"],
	[/\bflora bama\b|\borange beach waterfront park\b|\bmarina\b/, undefined],
];
export function classifyEventLocation(input: Pick<SourceFacts, "providerId" | "venue" | "address" | "title">, administratorBeachId?: string): EventLocationAssessment {
	const venue = normalizeMatchText(input.venue), match = explainBeachMatch(input);
	const addressOnlyMatch = input.address ? explainBeachMatch({ ...input, venue: "" }) : undefined;
	const evidence: LocationEvidenceItem[] = [], conflicts: string[] = [];
	const provider = BEACH_EVENT_PROVIDERS.find((item) => item.id === input.providerId);
	if (provider?.coverage.length) evidence.push({ kind: "providerCoverage", origin: "source", value: provider.coverage.join(", "), supportsExact: false });
	if (match.beachId && match.method) {
		evidence.push({ kind: match.method === "exactAddress" ? "exactAddress" : match.method === "sourceAlias" ? "explicitBeachToken" : "exactVenue", origin: match.method === "sourceAlias" ? "rule" : "source", value: match.reason, supportsExact: true });
		if (administratorBeachId && administratorBeachId !== match.beachId) conflicts.push(`Assigned beach ${administratorBeachId} conflicts with exact evidence for ${match.beachId}`);
		if (administratorBeachId) evidence.push({ kind: "administratorOverride", origin: "administrator", value: administratorBeachId, supportsExact: administratorBeachId === match.beachId });
		return { classification: "beachSpecific", precisionLabel: "At this beach", proposedBeachId: match.beachId, evidence: sanitizeLocationEvidence(evidence), conflicts: conflicts.map(clean), exactAssignmentSupported: !administratorBeachId || administratorBeachId === match.beachId, assignmentOrigin: administratorBeachId ? "administrator" : match.method === "sourceAlias" ? "rule" : "source" };
	}
	if (match.exclusionReason && addressOnlyMatch?.beachId) {
		evidence.push({ kind: "exactAddress", origin: "source", value: addressOnlyMatch.reason, supportsExact: true });
		conflicts.push(`Exact address evidence for ${addressOnlyMatch.beachId} conflicts with excluded venue ${input.venue}`);
	}
	if (!venue && !input.address) evidence.push({ kind: "missingLocation", origin: "source", value: "No venue or address supplied", supportsExact: false });
	if (broadPattern.test(venue)) evidence.push({ kind: "broadLocation", origin: "source", value: input.venue || "Broad location", supportsExact: false });
	const nearbyMatch = nearby.find(([pattern]) => pattern.test(venue));
	if (nearbyMatch) evidence.push({ kind: "nearbyVenue", origin: "rule", value: input.venue, supportsExact: false });
	if (match.exclusionReason) evidence.push({ kind: "knownExclusion", origin: "rule", value: match.reason, supportsExact: false });
	if (administratorBeachId) { evidence.push({ kind: "administratorOverride", origin: "administrator", value: administratorBeachId, supportsExact: false }); conflicts.push(`Retained exact assignment ${administratorBeachId} lacks affirmative exact-location evidence`); }
	const classification = broadPattern.test(venue) ? "regional" : nearbyMatch ? "nearbyCoastal" : "irrelevant";
	return {
		classification,
		precisionLabel: classification === "regional" ? "Regional" : classification === "nearbyCoastal" ? "Nearby coastal" : "Not beach relevant",
		...(nearbyMatch?.[1] ? { proposedBeachId: nearbyMatch[1] } : {}),
		...(classification === "regional" ? { region: input.venue || provider?.coverage[0] || "Coastal region" } : {}),
		evidence: sanitizeLocationEvidence(evidence), conflicts: conflicts.map(clean).slice(0, 8), exactAssignmentSupported: false, assignmentOrigin: administratorBeachId ? "administrator" : "rule",
	};
}

export interface LocationAuditItem {
	id: string; title: string; providerId: string; sourceName: string; currentBeachId: string;
	assessment: EventLocationAssessment; currentAssignmentSupported: boolean;
	recommendation: "retain" | "review" | "clearExactAssignment" | "classifyOnly";
}
export function auditEventLocations(events: BeachEvent[]): { version: 1; records: LocationAuditItem[]; summary: { total: number; supported: number; review: number; clearExactAssignment: number; classifyOnly: number }; humanSummary: string } {
	const records = [...events].sort((a, b) => a.id.localeCompare(b.id)).map((event): LocationAuditItem => {
		const assessment = classifyEventLocation(event.sourceFacts, event.beachId);
		const recommendation = assessment.exactAssignmentSupported ? "retain" : event.matchMethod === "adminOverride" ? "review" : "clearExactAssignment";
		return { id: event.id, title: clean(event.title), providerId: event.sourceFacts.providerId, sourceName: clean(event.sourceName), currentBeachId: event.beachId, assessment, currentAssignmentSupported: assessment.exactAssignmentSupported, recommendation };
	});
	const summary = { total: records.length, supported: records.filter((item) => item.currentAssignmentSupported).length, review: records.filter((item) => item.recommendation === "review").length, clearExactAssignment: records.filter((item) => item.recommendation === "clearExactAssignment").length, classifyOnly: records.filter((item) => item.recommendation === "classifyOnly").length };
	return { version: 1, records, summary, humanSummary: `${summary.total} records analyzed; ${summary.supported} supported exact assignments, ${summary.review} require operator review, ${summary.clearExactAssignment} should clear exact assignment, and ${summary.classifyOnly} should retain classification only.` };
}
