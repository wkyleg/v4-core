import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	SimulationEngine,
	createLogger,
	defineScenario,
} from "@elata-biosciences/agentforge";
import {
	DeterministicFlowTraderAgent,
	DeterministicHookPolicyAgent,
	DeterministicLiquidityStewardAgent,
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

const scenario = defineScenario({
	name: "uniswap-v4-flagship-deterministic",
	seed: scenarioSeed(9401),
	ticks: 60,
	tickSeconds: 300,
	pack: createUniswapV4ModelPack(),
	agents: [
		{
			type: DeterministicFlowTraderAgent,
			count: 12,
			params: { buyBias: 0.57 },
		},
		{ type: DeterministicLiquidityStewardAgent, count: 4 },
		{ type: DeterministicHookPolicyAgent, count: 2 },
	],
	query: {
		defaultBudget: {
			maxQueriesPerTick: 10,
			maxCostPerTick: 20,
			maxBytesPerTick: 16_000,
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
		],
		budgets: {
			maxPostsPerTick: 4,
			maxPostCostPerTick: 25,
			maxMessagesReadPerTick: 20,
			maxCharsReadPerTick: 5000,
		},
		defaultLatencyTicks: 1,
		dropRate: 0,
		paraphraseRate: 0,
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
		{ type: "gte", metric: "uniswap_tvl_usd", value: 5_000_000 },
		{ type: "gte", metric: "uniswap_volume_24h_usd", value: 100_000 },
		{ type: "gte", metric: "uniswap_lp_fees_usd", value: 100 },
	],
	studio: {
		report: createNotebookReport({
			title: "Uniswap v4 Flagship (Deterministic)",
			experimentNotes:
				"Policy-driven market participants stress modeled v4 features: hook modes, fee repricing, concentrated liquidity updates, and flow/imbalance feedback loops.",
			hypotheses: [
				"Hook policy changes should suppress MEV pressure during imbalance spikes.",
				"Liquidity stewards should keep TVL healthy while preserving fee generation.",
			],
			successCriteria: [
				"Scenario remains assertion-clean with high sustained volume.",
				"Dashboard traces clearly show hook mode and fee/volatility interactions.",
			],
			metricFields: [
				"uniswap_tvl_usd",
				"uniswap_volume_24h_usd",
				"uniswap_protocol_fees_usd",
				"uniswap_lp_fees_usd",
				"uniswap_realized_volatility",
				"uniswap_mev_pressure",
			],
			primaryMetric: "uniswap_volume_24h_usd",
			mlFeatures: [
				"tick",
				"uniswap_tvl_usd",
				"uniswap_mev_pressure",
				"uniswap_realized_volatility",
			],
			includePersonaQuality: false,
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
				"uniswap-v4-flagship-deterministic",
			),
		),
		ci: scenarioCiMode(true),
		mode: "deterministic",
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
