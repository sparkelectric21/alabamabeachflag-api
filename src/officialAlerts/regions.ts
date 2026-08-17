import type { AbfRegionId } from "./types";

export interface AbfAlertRegion {
	id: AbfRegionId;
	displayName: string;
	queryPoint: { latitude: number; longitude: number };
	polygon: { type: "Polygon"; coordinates: number[][][] };
}
/**
 * Version 1. Conservative WGS84 shoreline boxes surrounding each user-facing
 * ABF region. They are not jurisdiction boundaries. NWS point-query membership
 * is authoritative in Phase 1; polygons are versioned metadata for fixtures,
 * diagnostics, and a later authoritative-boundary replacement.
 */
export const ABF_ALERT_REGION_VERSION = "2026-08-17.v1";
export const ABF_ALERT_REGIONS: readonly AbfAlertRegion[] = [
	{ id: "gulfShores", displayName: "Gulf Shores", queryPoint: { latitude: 30.248332, longitude: -87.688653 }, polygon: { type: "Polygon", coordinates: [[[-87.76,30.21],[-87.62,30.21],[-87.62,30.29],[-87.76,30.29],[-87.76,30.21]]] } },
	{ id: "orangeBeach", displayName: "Orange Beach", queryPoint: { latitude: 30.269777, longitude: -87.582456 }, polygon: { type: "Polygon", coordinates: [[[-87.64,30.22],[-87.52,30.22],[-87.52,30.32],[-87.64,30.32],[-87.64,30.22]]] } },
	{ id: "fortMorgan", displayName: "Fort Morgan", queryPoint: { latitude: 30.229833, longitude: -87.831410 }, polygon: { type: "Polygon", coordinates: [[[-88.02,30.20],[-87.75,30.20],[-87.75,30.27],[-88.02,30.27],[-88.02,30.20]]] } },
	{ id: "dauphinIsland", displayName: "Dauphin Island", queryPoint: { latitude: 30.250144, longitude: -88.127458 }, polygon: { type: "Polygon", coordinates: [[[-88.34,30.20],[-88.05,30.20],[-88.05,30.29],[-88.34,30.29],[-88.34,30.20]]] } },
] as const;

export function isAbfRegionId(value: string): value is AbfRegionId {
	return ABF_ALERT_REGIONS.some((region) => region.id === value);
}
