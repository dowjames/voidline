// GPU-timed benchmark driver.
//
// Serves the project over localhost, boots bench.html in headless Chrome on the
// real Metal GPU, runs a fixed deterministic workload, and reports frame cost.
//
// Per-frame samples use gl.finish() so each number covers CPU submit + GPU
// execution rather than just the CPU half. Median is the primary metric: it is
// robust to the occasional scheduler hiccup that would poison a mean.

import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wasm': 'application/wasm',
};

function serve(port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

function pct(sorted, q) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return sorted[i];
}

function summarize(samples) {
  const s = [...samples].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = s.length;
  const mean = s.reduce((a, b) => a + b, 0) / Math.max(1, n);
  return {
    n,
    min: s[0] ?? NaN,
    median: pct(s, 0.5),
    p90: pct(s, 0.9),
    p95: pct(s, 0.95),
    max: s[n - 1] ?? NaN,
    mean,
  };
}

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
}
function has(name) { return process.argv.includes(`--${name}`); }

export async function runBenchmark(opts = {}) {
  const width = parseInt(opts.width ?? arg('width', 1280), 10);
  const height = parseInt(opts.height ?? arg('height', 720), 10);
  const warmup = parseInt(opts.warmup ?? arg('warmup', 150), 10);
  const measure = parseInt(opts.measure ?? arg('measure', 360), 10);
  const port = parseInt(opts.port ?? arg('port', 8731), 10);
  const seed = opts.seed ?? arg('seed', 'bench');
  const exe = opts.executable ?? arg('chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  const extraQs = opts.qs ?? arg('qs', '');

  const server = await serve(port);
  const errors = [];

  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: 'new',
    args: [
      '--use-angle=metal',
      '--enable-unsafe-swiftshader',
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--disable-gpu-driver-bug-workarounds',
      '--disable-frame-rate-limit',
      '--disable-gpu-vsync',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--window-size=' + width + ',' + height,
      '--hide-scrollbars',
      '--mute-audio',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push('console: ' + m.text());
    });

    const qs = new URLSearchParams({ seed, ...opts.params });
    const url = `http://localhost:${port}/bench.html?${qs}${extraQs ? (qs.toString() ? '&' : '') + extraQs : ''}`;
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });

    await page.waitForFunction('window.__bench && window.__bench.isReady() === true', { timeout: 120000 });

    const bootErr = await page.evaluate(() => window.__bootError || null);
    if (bootErr) throw new Error('game failed to boot: ' + bootErr);

    const gpu = await page.evaluate(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      const d = gl && gl.getExtension('WEBGL_debug_renderer_info');
      return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
    });

    const mode = opts.mode ?? arg('mode', 'synced');
    const jsFn = mode === 'pipelined' ? 'run' : 'runSynced';

    // Warmup: JIT warm, shader compile/link, texture upload, pipeline priming.
    await page.evaluate(([f, fn]) => window.__bench[fn](f), [warmup, jsFn]);

    // Per-frame deltas (measurement of record).
    const samples = await page.evaluate(([f, fn]) => window.__bench[fn](f), [measure, jsFn]);
    const stats = await page.evaluate(() => window.__bench.stats());

    const sum = summarize(samples);
    return { width, height, warmup, measure, gpu, samples, sum, stats, errors };
  } finally {
    await browser.close();
    server.close();
  }
}

// CLI ------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const json = has('json');
  const metrics = has('metrics');
  try {
    const r = await runBenchmark();

    // A page error means the scene is broken, not just slow. Favicon 404s are noise.
    const realErrors = r.errors.filter((e) => !/favicon|404/i.test(e));

    if (metrics) {
      const m = [
        `METRIC frame_ms=${r.sum.median.toFixed(4)}`,
        `METRIC frame_mean_ms=${r.sum.mean.toFixed(4)}`,
        `METRIC frame_p95_ms=${r.sum.p95.toFixed(4)}`,
        `METRIC fps=${(1000 / r.sum.median).toFixed(2)}`,
        `METRIC draw_calls=${r.stats.drawCalls}`,
        `METRIC triangles=${r.stats.triangles}`,
      ];
      process.stdout.write(m.join('\n') + '\n');
    } else if (json) {
      process.stdout.write(JSON.stringify({ ...r, samples: undefined }, null, 2) + '\n');
    } else {
      console.log(`GPU: ${r.gpu}`);
      console.log(`viewport ${r.width}x${r.height}  warmup ${r.warmup}  measure ${r.measure}`);
      console.log(`frame_ms  median ${r.sum.median.toFixed(3)}  mean ${r.sum.mean.toFixed(3)}  p90 ${r.sum.p90.toFixed(3)}  p95 ${r.sum.p95.toFixed(3)}  min ${r.sum.min.toFixed(3)}  max ${r.sum.max.toFixed(3)}`);
      console.log(`stats ${JSON.stringify(r.stats)}`);
    }

    if (!Number.isFinite(r.sum.median) || r.sum.median <= 0) {
      console.error('BENCH FAILED: non-finite frame time');
      process.exit(1);
    }
    if (realErrors.length) {
      console.error('BENCH FAILED: page errors\n  ' + realErrors.slice(0, 12).join('\n  '));
      process.exit(1);
    }
  } catch (e) {
    console.error('BENCH FAILED: ' + ((e && e.stack) || e));
    process.exit(1);
  }
}
