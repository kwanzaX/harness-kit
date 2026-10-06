export interface ToolCall { id: string; name: string; args: unknown }
export interface ModelReply { text?: string; toolCalls?: ToolCall[] }
export interface Message { role: 'system' | 'user' | 'assistant' | 'tool'; content?: unknown; toolCalls?: ToolCall[]; toolCallId?: string; name?: string; isError?: boolean }
export interface ToolSpec { name: string; description?: string; parameters?: JsonSchema }
export type Model = (req: { messages: Message[]; tools: ToolSpec[]; signal: AbortSignal }) => Promise<ModelReply>;
export interface Tool extends ToolSpec { run(args: any, ctx: { signal: AbortSignal }): Promise<unknown>; timeoutMs?: number }
export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  additionalProperties?: boolean;
  [key: string]: unknown;
};
export type AgentEvent =
  | { type: 'context.trimmed'; step: number; dropped: number }
  | { type: 'model.retry'; step: number; attempt: number; error: string }
  | { type: 'tool.ok'; step: number; tool: string; ms: number }
  | { type: 'tool.error'; step: number; tool: string; error: string; ms: number }
  | { type: 'tool.invalid_args'; step: number; tool: string; errors: string[] }
  | { type: 'output.repair'; step: number; errors: string[] };

export interface RunAgentOptions {
  model: Model;
  tools?: Tool[];
  messages: Message[];
  maxSteps?: number;
  maxTokens?: number;
  modelTimeoutMs?: number;
  toolTimeoutMs?: number;
  retries?: number;
  output?: JsonSchema;
  outputRepairs?: number;
  onEvent?: (e: AgentEvent) => void;
  sleep?: (ms: number) => Promise<void>;
}
export function runAgent<T = unknown>(opts: RunAgentOptions): Promise<{ text: string; output?: T; messages: Message[]; steps: number }>;
export class AgentError extends Error { code: 'BAD_OUTPUT' | 'MAX_STEPS'; steps: number }

export interface EvalCase<I = unknown, R = unknown> { name: string; input: I; check(result: R): boolean | string; minPassRate?: number }
export interface EvalResult { name: string; passed: number; trials: number; passRate: number; ok: boolean; failures: string[]; p50Ms: number }
export function runEvals<I, R>(cases: EvalCase<I, R>[], run: (input: I) => Promise<R>, opts?: { trials?: number; concurrency?: number }): Promise<{ ok: boolean; results: EvalResult[] }>;
export function formatReport(report: { results: EvalResult[] }): string;

export function fitContext(messages: Message[], opts: { maxTokens: number; count?: (m: Message) => number }): { messages: Message[]; dropped: number };
export function approxTokens(m: Message): number;
export function withRetry<T>(fn: (attempt: number) => Promise<T>, opts?: { retries?: number; baseMs?: number; maxMs?: number; sleep?: (ms: number) => Promise<void>; onRetry?: (err: Error, attempt: number) => void }): Promise<T>;
export function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T>;
export class TimeoutError extends Error {}
export function validate(schema: JsonSchema, value: unknown, path?: string): string[];
