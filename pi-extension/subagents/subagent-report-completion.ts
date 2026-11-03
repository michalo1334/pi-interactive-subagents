/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+J)
 * - Provides a `subagent_report_completion` tool to return results to the parent
 * - Applies an optional process-local compaction budget
 */
import {
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { writeFileSync } from "node:fs";
import { createSubagentActivityRecorder } from "./activity.ts";
import {
  ASK_USER_ANSWER_EVENT,
  ASK_USER_ANSWER_RESULT_EVENT,
  ASK_USER_BLOCKED_EVENT,
  ASK_USER_PROMPT_EVENT,
  createSimulatedUserQuestionRequest,
  getSimulatedUserAnswerPath,
  getSimulatedUserAnswerResultPath,
  getSimulatedUserQuestionPath,
  readSimulatedUserAnswer,
  removeSimulatedUserFile,
  writeJsonAtomic,
  type SimulatedUserQuestion,
  type SimulatedUserQuestionRequest,
} from "./simulated-user.ts";

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

export function shouldAutoExitOnAgentEnd(
  _userTookOver: boolean,
  messages: any[] | undefined,
): boolean {
  // Manual input should not strand an auto-exit subagent. If the latest agent
  // turn completed normally, close the session. Escape/abort still leaves it
  // open for inspection or another prompt.
  //
  // stopReason: "error" (e.g. exhausted retries on a provider overload) also
  // returns true — we want to shut down so the parent is woken up — but we
  // pair this with findLatestAssistantError() so the parent learns it was an
  // error, not a clean completion.
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return msg.stopReason !== "aborted";
      }
    }
  }

  return true;
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (handled separately by shouldAutoExitOnAgentEnd).
 */
