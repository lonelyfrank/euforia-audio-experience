import { matterQuality, type MatterParams, type MatterQuality } from '../../visual-engine/primitives/MatterPrimitive';

export interface SpectralMatterParams extends MatterParams {
  /** Seed of the matter: the same seed is the same body. */
  seed: number;
  /** Tilt of the matter's axis away from the viewer (rad). */
  tilt: number;
}

export { matterQuality, type MatterQuality };
