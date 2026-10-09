import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useStage, type CameraSpec } from "../sim/stage";
import { useWorld } from "../sim/world";
import { Effects } from "./Effects";
import { Fields } from "./Fields";
import { Ground, Pin, Plants, Settlements, VillageLabels } from "./Scenery";
import { Vehicles } from "./Vehicles";

const clamp01 = (u: number) => Math.min(1, Math.max(0, u));
const DAWN = new THREE.Color("#ffe9cf"), NOON = new THREE.Color("#ffffff");

/** Sun: follows the day clock while the day is running, otherwise a fixed late-morning light. */
function Sun() {
  const { geo, clock } = useWorld();
  const live = useStage().live;
  const light = useRef<THREE.DirectionalLight>(null!);
  const span = geo?.span ?? 100;
  useFrame(() => {
    // 06:00 → east horizon, 12:30 → overhead, 19:00 → west horizon
    const u = live ? clamp01((clock.current.t - 360) / 780) : 0.38;
    const up = Math.sin(u * Math.PI);
    light.current.position.set(Math.cos(u * Math.PI) * span * 0.9, 24 + up * span * 0.9, span * 0.45);
    light.current.color.copy(DAWN).lerp(NOON, up);
    light.current.intensity = 1.0 + up * 0.6;
  });
  const s = span * 0.75;
  return (
    <>
      <hemisphereLight args={["#ffffff", "#e3e9de", 1.9]} />
      <directionalLight ref={light} castShadow shadow-mapSize={[2048, 2048]} shadow-bias={-0.0005}>
        <orthographicCamera attach="shadow-camera" args={[-s, s, s, -s, 1, span * 4]} />
      </directionalLight>
    </>
  );
}

/**
 * Camera. Each page asks for a shot (stage.camera); the camera glides there. Dragging takes over.
 * Following a machine keeps it centred while leaving zoom and angle to the user.
 */
