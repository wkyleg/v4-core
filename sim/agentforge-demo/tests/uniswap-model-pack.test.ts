import { describe, expect, it } from "vitest";
import { createUniswapV4ModelPack } from "../packs/UniswapV4ModelPack.js";

describe("UniswapV4ModelPack", () => {
	it("initializes pools and emits base metrics", async () => {
		const pack = createUniswapV4ModelPack();
		await pack.initialize();
		pack.onTick(1, 1700000000);
		const world = pack.getWorldState();
		const metrics = pack.getMetrics();

		expect(world.poolCount).toBeGreaterThanOrEqual(2);
		expect(metrics.uniswap_pool_count).toBe(world.poolCount);
		expect(Number(metrics.uniswap_tvl_usd)).toBeGreaterThan(0);
	});
});
