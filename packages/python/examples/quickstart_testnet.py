# Mercurifi Agent Accounts example. Read docs/security-model.md first: agent keys can lose money within your caps.
# OWNER_KEY=0x… python examples/quickstart_testnet.py <launch token>   (fund OWNER_KEY at https://faucet.circle.com, Arc testnet)
# Testnet only: no mainnet agent factory is deployed yet, so create_client("mainnet") raises NotDeployedError for agent calls.
import asyncio
import os
import sys

from mercurifi import FirstAgent, create_client, generate_agent_key, local_key


async def main() -> None:
    mf = await create_client("testnet")
    owner = mf.owner(local_key(os.environ["OWNER_KEY"]))
    key = generate_agent_key()  # keep key.export_private_key() on your server only
    created = await owner.create_account(first_agent=FirstAgent(key.address))
    await owner.deposit(created.account, usdc="20")
    await owner.fund_gas(key.address, usdc="0.5")
    agent = await mf.agent(created.account, local_key(key.export_private_key()))
    fill = await agent.buy(sys.argv[1], usdc="5", slippage=0.02)
    print(f"bought {fill.tokens} tokens for {fill.usdc_spent} USDC in {fill.tx_hash}")


asyncio.run(main())