function Rig({ reduced }: { reduced: boolean }) {
  const { geo, plants, follow, vehiclePos, selected, cellById } = useWorld();
  const spec = useStage().camera;
  const controls = useRef<{ target: THREE.Vector3; update: () => void } | null>(null);
  const { camera } = useThree();
  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height));
  const span = geo?.span ?? 100;
  const want = useRef({ target: new THREE.Vector3(), r: span * 1.2, polar: 0.8, azim: -0.18, on: false });
  const sph = useMemo(() => new THREE.Spherical(), []);
  const off = useMemo(() => new THREE.Vector3(), []);

  // everything a whole-map shot must show: the board and the plants beside it
  const frame = useMemo(() => {
    const b = geo?.box ?? { x0: -50, x1: 50, z0: -50, z1: 50 };
    let x0 = b.x0, x1 = b.x1, z0 = b.z0, z1 = b.z1;
    for (const p of plants) {
      x0 = Math.min(x0, p.at[0] - 9); x1 = Math.max(x1, p.at[0] + 9);
      z0 = Math.min(z0, p.at[1] - 4); z1 = Math.max(z1, p.at[1] + 2);
    }
    return { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, hw: (x1 - x0) / 2, hd: (z1 - z0) / 2 };
  }, [geo, plants]);

  const aim = (s: CameraSpec) => {
    const w = want.current;
    w.polar = s.polar ?? 0.8;
    w.azim = s.azim ?? -0.18;
    const whole = !s.target && (s.dist ?? span * 1.2) > span * 0.8;
    if (whole) {
      // back off just far enough that the frame fits this stage, whatever its shape
      const tanV = Math.tan(THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov ?? 36) / 2);
      const sin = Math.sin(w.polar), cos = Math.cos(w.polar);
      const turn = Math.abs(Math.sin(w.azim)) * 0.5;
      const hw = frame.hw + frame.hd * turn, hd = frame.hd + frame.hw * turn;
      w.target.set(frame.cx, 0, frame.cz);
      w.r = Math.max(hw / (aspect * tanV), (hd * cos) / tanV) * 1.04 + hd * sin;
    } else {
      w.target.set(s.target?.[0] ?? 0, 0, s.target?.[1] ?? 0);
      w.r = s.dist ?? span * 1.2;
    }
    w.on = true;
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { aim(spec); }, [spec.key, frame, Math.round(aspect * 10)]);
  // a clicked field glides to the centre, keeping the user's zoom and angle
  useEffect(() => {
    const c = selected ? cellById.get(selected) : null;
    if (!c || follow) return;
    off.copy(camera.position).sub(controls.current?.target ?? want.current.target);
    sph.setFromVector3(off);
    const w = want.current;
    w.target.set(c.x, 0, c.z);
    w.r = Math.min(sph.radius, span * 0.75); w.polar = sph.phi; w.azim = sph.theta; w.on = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);
  // following: close in once, then leave the distance to the user
  useEffect(() => { if (follow) want.current.on = true; else aim(spec); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [follow]);

  useFrame((_, dt) => {
    const c = controls.current;
    if (!c) return;
    const k = reduced ? 1 : 1 - Math.exp(-Math.min(dt, 0.1) * 2.4);
    const w = want.current;
    if (follow) {
      const p = vehiclePos.current.get(follow);
      if (p) {
        off.copy(camera.position).sub(c.target);
        if (w.on) {
          sph.setFromVector3(off);
          sph.radius += (13 - sph.radius) * k;
          sph.phi += (0.95 - sph.phi) * k;
          off.setFromSpherical(sph);
          if (Math.abs(sph.radius - 13) < 0.3) w.on = false;
        }
        c.target.x += (p.x - c.target.x) * Math.min(1, k * 3);
        c.target.z += (p.z - c.target.z) * Math.min(1, k * 3);
        camera.position.copy(c.target).add(off);
      }
    } else if (w.on) {
      off.copy(camera.position).sub(c.target);
      sph.setFromVector3(off);
      c.target.lerp(w.target, k);
      sph.radius += (w.r - sph.radius) * k;
      sph.phi += (w.polar - sph.phi) * k;
      let d = w.azim - sph.theta;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      sph.theta += d * k;
      camera.position.copy(c.target).add(off.setFromSpherical(sph));
      if (c.target.distanceTo(w.target) < 0.05 && Math.abs(sph.radius - w.r) < 0.2 && Math.abs(d) < 0.004 && Math.abs(sph.phi - w.polar) < 0.004) w.on = false;
    }
    c.update();
  });

  return (
    <OrbitControls
      ref={controls as never}
      makeDefault
      enableDamping
      dampingFactor={0.1}
      maxPolarAngle={1.35}
      minDistance={5}
      maxDistance={span * 4}
      onStart={() => { want.current.on = false; }}
    />
  );
}

function World({ reduced }: { reduced: boolean }) {
  const { day, clock, cellById, selected } = useWorld();
  const mode = useStage();
  const dayRef = useRef(day);
  dayRef.current = day;
  // the day clock advances here so every animated thing reads one time source
  useFrame((_, dt) => {
    const c = clock.current, d = dayRef.current;
    if (!c.playing || !d) return;
    c.t += Math.min(dt, 0.1) * c.speed; // a hidden tab must not make the day leap forward
    if (c.t >= d.t1) { c.t = d.t1; c.playing = false; }
  });
  const pinned = cellById.get(mode.pin ?? selected ?? "");
  return (
    <>
      <Sun />
      <Rig reduced={reduced} />
      <Ground />
      <Settlements />
      <Fields reduced={reduced} />
      {pinned && <Pin at={[pinned.x, pinned.z]} />}
      {mode.live && <Vehicles reduced={reduced} />}
      <Plants />
      <VillageLabels />
      <Effects reduced={reduced} />
    </>
  );
}

function useReducedMotion() {
  const [r, setR] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const m = matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setR(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return r;
}

/** The one 3D map every page shares. */
export function Stage3D() {
  const { geo, select } = useWorld();
  const reduced = useReducedMotion();
  if (!geo) return null;
  const s = geo.span;
  return (
    <Canvas
      shadows
      flat
      dpr={[1, 1.5]}
      gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: "high-performance" }}
      camera={{ fov: 36, near: 1, far: s * 40, position: [-s * 0.35, s * 1.5, s * 1.3] }}
      onPointerMissed={() => select(null)}
      aria-label="3D map of the block: fields, roads, villages, machines and plants"
      role="img"
    >
      <World reduced={reduced} />
    </Canvas>
  );
}
