/* global process */
/** Live synthetic source, real RAF and GPU timing, at fixed quality; complements deterministic image replay. */
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.FIDELITY_OUTPUT || '/tmp/euforia-visual-performance';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const report = { head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), viewport: [1280, 720], signal: 'buildDrop', solids: process.env.FIDELITY_SOLIDS === '1', warmup: 16, seconds: 6, date: new Date().toISOString(), runs: [] };
try {
  const scenes = (process.env.FIDELITY_SCENES || 'spectrum,terrain,monolith-desert,fractured-expanse,pulse-ocean,resonant-forest,matter-field').split(',');
  for (const quality of (process.env.FIDELITY_QUALITIES || 'low,medium,high').split(',')) for (const scene of scenes) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(process.env.WORKSPACE_URL || 'http://127.0.0.1:1420');
    await page.waitForFunction(() => window.app);
    await page.evaluate(async ({ scene, quality }) => {
      const { settingsStore } = await import('/src/stores/settingsStore.ts');
      settingsStore.set({ scene, quality, direction: 'manual', rigMode: 'preset', reflection: false, trackInfo: 'hidden' });
      await window.app.playTestSignal('buildDrop');
    }, { scene, quality });
    if (report.solids) await page.evaluate(async () => {
      const { solidSlot } = await import('/src/visual-engine/primitives/solidSlot.ts');
      const world = window.app.directionDebug.current.visualizer.world;
      if (!world) throw new Error('Experimental solids need a recipe');
      world.add(solidSlot());
    });
    await page.waitForFunction(() => window.app.audio.timing.heardTime >= 16, undefined, { timeout: 60000 });
    await page.evaluate(() => {
      const engine = window.app.directionDebug, renderer = engine.renderer, gl = renderer.getContext();
      const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2'), info = gl.getExtension('WEBGL_debug_renderer_info');
      const pending = [], samples = [], gpu = []; let query = null, start = 0, source = 0, layers = 0, interval = 0, disjoint = 0;
      const previous = renderer.info.autoReset; renderer.info.autoReset = false;
      engine.diagnostics = {
        begin(_now, dt) {
          if (timer) {
            if (gl.getParameter(timer.GPU_DISJOINT_EXT)) { disjoint++; for (const q of pending) gl.deleteQuery(q); pending.length = 0; }
            else while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) { const q = pending.shift(); gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6); gl.deleteQuery(q); }
            if (pending.length < 8) { query = gl.createQuery(); gl.beginQuery(timer.TIME_ELAPSED_EXT, query); }
          }
          renderer.info.reset(); interval = dt * 1000; start = performance.now();
        },
        sourceDone() { source = performance.now(); }, layersDone() { layers = performance.now(); },
        end(count, crossfades, passes) {
          const end = performance.now();
          if (query) { gl.endQuery(timer.TIME_ELAPSED_EXT); pending.push(query); query = null; }
          samples.push({ dt: interval, source: source - start, layers: layers - source, composite: end - layers,
            ...renderer.info.render, ...renderer.info.memory, programs: renderer.info.programs.length, count, crossfades, passes,
            solid: engine.current.visualizer.debug?.['solid ms'] ?? null });
        }
      };
      window.__performanceStop = () => {
        engine.diagnostics = null; renderer.info.autoReset = previous;
        for (const q of pending) gl.deleteQuery(q);
        return { samples, gpu, disjoint, renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
          resolution: [renderer.domElement.width, renderer.domElement.height], heap: performance.memory?.usedJSHeapSize ?? null,
          heard: window.app.audio.timing.heardTime, debug: engine.current.visualizer.debug };
      };
    });
    await page.waitForTimeout(6000);
    const result = await page.evaluate(() => window.__performanceStop());
    report.runs.push({ scene, quality, ...result, errors });
    console.log(scene, quality, result.samples.length, 'frames', result.gpu.length, 'GPU queries', errors.length, 'errors');
    await writeFile(`${output}/performance.json`, JSON.stringify(report, null, 2));
    await page.close();
  }
} finally { await writeFile(`${output}/performance.json`, JSON.stringify(report, null, 2)); await browser.close(); }
