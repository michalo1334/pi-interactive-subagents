import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";

export interface SimulatedUserQuestion {
  question: string;
  header: string;
  options: Array<{
    label: string;
    description: string;
    preview?: string;
    hasPreview?: boolean;
  }>;
  multiSelect?: boolean;
}

export interface SimulatedUserQuestionRequest {
  version: 1;
  requestId: string;
  toolCallId: string;
  name: string;
  questions: SimulatedUserQuestion[];
}

export interface SimulatedUserAnswerEntry {
  questionIndex: number;
  optionIndexes?: number[];
  text?: string;
  notes?: string;
}

export interface SimulatedUserAnswer {
  version: 1;
  requestId: string;
  toolCallId: string;
  answers?: SimulatedUserAnswerEntry[];
  globalNote?: string;
  cancel?: boolean;
}

export interface SimulatedUserAnswerResult {
  ok: boolean;
  requestId?: string;
  toolCallId?: string;
  code?: string;
  reason?: string;
}

export const ASK_USER_PROMPT_EVENT = "rpiv:ask-user:prompt";
export const ASK_USER_BLOCKED_EVENT = "rpiv:ask-user:blocked";
export const ASK_USER_ANSWER_EVENT = "rpiv:ask-user:answer";
export const ASK_USER_ANSWER_RESULT_EVENT = "rpiv:ask-user:answer-result";

export function createSimulatedUserQuestionRequest(params: {
  toolCallId: string;
  name: string;
  questions: SimulatedUserQuestion[];
}): SimulatedUserQuestionRequest {
  return {
    version: 1,
    requestId: randomUUID(),
    toolCallId: params.toolCallId,
    name: params.name,
    questions: params.questions,
  };
}

export function getSimulatedUserQuestionPath(sessionFile: string): string {
  return `${sessionFile}.simulated-user-question.json`;
}

export function getSimulatedUserAnswerPath(sessionFile: string): string {
  return `${sessionFile}.simulated-user-answer.json`;
}

export function getSimulatedUserAnswerResultPath(sessionFile: string): string {
  return `${sessionFile}.simulated-user-answer-result.json`;
}

export function writeJsonAtomic(path: string, value: unknown): void {
  const temporaryPath = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(value), "utf8");
  renameSync(temporaryPath, path);
}

function readJson(path: string): any | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function readSimulatedUserQuestionRequest(
  sessionFile: string,
): SimulatedUserQuestionRequest | null {
  const data = readJson(getSimulatedUserQuestionPath(sessionFile));
  if (
    data?.version !== 1 ||
    typeof data.requestId !== "string" ||
    typeof data.toolCallId !== "string" ||
    typeof data.name !== "string" ||
    !Array.isArray(data.questions)
  ) {
    return null;
  }
  return data as SimulatedUserQuestionRequest;
}

export function readSimulatedUserAnswer(sessionFile: string): SimulatedUserAnswer | null {
  const data = readJson(getSimulatedUserAnswerPath(sessionFile));
  if (
    data?.version !== 1 ||
    typeof data.requestId !== "string" ||
    typeof data.toolCallId !== "string"
  ) {
    return null;
  }
  return data as SimulatedUserAnswer;
}

export function readSimulatedUserAnswerResult(
  sessionFile: string,
): SimulatedUserAnswerResult | null {
  const data = readJson(getSimulatedUserAnswerResultPath(sessionFile));
  if (!data || typeof data.ok !== "boolean") return null;
  return data as SimulatedUserAnswerResult;
}

export function removeSimulatedUserFile(path: string): void {
  rmSync(path, { force: true });
}

export function formatSimulatedUserQuestionPrompt(
  request: SimulatedUserQuestionRequest,
  runningId: string,
): string {
  const lines = [
    `Sub-agent "${request.name}" is waiting for a simulated-user answer.`,
    "Answer from the parent agent's current understanding.",
    "Do not ask the real user and do not call ask_user_question in the parent session.",
    "Call subagent_answer_question with the subagent id and request id below.",
    "Use 0-based questionIndex and optionIndexes. Use text for a custom answer.",
    "The child pane remains open and continues in the same turn after the answer is accepted.",
    "",
    `Subagent id: ${runningId}`,
    `Request id: ${request.requestId}`,
    "",
    "Questions:",
  ];

  request.questions.forEach((question, questionIndex) => {
    const selection = question.multiSelect ? "Select all that apply" : "Select one";
    lines.push("", `${questionIndex}. [${question.header}] ${question.question}`, `   ${selection}:`);
    question.options.forEach((option, optionIndex) => {
      lines.push(`   ${optionIndex}) ${option.label} — ${option.description}`);
      if (option.preview) lines.push(`      Preview: ${option.preview.replace(/\n/g, "\n      ")}`);
    });
  });

  return lines.join("\n");
}

export function formatSimulatedUserAnswerNotification(
  request: SimulatedUserQuestionRequest,
  answer: SimulatedUserAnswer,
): string {
  if (answer.cancel) return "User declined to answer questions";

  const entries = new Map(
    (answer.answers ?? []).map((entry) => [entry.questionIndex, entry]),
  );
  const segments: string[] = [];

  request.questions.forEach((question, questionIndex) => {
    const entry = entries.get(questionIndex);
    if (!entry) return;
    const values = (entry.optionIndexes ?? [])
      .map((optionIndex) => question.options[optionIndex]?.label)
      .filter((value): value is string => Boolean(value));
    if (entry.text?.trim()) values.push(entry.text.trim());
    segments.push(`"${question.question}"="${values.join(", ")}".`);
  });

  if (answer.globalNote?.trim()) segments.push(`global note: ${answer.globalNote.trim()}.`);
  return `User has answered your questions: ${segments.join(" ")} You can now continue with the user's answers in mind.`;
}
