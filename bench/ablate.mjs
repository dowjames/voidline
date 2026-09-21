// Ablation study: attribute frame cost to scene components.
// Diagnostic only — the default harness path never sets `ablate`.
//
// Methodology note: sequential ablation is confounded by GPU thermal drift
// (later cases measured slower regardless of content — observed as "negative"
// costs for removing bloom). Cases are therefore run round-robin across several
// passes so drift hits every case equally, and we take the median of medians.

import { runBenchmark } from './driver.mjs';

const CASES = [
  ['baseline', ''],
  ['- sky dome noise', 'sky'],
  ['- stars', 'stars'],
  ['- planet', 'planet'],
  ['- ships', 'ships'],
  ['- bullets', 'bullets'],
  ['- asteroids', 'asteroids'],
  ['- particles', 'particles'],
  ['- bloom pass', 'bloom'],
  ['- lens pass', 'lens'],
  ['- shadows', 'shadows'],
  ['- glass (canopy+tx)', 'glass'],
];

const PASSES = parseInt(process.argv[2] || '3', 10);
const samples = new Map(CASES.map(([l]) => [l, []]));

for (let pass = 0; pass < PASSES; pass++) {
  for (const [label, ablate] of CASES) {
    const r = await runBenchmark({
      mode: 'synced', width: 1280, height: 720, warmup: 80, measure: 150,
      qs: ablate ? `ablate=${ablate}` : '',
    });
    samples.get(label).push(r.sum.median);
  }
  process.stderr.write(`pass ${pass + 1}/${PASSES} done\n`);
}

const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const base = med(samples.get('baseline'));

console.log(`baseline ${base.toFixed(2)} ms  (${PASSES} interleaved passes)\n`);
const rows = CASES.slice(1).map(([label, ablate]) => {
  const m = med(samples.get(label));
  return { label, ablate, median: m, saved: base - m };
});
rows.sort((a, b) => b.saved - a.saved);
for (const r of rows) {
  console.log(`${r.label.padEnd(22)} ${r.median.toFixed(2)} ms   saves ${r.saved.toFixed(2)} ms  (${(100 * r.saved / base).toFixed(1)}%)`);
}
console.log('\nraw per-pass medians:');
for (const [label, arr] of samples) {
  console.log(`  ${label.padEnd(22)} ${arr.map((v) => v.toFixed(2)).join('  ')}`);
}
