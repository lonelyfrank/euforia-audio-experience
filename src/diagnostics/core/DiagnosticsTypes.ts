export type Domain = 'audio' | 'experience' | 'world' | 'physics' | 'matter' | 'geometry' | 'render' | 'diagnostics';
export type ClockDomain = 'audio' | 'capture' | 'presentation' | 'render';
export type MetricStatus = 'valid' | 'unavailable' | 'estimated';
export interface MetricDefinition {
  id: string;
  unit: string;
  source: string;
  domain: Domain;
  clock: ClockDomain;
  method: string;
  /** Only costs have a preferred direction; a larger physical response is not a regression. */
  lowerIsBetter?: boolean;
}
export interface DiagnosticMetric extends MetricDefinition {
  value: number | null;
  timestamp: number;
  status: MetricStatus;
}
export interface DiagnosticEvent {
  id: string;
  audioTime: number | null;
  observedAt: number;
  type: string;
  strength: number | null;
  confidence: number | null;
  /** Co-observed state, not a claim of causation. */
  context: string;
}
export interface ReportMetadata {
  engineVersion: string;
  gitSha: string | null;
  startedAt: string;
  os: string;
  backend: string;
  gpu: string | null;
  capabilities: string[];
  quality: string;
  resolution: string;
  source: string;
  sampleRate: number | null;
  session: number;
  detail: 'basic' | 'detailed';
  sampleHz: number;
  profiling: boolean;
  readback: boolean;
  scene: string | null;
  seed: number | null;
  experimental: string[];
  /** Relevant user settings and DEV overrides; absent only in older reports. */
  configuration?: string;
}
export interface DiagnosticSample { timestamp: number; metrics: DiagnosticMetric[] }
export interface DiagnosticReport {
  schema: 1;
  metadata: ReportMetadata;
  duration: number;
  samples: DiagnosticSample[];
  events: DiagnosticEvent[];
  labels: Record<string, string>;
  limitations: string[];
}
