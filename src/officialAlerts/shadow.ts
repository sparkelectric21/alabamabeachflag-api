import { policyFor } from "./policy";

const LEGACY_TERMS = ["rip", "surf", "coastal", "hurricane", "tropical", "storm surge", "marine", "beach", "flood", "thunderstorm", "lightning", "tornado"];
export function compareLegacyPolicy(event: string): { legacyIncluded: boolean; backendIncluded: boolean; difference: string | null } {
	const lower = event.toLowerCase();
	const legacyIncluded = LEGACY_TERMS.some((term) => lower.includes(term)) && lower !== "flood warning" && !lower.includes("river flood");
	const backendIncluded = policyFor(event) !== null;
	return { legacyIncluded, backendIncluded, difference: legacyIncluded === backendIncluded ? null : backendIncluded ? "backend_only_explicit_policy" : "legacy_only_broad_substring" };
}
