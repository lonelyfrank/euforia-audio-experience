/* global process, Buffer */
/** Deterministic GPU evidence through the product's decoder, experience, rig, layers and compositor.
 * No app route or live capture changes. See docs/visual-fidelity-audit.md for the limits of this replay.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.FIDELITY_OUTPUT || '/tmp/euforia-visual-fidelity';
const url = process.env.WORKSPACE_URL || 'http://127.0.0.1:1420';
const fps = Number(process.env.FIDELITY_FPS || 30);
const times = (process.env.FIDELITY_TIMES || '8,17,18.3,20,24').split(',').map(Number);
const signal = process.env.FIDELITY_SIGNAL || 'buildDrop';
const legacySeed = process.env.FIDELITY_LEGACY_SEED ? Number(process.env.FIDELITY_LEGACY_SEED) : null;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH,
  args: ['--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const report = { head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), signal, fps, times, legacySeed, viewport: [1280, 720], reflection: process.env.FIDELITY_REFLECTION === '1', solids: process.env.FIDELITY_SOLIDS === '1', date: new Date().toISOString(), runs: [], errors };
try {
  // A test-only document; production modules are imported from the development server.
  await page.route('**/__visual_fidelity', route => route.fulfill({ contentType: 'text/html', body: '<style>html,body{margin:0;background:#000}#stage{width:1280px;height:720px}</style><div id="stage"></div>' }));
  await page.goto(`${url}/__visual_fidelity`);
  await page.evaluate(async ({ signal, seconds }) => {
    const { TEST_SIGNALS } = await import('/src/audio/capture/testSignals.ts');
    if (!TEST_SIGNALS.some(s => s.id === signal)) throw new Error(`Unknown test signal: ${signal}`);
    // Analyse in a worker, once. Keep every wire record in order, including the scene records. No PCM on main.
    const code = `
      const nativeFetch = self.fetch.bind(self);
      self.fetch = (path, options) => nativeFetch(typeof path === 'string' ? new URL(path, '${location.origin}') : path, options);
      const { WasmAnalysis } = await import('${location.origin}/src/audio/features/WasmAnalysis.ts');
      const { SignalGenerator } = await import('${location.origin}/src/audio/capture/testSignals.ts');
      const chunks = []; let part;
      const wasm = await WasmAnalysis.create(48000, 2, { decode(data, length) { part = data.slice(0, length); } });
      wasm.setScene(1, 0.55);
      const generator = new SignalGenerator('${signal}', 48000), pcm = new Float32Array(960);
      for (let k = 0; k < ${Math.ceil(seconds * 100)}; k++) { generator.fillStereo(pcm, 480); wasm.push(pcm); chunks.push(part); }
      wasm.dispose(); postMessage(chunks, chunks.map(c => c.buffer));
    `;
    const objectURL = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    const worker = new Worker(objectURL, { type: 'module' });
    try { window.__tape = await new Promise((resolve, reject) => { worker.onmessage = e => resolve(e.data); worker.onerror = e => reject(new Error(e.message)); }); }
    finally { worker.terminate(); URL.revokeObjectURL(objectURL); }
    const paths = ['renderer/RenderEngine', 'app/RigController', 'audio/analysis/AudioAnalyzer', 'audio/features/decode', 'audio/features/SceneFeed', 'audio/visual-response/VisualResponse', 'experience/ExperienceEngine', 'stores/settingsStore', 'visualizers/registry', 'visualizers/palettes'];
    window.__modules = Object.assign({}, ...await Promise.all(paths.map(p => import(`/src/${p}.ts`))), await import('/node_modules/.vite/deps/three.js'));
    // RenderEngine.tick itself is used. The harness supplies its RAF timestamps and does not start a second loop.
    window.requestAnimationFrame = () => 1;
    window.cancelAnimationFrame = () => {};
    window.__mount = async (id, quality, fps, reflection, solids, legacySeed) => {
      window.__run?.render.dispose();
      const m = window.__modules, decoder = new m.AnalysisDecoder(), experience = new m.ExperienceEngine(), feed = new m.SceneFeed();
      decoder.onFrame = a => experience.ingest(a); decoder.onOnset = o => experience.onset(o);
      decoder.onBeat = b => experience.beat(b); decoder.onSection = s => experience.section(s); decoder.onScene = (data, at) => feed.push(data, at);
      const audio = new m.AudioAnalyzer().frame, interpreter = new m.VisualResponse();
      const settings = { ...m.DEFAULT_SETTINGS, scene: id, quality, direction: 'manual', rigMode: 'preset', reflection };
      const host = { features: decoder, experience, session: 1, timing: { heardTime: 0, gridWeight: 1 }, clock: { ready: true } };
      const input = { audio, response: interpreter.frame };
      let batch = 0, frame = 0, rig;
      const costs = [], resources = [], events = [], cues = [], cursor = { time: -Infinity, seq: 0 };
      let cueSeq = 0;
      const render = new m.RenderEngine(document.querySelector('#stage'), dt => {
        const now = frame / fps;
        decoder.begin();
        while (batch < Math.floor(now * 100 + 1e-7) && batch < window.__tape.length) { const data = window.__tape[batch++]; decoder.decode(data, data.length); }
        host.timing.heardTime = now - 0.1;
        feed.read(audio, 4800, true); audio.time = host.timing.heardTime;
        interpreter.update(audio, dt); rig.update(dt);
        experience.events.forEachHeard(cursor, host.timing.heardTime, e => events.push({ type: e.type, time: e.audioTime, seen: host.timing.heardTime }));
        const c = rig.rig.experience?.cues;
        if (c) { for (let seq = Math.max(cueSeq + 1, c.seq - c.cues.length + 1); seq <= c.seq; seq++) { const v = c.cues[seq % c.cues.length]; if (v.seq === seq) cues.push({ ...v, seen: host.timing.heardTime }); } cueSeq = c.seq; }
        return input;
      });
      render.setQuality(quality); render.setReflection(reflection);
      render.setPalette(m.paletteColors(m.findPalette('nebula'), [new m.Color(), new m.Color(), new m.Color()]));
      rig = new m.RigController(host, render, () => settings); input.rig = rig.rig;
      const before = performance.now(), random = Math.random;
      // Galaxy predates seeded scenes. Scope this optional control to test-only construction; preserve product code.
      if (id === 'galaxy' && legacySeed !== null) {
        const { Rng } = await import('/src/show/rng.ts');
        const rng = new Rng(legacySeed); Math.random = () => rng.next();
      }
      try { rig.showScene(id); } finally { Math.random = random; }
      while (!render.current.ready) await new Promise(resolve => setTimeout(resolve, 10));
      if (solids) {
        const { solidSlot } = await import('/src/visual-engine/primitives/solidSlot.ts');
        if (!render.current.visualizer.world) throw new Error('Experimental solids need a recipe');
        render.current.visualizer.world.add(solidSlot());
      }
      const mountMs = performance.now() - before;
      const renderer = render.renderer, gl = renderer.getContext(), info = gl.getExtension('WEBGL_debug_renderer_info');
      renderer.info.autoReset = false;
      window.__run = { render, rig, costs, resources, events, cues, mountMs, id, quality, fps, reflection,
        gpu: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        next(until, capture = false) {
          while (frame < Math.round(until * fps)) {
            frame++; renderer.info.reset(); const start = performance.now(); render.tick(frame * 1000 / fps);
            costs.push(performance.now() - start);
            if (frame % fps === 0) resources.push({ time: frame / fps, ...renderer.info.render, ...renderer.info.memory, programs: renderer.info.programs.length });
          }
          if (capture) this.png = renderer.domElement.toDataURL('image/png').split(',')[1];
        },
        snapshot() {
          const v = render.current.visualizer, w = v.world, camera = v.camera, exp = rig.rig.experience;
          return { time: frame / fps, heard: host.timing.heardTime, seed: render.current.source.preset.visual.seed ?? null,
            resolution: [renderer.domElement.width, renderer.domElement.height], debug: v.debug,
            camera: { position: camera.position.toArray(), quaternion: camera.quaternion.toArray(), fov: camera.fov },
            world: exp?.world, cues: exp?.cues.stats, geometry: w?.frame.geometry, look: w?.frame.look,
            primitives: w?.mounted.map(p => ({ id: p.slot.id, presence: p.presence.value, debug: p.primitive.debug })),
            info: { ...renderer.info.render, ...renderer.info.memory, programs: renderer.info.programs.length } };
        }
      };
      return { mountMs, gpu: window.__run.gpu };
    };
  }, { signal, seconds: Math.max(...times) + 1 });
  const scenes = process.env.FIDELITY_SCENES?.split(',') || await page.evaluate(() => window.__modules.visualizers.map(v => v.id));
  const qualities = (process.env.FIDELITY_QUALITIES || 'low,medium,high').split(',');
  for (const quality of qualities) for (const id of scenes) {
    const meta = await page.evaluate(args => window.__mount(...args), [id, quality, fps, report.reflection, report.solids, legacySeed]);
    const run = { id, quality, ...meta, frames: [] };
    let reached = 0;
    for (const at of times) {
      while (reached < at) { reached = Math.min(at, reached + 0.5); await page.evaluate(([t, capture]) => window.__run.next(t, capture), [reached, reached === at]); }
      const frame = await page.evaluate(() => window.__run.snapshot());
      if (![...frame.camera.position, ...frame.camera.quaternion, ...(frame.camera.fov === undefined ? [] : [frame.camera.fov]),
        frame.world?.speed, frame.world?.energy].every(Number.isFinite)) throw new Error(`Non-finite camera/world: ${id}/${quality}/${at}`);
      const name = `${id}-${quality}-${at.toFixed(2)}.png`;
      // Capture the framebuffer immediately; screenshots do not advance the musical clock.
      const png = await page.evaluate(() => window.__run.png);
      await writeFile(`${output}/${name}`, Buffer.from(png, 'base64'));
      run.frames.push({ ...frame, image: name });
    }
    Object.assign(run, await page.evaluate(() => ({ costs: window.__run.costs, resources: window.__run.resources, events: window.__run.events, cues: window.__run.cues })));
    report.runs.push(run);
    await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
    console.log(id, quality, 'captured', run.frames.length, 'frames;', meta.gpu);
  }
  if (process.env.FIDELITY_PARITY === '1') {
    report.parity = await page.evaluate(async () => {
      const renderer = window.__run.render.renderer, results = {};
      for (const [path, fn] of [['visual-engine/primitives/terrainParity', 'runTerrainParity'], ['visual-engine/primitives/forestParity', 'runForestParity'], ['visual-engine/primitives/oceanParity', 'runOceanParity']]) results[fn] = (await import(`/src/${path}.ts`))[fn](renderer);
      results.runParity = (await import('/src/render-systems/particles/parity.ts')).runParity(1024, 240, true, renderer);
      results.runTracerParity = (await import('/src/render-systems/particles/tracerParity.ts')).runTracerParity(1024, 120, true, renderer);
      return results;
    });
    if (Object.values(report.parity).some(r => r.outcome !== 'pass')) throw new Error('GPU parity failed; see report.parity');
  }
  if (errors.length) throw new Error(errors.join('\n'));
} finally { await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2)); await browser.close(); }
