# harness-kit

A small, provider-agnostic agent harness for Node.js, with evals for non-deterministic runs. Zero dependencies, about 300 lines.

- **Agent loop**: call the model, run the tools it asks for (in parallel), feed results back, stop on a final answer or at `maxSteps`.
- **Tool calling**: tool arguments are validated against a JSON schema before the tool runs. Invalid arguments, unknown tools, tool errors and tool timeouts go back to the model as tool results, so it can recover instead of the run crashing.
- **Context management**: before every model call the history is trimmed to a token budget. The system prompt always stays, the newest messages win, and an assistant tool call is never kept without its results (most providers reject that).
- **Structured outputs**: give an `output` schema and the final answer is parsed and validated. On failure the model gets the exact validation errors and a bounded number of repair attempts.
- **Designed for failure**: every model and tool call has a timeout (with an `AbortSignal` passed through) and model calls retry with exponential backoff and jitter. Errors marked `retryable: false` stop at once.
- **Evals**: run each case N times and report pass rate, distinct failure reasons and p50 latency. A case that passes 3 of 5 runs is flaky, and that is the finding.

## Install

```
npm install llm-harness-kit
```

Node 18+. ESM, with TypeScript types included.

## Use

```js
import { runAgent } from 'llm-harness-kit';

const res = await runAgent({
  model: myProviderAdapter, // async ({ messages, tools, signal }) => ({ text }) | ({ toolCalls: [{ id, name, args }] })
  tools: [{
    name: 'get_price',
    parameters: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
    run: async ({ symbol }, { signal }) => fetchPrice(symbol, { signal }),
  }],
  output: { type: 'object', properties: { usd: { type: 'number' } }, required: ['usd'] },
  messages: [{ role: 'user', content: 'What is BTC worth?' }],
  onEvent: (e) => console.log(e), // retries, tool errors, trims, repairs: one stream for observability
});
console.log(res.output); // { usd: 64000 }
```

The model is any async function, so one adapter per provider (Claude, OpenAI, a local model through llama.cpp) is all it takes.

## Evals

```js
import { runEvals, formatReport } from 'llm-harness-kit';

const report = await runEvals(cases, (input) => ask(input), { trials: 20 });
console.log(formatReport(report));
// PASS  price of BTC   19/20 (95%)  p50 3 ms  — answered 60000, expected 64000
// FAIL  price of ETH   15/20 (75%)  p50 2 ms  — answered 60000, expected 3100
```

`npm run example` runs this against a simulated model that drops connections, skips tools and returns malformed JSON on purpose.

## Tests

```
npm test
```

12 tests on Node's built-in runner, using scripted fake models: tool round-trips, invalid arguments, failing and hanging tools in the same step, retries, model timeouts, output repair, `maxSteps`, context trimming and eval pass rates.

## Not included (yet)

Streaming, token counting with a real tokenizer (pass your own `count` to `fitContext`), and persistence of runs. Each is a small addition on top of the event stream.
