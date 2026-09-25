// PHASE P4 — prompt-embed composer.
// Flattens the OpenAI messages[] into one prompt for a single `opencode run`,
// because OpenCode sessions do not recall previous turns (docs/plan.md §3.5-§3.6).

export interface ChatMessage {
  role: string;
  content: string;
}

export function normalizeContent(content: unknown): string {
  if (content == null) return "";
  return String(content);
}

export function composePrompt(messages: ChatMessage[]): string {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("composePrompt expects a non-empty array of messages");
  }

  const lastIndex = messages.length - 1;
  const systemContents: string[] = [];
  const history: string[] = [];

  for (let i = 0; i < lastIndex; i++) {
    const message = messages[i];
    const role = message && message.role ? String(message.role) : "";
    const content = normalizeContent(message?.content);

    if (role.toLowerCase() === "system" || role.toLowerCase() === "developer") {
      systemContents.push(content);
    } else {
      const label = role ? toTitleCase(role) : "Unknown";
      history.push(`${label}: ${content}`);
    }
  }

  const systemJoined = systemContents.join("\n");
  const historySection = history.join("\n");
  const lastContent = normalizeContent(messages[lastIndex]?.content);

  const lines: string[] = [
    "You are an expert assistant. Below is a conversation with a user.",
    "Reply to the final message. Do not reference that this is a conversation.",
  ];
  if (systemJoined) lines.push("", `System: ${systemJoined}`);
  if (historySection) lines.push(historySection);
  lines.push("", `Question: ${lastContent}`);

  return lines.join("\n");
}

export interface PromptAnchors {
  temperature?: number;
  maxTokens?: number;
}

export function buildAnchorLine(anchors: PromptAnchors): string | null {
  const hints: string[] = [];
  if (typeof anchors.temperature === "number") {
    if (anchors.temperature <= 0.3) hints.push("Be precise and deterministic.");
    else if (anchors.temperature >= 1.2) hints.push("Be highly creative and exploratory.");
    else hints.push("Balance accuracy and creativity.");
  }
  if (typeof anchors.maxTokens === "number" && anchors.maxTokens > 0) {
    hints.push(`Keep the answer under roughly ${anchors.maxTokens} tokens.`);
  }
  return hints.length > 0 ? hints.join(" ") : null;
}

export function applyAnchors(prompt: string, anchors: PromptAnchors): string {
  const line = buildAnchorLine(anchors);
  return line ? `${prompt}\n\n${line}` : prompt;
}

function toTitleCase(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}
