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
const DASHBOARD = 'aside[aria-label="Euforia Engine Diagnostics"]';
/** The three columns as laid out now, and what the renderer and the inspector's chart did about it. */
const station = () => page.evaluate(() => {
  const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
  const body = document.querySelector('.ws-inspector-body'), chart = document.querySelector('.ws-debug canvas'), shell = document.querySelector('.euforia-workspace');
  const audio = document.querySelector('.ws-audio'), deck = document.querySelector('.ws-deck');
  return { nav: box('.ws-sidebar'), view: box('.ws-preview'), inspector: box('.ws-inspector'), body: box('.ws-inspector-body'),
    deck: deck && deck.getBoundingClientRect().height,
    // Audio & Analysis is panels, not a canvas: where they start, how many, whether the spectrum is drawn and how the level lists are laid out.
    audio: audio && !audio.hidden && { top: audio.getBoundingClientRect().top, panels: audio.children.length, spectrum: audio.querySelector('.ws-bars path').getAttribute('d')?.length ?? 0,
      meters: getComputedStyle(audio.querySelector('.ws-meters')).gridTemplateColumns.split(' ').length },
    center: [...document.querySelector('.ws-center').children].map(el => el.className), layout: { ...shell.dataset },
    position: getComputedStyle(document.querySelector('.ws-inspector')).position,
    overflow: [document.documentElement.scrollWidth - innerWidth, shell.scrollWidth - shell.clientWidth, body.scrollWidth - body.clientWidth],
    scrollable: body.scrollHeight - body.clientHeight, scrollTop: body.scrollTop,
    chart: chart && { css: chart.clientWidth, pixels: chart.width, height: chart.clientHeight, top: chart.getBoundingClientRect().top },
    canvas: [window.__originalCanvas.clientWidth, window.__originalCanvas.clientHeight], inner: [innerWidth, innerHeight], dpr: Math.min(devicePixelRatio, 2), resizes: window.__resizes };
});
const settle = () => page.waitForTimeout(350);
/** Which sections of the inspector are on screen, by one witness node each; a section this build does not have is absent. */
const WITNESS = { health: '.ws-metrics .ws-spark', overview: ':scope > .ws-section > .ws-section-body > .ws-metrics-text', audio: '.ws-audio .ws-bars', charts: '.ws-debug canvas', experiment: '[aria-label="Forma Matter"]', laboratory: '.ws-lab-grid',
  acquisition: '>nav', plot: '>canvas', registry: '>.labels', isolation: '>.experimental', replay: '>[aria-label="Scenario replay"]', reports: '>[aria-label="Carica report baseline JSON"]', timeline: '>footer' };
