import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { clock } from "./clock";
import { fieldPhaseAt, type FieldM, type World } from "./model";
import { LAND } from "./palette";

/**
 * Real 3D crops near the camera: instanced, wind-swaying blade clumps whose type, height and
 * colour come from the data — each study field's live phase (standing paddy, stubble, cut, sown
 * wheat rows exactly where the Super Seeder has passed), and the surrounding plots' crops.
 */

const MAX = 70000;
const SPACING = 2.0;
const RADIUS = 210;

// plot crops for the surrounding land — must match GROUND_COLOR in Environment.tsx
type Crop = { h: number; color: THREE.Color; density: number } | null;
const PLOT: Crop[] = [
  { h: 0.22, color: new THREE.Color("#cfae6a"), density: 0.8 }, // stubble
  { h: 1.05, color: new THREE.Color("#7c9a35"), density: 1 }, // standing paddy
  { h: 2.6, color: new THREE.Color("#3f6f2c"), density: 0.9 }, // sugarcane / fodder
  null, // tilled soil
  { h: 1.0, color: new THREE.Color("#b5a23e"), density: 1 }, // ripening paddy
  { h: 0.14, color: new THREE.Color("#79a83a"), density: 0.7 }, // wheat sprouts
];
const plotCrop = (x: number, z: number): Crop => {
  const cx = Math.floor(x / 180), cz = Math.floor(z / 120);
  const h = ((Math.imul(cx >>> 0, 73856093) >>> 0) ^ (Math.imul(cz >>> 0, 19349663) >>> 0)) >>> 0;
  return PLOT[Math.floor(((h % 1000) / 1000) * 6)];
};

