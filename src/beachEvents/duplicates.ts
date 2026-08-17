import { normalizeMatchAddress, normalizeMatchText } from "./matching";
import type { BeachEvent, DuplicateAssessment, DuplicateClassification, DuplicateResolution } from "./types";

export const DUPLICATE_CANDIDATE_LIMIT = 50;
export const DUPLICATE_PAIR_LIMIT = 200;
export const DUPLICATE_EVIDENCE_LIMIT = 12;
const TIME_TOLERANCE_MS = 3 * 60 * 60 * 1000;
const GENERIC = new Set(["event", "festival", "cleanup", "coastal", "beach", "annual", "the", "at", "of", "and"]);
const tokens = (value = "") => [...new Set(normalizeMatchText(value).split(" ").filter((token) => token.length > 2 && !GENERIC.has(token)))].sort();
const similarity = (a: string[], b: string[]) => { const common = a.filter((token) => b.includes(token)).length; return Math.round(100 * common / Math.max(1, new Set([...a, ...b]).size)); };
export const canonicalEventURL = (value?: string) => { if (!value) return undefined; try { const url = new URL(value); url.hash = ""; for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_)/i.test(key)) url.searchParams.delete(key); url.hostname = url.hostname.toLowerCase(); return url.toString().replace(/\/$/, ""); } catch { return undefined; } };
const overlap = (a: BeachEvent, b: BeachEvent) => Date.parse(a.startAt) < Date.parse(b.endAt) && Date.parse(b.startAt) < Date.parse(a.endAt);
const sameDay = (a: BeachEvent, b: BeachEvent) => a.startAt.slice(0, 10) === b.startAt.slice(0, 10);
const authority = (event: BeachEvent) => event.sourceFacts.providerId === "manual" ? 0 : /state|park/i.test(event.sourceName) ? 3 : /city|town|county/i.test(event.sourceName) ? 2 : 1;
const bounded = (values: string[]) => [...new Set(values)].sort().slice(0, DUPLICATE_EVIDENCE_LIMIT);
const DAY_MS = 86400000;
const normalizedOrganizer = (event: BeachEvent) => normalizeMatchText(event.sourceName);
const locationScore = (a: BeachEvent, b: BeachEvent) => normalizeMatchAddress(a.address) && normalizeMatchAddress(a.address) === normalizeMatchAddress(b.address) ? 3 : normalizeMatchText(a.venue) && normalizeMatchText(a.venue) === normalizeMatchText(b.venue) ? 2 : a.beachId === b.beachId ? 1 : 0;
const blockStrength = (a: BeachEvent, b: BeachEvent) => {
	const url = canonicalEventURL(a.officialEventURL ?? a.sourceFacts.officialURL), otherURL = canonicalEventURL(b.officialEventURL ?? b.sourceFacts.officialURL);
	if (url && url === otherURL) return 7;
	if (a.sourceFacts.organizerEventId && a.sourceFacts.organizerEventId === b.sourceFacts.organizerEventId) return 6;
	if (a.sourceFacts.providerId === b.sourceFacts.providerId && a.sourceFacts.externalId === b.sourceFacts.externalId) return 6;
	if (a.sourceFacts.seriesId && a.sourceFacts.seriesId === b.sourceFacts.seriesId) return 5;
	if (a.sourceFacts.recurrenceId && (a.sourceFacts.externalId === b.sourceFacts.externalId || a.sourceFacts.recurrenceId === b.sourceFacts.recurrenceId)) return 5;
	const titleSimilarity = similarity(tokens(a.title), tokens(b.title)), organizerMatch = normalizedOrganizer(a) === normalizedOrganizer(b);
	if (organizerMatch && titleSimilarity >= 50) return 4;
	if (locationScore(a, b) && titleSimilarity >= 50) return 3;
	if (Math.abs(Date.parse(a.startAt) - Date.parse(b.startAt)) <= 7 * DAY_MS && (titleSimilarity >= 35 || locationScore(a, b))) return 2;
	if ((a.sourceFacts.providerId === "manual") !== (b.sourceFacts.providerId === "manual") && Math.abs(Date.parse(a.startAt) - Date.parse(b.startAt)) <= 7 * DAY_MS && titleSimilarity >= 35) return 1;
	return 0;
};

