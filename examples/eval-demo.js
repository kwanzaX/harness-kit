// Runs an eval suite against a simulated, deliberately unreliable model: it sometimes skips the
// tool, sometimes returns malformed JSON, and its "network" fails 20% of the time.
// No API key needed: `npm run example`. Swap `flakyModel` for a real provider adapter.
import { runAgent, runEvals, formatReport } from '../src/index.js';

const prices = { BTC: 64000, ETH: 3100, USDT: 1 };
const tools = [{
  name: 'get_price',
  description: 'USD price of a crypto asset',
  parameters: { type: 'object', properties: { symbol: { type: 'string', enum: Object.keys(prices) } }, required: ['symbol'] },
  run: async ({ symbol }) => ({ symbol, usd: prices[symbol] }),
}];

const flakyModel = async ({ messages }) => {
  if (Math.random() < 0.2) throw new Error('ECONNRESET');
  const last = messages.at(-1);
  if (last.role === 'user' && !last.content.startsWith('Your answer')) {
    const symbol = last.content.match(/BTC|ETH|USDT/)[0];
    if (Math.random() < 0.15) return { text: `{"symbol":"${symbol}","usd":60000}` }; // guessed without the tool
    return { toolCalls: [{ id: 'c1', name: 'get_price', args: { symbol } }] };
  }
  const tool = [...messages].reverse().find((m) => m.role === 'tool');
  const data = JSON.parse(tool?.content ?? '{}');
  if (Math.random() < 0.2) return { text: `price is ${data.usd}` }; // malformed, triggers a repair
  return { text: JSON.stringify({ symbol: data.symbol, usd: data.usd }) };
};

const output = { type: 'object', properties: { symbol: { type: 'string' }, usd: { type: 'number' } }, required: ['symbol', 'usd'] };
const ask = (q) => runAgent({ model: flakyModel, tools, output, messages: [{ role: 'user', content: q }], sleep: async () => {} }).then((r) => r.output);

const report = await runEvals(
  Object.entries(prices).map(([symbol, usd]) => ({
    name: `price of ${symbol}`,
    input: `What is the price of ${symbol}?`,
    check: (out) => out.usd === usd || `answered ${out.usd}, expected ${usd}`,
    minPassRate: 0.8,
  })),
  ask,
  { trials: 20 },
);
console.log(formatReport(report));
process.exitCode = report.ok ? 0 : 1;
