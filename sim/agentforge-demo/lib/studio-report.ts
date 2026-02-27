type NotebookReportOptions = {
	title: string;
	experimentNotes: string;
	hypotheses: string[];
	successCriteria: string[];
	resultsCommentary?: string;
	howToRead?: string;
	metricFields: string[];
	primaryMetric: string;
	mlFeatures?: string[];
	includePersonaQuality?: boolean;
	runMode?: "deterministic" | "exploration";
	llmProvider?: string;
	liveLlmRequired?: boolean;
	shortRun?: boolean;
};

function markdownList(items: string[]): string {
	if (items.length === 0) return "- None provided";
	return items.map((item) => `- ${item}`).join("\n");
}

export function createNotebookReport(options: NotebookReportOptions): {
	v: "v1";
	blocks: Array<Record<string, unknown>>;
} {
	const {
		title,
		experimentNotes,
		hypotheses,
		successCriteria,
		resultsCommentary = "Fill in after reviewing this run in Studio.",
		howToRead = "Use the charts for trends, then validate with tables and ML diagnostics.",
		metricFields,
		primaryMetric,
		mlFeatures = ["tick"],
		includePersonaQuality = true,
		runMode = "deterministic",
		llmProvider = "n/a",
		liveLlmRequired = false,
		shortRun = false,
	} = options;

	const selectFields = Array.from(
		new Set(["tick", "timestamp", ...metricFields]),
	);

	return {
		v: "v1",
		blocks: [
			{
				kind: "markdown",
				title: "Experiment Notes",
				markdown: `# ${title}

## Runtime Mode
- mode: \`${runMode}\`
- llm_provider: \`${llmProvider}\`
- live_llm_required: \`${String(liveLlmRequired)}\`
- short_run: \`${String(shortRun)}\`

## Experiment Notes
${experimentNotes}

## Hypotheses
${markdownList(hypotheses)}

## Success Criteria
${markdownList(successCriteria)}
`,
			},
			{
				kind: "dataset",
				as: "metrics_core",
				title: "Core Metrics",
				table: "metrics",
				spec: {
					v: "v1",
					select: selectFields,
					sort: { field: "tick", dir: "asc" },
					limit: 5000,
				},
			},
			{
				kind: "chart",
				title: `${primaryMetric} (raw)`,
				chartType: "line",
				dataset: "metrics_core",
				xField: "tick",
				yField: primaryMetric,
			},
			{
				kind: "ml",
				as: "ml_linear_primary",
				title: `Linear regression: ${primaryMetric} ~ ${mlFeatures.join(" + ")}`,
				request: {
					kind: "linear_regression",
					runId: "RUN_ID",
					table: "metrics",
					x: mlFeatures,
					y: primaryMetric,
					limit: 5000,
				},
			},
			{
				kind: "table",
				title: "Linear fit vs actual (debug table)",
				dataset: "ml_linear_primary.predictions_long",
				limit: 300,
			},
			{
				kind: "markdown",
				title: "Linear Fit Notes",
				markdown:
					"Regression output can be poorly conditioned in short runs. Use this table to verify prediction rows rather than relying on an auto-scaled line chart.",
			},
			{
				kind: "dataset",
				as: "action_mix",
				title: "Action Mix",
				table: "actions",
				spec: {
					v: "v1",
					groupBy: ["action.name"],
					aggregates: [{ as: "action_count", op: "count" }],
					sort: { field: "action_count", dir: "desc" },
					limit: 500,
				},
			},
			{
				kind: "chart",
				title: "Action Mix (Donut)",
				chartType: "donut",
				dataset: "action_mix",
				xField: "action.name",
				yField: "action_count",
			},
			{
				kind: "dataset",
				as: "gossip_intents",
				title: "Gossip Intent Mix",
				table: "actions",
				spec: {
					v: "v1",
					filters: [{ field: "action.name", op: "eq", value: "PostMessage" }],
					groupBy: ["action.params.intentTag"],
					aggregates: [{ as: "post_count", op: "count" }],
					sort: { field: "post_count", dir: "desc" },
					limit: 100,
				},
			},
			{
				kind: "chart",
				title: "Gossip Intent Mix (Bar)",
				chartType: "bar",
				dataset: "gossip_intents",
				xField: "action.params.intentTag",
				yField: "post_count",
			},
			{
				kind: "table",
				title: "Gossip Intent Mix (Debug Table)",
				dataset: "gossip_intents",
				limit: 100,
			},
			...(includePersonaQuality
				? [
						{
							kind: "dataset",
							as: "persona_actions",
							title: "Persona Action Trace",
							table: "actions",
							spec: {
								v: "v1",
								select: [
									"tick",
									"agentId",
									"action.name",
									"action.metadata.personaId",
									"action.metadata.intentTag",
									"action.metadata.rationale",
									"result.ok",
									"result.error",
								],
								sort: { field: "tick", dir: "asc" },
								limit: 2000,
							},
						},
						{
							kind: "table",
							title: "Persona Trace Table",
							dataset: "persona_actions",
							limit: 2000,
						},
					]
				: []),
			{
				kind: "markdown",
				title: "Results Commentary",
				markdown: `## Results Commentary
${resultsCommentary}

## How to Read This
${howToRead}
`,
			},
		],
	};
}
