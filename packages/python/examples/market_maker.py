# Mercurifi Agent Accounts example. Read docs/security-model.md first: agent keys can lose money within your caps.
# ACCOUNT=0x… AGENT_KEY=0x… python examples/market_maker.py <token>   (selling needs the opt-in sell permission)
import asyncio
import os
import sys

from mercurifi import ContractRevertError, create_client, local_key

TARGET = 50_000 * 10**18


async def main(token: str) -> None:
    mf = await create_client("testnet", api_key=os.environ.get("MERCURIFI_API_KEY"))
    agent = await mf.agent(os.environ["ACCOUNT"], local_key(os.environ["AGENT_KEY"]), slippage=0.01)
    async for ev in mf.stream([f"token:{token.lower()}"]):
        # Curve trades only: after graduation the token trades in a pool, and those arrive as separate `pool_trade` events.
        if ev.type != "trade":
            continue  # 'reset' means a gap; the loop re-reads state on the next trade anyway
        room, pos = await asyncio.gather(agent.headroom(), agent.position(token))
        try:
            if pos.balance_wei < TARGET and room.spend_usdc6 >= 2_000_000:
                f = await agent.buy(token, usdc="2")
                print(f"buy {f.tokens} for {f.usdc_spent} USDC")
            elif pos.balance_wei > TARGET * 2:
                f = await agent.sell(token, amount_wei=pos.balance_wei - TARGET)
                print(f"sell {f.tokens} for {f.usdc_received} USDC")
        except ContractRevertError as e:
            print(f"skipped: {e}")


asyncio.run(main(sys.argv[1]))
