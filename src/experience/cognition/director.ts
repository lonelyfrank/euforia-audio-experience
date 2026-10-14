import type { ShowInput } from '../../show/types';
import type { CognitionFrame } from './types';

/*
 * What the director takes from the cognition, and only when the cognition is sure. The show already plans its looks on
 * phrase boundaries (ShowDirector: a new look on a boundary after a hold, a tint per phrase, the breath before an
 * expected drop); here the boundaries it reads become the cognition's inferred phrase grid instead of the DSP's count
 * of eight bars from the last section change — when, and only when, the cognition leads (a phrase grid confirmed by
 * returning boundaries, downbeats with evidence, a clock that holds; `CognitionFrame.leads`). Otherwise the input stays
 * exactly what the DSP gave: the reactive direction is the fallback, frame by frame, with nothing to switch.
 *
 * No mesh, material or geometry is touched here or anywhere downstream of it: the show decides looks and timing, the
 * scenes keep reading the world.
 */

/** Rewrites the phrase fields of the show's input from the cognition when it leads. Returns whether it did. */
export function followCognition(input: ShowInput, cognition: Readonly<CognitionFrame> | undefined): boolean {
  if (!cognition || !cognition.enabled || !cognition.leads) return false;
  const c = cognition.clock;
  input.phraseBar = c.phraseBar;
  input.phraseBars = c.phraseBars;
  input.nextPhraseTime = c.nextPhrase;
  input.structureConfidence = c.phraseConfidence;
  return true;
}
