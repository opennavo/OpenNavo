"""Read packaged generated artifacts; all HTTP paths come from the Agent allowlist."""

import json
import re
from importlib.resources import files
from typing import Any, cast

from pydantic import BaseModel

from opennavo_mcp.gen import admin_models

OPERATIONS: dict[str, Any] = json.loads(
    files("opennavo_mcp.gen").joinpath("operations.json").read_text()
)
LOCALES: dict[str, Any] = json.loads(files("opennavo_mcp.gen").joinpath("locales.json").read_text())


def snake(value: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", value).lower()


def input_model(operation: str) -> type[BaseModel]:
    return cast(type[BaseModel], getattr(admin_models, OPERATIONS[operation]["model"]))


def expand(schema: dict[str, Any], definitions: dict[str, Any]) -> dict[str, Any]:
    if "$ref" in schema:
        return expand(definitions[schema["$ref"].split("/")[-1]], definitions)
    if "anyOf" in schema:
        options = [x for x in schema["anyOf"] if x.get("type") != "null"]
        if len(options) == 1:
            return expand(options[0], definitions)
        expanded = [expand(option, definitions) for option in options]
        if expanded and all("properties" in option for option in expanded):
            properties: dict[str, Any] = {}
            required = set(expanded[0].get("required", []))
            for option in expanded:
                properties.update(option["properties"])
                required.intersection_update(option.get("required", []))
            return {"type": "object", "properties": properties, "required": sorted(required)}
    return schema


def request_schema(operation: str) -> dict[str, Any]:
    return input_model(operation).model_json_schema()
