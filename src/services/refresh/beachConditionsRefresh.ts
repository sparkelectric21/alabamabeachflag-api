import { normalizeWeatherCondition } from "../weather/normalizeWeatherCondition";
import { beaches as BEACH_REGISTRY } from "../../config/BeachRegistry";
import { fetchForecast, fetchPoint } from "../nws/client";
import { refreshWaterTemperatureSelections } from "../waterTemperature/refresh";
import type { WaterTemperatureResults } from "../waterTemperature/refresh";
import { getBeachForecasts } from "../beachForecast/service";
import { fetchCurrentUV } from "../beachForecast/openMeteoClient";
import { elapsedMs, logError, logInfo, logWarn } from "../../utils/logger";
import type { BeachForecast } from "../../models/BeachConditions";
import type { NWSForecastResponse } from "../nws/client";
import { API_VERSION } from "../../config/version";
import { estimateVibrioConditions } from "../vibrio/estimator";
import { fetchTidePrediction } from "../tide/service";
import type { TidePrediction } from "../tide/models";
import type { ProviderHealthObservation } from "../../providerHealth/types";

interface BeachConditionsRefreshDependencies {
	refreshWaterTemperatureSelections: typeof refreshWaterTemperatureSelections;
	getBeachForecasts: typeof getBeachForecasts;
	getTidePredictions: typeof getTidePredictions;
	fetchCurrentUV: typeof fetchCurrentUV;
	fetchPoint: typeof fetchPoint;
	fetchForecast: typeof fetchForecast;
}

interface BeachConditionsRefreshOptions {
	vibrioConditionsEnabled?: boolean;
	now?: Date;
	dependencies?: Partial<BeachConditionsRefreshDependencies>;
}