function bladeGeometry() {
  // two crossed tapered blades, 4 segments each, base at y=0, tip at y=1
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  const SEG = 4;
  for (let b = 0; b < 3; b++) {
    const a = (b / 3) * Math.PI, ca = Math.cos(a), sa = Math.sin(a);
    const lean = 0.18 * (b - 1);
    const base = pos.length / 3;
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG, w = 0.09 * (1 - t) + 0.005;
      const off = lean * t * t;
      for (const side of [-1, 1]) {
        pos.push(ca * w * side + off * sa, t, sa * w * side - off * ca);
        nor.push(0.25 * sa, 0.95, -0.25 * ca);
      }
    }
    for (let i = 0; i < SEG; i++) {
      const k = base + i * 2;
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

/** Same coverage rule as the field shader, so sprouts/cut stubble appear exactly behind the machine. */
function covered(f: FieldM, x: number, z: number, progress: number) {
  const passes = f.work?.passes ?? 6;
  const u = (x - f.box.x0) / f.box.w, v = (z - f.box.z0) / f.box.h;
  const band = Math.floor(v * passes), done = progress * passes, frac = done - Math.floor(done);
  const dir = band % 2 === 0 ? u : 1 - u;
  return band < Math.floor(done) || (band === Math.floor(done) && dir <= frac);
}

export function Grass({ world }: { world: World }) {
  const { camera } = useThree();
  const uTime = useRef({ value: 0 });
  const mesh = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, side: THREE.DoubleSide });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = uTime.current;
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nuniform float uTime;")
        // blades are lit like a canopy (normal up) — squashed stubble would otherwise turn black
        .replace("#include <beginnormal_vertex>", "#include <beginnormal_vertex>\nobjectNormal = normalize(vec3(objectNormal.x * 0.3, 1.0, objectNormal.z * 0.3));")
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
           vec4 slI = instanceMatrix[3];
           float slH = position.y;
           float slGust = sin(uTime * 1.6 + slI.x * 0.09 + slI.z * 0.05) * 0.6 + sin(uTime * 3.1 + slI.x * 0.31) * 0.25;
           transformed.x += slGust * 0.22 * slH * slH;
           transformed.z += slGust * 0.12 * slH * slH;`,
        );
    };
    const prevCompile = mat.onBeforeCompile;
    mat.onBeforeCompile = (sh, r) => {
      prevCompile(sh, r);
      // both faces of a blade catch the sky light (back faces would otherwise render black)
      sh.fragmentShader = sh.fragmentShader.replace(
        "#include <normal_fragment_begin>",
        `#include <normal_fragment_begin>
         vec3 slUp = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
         if (dot(normal, slUp) < 0.0) normal = -normal;
         normal = normalize(mix(normal, slUp, 0.35));`,
      );
    };
    mat.customProgramCacheKey = () => "strawlink-grass";
    const m = new THREE.InstancedMesh(bladeGeometry(), mat, MAX);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.frustumCulled = false;
    m.receiveShadow = true;
    m.setColorAt(0, new THREE.Color());
    return m;
  }, []);

  // spatial index of study fields (50 m cells)
  const index = useMemo(() => {
    const g = new Map<string, FieldM[]>();
    for (const f of world.fields) {
      for (let x = Math.floor(f.box.x0 / 50); x <= Math.floor(f.box.x1 / 50); x++)
        for (let z = Math.floor(f.box.z0 / 50); z <= Math.floor(f.box.z1 / 50); z++) {
          const k = `${x},${z}`;
          (g.get(k) ?? g.set(k, []).get(k)!).push(f);
        }
    }
    return g;
  }, [world.fields]);

  const state = useRef({ cx: Infinity, cz: Infinity, t: -1, shown: false, last: 0 });
  const ray = useMemo(() => new THREE.Ray(), []);
  const plane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), []);
  const focus = useMemo(() => new THREE.Vector3(), []);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);

  useFrame((r) => {
    uTime.current.value = r.clock.elapsedTime;
    const st = state.current;
    const high = camera.position.y > 520;
    if (high) {
      if (st.shown) { mesh.count = 0; st.shown = false; }
      return;
    }
    ray.origin.copy(camera.position);
    camera.getWorldDirection(ray.direction);
    if (!ray.intersectPlane(plane, focus)) return;
    // keep the patch between the camera and what it looks at
    const fx = (focus.x + camera.position.x) / 2, fz = (focus.z + camera.position.z) / 2;
    const now = performance.now();
    const moved = Math.hypot(fx - st.cx, fz - st.cz) > 35;
    const tick = Math.abs(clock.t - st.t) > 2 && now - st.last > 400;
    if (!moved && !tick && st.shown) return;
    st.cx = fx; st.cz = fz; st.t = clock.t; st.last = now; st.shown = true;

    const phaseCache = new Map<string, ReturnType<typeof fieldPhaseAt>>();
    let n = 0;
    const x0 = Math.floor((fx - RADIUS) / SPACING) * SPACING, z0 = Math.floor((fz - RADIUS) / SPACING) * SPACING;
    for (let x = x0; x < fx + RADIUS && n < MAX; x += SPACING) {
      for (let z = z0; z < fz + RADIUS && n < MAX; z += SPACING) {
        const dx = x - fx, dz = z - fz;
        const d2 = dx * dx + dz * dz;
        if (d2 > RADIUS * RADIUS) continue;
        // deterministic jitter per lattice point
        const hx = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
        const jx = (hx - Math.floor(hx)) - 0.5;
        const hz = Math.sin(x * 39.3468 + z * 11.135) * 24634.6345;
        const jz = (hz - Math.floor(hz)) - 0.5;
        const px = x + jx * SPACING * 0.9, pz = z + jz * SPACING * 0.9;
        const fade = 1 - Math.sqrt(d2) / RADIUS; // thin out towards the edge of the patch
        if ((jx + 0.5) > fade * 1.6 + 0.15) continue;

        let height = 0, density = 1;
        let f: FieldM | undefined;
        for (const c of index.get(`${Math.floor(px / 50)},${Math.floor(pz / 50)}`) ?? []) {
          if (px > c.box.x0 && px < c.box.x1 && pz > c.box.z0 && pz < c.box.z1) { f = c; break; }
        }
        if (f) {
          const live = world.fieldById.get(f.id) ?? f;
          let ph = phaseCache.get(f.id);
          if (!ph) { ph = fieldPhaseAt(live, clock.t, world.date); phaseCache.set(f.id, ph); }
          const { phase, progress } = ph;
          if (phase === "standing" || phase === "ripe") {
            height = 0.95 + (jz + 0.5) * 0.3;
            col.copy(LAND.paddyGreen).lerp(LAND.paddyGold, phase === "ripe" ? 0.85 : progress * 0.6);
          } else if (phase === "stubble" || phase === "wet" || phase === "risk") {
            height = 0.2 + (jz + 0.5) * 0.1;
            col.copy(LAND.windrow).multiplyScalar(phase === "wet" ? 0.62 : 0.95);
          } else if (phase === "working") {
            const done = covered(live, px, pz, progress);
            if (done && live.work?.method === "seed") { height = 0.13; col.copy(LAND.sprout); density = 0.75; }
            else if (done) { height = 0.08; col.copy(LAND.shortStubble); }
            else { height = 0.2; col.copy(LAND.windrow).multiplyScalar(0.95); }
          } else if (phase === "baled") {
            height = 0.08; col.copy(LAND.shortStubble);
          } else if (phase === "seeded") {
            // wheat drilled in rows (0.2 m spacing ~ lattice rows)
            height = 0.14 + (jz + 0.5) * 0.06; col.copy(LAND.sprout); density = 0.8;
          } else {
            continue; // cleared: bare tilled soil
          }
        } else {
          const crop = plotCrop(px, pz);
          if (!crop) continue;
          height = crop.h * (0.85 + (jz + 0.5) * 0.3);
          density = crop.density;
          col.copy(crop.color).multiplyScalar(0.92 + (jx + 0.5) * 0.16);
        }
        if ((jz + 0.5) > density) continue;
        const w = 1.0 + (jx + 0.5) * 0.6;
        q.setFromAxisAngle(up, (jx + jz) * 6.283);
        mesh.setMatrixAt(n, m4.compose(p.set(px, f ? 0.6 : 0, pz), q, s.set(w, height, w)));
        mesh.setColorAt(n, col);
        n++;
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  return <primitive object={mesh} />;
}
