import json
from typing import Any, cast

import httpx2
import pytest
from fastmcp import Client
from starlette.responses import JSONResponse
from starlette.types import Receive, Scope, Send

from opennavo_mcp.public_server import (
    MAX_OUTPUT_BYTES,
    PublicAPIClient,
    PublicGCRALimiter,
    PublicMCPError,
    PublicPeerMiddleware,
    PublicRateLimitMiddleware,
    PublicSettings,
    app_summary,
    create_public_server,
    fit_public_output,
)


def settings(base: str = "https://api.example.test/api/v1") -> PublicSettings:
    return PublicSettings.model_validate({"OPENNAVO_PUBLIC_API_BASE": base})


async def close_client(client: PublicAPIClient) -> None:
    await client.close()


async def test_public_client_uses_only_configured_public_base() -> None:
    calls: list[httpx2.Request] = []

    def handle(request: httpx2.Request) -> httpx2.Response:
        calls.append(request)
        if request.url.path.endswith("/collections/demo/brewfile"):
            return httpx2.Response(200, text='cask "demo"\n')
        return httpx2.Response(200, json={"code": "0000", "data": {"records": []}})

    client = PublicAPIClient(settings(), httpx2.AsyncClient(transport=httpx2.MockTransport(handle)))
    try:
        assert await client.get("/search", {"q": "code"}) == {"records": []}
        assert calls[0].url.host == "api.example.test"
        assert calls[0].url.path == "/api/v1/search"
        assert await client.get("/collections/demo/brewfile", text=True) == 'cask "demo"\n'
        with pytest.raises(ValueError):
            await client.get("/admin-api/users")
        with pytest.raises(ValueError):
            await client.get("//evil.example/api/v1/search")
    finally:
        await close_client(client)


async def test_public_client_forwards_only_resolved_peer() -> None:
    calls: list[httpx2.Request] = []

    def handle(request: httpx2.Request) -> httpx2.Response:
        calls.append(request)
        return httpx2.Response(200, json={"code": "0000", "data": {"records": []}})

    client = PublicAPIClient(settings(), httpx2.AsyncClient(transport=httpx2.MockTransport(handle)))

    async def endpoint(scope: Scope, receive: Receive, send: Send) -> None:
        await client.get("/categories")
        await JSONResponse({"ok": True})(scope, receive, send)

    app = PublicPeerMiddleware(endpoint, ["172.30.80.2/32"])
    transport = httpx2.ASGITransport(app=app, client=("172.30.80.2", 1234))
    try:
        async with httpx2.AsyncClient(transport=transport, base_url="http://test") as caller:
            response = await caller.get(
                "/", headers={"X-Forwarded-For": "198.51.100.9, 203.0.113.10"}
            )
        assert response.status_code == 200
        assert calls[0].headers["X-Forwarded-For"] == "203.0.113.10"
    finally:
        await close_client(client)


