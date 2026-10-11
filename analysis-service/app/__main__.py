"""Entry point: ``python -m app`` starts the server on the configured host/port."""

import uvicorn

from app.config import Settings


def main() -> None:
    settings = Settings.from_env()
    uvicorn.run("app.main:app", host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
