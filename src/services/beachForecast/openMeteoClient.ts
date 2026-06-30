const OPEN_METEO_BASE_URL = "https://api.open-meteo.com/v1/forecast";

export async function fetchCurrentUV(
    latitude: number,
    longitude: number,
): Promise<number | undefined> {

    const url = new URL(OPEN_METEO_BASE_URL);

    url.searchParams.set("latitude", latitude.toString());
    url.searchParams.set("longitude", longitude.toString());
    url.searchParams.set("current", "uv_index");
    url.searchParams.set("timezone", "America/Chicago");

    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Open-Meteo request failed (${response.status})`);
    }

    const json = await response.json() as {
        current?: {
            uv_index?: number;
        };
    };

    return json.current?.uv_index;
}