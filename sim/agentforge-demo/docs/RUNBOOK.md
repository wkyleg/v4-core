# AgentForge Uniswap Demo Runbook

## Purpose

Run deterministic and LLM-powered Uniswap v4 demo scenarios from inside the Uniswap repo fork.

## Setup

```bash
cd sim/agentforge-demo
pnpm install
```

## Core Runs

```bash
pnpm run uniswap:v4:deterministic
pnpm run uniswap:v4:llm
pnpm run uniswap:v4:llm:short
pnpm run uniswap:v4:llm:deterministic
```

`uniswap:v4:llm` and `uniswap:v4:llm:short` require a live provider key (`OPENAI_API_KEY` or `OPENROUTER_API_KEY`) and will fail fast if missing.

## Verification Gates

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm run uniswap:v4:smoke
pnpm run uniswap:v4:stability
pnpm run stress:uniswap:v4
```

## Dashboard/Studio

```bash
pnpm run studio:8791
```

Then open `http://127.0.0.1:8791/`.

Run artifacts are written under `sim/agentforge-demo/results`.

## Troubleshooting quick checks

- If the run badge says `deterministic`, fallback behavior is expected and live LLM calls are disabled.
- Verify live run gossip in `results/.../gossip.ndjson`.
- Verify strategist memory snapshots in `results/.../agent_memory.ndjson`.
