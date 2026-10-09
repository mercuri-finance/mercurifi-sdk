"""Generated ABIs (scripts/gen-abis.mjs) wrapped as Contract objects. Never edit the JSON by hand."""
from ..codec import Contract, ErrorDecoder, load_abi

AGENT_ACCOUNT = Contract(load_abi("agentAccount"), "AgentAccount")
AGENT_POLICY_REGISTRY = Contract(load_abi("agentPolicyRegistry"), "AgentPolicyRegistry")
AGENT_ACCOUNT_FACTORY = Contract(load_abi("agentAccountFactory"), "AgentAccountFactory")
BONDING_CURVE = Contract(load_abi("bondingCurve"), "BondingCurve")
LAUNCH_FACTORY = Contract(load_abi("launchFactory"), "LaunchFactory")
FEE_MANAGER = Contract(load_abi("feeManager"), "FeeManager")
GRADUATION_MANAGER = Contract(load_abi("graduationManager"), "GraduationManager")
LAUNCH_HOOK = Contract(load_abi("launchHook"), "LaunchHook")
LAUNCH_TOKEN = Contract(load_abi("launchToken"), "LaunchToken")
V4_QUOTER = Contract(load_abi("v4Quoter"), "V4Quoter")
UNIVERSAL_ROUTER = Contract(load_abi("universalRouter"), "UniversalRouter")
# The TypeScript SOURCES order. Reverts are decoded in this order: the three agent ABIs first, merged, because
# one agent call can revert with an account error (TradeTooLarge) or a registry error (PeriodSpendExceeded).
ALL = (
    AGENT_ACCOUNT, AGENT_POLICY_REGISTRY, AGENT_ACCOUNT_FACTORY, BONDING_CURVE, LAUNCH_FACTORY, FEE_MANAGER, GRADUATION_MANAGER,
    LAUNCH_HOOK, LAUNCH_TOKEN, V4_QUOTER, UNIVERSAL_ROUTER,
)

# Revert decoding follows TypeScript revert.ts: the three agent ABIs first (merged), then Launch, then UniversalRouter
# before V4Quoter. ALL keeps the generator order instead; do not use it for reverts.
REVERT_ORDER = (
    AGENT_ACCOUNT, AGENT_POLICY_REGISTRY, AGENT_ACCOUNT_FACTORY, BONDING_CURVE, LAUNCH_FACTORY, FEE_MANAGER, GRADUATION_MANAGER,
    LAUNCH_HOOK, LAUNCH_TOKEN, UNIVERSAL_ROUTER, V4_QUOTER,
)
REVERT_DECODER = ErrorDecoder(REVERT_ORDER)  # raises at import if one selector means two signatures
