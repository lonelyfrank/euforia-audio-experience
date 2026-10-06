import { expect, it } from 'vitest';
import { WasmAnalysis } from '../audio/features/WasmAnalysis';
import { SignalGenerator } from '../audio/capture/testSignals';
import { ExperienceEngine } from '../experience/ExperienceEngine';
import { ShowDirector } from '../show/ShowDirector';
import { Dynamics } from '../dynamics/Dynamics';
import type { ShowInput, ShowSink, SlotParam } from '../show/types';

const SR = 48000;
const percentile = (a: number[], q: number) => [...a].sort((x,y)=>x-y)[Math.floor((a.length-1)*q)];
const summary = (a: number[]) => [0.5,0.95,0.99].map(q=>percentile(a,q).toFixed(3)).join('/');

it('PCM → acoustic → experience → planner → physics → world → show is invariant to render and audio batching', { timeout: 120000 }, async () => {
  const seconds = 24;
  const pcm = new Float32Array(seconds * SR * 2);
  new SignalGenerator('buildDrop', SR).fillStereo(pcm, seconds * SR);
  let reference: number[] | undefined;
  for (const [fps,batch] of [[30,128],[60,480],[144,2048]] as const) {
    const wasm = await WasmAnalysis.create(SR,2);
    const e = new ExperienceEngine();
    const show = new ShowDirector(), dynamics = new Dynamics();
    const names: SlotParam[] = ['intensity','dim','size','offset','strobe','tint'];
    const channels = Array.from({length:3},(_,s)=>Object.fromEntries(names.map(n=>[n,dynamics.channel(`${s}.${n}`,n==='strobe'?'flash':'glide')])));
    const sink: ShowSink = {
      target: (s,n,v,t)=>dynamics.setTarget(channels[s][n],v,t),
      impulse: (s,n,v,t)=>dynamics.impulse(channels[s][n],v,t),
      snap: t=>dynamics.snap(t,0.5),
    };
    const input: ShowInput = { time:0,presence:0,section:0,sectionId:0,barIndex:0,phraseBar:0,phraseBars:8,
      nextPhraseTime:0,beatBpm:0,nextBeatTime:0,barPhase:0,dropExpected:0,structureConfidence:0,key:-1,gridWeight:0 };
    const settings = {mode:'free' as const,scene:'galaxy'};
    const acousticTimes: number[] = [], experienceTimes: number[] = [], showTimes: number[] = [];
    let experienceWork = 0, captured = 0;
    wasm.decoder.onFrame = a => { const start=performance.now(); e.ingest(a); const cost=performance.now()-start; experienceWork+=cost; experienceTimes.push(cost); };
    const shared: number[] = [];
    for (let f=1;f<=seconds*fps;f++) {
      const t=f/fps;
      wasm.decoder.begin();
      while(captured+batch <= Math.floor(t*SR+1e-6)) {
        const chunk=pcm.subarray(captured*2,(captured+batch)*2);
        experienceWork=0; const start=performance.now(); wasm.push(chunk);
        acousticTimes.push(Math.max(0,performance.now()-start-experienceWork)); captured+=batch;
      }
      const snapshot=e.present(t-0.1);
      if (!snapshot) continue;
      const a=snapshot.acoustic;
      Object.assign(input,{time:t-0.1,presence:a.presence,section:a.section,sectionId:a.sectionId,barIndex:a.barIndex,
        phraseBar:a.phraseBar,phraseBars:a.phraseBars,nextPhraseTime:a.nextPhraseTime,beatBpm:a.beatBpm,
        nextBeatTime:a.nextBeatTime,barPhase:a.barPhase,dropExpected:a.dropExpected,structureConfidence:a.structureConfidence,
        key:a.key,gridWeight:a.beatConfidence,meter:a.meter,meterConfidence:a.meterConfidence,experience:snapshot});
      const start=performance.now();show.update(input,settings,sink);dynamics.advance(t-0.1);showTimes.push(performance.now()-start);
      if (Math.abs(t*6-Math.round(t*6))<1e-8 && t>2) {
        const s=snapshot.state;
        const w=snapshot.world;
        shared.push(s.time,s.energy,s.complexity,s.anticipation,s.releasePotential,s.eventId,snapshot.physics.energy,...snapshot.physics.modes,
          w.radius,w.angle,w.travel,w.bias,w.excitation,w.turbulence,w.potential,w.energy);
      }
    }
    wasm.dispose();
    if (!reference) reference=shared;
    else { expect(shared.length).toBe(reference.length); for(let i=0;i<shared.length;i++) expect(shared[i]).toBeCloseTo(reference[i],8); }
    console.log(`experience @${fps}fps / ${batch} frames: p50/p95/p99 ms WASM+decode per batch ${summary(acousticTimes)}; experience+planner+physics per hop ${summary(experienceTimes)}; show+dynamics per render ${summary(showTimes)}; events ${e.state.eventId}`);
    expect(e.state.time).toBeGreaterThan(seconds-0.05);
    expect(e.state.eventId).toBeGreaterThan(3);
    expect(e.state.complexity).toBeGreaterThan(0.1);
  }
});

