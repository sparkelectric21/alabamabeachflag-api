

export const WATER_QUALITY_CACHE_KEY = "water-quality";
export const BEACH_CONDITIONS_CACHE_KEY = "beach-conditions";
export const BEACH_FLAGS_CACHE_KEY = "beach-flags";
export const RIP_CURRENT_OUTLOOK_CACHE_KEY = "rip-current-outlook";
export const RIP_CURRENT_OUTLOOK_LEGACY_IMAGE_KEY = "rip-current-outlook:image";
export const RIP_CURRENT_OUTLOOK_IMAGE_KEY_PREFIX = "rip-current-outlook:image:";
export const APP_ANNOUNCEMENT_CACHE_KEY = "app-announcement";

export function ripCurrentOutlookImageKey(revision: string): string {
	return `${RIP_CURRENT_OUTLOOK_IMAGE_KEY_PREFIX}${revision}`;
}

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
	expirationTtl?: number,
): Promise<void> {
	const options = expirationTtl
		? { expirationTtl }
		: undefined;

	await kv.put(key, JSON.stringify(value), options);
}

export async function deleteCache(
	kv: KVNamespace,
	key: string,
): Promise<void> {
	await kv.delete(key);
}
