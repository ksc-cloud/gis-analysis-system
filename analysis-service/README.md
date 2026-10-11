# GIS Analysis Service (FastAPI)

Python spatial analysis service used internally by the Spring Boot application.
It binds to `127.0.0.1:8001` only, has no CORS, and never connects to MariaDB.
The Java application works normally whether or not this service is running.

## Requirements

- Python 3.14.8 (virtual environment in `analysis-service/.venv`, not tracked by Git)
- `requirements.txt`: runtime dependencies, `requirements-dev.txt`: plus test tools

## Setup (PowerShell)

```powershell
cd C:\Users\PC\gis-analysis-system\analysis-service
py -3.14 -m venv .venv                      # only if .venv does not exist
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m pip check
```

## Run

```powershell
# Check that port 8001 is free first (no output = free)
Get-NetTCPConnection -State Listen -LocalPort 8001 -ErrorAction SilentlyContinue

# Internal API token: set it in the shell only (never in a file that is committed).
# Without it /internal/* answers 503; /health works either way.
$env:ANALYSIS_INTERNAL_TOKEN = "<random value shared with the Java server>"
.\.venv\Scripts\python.exe -m app
# Development with auto reload
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8001 --reload
```

Stop the server with `Ctrl+C` in the terminal that started it.

```powershell
Invoke-RestMethod http://127.0.0.1:8001/health   # status: ok
curl.exe -s http://127.0.0.1:8001/health         # {"status":"ok"}
```

API docs (development): http://127.0.0.1:8001/docs

## Test

```powershell
.\.venv\Scripts\python.exe -m pytest -v
.\.venv\Scripts\python.exe -m pytest -v -s tests/test_building_stats.py::test_5000_buildings   # prints timing
.\.venv\Scripts\python.exe -m pytest -v -s tests/test_grid_density.py::test_5000_buildings_1km
.\.venv\Scripts\python.exe -m pytest -v -s tests/test_grid_density_api.py -k 5000             # timing and response size
.\.venv\Scripts\python.exe -m pytest -v -s tests/test_compare.py tests/test_compare_api.py -k "5000 or 16_mib"
```

`tests/test_java_real_results.py` compares real Java results saved in `tests/fixtures/real/*.json`
(Git-ignored, see `tests/fixtures/README.md`); it is skipped when that folder is empty.

