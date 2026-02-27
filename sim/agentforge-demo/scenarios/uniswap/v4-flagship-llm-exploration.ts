import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	SimulationEngine,
	createLogger,
	defineScenario,
} from "@elata-biosciences/agentforge";
import {
	DeterministicFlowTraderAgent,
	DeterministicLiquidityStewardAgent,
	UniswapLlmStrategistAgent,
} from "../../agents/index.js";
import {
	createNotebookReport,
	scenarioCiMode,
	scenarioOutDir,
	scenarioSeed,
} from "../../lib/index.js";
import { createUniswapV4ModelPack } from "../../packs/UniswapV4ModelPack.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
type QueryWorld = { pools?: Array<{ id: string }> };

function intEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

const runMode =
	process.env.SIMULATION_MODE === "deterministic"
		? "deterministic"
		: "exploration";
const isShortRun = process.env.SIM_SHORT_RUN === "1";
const runTicks = intEnv("SIM_SHORT_TICKS", isShortRun ? 18 : 70);
const runTickSeconds = intEnv("SIM_SHORT_TICK_SECONDS", isShortRun ? 120 : 240);
const requestedProvider =
	(process.env.LLM_GOSSIP_PROVIDER as "openai" | "openrouter" | undefined) ??
	"openai";

const scenario = defineScenario({
	name: "uniswap-v4-flagship-llm-exploration",
	seed: scenarioSeed(9402),
	ticks: runTicks,
	tickSeconds: runTickSeconds,
	pack: createUniswapV4ModelPack(),
	agents: [
		{
			type: DeterministicFlowTraderAgent,
			count: 10,
			params: { buyBias: 0.51 },
		},
		{ type: DeterministicLiquidityStewardAgent, count: 4 },
		{
			type: UniswapLlmStrategistAgent,
			count: 3,
			params: {
				provider: requestedProvider,
				model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
				liveRequired: process.env.LLM_LIVE_REQUIRED === "1",
			},
		},
	],
	exploration: {
		allowArbitraryExecution: true,
		autonomousRpcPolicy: "aggressive",
		allowlist: {
			allowedContracts: ["PoolManager"],
			allowedRpcMethods: ["eth_blockNumber", "eth_chainId"],
		},
	},
	query: {
		defaultBudget: {
			maxQueriesPerTick: 18,
			maxCostPerTick: 40,
			maxBytesPerTick: 32_000,
		},
		endpoints: [
			{ name: "get_world", cost: 1, handler: (_params, world) => world },
			{
				name: "get_pool",
				cost: 1,
				handler: (params, world: unknown) => {
					const poolId = String(params?.poolId ?? "");
					const typedWorld = world as QueryWorld;
					return (
						(typedWorld.pools ?? []).find((pool) => pool.id === poolId) ?? null
					);
				},
			},
		],
	},
	gossip: {
		channels: [
			{ id: "global", type: "global" },
			{ id: "risk", type: "topic" },
			{ id: "alpha", type: "topic" },
		],
		budgets: {
			maxPostsPerTick: 8,
			maxPostCostPerTick: 40,
			maxMessagesReadPerTick: 36,
			maxCharsReadPerTick: 12_000,
		},
		defaultLatencyTicks: 1,
		dropRate: 0.02,
		paraphraseRate: 0.05,
	},
	metrics: {
		sampleEveryTicks: 1,
		track: [
			"uniswap_pool_count",
			"uniswap_tvl_usd",
			"uniswap_volume_24h_usd",
			"uniswap_protocol_fees_usd",
			"uniswap_lp_fees_usd",
			"uniswap_realized_volatility",
			"uniswap_mev_pressure",
		],
	},
	assertions: [
		{ type: "gte", metric: "uniswap_pool_count", value: 2 },
		{ type: "gte", metric: "uniswap_tvl_usd", value: 4_000_000 },
		{ type: "gte", metric: "uniswap_volume_24h_usd", value: 150_000 },
		{ type: "gte", metric: "uniswap_protocol_fees_usd", value: 100 },
	],
	studio: {
		report: createNotebookReport({
			title: "Uniswap v4 Flagship (LLM Exploration)",
			experimentNotes:
				"LLM strategists coordinate hook and liquidity behavior through high-budget query + gossip channels while deterministic orderflow agents keep realistic pressure.",
			hypotheses: [
				"LLM strategists should adapt hook/fairness posture as volatility and imbalance move.",
				"Exploration run should produce rich replay/evidence artifacts for deterministic regression extraction.",
			],
			successCriteria: [
				"Assertions hold while volume and protocol fees remain strong.",
				"Replay bundle and gossip evidence demonstrate non-deterministic strategic adaptation.",
			],
			metricFields: [
				"uniswap_tvl_usd",
				"uniswap_volume_24h_usd",
				"uniswap_protocol_fees_usd",
				"uniswap_lp_fees_usd",
				"uniswap_realized_volatility",
				"uniswap_mev_pressure",
			],
			primaryMetric: "uniswap_protocol_fees_usd",
			mlFeatures: [
				"tick",
				"uniswap_volume_24h_usd",
				"uniswap_mev_pressure",
				"uniswap_realized_volatility",
			],
			runMode,
			llmProvider: requestedProvider,
			liveLlmRequired: process.env.LLM_LIVE_REQUIRED === "1",
			shortRun: isShortRun,
			includePersonaQuality: true,
		}),
	},
});

async function main(): Promise<void> {
	const engine = new SimulationEngine({
		logger: createLogger({ level: "warn", pretty: false }),
	});
	const result = await engine.run(scenario, {
		outDir: scenarioOutDir(
			join(
				__dirname,
				"..",
				"..",
				"results",
				"uniswap-v4-flagship-llm-exploration",
			),
		),
		ci: scenarioCiMode(true),
		mode: runMode,
		memoryCapture: {
			enabled: true,
			sampleEveryTicks: 1,
			maxBytesPerRecord: 262_144,
		},
	});
	process.exit(result.failedAssertions.length > 0 ? 1 : 0);
}

const isDirectExecution =
	process.argv[1] !== undefined &&
	fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectExecution) {
	void main();
}

export { scenario };