export function selectDuplicateCandidates(event: BeachEvent, events: BeachEvent[], limit = DUPLICATE_CANDIDATE_LIMIT) {
	const eligible = events.filter((candidate) => candidate.id !== event.id).map((candidate) => ({
		candidate,
		strength: blockStrength(event, candidate),
		timeDistance: Math.abs(Date.parse(event.startAt) - Date.parse(candidate.startAt)),
		location: locationScore(event, candidate),
		title: similarity(tokens(event.title), tokens(candidate.title)),
	})).filter((item) => item.strength > 0).sort((a, b) => b.strength - a.strength || a.timeDistance - b.timeDistance || b.location - a.location || b.title - a.title || a.candidate.id.localeCompare(b.candidate.id));
	const selected = eligible.slice(0, Math.min(limit, DUPLICATE_PAIR_LIMIT));
	const assessments = selected.map(({ candidate }) => ({ candidate, assessment: assessDuplicate(event, candidate) })).filter(({ assessment }) => ["strongDuplicate", "likelyDuplicate", "possibleDuplicate"].includes(assessment.classification));
	return { candidates: assessments, eligibleCount: eligible.length, omittedCount: Math.max(0, eligible.length - selected.length), truncated: eligible.length > selected.length };
}

export function assessDuplicate(a: BeachEvent, b: BeachEvent): DuplicateAssessment {
	const positive: string[] = [], conflicting: string[] = [], blocking: string[] = [];
	const sameSource = a.sourceFacts.providerId === b.sourceFacts.providerId && a.sourceFacts.externalId === b.sourceFacts.externalId;
	if (sameSource) positive.push("Same provider and external ID");
	const recurrenceException = Boolean(a.sourceFacts.recurrenceId || b.sourceFacts.recurrenceId);
	if (a.sourceFacts.providerId === b.sourceFacts.providerId && a.sourceFacts.externalId !== b.sourceFacts.externalId) conflicting.push("Distinct official occurrence IDs");
	if (recurrenceException) conflicting.push("Recurring master and exception remain separate records");
	const urlA = canonicalEventURL(a.officialEventURL ?? a.sourceFacts.officialURL), urlB = canonicalEventURL(b.officialEventURL ?? b.sourceFacts.officialURL);
	if (urlA && urlA === urlB) positive.push("Equal canonical official event URL");
	const organizerIdA = a.sourceFacts.organizerEventId, organizerIdB = b.sourceFacts.organizerEventId;
	if (organizerIdA && organizerIdA === organizerIdB) positive.push("Equal canonical organizer event ID");
	const titleA = tokens(a.title), titleB = tokens(b.title), titleSimilarity = similarity(titleA, titleB);
	const exactNormalizedTitle = normalizeMatchText(a.title) === normalizeMatchText(b.title);
	if (exactNormalizedTitle) positive.push("Equal normalized title");
	if (titleSimilarity >= 75) positive.push(`Identity title tokens ${titleSimilarity}% similar`); else if (titleSimilarity < 35) conflicting.push(`Identity title tokens only ${titleSimilarity}% similar`);
	const sameOrganizer = normalizeMatchText(a.sourceName) === normalizeMatchText(b.sourceName);
	if (sameOrganizer) positive.push("Same organizer/source name"); else conflicting.push("Different organizer/source name");
	const venueA = normalizeMatchText(a.venue), venueB = normalizeMatchText(b.venue), addressA = normalizeMatchAddress(a.address), addressB = normalizeMatchAddress(b.address);
	if ((venueA && venueA === venueB) || (addressA && addressA === addressB)) positive.push("Same normalized venue or address"); else if (venueA && venueB && venueA !== venueB) conflicting.push("Materially different venue");
	if (overlap(a, b)) positive.push("Occurrence windows overlap"); else if (Math.abs(Date.parse(a.startAt) - Date.parse(b.startAt)) <= TIME_TOLERANCE_MS) positive.push("Start times within three-hour tolerance"); else conflicting.push("Occurrence windows are distinct");
	if (a.location?.classification !== b.location?.classification) conflicting.push("Different location classes");
	if (a.location?.classification === "regional" && b.location?.classification === "beachSpecific") conflicting.push("Regional umbrella and exact child occurrence");
	if (a.sourceFacts.seriesId && a.sourceFacts.seriesId === b.sourceFacts.seriesId) positive.push("Shared source series identity");
	if (!sameDay(a, b) && a.sourceFacts.externalId !== b.sourceFacts.externalId) conflicting.push("Separate scheduled dates");
	let classification: DuplicateClassification = "unrelated";
	if (sameSource) classification = "sameSourceRecord";
	else if (recurrenceException || conflicting.includes("Regional umbrella and exact child occurrence") || conflicting.includes("Separate scheduled dates")) classification = "distinctOccurrence";
	else if ((organizerIdA && organizerIdA === organizerIdB) || (urlA && urlA === urlB && overlap(a, b))) classification = "strongDuplicate";
	else if (titleSimilarity >= 75 && sameOrganizer && positive.includes("Same normalized venue or address") && overlap(a, b)) classification = "likelyDuplicate";
	else if ((titleSimilarity >= 50 || (exactNormalizedTitle && [a, b].some((event) => event.sourceFacts.providerId === "manual"))) && (overlap(a, b) || positive.includes("Start times within three-hour tolerance"))) classification = "possibleDuplicate";
	blocking.push(overlap(a, b) ? "overlapping-window" : sameDay(a, b) ? "same-day" : "nearby-date", titleSimilarity >= 50 ? "title-token-block" : "weak-title-block");
	const canonical = authority(a) === authority(b) ? undefined : authority(a) > authority(b) ? a.id : b.id;
	return { pairId: [a.id, b.id].sort().join("::"), eventIds: [a.id, b.id].sort(), classification, blockingReasons: bounded(blocking), positiveEvidence: bounded(positive), conflictingEvidence: bounded(conflicting), titleTokens: { [a.id]: titleA.slice(0, 20), [b.id]: titleB.slice(0, 20) }, proposedCanonicalEventId: canonical, proposedRelationship: classification === "distinctOccurrence" && a.sourceFacts.seriesId && a.sourceFacts.seriesId === b.sourceFacts.seriesId ? "relatedOccurrences" : ["strongDuplicate", "likelyDuplicate"].includes(classification) ? "sameCanonicalEvent" : "keepSeparate", recommendedAction: classification === "strongDuplicate" ? "reviewCanonicalLink" : classification === "likelyDuplicate" || classification === "possibleDuplicate" ? "reviewPossibleDuplicate" : "keepSeparate" };
}