export function findLatestAssistantError(
  messages: any[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;
  let contextWindow: number | undefined;
  let activeModel: ExtensionContext["model"];
  let restoreCompactionSettings: (() => void) | undefined;

  // A CLI flag does not leak into nested spawns, unlike an environment variable.
  pi.registerFlag("subagent-context-window", {
    type: "string",
    description: "Usable context tokens before this subagent auto-compacts",
  });

  function contextWindowError(): string | undefined {
    if (contextWindow === undefined || !activeModel) return;
    if (activeModel.api === "pi-virtual") {
      return "contextWindow requires a physical model, not a virtual/router model.";
    }
    if (!Number.isSafeInteger(activeModel.contextWindow) || contextWindow > activeModel.contextWindow) {
      return `contextWindow (${contextWindow}) exceeds the model context window (${activeModel.contextWindow}).`;
    }
  }

  function failContextWindow(ctx: ExtensionContext, message: string) {
    const sessionFile = process.env.PI_SUBAGENT_SESSION;
    if (sessionFile) {
      try {
        writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "error", errorMessage: message }));
      } catch {
        // Still stop the child if the parent notification cannot be written.
      }
    }
    ctx.ui.notify(message, "error");
    ctx.shutdown();
  }

  function installContextWindow() {
    // Pi exposes no extension API to change runtime compaction settings. Scope
    // this reader shim to the child process and restore it at session shutdown.
    // Returning a copy keeps global/project settings and model metadata intact.
    restoreCompactionSettings?.();
    const original = SettingsManager.prototype.getCompactionSettings;
    const readSettings: typeof original = function (this: SettingsManager, ...args: Parameters<typeof original>) {
      const settings = original.apply(this, args);
      if (contextWindow === undefined || !activeModel) return settings;
      const error = contextWindowError();
      if (error) throw new Error(error);
      return { ...settings, reserveTokens: activeModel.contextWindow - contextWindow };
    };
    SettingsManager.prototype.getCompactionSettings = readSettings;
    restoreCompactionSettings = () => {
      if (SettingsManager.prototype.getCompactionSettings === readSettings) {
        SettingsManager.prototype.getCompactionSettings = original;
      }
    };
  }

  pi.on("model_select", (_event, ctx) => {
    activeModel = ctx.model;
    const error = contextWindowError();
    if (error) failContextWindow(ctx, error);
  });

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  const isSubagent = Boolean(process.env.PI_SUBAGENT_ID);
  const simulatedUserQuestionsEnabled = process.env.PI_SUBAGENT_SIMULATED_USER !== "0";
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });
  const capturedQuestionInputs = new Map<string, SimulatedUserQuestion[]>();
  let pendingQuestion: SimulatedUserQuestionRequest | null = null;
  let answerInterval: ReturnType<typeof setInterval> | null = null;

  function stopAnswerInterval() {
    if (!answerInterval) return;
    clearInterval(answerInterval);
    answerInterval = null;
  }

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+J to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+J to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let userTookOver = false;
  let agentStarted = false;

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    activeModel = ctx.model;
    const rawContextWindow = pi.getFlag("subagent-context-window");
    if (rawContextWindow !== undefined) {
      const value = Number(rawContextWindow);
      if (!Number.isSafeInteger(value) || value <= 0) {
        failContextWindow(ctx, "--subagent-context-window must be a positive safe integer in tokens.");
        return;
      }
      contextWindow = value;
      const error = contextWindowError();
      if (error) {
        failContextWindow(ctx, error);
        return;
      }
      installContextWindow();
    }

    recorder.sessionStart();
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx, null);
  });

  pi.on("input", () => {
    recorder.input();
    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover.
    if (!shouldMarkUserTookOver(agentStarted)) return;
    userTookOver = true;
  });

  pi.on("before_agent_start", () => {
    recorder.beforeAgentStart();
  });

  pi.on("agent_start", () => {
    agentStarted = true;
    recorder.agentStart();
  });

  pi.on("agent_end", (event, ctx) => {
    const messages = (event as any).messages as any[] | undefined;
    const shouldExit = autoExit && shouldAutoExitOnAgentEnd(userTookOver, messages);

    if (shouldExit) {
      // Surface stopReason: "error" turns (auto-retry exhausted, provider
      // overload, etc.) to the parent via the .exit sidecar so the watcher
      // can report a clear failure with the underlying error message.
      // Without this the parent would only see exit code 0 and a stale
      // assistant message, mistaking the crash for a successful completion.
      const errorInfo = findLatestAssistantError(messages);
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (errorInfo && sessionFile) {
        try {
          writeFileSync(
            `${sessionFile}.exit`,
            JSON.stringify({
              type: "error",
              errorMessage: errorInfo.errorMessage,
              stopReason: errorInfo.stopReason,
            }),
          );
        } catch {
          // Best effort — even without the sidecar, watcher's session-file
          // fallback can still recover the errorMessage.
        }
      }

      recorder.agentEndDone();
      ctx.shutdown();
      return;
    }

    recorder.agentEndWaiting();
    if (autoExit) {
      // Reset any recorded manual input marker. Auto-exit is decided by whether
      // the latest agent turn completed normally, not by who initiated it.
      userTookOver = false;
    }
  });

  pi.on("turn_start", (event) => {
    recorder.turnStart((event as any).turnIndex);
  });

  pi.on("turn_end", (event) => {
    recorder.turnEnd((event as any).turnIndex);
  });

  if (isSubagent) {
    pi.on("before_provider_request", () => {
      recorder.beforeProviderRequest();
    });
  }

  pi.on("after_provider_response", () => {
    recorder.afterProviderResponse();
  });

  pi.on("message_update", (event) => {
    recorder.messageUpdate((event as any).assistantMessageEvent?.type);
  });

  pi.on("tool_execution_start", (event) => {
    recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_call", (event) => {
    recorder.toolCall((event as any).toolCallId, (event as any).toolName);

    if (
      isSubagent &&
      simulatedUserQuestionsEnabled &&
      (event as any).toolName === "ask_user_question"
    ) {
      capturedQuestionInputs.set(
        (event as any).toolCallId,
        (((event as any).input?.questions ?? []) as SimulatedUserQuestion[]),
      );
    }
  });

  if (isSubagent && simulatedUserQuestionsEnabled) {
    const events = (pi as any).events;
    const sessionFile = process.env.PI_SUBAGENT_SESSION;

    if (events && sessionFile) {
      events.on(ASK_USER_PROMPT_EVENT, (payload: any) => {
        const toolCallId = typeof payload?.toolCallId === "string" ? payload.toolCallId : "";
        if (!toolCallId || !Array.isArray(payload?.questions)) return;

        const authored = capturedQuestionInputs.get(toolCallId) ?? [];
        const questions: SimulatedUserQuestion[] = payload.questions.map(
          (question: SimulatedUserQuestion, questionIndex: number) => ({
            ...question,
            options: question.options.map((option, optionIndex) => ({
              ...option,
              ...(authored[questionIndex]?.options[optionIndex]?.preview
                ? { preview: authored[questionIndex]!.options[optionIndex]!.preview }
                : {}),
            })),
          }),
        );

        pendingQuestion = createSimulatedUserQuestionRequest({
          toolCallId,
          name: process.env.PI_SUBAGENT_NAME ?? "subagent",
          questions,
        });
        removeSimulatedUserFile(getSimulatedUserAnswerPath(sessionFile));
        removeSimulatedUserFile(getSimulatedUserAnswerResultPath(sessionFile));
        writeJsonAtomic(getSimulatedUserQuestionPath(sessionFile), pendingQuestion);

        stopAnswerInterval();
        answerInterval = setInterval(() => {
          if (!pendingQuestion) return;
          const answer = readSimulatedUserAnswer(sessionFile);
          if (
            !answer ||
            answer.requestId !== pendingQuestion.requestId ||
            answer.toolCallId !== pendingQuestion.toolCallId
          ) {
            return;
          }

          removeSimulatedUserFile(getSimulatedUserAnswerPath(sessionFile));
          events.emit(ASK_USER_ANSWER_EVENT, {
            toolCallId: answer.toolCallId,
            requestId: answer.requestId,
            ...(answer.answers ? { answers: answer.answers } : {}),
            ...(answer.globalNote !== undefined ? { globalNote: answer.globalNote } : {}),
            ...(answer.cancel !== undefined ? { cancel: answer.cancel } : {}),
          });
        }, 100);
      });

      events.on(ASK_USER_ANSWER_RESULT_EVENT, (result: any) => {
        if (!pendingQuestion || result?.requestId !== pendingQuestion.requestId) return;
        writeJsonAtomic(getSimulatedUserAnswerResultPath(sessionFile), result);
        if (!result.ok) return;

        capturedQuestionInputs.delete(pendingQuestion.toolCallId);
        removeSimulatedUserFile(getSimulatedUserQuestionPath(sessionFile));
        pendingQuestion = null;
        stopAnswerInterval();
      });

      events.on(ASK_USER_BLOCKED_EVENT, (payload: any) => {
        if (
          payload?.active !== false ||
          !pendingQuestion ||
          payload?.toolCallId !== pendingQuestion.toolCallId
        ) {
          return;
        }

        writeJsonAtomic(getSimulatedUserAnswerResultPath(sessionFile), {
          ok: false,
          requestId: pendingQuestion.requestId,
          toolCallId: pendingQuestion.toolCallId,
          code: "not_found",
          reason: "The questionnaire closed before the simulated answer was accepted.",
        });
        capturedQuestionInputs.delete(pendingQuestion.toolCallId);
        removeSimulatedUserFile(getSimulatedUserQuestionPath(sessionFile));
        pendingQuestion = null;
        stopAnswerInterval();
      });
    }
  }

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_end", (event) => {
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("session_shutdown", (event) => {
    stopAnswerInterval();
    restoreCompactionSettings?.();
    restoreCompactionSettings = undefined;
    recorder.sessionShutdown((event as any).reason);
  });

  // Toggle expand/collapse with Ctrl+J
  pi.registerShortcut("ctrl+j", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description:
      "Send a help request to the parent agent and exit this session. " +
      "The parent will be notified with your message and can resume this session with a response. " +
      "Use when you're stuck, need clarification, or need the parent to take action.",
    parameters: Type.Object({
      message: Type.String({ description: "What you need help with" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "caller_ping is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      recorder.callerPing();
      const exitData = {
        type: "ping" as const,
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        message: params.message,
      };
      writeFileSync(`${sessionFile}.exit`, JSON.stringify(exitData));

      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Ping sent. Session will exit and parent will be notified." }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "subagent_report_completion",
    label: "Report Subagent Completion",
    description:
      "Report task completion and return your results to the parent agent. " +
      "Write an assistant message with your results before calling this tool. " +
      "That message becomes the summary returned to the parent. This tool closes the subagent session.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      recorder.reportCompletion();
      if (sessionFile) {
        writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
      }
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Completion reported. Closing subagent session." }],
        details: {},
      };
    },
  });
}