it('browser analysis path per sample rate: host pump, transfer, stage+decode, experience, planner', { timeout: 180000 }, async () => {
  const { AnalysisHost } = await import('../audio/features/AnalysisHost');
  const { AnalysisDecoder } = await import('../audio/features/decode');
  const { RecordStage } = await import('../audio/features/RecordStage');
  const { ClockSync } = await import('../timing/ClockSync');
  const seconds = 12;
  for (const rate of [44100, 48000, 96000]) {
    let now = 0;
    const stage = new RecordStage(1 << 20), decoder = new AnalysisDecoder(), clock = new ClockSync(), e = new ExperienceEngine();
    const pumps: number[] = [], transfers: number[] = [], decodes: number[] = [], hops: number[] = [], plans: number[] = [];
    const plan = e.planner.update.bind(e.planner);
    e.planner.update = (s, a, dt) => { const t0 = performance.now(); plan(s, a, dt); plans.push(performance.now() - t0); };
    decoder.onFrame = (a) => { const t0 = performance.now(); e.ingest(a); hops.push(performance.now() - t0); };
    let pending: { batch: Float64Array; length: number }[] = [];
    const host = await AnalysisHost.create({ sampleRate: rate, source: { kind: 'generator', signal: 'buildDrop' }, adaptive: false }, {
      records: (batch, length) => {
        // What postMessage does with a transferred buffer, on one thread.
        const t0 = performance.now();
        const moved = structuredClone(batch, { transfer: [batch.buffer] });
        transfers.push(performance.now() - t0);
        pending.push({ batch: moved, length });
      },
      pcm: (mono) => host.recycle(mono.buffer as ArrayBuffer),
    }, () => now);
    // The worklet wakes the worker every 512 frames; the renderer reads at 60 fps.
    const wake = 512 / rate;
    let nextFrame = 1 / 60;
    for (let t = wake; t <= seconds; t += wake) {
      now = t;
      const t0 = performance.now(); host.pump(); pumps.push(performance.now() - t0);
      if (t >= nextFrame) {
        nextFrame += 1 / 60;
        const t1 = performance.now();
        decoder.begin();
        for (const p of pending) { stage.stage(p.batch, p.length, t); host.recycle(p.batch.buffer as ArrayBuffer); }
        pending = [];
        const hopsBefore = hops.length;
        let experience = 0;
        stage.drain(decoder, clock, rate);
        for (let i = hopsBefore; i < hops.length; i++) experience += hops[i];
        decodes.push(performance.now() - t1 - experience);
      }
    }
    // What the last frame has not read yet.
    for (const p of pending) stage.stage(p.batch, p.length, now);
    stage.drain(decoder, clock, rate);
    const load = pumps.reduce((x, y) => x + y, 0) / 1000 / seconds;
    console.log(`browser path @${rate} Hz: p50/p95/p99 ms — host pump (WASM+framing) per 512-frame wake ${summary(pumps)} (DSP ${(load * 100).toFixed(1)}% of a core); ` +
      `transfer per batch ${summary(transfers)}; stage+decode per 60 fps frame ${summary(decodes)}; experience per hop ${summary(hops)}; planner per hop ${summary(plans)}`);
    expect(host.analysed).toBeGreaterThan((seconds - 0.02) * rate);
    expect(hops.length).toBe(Math.floor(host.analysed / 256));
    expect(load).toBeLessThan(0.5);
    host.dispose();
  }
});
