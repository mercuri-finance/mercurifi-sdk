# Mercurifi Agent Accounts example. Read docs/security-model.md first:
# agent keys can lose money within your caps.
#
# Fund OWNER_KEY with testnet USDC at https://faucet.circle.com (Arc testnet),
# then run:
#   OWNER_KEY=0x… python examples/quickstart_testnet.py <launch token>
import asyncio
import os
import sys

from mercurifi import FirstAgent, create_client, generate_agent_key, local_key


async def main() -> None:
    mf = await create_client("testnet")

    # The owner wallet creates the account, funds it and gives the agent key gas.
    owner = mf.owner(local_key(os.environ["OWNER_KEY"]))

    # Demo only: a real bot stores the key in a secret manager
    # and reads it at the call site.
    key = generate_agent_key()

    created = await owner.create_account(first_agent=FirstAgent(key.address))

    await owner.deposit(created.account, usdc="20")

    await owner.fund_gas(key.address, usdc="0.5")

    # The agent key trades for the account.
    agent = await mf.agent(created.account, local_key(key.export_private_key()))

    fill = await agent.buy(sys.argv[1], usdc="5", slippage=0.02)

    print(f"bought {fill.tokens} tokens for {fill.usdc_spent} USDC in {fill.tx_hash}")


asyncio.run(main())
