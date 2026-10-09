"""A small ABI layer over eth-abi: calls, results, errors and events, with structs as dicts keyed by component name."""
from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from importlib import resources
from typing import Any

from eth_abi.abi import decode, encode
from eth_utils.address import to_checksum_address
from eth_utils.crypto import keccak


def load_abi(name: str) -> list[dict[str, Any]]:
    text = resources.files("mercurifi.abi").joinpath(f"{name}.json").read_text(encoding="utf-8")
    abi: list[dict[str, Any]] = json.loads(text)
    return abi


def to_hex(b: bytes) -> str:
    return "0x" + bytes(b).hex()


def from_hex(s: str) -> bytes:
    return bytes.fromhex(s[2:] if s.startswith("0x") else s)


def canonical_type(param: Mapping[str, Any]) -> str:
    t: str = param["type"]
    if t.startswith("tuple"):
        return "(" + ",".join(canonical_type(c) for c in param["components"]) + ")" + t[5:]
    return t


def _signature(item: Mapping[str, Any]) -> str:
    return f"{item['name']}(" + ",".join(canonical_type(i) for i in item.get("inputs", [])) + ")"


def _to_abi(param: Mapping[str, Any], value: Any) -> Any:
    t: str = param["type"]
    if t.endswith("]"):
        inner = {**param, "type": t[: t.rindex("[")]}
        return [_to_abi(inner, v) for v in value]
    if t == "tuple":
        comps = param["components"]
        if isinstance(value, Mapping):
            return tuple(_to_abi(c, value[c["name"]]) for c in comps)
        return tuple(_to_abi(c, v) for c, v in zip(comps, value))
    if t.startswith("bytes") and isinstance(value, str):
        return from_hex(value)
    return value


def _from_abi(param: Mapping[str, Any], value: Any) -> Any:
    t: str = param["type"]
    if t.endswith("]"):
        inner = {**param, "type": t[: t.rindex("[")]}
        return [_from_abi(inner, v) for v in value]
    if t == "tuple":
        return {c["name"]: _from_abi(c, v) for c, v in zip(param["components"], value)}
    if t == "address":
        return to_checksum_address(value)
    if t.startswith("bytes"):
        return to_hex(value)
    return value


def _encode_params(params: Sequence[Mapping[str, Any]], values: Sequence[Any]) -> bytes:
    return encode([canonical_type(p) for p in params], [_to_abi(p, v) for p, v in zip(params, values)])


def _decode_params(params: Sequence[Mapping[str, Any]], data: bytes) -> list[Any]:
    raw = decode([canonical_type(p) for p in params], data)
    return [_from_abi(p, v) for p, v in zip(params, raw)]


class Contract:
    def __init__(self, abi: list[dict[str, Any]], name: str) -> None:
        self.name = name
        self.abi = abi
        self._functions: dict[str, list[dict[str, Any]]] = {}
        self._by_selector: dict[str, dict[str, Any]] = {}
        self._errors: dict[str, dict[str, Any]] = {}
        self._errors_by_name: dict[str, dict[str, Any]] = {}
        self._events: dict[str, dict[str, Any]] = {}
        self._events_by_name: dict[str, dict[str, Any]] = {}
        for item in abi:
            kind = item["type"]
            if kind == "function":
                self._functions.setdefault(item["name"], []).append(item)
                self._by_selector[to_hex(keccak(text=_signature(item))[:4])] = item
            elif kind == "error":
                self._errors[to_hex(keccak(text=_signature(item))[:4])] = item
                self._errors_by_name[item["name"]] = item
            elif kind == "event":
                self._events[to_hex(keccak(text=_signature(item)))] = item
                self._events_by_name[item["name"]] = item

    def function(self, fn: str, arity: int | None = None) -> dict[str, Any]:
        items = self._functions.get(fn, [])
        matches = [i for i in items if arity is None or len(i.get("inputs", [])) == arity]
        if not matches:
            raise KeyError(f"{self.name} has no function {fn}")
        return matches[0]

    def selector(self, fn: str) -> str:
        return to_hex(keccak(text=_signature(self.function(fn)))[:4])

    def encode(self, fn: str, *args: object) -> str:
        item = self.function(fn, len(args))
        return to_hex(keccak(text=_signature(item))[:4] + _encode_params(item.get("inputs", []), args))

    def decode_input(self, data: str) -> tuple[str, dict[str, Any]]:
        raw = from_hex(data)
        item = self._by_selector.get(to_hex(raw[:4]))
        if item is None:
            raise ValueError(f"unknown selector {to_hex(raw[:4])} for {self.name}")
        inputs = item.get("inputs", [])
        values = _decode_params(inputs, raw[4:])
        return item["name"], {p.get("name") or f"arg{i}": v for i, (p, v) in enumerate(zip(inputs, values))}

    def decode_output(self, fn: str, data: str) -> Any:
        outputs = self.function(fn).get("outputs", [])
        if not outputs:
            return None
        values = _decode_params(outputs, from_hex(data))
        return values[0] if len(values) == 1 else tuple(values)

    def encode_result(self, fn: str, value: object) -> str:
        outputs = self.function(fn).get("outputs", [])
        if not outputs:
            return "0x"
        values = [value] if len(outputs) == 1 else list(value)  # type: ignore[call-overload]
        return to_hex(_encode_params(outputs, values))

    def decode_error(self, data: str) -> tuple[str, list[Any]] | None:
        raw = from_hex(data)
        item = self._errors.get(to_hex(raw[:4]))
        if item is None:
            return None
        return item["name"], _decode_params(item.get("inputs", []), raw[4:])

    def encode_error(self, name: str, *args: object) -> str:
        item = self._errors_by_name[name]
        return to_hex(keccak(text=_signature(item))[:4] + _encode_params(item.get("inputs", []), args))

    def decode_log(self, topics: list[str], data: str) -> tuple[str, dict[str, Any]] | None:
        if not topics:
            return None
        item = self._events.get(topics[0].lower())
        if item is None:
            return None
        inputs = item.get("inputs", [])
        indexed = [p for p in inputs if p.get("indexed")]
        plain = [p for p in inputs if not p.get("indexed")]
        out: dict[str, Any] = {}
        for p, topic in zip(indexed, topics[1:]):
            dynamic = p["type"] in ("string", "bytes") or p["type"].startswith("tuple") or p["type"].endswith("]")
            out[p["name"]] = topic if dynamic else _decode_params([p], from_hex(topic))[0]
        for p, v in zip(plain, _decode_params(plain, from_hex(data))):
            out[p["name"]] = v
        return item["name"], out

    def encode_log(self, name: str, values: Mapping[str, object]) -> tuple[list[str], str]:
        item = self._events_by_name[name]
        inputs = item.get("inputs", [])
        topics = [to_hex(keccak(text=_signature(item)))]
        for p in (p for p in inputs if p.get("indexed")):
            topics.append(to_hex(_encode_params([p], [values.get(p["name"], _zero(p))])))
        plain = [p for p in inputs if not p.get("indexed")]
        return topics, to_hex(_encode_params(plain, [values.get(p["name"], _zero(p)) for p in plain]))


def _zero(p: Mapping[str, Any]) -> Any:
    t: str = p["type"]
    if t == "address":
        return "0x" + "00" * 20
    if t == "bool":
        return False
    if t == "string":
        return ""
    if t == "bytes":
        return b""
    if t.startswith("bytes"):
        return b"\x00" * int(t[5:])
    if t == "tuple":
        return {c["name"]: _zero(c) for c in p["components"]}
    if t.endswith("]"):
        return []
    return 0