@pytest.mark.parametrize(
    ("status", "message"),
    [
        (404, "public_api_not_found"),
        (429, "public_api_rate_limited"),
        (500, "public_api_unavailable"),
    ],
)
async def test_public_client_maps_upstream_errors(status: int, message: str) -> None:
    def handle(_: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(status, text="internal details must not escape")

    client = PublicAPIClient(settings(), httpx2.AsyncClient(transport=httpx2.MockTransport(handle)))
    try:
        with pytest.raises(PublicMCPError, match=message) as error:
            await client.get("/categories")
        assert "internal details" not in str(error.value)
    finally:
        await close_client(client)


async def test_public_client_maps_timeout() -> None:
    def handle(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ReadTimeout("upstream timeout", request=request)

    client = PublicAPIClient(settings(), httpx2.AsyncClient(transport=httpx2.MockTransport(handle)))
    try:
        with pytest.raises(PublicMCPError, match="public_api_timeout"):
            await client.get("/categories")
    finally:
        await close_client(client)


async def test_public_tools_are_read_only_and_compact() -> None:
    def handle(request: httpx2.Request) -> httpx2.Response:
        data: dict[str, Any]
        if request.url.path.endswith("/packages/cask/demo"):
            data = {
                "token": "demo",
                "displayName": "Demo",
                "summary": "S" * 10_000,
                "hidden": True,
                "draft": {"secret": "must not pass"},
                "installCommand": "brew install --cask demo",
                "repoUrl": "https://github.com/example/demo",
                "license": "MIT",
            }
        else:
            data = {"records": []}
        return httpx2.Response(200, json={"code": "0000", "msg": "ok", "data": data})

    http = httpx2.AsyncClient(transport=httpx2.MockTransport(handle))
    api = PublicAPIClient(settings(), http)
    server = create_public_server(settings(), api)
    async with Client(server) as client:
        tools = await client.list_tools()
        assert len(tools) == 9
        assert {tool.name for tool in tools} == {
            "search_apps",
            "get_app",
            "get_app_releases",
            "get_app_dependencies",
            "similar_apps",
            "list_categories",
            "rankings",
            "collections",
            "articles",
        }
        for tool in tools:
            assert tool.annotations is not None
            assert tool.annotations.read_only_hint is True
            assert tool.annotations.destructive_hint is False
            assert tool.annotations.idempotent_hint is True
        result = await client.call_tool("get_app", {"token": "demo"})
        assert result.is_error is False
        data = cast(dict[str, Any], result.data)
        assert data["link"] == "https://opennavo.com/apps/demo"
        assert data["installCommand"] == "brew install --cask demo"
        assert "hidden" not in json.dumps(data)
        assert "must not pass" not in json.dumps(data)
        assert len(json.dumps(data, ensure_ascii=False).encode()) <= MAX_OUTPUT_BYTES


def test_selected_outputs_have_links_and_size_caps() -> None:
    summary = app_summary({"kind": "cask", "token": "demo", "hidden": True})
    assert summary["link"] == "https://opennavo.com/apps/demo"
    assert "hidden" not in summary
    result = fit_public_output(
        {"link": "https://opennavo.com/apps/demo", "items": ["x" * 10_000] * 100},
        "https://opennavo.com/apps/demo",
    )
    assert len(json.dumps(result, ensure_ascii=False).encode()) <= MAX_OUTPUT_BYTES
    assert result["link"] == "https://opennavo.com/apps/demo"


async def test_public_gcra_is_per_ip_and_bounded() -> None:
    limiter = PublicGCRALimiter(2, 60)
    assert (await limiter.check("203.0.113.1", now=0.0))[0] is True
    assert (await limiter.check("203.0.113.1", now=0.0))[0] is True
    allowed, retry_after, _ = await limiter.check("203.0.113.1", now=0.0)
    assert allowed is False and retry_after > 0
    assert (await limiter.check("203.0.113.2", now=0.0))[0] is True


async def test_public_gcra_caps_buckets_and_evicts_least_recently_used() -> None:
    limiter = PublicGCRALimiter(1, 60, max_entries=3)
    for key in ("a", "b", "c"):
        assert (await limiter.check(key, now=0.0))[0] is True
    assert list(limiter._buckets) == ["a", "b", "c"]  # pyright: ignore[reportPrivateUsage]

    # A denied request still makes the limited client recent; the oldest other
    # client is evicted when the fourth distinct client arrives.
    allowed, _, _ = await limiter.check("a", now=0.0)
    assert allowed is False
    assert list(limiter._buckets) == ["b", "c", "a"]  # pyright: ignore[reportPrivateUsage]
    assert (await limiter.check("d", now=1.0))[0] is True
    assert list(limiter._buckets) == ["c", "a", "d"]  # pyright: ignore[reportPrivateUsage]
    assert len(limiter._buckets) == 3  # pyright: ignore[reportPrivateUsage]
    assert (await limiter.check("a", now=1.0))[0] is False


async def test_public_gcra_purges_expired_buckets_on_access() -> None:
    limiter = PublicGCRALimiter(1, 60, max_entries=3)
    assert (await limiter.check("expired-a", now=0.0))[0] is True
    assert (await limiter.check("expired-b", now=0.0))[0] is True
    assert (await limiter.check("fresh", now=60.0))[0] is True
    assert list(limiter._buckets) == ["fresh"]  # pyright: ignore[reportPrivateUsage]


@pytest.mark.parametrize(
    ("trusted", "forwarded", "expected"),
    [
        ([], "198.51.100.9", "203.0.113.10"),
        (["203.0.113.0/24"], "198.51.100.9", "198.51.100.9"),
    ],
)
async def test_public_peer_only_trusts_forwarded_for(
    trusted: list[str], forwarded: str, expected: str
) -> None:
    async def endpoint(scope: Scope, receive: Receive, send: Send) -> None:
        await JSONResponse({"peer": scope["state"]["public_peer"]})(scope, receive, send)

    app = PublicPeerMiddleware(endpoint, trusted)
    transport = httpx2.ASGITransport(app=app, client=("203.0.113.10", 1234))
    async with httpx2.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/", headers={"X-Forwarded-For": forwarded})
    assert response.json() == {"peer": expected}


async def test_public_rate_middleware_returns_clean_429() -> None:
    async def endpoint(scope: Scope, receive: Receive, send: Send) -> None:
        await JSONResponse({"ok": True})(scope, receive, send)

    limiter = PublicGCRALimiter(60, 60)
    app = PublicRateLimitMiddleware(endpoint, limiter)
    transport = httpx2.ASGITransport(app=app, client=("203.0.113.10", 1234))
    async with httpx2.AsyncClient(transport=transport, base_url="http://test") as client:
        responses = [await client.post("/mcp", json={}) for _ in range(61)]
    assert all(response.status_code == 200 for response in responses[:-1])
    limited = responses[-1]
    assert limited.status_code == 429
    assert limited.headers["Retry-After"] == "1"
    assert limited.json() == {
        "error": "rate_limited",
        "message": "Public MCP rate limit exceeded: per IP 60 requests / 60 s; retry after 1 s",
    }


async def test_public_rate_quotas_are_per_resolved_peer_and_ignore_forged_xff() -> None:
    async def endpoint(scope: Scope, receive: Receive, send: Send) -> None:
        await JSONResponse({"ok": True})(scope, receive, send)

    limiter = PublicGCRALimiter(2, 60)
    app = PublicPeerMiddleware(PublicRateLimitMiddleware(endpoint, limiter), [])
    client_a_transport = httpx2.ASGITransport(app=app, client=("203.0.113.10", 1234))
    client_b_transport = httpx2.ASGITransport(app=app, client=("203.0.113.11", 1234))
    async with (
        httpx2.AsyncClient(transport=client_a_transport, base_url="http://test") as client_a,
        httpx2.AsyncClient(transport=client_b_transport, base_url="http://test") as client_b,
    ):
        headers = {"X-Forwarded-For": "198.51.100.11"}
        assert (await client_a.post("/mcp", json={}, headers=headers)).status_code == 200
        assert (await client_a.post("/mcp", json={}, headers=headers)).status_code == 200
        assert (
            await client_a.post("/mcp", json={}, headers={"X-Forwarded-For": "198.51.100.12"})
        ).status_code == 429
        assert (await client_b.post("/mcp", json={}, headers=headers)).status_code == 200
