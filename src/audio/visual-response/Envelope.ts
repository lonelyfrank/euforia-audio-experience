/**
 * One-pole follower with separate attack and release time constants
 * (seconds). Frame-rate independent; a time constant of 0 follows instantly.
 */
export class Envelope {
  value = 0;

  constructor(
    private readonly attack: number,
    private readonly release: number,
  ) {}

  update(target: number, dt: number): number {
    const tau = target > this.value ? this.attack : this.release;
    this.value = tau <= 0 ? target : this.value + (target - this.value) * (1 - Math.exp(-dt / tau));
    return this.value;
  }

  reset(value = 0): void {
    this.value = value;
  }
}
