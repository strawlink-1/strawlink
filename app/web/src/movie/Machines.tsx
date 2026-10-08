import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { clock } from "./clock";
import { along, clamp } from "./geo";
import { fieldPhaseAt, poseAt, type MachineM, type World } from "./model";
import { balerSet, superSeeder, tractorTrolley, type Rig } from "./vehicles";

/** Live machine state shared with labels, camera and HUD (written every frame). */
export type LivePose = { pos: THREE.Vector3; heading: number; activity: string; fieldId?: string; progress: number; loaded: boolean; scale: number };
export const livePoses = new Map<string, LivePose>();

// ---------------------------------------------------------------- dust particles

const MAX_DUST = 2400;
function makeDust() {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(MAX_DUST * 3);
  const life = new Float32Array(MAX_DUST);
  const size = new Float32Array(MAX_DUST);
  const tint = new Float32Array(MAX_DUST * 3);
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aLife", new THREE.BufferAttribute(life, 1));
  geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
  geo.setAttribute("aTint", new THREE.BufferAttribute(tint, 3));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    vertexShader: /* glsl */ `
      attribute float aLife; attribute float aSize; attribute vec3 aTint;
      varying float vLife; varying vec3 vTint;
      void main() {
        vLife = aLife; vTint = aTint;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = min(aSize * (1.0 + (1.0 - aLife) * 2.0) * (260.0 / -mv.z), 90.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vLife; varying vec3 vTint;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d) * vLife * 0.4;
        if (a < 0.01) discard;
        gl_FragColor = vec4(vTint, a);
      }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  const vel = new Float32Array(MAX_DUST * 3);
  let next = 0;
  return {
    points,
    emit(x: number, y: number, z: number, color: THREE.Color, s: number, spread: number) {
      const i = next++ % MAX_DUST;
      pos[i * 3] = x + (Math.random() - 0.5) * spread;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z + (Math.random() - 0.5) * spread;
      vel[i * 3] = (Math.random() - 0.5) * 1.2;
      vel[i * 3 + 1] = 0.8 + Math.random() * 1.4;
      vel[i * 3 + 2] = (Math.random() - 0.5) * 1.2;
      life[i] = 1;
      size[i] = s;
      tint[i * 3] = color.r; tint[i * 3 + 1] = color.g; tint[i * 3 + 2] = color.b;
    },
    update(dt: number) {
      for (let i = 0; i < MAX_DUST; i++) {
        if (life[i] <= 0) continue;
        life[i] -= dt * 0.45;
        pos[i * 3] += vel[i * 3] * dt;
        pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
        pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aLife.needsUpdate = true;
      geo.attributes.aSize.needsUpdate = true;
      geo.attributes.aTint.needsUpdate = true;
    },
  };
}

// ---------------------------------------------------------------- machines

type Live = { m: MachineM; rig: Rig; shown: THREE.Vector3; heading: number; ready: boolean; ring: THREE.Mesh };

/** Glowing ground ring in the machine's paint colour (identity at any distance). */
function makeRing(color: string) {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(4.2, 5.6, 40),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.15;
  ring.renderOrder = 2;
  return ring;
}

function buildRig(m: MachineM): Rig {
  if (m.type === "baler_set") return balerSet(m.color, m.accent);
  if (m.type === "seeder") return superSeeder(m.color, m.accent);
  return tractorTrolley(m.color, m.accent);
}

const DUST_SOIL = new THREE.Color("#b49a72");
const DUST_STRAW = new THREE.Color("#ead8a0");
const DUST_ROAD = new THREE.Color("#c9bfae");

export function Machines({
  world, selected, onPick, onHover,
}: {
  world: World;
  selected: string | null;
  onPick: (id: string) => void;
  onHover: (id: string | null) => void;
}) {
  const { camera } = useThree();
  const dust = useMemo(makeDust, []);
  const store = useRef(new Map<string, Live>());
  const group = useRef<THREE.Group>(null);

  // keep one rig per machine id across plan changes so movement stays continuous
  const lives = useMemo(() => {
    const out: Live[] = [];
    for (const m of world.machines) {
      let l = store.current.get(m.id);
      if (!l || l.m.type !== m.type) {
        l = { m, rig: buildRig(m), shown: new THREE.Vector3(), heading: 0, ready: false, ring: makeRing(m.color) };
        l.rig.root.add(l.ring);
        l.rig.root.userData.machineId = m.id;
        store.current.set(m.id, l);
      }
      l.m = m;
      out.push(l);
    }
    return out;
  }, [world.machines]);

  useEffect(() => {
    const g = group.current;
    if (!g) return;
    g.clear();
    for (const l of lives) g.add(l.rig.root);
  }, [lives]);

  // ---- bales lying in baled fields
  const baleMesh = useMemo(() => {
    const geo = new THREE.BoxGeometry(1.2, 0.8, 2.2);
    geo.translate(0, 0.4, 0);
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: "#e4c46a", roughness: 0.95 }), 2000);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.count = 0;
    return mesh;
  }, []);

  const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(), tmpP = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);

  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.1);
    const t = clock.t;
    for (const l of lives) {
      const pose = poseAt(l.m, t);
      const target = tmpP.set(pose.pos[0], 0, pose.pos[1]);
      if (!l.ready) { l.shown.copy(target); l.heading = pose.heading; l.ready = true; }
      // glide toward the plan position (makes re-plans visibly re-route instead of teleport)
      const before = l.shown.clone();
      const k = 1 - Math.exp(-dt * 6);
      l.shown.lerp(target, k);
      const moved = before.distanceTo(l.shown);
      let dh = pose.heading - l.heading;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      l.heading += dh * (1 - Math.exp(-dt * 8));

      // legibility: real size up close, enlarged at overview distances
      const camD = camera.position.distanceTo(l.shown);
      const scale = clamp(camD / 85, 1, 28) * (selected === l.m.id ? 1.2 : 1);
      const root = l.rig.root;
      root.position.copy(l.shown);
      root.rotation.y = l.heading;
      root.scale.setScalar(scale);
      const working = pose.activity === "work";
      root.position.y = working ? Math.sin(performance.now() / 60 + l.m.id.length) * 0.04 * scale : 0;

      for (const w of l.rig.wheels) w.mesh.rotation.x += moved / scale / w.r;
      const ringMat = l.ring.material as THREE.MeshBasicMaterial;
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 260);
      ringMat.opacity = pose.activity === "idle" ? 0.35 : working ? 0.55 + 0.4 * pulse : 0.8;
      l.ring.scale.setScalar(working ? 1 + 0.18 * pulse : 1);
      if (l.rig.rotor) l.rig.rotor.rotation.x += working ? dt * 25 : 0;
      if (l.rig.plunger) l.rig.plunger.position.y = 2.25 + (working ? Math.sin(performance.now() / 90) * 0.12 : 0);
      if (l.rig.load) l.rig.load.visible = pose.loaded;
      if (l.rig.beacon) {
        const on = pose.activity !== "idle" && Math.sin(performance.now() / 150) > 0;
        (l.rig.beacon.material as THREE.MeshStandardMaterial).emissiveIntensity = on ? 2.5 : 0.2;
      }

      // dust: thick soil/straw while working, light dust while driving
      const behind = new THREE.Vector3(-Math.sin(l.heading), 0, -Math.cos(l.heading)).multiplyScalar(5 * scale);
      if (working && Math.random() < dt * 60) {
        dust.emit(l.shown.x + behind.x, 0.8 * scale, l.shown.z + behind.z, l.m.type === "seeder" ? DUST_SOIL : DUST_STRAW, 3.2 * scale, 2.5 * scale);
      } else if (pose.activity === "drive" && moved > 0.05 && Math.random() < dt * 20) {
        dust.emit(l.shown.x + behind.x, 0.5 * scale, l.shown.z + behind.z, DUST_ROAD, 2 * scale, 1.5 * scale);
      }

      const lp = livePoses.get(l.m.id) ?? { pos: new THREE.Vector3(), heading: 0, activity: "idle", progress: 0, loaded: false, scale: 1 };
      lp.pos.copy(l.shown);
      lp.heading = l.heading;
      lp.activity = pose.activity;
      lp.fieldId = pose.leg.kind === "work" || pose.leg.kind === "load" ? pose.leg.fieldId : undefined;
      lp.progress = pose.progress;
      lp.loaded = pose.loaded;
      lp.scale = scale;
      livePoses.set(l.m.id, lp);
    }
    dust.update(dt);

    // bales: dropped along the baler's actual passes; gone once a truck has loaded that field
    let n = 0;
    for (const f of world.fields) {
      if (f.work?.method !== "bale") continue;
      const { phase, progress } = fieldPhaseAt(f, t, world.date);
      if (phase !== "working" && phase !== "baled") continue;
      const leg = world.machines.find((m) => m.id === f.work!.machineId)?.legs.find((l) => l.kind === "work" && l.fieldId === f.id);
      if (!leg || leg.kind !== "work") continue;
      const count = clamp(Math.round(f.straw * 2.2), 6, 40);
      const loadedShare = f.pickups.filter((pk) => t >= pk + 12).length / Math.max(1, f.pickups.length);
      for (let k = 0; k < count; k++) {
        const frac = (k + 0.5) / count;
        if (phase === "working" && frac > progress) break;
        if (frac < loadedShare) continue;
        const a = along(leg.path, frac);
        tmpQ.setFromAxisAngle(up, a.heading + (k % 3) * 0.2);
        baleMesh.setMatrixAt(n++, tmpM.compose(tmpP.set(a.pos[0] + ((k * 7) % 5) - 2, 0.25, a.pos[1] + ((k * 3) % 5) - 2), tmpQ, tmpS.set(1, 1, 1)));
        if (n >= 2000) break;
      }
    }
    baleMesh.count = n;
    baleMesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <>
      <group
        ref={group}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          let o: THREE.Object3D | null = e.object;
          while (o && !o.userData.machineId) o = o.parent;
          if (o) onPick(o.userData.machineId);
        }}
        onPointerOver={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          let o: THREE.Object3D | null = e.object;
          while (o && !o.userData.machineId) o = o.parent;
          if (o) { onHover(o.userData.machineId); document.body.style.cursor = "pointer"; }
        }}
        onPointerOut={() => { onHover(null); document.body.style.cursor = ""; }}
      />
      <primitive object={baleMesh} />
      <primitive object={dust.points} />
    </>
  );
}
