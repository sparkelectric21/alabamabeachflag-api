import type { Env } from "../types";
import type { AdminIdentity } from "../services/admin/auth";
import { logError } from "../utils/logger";
import { createReport, getReport, listReports, markNotification, reportHistory, updateReport } from "../informationReports/store";
import { INFORMATION_REPORT_STATUSES, type InformationReportStatus } from "../informationReports/types";
import { parseInformationReport, ReportValidationError } from "../informationReports/validation";
import { externalEmailAllowed } from "../config/stagingIsolation";

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" } });
const labels: Record<string,string> = { beachOrAccessInformation:"Beach or access information",mapPinOrDirections:"Map pin or directions",facilityOrAmenity:"Facility or amenity",officialSourceOrWebsiteLink:"Official source or website link",beachConditionDisplay:"Beach condition display",appDisplayOrTechnicalProblem:"App display or technical problem",somethingElse:"Something else" };
const safePreview = (value:string) => value.replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim().slice(0,300);
const defaultInformationReportsAdminURL = "https://www.alabamabeachflag.com/admin/information-reports/";
const allowedInformationReportsAdminHosts = new Set(["alabamabeachflag.com", "www.alabamabeachflag.com", "staging.alabamabeachflag.com"]);
export const informationReportsAdminURL = (env: Pick<Env, "INFORMATION_REPORTS_ADMIN_URL">, reportId: string) => {
	let url = new URL(defaultInformationReportsAdminURL);
	try {
		const configured = new URL(env.INFORMATION_REPORTS_ADMIN_URL || defaultInformationReportsAdminURL);
		if (configured.protocol === "https:" && allowedInformationReportsAdminHosts.has(configured.hostname)) url = configured;
	} catch { /* Fall back to the canonical production admin URL. */ }
	url.pathname = "/admin/information-reports/";
	url.hash = "";
	url.search = "";
	url.searchParams.set("report", reportId);
	return url.toString();
};

export function isInformationReportSubmissionHost(url: URL, env: Pick<Env, "HISTORICAL_DATA_ENVIRONMENT">): boolean {
	const allowedHosts = env.HISTORICAL_DATA_ENVIRONMENT === "staging"
		? ["staging.alabamabeachflag.com"]
		: ["www.alabamabeachflag.com", "alabamabeachflag.com"];
	return url.protocol === "https:" && url.port === "" && allowedHosts.includes(url.hostname.toLowerCase());
}

async function notify(env: Env, report: Awaited<ReturnType<typeof createReport>>["record"]): Promise<void> {
	if (!externalEmailAllowed(env)) throw new Error("delivery_suppressed");
	if (!env.VERIFICATION_ALERT_EMAIL?.send) throw new Error("email_binding_unavailable");
	const recipients = [...new Set((env.BEACH_ACTIVITY_NOTIFICATION_RECIPIENTS ?? "").split(",").map((item) => item.trim()).filter(Boolean))];
	if (!recipients.length) throw new Error("notification_recipient_unavailable");
	const subject = `New Alabama Beach Flag information report: ${safePreview(report.contextTitle || labels[report.category])}`;
	const text = ["A new information report is ready for private review.","",`Category: ${labels[report.category]}`,`Message preview: ${safePreview(report.message)}`,`Context: ${safePreview(report.contextTitle || "General report")}`,`Beach ID: ${report.beachId || "Not provided"}`,`App: ${report.appVersion} (${report.appBuild})`,`Submitted: ${report.receivedAt}`,`Review: ${informationReportsAdminURL(env, report.id)}`].join("\n");
	for (const to of recipients) await env.VERIFICATION_ALERT_EMAIL.send({ from:"alerts@alabamabeachflag.com",to,subject,text });
}

async function recordNotificationState(db: D1Database, reportId: string, status: "sent" | "failed", error: string | null = null): Promise<void> {
	try { await markNotification(db, reportId, status, error); }
	catch { logError("Information reports", "notification_state_update_failed", { reportId, status }); }
}

export async function handleInformationReportCreate(request: Request, env: Env): Promise<Response> {
	if (!env.HISTORICAL_DATA) return json({ error:"service_unavailable", retryable:true },503);
	const length = Number(request.headers.get("content-length") || "0"); if (length > 8192) return json({ error:"payload_too_large", retryable:false },413);
	let raw: unknown; try { const text = await request.text(); if (new TextEncoder().encode(text).length > 8192) return json({ error:"payload_too_large",retryable:false },413); raw=JSON.parse(text); } catch { return json({ error:"invalid_json",retryable:false },400); }
	try {
		const created = await createReport(env.HISTORICAL_DATA,parseInformationReport(raw));
		if (!created.duplicate) {
			try { await notify(env, created.record); await recordNotificationState(env.HISTORICAL_DATA, created.record.id, "sent"); }
			catch(error) { await recordNotificationState(env.HISTORICAL_DATA, created.record.id, "failed", error instanceof Error ? error.message : "notification_failed"); logError("Information reports", "notification_failed", { reportId: created.record.id }); }
		}
		return json({ status:created.duplicate ? "duplicate" : "accepted", reportId:created.record.id, clientReportId:created.record.clientReportId },created.duplicate ? 200 : 201);
	} catch(error) { if(error instanceof ReportValidationError) return json({error:error.code,retryable:false},422); logError("Information reports","create_failed"); return json({error:"service_unavailable",retryable:true},503); }
}

export async function handleInformationReportsAdmin(request:Request,env:Env,identity:AdminIdentity,id?:string):Promise<Response>{
	if(!env.HISTORICAL_DATA)return json({error:"service_unavailable"},503);
	if(request.method==="GET") { if(id){const report=await getReport(env.HISTORICAL_DATA,id); if(!report)return json({error:"not_found"},404); return json({report,history:await reportHistory(env.HISTORICAL_DATA,id)});} return json({reports:await listReports(env.HISTORICAL_DATA)}); }
	if(request.method!=="PATCH"||!id)return json({error:"method_not_allowed"},405);
	let body:unknown;try{body=await request.json();}catch{return json({error:"invalid_json"},400);} if(!body||typeof body!=="object"||Array.isArray(body))return json({error:"invalid_request"},422);
	const value=body as Record<string,unknown>,keys=Object.keys(value);if(keys.some(k=>!["status","resolutionNote","duplicateOfReportId"].includes(k)))return json({error:"unexpected_field"},422);
	if(value.status!==undefined&&(typeof value.status!=="string"||!(INFORMATION_REPORT_STATUSES as readonly string[]).includes(value.status)))return json({error:"invalid_status"},422);
	if(value.resolutionNote!==undefined&&value.resolutionNote!==null&&(typeof value.resolutionNote!=="string"||value.resolutionNote.trim().length>2000))return json({error:"invalid_resolution_note"},422);
	if(value.duplicateOfReportId!==undefined&&value.duplicateOfReportId!==null&&typeof value.duplicateOfReportId!=="string")return json({error:"invalid_duplicate"},422);
	const report=await updateReport(env.HISTORICAL_DATA,id,{status:value.status as InformationReportStatus|undefined,resolutionNote:typeof value.resolutionNote==="string"?value.resolutionNote.trim():value.resolutionNote as null|undefined,duplicateOfReportId:value.duplicateOfReportId as string|null|undefined},identity);return report?json({report,history:await reportHistory(env.HISTORICAL_DATA,id)}):json({error:"not_found"},404);
}
