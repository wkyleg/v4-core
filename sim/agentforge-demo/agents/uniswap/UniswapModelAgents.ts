import {
	type Action,
	BaseAgent,
	type LlmClient,
	type LlmProviderConfig,
	type TickContext,
	createLlmProviderClient,
} from "@elata-biosciences/agentforge";

type HookMode = "passive" | "volatility_reactive" | "anti_mev";
type UniswapWorldView = {
	totalValueLockedUsd?: number;
	totalVolume24hUsd?: number;
	realizedVolatility?: number;
	mevPressureIndex?: number;
};
type PoolView = {
	id: string;
	liquidity: number;
	orderImbalance: number;
	feeBps: number;
};
type NormalizedLlmAction = {
	name: string;
	params: Record<string, unknown>;
	rationale: string;
};

function getPools(ctx: TickContext): PoolView[] {
	const world = ctx.world as {
		pools?: Array<{
			id: string;
			liquidity: number;
			orderImbalance: number;
			feeBps: number;
		}>;
	};
	return world.pools ?? [];
}

export class DeterministicFlowTraderAgent extends BaseAgent {
	override async step(ctx: TickContext): Promise<Action | null> {
		const pools = getPools(ctx);
		if (pools.length === 0) return null;
		const target = ctx.rng.pickOne(pools);
		const bias = this.getParam<number>("buyBias", 0.55);
		const side = ctx.rng.nextFloat() < bias ? "buy_token0" : "sell_token0";
		const notional = 7_500 + Math.floor(ctx.rng.nextFloat() * 45_000);
		return {
			id: this.generateActionId("u4_swap", ctx.tick),
			name: "u4_swap",
			params: {
				poolId: target.id,
				side,
				amountIn: notional,
			},
			metadata: { role: "flow_trader" },
		};
	}
}

export class DeterministicLiquidityStewardAgent extends BaseAgent {
	override async step(ctx: TickContext): Promise<Action | null> {
		const pools = getPools(ctx);
		if (pools.length === 0) return null;
		const [firstPool, ...restPools] = pools;
		if (!firstPool) return null;
		const target = restPools.reduce(
			(best, next) => (next.orderImbalance > best.orderImbalance ? next : best),
			firstPool,
		);
		const deltaSign =
			target.orderImbalance > 0.2 ? 1 : target.orderImbalance < -0.2 ? -1 : 0;
		if (deltaSign === 0) return null;
		const magnitude = 250_000 + Math.floor(ctx.rng.nextFloat() * 1_000_000);
		return {
			id: this.generateActionId("u4_modify_liquidity", ctx.tick),
			name: "u4_modify_liquidity",
			params: {
				poolId: target.id,
				deltaLiquidity: deltaSign * magnitude,
			},
			metadata: { role: "liquidity_steward" },
		};
	}
}

export class DeterministicHookPolicyAgent extends BaseAgent {
	override async step(ctx: TickContext): Promise<Action | null> {
		const pools = getPools(ctx);
		if (pools.length === 0 || ctx.tick % 3 !== 0) return null;
		const target = ctx.rng.pickOne(pools);
		const mode: HookMode =
			Math.abs(target.orderImbalance) > 0.3
				? "anti_mev"
				: target.feeBps < 10
					? "volatility_reactive"
					: "passive";
		return {
			id: this.generateActionId("u4_set_hook_mode", ctx.tick),
			name: "u4_set_hook_mode",
			params: { poolId: target.id, hookMode: mode },
			metadata: { role: "hook_policy" },
		};
	}
}

export class UniswapLlmStrategistAgent extends BaseAgent {
	private llm: LlmClient | null = null;
	private resolvedProvider: LlmProviderConfig["provider"] | null = null;

