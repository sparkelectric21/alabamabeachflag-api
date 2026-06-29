

export const WATER_QUALITY_CACHE_KEY = "water-quality";
export const BEACH_CONDITIONS_CACHE_KEY = "beach-conditions";
export const BEACH_FLAGS_CACHE_KEY = "beach-flags";

// Temporary compatibility alias while the iOS app migrates.
export const WEATHER_CACHE_KEY = BEACH_CONDITIONS_CACHE_KEY;

export async function readCache<T>(
	kv: KVNamespace,
	key: string,
): Promise<T | null> {
	return await kv.get<T>(key, "json");
}

export async function writeCache<T>(
	kv: KVNamespace,
	key: string,
	value: T,
	expirationTtl = 3600,
): Promise<void> {
	await kv.put(key, JSON.stringify(value), {
		expirationTtl,
	});
}

export async function deleteCache(
	kv: KVNamespace,
	key: string,
): Promise<void> {
	await kv.delete(key);
}