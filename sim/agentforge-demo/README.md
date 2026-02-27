# AgentForge Demo Lane (Uniswap v4 In-Repo)

This package runs AgentForge simulations from within the Uniswap repo for generalizable demo workflows.

## Scenarios

- Deterministic: `scenarios/uniswap/v4-flagship-deterministic.ts`
- LLM exploration: `scenarios/uniswap/v4-flagship-llm-exploration.ts`

## Commands

```bash
pnpm install
pnpm run uniswap:v4:smoke
pnpm run uniswap:v4:stability
pnpm run uniswap:v4:llm:short
pnpm run studio:8791
```

Open `http://127.0.0.1:8791/` to inspect completed runs under `./results`.

## Environment

- `OPENAI_API_KEY` or `OPENROUTER_API_KEY` for live LLM exploration mode.
- Live LLM scripts (`uniswap:v4:llm`, `uniswap:v4:llm:short`) hard-fail when no provider key is present.
- `SIMULATION_MODE=deterministic` to run the LLM scenario in deterministic fallback mode.
- `SIM_RUN_TAG` to isolate output directories per run.
