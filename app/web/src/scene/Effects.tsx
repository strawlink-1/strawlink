import { Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import type { XZ } from "../sim/geo";
import { useStage, type AirLayer } from "../sim/stage";
import { Label } from "./Label";
import { useWorld, type Pulse as PulseT } from "../sim/world";

const clamp01 = (u: number) => Math.min(1, Math.max(0, u));

/** Rain over a village whose fields are too wet to work. */
function Rain({ at: [cx, cz], r, reduced }: { at: XZ; r: number; reduced: boolean }) {
  const N = 900, TOP = 13;
  const pts = useRef<THREE.Points>(null!);
  const positions = useMemo(() => {
    const a = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const d = r * Math.sqrt(Math.random()), th = Math.random() * Math.PI * 2;
      a[i * 3] = Math.cos(th) * d; a[i * 3 + 1] = Math.random() * TOP; a[i * 3 + 2] = Math.sin(th) * d;
    }
    return a;
  }, [r]);
  useFrame((_, dt) => {
    if (reduced) return;
    const attr = pts.current.geometry.attributes.position as THREE.BufferAttribute;
    const a = attr.array as Float32Array;
    for (let i = 1; i < a.length; i += 3) { a[i] -= Math.min(dt, 0.1) * 20; if (a[i] < 0) a[i] += TOP; }
    attr.needsUpdate = true;
  });
  return (
    <group position={[cx, 0, cz]}>
      <points ref={pts}>
        <bufferGeometry><bufferAttribute attach="attributes-position" args={[positions, 3]} /></bufferGeometry>
        <pointsMaterial color="#2563eb" size={0.2} transparent opacity={0.7} depthWrite={false} />
      </points>
      {[[-0.4, 0], [0.25, 0.3], [0.5, -0.2], [-0.1, -0.5], [0, 0.1]].map(([x, z], i) => (
        <mesh key={i} position={[x * r, TOP + (i % 2), z * r]} scale={[1.7, 0.45, 1.35]}>
          <sphereGeometry args={[r * 0.3, 14, 10]} /><meshLambertMaterial color="#94a3b8" transparent opacity={0.55} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}

/** Smoke columns over recently burned fields (season replay — observed 2025 burns, not a pollution reading). */
function Smoke({ sites, reduced }: { sites: XZ[]; reduced: boolean }) {
  const PUFFS = 4, MAX = 70;
  const mesh = useRef<THREE.InstancedMesh>(null!);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  useFrame((s) => {
    const m = mesh.current;
    const n = Math.min(sites.length, MAX);
    for (let i = 0; i < MAX; i++) {
      for (let j = 0; j < PUFFS; j++) {
        const u = i < n ? (reduced ? (j + 0.5) / PUFFS : (s.clock.elapsedTime * 0.22 + j / PUFFS + i * 0.37) % 1) : 0;
        const size = i < n ? Math.sin(u * Math.PI) * (0.45 + u * 1.2) : 0;
        dummy.position.set((sites[i]?.[0] ?? 0) + Math.sin(i + u * 3) * 0.3, 0.4 + u * 6.5, (sites[i]?.[1] ?? 0) + Math.cos(i * 2 + u * 3) * 0.3);
        dummy.scale.setScalar(Math.max(0.0001, size));
        dummy.updateMatrix();
        m.setMatrixAt(i * PUFFS + j, dummy.matrix);
      }
    }
    m.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, MAX * PUFFS]} frustumCulled={false}>
      <sphereGeometry args={[1, 10, 8]} />
      <meshLambertMaterial color="#6b7280" transparent opacity={0.4} depthWrite={false} />
    </instancedMesh>
  );
}

/** Rings rising from a field whose state just changed (confirmation, re-plan, clearance, rain). */
function Pulse({ pulse }: { pulse: PulseT }) {
  const g = useRef<THREE.Group>(null!);
  const t0 = useRef<number | null>(null);
  useFrame((s) => {
    t0.current ??= s.clock.elapsedTime;
    const u = (s.clock.elapsedTime - t0.current) / 2.6;
    g.current.visible = u < 1;
    if (u >= 1) return;
    g.current.children.forEach((c, i) => {
      const v = clamp01(u * 1.25 - i * 0.18);
      c.scale.setScalar(0.4 + v * 4.5);
      c.position.y = 0.3 + v * 3.5;
      ((c as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = (1 - v) * 0.95;
    });
  });
  return (
    <group ref={g} position={[pulse.x, 0, pulse.z]}>
      {[0, 1, 2].map((i) => (
        <mesh key={i} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[0.82, 1, 40]} /><meshBasicMaterial color={pulse.color} transparent depthWrite={false} side={THREE.DoubleSide} toneMapped={false} /></mesh>
      ))}
    </group>
  );
}

/** Today's truck trips as arcs from each field to the plant that takes its bales. */
function Trips({ reduced }: { reduced: boolean }) {
  const { day, cellById, plants } = useWorld();
  const arcs = useMemo(() => {
    const where = new Map(plants.map((p, i) => [p.id, { at: p.at, color: ["#d97706", "#0891b2", "#7c3aed"][i % 3] }]));
    return (day?.trips ?? []).flatMap((t, i) => {
      const c = cellById.get(t.field_id), p = where.get(t.plant_id);
      if (!c || !p) return [];
      const a = new THREE.Vector3(c.x, 0.2, c.z), b = new THREE.Vector3(p.at[0], 1.2, p.at[1]);
      const mid = a.clone().lerp(b, 0.5).setY(6 + a.distanceTo(b) * 0.12);
      return [{ key: `${t.field_id}-${i}`, pts: new THREE.QuadraticBezierCurve3(a, mid, b).getPoints(28), color: p.color }];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day?.planId, plants, cellById.size]);
  const refs = useRef<({ material: { dashOffset: number } } | null)[]>([]);
  useFrame((_, dt) => { if (!reduced) for (const r of refs.current) if (r) r.material.dashOffset -= Math.min(dt, 0.1) * 2.4; });
  return (
    <>
      {arcs.map((a, i) => (
        <Line key={a.key} ref={((r: never) => { refs.current[i] = r; }) as never} points={a.pts} color={a.color} lineWidth={2.2} dashed dashSize={1.4} gapSize={0.9} transparent opacity={0.9} />
      ))}
    </>
  );
}

/** Where smoke would drift if the at-risk fields burned: wind streaks, downwind fans and the places inside them. */
function Air({ air, reduced }: { air: AirLayer; reduced: boolean }) {
  const { geo } = useWorld();
  const N = 80;
  const streaks = useRef<THREE.InstancedMesh>(null!);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  // compass bearing (clockwise from north) → scene direction: north is −z, east is +x
  const rad = (air.windTo * Math.PI) / 180;
  const dir = useMemo(() => new THREE.Vector2(Math.sin(rad), -Math.cos(rad)), [rad]);
  const half = (geo?.span ?? 100) * 0.62;
  const seeds = useMemo(() => Array.from({ length: N }, () => ({ a: Math.random(), side: Math.random() * 2 - 1, y: 1.5 + Math.random() * 3.5, v: 0.6 + Math.random() * 0.8 })), []);
  useFrame((s) => {
    const t = reduced ? 0 : s.clock.elapsedTime * 0.06;
    seeds.forEach((p, i) => {
      const along = (((p.a + t * p.v) % 1) * 2 - 1) * half;
      dummy.position.set(dir.x * along - dir.y * p.side * half, p.y, dir.y * along + dir.x * p.side * half);
      dummy.rotation.set(0, Math.atan2(dir.x, dir.y), 0);
      dummy.scale.set(0.05, 0.05, 3.2);
      dummy.updateMatrix();
      streaks.current.setMatrixAt(i, dummy.matrix);
    });
    streaks.current.instanceMatrix.needsUpdate = true;
  });
  // one translucent fan per source field, opening downwind
  const fan = useMemo(() => {
    const half = (air.sectorDeg * Math.PI) / 180;
    const g = new THREE.CircleGeometry(26, 20, -half, half * 2);
    g.rotateX(-Math.PI / 2);
    return g;
  }, [air.sectorDeg]);
  return (
    <>
      <instancedMesh ref={streaks} args={[undefined, undefined, N]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} /><meshBasicMaterial color="#475569" transparent opacity={0.4} toneMapped={false} />
      </instancedMesh>
      {air.sources.slice(0, 24).map(([x, z], i) => (
        // CircleGeometry's zero angle points along +x; turn it to the wind direction
        <mesh key={i} geometry={fan} position={[x, 0.2 + i * 0.002, z]} rotation={[0, Math.atan2(-dir.y, dir.x), 0]}>
          <meshBasicMaterial color="#f97316" transparent opacity={0.1} depthWrite={false} side={THREE.DoubleSide} toneMapped={false} />
        </mesh>
      ))}
      {air.places.map((p) => (
        <group key={p.kind + p.name} position={[p.at[0], 0, p.at[1]]}>
          <mesh position={[0, 0.9, 0]}><coneGeometry args={[0.4, 1.8, 4]} /><meshLambertMaterial color={p.kind === "school" ? "#ffd166" : "#ff8a4c"} /></mesh>
          <Label at={[0, 2.6, 0]} above>
            <div className={`label3d place ${p.kind}`}>{p.kind === "school" ? "School" : "Village"} · {p.name || "unnamed"}<small>{p.km.toFixed(1)} km{p.moved ? ", drawn closer" : ""}</small></div>
          </Label>
        </group>
      ))}
    </>
  );
}

export function Effects({ reduced }: { reduced: boolean }) {
  const { villages, pulses } = useWorld();
  const mode = useStage();
  return (
    <>
      {villages.filter((v) => v.wet).map((v) => <Rain key={v.id} at={v.mid} r={Math.min(v.r, 14)} reduced={reduced} />)}
      {mode.smoke.length > 0 && <Smoke sites={mode.smoke} reduced={reduced} />}
      {!reduced && pulses.map((p) => <Pulse key={p.key} pulse={p} />)}
      {mode.trips && <Trips reduced={reduced} />}
      {mode.air && <Air air={mode.air} reduced={reduced} />}
    </>
  );
}
