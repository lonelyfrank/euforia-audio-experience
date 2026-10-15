/* global process */
/** All product scenes in one live session/renderer, followed by interrupted transitions. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH,
  args: ['--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const report = { rounds: [], interrupted: [], errors: [] };
page.on('pageerror', e => report.errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') report.errors.push(m.text()); });
try {
  await page.goto(process.env.WORKSPACE_URL || 'http://127.0.0.1:1420');
  await page.waitForFunction(() => window.app);
  const ids = await page.evaluate(async () => {
    const { settingsStore } = await import('/src/stores/settingsStore.ts');
    window.__settings = settingsStore;
    settingsStore.set({ quality: 'low', direction: 'manual', rigMode: 'preset', reflection: false });
    await window.app.playTestSignal('buildDrop');
    window.__renderer = window.app.directionDebug.renderer;
    return (await import('/src/visualizers/registry.ts')).visualizers.map(v => v.id);
  });
  const cdp = await page.context().newCDPSession(page);
  const snapshot = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    return page.evaluate(() => {
      const e = window.app.directionDebug, r = e.renderer;
      return { session: window.app.audio.session, sameRenderer: r === window.__renderer,
        geometries: r.info.memory.geometries, textures: r.info.memory.textures, programs: r.info.programs.length,
        heap: performance.memory?.usedJSHeapSize ?? null, scene: e.current.source.preset.name };
    });
  };
  const settle = () => page.waitForFunction(() => {
    const e = window.app.directionDebug;
    return e.current.ready && e.slots.every(s => !s.previous);
  }, undefined, { timeout: 20000 });
  for (let round = 0; round < 3; round++) {
    const samples = [];
    for (const id of ids) {
      const start = Date.now();
      await page.evaluate(id => window.__settings.set({ scene: id }), id);
      await settle();
      samples.push({ id, switchMs: Date.now() - start, ...await snapshot() });
    }
    report.rounds.push(samples);
  }
  // Replace layers while compilation/crossfade may still be pending, then let the fallback expire.
  for (const id of [...ids, ...ids]) {
    await page.evaluate(id => window.__settings.set({ scene: id }), id);
    await page.waitForTimeout(30);
  }
  await settle(); await page.waitForTimeout(3500);
  report.interrupted.push(await snapshot());
  const resources = r => [r.geometries, r.textures, r.programs];
  // GPU resources are uploaded lazily when a primitive becomes present. Different musical phases can
  // allocate fewer resources (e.g. Shell's dust). Compare the last visit with the observed warm maximum.
  for (let i = 0; i < ids.length; i++) {
    const previous = [resources(report.rounds[0][i]), resources(report.rounds[1][i])];
    assert.ok(resources(report.rounds[2][i]).every((n, k) => n <= Math.max(...previous.map(r => r[k]))), `${ids[i]} GPU resources stay within previous visits`);
  }
  assert.deepEqual(resources(report.interrupted[0]), resources(report.rounds[2].at(-1)), 'interrupted transitions release old GPU resources');
  const all = [...report.rounds.flat(), ...report.interrupted];
  assert.ok(all.every(r => r.sameRenderer && r.session === all[0].session), 'one renderer and one uninterrupted audio session');
  assert.deepEqual(report.errors, []);
  report.outcome = 'pass';
} finally {
  await writeFile(process.env.FIDELITY_OUTPUT || '/tmp/euforia-visual-lifecycle.json', JSON.stringify(report, null, 2));
  await browser.close();
}
