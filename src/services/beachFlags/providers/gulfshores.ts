import { BeachFlagColor, BeachFlagProviderResult } from "../types";
import { CONTENT_TYPES, UPSTREAM_LIMITS, validateGulfShoresUrl } from "../../../config/upstreamSecurity";
import { fetchWithRetry, readResponseText } from "../../../utils/http";

const GULF_SHORES_URL = "https://www.gulfshoresal.gov/1136/Beach-Safety";

const GULF_SHORES_IDS = [
	"gulf-shores-public-beach",
	"gulf-state-park-pavilion",
	"little-lagoon-pass",
];

type GulfShoresFlagState = {
	primaryFlag: BeachFlagColor;
	hasPurpleFlag: boolean;
};

// These IDs are the City of Gulf Shores' paired normal/hover condition graphics
// in ImageRepository (3006-3023). They are read only from #surfTS so the static
// educational flag images elsewhere on the page can never become live status.
const FLAG_STATE_BY_IMAGE_DOCUMENT_ID: Record<string, GulfShoresFlagState> = {
	"3006": { primaryFlag: "doubleRed", hasPurpleFlag: false },
	"3007": { primaryFlag: "doubleRed", hasPurpleFlag: false },
	// Current CivicPlus replacement pair for "Closed to Public" (July 21, 2026).
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

function stripHtml(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/\s+/g, " ")
		.trim();
}

function extractElementById(html: string, id: string): string | null {
	const openingTag = new RegExp(`<div\\b[^>]*\\bid=["']${id}["'][^>]*>`, "i");
	const start = html.search(openingTag);

	if (start < 0) {
		return null;
	}

	const divTag = /<\/?div\b[^>]*>/gi;
	divTag.lastIndex = start;
	let depth = 0;
	let match: RegExpExecArray | null;

	while ((match = divTag.exec(html))) {
		depth += /^<\/div/i.test(match[0]) ? -1 : 1;

		if (depth === 0) {
			return html.slice(start, divTag.lastIndex);
		}
	}

	return null;
}

function currentConditionsImage(html: string): { documentId: string | null; semanticText: string } | null {
	const surfConditions = extractElementById(html, "surfTS");

	if (!surfConditions) {
		return null;
	}

	const imageMatch = surfConditions.match(/<img\b[^>]*>/i);
	const imageTag = imageMatch?.[0] ?? "";
	const documentId = imageTag.match(
		/\bsrc=["'][^"']*\/ImageRepository\/Document\?[^"']*\bdocumentID=(\d+)[^"']*["']/i,
	)?.[1] ?? null;
	const semanticText = Array.from(
		imageTag.matchAll(/\b(?:alt|title|aria-label|data-title|data-description)=["']([^"']*)["']/gi),
		(match) => match[1],
	).join(" ");

	return { documentId, semanticText };
}

function extractCurrentConditionsText(html: string): string {
	const htmlMatch = html.match(
		/Surf Conditions:\s*<\/p>((?:\s*<p[^>]*>[\s\S]*?<\/p>){1,2})/i,
	);

	if (htmlMatch?.[1]) {
		return `Surf Conditions: ${stripHtml(htmlMatch[1])}`;
	}

	const text = stripHtml(html);
	const start = text.search(/Surf Conditions:/i);

	if (start < 0) {
		return "";
	}

	const section = text.slice(start, start + 160);
	const end = section.search(/Search Home|Residents|Beaches Beach Safety/i);

	if (end > 0) {
		return section.slice(0, end).trim();
	}

	return section.trim();
}

function flagFromHazard(text: string): BeachFlagColor | null {
	const normalized = text.toLowerCase();

	if (normalized.includes("double red") || normalized.includes("water closed")) {
		return "doubleRed";
	}

	if (normalized.includes("high hazard") || normalized.includes("red flag")) {
		return "red";
	}

	if (normalized.includes("medium hazard") || normalized.includes("yellow flag")) {
		return "yellow";
	}

	if (normalized.includes("low hazard") || normalized.includes("green flag")) {
		return "green";
	}

	return null;
}

export async function getGulfShoresFlags(generatedAt: string): Promise<BeachFlagProviderResult> {
	const response = await fetchWithRetry(GULF_SHORES_URL, {
		label: "Gulf Shores Flags",
		validateUrl: validateGulfShoresUrl,
	});

	if (!response.ok) {
		return {
			reports: [],
			errors: [
				{
					beachId: "gulf-shores",
					displayName: "Gulf Shores",
						message: "provider_unavailable",
				},
			],
		};
	}

	const html = await readResponseText(response, {
		maxBytes: UPSTREAM_LIMITS.municipalHtmlBytes,
		contentTypes: CONTENT_TYPES.html,
	});
	const currentImage = currentConditionsImage(html);
	const imageFlagState = currentImage?.documentId
		? FLAG_STATE_BY_IMAGE_DOCUMENT_ID[currentImage.documentId]
		: null;
	const currentConditionsText = currentImage?.semanticText || extractCurrentConditionsText(html);
	const normalizedConditions = currentConditionsText.toLowerCase();
	const semanticFlag = flagFromHazard(currentConditionsText);
	// Explicit active-status semantics win over IDs. flagFromHazard checks Double Red
	// first, preventing a stale/lower-precedence ID from downgrading a closure.
	const primaryFlag = semanticFlag ?? imageFlagState?.primaryFlag ?? null;

	if (!primaryFlag) {
		return {
			reports: [],
			errors: GULF_SHORES_IDS.map((beachId) => ({
				beachId,
				displayName: beachId,
				message: "provider_unavailable",
			})),
		};
	}

	const reportData = {
		primaryFlag,
		hasPurpleFlag: primaryFlag === "doubleRed" ? false : imageFlagState?.hasPurpleFlag ?? (
			normalizedConditions.includes("purple flag") ||
			normalizedConditions.includes("dangerous marine life")
		),
		lastUpdated: generatedAt,
		sourceType: "official" as const,
		sourceName: "City of Gulf Shores",
	};

	return {
		reports: GULF_SHORES_IDS.map((beachId) => ({
			beachId,
			displayName: beachId
				.split("-")
				.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
				.join(" "),
			...reportData,
		})),
		errors: [],
	};
}
