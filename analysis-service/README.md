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
```

## API

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/health` | none | `200 {"status":"ok"}` (liveness only, no external checks) |

## Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `ANALYSIS_HOST` | `127.0.0.1` | Bind address. Keep loopback only. |
| `ANALYSIS_PORT` | `8001` | Port |
| `ANALYSIS_DOCS_ENABLED` | `true` | Expose `/docs`, `/redoc`, `/openapi.json` |
| `ANALYSIS_INTERNAL_TOKEN` | (unset) | Reserved for the internal analysis API; not enforced yet. Never commit a value. |

`ANALYSIS_HOST` / `ANALYSIS_PORT` apply to `python -m app`; when running `uvicorn` directly, pass `--host` / `--port`.