async function safeFetchCurrentUV(
	latitude: number,
	longitude: number,
	fetchUV: typeof fetchCurrentUV = fetchCurrentUV,
): Promise<number | undefined> {
	try {
		const value = await fetchUV(latitude, longitude);
		return value == null ? undefined : Math.round(value);
	} catch (error) {
		logError("Beach Conditions", "Open-Meteo UV failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

function getUVCategory(uv: number | undefined): string | undefined {
	if (uv === undefined) {
		return undefined;
	}

	if (uv < 3) {
		return "Low";
	}

	if (uv < 6) {
		return "Moderate";
	}

	if (uv < 8) {
		return "High";
	}

	if (uv < 11) {
		return "Very High";
	}

	return "Extreme";
}

async function safeGetBeachForecasts(fetchForecasts: typeof getBeachForecasts = getBeachForecasts): Promise<Map<string, BeachForecast>> {
	try {
		return await fetchForecasts();
	} catch (error) {
		logError("Beach Conditions", "NOAA beach forecast failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return new Map();
	}
}

async function getTidePredictions(now: Date): Promise<Map<string, TidePrediction>> {
	const results = new Map<string, TidePrediction>();
	const requests = new Map<string, Promise<TidePrediction>>();
	await Promise.all(BEACH_REGISTRY.map(async (beach) => {
		if (!beach.tide) return;
		const key = `${beach.tide.stationId}:${beach.tide.stationType}`;
		let request = requests.get(key);
		if (!request) {
			request = fetchTidePrediction(beach.tide, now);
			requests.set(key, request);
		}
		try {
			results.set(beach.id, await request);
		} catch (error) {
			logWarn("Beach Conditions", "NOAA tide prediction failed", {
				beachId: beach.id, stationId: beach.tide.stationId, stationType: beach.tide.stationType,
				reason: "events_unavailable",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}));
	return results;
}

async function mapWithConcurrency<T, R>(
	values: T[],
	limit: number,
	mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(values.length);
	let nextIndex = 0;

	async function worker(): Promise<void> {
		while (nextIndex < values.length) {
			const index = nextIndex++;
			results[index] = await mapper(values[index], index);
		}
	}

	await Promise.all(
		Array.from({ length: Math.min(limit, values.length) }, () => worker()),
	);
	return results;
}

export async function buildBeachConditionsPayload(options: BeachConditionsRefreshOptions = {}) {
	const startedAt = Date.now();
	const generatedAt = options.now ?? new Date();
	const dependencies: BeachConditionsRefreshDependencies = {
		refreshWaterTemperatureSelections,
		getBeachForecasts,
		getTidePredictions,
		fetchCurrentUV,
		fetchPoint,
		fetchForecast,
		...options.dependencies,
	};
	logInfo("Beach Conditions", "Starting refresh");

	const [orangeBeachUV, fortMorganUV, dauphinIslandUV] = await Promise.all([
		safeFetchCurrentUV(30.248108, -87.71726, dependencies.fetchCurrentUV),
		safeFetchCurrentUV(30.2285, -88.0243, dependencies.fetchCurrentUV),
		safeFetchCurrentUV(30.2506, -88.1096, dependencies.fetchCurrentUV),
	]);
	const regionalUV = {
		orangeBeach: orangeBeachUV,
		fortMorgan: fortMorganUV,
		dauphinIsland: dauphinIslandUV,
	};

	logInfo("Beach Conditions", "Regional UV refreshed", {
		orangeBeach: regionalUV.orangeBeach,
		fortMorgan: regionalUV.fortMorgan,
		dauphinIsland: regionalUV.dauphinIsland,
	});

	const beachConditions: Array<{
		beachId: string;
		displayName: string;
		temperature?: number;
		temperatureUnit?: string;
		condition: string | undefined;
		windSpeed?: string;
		windDirection?: string;
		waterTemperature: WaterTemperatureResults[string] | null;
		forecast: BeachForecast | null;
		tide?: TidePrediction;
		vibrioConditions?: ReturnType<typeof estimateVibrioConditions>;
	}> = [];
	const errors: Array<{
		beachId: string;
		displayName: string;
		message: string;
	}> = [];
	const [waterTemperatureSelections, beachForecasts, tidePredictions] = await Promise.all([
		dependencies.refreshWaterTemperatureSelections(),
		safeGetBeachForecasts(dependencies.getBeachForecasts),
		dependencies.getTidePredictions(generatedAt),
	]);
	const waterTemperatures = waterTemperatureSelections.general;
	const vibrioWaterTemperatures = waterTemperatureSelections.vibrio;
	const weatherRequests = new Map<string, Promise<NWSForecastResponse | undefined>>();
	let nwsFailureCount = 0;

	await mapWithConcurrency(BEACH_REGISTRY, 4, async (beach, beachIndex) => {
		const weatherKey = `${beach.weather.latitude},${beach.weather.longitude}`;
		let weatherRequest = weatherRequests.get(weatherKey);

		if (!weatherRequest) {
			weatherRequest = dependencies.fetchPoint(
				beach.weather.latitude,
				beach.weather.longitude,
			).then((point) => dependencies.fetchForecast(point.properties.forecastHourly))
				.then((forecast) => {
					if (!forecast.properties.periods[0]) throw new Error("NWS hourly forecast did not include any periods");
					return forecast;
				})
				.catch((error) => {
					logWarn("Beach Conditions", "Provider domain unavailable", {
						provider: "nws", domain: "hourly_forecast", reason: "request_failed", weatherKey,
						error: error instanceof Error ? error.message : String(error),
					});
					return undefined;
				});
			weatherRequests.set(weatherKey, weatherRequest);
		}

		const forecast = await weatherRequest;
		const current = forecast?.properties.periods[0];
		const beachForecast = beach.beachForecast
			? beachForecasts.get(beach.beachForecast.siteId)
			: undefined;

		const uvValue = beach.uv
			? regionalUV[beach.uv.region]
			: undefined;

		if (!current) {
			nwsFailureCount++;
			errors.push({
				beachId: beach.id,
				displayName: beach.displayName,
				message: "provider_unavailable",
			});
		}

		const vibrioConditions = options.vibrioConditionsEnabled && beach.vibrioConditions.eligible
			? estimateVibrioConditions({
				enabled: true,
				now: generatedAt,
				observation: vibrioWaterTemperatures[beach.id] ? {
					waterTemperature: vibrioWaterTemperatures[beach.id].temperature,
					waterTemperatureUnit: "F",
					observedAt: vibrioWaterTemperatures[beach.id].observedAt,
					provider: vibrioWaterTemperatures[beach.id].provider,
					stationId: vibrioWaterTemperatures[beach.id].stationId,
				} : null,
			})
			: undefined;
		if (vibrioConditions?.diagnosticCode) {
			logWarn("Vibrio Conditions", "Observation unavailable", {
				beachId: beach.id,
				condition: vibrioConditions.diagnosticCode,
				provider: vibrioWaterTemperatures[beach.id]?.provider,
				stationId: vibrioWaterTemperatures[beach.id]?.stationId,
			});
		}
		const publicVibrioConditions = vibrioConditions
			? (({ diagnosticCode: _diagnosticCode, ...result }) => result)(vibrioConditions)
			: undefined;

		beachConditions[beachIndex] = {
			beachId: beach.id,
			displayName: beach.displayName,
			...(current ? {
				temperature: current.temperature,
				temperatureUnit: current.temperatureUnit,
				condition: normalizeWeatherCondition(current.shortForecast),
				windSpeed: current.windSpeed,
				windDirection: current.windDirection,
			} : { condition: undefined }),
			waterTemperature: waterTemperatures[beach.id] ?? null,
			forecast: beach.beachForecast
				? {
					...(beachForecast ?? {}),
					uvValue,
					uvCategory: getUVCategory(uvValue),
				}
				: null,
			...(tidePredictions.get(beach.id) ? { tide: tidePredictions.get(beach.id) } : {}),
			...(publicVibrioConditions ? { vibrioConditions: publicVibrioConditions } : {}),
		};
	});
	const successfulBeachConditions = beachConditions.filter(Boolean);
	const expectedForecasts = BEACH_REGISTRY.filter((beach) => beach.beachForecast).length;
	const expectedTides = BEACH_REGISTRY.filter((beach) => beach.tide).length;
	const expectedWaterTemperatures = BEACH_REGISTRY.filter((beach) => beach.supports.waterTemperature).length;
	const uvFailuresByRegion = new Map<string, number>();
	for (const beach of BEACH_REGISTRY) {
		if (beach.uv && regionalUV[beach.uv.region] === undefined) {
			uvFailuresByRegion.set(beach.uv.region, (uvFailuresByRegion.get(beach.uv.region) ?? 0) + 1);
		}
	}
	const providerHealth: ProviderHealthObservation[] = [
		{ provider: "nws", domain: "hourly_forecast", affectedBeachCount: nwsFailureCount, expectedBeachCount: BEACH_REGISTRY.length, ...(nwsFailureCount ? { errorReason: "request_failed" } : {}) },
		{ provider: "noaa", domain: "marine_beach_forecast", affectedBeachCount: Math.max(0, expectedForecasts - beachForecasts.size), expectedBeachCount: expectedForecasts, ...(beachForecasts.size < expectedForecasts ? { errorReason: "forecast_unavailable" } : {}) },
		{ provider: "noaa", domain: "tide_predictions", affectedBeachCount: Math.max(0, expectedTides - tidePredictions.size), expectedBeachCount: expectedTides, ...(tidePredictions.size < expectedTides ? { errorReason: "events_unavailable" } : {}) },
		{ provider: "water_temperature_sources", domain: "general_selection", affectedBeachCount: Math.max(0, expectedWaterTemperatures - Object.keys(waterTemperatures).length), expectedBeachCount: expectedWaterTemperatures, ...(Object.keys(waterTemperatures).length < expectedWaterTemperatures ? { errorReason: "approved_observation_unavailable" } : {}) },
	];
	for (const [region, affectedBeachCount] of uvFailuresByRegion) {
		providerHealth.push({
			provider: "open_meteo",
			domain: `current_uv:${region}`,
			affectedBeachCount,
			expectedBeachCount: BEACH_REGISTRY.filter((beach) => beach.uv?.region === region).length,
			errorReason: "request_failed",
		});
	}
	for (const region of ["orangeBeach", "fortMorgan", "dauphinIsland"] as const) {
		if (!uvFailuresByRegion.has(region)) providerHealth.push({
			provider: "open_meteo",
			domain: `current_uv:${region}`,
			affectedBeachCount: 0,
			expectedBeachCount: BEACH_REGISTRY.filter((beach) => beach.uv?.region === region).length,
		});
	}

	const payload = {
		status: successfulBeachConditions.length > 0 ? "ok" : "unavailable",
		apiVersion: API_VERSION,
		source: "NOAA",
		generatedAt: generatedAt.toISOString(),
		count: successfulBeachConditions.length,
		beachConditions: successfulBeachConditions,
		errors,
		refreshDiagnostics: {
			expectedBeachCount: BEACH_REGISTRY.length,
			providerFailures: { nws: nwsFailureCount },
			providerHealth,
		},
	};

	logInfo("Beach Conditions", "Finished refresh", {
		durationMs: elapsedMs(startedAt),
		count: successfulBeachConditions.length,
		errors: errors.length,
	});

	return payload;
}
