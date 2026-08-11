import { CONTENT_TYPES, UPSTREAM_LIMITS, validateGulfShoresUrl } from "../config/upstreamSecurity";
import { fetchWithRetry, readResponseText } from "../utils/http";

const SOURCE_URL = "https://www.gulfshoresal.gov/1136/Beach-Safety";
type OfficialGulfShoresState = { primaryFlag: string; hasPurpleFlag: boolean };

const STATES: Record<string, OfficialGulfShoresState> = {
	"3006": { primaryFlag: "doubleRed", hasPurpleFlag: false },
	"3007": { primaryFlag: "doubleRed", hasPurpleFlag: false },
	// CivicPlus replacement pair for "Closed to Public" observed July 21, 2026.
	"4339": { primaryFlag: "doubleRed", hasPurpleFlag: false },
	"4340": { primaryFlag: "doubleRed", hasPurpleFlag: false },
	"3010": { primaryFlag: "red", hasPurpleFlag: false },
	"3011": { primaryFlag: "red", hasPurpleFlag: true },
	"3012": { primaryFlag: "green", hasPurpleFlag: true },
	"3013": { primaryFlag: "green", hasPurpleFlag: true },
	"3014": { primaryFlag: "green", hasPurpleFlag: false },
	"3015": { primaryFlag: "green", hasPurpleFlag: false },
	"3016": { primaryFlag: "yellow", hasPurpleFlag: true },
	"3017": { primaryFlag: "yellow", hasPurpleFlag: true },
	"3018": { primaryFlag: "red", hasPurpleFlag: false },
	"3019": { primaryFlag: "red", hasPurpleFlag: true },
	"3020": { primaryFlag: "yellow", hasPurpleFlag: true },
	"3021": { primaryFlag: "yellow", hasPurpleFlag: true },
	"3022": { primaryFlag: "yellow", hasPurpleFlag: false },
	"3023": { primaryFlag: "yellow", hasPurpleFlag: false },
};

function extractElementById(html: string, id: string): string | null {
	const openingTag = new RegExp(`<div\\b[^>]*\\bid=["']${id}["'][^>]*>`, "i");
	const start = html.search(openingTag);
	if (start < 0) return null;

	const divTag = /<\/?div\b[^>]*>/gi;
	divTag.lastIndex = start;
	let depth = 0;
	let match: RegExpExecArray | null;
	while ((match = divTag.exec(html))) {
		depth += /^<\/div/i.test(match[0]) ? -1 : 1;
		if (depth === 0) return html.slice(start, divTag.lastIndex);
	}
	return null;
}

function visibleText(html: string): string {
	return html
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;|&#160;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/\s+/g, " ")
		.trim();
}

function semanticState(section: string): OfficialGulfShoresState | null {
	const text = visibleText(section);
	let primaryFlag: string | null = null;
	if (/\b(?:water\s+(?:is\s+)?closed|water\s+closure|closed\s+to\s+(?:the\s+)?public|double\s+red)\b/i.test(text)) {
		primaryFlag = "doubleRed";
	} else if (/\bhigh\s+hazard\b/i.test(text)) {
		primaryFlag = "red";
	} else if (/\bmedium\s+hazard\b/i.test(text)) {
		primaryFlag = "yellow";
	} else if (/\blow\s+hazard\b/i.test(text)) {
		primaryFlag = "green";
	}
	if (!primaryFlag) return null;
	return {
		primaryFlag,
		hasPurpleFlag: primaryFlag === "doubleRed"
			? false
			: /\b(?:purple\s+flag|dangerous\s+marine\s+life)\b/i.test(text),
	};
}

function legacyImageState(section: string): OfficialGulfShoresState | null {
	for (const match of section.matchAll(/<img\b[^>]*>/gi)) {
		const id = match[0].match(
			/\bsrc=["'][^"']*\/ImageRepository\/Document\?[^"']*\bdocumentID=(\d+)[^"']*["']/i,
		)?.[1];
		if (id && STATES[id]) return STATES[id];
	}
	return null;
}

export function parseOfficialGulfShoresState(html: string): OfficialGulfShoresState {
	const section = extractElementById(html, "surfTS");
	const state = section ? semanticState(section) ?? legacyImageState(section) : null;
	if (!state) throw new Error("official_source_format_changed");
	return state;
}

export async function readOfficialGulfShoresState() {
	let html: string;
	try {
		const response = await fetchWithRetry(SOURCE_URL, {
			label: "Gulf Shores Verification",
			validateUrl: validateGulfShoresUrl,
		});
		if (!response.ok) throw new Error("upstream_non_success");
		html = await readResponseText(response, {
			maxBytes: UPSTREAM_LIMITS.municipalHtmlBytes,
			contentTypes: CONTENT_TYPES.html,
		});
	} catch {
		throw new Error("official_source_unavailable");
	}
	return parseOfficialGulfShoresState(html);
}
