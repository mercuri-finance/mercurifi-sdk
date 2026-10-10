# Mercurifi Agent Accounts example. Read docs/security-model.md first: agent keys can lose money within your caps.
# ACCOUNT=0x… AGENT_KEY=0x… MERCURIFI_API_KEY=mfk_test_… python examples/launch_bot.py <name> <symbol> [image.png]
# Image uploads need the API key owner's agent account to be older than 24 hours; before that, pass metadata_uri instead.
import asyncio
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from mercurifi import ImageUpload, create_client, local_key


async def main(name: str, symbol: str, image_path: str | None) -> None:
    mf = await create_client("testnet", api_key=os.environ["MERCURIFI_API_KEY"])
    agent = await mf.agent(os.environ["ACCOUNT"], local_key(os.environ["AGENT_KEY"]))
    room = await agent.headroom()
    if room.launches == 0:
        print(
            f"No launches left this period; caps reset at {datetime.fromtimestamp(room.period_ends_at, timezone.utc).isoformat()}."
        )
        return
    image = None
    if image_path:
        image = ImageUpload(
            Path(image_path).read_bytes(),
            "image/png" if image_path.endswith(".png") else "image/jpeg",
        )
    fill = await agent.launch(
        name,
        symbol,
        description="Launched by a Mercurifi agent key.",
        image=image,
        initial_buy_usdc="2",
    )
    print(f"launched {fill.launched.token if fill.launched else 'nothing'} in {fill.tx_hash}")


asyncio.run(main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None))
