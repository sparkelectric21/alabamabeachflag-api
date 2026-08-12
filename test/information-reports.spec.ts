import { describe,expect,it,vi } from "vitest";
import { readFileSync } from "node:fs";
import { parseInformationReport,ReportValidationError } from "../src/informationReports/validation";
import { handleInformationReportCreate,informationReportsAdminURL } from "../src/routes/informationReports";
import worker from "../src/index";
import type { Env } from "../src/types";
const valid={schemaVersion:1,clientReportId:"72c52fc1-2978-4c1b-9db2-78b5555661aa",category:"mapPinOrDirections",message:"The directions point to the wrong entrance.",clientCreatedAt:"2026-08-11T18:00:00.000Z",mapPoiId:"poi.cotton-bayou",screenId:"mapPoiDetail",appVersion:"1.2.1",appBuild:"121",platform:"iOS"};
describe("information report validation",()=>{
 it("accepts a strict valid report and trims user text",()=>expect(parseInformationReport({...valid,message:"  Incorrect official link.  ",contactEmail:" user@example.com "})).toMatchObject({message:"Incorrect official link.",contactEmail:"user@example.com"}));
 it.each([["category","unknown","invalid_category"],["clientReportId","bad","invalid_client_report_id"],["message","   ","invalid_message"],["schemaVersion",2,"unsupported_schema_version"],["platform","Android","invalid_platform"]])("rejects invalid %s",(key,value,code)=>expect(()=>parseInformationReport({...valid,[key]:value})).toThrowError(new ReportValidationError(code as string)));
 it("rejects unknown fields and oversized values",()=>{expect(()=>parseInformationReport({...valid,latitude:30.2})).toThrow("unexpected_field");expect(()=>parseInformationReport({...valid,message:"x".repeat(1501)})).toThrow("invalid_message")});
 it("contains no reporter location, fingerprint, or IP fields",()=>{const report=parseInformationReport(valid);for(const key of ["latitude","longitude","deviceId","deviceName","advertisingId","ip","ipAddress","sourceIP"])expect(report).not.toHaveProperty(key);expect(JSON.stringify(report)).not.toMatch(/198\.51\.100\.24|cf-connecting-ip/i)});
});

describe("information report acceptance isolation",()=>{
 it("accepts a persisted report even when email and notification-state recording fail",async()=>{
  const db={prepare:(sql:string)=>({bind:(..._values:unknown[])=>({first:async()=>null,run:async()=>{if(sql.startsWith("UPDATE information_reports"))throw new Error("state write failed");return{success:true}}})}),batch:async()=>[]} as unknown as D1Database;
  const env={HISTORICAL_DATA:db,BEACH_ACTIVITY_NOTIFICATION_RECIPIENTS:"configured@example.test",VERIFICATION_ALERT_EMAIL:{send:async()=>{throw new Error("email failed")}}} as unknown as Env;
  const response=await handleInformationReportCreate(new Request("https://example.test/v1/information-reports",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(valid)}),env);
  expect(response.status).toBe(201);expect(await response.json()).toMatchObject({status:"accepted",clientReportId:valid.clientReportId});
 });
 it("does not notify for an idempotent duplicate",async()=>{
  const send=vi.fn();const stored={id:"server-1",client_report_id:valid.clientReportId,status:"new",category:valid.category,message:valid.message,client_created_at:valid.clientCreatedAt,map_poi_id:valid.mapPoiId,screen_id:valid.screenId,app_version:valid.appVersion,app_build:valid.appBuild,received_at:valid.clientCreatedAt,updated_at:valid.clientCreatedAt,notification_status:"sent"};
  const db={prepare:()=>({bind:()=>({first:async()=>stored})})} as unknown as D1Database;
  const env={HISTORICAL_DATA:db,BEACH_ACTIVITY_NOTIFICATION_RECIPIENTS:"configured@example.test",VERIFICATION_ALERT_EMAIL:{send}} as unknown as Env;
  const response=await handleInformationReportCreate(new Request("https://example.test/v1/information-reports",{method:"POST",body:JSON.stringify(valid)}),env);
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject({status:"duplicate"});expect(send).not.toHaveBeenCalled();
 });
});

describe("information report admin links",()=>{
 it("uses the configured staging admin origin and canonical report query",()=>expect(informationReportsAdminURL({INFORMATION_REPORTS_ADMIN_URL:"https://staging.alabamabeachflag.com/admin/information-reports/"} as Env,"staging-report")).toBe("https://staging.alabamabeachflag.com/admin/information-reports/?report=staging-report"));
 it("retains the production canonical URL when no environment override is configured",()=>expect(informationReportsAdminURL({} as Env,"production-report")).toBe("https://www.alabamabeachflag.com/admin/information-reports/?report=production-report"));
 it.each(["not a URL","https://example.test/admin/information-reports/","http://staging.alabamabeachflag.com/admin/information-reports/"])("fails closed to the canonical production URL for unsafe configured URLs",(configured)=>expect(informationReportsAdminURL({INFORMATION_REPORTS_ADMIN_URL:configured} as Env,"safe-report")).toBe("https://www.alabamabeachflag.com/admin/information-reports/?report=safe-report"));
});

