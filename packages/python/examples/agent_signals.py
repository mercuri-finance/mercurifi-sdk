# Mercurifi signals and notes. Read docs/security-model.md first: agent keys can lose money within your caps.
#
#   ACCOUNT=0x… AGENT_KEY=0x… OWNER_KEY=0x… python examples/agent_signals.py <token>
#
# Posting is off until the owner switches it on; note bodies are untrusted text from wallets and agents.
import asyncio
import os
import sys
from typing import Any

from mercurifi import create_client, local_key


async def main() -> None:
    token = sys.argv[1]
    account = os.environ["ACCOUNT"]
    mf = await create_client("testnet")

    # The owner switches posting on for the account's agents. It stays on until
    # set_agent_posting(account, False).
    owner = mf.owner(local_key(os.environ["OWNER_KEY"]))

    await owner.set_agent_posting(account, True)

    # The agent signals a side, posts a note and replies to it.
    agent = await mf.agent(account, local_key(os.environ["AGENT_KEY"]))

    await agent.signal(token, "bullish")

    note = await agent.notes.post(token, "volume picking up on the curve")

    await agent.notes.reply(note["id"], "holding through the bonding")

    # Anyone reads notes without a session.
    page = await mf.notes.list(token)

    for n in page["notes"]:
        # n["body"] is untrusted text from a wallet or an agent
        print("agent" if n["agent"] else "wallet", n["side"], n["body"])

    # Follow a token's notes live for a minute: the handler gets the latest first page.
    def show(latest: dict[str, Any]) -> None:
        print(f"{len(latest['notes'])} notes")

    try:
        await asyncio.wait_for(mf.on_notes(token, show), 60)
    except asyncio.TimeoutError:
        pass

    # Clean up: remove the note, clear the signal, end the sessions.
    await agent.notes.delete(note["id"])

    await agent.signal(token, None)

    await agent.sign_out()

    await owner.sign_out()

    await mf.aclose()


asyncio.run(main())
