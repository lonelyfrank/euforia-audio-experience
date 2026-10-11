import type { App } from '../app/App';
import { DiagnosticsController } from './core/DiagnosticsController';
import { EngineWorkspace } from './workspace/EngineWorkspace';

/** One controller, one workspace. The release entry remains lazy and observation-only. */
export function installDiagnostics(app: App, tools = true, open = false): () => void {
  const controller = new DiagnosticsController(app);
  let workspace: EngineWorkspace | null = null;
  let disposed = false;
  const show = () => {
    const query = new URLSearchParams(location.search);
    if (open || query.has('diagnostics')) workspace?.open('diagnostics');
    else if (tools && query.has('engine')) workspace?.open('laboratories');
    else if (tools && (query.has('debug') || query.has('matter') || query.has('primitives'))) workspace?.open('audio');
  };
  if (import.meta.env.DEV && tools) {
    void import('./workspace/DevelopmentTools').then(({ DevelopmentTools }) => {
      if (disposed) return;
      workspace = new EngineWorkspace(app, controller, (parent, deck) => new DevelopmentTools(app, controller, parent, deck));
      show();
    });
  } else { workspace = new EngineWorkspace(app, controller); show(); }
  return () => { disposed = true; workspace?.dispose(); controller.dispose(); };
}
