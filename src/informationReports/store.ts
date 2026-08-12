import type { AdminIdentity } from "../services/admin/auth";
import type { InformationReportInput, InformationReportRecord, InformationReportStatus } from "./types";

const row = (value: Record<string, unknown>): InformationReportRecord => ({
	id: String(value.id), clientReportId: String(value.client_report_id), schemaVersion: 1, status: value.status as InformationReportStatus,
	category: value.category as InformationReportRecord["category"], message: String(value.message), contactEmail: value.contact_email ? String(value.contact_email) : undefined,
	clientCreatedAt: String(value.client_created_at), beachId: value.beach_id ? String(value.beach_id) : undefined, beachAccessId: value.beach_access_id ? String(value.beach_access_id) : undefined,
	mapPoiId: value.map_poi_id ? String(value.map_poi_id) : undefined, sourceId: value.source_id ? String(value.source_id) : undefined, learnArticleId: value.learn_article_id ? String(value.learn_article_id) : undefined,
	screenId: String(value.screen_id), appVersion: String(value.app_version), appBuild: String(value.app_build), platform: "iOS", catalogVersion: value.catalog_version ? String(value.catalog_version) : undefined,
	contextTitle: value.context_title ? String(value.context_title) : undefined, receivedAt: String(value.received_at), updatedAt: String(value.updated_at), resolutionNote: value.resolution_note ? String(value.resolution_note) : null,
	duplicateOfReportId: value.duplicate_of_report_id ? String(value.duplicate_of_report_id) : null, notificationStatus: value.notification_status as InformationReportRecord["notificationStatus"],
});

export async function createReport(db: D1Database, input: InformationReportInput, now = new Date()): Promise<{ record: InformationReportRecord; duplicate: boolean }> {
	const existing = await db.prepare("SELECT * FROM information_reports WHERE client_report_id = ?1").bind(input.clientReportId).first<Record<string, unknown>>();
	if (existing) return { record: row(existing), duplicate: true };
	const id = crypto.randomUUID(), timestamp = now.toISOString();
	try {
		await db.batch([
			db.prepare("INSERT INTO information_reports (id,client_report_id,status,schema_version,category,message,contact_email,beach_id,beach_access_id,map_poi_id,source_id,learn_article_id,screen_id,context_title,catalog_version,app_version,app_build,platform,client_created_at,received_at,updated_at) VALUES (?1,?2,'new',1,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,'iOS',?16,?17,?17)").bind(id,input.clientReportId,input.category,input.message,input.contactEmail ?? null,input.beachId ?? null,input.beachAccessId ?? null,input.mapPoiId ?? null,input.sourceId ?? null,input.learnArticleId ?? null,input.screenId,input.contextTitle ?? null,input.catalogVersion ?? null,input.appVersion,input.appBuild,input.clientCreatedAt,timestamp),
			db.prepare("INSERT INTO information_report_history (id,report_id,action,to_status,actor,created_at) VALUES (?1,?2,'created','new','app',?3)").bind(crypto.randomUUID(),id,timestamp),
		]);
	} catch (error) {
		const raced = await db.prepare("SELECT * FROM information_reports WHERE client_report_id = ?1").bind(input.clientReportId).first<Record<string, unknown>>();
		if (raced) return { record: row(raced), duplicate: true }; throw error;
	}
	return { record: { ...input, id, status: "new", receivedAt: timestamp, updatedAt: timestamp, resolutionNote: null, duplicateOfReportId: null, notificationStatus: "pending" }, duplicate: false };
}

export async function getReport(db: D1Database, id: string) { const found = await db.prepare("SELECT * FROM information_reports WHERE id = ?1").bind(id).first<Record<string, unknown>>(); return found ? row(found) : null; }
export async function listReports(db: D1Database) { const result = await db.prepare("SELECT * FROM information_reports ORDER BY CASE status WHEN 'new' THEN 0 ELSE 1 END, received_at DESC LIMIT 500").all<Record<string, unknown>>(); return result.results.map(row); }
export async function reportHistory(db: D1Database, id: string) { return (await db.prepare("SELECT id,action,from_status AS fromStatus,to_status AS toStatus,note,actor,created_at AS createdAt FROM information_report_history WHERE report_id=?1 ORDER BY created_at ASC").bind(id).all()).results; }
export async function updateReport(db: D1Database, id: string, changes: { status?: InformationReportStatus; resolutionNote?: string | null; duplicateOfReportId?: string | null }, identity: AdminIdentity) {
	const current = await getReport(db,id); if (!current) return null; const next = changes.status ?? current.status; const timestamp = new Date().toISOString();
	await db.batch([
		db.prepare("UPDATE information_reports SET status=?1,resolution_note=?2,duplicate_of_report_id=?3,updated_at=?4 WHERE id=?5").bind(next,changes.resolutionNote === undefined ? current.resolutionNote : changes.resolutionNote,changes.duplicateOfReportId === undefined ? current.duplicateOfReportId : changes.duplicateOfReportId,timestamp,id),
		db.prepare("INSERT INTO information_report_history (id,report_id,action,from_status,to_status,note,actor,created_at) VALUES (?1,?2,'updated',?3,?4,?5,?6,?7)").bind(crypto.randomUUID(),id,current.status,next,changes.resolutionNote ?? null,identity.subject,timestamp),
	]); return getReport(db,id);
}
export async function markNotification(db:D1Database,id:string,status:"sent"|"failed",error:string|null=null){ await db.prepare("UPDATE information_reports SET notification_status=?1,notification_error=?2 WHERE id=?3").bind(status,error?.slice(0,200) ?? null,id).run(); }
