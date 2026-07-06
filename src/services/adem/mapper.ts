import type { WaterQualityStatus } from "../../models/WaterQuality";
import type { SpreadsheetRow } from "./parser";

export interface LatestSample {
	sampleDate: string | null;
	enterococcus: number | null;
	advisory: boolean;
	status: WaterQualityStatus;
	rawEnterococcus: string | null;
}

function normalizeCell(cell: unknown): string {
	return String(cell ?? "").trim();
}

function isSampleDate(value: string): boolean {
	return /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(value);
}

function normalizeSampleDate(value: string): string {
	const [month, day, year] = value.split("/");
	const fullYear = year.length === 2 ? `20${year}` : year;

	return `${fullYear}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function sampleDateTimestamp(value: string): number {
	return new Date(`${normalizeSampleDate(value)}T00:00:00Z`).getTime();
}

function parseEnterococcus(row: SpreadsheetRow): {
	value: number | null;
	raw: string | null;
} {
	const qualifier = normalizeCell(row[2]);
	const result = normalizeCell(row[3]);

	if (!result || /site closed/i.test(result) || /n\/a/i.test(result)) {
		return { value: null, raw: result || null };
	}

	const raw = `${qualifier}${result}`.trim();
	const match = result.match(/\d+(?:\.\d+)?/);

	if (!match) {
		return { value: null, raw };
	}

	return {
		value: Number(match[0]),
		raw,
	};
}

function statusForEnterococcus(value: number | null): WaterQualityStatus {
	if (value === null) {
		return "unavailable";
	}

	if (value < 35) {
		return "excellent";
	}

	if (value < 104) {
		return "elevated";
	}

	return "advisory";
}

export function extractLatestSample(rows: SpreadsheetRow[]): LatestSample {
	let latest: LatestSample | null = null;
	let latestTimestamp = Number.NEGATIVE_INFINITY;

	for (const row of rows) {
		const firstCell = normalizeCell(row[0]);

		if (!isSampleDate(firstCell)) {
			continue;
		}

		const timestamp = sampleDateTimestamp(firstCell);

		if (Number.isNaN(timestamp) || timestamp <= latestTimestamp) {
			continue;
		}

		const parsed = parseEnterococcus(row);
		const status = statusForEnterococcus(parsed.value);

		latest = {
			sampleDate: normalizeSampleDate(firstCell),
			enterococcus: parsed.value,
			advisory: status === "advisory",
			status,
			rawEnterococcus: parsed.raw,
		};
		latestTimestamp = timestamp;
	}

	return latest ?? {
		sampleDate: null,
		enterococcus: null,
		advisory: false,
		status: "unavailable",
		rawEnterococcus: null,
	};
}
