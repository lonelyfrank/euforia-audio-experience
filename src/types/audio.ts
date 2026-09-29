/**
 * Normalized snapshot of the audio signal, produced once per rendered frame by
 * the AudioAnalyzer and consumed read-only by visualizers.
 *
 * All scalar values are in the 0..1 range (already smoothed and auto-gained),
 * so visualizers can map them directly to visual parameters.
 *
 * The typed arrays are owned by the analyzer and reused between frames:
 * never keep a reference to them across frames and never mutate them.
 */
export interface AudioFrame {
  /** Seconds since the analyzer started. */
  time: number;
  sampleRate: number;
  /** True when the input is (almost) silent. */
  silent: boolean;

  /** Overall loudness (smoothed RMS, auto-gained). */
  volume: number;
  /** Instantaneous peak of the current window, 0..1 (not auto-gained). */
  peak: number;

  /** 20–250 Hz */
  bass: number;
  /** 250–500 Hz */
  lowMid: number;
  /** 500–2000 Hz */
  mid: number;
  /** 2–4 kHz */
  highMid: number;
  /** 4–16 kHz */
  treble: number;
  /** Total spectral energy across the audible range. */
  energy: number;

  /** Log-frequency spectrum (SPECTRUM_BINS values, 0..1, smoothed). */
  spectrum: Float32Array;
  /** Latest time-domain samples, -1..1 (gain applied, not smoothed). */
  waveform: Float32Array;

  /** True only on the frame where a beat was detected. */
  beat: boolean;
  /** Decaying pulse that jumps to 1 on each beat and falls back to 0. */
  beatPulse: number;
  /** Kick onset strength, 0..1: rise of the sub-120 Hz level over its running average (not full-band flux). */
  onset: number;
  /** Rough tempo estimate; 0 while unknown. */
  bpm: number;
  /** 0..1: how far the tempo can be trusted (0 for beatless music, pads, noise). */
  tempoConfidence: number;
  /** Position inside the current beat, 0..1 (0 = on the beat); 0 while no tempo is known. */
  beatPhase: number;

  /**
   * Transients per region (spectral flux above its own running level, 0..1,
   * instantaneous): 30–250 Hz (kick, bass attacks), 250 Hz–2 kHz (snare,
   * claps, plucks), 2–16 kHz (hi-hats, cymbals, consonants).
   */
  lowFlux: number;
  midFlux: number;
  highFlux: number;
  /** Spectral flatness 250 Hz–8 kHz, 0 = tonal (notes, voice) … 1 = noisy (noise, cymbals). Smoothed. */
  flatness: number;
  /** Absolute loudness (RMS, -60..0 dBFS → 0..1), not auto-gained: for comparing sections. Smoothed. */
  loudness: number;
  /**
   * Raw level (dB, not normalized, not smoothed) of the low (20–250 Hz, ~20 ms
   * window), mid (250 Hz–2 kHz) and high (2–16 kHz) regions: they follow fades
   * and cuts as they happen. SILENCE_DB when silent.
   */
  lowDb: number;
  midDb: number;
  highDb: number;

  /** The bass line (40–300 Hz): pitch and the real shape of one cycle. */
  bassVoice: VoiceFrame;
  /** The lead (180–1400 Hz fundamental): melody, vocals, lead synths. */
  leadVoice: VoiceFrame;
}

/**
 * One voice of the mix as a digital oscilloscope in averaging mode would show
 * it: its cycles stacked at its pitch, so the shape of the sound itself remains
 * (sawtooth, square, sine, clipped…). A voice band can pick up other
 * instruments when its own is absent: weight it by the region's presence.
 */
export interface VoiceFrame {
  /** Fundamental (Hz); 0 while the voice is unpitched or silent. */
  pitch: number;
  /** 0..1: how clearly periodic the voice is. */
  clarity: number;
  /** One cycle, SHAPE_SIZE samples in -1..1, aligned so its fundamental is a sine starting at 0. Smoothed. */
  shape: Float32Array;
}

/**
 * Musical roles derived from an AudioFrame by the VisualResponse layer, so
 * scenes can give each part of the music its own visual job instead of
 * pulsing everything with loudness. All values 0..1, frame-rate independent.
 *
 * - LOW  → `weight`: mass, scale, depth, slow pressure (never jitter).
 * - MID  → `flow`: form, curvature, twist, lateral motion.
 * - HIGH → `detail` (sustained) and `shimmer` (rising edges): fine detail, sparkle.
 * - TRANSIENT → `impact`: short events (shockwaves, brief glow), not continuous control.
 * - ENERGY → `density`: moderate global multiplier.
 *
 * Band levels in AudioFrame are each normalized to their own recent history,
 * so they say "this band is moving", not "this band is present". The `*Share`
 * values come from the (globally normalized) spectrum and say how much of the
 * mix sits in each region; the roles above are already weighted by them.
 */
