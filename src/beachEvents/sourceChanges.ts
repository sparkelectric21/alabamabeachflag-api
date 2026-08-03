import { decodeHTMLEntities, normalizeDescription, sanitizeEventURL } from "./normalize";
import { normalizeMatchAddress } from "./matching";
import type { SourceFacts } from "./types";

const MATERIAL_FIELDS = new Set<keyof SourceFacts>([
	"title",
	"venue",
	"address",
	"startAt",
	"endAt",
	"allDay",
	"recurring",
	"officialURL",
	"registrationURL",
	"organizerWebsiteURL",
	"officialEventsPageURL",
	"description",
	"contactInformation",
	"endTimeUnavailable",
	"sourceStatus",
]);

const COSMETIC_WORDS = new Set([
	"a", "an", "and", "are", "at", "be", "by", "details", "event", "events", "for", "from", "information", "is", "it", "join", "learn", "more", "of", "official", "on", "our", "please", "the", "this", "to", "us", "visit", "website", "will", "with", "you", "your",
]);

const WORD_EQUIVALENTS: Record<string, string> = {
	allowed: "allowed",
	cancellation: "cancelled", cancellations: "cancelled", canceled: "cancelled", cancelled: "cancelled", canceling: "cancelled", cancelling: "cancelled",
	checkin: "checkin",
	children: "child", kids: "child",
	closure: "closed", closures: "closed", close: "closed", closed: "closed", closing: "closed",
	cost: "fee", costs: "fee", fees: "fee",
	instruction: "instruction", instructions: "instruction",
	park: "parking", parked: "parking", parking: "parking",
	postpone: "postponed", postponed: "postponed", postponement: "postponed",
	prohibit: "prohibited", prohibited: "prohibited", forbids: "prohibited", forbidden: "prohibited",
	register: "register", registered: "register", registering: "register", registration: "register", registrations: "register",
	require: "required", required: "required", requirement: "required", requirements: "required", requires: "required", must: "required",
	reservation: "reserve", reservations: "reserve", reserve: "reserve", reserved: "reserve",
	signup: "register",
	ticket: "ticket", tickets: "ticket",
	visitor: "visitor", visitors: "visitor",
};

export function stableHash(value: string): string {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizedText(value: unknown): string {
	if (typeof value !== "string") return value === undefined ? "" : JSON.stringify(value);
	return decodeHTMLEntities(value).normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, " ").trim();
}

function normalizedDescription(value: unknown): string {
	if (typeof value !== "string") return "";
	return normalizedText(normalizeDescription(value).fullDescription ?? value);
}

function normalizedURL(value: unknown): string {
	const sanitized = sanitizeEventURL(value);
	if (!sanitized) return typeof value === "string" ? value.trim() : "";
	const url = new URL(sanitized);
	url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
	const parameters = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
	url.search = "";
	for (const [key, parameter] of parameters) url.searchParams.append(key, parameter);
	return url.toString();
}

function semanticTokens(value: unknown, description = false): string[] {
	if (typeof value !== "string") return [];
	const cleaned = description ? normalizeDescription(value).fullDescription ?? value : value;
	const canonicalPhrases = decodeHTMLEntities(cleaned)
		.replace(/\bno\s+([\p{L}\p{N}]+)\s+allowed\b/giu, "$1 prohibited")
		.replace(/\b(?:not allowed|sign[ -]?up|check[ -]?in)\b/giu, (phrase) => ({ "not allowed": "prohibited", "sign up": "signup", "sign-up": "signup", "signup": "signup", "check in": "checkin", "check-in": "checkin", "checkin": "checkin" })[phrase.toLowerCase()] ?? phrase);
	const tokens = normalizedText(canonicalPhrases).split(" ").filter(Boolean).map((word) => WORD_EQUIVALENTS[word] ?? word).filter((word) => !COSMETIC_WORDS.has(word));
	return [...new Set(tokens)].sort();
}

function comparisonValue(field: keyof SourceFacts, value: unknown): unknown {
	if (field === "address") return typeof value === "string" ? normalizeMatchAddress(decodeHTMLEntities(value)) : normalizedText(value);
	if (["title", "venue", "sourceName", "sourceNote", "contactInformation"].includes(field)) return normalizedText(value);
	if (field === "description") return normalizedDescription(value);
	if (["sourceURL", "officialURL", "registrationURL", "organizerWebsiteURL", "officialEventsPageURL"].includes(field)) return normalizedURL(value);
	// Older normalized records predate the explicit confirmed status. Treat the
	// absent legacy value as confirmed so rollout cannot manufacture re-review.
	if (field === "sourceStatus") return value ?? "confirmed";
	if (field === "sequence") return typeof value === "number" && Number.isFinite(value) ? value : null;
	return value ?? null;
}

function materialComparisonValue(field: keyof SourceFacts, value: unknown): unknown {
	if (field === "title") return semanticTokens(value);
	if (field === "description") return semanticTokens(value, true);
	return comparisonValue(field, value);
}

export function sourceRevision(facts: SourceFacts): string {
	const entries = (Object.keys(facts) as Array<keyof SourceFacts>)
		.sort()
		.map((field) => [field, comparisonValue(field, facts[field])] as const)
		.filter(([field, value]) => !(field === "sourceStatus" && value === "confirmed"));
	return stableHash(JSON.stringify(entries));
}

export function compareSourceFacts(previous: SourceFacts, current: SourceFacts): {
	changedFields: string[];
	materialFields: string[];
	cosmeticFields: string[];
} {
	const fields = [...new Set([...Object.keys(previous), ...Object.keys(current)])] as Array<keyof SourceFacts>;
	const changedFields = fields.filter((field) => JSON.stringify(previous[field] ?? null) !== JSON.stringify(current[field] ?? null)).sort();
	const materiallyDifferent = new Set(fields.filter((field) =>
		MATERIAL_FIELDS.has(field)
		&& JSON.stringify(materialComparisonValue(field, previous[field])) !== JSON.stringify(materialComparisonValue(field, current[field]))));
	return {
		changedFields,
		materialFields: changedFields.filter((field) => materiallyDifferent.has(field as keyof SourceFacts)),
		cosmeticFields: changedFields.filter((field) => !materiallyDifferent.has(field as keyof SourceFacts)),
	};
}

export function eventSourceStatus(facts: SourceFacts): "cancelled" | "postponed" | null {
	if (facts.sourceStatus === "cancelled") return "cancelled";
	if (facts.sourceStatus === "postponed") return "postponed";
	return null;
}
