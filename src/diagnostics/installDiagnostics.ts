import type { App } from '../app/App';
import { installDebugOverlay } from '../app/debug/DebugOverlay';
import { installEngineCockpit } from '../app/engine/EngineCockpit';
import { DiagnosticsController } from './core/DiagnosticsController';
import { DiagnosticsDashboard } from './ui/DiagnosticsDashboard';

/**
 * The one entry point of diagnostics. Development builds load it at start, with every tool; a
 * production build loads it only when diagnostics are asked for (`?diagnostics`, or
 * Ctrl+Alt+Shift+D: see App), and then only the dashboard: an observer that reads the engine and
 * writes no setting. The overlay and the cockpit stay development tools (`tools` false leaves them out).
 */
export function installDiagnostics(app: App, tools = true, open = false): () => void {
  const controller = new DiagnosticsController(app);
  let dashboard: DiagnosticsDashboard | null = null;
  const toggle = () => {
    if (dashboard) { dashboard.dispose(); dashboard = null; }
    else dashboard = new DiagnosticsDashboard(controller, toggle);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.repeat || (event.target instanceof HTMLElement && (event.target.isContentEditable || /INPUT|SELECT|TEXTAREA/.test(event.target.tagName)))) return;
    if (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && event.code === 'KeyG') toggle();
  };
  const overlay = tools ? installDebugOverlay(app, controller) : () => {};
  const cockpit = tools ? installEngineCockpit(app, controller, () => { if (!dashboard) toggle(); }) : () => {};
  window.addEventListener('keydown', onKey);
  if (open || new URLSearchParams(location.search).has('diagnostics')) toggle();
  return () => { window.removeEventListener('keydown', onKey); dashboard?.dispose(); dashboard = null; overlay(); cockpit(); controller.dispose(); };
}
