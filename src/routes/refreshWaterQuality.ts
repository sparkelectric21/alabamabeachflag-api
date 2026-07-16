import type { AdminIdentity } from "../services/admin/auth";
import type { Env } from "../types";
import { handleAdminRefreshRequest } from "./adminRefresh";

export function handleRefreshWaterQualityRequest(request: Request, env: Env, identity: AdminIdentity): Promise<Response> {
	return handleAdminRefreshRequest(request, env, "water-quality", identity);
}
