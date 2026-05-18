import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type LoopState = {
	active: boolean;
	paused: boolean;
	objective: string;
	iteration: number;
	maxIterations: number;
	continuePrompt: string;
	stopReason?: string;
};

const DEFAULT_MAX_ITERATIONS = 25;
const DEFAULT_CONTINUE_PROMPT = "Continue the loop.";
const DONE_MARKER = "LOOP_DONE";

function parseLoopArgs(args: string):
	| { kind: "start"; objective: string; maxIterations: number; continuePrompt: string }
	| { kind: "stop" | "pause" | "resume" | "status" | "help" } {
	const trimmed = args.trim();
	if (!trimmed || trimmed === "help" || trimmed === "--help" || trimmed === "-h") return { kind: "help" };

	const [first, ...rest] = trimmed.split(/\s+/);
	if (["stop", "pause", "resume", "status"].includes(first)) {
		return { kind: first as "stop" | "pause" | "resume" | "status" };
	}

	let maxIterations = DEFAULT_MAX_ITERATIONS;
	let continuePrompt = DEFAULT_CONTINUE_PROMPT;
	let objective = trimmed;

	const maxMatch = objective.match(/(?:^|\s)--max(?:=|\s+)(\d+)(?=\s|$)/);
	if (maxMatch) {
		maxIterations = Math.max(1, Number(maxMatch[1]));
		objective = objective.replace(maxMatch[0], " ").trim();
	}

	const continueMatch = objective.match(/(?:^|\s)--continue\s+"([^"]+)"(?=\s|$)/);
	if (continueMatch) {
		continuePrompt = continueMatch[1].trim() || DEFAULT_CONTINUE_PROMPT;
		objective = objective.replace(continueMatch[0], " ").trim();
	}

	// Claude Code-style shorthand: `/loop 10 do the thing`.
	if (/^\d+$/.test(first) && rest.length > 0) {
		maxIterations = Math.max(1, Number(first));
		objective = rest.join(" ").trim();
	}

	return { kind: "start", objective, maxIterations, continuePrompt };
}

function controlPrompt(state: LoopState, firstTurn: boolean): string {
	const header = firstTurn
		? `Start a /loop run for this objective:\n\n${state.objective}`
		: state.continuePrompt;

	return `${header}

/loop control instructions:
- You are in an autonomous loop. Complete exactly one useful slice of work per turn.
- If the objective is complete, either call the loop_done tool or include ${DONE_MARKER} in your final response.
- If you are blocked and need the user, call loop_done with the blocker as the reason.
- If more autonomous work remains, do the next slice and end normally; pi will send the next loop turn.
- Current loop turn: ${state.iteration + 1}/${state.maxIterations}.`;
}

function stateSummary(state: LoopState | undefined): string {
	if (!state?.active) return "No active /loop run.";
	const status = state.paused ? "paused" : "active";
	return `/loop is ${status}: turn ${state.iteration}/${state.maxIterations}\nObjective: ${state.objective}`;
}

function getAssistantText(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	const lastAssistant = [...messages]
		.reverse()
		.find((message: any) => message?.role === "assistant") as any;
	const content = lastAssistant?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n");
}

