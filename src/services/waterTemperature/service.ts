import type { BeachDefinition } from "../../config/BeachRegistry";
import {
	fetchWaterTemperature,
	type WaterTemperatureObservation,
} from "./client";
import { fetchNDBCWaterTemperature } from "./ndbcClient";

type WaterTemperatureSource = NonNullable<
	BeachDefinition["waterTemperature"]
>["sources"][number];

export interface WaterTemperatureObservationWithSource
	extends WaterTemperatureObservation {
	provider: WaterTemperatureSource["provider"];
	stationId: string;
}

async function fetchFromSource(
	source: WaterTemperatureSource,
): Promise<WaterTemperatureObservationWithSource> {
	const observation =
		source.provider === "coops"
			? await fetchWaterTemperature(source.stationId)
			: await fetchNDBCWaterTemperature(source.stationId);

	return {
		...observation,
		provider: source.provider,
		stationId: source.stationId,
	};
}

export async function fetchLatestWaterTemperature(
	sourceConfig: BeachDefinition["waterTemperature"],
): Promise<WaterTemperatureObservationWithSource> {
	if (!sourceConfig || sourceConfig.sources.length === 0) {
		throw new Error("Water temperature source is not configured.");
	}

	const failures: string[] = [];

	for (const source of sourceConfig.sources) {
		try {
			return await fetchFromSource(source);
		} catch (error) {
			failures.push(
				`${source.provider}:${source.stationId} - ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	throw new Error(
		`No water temperature sources returned valid data. ${failures.join("; ")}`,
	);
}