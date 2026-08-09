import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function query(database: string, sql: string): string {
	return execFileSync("sqlite3", [database, sql], { encoding: "utf8" }).trim();
}

describe("historical D1 migrations", () => {
	it("applies all migrations to an empty SQLite-compatible database", () => {
		const directory = mkdtempSync(join(tmpdir(), "historical-migration-"));
		temporaryDirectories.push(directory);
		const database = join(directory, "history.sqlite");
		for (const migration of ["0001_historical_observations.sql", "0002_historical_provenance.sql"]) {
			execFileSync("sqlite3", [database], { input: readFileSync(resolve("migrations", migration)) });
		}
		expect(query(database, "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'historical_%' ORDER BY name")).toBe("historical_ingestion_runs\nhistorical_observations");
		const columns = query(database, "SELECT name FROM pragma_table_info('historical_observations') ORDER BY cid").split("\n");
		expect(columns).toEqual(expect.arrayContaining(["source_observation_key", "source_station_id", "observation_time_basis", "source_configuration_version"]));
		const indexes = query(database, "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'historical_%' ORDER BY name").split("\n");
		expect(indexes).toEqual(expect.arrayContaining(["historical_observations_source_observation", "historical_observations_area_latest", "historical_ingestion_runs_job_latest"]));
		expect(() => execFileSync("sqlite3", [database, "INSERT INTO historical_observations (id,logical_key,revision_hash,revision_number,observation_type,record_kind,provider,observed_at,fetched_at,stored_at,value_text,observation_time_basis) VALUES ('1','l','r',1,'x','state','p','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','x','invalid')"])).toThrow();
	});
});
