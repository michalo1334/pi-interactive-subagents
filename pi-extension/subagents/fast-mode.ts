export interface RequestModel {
  provider?: string;
  api?: string;
  id?: string;
}

const PRIORITY_CAPABLE_CODEX_MODELS = new Set([
  "gpt-5.4",
  "gpt-5.5",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Add the OpenAI Codex Fast-mode tier when all support requirements are met.
 *
 * The caller must return this result from `before_provider_request` unchanged.
 * `undefined` means that the original request must remain unchanged.
 */
export function buildCodexFastModePayload(
  enabled: boolean,
  payload: unknown,
  model: RequestModel | undefined,
): Record<string, unknown> | undefined {
  if (!enabled || !model) return undefined;
  if (model.provider !== "openai-codex") return undefined;
  if (model.api !== "openai-codex-responses") return undefined;
  if (!model.id || !PRIORITY_CAPABLE_CODEX_MODELS.has(model.id)) return undefined;
  if (!isRecord(payload) || payload.model !== model.id) return undefined;
  if ("service_tier" in payload) return undefined;

  return {
    ...payload,
    service_tier: "priority",
  };
}

/** True only for Pi processes launched by the parent subagent extension. */
export function isSubagentProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.PI_SUBAGENT_ID === "string" && env.PI_SUBAGENT_ID.length > 0;
}
