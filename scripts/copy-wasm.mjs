// Copies the freshly built analysis module next to its loader (committed, so
// browser development works without a Rust toolchain). Run via `npm run wasm`.
import { copyFileSync, statSync } from 'node:fs';

const from = 'target/wasm32-unknown-unknown/release/spectrum_analysis_wasm.wasm';
const to = 'src/audio/features/spectrum_analysis.wasm';
copyFileSync(from, to);
console.log(`${to}: ${(statSync(to).size / 1024).toFixed(1)} KiB`);
