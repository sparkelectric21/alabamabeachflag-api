export type TideDirection = "rising" | "falling";
export type TideEventType = "high" | "low";

export interface TidePredictionPoint {
	time: string;
	height: number;
}

export interface TideEvent extends TidePredictionPoint {
	type: TideEventType;
}

export interface TidePrediction {
	stationId: string;
	stationName: string;
	stationType: "harmonic" | "subordinate";
	predictionDate: string;
	timeZone: "America/Chicago";
	datum: "MLLW";
	units: "feet";
	points: TidePredictionPoint[];
	events: TideEvent[];
	direction?: TideDirection;
	nextEvent?: TideEvent;
	fetchedAt: string;
	stationUrl: string;
}
