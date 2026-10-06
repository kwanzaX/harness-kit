// Evals for non-deterministic agents: run every case several times and report pass rates,
// not a single pass/fail. A case that passes 3 of 5 runs is flaky, and that is the finding.

/**
 * @typedef {{ name: string, input: unknown, check: (result: any) => boolean | string, minPassRate?: number }} EvalCase
 * @param {EvalCase[]} cases
 * @param {(input: unknown) => Promise<unknown>} run
 * @param {{ trials?: number, concurrency?: number }} [opts]
 */
export async function runEvals(cases, run, { trials = 5, concurrency = 4 } = {}) {
  const jobs = cases.flatMap((c) => Array.from({ length: trials }, (_, t) => ({ c, t })));
  const outcomes = new Map(cases.map((c) => [c.name, []]));

  await pool(jobs, concurrency, async ({ c }) => {
    const started = Date.now();
    let pass = false;
    let reason = '';
    try {
      const verdict = c.check(await run(c.input));
      pass = verdict === true;
      reason = pass ? '' : typeof verdict === 'string' ? verdict : 'check returned false';
    } catch (err) {
      reason = `threw: ${err.message}`;
    }
    outcomes.get(c.name).push({ pass, reason, ms: Date.now() - started });
  });

  const results = cases.map((c) => {
    const runs = outcomes.get(c.name);
    const passed = runs.filter((r) => r.pass).length;
    const passRate = passed / runs.length;
    const minPassRate = c.minPassRate ?? 1;
    return {
      name: c.name,
      passed,
      trials: runs.length,
      passRate,
      ok: passRate >= minPassRate,
      failures: [...new Set(runs.filter((r) => !r.pass).map((r) => r.reason))],
      p50Ms: percentile(runs.map((r) => r.ms), 50),
    };
  });
  return { ok: results.every((r) => r.ok), results };
}

/** One line per case, for CI logs. */
export function formatReport({ results }) {
  return results
    .map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.passed}/${r.trials} (${Math.round(r.passRate * 100)}%)  p50 ${r.p50Ms} ms${r.failures.length ? `  — ${r.failures.join(' | ')}` : ''}`)
    .join('\n');
}

async function pool(items, size, worker) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  });
  await Promise.all(lanes);
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
