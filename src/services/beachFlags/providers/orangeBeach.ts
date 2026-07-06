import { BeachFlagColor, BeachFlagProviderResult } from "../types";
import { fetchWithRetry } from "../../../utils/http";

const ORANGE_BEACH_URL = "https://www.orangebeachal.gov/170/Beach-Safety-Mollys-Patrol";

const ORANGE_BEACH_IDS = [
	"cotton-bayou",
	"alabama-point",
	"florida-point",
];

function stripHtml(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&rsquo;/gi, "’")
		.replace(/&#39;/gi, "'")
		.replace(/&apos;/gi, "'")
		.replace(/&ldquo;/gi, "\"")
		.replace(/&rdquo;/gi, "\"")
		.replace(/\s+/g, " ")
		.trim();
}

function extractDailyReportHtml(html: string): string {
	const start = html.search(/Orange Beach Daily Beach Report/i);

	if (start < 0) {
		return html;
	}

	const remaining = html.slice(start);
	const end = remaining.search(/Sign up to receive daily beach conditions/i);

	if (end < 0) {
		return remaining;
	}

	return remaining.slice(0, end);
}

function valueAfter(text: string, label: string): string | null {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = text.match(
		new RegExp(
			`${escaped}:?\\s*(.*?)(?=Gulf Temperature|Surf Conditions|Rip Current Forecast|Daily Weather|Wind|UV Index|Tides|$)`,
			"i",
		),
	);

	return match?.[1]?.trim() ?? null;
}

function flagValue(text: string): string | null {
	const match = text.match(
		/Today[’']s Flag Color:?\s*(.*?)(?=Gulf Temperature|Surf Conditions|Rip Current Forecast|Daily Weather|Wind|UV Index|Tides|$)/i,
	);

	return match?.[1]?.trim() ?? null;
}

function flagValueFromHtml(html: string): string | null {
	const match = html.match(/<li>\s*<strong>\s*Today[’'&a-zA-Z#0-9;]*s Flag Color:\s*(?:&nbsp;)?\s*<\/strong>\s*([\s\S]*?)<\/li>/i);

	return match?.[1] ? stripHtml(match[1]) : null;
}

function parseFlag(value: string | null): BeachFlagColor | null {
	const text = (value ?? "").toLowerCase();

	if (text.includes("double red")) {
		return "doubleRed";
	}

	if (text.includes("single red") || text.includes("red flag")) {
		return "red";
	}

	if (text.includes("yellow")) {
		return "yellow";
	}

	if (text.includes("green")) {
		return "green";
	}

	return null;
}

export async function getOrangeBeachFlags(generatedAt: string): Promise<BeachFlagProviderResult> {
	const response = await fetchWithRetry(ORANGE_BEACH_URL, {
		label: "Orange Beach Flags",
	});

	if (!response.ok) {
		return {
			reports: [],
			errors: [
				{
					beachId: "orange-beach",
					displayName: "Orange Beach",
					message: `Failed to fetch Orange Beach (${response.status})`,
				},
			],
		};
	}

	const html = await response.text();
	const reportHtml = extractDailyReportHtml(html);
	const text = stripHtml(reportHtml);
	const normalizedText = text.toLowerCase();
	const primaryFlag = parseFlag(flagValueFromHtml(reportHtml) ?? flagValue(text));

	if (!primaryFlag) {
		return {
			reports: [],
			errors: ORANGE_BEACH_IDS.map((beachId) => ({
				beachId,
				displayName: beachId,
				message: "Orange Beach response did not contain a recognized flag status.",
			})),
		};
	}

	return {
		reports: ORANGE_BEACH_IDS.map((beachId) => ({
			beachId,
			displayName: beachId
				.split("-")
				.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
				.join(" "),
			primaryFlag,
			hasPurpleFlag:
				normalizedText.includes("purple flag") ||
				normalizedText.includes("dangerous marine life"),
			lastUpdated: generatedAt,
			sourceType: "official",
			sourceName: "City of Orange Beach",
		})),
		errors: [],
	};
}
