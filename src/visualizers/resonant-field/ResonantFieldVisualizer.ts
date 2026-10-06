import { AdditiveBlending, BufferAttribute, Color, PlaneGeometry, Points, ShaderMaterial, Vector4 } from 'three';
import type { AudioFrame, VisualResponseFrame } from '../../types/audio';
import type { ModulationState } from '../../director/types';
import type { PaletteColors, SceneClock, VisualizerContext } from '../../types/visualizer';
import { MODE_SHAPES, MODES, WAVES } from '../../physics/ResonantPhysics';
import { REST_VIEW } from '../../world/WorldView';
import { BaseVisualizer } from '../shared/BaseVisualizer';

export interface ResonantFieldParams { resolution: number }
/** A membrane of points: precomputed eigenmodes + causal, reflecting radial waves. No local DSP. */
export class ResonantFieldVisualizer extends BaseVisualizer<ResonantFieldParams> {
  private material!: ShaderMaterial;
  private points!: Points;
  private readonly amplitudes = new Float32Array(MODES);
  private readonly waves = Array.from({ length: WAVES }, () => new Vector4(0, 0, -100, 0));

  init(context: VisualizerContext): void {
    const resolution = Math.max(32, Math.round(this.preset.visual.resolution * Math.sqrt(context.quality.density)));
    const geometry = new PlaneGeometry(6, 6, resolution, resolution);
    const positions = geometry.getAttribute('position');
    const shapes = [new Float32Array(positions.count * 4), new Float32Array(positions.count * 4), new Float32Array(positions.count * 4)];
    for (let v = 0; v < positions.count; v++) {
      const x = (positions.getX(v) + 3) / 6, y = (positions.getY(v) + 3) / 6;
      for (let i = 0; i < MODES; i++) {
        const [m, n] = MODE_SHAPES[i];
        shapes[Math.floor(i / 4)][v * 4 + i % 4] = Math.sin(m * Math.PI * x) * Math.sin(n * Math.PI * y);
      }
    }
    for (let i = 0; i < 3; i++) geometry.setAttribute(`mode${i}`, new BufferAttribute(shapes[i], 4));
    this.material = new ShaderMaterial({
      uniforms: {
        uModes: { value: this.amplitudes }, uWaves: { value: this.waves }, uTime: { value: 0 },
        uExpansion: { value: 0 }, uWidth: { value: 0 }, uCoherence: { value: 0 }, uLateral: { value: 0 },
        uLight: { value: 0 }, uSize: { value: context.quality.pixelScale * 2.3 },
        uA: { value: new Color() }, uB: { value: new Color() }, uC: { value: new Color() },
      },
      vertexShader: `
        attribute vec4 mode0; attribute vec4 mode1; attribute vec4 mode2;
        uniform float uModes[12]; uniform vec4 uWaves[8];
        uniform float uTime, uExpansion, uWidth, uCoherence, uLateral, uSize;
        varying float vHeight, vNode;
        float pulse(vec2 p, vec2 origin, float age) {
          float d = distance(p, origin), behind = age * 1.4 - d;
          if (age < 0.0 || behind < 0.0) return 0.0;
          return sin(behind * 18.0) * exp(-behind * 5.0 - age * 1.3) / sqrt(1.0 + d * 4.0);
        }
        void main() {
          vec2 p = position.xy / 3.0;
          float modal = dot(mode0, vec4(uModes[0],uModes[1],uModes[2],uModes[3]))
            + dot(mode1, vec4(uModes[4],uModes[5],uModes[6],uModes[7]))
            + dot(mode2, vec4(uModes[8],uModes[9],uModes[10],uModes[11]));
          float wave = 0.0;
          for(int i=0; i<8; i++) {
            vec4 w=uWaves[i]; float age=uTime-w.z;
            // First image sources implement fixed-edge reflection; all pulses remain causal.
            wave += w.w * (pulse(p,w.xy,age)
              - 0.55*pulse(p,vec2(2.0-w.x,w.y),age) - 0.55*pulse(p,vec2(-2.0-w.x,w.y),age)
              - 0.55*pulse(p,vec2(w.x,2.0-w.y),age) - 0.55*pulse(p,vec2(w.x,-2.0-w.y),age));
          }
          float z=modal*2.5+wave*0.7;
          vec3 pos=position;
          pos.z=0.0;
          pos.xy *= 1.0 + uExpansion*0.18;
          pos.x *= 1.0 + uWidth*0.3;
          // The world's lateral force tilts the membrane towards where the sound is.
          pos.z += uLateral * p.x * 0.35;
          pos.z+=z;
          vHeight=clamp(abs(z),0.0,1.0);
          vNode=exp(-abs(modal)*20.0)*(0.25+uCoherence*0.75);
          vec4 mv=modelViewMatrix*vec4(pos,1.0);
          gl_Position=projectionMatrix*mv;
          gl_PointSize=clamp(uSize*(9.0/max(2.0,-mv.z)),1.0,5.0);
        }`,
      fragmentShader: `
        uniform vec3 uA,uB,uC; uniform float uLight;
        varying float vHeight,vNode;
        void main(){
          float d=length(gl_PointCoord-0.5)*2.0;
          float alpha=exp(-d*d*4.0)*(0.2+vNode*0.45+vHeight*0.35)*uLight;
          if(alpha<0.004) discard;
          vec3 color=mix(mix(uA,uB,vHeight),uC,vNode*0.4);
          gl_FragColor=vec4(color,alpha);
        }`,
      transparent: true, depthWrite: false, blending: AdditiveBlending,
    });
    this.points = new Points(geometry, this.material);
    this.points.rotation.x = -0.5;
    this.points.rotation.z = Math.PI / 4;
    this.scene.add(this.points);
    this.camera.position.set(0, 0, this.preset.camera.distance);
    this.resize(context.width, context.height);
  }

  setPalette(colors: PaletteColors): void {
    this.material.uniforms.uA.value.copy(colors[0]);
    this.material.uniforms.uB.value.copy(colors[1]);
    this.material.uniforms.uC.value.copy(colors[2]);
  }

  update(_frame: AudioFrame, _dt: number, _time: number, response: VisualResponseFrame, modulation?: ModulationState, clock?: SceneClock): void {
    const e = clock?.experience;
    const u = this.material.uniforms;
    const world = modulation?.world ?? REST_VIEW;
    // The membrane turns slowly with the world's rotation; its expansion is the world's radial body.
    this.points.rotation.z = Math.PI / 4 + world.turn * 0.08;
    u.uExpansion.value = world.pressure;
    u.uLateral.value = world.lateral;
    if (e) {
      this.amplitudes.set(e.physics.modes);
      for (let i = 0; i < WAVES; i++) this.waves[i].fromArray(e.physics.waves, i * 4);
      u.uTime.value = clock!.time;
      u.uWidth.value = e.acoustic.width * e.acoustic.stereoConfidence;
      // Nodal lines are as sharp as the world is coherent.
      u.uCoherence.value = world.coherence;
      // The world's light, held while the membrane still rings after the sound.
      u.uLight.value = Math.min(0.8, 0.12 + (modulation?.brightness ?? world.light) * 0.65) *
        Math.max(world.light, Math.min(0.6, e.physics.energy * 0.15));
    } else {
      this.amplitudes.fill(0); u.uLight.value = response.audible * 0.2;
      for (const wave of this.waves) wave.set(0, 0, -100, 0);
      u.uWidth.value = u.uCoherence.value = 0;
    }
  }
}
