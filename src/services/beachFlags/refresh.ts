

import { BeachFlagReport } from "./types";
import { getDauphinIslandFlags } from "./providers/dauphinIsland";
import { getFortMorganFlags } from "./providers/fortMorgan";
import { getGulfShoresFlags } from "./providers/gulfshores";
import { getOrangeBeachFlags } from "./providers/orangeBeach";
import { elapsedMs, logError, logInfo } from "../../utils/logger";
import { API_VERSION } from "../../config/version";

export async function buildBeachFlagsPayload() {
	const startedAt = Date.now();
	logInfo("Flags", "Starting refresh");
	try {
		const generatedAt = new Date().toISOString();

		const gulfShores = await getGulfShoresFlags(generatedAt);
		const orangeBeach = await getOrangeBeachFlags(generatedAt);
		const dauphinIsland = await getDauphinIslandFlags();

		const gulfReference = gulfShores.reports.find(
			(report) => report.beachId === "gulf-shores-public-beach",
		);

		const fortMorgan = getFortMorganFlags(generatedAt, gulfReference);

		const beachFlags: BeachFlagReport[] = [
			...gulfShores.reports,
			...orangeBeach.reports,
			...fortMorgan,
			...dauphinIsland.reports,
		];

		const errors = [
			...gulfShores.errors,
			...orangeBeach.errors,
			...dauphinIsland.errors,
		];

		const payload = {
			status: beachFlags.length > 0 ? "ok" : "unavailable",
			apiVersion: API_VERSION,
			source: "Official municipal beach flag sources",
			generatedAt,
			lastSuccessfulRefresh: generatedAt,
			count: beachFlags.length,
			beachFlags,
			errors,
		};

		logInfo("Flags", "Finished refresh", {
			durationMs: elapsedMs(startedAt),
			count: beachFlags.length,
			errors: errors.length,
		});
		return payload;
	} catch (error) {
		logError("Flags", "Refresh failed", {
			error: error instanceof Error ? error.message : String(error),
			durationMs: elapsedMs(startedAt),
		});
		throw error;
	}
}
