import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { livePoses } from "./Machines";
import type { World } from "./model";

export type CamMode = { kind: "intro" } | { kind: "free" } | { kind: "follow"; id: string } | { kind: "focus"; x: number; z: number; r: number };

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Cinematic camera: an opening fly-in, free orbit, chase-cam behind a machine, and smooth
 * fly-to for fields. User input always wins (dragging switches back to free orbit).
 */
export function CameraRig({ world, mode, onUserMove }: { world: World; mode: CamMode; onUserMove: () => void }) {
  const { camera, gl } = useThree();
  const controls = useRef<OrbitControls | null>(null);
  const intro = useRef({ t: 0, from: new THREE.Vector3(), to: new THREE.Vector3(), lookFrom: new THREE.Vector3(), lookTo: new THREE.Vector3() });
  const userDragging = useRef(false);

  useEffect(() => {
    const c = new OrbitControls(camera, gl.domElement);
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.maxPolarAngle = Math.PI * 0.47;
    c.minDistance = 25;
    c.maxDistance = 16000;
    c.screenSpacePanning = false;
    c.addEventListener("start", () => { userDragging.current = true; onUserMove(); });
    c.addEventListener("end", () => { userDragging.current = false; });
    controls.current = c;
    return () => c.dispose();
  }, [camera, gl, onUserMove]);

  // opening shot: from high over the plains down to an oblique view of the block
  useEffect(() => {
    if (mode.kind !== "intro") return;
    const e = world.extent;
    const span = Math.max(e.w, e.h);
    const i = intro.current;
    i.t = 0;
    i.from.set(e.cx - span * 0.55, span * 0.75, e.cz + span * 0.95);
    i.to.set(e.cx - span * 0.08, span * 0.2, e.cz + span * 0.5);
    i.lookFrom.set(e.cx, 0, e.cz - span * 0.3);
    i.lookTo.set(e.cx, 0, e.cz);
    camera.position.copy(i.from);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode.kind === "intro", world.extent.cx]);

  const goal = new THREE.Vector3(), look = new THREE.Vector3();

  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.1);
    const c = controls.current;
    if (!c) return;
    if (mode.kind === "intro") {
      const i = intro.current;
      i.t = Math.min(1, i.t + dt / 6.5);
      const k = ease(i.t);
      camera.position.lerpVectors(i.from, i.to, k);
      c.target.lerpVectors(i.lookFrom, i.lookTo, k);
      if (i.t >= 1) onUserMove();
    } else if (mode.kind === "follow" && !userDragging.current) {
      const lp = livePoses.get(mode.id);
      if (lp) {
        // low, slightly off-axis chase shot so the field, the work front and the horizon are all in frame
        const back = 34 * Math.max(1, lp.scale * 0.8);
        const side = 0.45;
        goal.set(
          lp.pos.x - Math.sin(lp.heading - side) * back,
          back * 0.42,
          lp.pos.z - Math.cos(lp.heading - side) * back,
        );
        look.set(lp.pos.x + Math.sin(lp.heading) * 14, 1.5, lp.pos.z + Math.cos(lp.heading) * 14);
        camera.position.lerp(goal, 1 - Math.exp(-dt * 2.2));
        c.target.lerp(look, 1 - Math.exp(-dt * 4));
      }
    } else if (mode.kind === "focus" && !userDragging.current) {
      goal.set(mode.x - mode.r * 0.6, mode.r * 0.75, mode.z + mode.r * 0.9);
      camera.position.lerp(goal, 1 - Math.exp(-dt * 2.5));
      c.target.lerp(look.set(mode.x, 0, mode.z), 1 - Math.exp(-dt * 3));
    }
    c.update();
  });

  return null;
}