describe("information report custom-domain routing",()=>{
 const context={} as ExecutionContext;
 const request=(host:string,headers:Record<string,string>={},suffix="")=>new Request(`https://${host}/v1/information-reports${suffix}`,{method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(valid)});
 const acceptingDB={prepare:()=>({bind:()=>({first:async()=>null,run:async()=>({success:true})})}),batch:async()=>[]} as unknown as D1Database;
 const acceptingEnv=(environment:"production"|"staging")=>({HISTORICAL_DATA:acceptingDB,HISTORICAL_DATA_ENVIRONMENT:environment,BEACH_ACTIVITY_NOTIFICATION_RECIPIENTS:"configured@example.test",VERIFICATION_ALERT_EMAIL:{send:async()=>{throw new Error("email failed")}}} as unknown as Env);
 it("accepts production www and apex custom-domain POSTs",async()=>{
 for(const host of ["www.alabamabeachflag.com","alabamabeachflag.com"]) expect((await worker.fetch(request(host),acceptingEnv("production"),context)).status).toBe(201);
  for(const query of ["?retry=1","?retry=1&source=outbox","?value=%2Fnot-a-path"]) expect((await worker.fetch(request("www.alabamabeachflag.com",{},query),acceptingEnv("production"),context)).status).toBe(201);
 });
 it("accepts the staging custom-domain POST only in staging",async()=>expect((await worker.fetch(request("staging.alabamabeachflag.com"),acceptingEnv("staging"),context)).status).toBe(201));
 it("rejects wrong, direct Worker, wildcard suffixes, and forwarded-host submissions before persistence or notification",async()=>{
  const prepare=vi.fn(),send=vi.fn();const env={HISTORICAL_DATA:{prepare} as unknown as D1Database,HISTORICAL_DATA_ENVIRONMENT:"production",BEACH_ACTIVITY_NOTIFICATION_RECIPIENTS:"configured@example.test",VERIFICATION_ALERT_EMAIL:{send}} as unknown as Env;
  for(const [host,headers,suffix] of [["staging.alabamabeachflag.com",{},""],["alabamabeachflag-api.sparkelectricalservicesllc.workers.dev",{},""],["alabamabeachflag-api.sparkelectricalservicesllc.workers.dev",{},"?retry=1"],["unknown.example.test",{},""],["www.alabamabeachflag.com:444",{},""],["www.alabamabeachflag.com",{},"/extra"],["www.alabamabeachflag.com",{},"-anything"],["www.alabamabeachflag.com",{},"foo"],["www.alabamabeachflag.com",{},"%2Fextra"],["alabamabeachflag-api.sparkelectricalservicesllc.workers.dev",{"X-Forwarded-Host":"www.alabamabeachflag.com","Host":"www.alabamabeachflag.com"},""]]) expect((await worker.fetch(request(host,headers,suffix),env,context)).status).toBe(404);
  expect(prepare).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
  expect((await worker.fetch(request("www.alabamabeachflag.com"),acceptingEnv("staging"),context)).status).toBe(404);
  expect((await worker.fetch(request("alabamabeachflag-api-staging.sparkelectricalservicesllc.workers.dev"),acceptingEnv("staging"),context)).status).toBe(404);
 });
 it("keeps direct Worker public and admin routes unaffected",async()=>{
  expect((await worker.fetch(new Request("https://alabamabeachflag-api.sparkelectricalservicesllc.workers.dev/v1/beach-flags"),{} as Env,context)).status).not.toBe(404);
  expect((await worker.fetch(new Request("https://alabamabeachflag-api.sparkelectricalservicesllc.workers.dev/admin/information-reports"),{} as Env,context)).status).not.toBe(404);
 });
 it("configures terminal-wildcard report routes while retaining admin service routes",()=>{
  const production=readFileSync("wrangler.jsonc","utf8"),staging=readFileSync("wrangler.staging.jsonc","utf8");
  for(const route of ["www.alabamabeachflag.com/v1/information-reports*","alabamabeachflag.com/v1/information-reports*","staging.alabamabeachflag.com/v1/information-reports*"]) expect(`${production}\n${staging}`).toContain(route);
  expect(`${production}\n${staging}`).not.toContain("/v1/*");
  expect(production).toContain("www.alabamabeachflag.com/admin/service/*");expect(production).toContain("alabamabeachflag.com/admin/service/*");expect(staging).toContain("staging.alabamabeachflag.com/admin/service/*");
  expect(`${production}\n${staging}`).not.toContain("INFORMATION_REPORT_RATE_LIMITER");
 });
});
