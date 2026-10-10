"""A small ABI layer over eth-abi: calls, results, errors and events, with structs as dicts keyed by component name."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from importlib import resources
from typing import Any

from eth_abi.abi import decode, encode
from eth_abi.exceptions import DecodingError, EncodingError
from eth_utils.address import to_checksum_address
from eth_utils.crypto import keccak

from .errors import MercurifiError


class AbiDecodeError(MercurifiError):
    """Bytes are not canonical ABI data for the expected types (truncated, padded, dirty or non-canonical offsets)."""

    code = "ABI_MALFORMED"


class AbiUnknownSelectorError(AbiDecodeError):
    """The 4-byte selector is not in this ABI."""

    code = "ABI_UNKNOWN_SELECTOR"


class AbiEncodeError(MercurifiError):
    """Arguments do not fit the ABI types (wrong count, missing struct key, out of range) or the name is ambiguous or unknown."""

    code = "ABI_ENCODE"


def load_abi(name: str) -> list[dict[str, Any]]:
    text = resources.files("mercurifi.abi").joinpath(f"{name}.json").read_text(encoding="utf-8")
    abi: list[dict[str, Any]] = json.loads(text)
    return abi


def to_hex(b: bytes) -> str:
    return "0x" + bytes(b).hex()


def from_hex(s: str) -> bytes:
    try:
        return bytes.fromhex(s[2:] if s.startswith("0x") else s)
    except (ValueError, TypeError) as exc:
        raise AbiDecodeError("not valid hex (odd length or non-hex characters)") from exc


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
            missing = [c["name"] for c in comps if c["name"] not in value]
            if missing:
                raise AbiEncodeError(f"missing struct field(s): {', '.join(missing)}")
            return tuple(_to_abi(c, value[c["name"]]) for c in comps)
        return tuple(_to_abi(c, v) for c, v in zip(comps, value, strict=True))
    if t.startswith("bytes") and isinstance(value, str):
        return from_hex(value)
    return value


def _from_abi(param: Mapping[str, Any], value: Any) -> Any:
    t: str = param["type"]
    if t.endswith("]"):
        inner = {**param, "type": t[: t.rindex("[")]}
        return [_from_abi(inner, v) for v in value]
    if t == "tuple":
        return {c["name"]: _from_abi(c, v) for c, v in zip(param["components"], value, strict=True)}
    if t == "address":
        return to_checksum_address(value)
    if t.startswith("bytes"):
        return to_hex(value)
    return value


def _encode_params(params: Sequence[Mapping[str, Any]], values: Sequence[Any]) -> bytes:
    if len(params) != len(values):
        raise AbiEncodeError(f"expected {len(params)} argument(s), got {len(values)}")
    try:
        return encode(
            [canonical_type(p) for p in params],
            [_to_abi(p, v) for p, v in zip(params, values, strict=True)],
        )
    except AbiEncodeError:
        raise
    except (EncodingError, ValueError, TypeError, KeyError) as exc:
        raise AbiEncodeError(f"cannot encode arguments: {type(exc).__name__}: {exc}") from exc


def _decode_params(
    params: Sequence[Mapping[str, Any]], data: bytes, strict: bool = True
) -> list[Any]:
    types = [canonical_type(p) for p in params]
    try:
        raw = decode(types, data)
        # eth-abi ignores trailing bytes and non-canonical offsets; the only canonical form is what encode() produces.
        if strict and encode(types, raw) != data:
            raise AbiDecodeError(
                "non-canonical ABI data (trailing bytes, dirty padding or non-canonical offsets)"
            )
    except AbiDecodeError:
        raise
    except (DecodingError, EncodingError, ValueError, TypeError, OverflowError) as exc:
        raise AbiDecodeError(f"malformed ABI data: {type(exc).__name__}") from exc
    return [_from_abi(p, v) for p, v in zip(params, raw, strict=True)]


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
                sel = to_hex(keccak(text=_signature(item))[:4])
                seen = self._by_selector.get(sel)
                if seen is not None:
                    if _signature(seen) != _signature(item):
                        raise ValueError(
                            f"{name}: selector {sel} is shared by {_signature(seen)} and {_signature(item)}"
                        )
                    continue
                self._functions.setdefault(item["name"], []).append(item)
                self._by_selector[sel] = item
            elif kind == "error":
                sel = to_hex(keccak(text=_signature(item))[:4])
                seen = self._errors.get(sel)
                if seen is not None and _signature(seen) != _signature(item):
                    raise ValueError(
                        f"{name}: error selector {sel} is shared by {_signature(seen)} and {_signature(item)}"
                    )
                self._errors[sel] = item
                self._errors_by_name[item["name"]] = item
            elif kind == "event":
                self._events[to_hex(keccak(text=_signature(item)))] = item
                self._events_by_name[item["name"]] = item

    def function(self, fn: str, arity: int | None = None) -> dict[str, Any]:
        items = self._functions.get(fn, [])
        matches = [i for i in items if arity is None or len(i.get("inputs", [])) == arity]
        if not matches and items:
            raise AbiEncodeError(
                f"{self.name}.{fn} takes {len(items[0].get('inputs', []))} argument(s), not {arity}"
            )
        if not matches:
            raise AbiUnknownSelectorError(f"{self.name} has no function {fn}")
        if len(matches) > 1:
            raise AbiEncodeError(f"{self.name}.{fn} is overloaded; pass the arity")
        return matches[0]

    def error_signatures(self) -> dict[str, str]:
        """Error selector -> canonical signature."""
        return {sel: _signature(item) for sel, item in self._errors.items()}

    def selector(self, fn: str) -> str:
        return to_hex(keccak(text=_signature(self.function(fn)))[:4])

    def encode(self, fn: str, *args: object) -> str:
        item = self.function(fn, len(args))
        return to_hex(
            keccak(text=_signature(item))[:4] + _encode_params(item.get("inputs", []), args)
        )

    def decode_input(self, data: str, strict: bool = True) -> tuple[str, dict[str, Any]]:
        raw = from_hex(data)
        item = self._by_selector.get(to_hex(raw[:4]))
        if item is None:
            raise AbiUnknownSelectorError(f"unknown selector {to_hex(raw[:4])} for {self.name}")
        inputs = item.get("inputs", [])
        values = _decode_params(inputs, raw[4:], strict)
        return item["name"], {
            p.get("name") or f"arg{i}": v
            for i, (p, v) in enumerate(zip(inputs, values, strict=True))
        }

    def decode_output(self, fn: str, data: str, strict: bool = True) -> Any:
        outputs = self.function(fn).get("outputs", [])
        if not outputs:
            return None
        values = _decode_params(outputs, from_hex(data), strict)
        return values[0] if len(values) == 1 else tuple(values)

    def encode_result(self, fn: str, value: object) -> str:
        outputs = self.function(fn).get("outputs", [])
        if not outputs:
            return "0x"
        if len(outputs) == 1:
            values = [value]
        elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
            values = list(value)
        else:
            raise AbiEncodeError(f"{fn} returns {len(outputs)} values; pass a sequence")
        return to_hex(_encode_params(outputs, values))

    def decode_error(self, data: str, strict: bool = True) -> tuple[str, list[Any]] | None:
        raw = from_hex(data)
        item = self._errors.get(to_hex(raw[:4]))
        if item is None:
            return None
        return item["name"], _decode_params(item.get("inputs", []), raw[4:], strict)

    def encode_error(self, name: str, *args: object) -> str:
        item = self._errors_by_name.get(name)
        if item is None:
            raise AbiEncodeError(f"{self.name} has no error {name}")
        return to_hex(
            keccak(text=_signature(item))[:4] + _encode_params(item.get("inputs", []), args)
        )

    def decode_log(self, topics: list[str], data: str) -> tuple[str, dict[str, Any]] | None:
        if not topics:
            return None
        item = self._events.get(topics[0].lower())
        if item is None:
            return None
        inputs = item.get("inputs", [])
        indexed = [p for p in inputs if p.get("indexed")]
        plain = [p for p in inputs if not p.get("indexed")]
        if len(topics) != 1 + len(indexed):
            raise AbiDecodeError(
                f"{item['name']} expects {1 + len(indexed)} topics, got {len(topics)}"
            )
        out: dict[str, Any] = {}
        for p, topic in zip(indexed, topics[1:], strict=True):
            dynamic = (
                p["type"] in ("string", "bytes")
                or p["type"].startswith("tuple")
                or p["type"].endswith("]")
            )
            raw_topic = from_hex(topic)
            if len(raw_topic) != 32:
                raise AbiDecodeError("topic is not 32 bytes")
            out[p["name"]] = to_hex(raw_topic) if dynamic else _decode_params([p], raw_topic)[0]
        for p, v in zip(plain, _decode_params(plain, from_hex(data)), strict=True):
            out[p["name"]] = v
        return item["name"], out

    def encode_log(self, name: str, values: Mapping[str, object]) -> tuple[list[str], str]:
        item = self._events_by_name.get(name)
        if item is None:
            raise AbiEncodeError(f"{self.name} has no event {name}")
        inputs = item.get("inputs", [])
        topics = [to_hex(keccak(text=_signature(item)))]
        for p in (p for p in inputs if p.get("indexed")):
            topics.append(to_hex(_encode_params([p], [values.get(p["name"], _zero(p))])))
        plain = [p for p in inputs if not p.get("indexed")]
        return topics, to_hex(
            _encode_params(plain, [values.get(p["name"], _zero(p)) for p in plain])
        )


class ErrorDecoder:
    """Decodes revert data against several ABIs in order. The first ABI that declares the selector wins.

    The same selector with the same signature in two ABIs is fine (one message); the same selector with a different
    signature is ambiguous and raises when the decoder is built.
    """

    def __init__(self, contracts: Sequence[Contract]) -> None:
        self.contracts = tuple(contracts)
        seen: dict[str, str] = {}
        for c in self.contracts:
            for sel, sig in c.error_signatures().items():
                if seen.setdefault(sel, sig) != sig:
                    raise ValueError(f"error selector {sel} means {seen[sel]} and {sig}")

    def decode(self, data: str) -> tuple[str, str, list[Any]] | None:
        """(source ABI name, error name, args) or None when no ABI declares the selector."""
        for c in self.contracts:
            hit = c.decode_error(data)
            if hit is not None:
                return c.name, hit[0], hit[1]
        return None


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
