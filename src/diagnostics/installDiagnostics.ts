import type { App } from '../app/App';
import { installDebugOverlay } from '../app/debug/DebugOverlay';
import { installEngineCockpit } from '../app/engine/EngineCockpit';
import { DiagnosticsController } from './core/DiagnosticsController';
import { DiagnosticsDashboard } from './ui/DiagnosticsDashboard';

/** One DEV entry point; production never loads this module or any of its dependencies. */
export function installDiagnostics(app: App): () => void {
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
  const overlay = installDebugOverlay(app, controller);
  const cockpit = installEngineCockpit(app, controller, () => { if (!dashboard) toggle(); });
  window.addEventListener('keydown', onKey);
  if (new URLSearchParams(location.search).has('diagnostics')) toggle();
  return () => { window.removeEventListener('keydown', onKey); dashboard?.dispose(); dashboard = null; overlay(); cockpit(); controller.dispose(); };
}
