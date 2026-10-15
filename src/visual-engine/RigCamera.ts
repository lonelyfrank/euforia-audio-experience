import type { PerspectiveCamera } from 'three';
import { createInput, LOCOMOTIONS, type CameraRig, type Locomotion, type MotionFocus, type MotionInput } from '../render-systems/camera/locomotion';
import { REST_VIEW } from '../world/WorldView';
import type { WorldFrame } from './Primitive';
import type { WorldCamera } from './WorldRecipe';

/**
 * A world's observer made of a camera rig (render-systems/camera/locomotion.ts): the frame's world goes in, and what
 * the scene offers to look at (`aim`: a structure rising, a cluster of bodies), read from what its primitives showed.
 * The scene's motion past the observer is `rig.advance` after the step.
 */
export class RigCamera implements WorldCamera {
  readonly input: MotionInput = createInput(REST_VIEW);
  /** Pose shown, target, lens, roll, the observer's speed, the scene's forward speed and the weight of each profile. */
  readonly debug: Record<string, number> = { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0, fov: 0, roll: 0, motion: 0, advance: 0, focus: 0 };
  private readonly kinds: Locomotion[];

  constructor(readonly rig: CameraRig, private readonly aim?: (frame: Readonly<WorldFrame>, focus: MotionFocus) => void) {
    this.kinds = rig.locomotion;
    for (const kind of LOCOMOTIONS) if (this.kinds.includes(kind)) this.debug[kind] = 0;
  }

  get locomotion(): readonly Locomotion[] { return this.kinds; }

  step(frame: Readonly<WorldFrame>): void {
    const input = this.input;
    input.dt = frame.dt; input.view = frame.view; input.time = frame.time; input.timed = frame.timed;
    input.focus.weight = 0;
    this.aim?.(frame, input.focus);
    this.rig.step(input);
    const d = this.debug, p = this.rig.pose;
    d.x = p.x; d.y = p.y; d.z = p.z; d.tx = p.tx; d.ty = p.ty; d.tz = p.tz; d.fov = p.fov; d.roll = p.roll;
    d.motion = this.rig.motion; d.advance = this.rig.speed; d.focus = input.focus.weight;
    for (let i = 0; i < this.kinds.length; i++) d[this.kinds[i]] = this.rig.weights[i];
  }

  apply(camera: PerspectiveCamera, fov: number): void {
    this.rig.apply(camera, fov);
  }

  reset(): void {
    this.rig.reset();
  }
}
