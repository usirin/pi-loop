import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type LoopState = {
	active: boolean;
	paused: boolean;
	objective: string;
	iteration: number;
	maxIterations: number;
	intervalMs: number;
	continuePrompt: string;
	stopReason?: string;
};

const DEFAULT_MAX_ITERATIONS = 25;
const DEFAULT_CONTINUE_PROMPT = "Continue the loop.";
const DONE_MARKER = "LOOP_DONE";

function parseDuration(value: string): number | undefined {
	const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
	if (!match) return undefined;

	const amount = Number(match[1]);
	const unit = match[2].toLowerCase();
	const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 60 * 60_000;
	return Math.max(0, Math.round(amount * multiplier));
}

function formatDuration(ms: number): string {
	if (ms <= 0) return "none";
	if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
	if (ms % 60_000 === 0) return `${ms / 60_000}m`;
	if (ms % 1_000 === 0) return `${ms / 1_000}s`;
	return `${ms}ms`;
}

function parseLoopArgs(args: string):
	| { kind: "start"; objective: string; maxIterations: number; intervalMs: number; continuePrompt: string }
	| { kind: "stop" | "pause" | "resume" | "status" | "help" } {
	const trimmed = args.trim();
	if (!trimmed || trimmed === "help" || trimmed === "--help" || trimmed === "-h") return { kind: "help" };

	const [first, ...rest] = trimmed.split(/\s+/);
	if (["stop", "pause", "resume", "status"].includes(first)) {
		return { kind: first as "stop" | "pause" | "resume" | "status" };
	}

	let maxIterations = DEFAULT_MAX_ITERATIONS;
	let intervalMs = 0;
	let continuePrompt = DEFAULT_CONTINUE_PROMPT;
	let objective = trimmed;

	const maxMatch = objective.match(/(?:^|\s)--max(?:=|\s+)(\d+)(?=\s|$)/);
	if (maxMatch) {
		maxIterations = Math.max(1, Number(maxMatch[1]));
		objective = objective.replace(maxMatch[0], " ").trim();
	}

	const intervalMatch = objective.match(/(?:^|\s)--interval(?:=|\s+)(\d+(?:\.\d+)?(?:ms|s|m|h))(?=\s|$)/i);
	if (intervalMatch) {
		intervalMs = parseDuration(intervalMatch[1]) ?? 0;
		objective = objective.replace(intervalMatch[0], " ").trim();
	}

	const continueMatch = objective.match(/(?:^|\s)--continue\s+"([^"]+)"(?=\s|$)/);
	if (continueMatch) {
		continuePrompt = continueMatch[1].trim() || DEFAULT_CONTINUE_PROMPT;
		objective = objective.replace(continueMatch[0], " ").trim();
	}

	// Claude Code-style interval shorthand: `/loop 3m do the thing`.
	const shorthandIntervalMs = parseDuration(first);
	if (shorthandIntervalMs !== undefined && rest.length > 0) {
		intervalMs = shorthandIntervalMs;
		objective = rest.join(" ").trim();
	}
	// Convenience shorthand: `/loop 10 do the thing` sets max iterations.
	else if (/^\d+$/.test(first) && rest.length > 0) {
		maxIterations = Math.max(1, Number(first));
		objective = rest.join(" ").trim();
	}

	return { kind: "start", objective, maxIterations, intervalMs, continuePrompt };
}

function controlPrompt(state: LoopState, firstTurn: boolean): string {
	const header = firstTurn
		? `Start a /loop run for this objective:\n\n${state.objective}`
		: state.continuePrompt;
	const intervalInstructions =
		state.intervalMs > 0
			? `\n- This is an interval loop running every ${formatDuration(state.intervalMs)}. Treat this turn as one scheduled tick.\n- For interval loops, do not call loop_done merely because this tick succeeded; end normally so pi can run the next scheduled tick.\n- For interval loops, only call loop_done if the loop is permanently blocked, unsafe to continue, or the user explicitly asked you to stop.`
			: `\n- If the objective is complete, either call the loop_done tool or include ${DONE_MARKER} in your final response.\n- If more autonomous work remains, do the next slice and end normally; pi will send the next loop turn.`;

	return `${header}

/loop control instructions:
- You are in an autonomous loop. Complete exactly one useful slice of work per turn.${intervalInstructions}
- If you are blocked and need the user, call loop_done with the blocker as the reason.
- Current loop turn: ${state.iteration + 1}/${state.maxIterations}.`;
}

