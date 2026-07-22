import { CONTENT_TYPES, UPSTREAM_LIMITS, validateOrangeBeachUrl } from "../config/upstreamSecurity";
import { fetchWithRetry, readResponseText } from "../utils/http";

const SOURCE_URL = "https://www.orangebeachal.gov/170/Beach-Safety-Mollys-Patrol";

export interface OrangeBeachOfficialState { primaryFlag: "green" | "yellow" | "red" | "doubleRed"; hasPurpleFlag: boolean }

function decodeText(value: string): string {
	return value.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&")
		.replace(/&(?:rsquo|apos);|&#39;/gi, "'").replace(/\s+/g, " ").trim();
}

export function parseOfficialOrangeBeachHtml(html: string): OrangeBeachOfficialState {
	const heading = html.search(/Orange Beach Daily Beach Report/i);
	if (heading < 0) throw new Error("official_source_format_changed");
	const after = html.slice(heading);
	const boundary = after.search(/Sign up to receive daily beach conditions/i);
	if (boundary < 0) throw new Error("official_source_format_changed");
	const report = decodeText(after.slice(0, boundary));
	const match = report.match(/Today['’]s Flag Color\s*:?\s*(.+?)(?=Gulf Temperature|Surf Conditions|Rip Current Forecast|Daily Weather|Wind|UV Index|Tides)/i);
	if (!match?.[1]) throw new Error("official_source_format_changed");
	const value = match[1].toLowerCase();
	const primaryFlag = value.includes("double red") ? "doubleRed"
		: value.includes("single red") || /\bred flag\b/.test(value) ? "red"
		: value.includes("yellow") ? "yellow" : value.includes("green") ? "green" : null;
	if (!primaryFlag) throw new Error("unrecognized_flag_value");
	return { primaryFlag, hasPurpleFlag: /purple flag|dangerous marine life/i.test(report) };
}

export async function readOfficialOrangeBeachState(): Promise<OrangeBeachOfficialState> {
	const response = await fetchWithRetry(SOURCE_URL, { label: "Orange Beach Verification", validateUrl: validateOrangeBeachUrl });
	if (!response.ok) throw new Error("official_source_unavailable");
	const html = await readResponseText(response, { maxBytes: UPSTREAM_LIMITS.municipalHtmlBytes, contentTypes: CONTENT_TYPES.html });
	return parseOfficialOrangeBeachHtml(html);
}
