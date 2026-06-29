import { BeachFlagColor, BeachFlagProviderResult } from "../types";

const GULF_SHORES_URL = "https://www.gulfshoresal.gov/1136/Beach-Safety";

const GULF_SHORES_IDS = [
	"gulf-shores-public-beach",
	"gulf-state-park-pavilion",
	"little-lagoon-pass",
];

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

function extractCurrentConditionsText(html: string): string {
	const htmlMatch = html.match(/Surf Conditions:\s*<\/p>\s*<p[^>]*>([\s\S]*?)<\/p>/i);

	if (htmlMatch?.[1]) {
		return `Surf Conditions: ${stripHtml(htmlMatch[1])}`;
	}

	const text = stripHtml(html);
	const start = text.search(/Surf Conditions:/i);

	if (start < 0) {
		return text;
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

	if (normalized.includes("water closed")) {
		return "doubleRed";
	}

	if (normalized.includes("medium hazard") || normalized.includes("yellow flag")) {
		return "yellow";
	}

	if (normalized.includes("low hazard") || normalized.includes("green flag")) {
		return "green";
	}

	if (normalized.includes("high hazard") || normalized.includes("red flag")) {
		return "red";
	}

	if (normalized.includes("double red")) {
		return "doubleRed";
	}

	return null;
}

export async function getGulfShoresFlags(generatedAt: string): Promise<BeachFlagProviderResult> {
	const response = await fetch(GULF_SHORES_URL);

	if (!response.ok) {
		return {
			reports: [],
			errors: [
				{
					beachId: "gulf-shores",
					displayName: "Gulf Shores",
					message: `Failed to fetch Gulf Shores flags (${response.status})`,
				},
			],
		};
	}

	const html = await response.text();
	const currentConditionsText = extractCurrentConditionsText(html);
	const primaryFlag = flagFromHazard(currentConditionsText);

	const reportData = {
		primaryFlag,
		hasPurpleFlag: currentConditionsText.toLowerCase().includes("purple flag") || currentConditionsText.toLowerCase().includes("dangerous marine life"),
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