function stateSummary(state: LoopState | undefined): string {
	if (!state?.active) return "No active /loop run.";
	const status = state.paused ? "paused" : "active";
	const interval = state.intervalMs > 0 ? `\nInterval: ${formatDuration(state.intervalMs)}` : "";
	return `/loop is ${status}: turn ${state.iteration}/${state.maxIterations}${interval}\nObjective: ${state.objective}`;
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
	let pendingTimer: ReturnType<typeof setTimeout> | undefined;

	function clearPendingTimer() {
		if (pendingTimer !== undefined) {
			clearTimeout(pendingTimer);
			pendingTimer = undefined;
		}
	}

	function updateUi(ctx: ExtensionContext) {
		if (!state?.active) {
			ctx.ui.setStatus("loop", "");
			ctx.ui.setWidget("loop", []);
			return;
		}

		const status = state.paused ? "paused" : `${state.iteration}/${state.maxIterations}`;
		ctx.ui.setStatus("loop", `loop: ${status}`);
		const interval = state.intervalMs > 0 ? ` every ${formatDuration(state.intervalMs)}` : "";
		ctx.ui.setWidget("loop", [
			`/loop ${state.paused ? "paused" : "running"} (${state.iteration}/${state.maxIterations})${interval}`,
			state.objective,
		]);
	}

	function stopLoop(ctx: ExtensionContext, reason: string) {
		clearPendingTimer();
		if (!state?.active) return;
		state.active = false;
		state.paused = false;
		state.stopReason = reason;
		ctx.ui.notify(`/loop stopped: ${reason}`, "info");
		updateUi(ctx);
	}

	function sendLoopTurn(ctx: ExtensionContext, firstTurn: boolean) {
		clearPendingTimer();
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

	function scheduleNextLoopTurn(ctx: ExtensionContext) {
		if (!state?.active || state.paused) return;
		if (state.intervalMs <= 0) {
			sendLoopTurn(ctx, false);
			return;
		}

		clearPendingTimer();
		ctx.ui.notify(`/loop waiting ${formatDuration(state.intervalMs)} before the next turn.`, "info");
		pendingTimer = setTimeout(() => {
			pendingTimer = undefined;
			sendLoopTurn(ctx, false);
		}, state.intervalMs);
	}

	pi.registerTool({
		name: "loop_done",
		label: "Loop Done",
		description: "Stop the active /loop run when the objective is complete or blocked.",
		promptSnippet: "Stop an active /loop run when the loop objective is complete or blocked",
		promptGuidelines: [
			"Use loop_done when a non-interval /loop run has completed its objective or any /loop run cannot continue without the user. For interval /loop runs, do not use loop_done merely because the current scheduled tick succeeded.",
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
					"Usage: /loop [interval] [--max N] <objective> | /loop --interval 3m <objective> | /loop status|pause|resume|stop\nExamples: /loop 3m check PR reviews | /loop --max 10 fix tests\nStop by calling loop_done or saying LOOP_DONE.",
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
				clearPendingTimer();
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
				intervalMs: parsed.intervalMs,
				continuePrompt: parsed.continuePrompt,
			};
			const interval = parsed.intervalMs > 0 ? ` every ${formatDuration(parsed.intervalMs)}` : "";
			ctx.ui.notify(`Starting /loop for up to ${parsed.maxIterations} turns${interval}.`, "info");
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

		scheduleNextLoopTurn(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (state?.active) {
			stopLoop(ctx, "session shutdown");
		}
	});
}
