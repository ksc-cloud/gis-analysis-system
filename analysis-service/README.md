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
```

`tests/test_java_real_results.py` compares real Java results saved in `tests/fixtures/real/*.json`
(Git-ignored, see `tests/fixtures/README.md`); it is skipped when that folder is empty.

## API

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/health` | none | `200 {"status":"ok"}` (liveness only, no external checks) |
| POST | `/internal/v1/building-stats` | `X-Internal-Token` | building statistics of one radius analysis |

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

### Errors (`{"error", "message", "details"?}`, never containing submitted values)

| Status | error | When |
|---|---|---|
| 400 | `INVALID_JSON`, `INVALID_CONTENT_LENGTH` | body is not JSON / bad header |
| 401 | `UNAUTHORIZED` | `X-Internal-Token` missing or wrong |
| 413 | `PAYLOAD_TOO_LARGE` | body over `ANALYSIS_MAX_BODY_BYTES` (default 16 MiB), also for chunked bodies |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | not `application/json` |
| 422 | `VALIDATION_ERROR`, `DUPLICATE_BUILDING_ID` | contract violations (first 20 details) |
| 503 | `INTERNAL_TOKEN_NOT_CONFIGURED` | `ANALYSIS_INTERNAL_TOKEN` is not set |

Limits: 5,000 buildings, 100 polygons per building, 100 rings per polygon, 10,000 positions per ring,
500,000 positions in total. Center: lon 124–132, lat 33–39; radius: integer 50–1000 (same as Java).

## Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `ANALYSIS_HOST` | `127.0.0.1` | Bind address. Keep loopback only. |
| `ANALYSIS_PORT` | `8001` | Port |
| `ANALYSIS_DOCS_ENABLED` | `true` | Expose `/docs`, `/redoc`, `/openapi.json` |
| `ANALYSIS_INTERNAL_TOKEN` | (unset) | Required by `/internal/*` (503 while unset). Never commit or log a value. |
| `ANALYSIS_MAX_BODY_BYTES` | `16777216` | Request body limit for `/internal/*` (1024 – 67108864) |

`ANALYSIS_HOST` / `ANALYSIS_PORT` apply to `python -m app`; when running `uvicorn` directly, pass `--host` / `--port`.
