from pathlib import Path

PKG = Path(__file__).resolve().parents[1]
LOSS_BOUND = (
    "A stolen agent key can still lose money through bad trades: buying an attacker's token, or selling the account's holdings into a "
    "price the attacker pushed down. **That loss is bounded by the account's caps, not prevented.** Per period, the bound is the USDC "
    "spend cap plus the sell cap, which is measured at the account's own cost basis. It keeps accruing every period until the key is "
    "revoked or expires."
)


def test_readme_carries_the_loss_bound() -> None:
    assert LOSS_BOUND in (PKG / "README.md").read_text()


def test_readme_matches_the_contracts_as_built() -> None:
    readme = (PKG / "README.md").read_text()
    assert "AgentPolicyRegistry" in readme
    assert "high-water average cost" in readme
    for row in ("registry `setPolicy`", "factory `createAccount`", "registry `acceptOwnership`"):
        assert row in readme


def test_readme_keeps_the_handling_notes_and_the_testnet_notice() -> None:
    readme = (PKG / "README.md").read_text()
    for heading in (
        "## Handling agent keys",
        "## Untrusted text for models",
        "## Untrusted text and Unicode data",
    ):
        assert heading in readme
    assert (
        "Agent Accounts are deployed on Arc testnet" in readme
        and "NotDeployedError" in readme
        and "stay empty until an owner-approved deployment" in readme
    )
    assert (
        "never in a markdown code fence" in readme
        or "Never put it in a markdown code fence" in readme
    )


def test_examples_link_security_model_and_compile() -> None:
    for name in ("quickstart_testnet", "market_maker", "launch_bot", "llm_tools"):
        text = (PKG / "examples" / f"{name}.py").read_text()
        assert "docs/security-model.md" in text
        compile(text, name, "exec")
    code = [
        line
        for line in (PKG / "examples" / "quickstart_testnet.py").read_text().splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    assert len(code) <= 16


def test_readme_quickstart_is_the_example() -> None:
    readme = (PKG / "README.md").read_text()
    example = (PKG / "examples" / "quickstart_testnet.py").read_text()
    body = example[example.index("import asyncio") :].strip()
    assert body in readme


def test_no_stale_not_deployed_claims() -> None:
    import re

    root = PKG.parents[1]
    files = [
        root / "README.md",
        *(root / "docs").glob("*.md"),
        *PKG.glob("README.md"),
        *(PKG.parent / "typescript").glob("README.md"),
        *(PKG / "examples").glob("*.py"),
        *(PKG.parent / "typescript" / "examples").glob("*.ts"),
    ]
    assert len(files) >= 12
    for f in files:
        assert not re.search(
            r"No Agent Accounts deployment exists|deployment is recorded\)|runs once a testnet deployment|until one is recorded|## No deployment yet",
            f.read_text(),
        ), f


def test_readme_says_who_signs_for_erc8004_and_circle() -> None:
    readme = (PKG / "README.md").read_text()
    for heading in ("## ERC-8004 identity (optional)", "## Circle Wallets"):
        assert heading in readme
    assert (
        "`isValidSignature` always fails" in readme
        and "no exportable" in readme
        and "provides no Circle adapter" in readme
    )
    assert "from mercurifi.identity import" in readme