const sections = () => page.evaluate(([witness, dashboard]) => {
  const body = document.querySelector('.ws-inspector-body'), shadow = body.querySelector(dashboard).shadowRoot;
  return Object.entries(witness).filter(([, selector]) => (selector[0] === '>' ? shadow.querySelector(selector.slice(1)) : body.querySelector(selector))?.getClientRects().length).map(([id]) => id).sort();
}, [WITNESS, DASHBOARD]);
/** What the typed map says the view holds, of the sections that exist in the page (a laboratory's inspector only while one runs). */
const expected = (view, lab) => page.evaluate(async ([view, lab]) => (await import('/src/diagnostics/workspace/sections.ts')).VIEW_SECTIONS[view].filter(id => id !== 'laboratory' || lab).sort(), [view, lab]);
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
    await page.evaluate(() => {
      window.__initialScene = window.app.directionDebug.current;
      // Test-only counter on the one renderer: how many times the workspace made it size its targets.
      // RenderEngine.resize sets the pixel ratio once per resize (three then calls setSize itself, so setSize would count twice).
      const renderer = window.app.directionDebug.renderer, setPixelRatio = renderer.setPixelRatio.bind(renderer);
      window.__resizes = 0; renderer.setPixelRatio = (...args) => { window.__resizes++; return setPixelRatio(...args); };
      window.__session = window.app.audio.session; window.__worldTime = window.app.audio.experience.presented.world.time;
    });
    await page.keyboard.press('Shift+D');
    await page.locator('.euforia-workspace').waitFor();
    assert.equal(await page.locator('h1').first().textContent(), 'Audio & Analysis');
    // Shift+D is the Audio & Analysis station: navigation, the live scene, the analytics beside it, with no further click or scroll.
    await settle();
    const open = await station();
    assert.ok(open.nav.right <= open.view.x && open.view.right <= open.inspector.x, 'navigation · viewport · inspector, left to right');
    assert.ok(open.inspector.w >= 430 && open.inspector.w <= 470, `inspector ${open.inspector.w} px`);
    assert.ok(open.nav.w >= 205 && open.nav.w <= 262, `navigation ${open.nav.w} px`);
    assert.ok(open.view.w > open.inspector.w && open.view.w > open.nav.w, 'the viewport is the widest column');
    assert.ok(open.view.h >= (open.inner[1] - 50) * 0.7, `the viewport takes the height the heading and the deck leave (${open.view.h} of ${open.inner[1]})`);
    assert.deepEqual(open.center, ['ws-heading', 'ws-preview', 'ws-deck'], 'under the viewport, only the capture deck');
    assert.equal(open.deck, 150, 'the deck has one height');
    assert.ok(Math.abs(open.canvas[0] - (open.view.w - 2)) <= 1 && Math.abs(open.canvas[1] - (open.view.h - 2)) <= 1, 'the one canvas fills the viewport');
    assert.equal(await page.evaluate(selector => ['.ws-audio .ws-bars', selector].every(s => document.querySelector(`.ws-inspector-body ${s}`)) && !!window.__originalCanvas.closest('.ws-preview'), DASHBOARD), true, 'audio panels and registry live in the inspector');
    // Shift+D is the audio station and nothing else: no rendering tiles, experiment controls, isolation, acquisition controls, replay or reports.
    assert.deepEqual(await sections(), ['audio', 'registry'], 'Audio & Analysis holds the audio panels and the audio registry only');
    assert.ok(open.audio.top < open.body.bottom - 200 && open.audio.panels >= 10, 'the audio panels are in view at once');
    assert.ok(open.audio.spectrum > 100 && open.audio.meters === 1, 'the spectrum is drawn from the live frame; level lists in one column');
    assert.equal(await page.evaluate(() => document.querySelector('.ws-deck .ws-wave polyline').getAttribute('points').length > 100 && document.querySelector('.ws-deck .ws-device strong').textContent), 'Beat 124 BPM', 'the deck shows the signal and its device');
    assert.deepEqual(await page.evaluate(() => [document.querySelectorAll('.ws-source').length, document.querySelector('.ws-pills').textContent.includes('Test signal')]), [0, true], 'the source in use is named once, in the toolbar');
    assert.equal(await page.getByRole('button', { name: 'REC', exact: true }).count() + await page.locator(DASHBOARD).evaluate(el => [...el.shadowRoot.querySelectorAll('button')].filter(b => b.textContent === 'REC').length), 1, 'one REC control');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.euforia-workspace')).fontFamily.includes('Geist') && document.fonts.check('12px "Geist Variable"')), true, 'the cockpit is set in Geist');
    assert.ok(open.scrollable > 0, 'the inspector scrolls by itself');
    assert.deepEqual(open.overflow, [0, 0, 0], 'no horizontal overflow');
    assert.equal(open.resizes, 1, 'entering the viewport sizes the renderer once');
    // Folding the inspector away keeps everything it holds: the same nodes, the same scroll, the same width when it returns.
    await page.evaluate(() => { window.__audio = document.querySelector('.ws-audio .ws-bars'); document.querySelector('.ws-inspector-body').scrollTop = 140; });
    await click('Inspector'); await settle();
    const folded = await station();
    assert.equal(folded.inspector.w, 0); assert.ok(folded.view.w > open.view.w + 300, 'the viewport takes the inspector column');
    assert.equal(folded.resizes, 2);
    await page.locator('.ws-top').getByRole('button', { name: 'Inspector', exact: true }).click(); await settle();
    const back = await station();
    assert.equal(back.inspector.w, open.inspector.w); assert.equal(back.scrollTop, 140, 'scroll kept while hidden');
    assert.equal(await page.evaluate(() => document.querySelector('.ws-audio .ws-bars') === window.__audio), true, 'audio panels reused');
    // A wide inspector lays the same panels out in two columns; the viewport alone hides both side columns and the deck.
    await page.getByTitle('Allarga / riduci inspector · tabelle e report').click(); await settle();
    const wide = await station();
    assert.ok(wide.inspector.w >= 560 && wide.audio.meters === 2, `wide inspector ${wide.inspector.w} px, level lists in ${wide.audio.meters} columns`);
    assert.deepEqual(wide.overflow, [0, 0, 0]);
    await page.getByTitle('Allarga / riduci inspector · tabelle e report').click(); await settle();
    await page.getByTitle('Solo il viewport / le tre colonne').click(); await settle();
    const alone = await station();
    assert.ok(alone.nav.w === 0 && alone.inspector.w === 0 && alone.view.w >= alone.inner[0] - 30, 'viewport alone');
    await page.getByTitle('Solo il viewport / le tre colonne').click(); await settle();
    assert.equal((await station()).resizes, 7, 'one renderer resize per layout step, none in between');
    // The shortcut always brings the station back whole, even if the inspector was folded when the workspace was closed.
    await click('Inspector'); await page.keyboard.press('Escape');
    assert.equal(await page.locator('.euforia-workspace').count(), 0);
    await page.keyboard.press('Shift+D'); await settle();
    assert.equal((await station()).inspector.w, open.inspector.w, 'Shift+D reopens with the inspector');
    await page.keyboard.press('Shift+G');
    assert.equal(await page.locator('.euforia-workspace').count(), 1);
    await page.locator('.ws-top').getByRole('button', { name: 'REC', exact: true }).click();
    await page.waitForTimeout(700);
    const first = await report();
    await navigate('audio');
    await page.locator(DASHBOARD).evaluate(el => { window.__audioMetricRow = el.shadowRoot.querySelector('.row'); window.__audio = document.querySelector('.ws-audio .ws-bars'); });
    // The panels follow the live frame: the spectrum drawn now is not the one drawn a second ago.
    const spectrum = () => page.evaluate(() => document.querySelector('.ws-audio .ws-bars path').getAttribute('d'));
    const drawn = await spectrum(); await page.waitForTimeout(1200);
    assert.notEqual(await spectrum(), drawn, 'audio panels are live');
    const steady = (await station()).resizes;
    for (const view of ['experience', 'world', 'matter']) {
      await navigate(view); await settle();
      const shown = await station();
      assert.ok(shown.chart.height > 100 && shown.chart.pixels === Math.round(shown.chart.css * shown.dpr), `${view} charts drawn in the inspector`);
      assert.deepEqual(shown.overflow, [0, 0, 0]);
      assert.equal(shown.audio, false, 'the audio panels step out of the other views');
      assert.deepEqual(await sections(), await expected(view), `${view} holds its own sections`);
      if (view === 'experience') await page.evaluate(() => { window.__chart = document.querySelector('.ws-debug canvas'); });
    }
    for (const view of ['render', 'overview']) { await navigate(view); assert.deepEqual(await sections(), await expected(view), `${view} holds its own sections`); }
    await navigate('audio');
    assert.equal(await page.locator(DASHBOARD).evaluate(el => el.shadowRoot.querySelector('.row') === window.__audioMetricRow && document.querySelector('.ws-debug canvas') === window.__chart && document.querySelector('.ws-audio .ws-bars') === window.__audio), true, 'metric DOM, chart canvas and audio panels reused on domain return');
    assert.equal((await station()).resizes, steady, 'changing section never resizes the renderer');
    await navigate('diagnostics');
    assert.deepEqual(await sections(), await expected('diagnostics'), 'registry, acquisition, isolation, replay, reports and timeline are all in Diagnostics & Reports');
    const second = await report();
    assert.equal(await page.evaluate(() => window.app.directionDebug.current === window.__initialScene), true, 'navigation preserves the scene instance');
    assert.ok(second.samples.length >= first.samples.length, 'REC survives navigation');
    assert.equal(await page.evaluate(() => window.app.directionDebug.renderer === window.__originalRenderer && window.app.directionDebug.renderer.domElement === window.__originalCanvas), true);
    await click('Freeze vista');
    const before = await page.locator(DASHBOARD).evaluate(el => el.shadowRoot.querySelector('.row .value')?.textContent);
    await page.waitForTimeout(500);
    assert.equal(await page.locator(DASHBOARD).evaluate(el => el.shadowRoot.querySelector('.row .value')?.textContent), before);
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
    const lab = await station();
    assert.deepEqual(lab.overflow, [0, 0, 0], 'the laboratory fits the inspector');
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.ws-inspector-body .engine')].length), 3, 'cockpit blocks live in the inspector');
    assert.deepEqual(await sections(), await expected('laboratories', true), 'Laboratories holds the experiment, the laboratory and isolation');
    // Switch View is not Stop Experiment: the laboratory, its override and its pinned world stay while another section is read...
    const labState = () => page.evaluate(async () => { const { structuralLab } = await import('/src/visual-engine/primitives/WirePolygonPrimitive.ts'); return [structuralLab.active, structuralLab.tuning.coherence, window.app.pinnedScene, window.app.audio.session === window.__session]; });
    await page.evaluate(() => { window.__lab = document.querySelector('.ws-lab-grid'); window.__labScene = window.app.directionDebug.current; });
    const running = await labState();
    assert.deepEqual([running[0], running[1], running[3]], [true, 0.8, true]); assert.ok(running[2], 'the laboratory pins its world');
    for (const view of ['world', 'audio', 'diagnostics']) { await navigate(view); assert.deepEqual(await labState(), running, `the laboratory survives ${view}`); }
    assert.deepEqual(await sections(), await expected('diagnostics'), 'a running laboratory adds nothing to the other views');
    // ...and the sidebar enters the laboratory already running, as Shift+E would: the same inspector, nothing built again.
    await navigate('laboratories');
    assert.deepEqual(await labState(), running);
    assert.equal(await page.evaluate(() => document.querySelector('.ws-lab-grid') === window.__lab && document.querySelectorAll('.ws-lab-grid').length === 1 && window.app.directionDebug.current === window.__labScene), true, 'the running laboratory is reused, not started again');
    // Escape over overrides in force asks once, without stopping anything; Escape again (or the other button) stays.
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.ws-confirm').count(), 1); assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Chiudi e ripristina');
    await page.keyboard.press('Escape');
    assert.deepEqual([await page.locator('.ws-confirm').count(), await page.locator('.euforia-workspace').count()], [0, 1], 'Escape closes the question first');
    await page.keyboard.press('Escape'); await click('Resta nel workspace');
    assert.deepEqual([await page.locator('.ws-confirm').count(), ...await labState()], [0, ...running], 'staying keeps the experiment as it was');
    await navigate('world');
    assert.equal(await page.getByRole('button', { name: 'Termina esperimento', exact: true }).count(), 0, 'one control ends the experiment');
    await click('Termina Structural Lab');
    assert.deepEqual(await page.evaluate(async () => { const { structuralLab } = await import('/src/visual-engine/primitives/WirePolygonPrimitive.ts'); return [structuralLab.active, structuralLab.tuning.coherence, window.app.pinnedScene]; }), [false, null, null]);
    // The sidebar and Shift+E are one path: entering Laboratories with none running opens the laboratory asked for.
    await navigate('laboratories'); await page.locator('.ws-lab-grid').waitFor();
    assert.deepEqual((await labState()).slice(0, 2), [true, null], 'the sidebar opens the laboratory, with no override left from the last one');
    await page.getByLabel('Forma Matter').selectOption('wave');
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
      const sized = await station();
      assert.deepEqual(sized.overflow, [0, 0, 0], `no overflow at ${size.width}`);
      assert.ok(sized.view.w >= 480 && sized.view.w > sized.inspector.w, `viewport ${sized.view.w} px at ${size.width}`);
    }
    // A narrow window: the inspector lies over the viewport and folds away, the renderer is never squeezed by it.
    await page.setViewportSize({ width: 800, height: 700 }); await settle();
    const narrow = await station();
    assert.equal(narrow.position, 'absolute'); assert.ok(narrow.view.w >= 800 - 52 - 30, `narrow viewport ${narrow.view.w} px`);
    assert.deepEqual(narrow.overflow, [0, 0, 0]);
    await click('Inspector'); await settle();
    const uncovered = await station();
    assert.equal(uncovered.inspector.w, 0); assert.equal(uncovered.view.w, narrow.view.w); assert.equal(uncovered.resizes, narrow.resizes, 'folding the overlay does not resize the renderer');
    await click('Inspector');
    await page.setViewportSize({ width: 1400, height: 900 }); await settle();
    await page.getByTitle('Espandi / comprimi navigazione').click();
    assert.equal(await page.locator('.euforia-workspace').getAttribute('data-collapsed'), 'true');
    await page.screenshot({ path: output.replace('.json', '.png') });
    await page.keyboard.press('Shift+G');
    assert.equal(await page.locator('.euforia-workspace').count(), 0);
    assert.deepEqual(await page.evaluate(async () => { const { matterLab } = await import('/src/render-systems/forms/MatterForms.ts'); const { worldLab } = await import('/src/visual-engine/VisualWorld.ts'); return [matterLab.form, worldLab.only, window.app.directionDebug.diagnostics, window.__originalCanvas.closest('.app-stage').parentElement.id]; }), ['auto', null, null, 'app']);
    assert.deepEqual((await labState()).slice(0, 3), [false, null, null], 'closing the workspace ends the laboratory and gives the pin back');
    // Structural → Solid → close: each laboratory gives back what it took, and Escape + Enter is the confirmed way out.
    await page.keyboard.press('Shift+E'); await page.locator('.ws-lab-grid').waitFor();
    await click('Avvia Solid Dynamics'); await page.locator('.ws-solid').waitFor();
    const solidState = () => page.evaluate(async () => { const { solidLab } = await import('/src/visual-engine/structural/SolidTypes.ts'); const { structuralLab } = await import('/src/visual-engine/primitives/WirePolygonPrimitive.ts');
      return [structuralLab.active, solidLab.active, solidLab.tuning.coherence, window.app.audio.experience.calibration.enabled, document.querySelectorAll('.ws-lab-grid').length]; });
    assert.deepEqual(await solidState(), [false, true, null, true, 1], 'one laboratory at a time, the first one left clean');
    await page.getByLabel('Override Environment coherence').check();
    assert.equal(await page.locator('.ws-top').getByRole('button', { name: 'Termina Solid Dynamics', exact: true }).count(), 1, 'the toolbar names the laboratory it ends');
    await page.getByLabel('Override Environment coherence').evaluate(el => el.blur());
    await page.keyboard.press('Escape'); await page.locator('.ws-confirm').waitFor(); await page.keyboard.press('Enter');
    assert.equal(await page.locator('.euforia-workspace').count(), 0, 'Escape, then Enter, closes over an experiment');
    assert.deepEqual([...(await solidState()).slice(0, 4), await page.evaluate(() => window.app.pinnedScene)], [false, false, null, true, null], 'no laboratory state left after closing');
    await page.waitForTimeout(1500);
    const memory = () => page.evaluate(() => { const r = window.app.directionDebug.renderer; return { ...r.info.memory, programs: r.info.programs.length, lost: r.getContext().isContextLost() }; });
    const gpu = await memory();
    // The laboratory above pinned another world and gave the scene back: from here on the layer must stay the same object.
    await page.evaluate(() => { window.__cycleScene = window.app.directionDebug.current; });
    for (let i = 0; i < 6; i++) { await page.keyboard.press('Shift+D'); await page.keyboard.press('Shift+G'); await page.keyboard.press('Shift+G'); }
    await page.waitForTimeout(500);
    assert.deepEqual(await memory(), gpu, 'no GPU resource left behind by opening and closing');
    assert.equal(gpu.lost, false);
    assert.deepEqual(await page.evaluate(() => [window.app.audio.session === window.__session, window.app.audio.experience.presented.world.time > window.__worldTime, window.app.directionDebug.current === window.__cycleScene,
      window.__originalCanvas.clientWidth === innerWidth && window.__originalCanvas.clientHeight === innerHeight]), [true, true, true, true], 'audio session, world, scene and full-window stage survive the workspace');
    assert.equal(await page.locator('.euforia-workspace').count(), 0);
    assert.equal(await page.locator('.app-canvas canvas').count(), 1);
    assert.equal(await page.evaluate(() => window.__webglCreations), 1);
    assert.deepEqual(await page.evaluate(() => ({ ...window.__resources })), resources, 'observers and intervals restored after close');
    assert.deepEqual(errors, []);
    await writeFile(output, JSON.stringify({ result: 'pass', checks: ['shortcuts', 'single canvas and renderer', 'REC continuity', 'freeze', 'pause', 'baseline import', 'compare', 'JSON CSV MD export', 'shadow input guard', 'lab lifecycle', 'override reset', 'pin restore', 'replay continuity', 'resize', 'collapse', 'repeated close/reopen',
      'three-column station on Shift+D', 'viewport over the capture deck', 'inspector holds tiles/audio panels/registry', 'cockpit tokens and Geist', 'audio panels live and reused', 'inspector fold/wide/viewport-alone keep state', 'one renderer resize per layout step',
      'narrow overlay', 'GPU resources and session unchanged after close'], errors }, null, 2));
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
      await measure('audio-charts-visible', async()=>page.locator('.ws-audio .ws-meters').first().scrollIntoViewIfNeeded());
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
