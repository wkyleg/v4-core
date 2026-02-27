# Uniswap In-Repo AgentForge Migration Notes

## Summary

This change moves flagship AgentForge Uniswap simulation demos into the Uniswap repo lane at `sim/agentforge-demo`, instead of keeping them in `elata-protocol`.

## Delivered

- Deterministic flagship scenario:
  - `scenarios/uniswap/v4-flagship-deterministic.ts`
- Non-deterministic LLM flagship scenario:
  - `scenarios/uniswap/v4-flagship-llm-exploration.ts`
- Modeled protocol pack:
  - `packs/UniswapV4ModelPack.ts`
- Specialized agent set:
  - `agents/uniswap/UniswapModelAgents.ts`
- Dashboard/studio report helper:
  - `lib/studio-report.ts`
- Deterministic consistency validator:
  - `scripts/validate-uniswap-consistency.ts`

## Verification Evidence

Executed successfully in `sim/agentforge-demo`:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:coverage`
- `pnpm run uniswap:v4:smoke`
- `pnpm run uniswap:v4:stability`
- `pnpm run stress:uniswap:v4`

Notable output:

- Stability check passed for deterministic flagship with matching normalized summary/metrics hashes.

## LLM Demo Plumbing Hardening

The LLM exploration lane is now explicit and easier to audit:

- Live-provider commands fail fast without keys:
  - `pnpm run uniswap:v4:llm`
  - `pnpm run uniswap:v4:llm:short`
- Deterministic fallback remains available for control runs:
  - `pnpm run uniswap:v4:llm:deterministic`
- Report metadata now surfaces mode/provider/short-run flags to avoid ambiguity in Studio.
- LLM strategist telemetry includes inspectable rationale/provider/intent metadata.
- Strategist memory snapshots are persisted (`agent_memory.ndjson`) and visible in Studio.
- Gossip posts and deliveries are verifiable in both files (`gossip.ndjson`) and UI tabs.

## Artifact Checks (Latest Live Short Run)

Validated run root:

- `results/uniswap-v4-flagship-llm-exploration-live_short6/uniswap-v4-flagship-llm-exploration-ci`

Validated artifacts:

- `summary.json`: run `success: true`, assertions passing
- `actions.ndjson`: `PostMessage` events present for strategist agents
- `gossip.ndjson`: `gossip_post` and `gossip_deliver` entries present
- `agent_memory.ndjson`: non-empty strategist memory (`lastDecision`, `lastLlmRaw`)
