// Keeps the conversation inside a budget before each model call.
// Rules: the system message always stays; the newest messages win; an assistant tool call
// is never kept without its tool results (or the reverse), because most providers reject that.

/** Rough token estimate (≈ 4 characters per token). Swap in a real tokenizer through options. */
export const approxTokens = (msg) => Math.ceil(JSON.stringify(msg.content ?? '').length / 4) + 4;

/**
 * @param {Array<{role: string, content?: unknown, toolCalls?: unknown[], toolCallId?: string}>} messages
 * @param {{ maxTokens: number, count?: (m: object) => number }} opts
 * @returns {{ messages: object[], dropped: number }}
 */
export function fitContext(messages, { maxTokens, count = approxTokens }) {
  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');

  // Group each assistant tool call with the tool results that answer it, so they live or die together.
  const groups = [];
  for (const m of rest) {
    const prev = groups[groups.length - 1];
    if (m.role === 'tool' && prev && prev.some((p) => p.role === 'assistant' && p.toolCalls?.length)) prev.push(m);
    else groups.push([m]);
  }

  let budget = maxTokens - system.reduce((n, m) => n + count(m), 0);
  const kept = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const cost = groups[i].reduce((n, m) => n + count(m), 0);
    if (cost > budget && kept.length) break;
    kept.unshift(...groups[i]);
    budget -= cost;
  }
  return { messages: [...system, ...kept], dropped: rest.length - kept.length };
}