export interface VisualResponseFrame {
  /**
   * Whether sound is really there (0..1), independent of its loudness: the
   * mix against a learned noise floor, with hysteresis, a fast attack and a
   * slow release. 0 in silence and over steady hiss or hum; every other role
   * (and the `*Audible` values) is gated by it, so a scene built on them
   * materializes with the sound and falls asleep without it.
   */
  presence: number;
  weight: number;
  flow: number;
  detail: number;
  shimmer: number;
  impact: number;
  density: number;
  /**
   * MESO (≈ 0.1–1 s): how much the music is moving — transients in any
   * region, averaged over about a second. A sustained pad reads ~0, a busy
   * groove high, even at the same loudness.
   */
  motion: number;
  /** MACRO (≈ 2–5 s): how full and wide the sound is — how much of the spectrum it covers (a tone ≈ 0.2, a full mix ≈ 1). */
  openness: number;
  /** MACRO: build-up or noisy intensity (risers, washes of noise in a loud part). */
  tension: number;
  /** Memory of the last impacts (≈ 1 s): jumps with `impact`, then fades like an afterimage. */
  trace: number;
  /** Coarse state of the music over seconds; changes are confirmed and never flicker. */
  state: MusicalState;
  /** Share of the spectrum in 30–250 Hz, 250 Hz–2 kHz, 2–16 kHz (sum ≈ 1, balanced mix ≈ 1/3 each). */
  lowShare: number;
  midShare: number;
  highShare: number;
  /**
   * How audible each region is right now compared with its recent level
   * (0..1): 1 through ordinary dynamics, falling as the region fades (at the
   * speed of the fade) and dropping at once on a hard cut, back to 1 on the
   * next attack. Short rhythmic gaps are held. Elements tied to a region
   * should vanish with it; `audible` is the loudest region (the whole scene).
   */
  lowAudible: number;
  midAudible: number;
  highAudible: number;
  audible: number;
  /** Slow musical context: tempo clock, song sections, character and per-song variation. */
  music: MusicContextFrame;
}

/**
 * What the song is doing over seconds rather than frames, so scenes can move
 * at the song's pace, evolve with its sections and look different from song
 * to song. Everything glides; nothing here jumps between frames.
 */
export interface MusicContextFrame {
  /** Tempo the motion follows (BPM): the detected tempo when trusted, else a pace from the music's activity. */
  tempo: number;
  /** 0..1: how locked the motion is to the detected tempo. */
  tempoLock: number;
  /**
   * Musical clock in beats: advances at `tempo` and, when locked, stays
   * aligned to the detected beats. Use it for cyclic motion (one swell per
   * bar = beats / 4) so it lands on the music.
   */
  beats: number;
  /** Motion speed multiplier from the tempo, 1 at 120 BPM (≈ 0.6–1.5). */
  pace: number;
  /** 0..1: loudness of the current section relative to the song's quiet and loud parts. */
  intensity: number;
  /** 0..1 while the intensity keeps rising (a build-up). */
  build: number;
  /** Pulse (1 → 0 over ~2 s) when a loud section lands after a quiet or rising one. */
  drop: number;
  /** How percussive each region has been over the last seconds (0 = none … 1 = ≥ 4 hits/s). */
  lowPercussion: number;
  midPercussion: number;
  highPercussion: number;
  /** Spectral centroid, 0 = dark … 1 = bright. */
  brightness: number;
  /** 0 = noisy … 1 = tonal (notes, voice, pads). */
  tonality: number;
  /** Increments on a new song (source change, or sound after ≥ 1.2 s of silence). */
  song: number;
  /** 0..1 while the song's character is being learned (first seconds), then 1: `variation` is fixed. */
  songLock: number;
  /**
   * Per-song variation values (0..1), derived from the song's character
   * (tempo, balance, brightness, tonality, percussion): the same song gives
   * the same values, different songs different ones. Scenes map them to
   * shape choices. They glide when they change.
   */
  variation: Float32Array;

  /**
   * What to draw for the bass line and the lead: one cycle (SHAPE_SIZE
   * samples, -1..1) — the voice's current shape when it is clear, else the
   * learned style. Changes glide.
   */
  bassLine: Float32Array;
  leadLine: Float32Array;
  /** Voice pitch (Hz), held while unpitched and gliding; drives wave lengths. */
  bassPitch: number;
  leadPitch: number;
  /** 0..1: how present and clear each voice is (clarity × presence of its region). */
  bassVoice: number;
  leadVoice: number;
  /**
   * Learned style, a memory of ≈ 20 s that is never reset between songs, so
   * the scene adapts little by little to what is playing: typical cycle
   * shapes of the bass and lead, and how tonal and percussive the music is.
   */
  bassStyle: Float32Array;
  leadStyle: Float32Array;
  styleTonality: number;
  stylePercussion: number;
}

export type MusicalState = 'silent' | 'calm' | 'rising' | 'active' | 'peak' | 'falling';

export type AudioSourceId = 'system' | 'microphone' | 'file' | 'fake';

export type CaptureStatus = 'idle' | 'starting' | 'running' | 'error';
