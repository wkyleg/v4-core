#!/usr/bin/env tsx

function hasOpenAi(): boolean {
	return Boolean(process.env.OPENAI_API_KEY?.trim());
}

function hasOpenRouter(): boolean {
	return Boolean(process.env.OPENROUTER_API_KEY?.trim());
}

function main(): void {
	const hasAnyProvider = hasOpenAi() || hasOpenRouter();
	if (!hasAnyProvider) {
		console.error(
			"Live LLM run requires OPENAI_API_KEY or OPENROUTER_API_KEY. Aborting.",
		);
		process.exit(1);
	}
}

main();