	override async step(ctx: TickContext): Promise<Action | Action[] | null> {
		const pools = getPools(ctx);
		if (pools.length === 0) return null;
		this.remember("lastTick", ctx.tick);
		const providerMode =
			ctx.mode === "exploration" ||
			this.getParam<boolean>("forceLlmInDeterministic", false) === true;
		if (!providerMode) return this.fallbackAction(ctx, pools);
		const liveRequired = this.getParam<boolean>("liveRequired", false);
		if (ctx.tick % 6 === 0) {
			const pool = ctx.rng.pickOne(pools);
			const text = `llm_summary tick=${ctx.tick} pool=${pool.id} imbalance=${pool.orderImbalance.toFixed(3)}`;
			this.remember("lastDecision", {
				tick: ctx.tick,
				actionName: "PostMessage",
				provider: this.resolvedProvider ?? "openai",
				rationale: "scheduled_strategy_summary",
			});
			return {
				id: this.generateActionId("PostMessage", ctx.tick),
				name: "PostMessage",
				params: {
					channelId: "strategy",
					text,
				},
				metadata: {
					role: "llm_strategist",
					provider: this.resolvedProvider ?? "openai",
					rationale: "scheduled_strategy_summary",
				},
			};
		}

		try {
			const client = this.getClient();

			const messages = ctx.gossip?.readInbox(this.id) ?? [];
			const recentMessages = messages.slice(-6).map(
				(m) => `[${m.envelope.channelId}] ${m.envelope.authorAgentId}: ${m.payload.text}`,
			);
			const lastDecision = this.recall<Record<string, unknown>>("lastDecision");
			const lastLlmRaw = this.recall<string>("lastLlmRaw");

			const completion = await client.complete({
				model: this.getParam<string>(
					"model",
					process.env.OPENAI_MODEL ?? "gpt-4o-mini",
				),
				system:
					'You are a Uniswap v4 strategist. You may return a single action or multiple actions: {"actions":[...]} (max 3). '
					+ 'Available actions: u4_swap, u4_modify_liquidity, u4_set_hook_mode, PostMessage, QueryWorld. '
					+ 'Output strict JSON: {"name":"...","params":{...},"rationale":"..."} or {"actions":[{...},{...}]}',
				user: JSON.stringify({
					tick: ctx.tick,
					pools,
					world: {
						tvl: (ctx.world as UniswapWorldView).totalValueLockedUsd,
						volume: (ctx.world as UniswapWorldView).totalVolume24hUsd,
						volatility: (ctx.world as UniswapWorldView).realizedVolatility,
						mev: (ctx.world as UniswapWorldView).mevPressureIndex,
					},
					lastResult: ctx.lastResult ?? null,
					lastDecision: lastDecision ?? null,
					lastLlmSummary: lastLlmRaw?.slice(0, 200) ?? null,
					gossip: recentMessages.length > 0 ? recentMessages : null,
					actionTemplates: ctx.capabilities?.actionTemplates ?? null,
				}),
			});
			const raw = this.parseJson(completion);
			if (!raw) {
				if (liveRequired) throw new Error("llm_response_parse_failed");
				return this.fallbackAction(ctx, pools);
			}

			const items: Record<string, unknown>[] = Array.isArray(raw.actions) ? (raw.actions as Record<string, unknown>[]) : [raw];
			const actions: Action[] = [];

			for (const item of items.slice(0, 3)) {
				if (typeof item.name !== "string" || typeof item.params !== "object") continue;
				const normalized = this.normalizeLlmAction(
					item.name,
					item.params as Record<string, unknown>,
					typeof item.rationale === "string" ? item.rationale : "none",
					ctx,
					pools,
				);
				actions.push({
					id: this.generateActionId(normalized.name, ctx.tick),
					name: normalized.name,
					params: normalized.params,
					metadata: {
						role: "llm_strategist",
						provider: this.resolvedProvider ?? "none",
						rationale: normalized.rationale.slice(0, 240),
					},
				});
			}

			if (actions.length === 0) {
				if (liveRequired) throw new Error("llm_response_parse_failed");
				return this.fallbackAction(ctx, pools);
			}

			this.remember("lastLlmRaw", completion.slice(0, 300));
			this.remember("lastDecision", {
				tick: ctx.tick,
				actionName: actions[0]!.name,
				provider: this.resolvedProvider ?? "none",
				rationale: (actions[0]!.metadata as Record<string, unknown>)?.rationale ?? "none",
			});
			return actions.length === 1 ? actions[0]! : actions;
		} catch (error) {
			if (liveRequired) {
				throw error;
			}
			this.remember(
				"lastLlmError",
				error instanceof Error ? error.message : "unknown",
			);
			return this.fallbackAction(ctx, pools);
		}
	}

	private fallbackAction(ctx: TickContext, pools: PoolView[]): Action {
		const target = ctx.rng.pickOne(pools);
		if (ctx.tick % 4 === 0) {
			this.remember("lastDecision", {
				tick: ctx.tick,
				actionName: "PostMessage",
				provider: this.resolvedProvider ?? "fallback",
				rationale: "fallback_gossip",
				poolId: target.id,
			});
			return {
				id: this.generateActionId("PostMessage", ctx.tick),
				name: "PostMessage",
				params: {
					channelId: "strategy",
					text: `llm_fallback tick=${ctx.tick} pool=${target.id} imbalance=${target.orderImbalance.toFixed(3)}`,
				},
				metadata: {
					role: "llm_fallback",
					provider: this.resolvedProvider ?? "fallback",
				},
			};
		}
		this.remember("lastDecision", {
			tick: ctx.tick,
			actionName: "u4_swap",
			provider: this.resolvedProvider ?? "fallback",
			rationale: "fallback_swap",
			poolId: target.id,
		});
		return {
			id: this.generateActionId("u4_swap", ctx.tick),
			name: "u4_swap",
			params: {
				poolId: target.id,
				side: target.orderImbalance > 0 ? "sell_token0" : "buy_token0",
				amountIn: 20_000 + Math.floor(ctx.rng.nextFloat() * 35_000),
			},
			metadata: {
				role: "llm_fallback",
				provider: this.resolvedProvider ?? "fallback",
			},
		};
	}

