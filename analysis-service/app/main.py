"""FastAPI application factory.

No CORS middleware: browsers never call this service directly; the Java server
will proxy internal analysis requests in a later step.
"""

from fastapi import FastAPI

from app import __version__
from app.api import health
from app.config import Settings


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    docs = settings.docs_enabled
    app = FastAPI(
        title="GIS Analysis Service",
        version=__version__,
        docs_url="/docs" if docs else None,
        redoc_url="/redoc" if docs else None,
        openapi_url="/openapi.json" if docs else None,
    )
    app.state.settings = settings
    app.include_router(health.router)
    return app


app = create_app()
