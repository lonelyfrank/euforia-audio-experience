import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Points,
  PointsMaterial,
  RingGeometry,
} from 'three';
import { SPECTRUM_BINS } from '../../audio/analysis/AudioAnalyzer';
import type { AudioFrame } from '../../types/audio';
import type { PaletteColors, VisualizerContext } from '../../types/visualizer';
import { BaseVisualizer } from '../shared/BaseVisualizer';

export interface SpectrumParams {
  /** Inner radius where bars start. */
  radius: number;
  barWidth: number;
  barDepth: number;
  maxLength: number;
  rotationSpeed: number;
  coreSize: number;
  dustCount: number;
}

/** 128 bars: the spectrum is mirrored so the burst is symmetric. */
const HALF = 64;
const BAR_COUNT = HALF * 2;
/** Spectrum bins merged into each bar. */
const BINS_PER_BAR = SPECTRUM_BINS / HALF;

/**
 * Radial 3D spectrum: 128 bars bursting out of a pulsing wireframe core,
 * with dust that sparkles on high frequencies.
 * bands → bar length, bass → core & ring scale, mids → rotation,
 * treble → glow & dust.
 */
export class SpectrumVisualizer extends BaseVisualizer<SpectrumParams> {
  private readonly ring = new Group();
  private bars!: InstancedMesh;
  private coreMaterial!: MeshBasicMaterial;
  private core!: Mesh;
  private dustMaterial!: PointsMaterial;
  private dust!: Points;
  private circleMaterial!: MeshBasicMaterial;
  private readonly dummy = new Object3D();
  private readonly color = new Color();
  /** Base colour per bar, from the palette. */
  private readonly barColors = Array.from({ length: BAR_COUNT }, () => new Color());
  private rotation = 0;

  init({ quality }: VisualizerContext): void {
    const p = this.preset.visual;
    // Bars grow outward along +Y from the inner radius.
    const barGeometry = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    this.bars = new InstancedMesh(barGeometry, new MeshBasicMaterial(), BAR_COUNT);
    for (let i = 0; i < BAR_COUNT; i++) this.bars.setColorAt(i, this.color.setRGB(0, 0, 0));
    this.ring.add(this.bars);

    this.circleMaterial = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2 });
    this.ring.add(new Mesh(new RingGeometry(p.radius * 0.9 - 0.012, p.radius * 0.9 + 0.012, 128), this.circleMaterial));
    this.scene.add(this.ring);

    this.coreMaterial = new MeshBasicMaterial({ wireframe: true, transparent: true, blending: AdditiveBlending });
    this.core = new Mesh(new IcosahedronGeometry(1, 2), this.coreMaterial);
    this.scene.add(this.core);

    const count = Math.round(p.dustCount * quality.density);
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const r = p.radius * (1 + Math.random() * 3);
      const a = Math.random() * Math.PI * 2;
      positions[i * 3] = Math.cos(a) * r;
      positions[i * 3 + 1] = Math.sin(a) * r;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 6;
    }
    const dustGeometry = new BufferGeometry();
    dustGeometry.setAttribute('position', new BufferAttribute(positions, 3));
    this.dustMaterial = new PointsMaterial({ size: 0.04, transparent: true, depthWrite: false, blending: AdditiveBlending });
    this.dust = new Points(dustGeometry, this.dustMaterial);
    this.scene.add(this.dust);
  }

  setPalette([primary, secondary, highlight]: PaletteColors): void {
    // Lows in the primary hue, the rest in the secondary, every fifth bar highlighted.
    for (let i = 0; i < BAR_COUNT; i++) {
      const bar = i < HALF ? i : BAR_COUNT - 1 - i;
      this.barColors[i].copy(i % 5 === 0 ? highlight : bar < HALF / 5 ? primary : secondary);
    }
    this.coreMaterial.color.copy(primary);
    this.dustMaterial.color.copy(secondary).lerp(this.color.setRGB(1, 1, 1), 0.6);
  }

  update(frame: AudioFrame, dt: number, time: number): void {
    const p = this.preset.visual;
    const { spectrum, bass, mid, treble, beatPulse } = frame;

    this.rotation += dt * (p.rotationSpeed + mid * 0.25);
    this.ring.rotation.z = this.rotation;
    this.ring.scale.setScalar(1 + bass * 0.08 + beatPulse * 0.06);

    const dummy = this.dummy;
    const step = (Math.PI * 2) / BAR_COUNT;
    for (let i = 0; i < BAR_COUNT; i++) {
      // Lowest frequencies at the top, highest meet at the bottom.
      const bar = i < HALF ? i : BAR_COUNT - 1 - i;
      let value = 0;
      for (let b = 0; b < BINS_PER_BAR; b++) value = Math.max(value, spectrum[bar * BINS_PER_BAR + b]);
      const angle = i * step;
      dummy.position.set(-Math.sin(angle) * p.radius, Math.cos(angle) * p.radius, 0);
      dummy.rotation.set(0, 0, angle);
      dummy.scale.set(p.barWidth, 0.05 + value * p.maxLength, p.barDepth);
      dummy.updateMatrix();
      this.bars.setMatrixAt(i, dummy.matrix);
      this.color.copy(this.barColors[i]).multiplyScalar(0.25 + value * 0.9 + treble * 0.15);
      this.bars.setColorAt(i, this.color);
    }
    this.bars.instanceMatrix.needsUpdate = true;
    this.bars.instanceColor!.needsUpdate = true;

    this.core.scale.setScalar(p.coreSize * (0.75 + bass * 0.4 + beatPulse * 0.2));
    this.core.rotation.x += dt * (0.1 + mid * 0.5);
    this.core.rotation.y += dt * (0.15 + mid * 0.4);
    this.coreMaterial.opacity = 0.2 + bass * 0.35;
    this.circleMaterial.opacity = 0.12 + bass * 0.15;

    this.dust.rotation.z = -this.rotation * 0.4;
    this.dustMaterial.opacity = 0.15 + treble * 0.85;
    this.dustMaterial.size = 0.03 + treble * 0.05;

    // Mostly frontal with a slow, light orbit for depth.
    const { distance, drift } = this.preset.camera;
    const orbit = Math.sin(time * 0.07) * 0.35 * drift;
    const tilt = Math.sin(time * 0.05) * 0.2 * drift;
    this.camera.position.set(Math.sin(orbit) * distance, Math.sin(tilt) * distance, Math.cos(orbit) * distance);
    this.camera.lookAt(0, 0, 0);
  }
}
