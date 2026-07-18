import { CONTENT_TYPES, UPSTREAM_LIMITS, validateCoopsUrl } from "../../config/upstreamSecurity";
import { fetchWithRetry, readResponseJson } from "../../utils/http";

const NOAA_COOPS_BASE_URL = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";

export interface CoopsErrorResponse {
	error?: { message: string };
}

export async function fetchCoopsJson<T extends CoopsErrorResponse>(
	parameters: Record<string, string>,
): Promise<T> {
	const url = new URL(NOAA_COOPS_BASE_URL);
	url.searchParams.set("application", "alabama-beach-flag");
	url.searchParams.set("format", "json");
	for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);

	const response = await fetchWithRetry(url.toString(), {
		validateUrl: validateCoopsUrl,
		headers: { "User-Agent": "Alabama Beach Flag" },
	});
	if (!response.ok) throw new Error(`NOAA CO-OPS request failed (${response.status})`);

	const json = await readResponseJson<T>(response, {
		maxBytes: UPSTREAM_LIMITS.coopsJsonBytes,
		contentTypes: CONTENT_TYPES.json,
	});
	if (json.error) throw new Error(json.error.message);
	return json;
}
