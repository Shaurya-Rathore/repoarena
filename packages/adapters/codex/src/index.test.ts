import { expect, it } from "vitest";
import { codexExecArgs, parseCodexUsage } from "./index.js";

it("uses current noninteractive writable ephemeral Codex flags", () => {
	expect(codexExecArgs("repair the fixture", "test-model")).toEqual([
		"exec",
		"--json",
		"--color",
		"never",
		"--sandbox",
		"workspace-write",
		"--ephemeral",
		"--model",
		"test-model",
		"repair the fixture",
	]);
});

it("normalizes the final valid Codex JSONL usage event", () => {
	const fixture = [
		JSON.stringify({ type: "turn.started" }),
		"sanitized non-json progress",
		JSON.stringify({
			type: "turn.completed",
			usage: {
				input_tokens: 120,
				cached_input_tokens: 80,
				cache_write_input_tokens: 0,
				output_tokens: 21,
				reasoning_output_tokens: 9,
			},
		}),
	].join("\n");
	expect(parseCodexUsage(fixture)).toEqual({
		input_tokens: 120,
		cached_input_tokens: 80,
		output_tokens: 21,
		reasoning_tokens: 9,
	});
});

it("leaves malformed or incomplete usage unavailable", () => {
	expect(
		parseCodexUsage(
			JSON.stringify({
				type: "turn.completed",
				usage: { input_tokens: 1, output_tokens: "secret-shaped-invalid" },
			}),
		),
	).toBeNull();
});
