

import type { SpreadsheetRow } from "./parser";

export interface WaterQualityRecord {
	beachName: string;
	sampleDate: string | null;
	enterococcus: number | null;
	status: "excellent" | "elevated" | "advisory" | "unavailable";
}

export function mapWaterQuality(rows: SpreadsheetRow[]): WaterQualityRecord[] {
	return rows.map((row) => {
		const beachName = String(
			row["Beach"] ?? row["Beach Name"] ?? row["Location"] ?? "Unknown",
		).trim();

		const sampleDate = row["Date"] ? String(row["Date"]) : null;

		const rawValue = Number(
			row["Enterococcus"] ?? row["ENT"] ?? row["Result"] ?? NaN,
		);

		const enterococcus = Number.isFinite(rawValue) ? rawValue : null;

		let status: WaterQualityRecord["status"] = "unavailable";

		if (enterococcus !== null) {
			if (enterococcus < 35) {
				status = "excellent";
			} else if (enterococcus < 104) {
				status = "elevated";
			} else {
				status = "advisory";
			}
		}

		return {
			beachName,
			sampleDate,
			enterococcus,
			status,
		};
	});
}