"""FastAPI application factory.

No CORS middleware: browsers never call this service directly; the Java server
will proxy internal analysis requests in a later step.
"""

from fastapi import FastAPI

from app import __version__
from app.api import errors, health, internal, openapi
from app.config import Settings
from app.security import InternalApiGuard


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
    app.add_middleware(InternalApiGuard, settings=settings)
    errors.install(app)
    app.include_router(health.router)
    app.include_router(internal.router)
    openapi.install(app, internal.REQUEST_MODELS)
    return app


app = create_app()
