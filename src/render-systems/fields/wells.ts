/*
 * Potential wells: the smallest piece of collective behaviour the scenes
 * share. A periodic potential with one well per unit of a coordinate
 * (U = −cos 2πx) is what a standing wave does to what floats in it: dust in a
 * sounding tube gathers on the nodes, sand on a plate on its nodal lines.
 * Nothing here knows about neighbours; elements end up together because they
 * answer the same potential.
 *
 *   wellPull  the restoring pull towards the nearest well (a flow or a force
 *             for what is simulated: the shells of the Field scene);
 *   wellRest  where a point rests once the wells are `depth` deep, in closed
 *             form (for what has no state: the particles of Particle Field).
 *
 * Written twice like the field law: GLSL for the GPU, the same function in
 * TypeScript for the tests.
 */

/** Deepest a well may be: below 1 the map x → wellRest(x) stays one to one (elements gather, they never cross). */
export const WELL_DEPTH = 0.94;

export const wellsGlsl = /* glsl */ `
// −sin(2πx) / 2π: zero in a well (whole x) and on the ridge between two, towards the well in between.
float wellPull(float x) {
  return -sin(6.2831853 * x) * 0.15915494;
}
// Where a point that was at x rests in wells of this depth (0 = free … ${WELL_DEPTH} = gathered): nearer its well, never past it.
float wellRest(float x, float depth) {
  return x + depth * wellPull(x);
}
`;

/** CPU reference of the GLSL `wellPull`. */
export function wellPull(x: number): number {
  return -Math.sin(2 * Math.PI * x) / (2 * Math.PI);
}

/** CPU reference of the GLSL `wellRest`. */
export function wellRest(x: number, depth: number): number {
  return x + depth * wellPull(x);
}
