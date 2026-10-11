/* global process, Buffer */
/** Real-browser acceptance and repeatable overhead probe. See docs/engine-workspace.md. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const { chromium } = await import(process.argv[3] || process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ executablePath: process.argv[4] || process.env.CHROMIUM_PATH || undefined,
  args: ['--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.addInitScript(() => {
  window.__resources = { intervals: 0, observers: 0 };
  const intervals = new Set(), startInterval = window.setInterval.bind(window), stopInterval = window.clearInterval.bind(window);
  window.setInterval = (...args) => { const id = startInterval(...args); intervals.add(id); window.__resources.intervals = intervals.size; return id; };
  window.clearInterval = id => { intervals.delete(id); window.__resources.intervals = intervals.size; stopInterval(id); };
  for (const key of ['ResizeObserver', 'IntersectionObserver']) {
    const Observer = window[key];
    window[key] = class extends Observer {
      active = false;
      observe(...args) { if (!this.active) { this.active = true; window.__resources.observers++; } return super.observe(...args); }
      disconnect() { if (this.active) { this.active = false; window.__resources.observers--; } return super.disconnect(); }
    };
  }
  const original = HTMLCanvasElement.prototype.getContext, seen = new WeakSet();
  window.__webglCreations = 0;
  HTMLCanvasElement.prototype.getContext = function (...args) {
    const result = original.apply(this, args);
    if (result && String(args[0]).startsWith('webgl') && !seen.has(this)) { seen.add(this); window.__webglCreations++; }
    return result;
  };
});
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('requestfailed', request => console.log('Request failed', request.url(), request.failure()?.errorText));
page.on('response', response => { if (response.status() >= 400) console.log('HTTP', response.status(), response.url()); });
const mode = process.argv[2] || process.env.WORKSPACE_MODE || 'acceptance';
const url = process.env.WORKSPACE_URL || (mode === 'before' ? 'http://127.0.0.1:1422' : 'http://127.0.0.1:1420');
const output = process.env.WORKSPACE_OUTPUT || `/tmp/euforia-workspace-${mode}.json`;
const click = name => page.getByRole('button', { name, exact: true }).click();
const navigate = view => page.locator(`[data-view="${view}"]`).click();
const report = async () => {
  const pending = page.waitForEvent('download'); await click('Export JSON');
  return JSON.parse(await readFile(await (await pending).path(), 'utf8'));
};
try {
  await page.goto(url);
  await page.waitForFunction(() => window.app);
  await page.evaluate(async () => {
    const { settingsStore } = await import('/src/stores/settingsStore.ts');
    settingsStore.set({ quality: 'low', scene: 'spectrum', direction: 'manual', rigMode: 'preset' });
    await window.app.playTestSignal('beat124');
    window.__originalCanvas = window.app.directionDebug.renderer.domElement;
    window.__originalRenderer = window.app.directionDebug.renderer;
  });
  await page.waitForTimeout(1500);
  if (mode === 'parity') {
    await page.keyboard.press('Shift+G'); await page.locator('.euforia-workspace').waitFor();
    const reports = [];
    for (const label of ['Parità Matter', 'Parità Tracer']) {
      const pending = page.waitForEvent('download'); await click(label);
      const result = JSON.parse(await readFile(await (await pending).path(), 'utf8'));
      assert.equal(result.outcome, 'pass'); reports.push({ label, ...result }); console.log(label, result.mean, result.max);
    }
    assert.equal(await page.evaluate(() => window.__webglCreations), 1);
    assert.deepEqual(errors, []);
    await writeFile(output, JSON.stringify({ reports, webglContexts: 1, errors }, null, 2));
  } else if (mode === 'acceptance') {
    assert.equal(await page.locator('.euforia-workspace').count(), 0);
    const resources = await page.evaluate(() => ({ ...window.__resources }));
    await page.evaluate(() => { window.__initialScene = window.app.directionDebug.current; });
    await page.keyboard.press('Shift+D');
    await page.locator('.euforia-workspace').waitFor();
    assert.equal(await page.locator('h1').first().textContent(), 'Audio & Analysis');
    await page.keyboard.press('Shift+G');
    assert.equal(await page.locator('.euforia-workspace').count(), 1);
    await page.locator('.ws-top').getByRole('button', { name: 'REC', exact: true }).click();
    await page.waitForTimeout(700);
    const first = await report();
    await navigate('audio');
    await page.locator('aside').evaluate(el => { window.__audioMetricRow = el.shadowRoot.querySelector('.row'); });
    await navigate('experience'); await navigate('world'); await navigate('matter'); await navigate('render');
    await navigate('audio');
    assert.equal(await page.locator('aside').evaluate(el => el.shadowRoot.querySelector('.row') === window.__audioMetricRow), true, 'metric DOM reused on domain return');
    await navigate('diagnostics');
    const second = await report();
    assert.equal(await page.evaluate(() => window.app.directionDebug.current === window.__initialScene), true, 'navigation preserves the scene instance');
    assert.ok(second.samples.length >= first.samples.length, 'REC survives navigation');
    assert.equal(await page.evaluate(() => window.app.directionDebug.renderer === window.__originalRenderer && window.app.directionDebug.renderer.domElement === window.__originalCanvas), true);
    await click('Freeze vista');
    const before = await page.locator('aside').evaluate(el => el.shadowRoot.querySelector('.row .value')?.textContent);
    await page.waitForTimeout(500);
    assert.equal(await page.locator('aside').evaluate(el => el.shadowRoot.querySelector('.row .value')?.textContent), before);
    await click('Freeze vista');
    await click('Pausa acquisizione'); const paused = await report(); await page.waitForTimeout(500);
    assert.equal((await report()).samples.length, paused.samples.length); await click('Pausa acquisizione');
    await click('Memorizza baseline'); await click('Confronta');
    await page.getByLabel('Carica report baseline JSON').setInputFiles({ name: 'baseline.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(second)) });
    await page.getByText('Baseline importata', { exact: true }).waitFor();
    await click('Confronta');
    for (const format of ['CSV', 'MD']) { const pending = page.waitForEvent('download'); await click(`Export ${format}`); assert.ok((await readFile(await (await pending).path(), 'utf8')).length > 100); }
    // A shadow DOM select must swallow shortcuts, even when the outer event target is <aside>.
    await page.getByLabel('Dominio diagnostico').focus(); await page.keyboard.press('Shift+D');
    assert.equal(await page.locator('h1').first().textContent(), 'Diagnostics & Reports');
    await page.getByLabel('Dominio diagnostico').evaluate(el => el.blur());
    await page.keyboard.press('Shift+E');
    await page.waitForTimeout(1200);
    await page.getByLabel('Override coherence').check();
    await page.getByLabel('coherence', { exact: true }).fill('0.8');
    await click('Form');
    await navigate('world');
    assert.equal(await page.evaluate(async () => (await import('/src/visual-engine/primitives/WirePolygonPrimitive.ts')).structuralLab.active), true);
    await click('Termina laboratorio');
    assert.deepEqual(await page.evaluate(async () => { const { structuralLab } = await import('/src/visual-engine/primitives/WirePolygonPrimitive.ts'); return [structuralLab.active, structuralLab.tuning.coherence, window.app.pinnedScene]; }), [false, null, null]);
    await navigate('matter'); await page.getByLabel('Forma Matter').selectOption('wave');
    await navigate('diagnostics'); await page.getByLabel('Isolamento sperimentale primitive').evaluate(el => { el.append(new Option('test', 'test')); el.value = 'test'; el.dispatchEvent(new Event('change')); });
    await click('Reset isolamento');
    await page.getByLabel('Scenario replay').selectOption('silence'); await click('Avvia replay');
    await navigate('audio'); await page.waitForTimeout(500); await navigate('diagnostics');
    await page.getByText('Replay completato:', { exact: false }).waitFor({ timeout: 120000 });
    assert.equal((await report()).metadata.source, 'synthetic:silence');
    await click('Usa dati live');
    for (const size of [{ width: 1024, height: 768 }, { width: 1920, height: 1080 }, { width: 1400, height: 900 }]) {
      await page.setViewportSize(size); await page.waitForTimeout(300);
      const dimensions = await page.evaluate(() => { const canvas = window.__originalCanvas, host = canvas.parentElement; return [canvas.clientWidth, canvas.clientHeight, host.clientWidth, host.clientHeight]; });
      assert.equal(dimensions[0], dimensions[2]); assert.equal(dimensions[1], dimensions[3]);
    }
    await page.getByTitle('Espandi / comprimi navigazione').click();
    assert.equal(await page.locator('.euforia-workspace').getAttribute('data-collapsed'), 'true');
    await page.screenshot({ path: output.replace('.json', '.png') });
    await page.keyboard.press('Shift+G');
    assert.equal(await page.locator('.euforia-workspace').count(), 0);
    assert.deepEqual(await page.evaluate(async () => { const { matterLab } = await import('/src/render-systems/forms/MatterForms.ts'); const { worldLab } = await import('/src/visual-engine/VisualWorld.ts'); return [matterLab.form, worldLab.only, window.app.directionDebug.diagnostics, window.__originalCanvas.closest('.app-stage').parentElement.id]; }), ['auto', null, null, 'app']);
    for (let i = 0; i < 6; i++) { await page.keyboard.press('Shift+D'); await page.keyboard.press('Shift+G'); await page.keyboard.press('Shift+G'); }
    assert.equal(await page.locator('.euforia-workspace').count(), 0);
    assert.equal(await page.locator('.app-canvas canvas').count(), 1);
    assert.equal(await page.evaluate(() => window.__webglCreations), 1);
    assert.deepEqual(await page.evaluate(() => ({ ...window.__resources })), resources, 'observers and intervals restored after close');
    assert.deepEqual(errors, []);
    await writeFile(output, JSON.stringify({ result: 'pass', checks: ['shortcuts', 'single canvas and renderer', 'REC continuity', 'freeze', 'pause', 'baseline import', 'compare', 'JSON CSV MD export', 'shadow input guard', 'lab lifecycle', 'override reset', 'pin restore', 'replay continuity', 'resize', 'collapse', 'repeated close/reopen'], errors }, null, 2));
  } else {
    await page.evaluate(() => { const host = window.__originalCanvas.parentElement; host.style.width = '960px'; host.style.height = '540px'; });
    const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
    const result = [];
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x => [x.name, x.value]));
    const measure = async (name, action, during) => {
      await action(); await page.waitForTimeout(2000);
      await page.evaluate(() => { window.__durations = []; let last = performance.now(); const frame = now => { window.__durations.push(now - last); last = now; window.__benchRaf = requestAnimationFrame(frame); }; window.__benchRaf = requestAnimationFrame(frame); });
      const before = await metrics(); await Promise.all([page.waitForTimeout(6000), during?.()]); const after = await metrics();
      const frames = await page.evaluate(() => { cancelAnimationFrame(window.__benchRaf); return window.__durations.slice(1); });
      frames.sort((a,b) => a-b);
      const renderSize = await page.evaluate(() => [window.__originalCanvas.width, window.__originalCanvas.height]);
      result.push({ name, renderSize, frames: frames.length, mean: frames.reduce((a,b)=>a+b,0)/frames.length, p50:frames[Math.ceil(frames.length*.5)-1], p95:frames[Math.ceil(frames.length*.95)-1], p99:frames[Math.ceil(frames.length*.99)-1], jank:frames.filter(x=>x>25).length/frames.length, taskMsPerSecond: (after.TaskDuration-before.TaskDuration)*1000/(after.Timestamp-before.Timestamp), scriptMsPerSecond: (after.ScriptDuration-before.ScriptDuration)*1000/(after.Timestamp-before.Timestamp), heapMB:after.JSHeapUsedSize/1048576, nodes:after.Nodes, layoutCount:after.LayoutCount-before.LayoutCount });
    };
    await measure('closed', async()=>{});
    if (mode === 'before') {
      await measure('audio-legacy', async()=>page.keyboard.press('Shift+D'));
      await page.keyboard.press('Shift+D');
      await measure('diagnostics-legacy', async()=>page.keyboard.press('Shift+G'));
      await page.getByRole('button',{name:'Chiudi · Shift+G',exact:true}).click();
      await measure('lab-legacy', async()=>page.keyboard.press('Shift+E'));
    } else {
      await page.keyboard.press('Shift+G');
      await measure('overview', async()=>navigate('overview'));
      await measure('audio', async()=>navigate('audio'));
      await measure('audio-charts-visible', async()=>page.locator('.ws-debug').scrollIntoViewIfNeeded());
      await measure('diagnostics', async()=>navigate('diagnostics'));
      await measure('diagnostics-collapsed', async()=>page.getByTitle('Espandi / comprimi navigazione').click());
      await measure('REC', async()=>page.locator('.ws-top').getByRole('button',{name:'REC',exact:true}).click());
      await measure('laboratories', async()=>page.keyboard.press('Shift+E'));
      await measure('lab-override', async()=>{ await page.getByLabel('Override coherence').check(); await page.getByLabel('coherence',{exact:true}).fill('0.8'); });
      await measure('rapid-navigation', async()=>{}, async()=>{ for(let i=0;i<10;i++){await navigate('audio');await navigate('world');await navigate('diagnostics')} });
      await measure('closed-again', async()=>click('Chiudi'));
      await cdp.send('HeapProfiler.collectGarbage');
      const afterGC = await metrics();
      result.push({ name: 'closed-after-GC', heapMB: afterGC.JSHeapUsedSize/1048576, nodes: afterGC.Nodes, resources: await page.evaluate(() => window.__resources) });
    }
    await writeFile(output, JSON.stringify({ mode, url, viewport:page.viewportSize(), quality:'low', renderHost:'960x540 CSS px fixed across all cases', signal:'beat124', scene:'spectrum (Structural Lab in lab cases)', method:'2 s settling + 6 s per case; CDP CPU and heap, external RAF intervals; machine not isolated', result, errors }, null, 2));
  }
  console.log(`Saved ${output}`);
} finally { await browser.close(); }
