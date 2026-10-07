/** Energy, complexity, continuity of form and space. Distances define a symmetric scene graph. */
const CHARACTER: Readonly<Record<string, readonly number[]>> = {
  galaxy: [0.55, 0.65, 0.85, 0.9], tunnel: [0.9, 0.5, 0.7, 0.6],
  'particle-field': [0.75, 0.9, 0.4, 0.9], liquid: [0.4, 0.65, 0.9, 0.4],
  spectrum: [0.7, 0.35, 0.6, 0.5], oscilloscope: [0.45, 0.3, 0.8, 0.2],
  'resonant-field': [0.5, 0.55, 0.85, 0.6], 'spectral-matter': [0.65, 0.8, 0.7, 0.85],
};
export function relationship(from: string | null, to: string): number {
  if (!from || !CHARACTER[from] || !CHARACTER[to]) return 0.5;
  let distance = 0;
  for (let i = 0; i < 4; i++) distance += (CHARACTER[from][i] - CHARACTER[to][i]) ** 2;
  return Math.max(0, 1 - Math.sqrt(distance / 4));
}
