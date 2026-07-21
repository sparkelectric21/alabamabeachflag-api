import { CONTENT_TYPES, UPSTREAM_LIMITS, validateGulfShoresUrl } from "../config/upstreamSecurity";
import { fetchWithRetry, readResponseText } from "../utils/http";

const SOURCE_URL = "https://www.gulfshoresal.gov/1136/Beach-Safety";
const STATES: Record<string, { primaryFlag: string; hasPurpleFlag: boolean }> = {
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

export async function readOfficialGulfShoresState() {
	const response = await fetchWithRetry(SOURCE_URL, {
		label: "Gulf Shores Verification",
		validateUrl: validateGulfShoresUrl,
	});
	if (!response.ok) throw new Error("official_source_unavailable");
	const html = await readResponseText(response, {
		maxBytes: UPSTREAM_LIMITS.municipalHtmlBytes,
		contentTypes: CONTENT_TYPES.html,
	});
	const section = extractElementById(html, "surfTS");
	const id = section?.match(/documentID=(\d+)/i)?.[1];
	const state = id ? STATES[id] : undefined;
	if (!state) throw new Error("official_source_format_changed");
	return state;
}