export function auditDuplicateCandidates(events: BeachEvent[]): { candidates: DuplicateAssessment[]; truncated: boolean; summary: string } {
	const candidates: DuplicateAssessment[] = [];
	let omitted = 0;
	for (const event of [...events].sort((a, b) => b.startAt.localeCompare(a.startAt) || a.id.localeCompare(b.id))) {
		const selected = selectDuplicateCandidates(event, events);
		omitted += selected.omittedCount;
		for (const { assessment } of selected.candidates) if (!candidates.some((item) => item.pairId === assessment.pairId) && candidates.length < DUPLICATE_PAIR_LIMIT) candidates.push(assessment);
		if (candidates.length === DUPLICATE_PAIR_LIMIT) break;
	}
	return { candidates, truncated: omitted > 0 || candidates.length === DUPLICATE_PAIR_LIMIT, summary: `${candidates.length} bounded candidate pair${candidates.length === 1 ? "" : "s"}; ${omitted} eligible candidate${omitted === 1 ? "" : "s"} omitted by bounds; no records merged or deleted.` };
}

export function applyDuplicateResolution(event: BeachEvent, resolution: DuplicateResolution | undefined): BeachEvent {
	if (!resolution) { const next = { ...event }; delete next.duplicateResolution; return next; }
	if (event.duplicateResolution?.decision === resolution.decision && event.duplicateResolution?.relatedEventId === resolution.relatedEventId && event.duplicateResolution?.evidenceRevision === resolution.evidenceRevision) return event;
	return { ...event, duplicateResolution: resolution, ...(resolution.decision === "suppressDuplicate" ? { status: "hidden" as const } : {}) };
}
