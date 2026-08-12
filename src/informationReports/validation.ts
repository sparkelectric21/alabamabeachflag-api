import { INFORMATION_REPORT_CATEGORIES, type InformationReportInput } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KEYS = new Set(["schemaVersion", "clientReportId", "category", "message", "contactEmail", "clientCreatedAt", "beachId", "beachAccessId", "mapPoiId", "sourceId", "learnArticleId", "screenId", "appVersion", "appBuild", "platform", "catalogVersion", "contextTitle"]);

export class ReportValidationError extends Error { constructor(readonly code: string) { super(code); } }
const optional = (value: unknown, max = 128) => value === undefined || (typeof value === "string" && value.length <= max && ID.test(value));

export function parseInformationReport(value: unknown): InformationReportInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReportValidationError("invalid_request");
	const body = value as Record<string, unknown>;
	if (Object.keys(body).some((key) => !KEYS.has(key))) throw new ReportValidationError("unexpected_field");
	if (body.schemaVersion !== 1) throw new ReportValidationError("unsupported_schema_version");
	if (typeof body.clientReportId !== "string" || !UUID.test(body.clientReportId)) throw new ReportValidationError("invalid_client_report_id");
	if (typeof body.category !== "string" || !(INFORMATION_REPORT_CATEGORIES as readonly string[]).includes(body.category)) throw new ReportValidationError("invalid_category");
	if (typeof body.message !== "string") throw new ReportValidationError("invalid_message");
	const message = body.message.trim(); if (message.length < 10 || message.length > 1500) throw new ReportValidationError("invalid_message");
	if (body.contactEmail !== undefined && (typeof body.contactEmail !== "string" || body.contactEmail.trim().length > 254 || !EMAIL.test(body.contactEmail.trim()))) throw new ReportValidationError("invalid_contact_email");
	if (typeof body.clientCreatedAt !== "string" || !Number.isFinite(Date.parse(body.clientCreatedAt))) throw new ReportValidationError("invalid_client_created_at");
	for (const key of ["beachId", "beachAccessId", "mapPoiId", "sourceId", "learnArticleId", "catalogVersion"] as const) if (!optional(body[key])) throw new ReportValidationError(`invalid_${key}`);
	if (typeof body.screenId !== "string" || !ID.test(body.screenId)) throw new ReportValidationError("invalid_screen_id");
	if (typeof body.appVersion !== "string" || !VERSION.test(body.appVersion) || typeof body.appBuild !== "string" || !VERSION.test(body.appBuild)) throw new ReportValidationError("invalid_app_version");
	if (body.platform !== "iOS") throw new ReportValidationError("invalid_platform");
	if (body.contextTitle !== undefined && (typeof body.contextTitle !== "string" || body.contextTitle.trim().length > 200)) throw new ReportValidationError("invalid_context_title");
	return { ...(body as unknown as InformationReportInput), message, contactEmail: typeof body.contactEmail === "string" ? body.contactEmail.trim() : undefined, contextTitle: typeof body.contextTitle === "string" ? body.contextTitle.trim() : undefined };
}