export default function loopExtension(pi: ExtensionAPI) {
	let state: LoopState | undefined;

	function updateUi(ctx: ExtensionContext) {
		if (!state?.active) {
			ctx.ui.setStatus("loop", "");
			ctx.ui.setWidget("loop", []);
			return;
		}

		const status = state.paused ? "paused" : `${state.iteration}/${state.maxIterations}`;
		ctx.ui.setStatus("loop", `loop: ${status}`);
		ctx.ui.setWidget("loop", [
			`/loop ${state.paused ? "paused" : "running"} (${state.iteration}/${state.maxIterations})`,
			state.objective,
		]);
	}

	function stopLoop(ctx: ExtensionContext, reason: string) {
		if (!state?.active) return;
		state.active = false;
		state.paused = false;
		state.stopReason = reason;
		ctx.ui.notify(`/loop stopped: ${reason}`, "info");
		updateUi(ctx);
	}

	function sendLoopTurn(ctx: ExtensionContext, firstTurn: boolean) {
		if (!state?.active || state.paused) return;
		if (state.iteration >= state.maxIterations) {
			stopLoop(ctx, `reached max iterations (${state.maxIterations})`);
			return;
		}

		const prompt = controlPrompt(state, firstTurn);
		state.iteration += 1;
		updateUi(ctx);

		if (ctx.isIdle()) {
			pi.sendUserMessage(prompt);
		} else {
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		}
	}

	pi.registerTool({
		name: "loop_done",
		label: "Loop Done",
		description: "Stop the active /loop run when the objective is complete or blocked.",
		promptSnippet: "Stop an active /loop run when the loop objective is complete or blocked",
		promptGuidelines: [
			"Use loop_done when an active /loop run has completed its objective or cannot continue without the user.",
		],
		parameters: Type.Object({
			reason: Type.String({ description: "Why the loop should stop" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			stopLoop(ctx, params.reason);
			return {
				content: [{ type: "text", text: `Stopped /loop: ${params.reason}` }],
				details: { reason: params.reason },
			};
		},
	});

	pi.registerCommand("loop", {
		description: "Autonomously repeat work until done, stopped, or max iterations is reached",
		getArgumentCompletions: (prefix) => {
			const commands = ["status", "stop", "pause", "resume", "help", "--max "];
			const matches = commands.filter((command) => command.startsWith(prefix));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const parsed = parseLoopArgs(args);

			if (parsed.kind === "help") {
				ctx.ui.notify(
					"Usage: /loop [--max N] <objective> | /loop N <objective> | /loop status|pause|resume|stop\nStop by calling loop_done or saying LOOP_DONE.",
					"info",
				);
				return;
			}

			if (parsed.kind === "status") {
				ctx.ui.notify(stateSummary(state), "info");
				return;
			}

			if (parsed.kind === "stop") {
				if (!state?.active) {
					ctx.ui.notify("No active /loop run.", "info");
					return;
				}
				stopLoop(ctx, "stopped by user");
				return;
			}

			if (parsed.kind === "pause") {
				if (!state?.active) {
					ctx.ui.notify("No active /loop run.", "info");
					return;
				}
				state.paused = true;
				updateUi(ctx);
				ctx.ui.notify("/loop paused. Use /loop resume to continue.", "info");
				return;
			}

			if (parsed.kind === "resume") {
				if (!state?.active) {
					ctx.ui.notify("No active /loop run.", "info");
					return;
				}
				state.paused = false;
				ctx.ui.notify("/loop resumed.", "info");
				sendLoopTurn(ctx, false);
				return;
			}

			if (!parsed.objective) {
				ctx.ui.notify("Usage: /loop [--max N] <objective>", "warning");
				return;
			}

			if (state?.active) {
				const replace = await ctx.ui.confirm("/loop already running", "Stop the current loop and start a new one?");
				if (!replace) return;
			}

			state = {
				active: true,
				paused: false,
				objective: parsed.objective,
				iteration: 0,
				maxIterations: parsed.maxIterations,
				continuePrompt: parsed.continuePrompt,
			};
			ctx.ui.notify(`Starting /loop for up to ${parsed.maxIterations} turns.`, "info");
			sendLoopTurn(ctx, true);
		},
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!state?.active || state.paused) return;

		const assistantText = getAssistantText((event as any).messages);
		if (assistantText.includes(DONE_MARKER)) {
			stopLoop(ctx, `assistant emitted ${DONE_MARKER}`);
			return;
		}

		sendLoopTurn(ctx, false);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (state?.active) {
			stopLoop(ctx, "session shutdown");
		}
	});
}
