"""HTTP, stdio and in-memory tests share permission checks; caches never store plaintext tokens."""

from collections import OrderedDict
from contextvars import ContextVar
from dataclasses import dataclass
from hashlib import sha256
from time import monotonic
from typing import Any, cast

from fastmcp.server.auth import AccessToken, TokenVerifier
from fastmcp.server.dependencies import get_access_token

from opennavo_mcp.agent_client import AgentClient, AgentError
from opennavo_mcp.config import Settings

PEER: ContextVar[str] = ContextVar("mcp_peer", default="127.0.0.1")


@dataclass(frozen=True, repr=False)
class Credential:
    token: str
    ip: str


@dataclass(frozen=True)
class Identity:
    policy: dict[str, Any]

    def allows(self, permission: str) -> bool:
        return not permission or permission in self.policy["permissions"]

    @property
    def allow_delete(self) -> bool:
        return self.policy["allowDelete"] is True


CURRENT: ContextVar[tuple[Credential, Identity]] = ContextVar("mcp_identity")


class Authenticator:
    def __init__(self, client: AgentClient, ttl: float = 25):
        self.client = client
        self.ttl = min(max(ttl, 0), 25)
        self.cache: OrderedDict[tuple[str, str], tuple[float, Identity]] = OrderedDict()

    def invalidate(self, credential: Credential) -> None:
        self.cache.pop((sha256(credential.token.encode()).hexdigest(), credential.ip), None)

    async def authenticate(self, credential: Credential) -> Identity:
        key = sha256(credential.token.encode()).hexdigest(), credential.ip
        entry = self.cache.get(key)
        if entry and entry[0] > monotonic():
            return entry[1]
        self.cache.pop(key, None)
        policy = await self.client.call(
            "introspectAgentToken", credential.token, credential.ip, "whoami"
        )
        if not isinstance(policy, dict):
            raise AgentError("8888")
        policy = cast(dict[str, Any], policy)
        if (
            policy.get("active") is not True
            or policy.get("paused") is not False
            or not isinstance(policy.get("permissions"), list)
            or not isinstance(policy.get("allowDelete"), bool)
        ):
            raise AgentError("8888")
        identity = Identity(policy)
        self.cache[key] = monotonic() + self.ttl, identity
        while len(self.cache) > 1024:
            self.cache.popitem(last=False)
        return identity


class GatewayVerifier(TokenVerifier):
    def __init__(self, authenticator: Authenticator):
        super().__init__()
        self.authenticator = authenticator

    async def verify_token(self, token: str) -> AccessToken | None:
        try:
            identity = await self.authenticator.authenticate(Credential(token, PEER.get()))
        except AgentError:
            return None
        return AccessToken(
            token=token,
            client_id=str(identity.policy["clientId"]),
            scopes=identity.policy["permissions"],
        )


def credential(settings: Settings) -> Credential:
    token = get_access_token()
    if token:
        return Credential(token.token, PEER.get())
    if settings.transport == "stdio" and settings.token:
        return Credential(settings.token.get_secret_value(), "127.0.0.1")
    raise AgentError("8888")
