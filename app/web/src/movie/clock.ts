import { useEffect, useState } from "react";

/** Simulation clock in minutes after midnight. Mutated every frame by the scene; HUD samples it. */
export const clock = {
  t: 8 * 60,
  playing: true,
  speed: 6, // sim minutes per real second
  min: 7 * 60,
  max: 18 * 60,
  seek(t: number) {
    this.t = Math.max(this.min, Math.min(this.max, t));
  },
  tick(dtSec: number) {
    if (!this.playing) return;
    this.t += dtSec * this.speed;
    if (this.t > this.max) {
      this.t = this.max;
      this.playing = false;
    }
  },
};

/** Re-render a HUD component a few times per second with the current clock. */
export function useClockSample(hz = 8) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => set((x) => x + 1), 1000 / hz);
    return () => window.clearInterval(id);
  }, [hz]);
  return clock;
}

/** Sun direction for the sim time (late-October Punjab: ~06:25 sunrise, ~17:40 sunset). */
export function sunAt(t: number): { elevation: number; azimuth: number } {
  const rise = 6 * 60 + 25, set = 17 * 60 + 40;
  const f = (t - rise) / (set - rise);
  const elevation = Math.sin(Math.PI * Math.max(-0.08, Math.min(1.08, f))) * (48 * Math.PI / 180);
  const azimuth = Math.PI * 0.5 + f * Math.PI; // east → south → west
  return { elevation, azimuth };
}
