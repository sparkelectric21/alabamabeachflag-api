import { OFFICIAL_ALERTS_CACHE_KEY } from "../services/cache/kv";
import { readCache, writeCache } from "../services/cache/kv";
import type { OfficialAlertSnapshot } from "./types";

export const readOfficialAlertSnapshot = (env: { BEACH_DATA: KVNamespace }) => readCache<OfficialAlertSnapshot>(env.BEACH_DATA, OFFICIAL_ALERTS_CACHE_KEY);
export const writeOfficialAlertSnapshot = (env: { BEACH_DATA: KVNamespace }, snapshot: OfficialAlertSnapshot) => writeCache(env.BEACH_DATA, OFFICIAL_ALERTS_CACHE_KEY, snapshot);
