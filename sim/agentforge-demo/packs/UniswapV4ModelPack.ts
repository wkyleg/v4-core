import type {
	Action,
	ActionResult,
	CapabilityManifest,
	Pack,
	WorldState,
} from "@elata-biosciences/agentforge";

type HookMode = "passive" | "volatility_reactive" | "anti_mev";

type PoolState = {
	id: string;
	token0: string;
	token1: string;
	price: number;
	liquidity: number;
	feeBps: number;
	hookMode: HookMode;
	volume24h: number;
	lpFeesAccrued: number;
	protocolFeesAccrued: number;
	orderImbalance: number;
	priceHistory: number[];
};

export type UniswapV4WorldState = WorldState & {
	poolCount: number;
	pools: Array<{
		id: string;
		token0: string;
		token1: string;
		price: number;
		liquidity: number;
		feeBps: number;
		hookMode: HookMode;
		volume24h: number;
		orderImbalance: number;
	}>;
	totalValueLockedUsd: number;
	totalVolume24hUsd: number;
	protocolFeesUsd: number;
	lpFeesUsd: number;
	realizedVolatility: number;
	mevPressureIndex: number;
};

export interface UniswapV4ModelPackConfig {
	initialPools?: PoolState[];
}

const DEFAULT_POOLS: PoolState[] = [
	{
		id: "eth_usdc_5bps",
		token0: "WETH",
		token1: "USDC",
		price: 3200,
		liquidity: 18_000_000,
		feeBps: 5,
		hookMode: "volatility_reactive",
		volume24h: 0,
		lpFeesAccrued: 0,
		protocolFeesAccrued: 0,
		orderImbalance: 0,
		priceHistory: [3200],
	},
	{
		id: "wbtc_usdc_30bps",
		token0: "WBTC",
		token1: "USDC",
		price: 58_000,
		liquidity: 9_000_000,
		feeBps: 30,
		hookMode: "anti_mev",
		volume24h: 0,
		lpFeesAccrued: 0,
		protocolFeesAccrued: 0,
		orderImbalance: 0,
		priceHistory: [58_000],
	},
];

export class UniswapV4ModelPack implements Pack {
	readonly name = "uniswap-v4-model";

	private pools = new Map<string, PoolState>();
	private tick = 0;
	private timestamp = 0;
	private lastVolatility = 0;

	constructor(private readonly config: UniswapV4ModelPackConfig = {}) {}

	async initialize(): Promise<void> {
		this.pools.clear();
		for (const pool of this.config.initialPools ?? DEFAULT_POOLS) {
			this.pools.set(pool.id, {
				...pool,
				priceHistory: [...pool.priceHistory],
			});
		}
	}

	onTick(tick: number, timestamp: number): void {
		this.tick = tick;
		this.timestamp = timestamp;
		for (const pool of this.pools.values()) {
			pool.volume24h *= 0.985;
			pool.orderImbalance *= 0.6;
			const drift = 1 + Math.sin(tick / 5 + pool.price / 10_000) * 0.0015;
			pool.price = Math.max(0.0001, pool.price * drift);
			pool.priceHistory.push(pool.price);
			if (pool.priceHistory.length > 40) pool.priceHistory.shift();
		}
		this.lastVolatility = this.computeRealizedVolatility();
	}

	getWorldState(): UniswapV4WorldState {
		const pools = [...this.pools.values()];
		const totalVolume24hUsd = pools.reduce((sum, p) => sum + p.volume24h, 0);
		const totalValueLockedUsd = pools.reduce(
			(sum, p) => sum + p.liquidity * 2,
			0,
		);
		const protocolFeesUsd = pools.reduce(
			(sum, p) => sum + p.protocolFeesAccrued,
			0,
		);
		const lpFeesUsd = pools.reduce((sum, p) => sum + p.lpFeesAccrued, 0);
		const mevPressureIndex =
			pools.reduce((sum, p) => sum + Math.abs(p.orderImbalance), 0) /
			pools.length;
		return {
			tick: this.tick,
			timestamp: this.timestamp,
			poolCount: pools.length,
			pools: pools.map((p) => ({
				id: p.id,
				token0: p.token0,
				token1: p.token1,
				price: p.price,
				liquidity: p.liquidity,
				feeBps: p.feeBps,
				hookMode: p.hookMode,
				volume24h: p.volume24h,
				orderImbalance: p.orderImbalance,
			})),
			totalValueLockedUsd,
			totalVolume24hUsd,
			protocolFeesUsd,
			lpFeesUsd,
			realizedVolatility: this.lastVolatility,
			mevPressureIndex,
		};
	}