	private getClient(): LlmClient {
		if (this.llm) return this.llm;
		const requested = this.getParam<LlmProviderConfig["provider"]>(
			"provider",
			"openai",
		);
		const hasOpenAi = Boolean(process.env.OPENAI_API_KEY);
		const hasOpenRouter = Boolean(process.env.OPENROUTER_API_KEY);
		const resolved =
			requested === "openai"
				? hasOpenAi
					? "openai"
					: hasOpenRouter
						? "openrouter"
						: null
				: requested === "openrouter"
					? hasOpenRouter
						? "openrouter"
						: hasOpenAi
							? "openai"
							: null
					: requested;
		if (!resolved) {
			throw new Error("no_llm_provider_key_configured");
		}
		this.resolvedProvider = resolved;
		this.llm = createLlmProviderClient({
			provider: resolved,
			model: this.getParam<string>(
				"model",
				process.env.OPENAI_MODEL ?? "gpt-4o-mini",
			),
		});
		return this.llm;
	}

	private normalizeLlmAction(
		name: string,
		params: Record<string, unknown>,
		rationale: string,
		ctx: TickContext,
		pools: PoolView[],
	): NormalizedLlmAction {
		const fallbackPool = ctx.rng.pickOne(pools);
		if (name === "u4_swap") {
			const poolId =
				typeof params.poolId === "string" ? params.poolId : fallbackPool.id;
			const side =
				params.side === "buy_token0" || params.side === "sell_token0"
					? params.side
					: fallbackPool.orderImbalance > 0
						? "sell_token0"
						: "buy_token0";
			const amountRaw =
				typeof params.amountIn === "number"
					? params.amountIn
					: Number(params.amountIn ?? 25_000);
			const amountIn = Math.max(
				5_000,
				Math.min(150_000, Math.floor(amountRaw)),
			);
			return { name, params: { poolId, side, amountIn }, rationale };
		}
		if (name === "u4_modify_liquidity") {
			if (ctx.tick % 5 === 1) {
				return {
					name: "PostMessage",
					params: {
						channelId: "strategy",
						text: `llm_liquidity_view tick=${ctx.tick} ${rationale.slice(0, 120)}`,
					},
					rationale,
				};
			}
			const poolId =
				typeof params.poolId === "string"
					? params.poolId
					: Array.isArray(params.pools)
						? String(
								(params.pools[0] as { id?: unknown } | undefined)?.id ?? "",
							)
						: fallbackPool.id;
			const deltaRaw =
				typeof params.deltaLiquidity === "number"
					? params.deltaLiquidity
					: Math.floor((ctx.rng.nextFloat() - 0.5) * 900_000);
			const deltaLiquidity = Math.max(
				-1_250_000,
				Math.min(1_250_000, Math.floor(deltaRaw)),
			);
			return { name, params: { poolId: poolId || fallbackPool.id, deltaLiquidity }, rationale };
		}
		if (name === "u4_set_hook_mode") {
			const poolId =
				typeof params.poolId === "string" ? params.poolId : fallbackPool.id;
			const hookMode =
				params.hookMode === "passive" ||
				params.hookMode === "volatility_reactive" ||
				params.hookMode === "anti_mev"
					? params.hookMode
					: "volatility_reactive";
			return { name, params: { poolId, hookMode }, rationale };
		}
		if (name === "PostMessage") {
			const text =
				typeof params.text === "string"
					? params.text
					: `llm_strategy tick=${ctx.tick} pool=${fallbackPool.id} imbalance=${fallbackPool.orderImbalance.toFixed(3)}`;
			return {
				name,
				params: {
					channelId:
						typeof params.channelId === "string" ? params.channelId : "strategy",
					text,
				},
				rationale,
			};
		}
		return {
			name: "PostMessage",
			params: {
				channelId: "strategy",
				text: `llm_strategy tick=${ctx.tick} pool=${fallbackPool.id} action=${name}`,
			},
			rationale: `Unsupported action "${name}" coerced to gossip post.`,
		};
	}

	private parseJson(raw: string): Record<string, unknown> | null {
		const trimmed = raw.trim();
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		if (start < 0 || end <= start) return null;
		try {
			return JSON.parse(trimmed.slice(start, end + 1)) as Record<
				string,
				unknown
			>;
		} catch {
			return null;
		}
	}
}
