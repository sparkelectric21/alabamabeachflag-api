import { elapsedMs, logError, logInfo } from "../../utils/logger";
import { getLatestWaterQuality } from "../adem/service";
import { API_VERSION } from "../../config/version";

export interface WaterQualityCachePayload {
	status: "ok";
	apiVersion: typeof API_VERSION;
	source: "ADEM";
	generatedAt: string;
	lastSuccessfulRefresh: string;
	count: number;
	waterQuality: Awaited<ReturnType<typeof getLatestWaterQuality>>;
}

export async function buildWaterQualityPayload(): Promise<WaterQualityCachePayload> {
	const startedAt = Date.now();
	logInfo("Water Quality", "Starting refresh");
	try {
		const waterQuality = await getLatestWaterQuality();

		const refreshedAt = new Date().toISOString();

		const payload: WaterQualityCachePayload = {
			status: "ok",
			apiVersion: API_VERSION,
			source: "ADEM",
			generatedAt: refreshedAt,
			lastSuccessfulRefresh: refreshedAt,
			count: waterQuality.length,
			waterQuality,
		};

		logInfo("Water Quality", "Finished refresh", {
			durationMs: elapsedMs(startedAt),
			count: waterQuality.length,
		});
		return payload;
	} catch (error) {
		logError("Water Quality", "Refresh failed", {
			error: error instanceof Error ? error.message : String(error),
			durationMs: elapsedMs(startedAt),
		});
		throw error;
	}
}
