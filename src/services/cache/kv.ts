

export const WATER_QUALITY_CACHE_KEY = "water-quality";

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