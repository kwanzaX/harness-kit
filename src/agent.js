// The agent loop: call the model, run the tools it asks for, feed results back, stop on a final answer.
// Provider-agnostic: the model is any async function that returns { text } or { toolCalls }.

import { validate } from './schema.js';
import { withRetry, withTimeout } from './resilience.js';
import { fitContext } from './context.js';

/**
 * @typedef {{ id: string, name: string, args: unknown }} ToolCall
 * @typedef {{ text?: string, toolCalls?: ToolCall[] }} ModelReply
 * @typedef {(req: { messages: object[], tools: object[], signal: AbortSignal }) => Promise<ModelReply>} Model
 * @typedef {{ name: string, description?: string, parameters?: object, run: (args: any, ctx: { signal: AbortSignal }) => Promise<unknown>, timeoutMs?: number }} Tool
 */

export class AgentError extends Error {
  constructor(message, { code, steps } = {}) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.steps = steps;
  }
}

/**
 * @param {{
 *   model: Model,
 *   tools?: Tool[],
 *   messages: object[],
 *   maxSteps?: number,
 *   maxTokens?: number,
 *   modelTimeoutMs?: number,
 *   toolTimeoutMs?: number,
 *   retries?: number,
 *   output?: object,
 *   outputRepairs?: number,
 *   onEvent?: (e: object) => void,
 *   sleep?: (ms: number) => Promise<void>,
 * }} opts
 * @returns {Promise<{ text: string, output?: unknown, messages: object[], steps: number }>}
 */
export async function runAgent(opts) {
  const {
    model, tools = [], maxSteps = 8, maxTokens = 8000,
    modelTimeoutMs = 30000, toolTimeoutMs = 10000, retries = 2,
    output, outputRepairs = 2, onEvent = () => {}, sleep,
  } = opts;
  const messages = [...opts.messages];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const toolSpecs = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  let repairsLeft = outputRepairs;

  for (let step = 1; step <= maxSteps; step++) {
    const { messages: window, dropped } = fitContext(messages, { maxTokens });
    if (dropped) onEvent({ type: 'context.trimmed', step, dropped });

    const reply = await withRetry(
      () => withTimeout((signal) => model({ messages: window, tools: toolSpecs, signal }), modelTimeoutMs),
      { retries, sleep, onRetry: (err, attempt) => onEvent({ type: 'model.retry', step, attempt, error: err.message }) },
    );

    if (reply.toolCalls?.length) {
      messages.push({ role: 'assistant', content: reply.text ?? '', toolCalls: reply.toolCalls });
      // Independent tool calls run in parallel; each one fails on its own without sinking the others.
      const results = await Promise.all(reply.toolCalls.map((call) => runTool(call, byName, toolTimeoutMs, onEvent, step)));
      messages.push(...results);
      continue;
    }

    const text = reply.text ?? '';
    messages.push({ role: 'assistant', content: text });
    if (!output) return { text, messages, steps: step };

    // Structured output: parse and validate; on failure, tell the model what was wrong and let it repair.
    const parsed = parseJson(text);
    const errors = parsed.ok ? validate(output, parsed.value) : [`not valid JSON: ${parsed.error}`];
    if (!errors.length) return { text, output: parsed.value, messages, steps: step };
    if (repairsLeft-- <= 0) throw new AgentError(`output failed validation: ${errors.join('; ')}`, { code: 'BAD_OUTPUT', steps: step });
    onEvent({ type: 'output.repair', step, errors });
    messages.push({ role: 'user', content: `Your answer did not match the required JSON schema:\n- ${errors.join('\n- ')}\nReply again with only the corrected JSON.` });
  }
  throw new AgentError(`no final answer after ${maxSteps} steps`, { code: 'MAX_STEPS', steps: maxSteps });
}

async function runTool(call, byName, defaultTimeout, onEvent, step) {
  const tool = byName.get(call.name);
  const reply = (content, isError = false) => ({ role: 'tool', toolCallId: call.id, name: call.name, content, isError });
  if (!tool) return reply(`Unknown tool "${call.name}".`, true);

  const errors = validate(tool.parameters, call.args);
  if (errors.length) {
    onEvent({ type: 'tool.invalid_args', step, tool: call.name, errors });
    return reply(`Invalid arguments: ${errors.join('; ')}`, true);
  }

  const started = Date.now();
  try {
    const result = await withTimeout((signal) => tool.run(call.args, { signal }), tool.timeoutMs ?? defaultTimeout);
    onEvent({ type: 'tool.ok', step, tool: call.name, ms: Date.now() - started });
    return reply(typeof result === 'string' ? result : JSON.stringify(result));
  } catch (err) {
    // The model sees the failure and can choose another path; the loop keeps going.
    onEvent({ type: 'tool.error', step, tool: call.name, error: err.message, ms: Date.now() - started });
    return reply(`Tool failed: ${err.message}`, true);
  }
}

function parseJson(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
