import { fetchCoopsJson } from "../waterTemperature/coopsClient";
import type { TideEvent, TidePredictionPoint } from "./models";
import { parseNoaaLocalTime } from "./time";

interface RawPrediction { t: string; v: string; type?: string }
interface PredictionResponse { predictions?: RawPrediction[]; error?: { message: string } }

function parsePredictions(raw: RawPrediction[] | undefined, events: boolean): Array<TidePredictionPoint | TideEvent> {
	if (!Array.isArray(raw) || raw.length === 0) throw new Error("NOAA returned empty tide predictions");
	let previous: Date | undefined;
	return raw.map((item) => {
		const time = parseNoaaLocalTime(item.t, previous);
		previous = time;
		const height = Number(item.v);
		if (!Number.isFinite(height)) throw new Error("NOAA returned a nonfinite tide height");
		if (!events) return { time: time.toISOString(), height };
		const type = item.type === "H" ? "high" : item.type === "L" ? "low" : undefined;
		if (!type) throw new Error("NOAA returned an unexpected tide event type");
		return { type, time: time.toISOString(), height };
	});
}

async function request(stationId: string, date: string, interval: "15" | "hilo") {
	return fetchCoopsJson<PredictionResponse>({
		product: "predictions", station: stationId, begin_date: date, end_date: date,
		time_zone: "lst_ldt", datum: "MLLW", units: "english", interval,
	});
}

export async function fetchTideEvents(stationId: string, date: string): Promise<TideEvent[]> {
	return parsePredictions((await request(stationId, date, "hilo")).predictions, true) as TideEvent[];
}

export async function fetchTidePoints(stationId: string, date: string): Promise<TidePredictionPoint[]> {
	return parsePredictions((await request(stationId, date, "15")).predictions, false) as TidePredictionPoint[];
}