## API

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/health` | none | `200 {"status":"ok"}` (liveness only, no external checks) |
| POST | `/internal/v1/building-stats` | `X-Internal-Token` | building statistics of one radius analysis |
| POST | `/internal/v1/grid-density` | `X-Internal-Token` | building density per 50/100/200 m grid cell (GeoJSON) |
| POST | `/internal/v1/compare-analyses` | `X-Internal-Token` | comparison of two saved radius analyses (body limit 32 MiB) |
| POST | `/internal/v1/hotspot` | `X-Internal-Token` | grid hotspots (Getis-Ord Gi*) and global Moran's I of one complete radius analysis |

`/docs` shows the request and response schemas of all internal endpoints. Use **Authorize** to enter the
`X-Internal-Token` value; the check itself is still done by the middleware (`app/security.py`), so the documentation
does not change authentication, the size limit or the error format.

### POST /internal/v1/building-stats

The request reuses the Java radius analysis result (`GET /api/buildings/nearby` or `GET /api/analyses/{id}`);
`tests/java_result.py` is the reference mapping.

```json
{
  "source": {"kind": "SAVED", "analysisId": 12, "analyzedAt": "2026-10-11T08:00:00Z"},
  "center": {"lon": 126.978, "lat": 37.5665},
  "radiusMeters": 300,
  "complete": false,
  "incompleteReasons": [{"code": "PAGE_LIMIT", "message": "..."}],
  "javaSummary": {"intersecting": 1, "inside": 1, "partial": 0, "outsideExcluded": 0,
                  "geometryUnavailable": 0, "distinctBuildings": 1, "mergedDuplicateFeatures": 0},
  "includeBuildings": true,
  "buildings": [{"id": "bd:1111010100100010000000001", "groundFloorRaw": "5", "relation": "INSIDE",
                 "distanceMeters": 12.34,
                 "geometry": {"type": "MultiPolygon", "coordinates": [[[[126.978, 37.566], "..."]]]}}]
}
```

- `source`, `javaSummary`, `relation`, `distanceMeters`, `includeBuildings` are optional. Unknown fields are rejected.
- `complete` must be `true` exactly when `incompleteReasons` is empty (same rule as Java).
- Building ids must be unique; a duplicate rejects the whole request (`422 DUPLICATE_BUILDING_ID`).

Response groups: `method` (projection and circle approximation error), `counts`, `footprint`, `withinRadius`,
`floors`, `completeness` (scope and per-statistic notes), `warnings`, `excluded`, `buildings`.

### Calculation

| Item | Rule |
|---|---|
| Projection | Plane tangent at the analysis center, WGS84 radii of curvature: the Java `PlanarGeometry` formula and constants (`app/geo/projection.py`) |
| Relation / distance | Port of `PlanarGeometry.evaluate`: INSIDE when every outer-ring vertex is within r + 1 mm, PARTIAL when the distance is within r + 1 mm, holes are outside the building |
| Building area | Each polygon part (holes removed) is validated; parts of one building are unioned, so overlap between parts (`internalOverlapArea`) counts once |
| `footprint.sumArea` | Sum of building areas: overlap **between** buildings counted repeatedly |
| `footprint.unionArea` | Ground area covered by all buildings: every overlap counted once (`betweenBuildingOverlapArea` = sum − union) |
| `areaInRadius` | INSIDE: whole footprint (exact). PARTIAL: intersection with the inscribed 256-gon |
| `coverageRatio` | `withinRadius.unionArea / πr²` (true circle area as denominator) |
| Floors | Java `validFloors` (ASCII `[0-9]{1,4}`, at least 1) and `Math.round` half-up average, over all input buildings |
| Invalid geometry | Repaired with `make_valid(method="structure")` (`repaired`, `repairReasons`); unrepairable or < 0.01 m² goes to `excluded` |

Circle approximation (256-gon, measured): the polygon is 0.0100 % smaller than πr² (r = 1000 m: 315 m²,
largest gap 0.075 m). `withinRadius.unionArea` can be low by at most `method.circleMissingArea`. For a single
building crossing the circle the loss is at most about gap × crossing length; measured on 400 random squares per
case: 5 m squares at r = 1000 m lose up to 0.37 m² (a sliver that barely enters the circle can lose most of its
small area), 50 m squares at r = 1000 m up to 2.5 m².

### POST /internal/v1/grid-density

The same request as building-stats (without `includeBuildings`) plus grid options:

```json
{
  "center": {"lon": 126.978, "lat": 37.5665},
  "radiusMeters": 300,
  "complete": true,
  "incompleteReasons": [],
  "cellSizeMeters": 100,
  "includeEmptyCells": true,
  "includeCellBuildingIds": false,
  "buildings": [{"id": "bd:1111010100100010000000001", "geometry": {"type": "MultiPolygon", "coordinates": ["..."]}}]
}
```

| Field | Rule |
|---|---|
| `cellSizeMeters` | required, integer `50`, `100` or `200` (`100.0`, `"100"` and other sizes are rejected) |
| `includeEmptyCells` | default `true`; `false` leaves out cells without buildings (totals still use every cell) |
| `includeCellBuildingIds` | default `false`; `true` fills `properties.buildingIds` (otherwise `null`) |

Response (abridged; 42 synthetic buildings, r = 300 m, 100 m cells):

```json
{
  "schemaVersion": 1, "cellSizeMeters": 100, "radiusMeters": 300,
  "method": {"...": "same as building-stats"},
  "grid": {"cellSizeMeters": 100, "cellArea": 10000.0, "origin": "CELL_CENTERED_AT_ANALYSIS_CENTER",
           "columns": [-3, 3], "rows": [-3, 3], "cellCount": 45, "returnedCellCount": 45, "emptyCellCount": 19,
           "boundaryCellCount": 24, "smallBoundaryCellCount": 8, "smallBoundaryRatio": 0.25,
           "minBuildingAreaInCell": 0.01, "description": "...", "comparisonWithBuildingStats": "..."},
  "counts": {"...": "same as building-stats"},
  "summary": {"domainArea": 282743.34, "sumArea": 14096.7, "occupiedArea": 13762.06, "coverageRatio": 0.048673,
              "coveragePercent": 4.87, "occupiedCellCount": 26, "primaryBuildingCount": 38, "primaryByNearestCell": 0},
  "consistency": {"withinRadiusUnionArea": 13762.06, "occupiedAreaCalculationDifference": 1.8189894035458565e-12,
                  "occupiedAreaDisplayDifference": -0.01, "occupiedAreaMatches": true, "circleArea": 282743.34,
                  "domainAreaCalculationDifference": 0.0, "domainAreaDisplayDifference": 0.02,
                  "analyzedBuildings": 38, "primaryBuildingTotal": 38, "primaryMatchesAnalyzed": true,
                  "description": "..."},
  "completeness": {"...": "scope and notes"},
  "warnings": [{"code": "OUTSIDE_RADIUS"}, {"code": "BETWEEN_BUILDING_OVERLAP"}, {"code": "SMALL_BOUNDARY_CELLS"}],
  "excluded": ["..."],
  "cells": {"type": "FeatureCollection", "features": [
    {"type": "Feature", "id": "1:0",
     "geometry": {"type": "Polygon", "coordinates": [[[126.97856595, 37.566049502], [126.979697851, 37.566049502],
                  [126.979697851, 37.566950498], [126.97856595, 37.566950498], [126.97856595, 37.566049502]]]},
     "properties": {"col": 1, "row": 0, "centerLon": 126.979131901, "centerLat": 37.5665, "cellArea": 10000.0,
                    "domainArea": 10000.0, "domainRatio": 1.0, "boundary": false, "smallBoundary": false,
                    "buildingCount": 4, "primaryBuildingCount": 3, "sumArea": 1331.04, "occupiedArea": 1181.04,
                    "betweenBuildingOverlapArea": 150.0, "coverageRatio": 0.118104, "coveragePercent": 11.81,
                    "buildingIds": null}}]}
}
```

### Grid calculation

| Item | Rule |
|---|---|
| Grid | Squares on the same local tangent plane as the analysis. Cell `(col, row)` covers x `[(col − ½)s, (col + ½)s]`, y `[(row − ½)s, (row + ½)s]`: cell `(0, 0)` is centered on the analysis center, `col` grows east and `row` north. Feature id `"col:row"`, cells ordered by row then column (south-west first) |
| Cells | Every cell sharing area with the true circle (> 10⁻⁶ m²). Boundary cells are returned as full squares |
| `domainArea` | Exact area of cell ∩ true circle (closed form, `app/geo/grid.py`), the denominator of `coverageRatio`. All domains add up to πr² |
| `occupiedArea` | Area of the building-stats `withinRadius` union inside the cell: overlaps between buildings count once. All cells add up to `withinRadius.unionArea` |
| `sumArea` / `betweenBuildingOverlapArea` | Sum of the building parts in the cell (overlaps repeated) / `sumArea − occupiedArea` |
| `buildingCount` | Buildings with at least 0.01 m² inside the circle and the cell; a building across several cells counts in each |
| `primaryBuildingCount` | Every analyzed building exactly once, in the cell with its largest part inside the circle (parts within 10⁻⁶ m² are equal: first cell in grid order). A PARTIAL building with no area inside the circle goes to the cell nearest to its point closest to the center (`summary.primaryByNearestCell`). The total equals `counts.analyzed` |
| `boundary` / `smallBoundary` | `domainArea` < cell area / `domainArea` < 25 % of the cell area (`SMALL_BOUNDARY_CELLS` warning: the small denominator makes the ratio unstable) |
| GeoJSON | Cell corners converted back with the inverse of the same projection, WGS84 lon/lat rounded to 9 decimals (≈ 0.1 mm), exterior ring counterclockwise (RFC 7946) |
| Spatial index | Shapely `STRtree` over the union parts and over the clipped buildings, queried with all cell boxes at once |

**Consistency.** Internal totals use unrounded values. `consistency.*CalculationDifference` is the unrounded cell
total minus the reference (`withinRadius.unionArea` or πr²): real floating point / geometry error, below 10⁻⁷ m²
in the tests (`occupiedAreaMatches` is true within 0.001 m²). `consistency.*DisplayDifference` is the sum of the
displayed (0.01 m² rounded) cell values minus the displayed reference: rounding only, up to 0.005 m² per cell.

**Differences from building-stats.** Building selection, repair, INSIDE/PARTIAL/OUTSIDE decision and the 256-gon
clipping are the same code (`app/services/radius_analysis.py`); `counts`, `method`, `excluded` are identical, and the
overall `summary.coverageRatio` equals `withinRadius.coverageRatio`. Differences: (1) in boundary cells the numerator
is clipped with the 256-gon while the denominator uses the true circle, the same convention as the overall coverage,
so boundary cells can be slightly low; (2) `buildingCount` adds up to more than `counts.analyzed` when buildings cross
cell lines (use `primaryBuildingCount` for totals); (3) PARTIAL buildings with no area inside the circle appear only
in `primaryBuildingCount`; (4) no floor statistics. The response repeats this in `grid.comparisonWithBuildingStats`.

**Partial results.** When `complete` is false, `completeness.scope` is `OBSERVED_BUILDINGS_ONLY`, the first warning is
`PARTIAL_RESULT`, and the notes cover the cell counts, areas and coverage: an empty cell may only be unobserved, and
the cell values must not be shown as the density of the whole area.

Measured (5000 buildings, r = 1000 m, end to end through the API): 50 m cells 1345 cells, 0.75 s, 979 KiB
(1053 KiB with building ids); 100 m 357 cells, 0.67 s, 419 KiB; 200 m 101 cells, 0.62 s, 273 KiB.

### POST /internal/v1/compare-analyses

Compares two saved analyses (`GET /api/analyses/{id}`, older one as `before`). Each side is the building-stats
request (without `includeBuildings`) plus `criterion` and `dataSource`; `tests/java_result.py`
`to_compare_request()` is the reference mapping.

```json
{
  "before": {"source": {"kind": "SAVED", "analysisId": 12, "analyzedAt": "2026-03-01T09:00:00Z"},
             "criterion": "POLYGON_INTERSECTS_CIRCLE",
             "dataSource": {"provider": "VWorld 2D 데이터 API", "layer": "LT_C_SPBD (도로명주소 건물)",
                            "coordinateSystem": "EPSG:4326 (WGS84 경위도)"},
             "center": {"lon": 126.978, "lat": 37.5665}, "radiusMeters": 300, "complete": true,
             "incompleteReasons": [], "javaSummary": {"...": "optional"}, "buildings": ["..."]},
  "after": {"...": "same shape, analysisId 15"},
  "includeUnchanged": false,
  "includeBuildingChanges": true
}
```

| Rule | |
|---|---|
| `source` | required on both sides: `kind` `SAVED`, `analysisId`, `analyzedAt` with a time zone |
| Same `analysisId` | `422 SAME_ANALYSIS` |
| `before.analyzedAt` later than `after.analyzedAt` | `422 ANALYSIS_ORDER_REVERSED` (equal times are allowed with the `SAME_ANALYZED_AT` warning) |
| `includeUnchanged` | default `false`: matched buildings without changes are only counted |
| `includeBuildingChanges` | default `true`; `false` returns only `buildings.summary` |
| Body limit | `ANALYSIS_COMPARE_MAX_BODY_BYTES` (default 32 MiB) for this path only; the other endpoints keep 16 MiB. Each side keeps the building-stats limits (5,000 buildings, 500,000 positions) |

Response (abridged, from `tests/test_compare_api.py::valid_payload`):

```json
{
  "comparable": true, "comparisonBasis": "CHANGE", "notComparableReasons": [],
  "before": {"source": {}, "counts": {}, "identifiers": {"bd": 2, "feature": 0, "row": 0, "other": 0}, "warnings": []},
  "after": {"...": "same shape"},
  "conditions": {"centerDistanceMeters": 0.0, "centerToleranceMeters": 0.05, "sameCenter": true, "sameRadius": true,
                 "sameCriterion": true, "sameDataSource": true, "sameCoordinateSystem": true,
                 "analyzedIntervalSeconds": 15897600.0, "bothComplete": true},
  "method": {"centerToleranceMeters": 0.05, "featureIouThreshold": 0.5, "candidateIouThreshold": 0.9,
             "geometryToleranceM2": 0.01, "matchingDescription": "...", "statisticsDescription": "...",
             "analysis": {"...": "building-stats method"}},
  "statistics": {"basis": "CHANGE", "interpretation": "...",
                 "buildingCount": {"unit": "count", "before": 2, "after": 2, "delta": 0, "changeRate": 0.0},
                 "unionArea": {"unit": "m2", "before": 200.0, "after": 200.0, "delta": 0.0, "changeRate": 0.0},
                 "coverageRatio": {"unit": "ratio", "before": 0.006366, "after": 0.006366, "delta": 0.0,
                                   "changeRate": 0.0, "deltaPercentPoint": 0.0},
                 "averageFloors": {"unit": "floors", "before": 3.0, "after": 4.0, "delta": 1.0, "changeRate": 0.333333},
                 "javaBuildingCount": null, "sumArea": {}, "averageArea": {}, "floorsWithData": {}},
  "buildings": {
    "summary": {"matched": 1, "unchanged": 0, "modified": 1, "added": 1, "removed": 1, "onlyInAfter": 0,
                "onlyInBefore": 0, "uncomparableBefore": 0, "uncomparableAfter": 0, "lowConfidence": 0,
                "candidates": 0, "ambiguousCandidates": 0},
    "changes": [
      {"id": "bd:3", "status": "ADDED", "match": null, "before": null, "after": {"footprintArea": 100.0, "...": ""}},
      {"id": "bd:2", "status": "REMOVED", "...": ""},
      {"id": "bd:1", "status": "MODIFIED", "match": {"basis": "BD_MGT_SN", "confidence": "HIGH", "reasons": []},
       "changes": ["FLOORS"], "footprintArea": {"before": 100.0, "after": 100.0, "delta": 0.0, "changeRate": 0.0},
       "symmetricDifferenceArea": 0.0, "iou": 1.0,
       "floors": {"before": 3, "after": 5, "delta": 2, "beforeRaw": "3", "afterRaw": "5"}}],
    "uncomparable": [], "possibleSameBuilding": []},
  "warnings": [], "notes": ["..."]
}
```

### Comparison rules

| Item | Rule |
|---|---|
| Comparable | Centers within 0.05 m (on the tangent plane of `before.center`), equal `radiusMeters`, both criteria `POLYGON_INTERSECTS_CIRCLE`, equal `dataSource.provider`/`layer` and `coordinateSystem`. Otherwise `200` with `comparable: false`, every failed condition in `notComparableReasons`, and `statistics`/`buildings` `null` |
| Basis | `CHANGE` when both are complete, otherwise `OBSERVATION_DIFFERENCE` (warning, notes; `ONLY_IN_BEFORE`/`ONLY_IN_AFTER` instead of `REMOVED`/`ADDED`) |
| Statistics | Unrounded building-stats values of each side (same pipeline): `buildingCount` = `counts.analyzed`, `unionArea` = `withinRadius.unionArea`, `sumArea` = `footprint.sumArea`, `coverageRatio` (+ `deltaPercentPoint`), `averageArea` = `footprint.averageArea`, `averageFloors` (unrounded mean of valid floors), `floorsWithData`, `javaBuildingCount` when both sides have `javaSummary`. `delta = after − before`, `changeRate = delta / before` (`null` when before is 0 or missing). Rounded only in the response |
| `bd:` | Same id = same building, confidence `HIGH` |
| `feature:` | Same id and whole-footprint IoU ≥ 0.5 = same building, confidence `MEDIUM`; otherwise `FEATURE_ID_UNVERIFIED` (uncomparable, not added/removed) |
| `row:` / other | Never matched, even with equal ids (`ROW_IDENTIFIER`, `UNKNOWN_IDENTIFIER`) |
| Repaired footprint | Still compared, confidence `LOW` (`match.reasons`, `LOW_CONFIDENCE` entry) |
| Excluded footprint | Invalid / zero area / outside the circle on either side: the id is uncomparable (`GEOMETRY_EXCLUDED`, `OUTSIDE_RADIUS`, `COUNTERPART_EXCLUDED`) |
| Building changes | `GEOMETRY` (symmetric difference ≥ 0.01 m²), `FLOORS` (both valid, different), `FLOORS_DATA` (valid on one side only), `RELATION` (INSIDE ↔ PARTIAL); none = `UNCHANGED` |
| Candidates | Buildings left unmatched (added/removed, `row:`, unverified `feature:`) with IoU ≥ 0.9 (STRtree). `CANDIDATE` only when the pair is the only one ≥ 0.9 for both buildings, otherwise all pairs of those buildings are `AMBIGUOUS`; no 1:1 assignment is guessed. Candidates never change a status or a statistic |

Notes in every response: differences are differences of VWorld LT_C_SPBD data between the two analysis times; VWorld
update times can differ from real construction or demolition, and `ADDED`/`REMOVED` do not confirm either.

Measured: 5000 + 5000 buildings at r = 1000 m: 2.9 MiB request, 1.9 s end to end, 964 KiB response
(617 modified, 40 renumbered ids reported as candidates); 45-vertex footprints: 18.5 MiB request, 4.2 s, about
100 MiB peak Python allocation (GEOS memory not included).

### POST /internal/v1/hotspot

The building-stats request (without `includeBuildings`) plus:

| Field | Rule |
|---|---|
| `cellSizeMeters` | required, 50, 100 or 200 (the grid of grid-density; every cell, no building ids) |
| `permutations` | 99, 999 (default) or 9999: Moran's I permutation test |
| `seed` | integer 0 – 2147483647, default 20261012: same request, same result |

`includeEmptyCells`, `includeCellBuildingIds` and unknown fields are rejected (422).

| Status | When | Response |
|---|---|---|
| `OK` | statistics computed | `grid`, `counts`, `moran`, every cell with its result; warning `SPARSE_VALUES` when fewer than 10 % of the tested cells have buildings |
| `CONSTANT_VALUES` | every tested cell has the same coverage (also no buildings) | every cell `NOT_TESTED`, `moran: null`, warning |
| `INSUFFICIENT_CELLS` | fewer than 30 cells can be tested | every cell `NOT_TESTED`, `moran: null`, warning |
| `PARTIAL_RESULT_BLOCKED` | `complete: false` with **any** reason (known or not; no allow list), or a building Python cannot repair (`INVALID_GEOMETRY`, reported as `PYTHON_GEOMETRY_EXCLUDED`) | `200`, `blockedReasons`, `grid`/`counts`/`moran` `null`, no cells, summary 0, one `PARTIAL_RESULT_BLOCKED` warning. A partial request is blocked before the grid is computed; an unrepairable building after the grid, before the statistics. `ZERO_AREA` and `OUTSIDE_RADIUS` exclusions add no area and do not block |

`completeness` is the grid-density completeness plus `sourceComplete` (Java `complete`) and
`pythonGeometryExcluded`; `complete` is false exactly when the status is `PARTIAL_RESULT_BLOCKED`.

Each cell (`cells.features`, same `id`, geometry and order as grid-density) has `col`, `row`, `centerLon`,
`centerLat`, `boundary`, `smallBoundary`, `domainRatio`, `coverageRatio`, `neighborCount`, `giZ`, `pValue`, `qValue`,
`hotspotClass` (`HOT_99/95/90`, `NOT_SIGNIFICANT`, `COLD_90/95/99`, `NOT_TESTED`), `bin` (3 … −3) and `reason`
(`SMALL_BOUNDARY`, `NO_NEIGHBORS`, `UNDEFINED_VARIANCE`, `CONSTANT_VALUES`, `INSUFFICIENT_CELLS`). Statistics of
untested cells are `null`. `moran` has `i`, `expected`, `pValue`, `zSimulated`, `simulatedMean`, `simulatedSd`
(the simulated values are not returned).

| Item | Rule |
|---|---|
| Variable | cell `coverageRatio` of grid-density |
| Neighbors | Queen (8 directions) among cells that are not small boundary cells; small boundary cells and cells without a neighbor are not tested |
| Gi* | binary weights including the cell, two-sided normal p-value |
| Correction | Benjamini-Hochberg over the tested cells only; class by the **unrounded** q-value: q ≤ 0.01 / 0.05 / 0.10 → 99 / 95 / 90 %, sign of z → HOT / COLD |
| Moran's I | row-standardized weights; p = (#{\|I_sim − E[I]\| ≥ \|I − E[I]\|} + 1) / (P + 1), E[I] = −1/(n−1) |
| Rounding | `giZ` 4 decimals, `pValue`/`qValue` 6 significant digits, Moran values 6 decimals (`zSimulated` 4) |

Limits (also in `method.limitations`): the Gi* p-value is a normal approximation (less reliable when most cells are
0); BH controls the FDR for independent or positively dependent tests, which neighboring Gi* do not always prove, so
10 / 5 / 1 % are nominal levels; results depend on the cell size; cells cut by the circle can have a coverage
different from interior cells, so hot or cold spots along the boundary need care.

Measured (synthetic, 5000 buildings at r = 1000 m, 50 m cells, 999 permutations, this test machine): about 0.95 s
for grid-density plus statistics in the service.

### Errors (`{"error", "message", "details"?}`, never containing submitted values)

| Status | error | When |
|---|---|---|
| 400 | `INVALID_JSON`, `INVALID_CONTENT_LENGTH` | body is not JSON / bad header |
| 401 | `UNAUTHORIZED` | `X-Internal-Token` missing or wrong |
| 413 | `PAYLOAD_TOO_LARGE` | body over `ANALYSIS_MAX_BODY_BYTES` (default 16 MiB; compare-analyses: `ANALYSIS_COMPARE_MAX_BODY_BYTES`, default 32 MiB), also for chunked bodies |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | not `application/json` |
| 422 | `VALIDATION_ERROR`, `DUPLICATE_BUILDING_ID` | contract violations (first 20 details) |
| 422 | `SAME_ANALYSIS`, `ANALYSIS_ORDER_REVERSED` | compare-analyses: same `analysisId`, `before` later than `after` |
| 503 | `INTERNAL_TOKEN_NOT_CONFIGURED` | `ANALYSIS_INTERNAL_TOKEN` is not set |

Limits: 5,000 buildings, 100 polygons per building, 100 rings per polygon, 10,000 positions per ring,
500,000 positions in total. Center: lon 124–132, lat 33–39; radius: integer 50–1000 (same as Java).

## Java integration (step 8-5)

The Spring Boot application calls this service server to server (`com.example.gis_analysis_system.spatial`); the
browser only calls Java:

| Java API | Python endpoint |
|---|---|
| `GET /api/analyses/{id}/statistics?includeBuildings=false` | building-stats (saved analysis, `source.kind` `SAVED`) |
| `GET /api/analyses/{id}/grid-density?cellSize=100&includeEmptyCells=true&includeBuildingIds=false` | grid-density |
| `GET /api/analyses/{id}/comparison?with={otherId}&includeUnchanged=false&includeBuildingChanges=true` | compare-analyses (older analysis = `before`; same time: lower id) |
| `GET /api/analysis-snapshots/{token}/statistics`, `.../grid-density` | building-stats / grid-density of an unsaved result (`LIVE`) |
| `GET /api/spatial-analysis/status` | `/health` → `{"available", "configured"}` only |

Java answers `{"analysisIds": [...], "analysisService": {"schemaVersion": 1}, "result": <this service's response>}`
after checking the response structure. Use the **same** `ANALYSIS_INTERNAL_TOKEN` for both servers (Java reads the
environment variable or `analysis-service.internal-token` in the git-ignored `application-local.properties`); Java
accepts only a loopback `ANALYSIS_SERVICE_URL` (default `http://127.0.0.1:8001`). When this service is not running,
only these Java endpoints answer 503; the map, radius analysis and history are unaffected.

Opt-in Java tests against a running service (they only send analysis requests):

```powershell
$env:ANALYSIS_IT_URL = "http://127.0.0.1:8001"; $env:ANALYSIS_IT_TOKEN = "<the server's token>"
.\mvnw.cmd test "-Dtest=PythonServiceLiveTests,SpatialAnalysisApiLiveTests"
# with GIS_TEST_DB_* also set: SpatialAnalysisMariaDbLiveTests (saves and deletes its own analyses)
```

## Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `ANALYSIS_HOST` | `127.0.0.1` | Bind address. Keep loopback only. |
| `ANALYSIS_PORT` | `8001` | Port |
| `ANALYSIS_DOCS_ENABLED` | `true` | Expose `/docs`, `/redoc`, `/openapi.json` |
| `ANALYSIS_INTERNAL_TOKEN` | (unset) | Required by `/internal/*` (503 while unset). Never commit or log a value. |
| `ANALYSIS_MAX_BODY_BYTES` | `16777216` | Request body limit for `/internal/*` except compare-analyses (1024 – 67108864) |
| `ANALYSIS_COMPARE_MAX_BODY_BYTES` | `33554432` | Request body limit for `/internal/v1/compare-analyses` only (1024 – 67108864) |

`ANALYSIS_HOST` / `ANALYSIS_PORT` apply to `python -m app`; when running `uvicorn` directly, pass `--host` / `--port`.
