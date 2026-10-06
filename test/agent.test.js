import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, AgentError, fitContext, runEvals, validate, withRetry, TimeoutError } from '../src/index.js';

const noSleep = async () => {};

// A model that replays a fixed script of replies and records what it was sent.
function scripted(replies) {
  const calls = [];
  const model = async (req) => {
    calls.push(req);
    const next = replies[calls.length - 1];
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(req);
    return next ?? { text: 'done' };
  };
  model.calls = calls;
  return model;
}

const weather = {
  name: 'get_weather',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
  run: async ({ city }) => ({ city, tempC: 21 }),
};

test('runs a tool call and returns the final answer', async () => {
  const model = scripted([
    { toolCalls: [{ id: 't1', name: 'get_weather', args: { city: 'Luanda' } }] },
    (req) => ({ text: `It is ${JSON.parse(req.messages.at(-1).content).tempC}°C` }),
  ]);
  const res = await runAgent({ model, tools: [weather], messages: [{ role: 'user', content: 'Weather?' }] });
  assert.equal(res.text, 'It is 21°C');
  assert.equal(res.steps, 2);
  assert.deepEqual(model.calls[0].tools.map((t) => t.name), ['get_weather']);
});

test('invalid tool arguments go back to the model instead of crashing', async () => {
  const model = scripted([
    { toolCalls: [{ id: 't1', name: 'get_weather', args: { town: 'Luanda' } }] },
    (req) => ({ text: req.messages.at(-1).content }),
  ]);
  const res = await runAgent({ model, tools: [weather], messages: [{ role: 'user', content: 'x' }] });
  assert.match(res.text, /city: required/);
  assert.match(res.text, /town: not allowed/);
});

test('a failing or hanging tool does not sink the other tool calls', async () => {
  const boom = { name: 'boom', run: async () => { throw new Error('upstream 503'); } };
  const hang = { name: 'hang', timeoutMs: 20, run: () => new Promise(() => {}) };
  const model = scripted([
    { toolCalls: [{ id: 'a', name: 'boom', args: {} }, { id: 'b', name: 'hang', args: {} }, { id: 'c', name: 'get_weather', args: { city: 'Lisbon' } }] },
    (req) => ({ text: req.messages.filter((m) => m.role === 'tool').map((m) => `${m.name}:${m.isError ? 'err' : 'ok'}`).join(',') }),
  ]);
  const res = await runAgent({ model, tools: [boom, hang, weather], messages: [{ role: 'user', content: 'x' }] });
  assert.equal(res.text, 'boom:err,hang:err,get_weather:ok');
});

test('retries transient model errors, then succeeds', async () => {
  const model = scripted([new Error('ECONNRESET'), new Error('429'), { text: 'ok' }]);
  const events = [];
  const res = await runAgent({ model, messages: [{ role: 'user', content: 'x' }], sleep: noSleep, onEvent: (e) => events.push(e.type) });
  assert.equal(res.text, 'ok');
  assert.deepEqual(events, ['model.retry', 'model.retry']);
});

test('a model call that hangs times out and is retried', async () => {
  const model = scripted([() => new Promise(() => {}), { text: 'second try' }]);
  const res = await runAgent({ model, messages: [{ role: 'user', content: 'x' }], modelTimeoutMs: 20, sleep: noSleep });
  assert.equal(res.text, 'second try');
});

test('structured output is validated and repaired', async () => {
  const output = { type: 'object', properties: { score: { type: 'integer' } }, required: ['score'] };
  const model = scripted([{ text: '{"score": "high"}' }, { text: '```json\n{"score": 7}\n```' }]);
  const res = await runAgent({ model, output, messages: [{ role: 'user', content: 'rate' }] });
  assert.deepEqual(res.output, { score: 7 });
  assert.match(model.calls[1].messages.at(-1).content, /\$\.score: expected integer/);
});

test('gives up with a typed error when the output never validates', async () => {
  const model = scripted([{ text: 'nope' }, { text: 'nope' }]);
  await assert.rejects(
    runAgent({ model, output: { type: 'object' }, outputRepairs: 1, messages: [{ role: 'user', content: 'x' }] }),
    (err) => err instanceof AgentError && err.code === 'BAD_OUTPUT',
  );
});

test('stops at maxSteps when the model keeps calling tools', async () => {
  const loop = () => ({ toolCalls: [{ id: String(Math.random()), name: 'get_weather', args: { city: 'X' } }] });
  const model = scripted(Array(10).fill(loop));
  await assert.rejects(
    runAgent({ model, tools: [weather], maxSteps: 3, messages: [{ role: 'user', content: 'x' }] }),
    (err) => err.code === 'MAX_STEPS' && model.calls.length === 3,
  );
});

test('context trimming keeps the system prompt and never splits a tool call from its result', () => {
  const big = 'x'.repeat(400); // ≈100 tokens each
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: big },
    { role: 'assistant', content: '', toolCalls: [{ id: '1' }] },
    { role: 'tool', toolCallId: '1', content: big },
    { role: 'user', content: big },
  ];
  const { messages: kept, dropped } = fitContext(messages, { maxTokens: 260 });
  assert.equal(kept[0].role, 'system');
  assert.deepEqual(kept.slice(1).map((m) => m.role), ['assistant', 'tool', 'user']);
  assert.equal(dropped, 1);
});

test('validate reports nested errors with paths', () => {
  const schema = { type: 'object', properties: { items: { type: 'array', items: { type: 'object', required: ['id'] } } } };
  assert.deepEqual(validate(schema, { items: [{ id: 1 }, {}] }), ['$.items[1].id: required']);
});

test('withRetry stops at once on non-retryable errors', async () => {
  let n = 0;
  const fatal = Object.assign(new Error('bad key'), { retryable: false });
  await assert.rejects(withRetry(async () => { n++; throw fatal; }, { sleep: noSleep }), /bad key/);
  assert.equal(n, 1);
  assert.equal(new TimeoutError(5).name, 'TimeoutError');
});

test('evals report pass rates across trials and flag flaky cases', async () => {
  let i = 0;
  const flaky = async () => (i++ % 2 === 0 ? 'right' : 'wrong');
  const report = await runEvals(
    [
      { name: 'stable', input: 1, check: () => true },
      { name: 'flaky', input: 2, check: (r) => r === 'right' || `got ${r}`, minPassRate: 0.8 },
    ],
    (input) => (input === 1 ? Promise.resolve('x') : flaky()),
    { trials: 4, concurrency: 1 },
  );
  const [stable, flakyResult] = report.results;
  assert.equal(stable.passRate, 1);
  assert.equal(flakyResult.passRate, 0.5);
  assert.equal(flakyResult.ok, false);
  assert.deepEqual(flakyResult.failures, ['got wrong']);
  assert.equal(report.ok, false);
});
