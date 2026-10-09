FROM ghcr.io/astral-sh/uv:0.12.9 AS uv
FROM python:3.13-alpine AS build
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
COPY pyproject.toml uv.lock .python-version ./
COPY src ./src
COPY third-party ./third-party
RUN uv sync --locked --no-dev --no-editable

FROM python:3.13-alpine
# The frozen application venv is copied below; pip is not used at runtime.
RUN apk upgrade --no-cache && rm -rf /usr/local/lib/python3.13/site-packages/pip* /usr/local/bin/pip*
COPY third-party/ /usr/share/licenses/opennavo/
WORKDIR /app
COPY --from=build --chown=10001:10001 /app/.venv /app/.venv
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1 OPENNAVO_MCP_HOST=0.0.0.0 OPENNAVO_MCP_PORT=8790
USER 10001:10001
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["python", "-I", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8790/healthz', timeout=2).close()"]
ENTRYPOINT ["opennavo-mcp"]
