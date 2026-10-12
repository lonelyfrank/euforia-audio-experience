import { describe, expect, it } from 'vitest';
import type { WorkspaceView } from './components';
import { applySections, block, VIEW_DOMAINS, VIEW_SECTIONS, type Section } from './sections';

const VIEWS = Object.keys(VIEW_SECTIONS) as WorkspaceView[];
/** Built only by the DEV tools: a release build has none of them, whatever the view asks for. */
const DEV: readonly Section[] = ['audio', 'charts', 'experiment', 'laboratory', 'isolation'];
const viewsOf = (section: Section): WorkspaceView[] => VIEWS.filter(view => VIEW_SECTIONS[view].includes(section));

describe('what each workspace view holds', () => {
  it('keeps experiments, laboratories and primitive isolation out of the analysis views', () => {
    expect(viewsOf('experiment')).toEqual(['laboratories']);
    expect(viewsOf('laboratory')).toEqual(['laboratories']);
    expect(viewsOf('isolation')).toEqual(['laboratories', 'diagnostics']);
    for (const section of ['experiment', 'laboratory', 'isolation', 'health', 'acquisition', 'replay', 'reports'] as const) expect(VIEW_SECTIONS.audio).not.toContain(section);
  });
  it('keeps the whole registry, replay and reports in Diagnostics & Reports, where the domain is chosen', () => {
    for (const section of ['acquisition', 'replay', 'reports'] as const) expect(viewsOf(section)).toEqual(['diagnostics']);
    expect(VIEW_DOMAINS.diagnostics).toBeNull();
    // A contextual view reads its own domains and has no way to browse the others.
    for (const view of VIEWS) if (view !== 'diagnostics') expect(VIEW_DOMAINS[view]!.length).toBeGreaterThan(0);
    expect(VIEW_DOMAINS.world).toEqual(['world', 'physics']); expect(VIEW_DOMAINS.matter).toEqual(['matter', 'geometry']);
  });
  it('gives the rendering measures their view, and the overview the engine health', () => {
    expect(viewsOf('health')).toEqual(['overview', 'render']);
    expect(VIEW_SECTIONS.render).toEqual(expect.arrayContaining(['plot', 'registry']));
    expect(VIEW_SECTIONS.overview).not.toContain('experiment');
  });
  it('leaves every view of a release build with something to show', () => {
    for (const view of VIEWS) if (view !== 'laboratories') expect(VIEW_SECTIONS[view].some(section => !DEV.includes(section)), view).toBe(true);
    expect(VIEW_SECTIONS.laboratories.every(section => DEV.includes(section))).toBe(true);
  });
});

describe('applySections', () => {
  const sections = [...new Set(VIEWS.flatMap(view => VIEW_SECTIONS[view]))];
  it('shows exactly what the view asks for, and a container while anything inside it shows', () => {
    const targets = new Map(sections.map(section => [section, { hidden: false }]));
    const host = { hidden: false }, blocks = [...[...targets].map(([section, target]) => block(target, section)), block(host, 'registry', 'replay', 'timeline')];
    for (const view of VIEWS) {
      applySections(view, blocks);
      for (const [section, target] of targets) expect(target.hidden, `${view} · ${section}`).toBe(!VIEW_SECTIONS[view].includes(section));
      expect(host.hidden, view).toBe(view === 'overview' || view === 'laboratories');
    }
  });
  it('writes a block only when its state changes: the view already shown costs nothing', () => {
    let writes = 0, hidden = false;
    const target = { get hidden() { return hidden; }, set hidden(value: boolean) { hidden = value; writes++; } };
    applySections('audio', [block(target, 'audio')]); expect(writes).toBe(0);
    applySections('world', [block(target, 'audio')]); applySections('matter', [block(target, 'audio')]); expect(writes).toBe(1);
    applySections('audio', [block(target, 'audio')]); expect([writes, hidden]).toEqual([2, false]);
  });
});
