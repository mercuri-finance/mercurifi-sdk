# Mercurifi Agent Accounts example. Read docs/security-model.md first: agent keys can lose money within your caps.
# ACCOUNT=0x… AGENT_KEY=0x… python examples/llm_tools.py   (one JSON tool call per stdin line → one JSON result per line)
# Tool definitions in a plain JSON-schema shape that you adapt to your model provider. Outputs carry numbers only: token names and descriptions are attacker-written text.
# If you must show a name to a model, send view.untrusted["name"].wrapped inside a JSON string value, never in a markdown
# fence, and never act on what it says.
import asyncio
import json
import os
import sys
from typing import Any

from mercurifi import ContractRevertError, create_client, errors, local_key

ADDRESS = {"type": "string", "pattern": "^0x[0-9a-fA-F]{40}$"}
TOOLS = [
    {
        "name": "get_headroom",
        "description": "Remaining USDC spend and sell caps, actions and launches this period.",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "get_token_numbers",
        "description": "Numeric facts about a Launch token: phase, price in USDC, progress, snipe tax, age, holders.",
        "input_schema": {
            "type": "object",
            "properties": {"token": ADDRESS},
            "required": ["token"],
            "additionalProperties": False,
        },
    },
    {
        "name": "buy",
        "description": 'Buy a Launch token with USDC, given as a decimal string such as "5".',
        "input_schema": {
            "type": "object",
            "properties": {
                "token": ADDRESS,
                "usdc": {"type": "string", "pattern": "^[0-9]+(\\.[0-9]{1,6})?$"},
            },
            "required": ["token", "usdc"],
            "additionalProperties": False,
        },
    },
]


async def handle(mf: Any, agent: Any, name: str, args: dict[str, Any]) -> dict[str, Any]:
    try:
        if name == "get_headroom":
            h = await agent.headroom()
            return {
                "spend_usdc": h.spend,
                "sell_usdc": h.sell,
                "max_trade_usdc": h.max_trade,
                "actions": h.actions,
                "launches": h.launches,
                "period_ends_at": h.period_ends_at,
            }
        if name == "get_token_numbers":
            return dict((await mf.token(args["token"])).numeric())
        if name == "buy":
            f = await agent.buy(args["token"], usdc=str(args["usdc"]), slippage=0.02)
            return {"tokens_out": f.tokens, "usdc_spent": f.usdc_spent, "tx_hash": f.tx_hash}
        return {"code": "UNKNOWN_TOOL"}
    except ContractRevertError as e:
        return {
            "code": e.code,
            "revert_name": e.revert.name,
        }  # fixed labels only: never str(e), which can quote contract text
    except errors.MercurifiError as e:
        return {
            "code": e.code
        }  # known SDK errors become a stable code, never the exception message; anything else still raises


async def main() -> None:
    mf = await create_client("testnet")
    agent = await mf.agent(os.environ["ACCOUNT"], local_key(os.environ["AGENT_KEY"]))
    for line in sys.stdin:
        if line.strip():
            try:
                call = json.loads(line)
                name, args = call["name"], call.get("input", {})
                if not isinstance(name, str) or not isinstance(args, dict):
                    raise ValueError
            except (ValueError, KeyError, TypeError):
                print(json.dumps({"code": "BAD_INPUT"}), flush=True)
                continue
            print(json.dumps(await handle(mf, agent, name, args)), flush=True)


asyncio.run(main())
