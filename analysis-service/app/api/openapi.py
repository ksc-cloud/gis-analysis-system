"""OpenAPI additions for /docs. Documentation only: nothing here runs while a request is handled.

* The internal endpoints read the raw body (app.api.internal), so FastAPI does not know their request models;
  their JSON schemas are added to components.schemas and referenced from requestBody.
* The X-Internal-Token header is declared as an API key security scheme so /docs can send it. The check itself
  stays in app.security.InternalApiGuard.
"""

import json

from fastapi import FastAPI
from fastapi.openapi.utils import get_openapi
from pydantic import BaseModel
from pydantic.json_schema import models_json_schema

from app.security import TOKEN_HEADER

SECURITY_SCHEME = "InternalToken"
_REF = "#/components/schemas/"


def request_body(model: type[BaseModel]) -> dict:
    """openapi_extra of an internal endpoint whose body is ``model``."""
    return {
        "requestBody": {"required": True,
                        "content": {"application/json": {"schema": {"$ref": _REF + model.__name__}}}},
        "security": [{SECURITY_SCHEME: []}],
    }


def install(app: FastAPI, request_models: list[type[BaseModel]]) -> None:

    def openapi() -> dict:
        if app.openapi_schema is None:
            schema = get_openapi(title=app.title, version=app.version, description=app.description,
                                 routes=app.routes)
            components = schema.setdefault("components", {})
            _add_schemas(components.setdefault("schemas", {}), request_models)
            components["securitySchemes"] = {SECURITY_SCHEME: {
                "type": "apiKey", "in": "header", "name": TOKEN_HEADER,
                "description": "ANALYSIS_INTERNAL_TOKEN과 같은 값. 없으면 401, 서버에 설정되지 않았으면 503입니다."}}
            app.openapi_schema = schema
        return app.openapi_schema

    app.openapi = openapi


def _add_schemas(schemas: dict, models: list[type[BaseModel]]) -> None:
    """Adds the validation schemas of ``models``. A name already used by a different (response) schema gets the
    suffix -Input, and references to it are rewritten."""
    _, generated = models_json_schema([(m, "validation") for m in models], ref_template=_REF + "{model}")
    definitions = generated.get("$defs", {})
    renamed = {name: f"{name}-Input" for name, definition in definitions.items()
               if name in schemas and schemas[name] != definition}
    text = json.dumps(definitions)
    for old, new in renamed.items():
        text = text.replace(f'"{_REF}{old}"', f'"{_REF}{new}"')
    for name, definition in json.loads(text).items():
        schemas[renamed.get(name, name)] = definition
