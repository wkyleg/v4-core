#!/usr/bin/env tsx

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

type SummaryJson = {
	scenarioName: string;
	seed: number;
	ticks: number;
	success: boolean;
	failedAssertions?: Array<{ message?: string }>;
	finalMetrics?: Record<string, unknown>;
};

const STABLE_METRIC_KEYS = [
	"uniswap_pool_count",
	"uniswap_tvl_usd",
	"uniswap_volume_24h_usd",
	"uniswap_protocol_fees_usd",
	"uniswap_lp_fees_usd",
] as const;

function getArg(name: string): string | null {
	const index = process.argv.indexOf(`--${name}`);
	if (index < 0) return null;
	return process.argv[index + 1] ?? null;
}

function sha256(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

function normalizeSummary(raw: SummaryJson): Record<string, unknown> {
	const filteredFinalMetrics = Object.fromEntries(
		Object.entries(raw.finalMetrics ?? {}).filter(([key]) =>
			(STABLE_METRIC_KEYS as readonly string[]).includes(key),
		),
	);
	return {
		scenarioName: raw.scenarioName,
		seed: raw.seed,
		ticks: raw.ticks,
		success: raw.success,
		failedAssertions: raw.failedAssertions ?? [],
		finalMetrics: filteredFinalMetrics,
	};
}

function normalizeMetricsCsv(rawCsv: string): string {
	const lines = rawCsv.trim().split("\n");
	if (lines.length < 2) return rawCsv.trim();
	const header = lines[0]?.split(",") ?? [];
	const keepColumns = new Set(["tick", ...STABLE_METRIC_KEYS]);
	const keepIndexes = header
		.map((name, index) => ({ name, index }))
		.filter((entry) => keepColumns.has(entry.name))
		.map((entry) => entry.index);
	if (keepIndexes.length === 0) return rawCsv.trim();
	return lines
		.map((line) => {
			const cells = line.split(",");
			return keepIndexes.map((i) => cells[i] ?? "").join(",");
		})
		.join("\n");
}

async function loadText(path: string): Promise<string> {
	return readFile(path, "utf8");
}

async function main(): Promise<void> {
	const scenario = getArg("scenario");
	const tagA = getArg("tag-a");
	const tagB = getArg("tag-b");
	if (!scenario || !tagA || !tagB) {
		console.error(
			"Usage: tsx scripts/validate-uniswap-consistency.ts --scenario <name> --tag-a <tag> --tag-b <tag>",
		);
		process.exit(1);
	}

	const resultsRoot = join(process.cwd(), "results");
	const baseA = join(resultsRoot, `${scenario}-${tagA}`, `${scenario}-ci`);
	const baseB = join(resultsRoot, `${scenario}-${tagB}`, `${scenario}-ci`);

	const summaryA = JSON.parse(
		await loadText(join(baseA, "summary.json")),
	) as SummaryJson;
	const summaryB = JSON.parse(
		await loadText(join(baseB, "summary.json")),
	) as SummaryJson;
	const metricsA = await loadText(join(baseA, "metrics.csv"));
	const metricsB = await loadText(join(baseB, "metrics.csv"));

	const summaryHashA = sha256(JSON.stringify(normalizeSummary(summaryA)));
	const summaryHashB = sha256(JSON.stringify(normalizeSummary(summaryB)));
	const metricsHashA = sha256(normalizeMetricsCsv(metricsA));
	const metricsHashB = sha256(normalizeMetricsCsv(metricsB));

	const failures: string[] = [];
	if (summaryHashA !== summaryHashB)
		failures.push("normalized summary hash mismatch");
	if (metricsHashA !== metricsHashB) failures.push("metrics.csv hash mismatch");

	if (failures.length > 0) {
		console.error(`Consistency check failed for ${scenario}:`);
		for (const failure of failures) {
			console.error(`  - ${failure}`);
		}
		console.error(`summaryHashA=${summaryHashA}`);
		console.error(`summaryHashB=${summaryHashB}`);
		console.error(`metricsHashA=${metricsHashA}`);
		console.error(`metricsHashB=${metricsHashB}`);
		process.exit(1);
	}

	console.log(`Consistency check passed for ${scenario}.`);
	console.log(`summaryHash=${summaryHashA}`);
	console.log(`metricsHash=${metricsHashA}`);
}

void main();
