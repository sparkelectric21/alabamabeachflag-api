# MapKit POI Catalog

## Purpose

`GET /v1/map-pois` distributes Alabama Beach Flag's application-owned MapKit points of interest. Phase 1 establishes a source-controlled backend authority without changing the iOS app. The initial committed baseline contains 26 records: all 19 physical Beach Guide access points, one independent Dauphin Island landing, and six Orange Beach seasonal lifeguard towers.

The catalog does not include Apple basemap POIs and does not migrate the richer Beach Guide content.

## Versions and content identity

- `/v1/map-pois` is the HTTP route version.
- `schemaVersion` describes the document structure and client compatibility. Schema 1 is the only supported value.
- `catalogVersion` is a deliberate, human-readable content revision. It changes whenever catalog content is published, without changing `schemaVersion` for compatible edits.
- `ETag` is a quoted SHA-256 fingerprint of a canonical representation of meaningful catalog content. It is independent of JSON formatting, object-key insertion order, and runtime timestamps.

The initial `catalogVersion` is `2026-08-10.1`.

## Schema 1 vocabulary

Regions are `gulfShores`, `orangeBeach`, `fortMorgan`, and `dauphinIsland`.

Categories are `beachAccess`, `pier`, `pavilion`, `lifeguardTower`, and `waterAccess`. Pier and pavilion classification is explicit data, not inferred from IDs. A new record using an existing category can eventually reach compatible installed clients without an iOS release. A new category changes client interpretation and will normally require a schema and iOS update.

## Coordinate and provenance contract

Every coordinate is a verified physical MapKit destination. It must never be replaced with a water-quality sample, weather, tide, regional-condition, broad Beach model, or camera-framing coordinate. `BeachRegistry` is an environmental and operational registry and is not the MapKit POI source.

Every record includes an authority, stable source ID, source title, HTTPS source URL, and strict `YYYY-MM-DD` verification date. `coordinateSourceTitle` records the more specific coordinate provenance when it differs from the primary authority source.

## Enabled state and lifeguard semantics

Disabled POIs remain in the complete catalog but compatible clients must not render them. Keeping the record preserves stable identity, provenance, and review history. Disabling is not a real-time emergency-control guarantee for offline clients, which may continue using last-known-good or bundled content.

Lifeguard towers are seasonal locations only. Schema 1 requires `seasonal: true` and `staffingStatus: "notProvided"`; display text must not claim current staffing or an on-duty lifeguard.

## Validation and update procedure

The Worker validates the entire source-controlled catalog before serving it. A failure prevents partial or malformed publication. Validation covers schema vocabulary, stable and unique IDs, finite global and Alabama-coast coordinates, required bounded strings, HTTPS provenance, real verification dates, record count, Beach Guide relationships, catalog size, and lifeguard semantics.

To update the catalog:

1. Verify the fact and physical coordinate against an authoritative source.
2. Add or edit the typed record in `src/config/MapPOICatalog.ts`.
3. Preserve an existing stable ID; never create a new ID merely to correct content.
4. For a bundled Beach Guide access, use its exact current ID in `beachGuideAccessPointID`. Backend-only POIs omit that relationship.
5. To disable a POI, set `enabled` to `false`; do not delete it merely to hide it.
6. Increment `catalogVersion` for every published addition, correction, enable, disable, removal, or provenance change.
7. Keep `schemaVersion` unchanged for changes expressible in schema 1. Increment it only for incompatible structural or semantic changes.
8. Update baseline/parity tests when a reviewed publication intentionally changes content, then run `npm run check`.

Phase 1 uses the reviewed TypeScript catalog as the authority. It requires no D1, KV, R2, Durable Object, Static Assets, binding, or migration.

## HTTP and future iOS behavior

The route returns the complete catalog with public cache controls and a deterministic ETag, and honors `If-None-Match` with an empty `304` response. The planned compatible iOS resolution order is:

1. Fresh, successfully validated backend catalog.
2. Validated last-known-good cached backend catalog.
3. Bundled verified iOS catalog.

The bundled catalog and its tests remain the offline and emergency fallback. Phase 1 does not change iOS, Beach Guide presentation, or the bundled MapLibre system.
