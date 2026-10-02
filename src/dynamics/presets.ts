/**
 * Dynamics presets: the Director picks a type for each fixture parameter,
 * never coefficients. Two primitives, kept distinct:
 *
 * - `envelope`: instant attack (the value jumps to the peak at the event's
 *   exact time), exponential decay. For transients (flash, kick): a spring
 *   would add perceived latency.
 * - `spring`: damped harmonic motion towards a target (natural frequency in
 *   Hz, damping ratio ζ). ζ = 1 settles without overshoot (atmosphere),
 *   0.4–0.7 gives a small rebound (pulses).
 */
export type DynamicsType = 'flash' | 'hit' | 'pulse' | 'swing' | 'glide' | 'drift';

export type DynamicsPreset =
  | { kind: 'envelope'; /** Decay time constant (s). */ decay: number }
  | { kind: 'spring'; /** Natural frequency (Hz). */ frequency: number; /** Damping ratio ζ. */ damping: number };

export const PRESETS: Readonly<Record<DynamicsType, DynamicsPreset>> = {
  /** A short flash of light. */
  flash: { kind: 'envelope', decay: 0.12 },
  /** A kick-like hit: shorter than a flash. */
  hit: { kind: 'envelope', decay: 0.06 },
  /** A beat pulse with a small rebound. */
  pulse: { kind: 'spring', frequency: 3, damping: 0.55 },
  /** Motion with some swing (position, rotation). */
  swing: { kind: 'spring', frequency: 1.2, damping: 0.4 },
  /** A smooth glide to a new value, no overshoot (colour, size). */
  glide: { kind: 'spring', frequency: 0.6, damping: 1 },
  /** A very slow drift (atmosphere). */
  drift: { kind: 'spring', frequency: 0.12, damping: 1 },
};
