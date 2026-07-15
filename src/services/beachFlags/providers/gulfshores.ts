import { BeachFlagColor, BeachFlagProviderResult } from "../types";
import { fetchWithRetry } from "../../../utils/http";

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
	const surfConditionsIndex = html.search(/Surf Conditions:/i);

	if (surfConditionsIndex < 0) {
		return "";
	}

	const sectionHtml = html.slice(
		surfConditionsIndex,
		surfConditionsIndex + 2000,
	);

	return stripHtml(
		sectionHtml.replace(
			/<img\b[^>]*\balt=["']([^"']*)["'][^>]*>/gi,
			" $1 ",
		),
	);
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
	});

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
	const normalizedConditions = currentConditionsText.toLowerCase();
	const primaryFlag = flagFromHazard(currentConditionsText);

	if (!primaryFlag) {
		return {
			reports: [],
			errors: GULF_SHORES_IDS.map((beachId) => ({
				beachId,
				displayName: beachId,
				message: "Gulf Shores response did not contain a recognized flag status.",
			})),
		};
	}

	const reportData = {
		primaryFlag,
		hasPurpleFlag:
			normalizedConditions.includes("purple flag") ||
			normalizedConditions.includes("dangerous marine life"),
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