	async executeAction(action: Action): Promise<ActionResult> {
		if (action.name === "u4_swap") {
			const poolId = String(action.params.poolId);
			const pool = this.pools.get(poolId);
			if (!pool) return { ok: false, error: `unknown_pool:${poolId}` };
			const amountIn = Number(action.params.amountIn ?? 0);
			const side = String(action.params.side ?? "buy_token0");
			const direction = side === "buy_token0" ? 1 : -1;
			const dynamicFeeBps = this.resolveFeeBps(pool, amountIn);
			const feeUsd = amountIn * (dynamicFeeBps / 10_000);
			const impact = Math.min(
				0.08,
				(amountIn / Math.max(1, pool.liquidity)) * 2.1,
			);
			pool.price = Math.max(
				0.0001,
				pool.price *
					(1 + direction * impact * (1 + pool.orderImbalance * 0.15)),
			);
			pool.volume24h += amountIn;
			pool.orderImbalance = Math.max(
				-1,
				Math.min(1, pool.orderImbalance + direction * (amountIn / 2_000_000)),
			);
			pool.lpFeesAccrued += feeUsd * 0.85;
			pool.protocolFeesAccrued += feeUsd * 0.15;
			return { ok: true, gasUsed: BigInt(130_000) };
		}

		if (action.name === "u4_modify_liquidity") {
			const poolId = String(action.params.poolId);
			const pool = this.pools.get(poolId);
			if (!pool) return { ok: false, error: `unknown_pool:${poolId}` };
			const delta = Number(action.params.deltaLiquidity ?? 0);
			pool.liquidity = Math.max(100_000, pool.liquidity + delta);
			return { ok: true, gasUsed: BigInt(150_000) };
		}

		if (action.name === "u4_set_hook_mode") {
			const poolId = String(action.params.poolId);
			const pool = this.pools.get(poolId);
			if (!pool) return { ok: false, error: `unknown_pool:${poolId}` };
			const mode = String(action.params.hookMode) as HookMode;
			if (!["passive", "volatility_reactive", "anti_mev"].includes(mode)) {
				return { ok: false, error: `invalid_hook_mode:${mode}` };
			}
			pool.hookMode = mode;
			return { ok: true, gasUsed: BigInt(90_000) };
		}

		if (action.name === "u4_reprice_fee") {
			const poolId = String(action.params.poolId);
			const pool = this.pools.get(poolId);
			if (!pool) return { ok: false, error: `unknown_pool:${poolId}` };
			const feeBps = Number(action.params.feeBps ?? pool.feeBps);
			pool.feeBps = Math.max(1, Math.min(100, Math.round(feeBps)));
			return { ok: true, gasUsed: BigInt(75_000) };
		}

		return { ok: true };
	}

	getCapabilityManifest(): CapabilityManifest {
		return {
			version: "v1",
			generatedAtTick: this.tick,
			mode: "deterministic",
			tools: [
				"u4_swap",
				"u4_modify_liquidity",
				"u4_set_hook_mode",
				"u4_reprice_fee",
				"QueryWorld",
				"PostMessage",
			],
			queryEndpoints: [
				{ name: "get_world", cost: 1 },
				{ name: "get_pool", cost: 1 },
			],
			contracts: [{ alias: "PoolManager" }, { alias: "Hooks" }],
			actionTemplates: [
				{
					name: "u4_swap",
					description: "Modeled v4 swap",
					exampleParams: {
						poolId: "eth_usdc_5bps",
						amountIn: 25_000,
						side: "buy_token0",
					},
				},
				{
					name: "u4_modify_liquidity",
					description: "Modeled concentrated liquidity updates",
					exampleParams: { poolId: "eth_usdc_5bps", deltaLiquidity: 750_000 },
				},
				{
					name: "u4_set_hook_mode",
					description: "Switch hook behavior profile",
					exampleParams: { poolId: "eth_usdc_5bps", hookMode: "anti_mev" },
				},
			],
		};
	}

	getMetrics(): Record<string, number | bigint | string> {
		const world = this.getWorldState();
		return {
			uniswap_pool_count: world.poolCount,
			uniswap_tvl_usd: Math.round(world.totalValueLockedUsd),
			uniswap_volume_24h_usd: Math.round(world.totalVolume24hUsd),
			uniswap_protocol_fees_usd: Math.round(world.protocolFeesUsd),
			uniswap_lp_fees_usd: Math.round(world.lpFeesUsd),
			uniswap_realized_volatility: Number(world.realizedVolatility.toFixed(6)),
			uniswap_mev_pressure: Number(world.mevPressureIndex.toFixed(6)),
		};
	}

	async cleanup(): Promise<void> {
		this.pools.clear();
	}

	private resolveFeeBps(pool: PoolState, amountIn: number): number {
		if (pool.hookMode === "passive") return pool.feeBps;
		if (pool.hookMode === "volatility_reactive") {
			const volBps = this.lastVolatility * 10_000;
			return Math.max(1, Math.min(120, Math.round(pool.feeBps + volBps * 0.2)));
		}
		const mevSurcharge =
			Math.abs(pool.orderImbalance) * 22 +
			(amountIn / Math.max(1, pool.liquidity)) * 8_000;
		return Math.max(2, Math.min(140, Math.round(pool.feeBps + mevSurcharge)));
	}

	private computeRealizedVolatility(): number {
		const returns: number[] = [];
		for (const pool of this.pools.values()) {
			for (let i = 1; i < pool.priceHistory.length; i += 1) {
				const prev = pool.priceHistory[i - 1] ?? pool.priceHistory[i];
				const curr = pool.priceHistory[i] ?? prev;
				if (!prev || !curr) continue;
				returns.push((curr - prev) / prev);
			}
		}
		if (returns.length === 0) return 0;
		const mean =
			returns.reduce((sum, value) => sum + value, 0) / returns.length;
		const variance =
			returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
			returns.length;
		return Math.sqrt(variance);
	}
}

export function createUniswapV4ModelPack(
	config: UniswapV4ModelPackConfig = {},
): UniswapV4ModelPack {
	return new UniswapV4ModelPack(config);
}
