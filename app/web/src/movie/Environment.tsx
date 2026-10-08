import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { clock, sunAt } from "./clock";
import { hash, rng, type V2 } from "./geo";
import type { World } from "./model";
import type { RoadClass, RoadWay } from "./roadnet";

// ---------------------------------------------------------------- sky + light

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position.z = gl_Position.w; // keep at the far plane
  }
`;
const SKY_FRAG = /* glsl */ `
  uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uSunDir; uniform vec3 uSunColor;
  varying vec3 vDir;
  void main() {
    float h = clamp(vDir.y, -0.1, 1.0);
    vec3 col = mix(uHorizon, uTop, pow(max(h, 0.0), 0.55));
    float sun = max(dot(normalize(vDir), uSunDir), 0.0);
    col += uSunColor * (pow(sun, 900.0) * 3.0 + pow(sun, 18.0) * 0.35);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** Sky, haze, sun and fill light, all driven by the simulation clock. */
export function SkyAndLight({ fog, extent }: { fog: THREE.Color; extent: World["extent"] }) {
  const { scene, camera } = useThree();
  const focus = useMemo(() => new THREE.Vector3(), []);
  const ray = useMemo(() => new THREE.Ray(), []);
  const ground = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), []);
  const sun = useRef<THREE.DirectionalLight>(null);
  const hemi = useRef<THREE.HemisphereLight>(null);
  const sky = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false,
        uniforms: { uTop: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uSunDir: { value: new THREE.Vector3() }, uSunColor: { value: new THREE.Color() } },
      }),
    [],
  );
  const noon = { top: new THREE.Color("#2f6fc4"), hor: new THREE.Color("#b9c8cf"), sun: new THREE.Color("#fff1d2") };
  const dusk = { top: new THREE.Color("#2a4a86"), hor: new THREE.Color("#e8a66e"), sun: new THREE.Color("#ff9446") };
  const tmp = new THREE.Color();

  useFrame(() => {
    const { elevation, azimuth } = sunAt(clock.t);
    const dir = new THREE.Vector3(Math.cos(elevation) * Math.cos(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.sin(azimuth));
    const golden = 1 - Math.min(1, Math.max(0, elevation / 0.45));
    sky.uniforms.uTop.value.copy(noon.top).lerp(dusk.top, golden);
    sky.uniforms.uHorizon.value.copy(noon.hor).lerp(dusk.hor, golden);
    sky.uniforms.uSunColor.value.copy(noon.sun).lerp(dusk.sun, golden);
    sky.uniforms.uSunDir.value.copy(dir);
    fog.copy(tmp.copy(noon.hor).lerp(dusk.hor, golden * 0.8)).multiplyScalar(0.9);
    if (scene.fog) (scene.fog as THREE.FogExp2).color.copy(fog);
    if (sun.current) {
      // shadow frustum follows where the camera looks and tightens when close (sharp tractor shadows)
      ray.origin.copy(camera.position);
      camera.getWorldDirection(ray.direction);
      if (!ray.intersectPlane(ground, focus)) focus.set(extent.cx, 0, extent.cz);
      const camH = Math.max(20, camera.position.y);
      const half = Math.min(Math.max(extent.w, extent.h) * 0.75 + 600, Math.max(90, camH * 2.2));
      const sc = sun.current.shadow.camera as THREE.OrthographicCamera;
      if (Math.abs(sc.right - half) > half * 0.1) {
        sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
        sc.updateProjectionMatrix();
      }
      const r = half * 2 + 800;
      sun.current.position.set(focus.x + dir.x * r, Math.max(60, dir.y * r), focus.z + dir.z * r);
      sun.current.target.position.copy(focus);
      sun.current.target.updateMatrixWorld();
      sun.current.color.copy(noon.sun).lerp(dusk.sun, golden);
      sun.current.intensity = 0.4 + 2.6 * Math.max(0, Math.sin(elevation));
    }
    if (hemi.current) hemi.current.intensity = 0.9 + 0.5 * Math.max(0, Math.sin(elevation));
  });

  const half = Math.max(extent.w, extent.h) * 0.75 + 600;
  return (
    <>
      <mesh material={sky} renderOrder={-1} frustumCulled={false}>
        <sphereGeometry args={[60000, 32, 16]} />
      </mesh>
      <hemisphereLight ref={hemi} args={["#cfe3ff", "#6b5a3a", 0.9]} />
      <directionalLight
        ref={sun}
        castShadow
        shadow-mapSize={[4096, 4096]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.6}
        shadow-camera-left={-half}
        shadow-camera-right={half}
        shadow-camera-top={half}
        shadow-camera-bottom={-half}
        shadow-camera-near={10}
        shadow-camera-far={20000}
      />
    </>
  );
}

// ---------------------------------------------------------------- ground patchwork

const GROUND_DECLS = /* glsl */ `
  varying vec3 vGWorld;
  float gH1(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 15731.743); }
  float gNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(gH1(i), gH1(i + vec2(1, 0)), u.x), mix(gH1(i + vec2(0, 1)), gH1(i + vec2(1, 1)), u.x), u.y);
  }
`;
// Rectangular farm plots around the study block: real crop colours (sRGB, converted to linear),
// deliberately muted so the 200 planned parcels stand out.
const GROUND_COLOR = /* glsl */ `
  vec2 gP = vGWorld.xz / vec2(180.0, 120.0);
  vec2 gCell = floor(gP);
  vec2 gF = fract(gP);
  // integer hash: identical in GLSL and JS (Grass.tsx uses the same plot crops)
  uint gHu = (uint(int(gCell.x)) * 73856093u) ^ (uint(int(gCell.y)) * 19349663u);
  float gR = float(gHu % 1000u) / 1000.0;
  vec3 gCrops[6];
  gCrops[0] = vec3(0.72, 0.60, 0.38);  // harvested paddy stubble
  gCrops[1] = vec3(0.45, 0.56, 0.22);  // standing paddy
  gCrops[2] = vec3(0.27, 0.43, 0.18);  // sugarcane / fodder
  gCrops[3] = vec3(0.50, 0.39, 0.27);  // tilled soil
  gCrops[4] = vec3(0.64, 0.55, 0.26);  // ripening paddy
  gCrops[5] = vec3(0.38, 0.31, 0.21);  // fresh wheat bed
  int gIdx = int(floor(gR * 6.0));
  vec3 gCol = gCrops[0];
  for (int i = 0; i < 6; i++) if (i == gIdx) gCol = gCrops[i];
  float gRows = smoothstep(0.4, 1.0, sin((gR > 0.5 ? gF.x : gF.y) * 110.0) * 0.5 + 0.5) * (1.0 - smoothstep(500.0, 1800.0, length(vViewPosition)));
  gCol *= 0.9 + gRows * 0.1 + gNoise(vGWorld.xz * 0.05) * 0.16;
  float gGrey = dot(gCol, vec3(0.299, 0.587, 0.114));
  gCol = mix(gCol, vec3(gGrey), 0.35) * 0.82;
  vec2 gE = min(gF, 1.0 - gF) * vec2(180.0, 120.0);
  gCol = mix(gCol, vec3(0.40, 0.35, 0.25), smoothstep(1.8, 0.5, min(gE.x, gE.y)) * 0.75);
  diffuseColor.rgb = pow(gCol, vec3(2.2));
`;

export function Ground({ extent }: { extent: World["extent"] }) {
  const mat = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vGWorld;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvGWorld = (modelMatrix * vec4(position, 1.0)).xyz;");
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", `#include <common>\n${GROUND_DECLS}`)
        .replace("#include <color_fragment>", `#include <color_fragment>\n${GROUND_COLOR}`);
    };
    m.customProgramCacheKey = () => "strawlink-ground";
    return m;
  }, []);
  return (
    <mesh rotation-x={-Math.PI / 2} position={[extent.cx, 0, extent.cz]} material={mat} receiveShadow>
      <planeGeometry args={[60000, 60000, 1, 1]} />
    </mesh>
  );
}

// ---------------------------------------------------------------- roads (OpenStreetMap)

/** Flat ribbon geometry along polylines (one draw call per road class). */
export function ribbon(lines: V2[][], width: number, y: number) {
  const pos: number[] = [];
  const idx: number[] = [];
  let base = 0;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const [ax, az] = line[i - 1], [bx, bz] = line[i];
      const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1;
      const nx = (-dz / L) * width * 0.5, nz = (dx / L) * width * 0.5;
      pos.push(ax + nx, y, az + nz, ax - nx, y, az - nz, bx + nx, y, bz + nz, bx - nx, y, bz - nz);
      idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
      base += 4;
    }
    // round-ish joints: a small square at each vertex hides gaps on bends
    for (const [x, z] of line) {
      const h = width * 0.5;
      pos.push(x - h, y, z - h, x + h, y, z - h, x - h, y, z + h, x + h, y, z + h);
      idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
      base += 4;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const ROAD_STYLE: Record<RoadClass, { width: number; color: string; y: number }> = {
  major: { width: 9, color: "#3d3d3b", y: 0.9 },
  minor: { width: 6.5, color: "#55524c", y: 0.86 },
  village: { width: 4.5, color: "#7c7364", y: 0.82 },
  track: { width: 3.6, color: "#a48c66", y: 0.8 },
};

export function Roads({ ways }: { ways: RoadWay[] }) {
  const meshes = useMemo(() => {
    return (Object.keys(ROAD_STYLE) as RoadClass[]).map((cls) => {
      const st = ROAD_STYLE[cls];
      const lines = ways.filter((w) => w.cls === cls).map((w) => w.pts);
      const mesh = new THREE.Mesh(
        ribbon(lines, st.width, st.y),
        new THREE.MeshStandardMaterial({ color: st.color, roughness: cls === "track" ? 1 : 0.85, polygonOffset: true, polygonOffsetFactor: -2 }),
      );
      mesh.receiveShadow = true;
      return mesh;
    });
  }, [ways]);
  return (
    <>
      {meshes.map((m, i) => <primitive key={i} object={m} />)}
    </>
  );
}

// ---------------------------------------------------------------- villages + trees

const HOUSE_COLORS = ["#c96f4a", "#e9dcc4", "#d9a07a", "#efe6d2", "#b85c3c", "#f1d9b5", "#c9b79a", "#e4c9a8"];

export function Villages({ world }: { world: World }) {
  const { walls, roofs, tanks, trunks, crowns } = useMemo(() => {
    const occupied = (x: number, z: number) =>
      world.fields.some((f) => x > f.box.x0 - 8 && x < f.box.x1 + 8 && z > f.box.z0 - 8 && z < f.box.z1 + 8);
    const houses: { x: number; z: number; w: number; d: number; h: number; c: string; r: number }[] = [];
    const trees: { x: number; z: number; s: number }[] = [];
    for (const v of world.villages) {
      const R = rng(hash(v.id));
      for (let i = 0; i < 180 && houses.length < 900; i++) {
        const a = R() * Math.PI * 2, d = Math.sqrt(R()) * 260;
        const x = v.pos[0] + Math.cos(a) * d, z = v.pos[1] + Math.sin(a) * d;
        if (occupied(x, z)) continue;
        houses.push({ x, z, w: 8 + R() * 10, d: 7 + R() * 9, h: 3.2 + Math.floor(R() * 2.4) * 3, c: HOUSE_COLORS[Math.floor(R() * HOUSE_COLORS.length)], r: Math.floor(R() * 4) * (Math.PI / 2) + (R() - 0.5) * 0.2 });
      }
      for (let i = 0; i < 160; i++) {
        const a = R() * Math.PI * 2, d = 200 + R() * 260;
        const x = v.pos[0] + Math.cos(a) * d, z = v.pos[1] + Math.sin(a) * d;
        if (!occupied(x, z)) trees.push({ x, z, s: 0.8 + R() * 0.7 });
      }
    }
    // eucalyptus rows along some field edges (a common Punjab boundary)
    const R = rng(7);
    for (const f of world.fields) {
      if (R() > 0.22) continue;
      const along = R() > 0.5;
      const n = 5;
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const x = along ? f.box.x0 + t * f.box.w : f.box.x0 - 4;
        const z = along ? f.box.z0 - 4 : f.box.z0 + t * f.box.h;
        if (!occupied(x, z)) trees.push({ x, z, s: 1.1 + R() * 0.4 });
      }
    }

    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    const wallMat = new THREE.MeshStandardMaterial({ roughness: 0.92 });
    const walls = new THREE.InstancedMesh(box, wallMat, houses.length);
    const roofs = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ color: "#8d8577", roughness: 1 }), houses.length);
    const tanks = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 10).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color: "#2d2d2d", roughness: 0.6 }), houses.length);
    houses.forEach((h, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), h.r);
      walls.setMatrixAt(i, m.compose(p.set(h.x, 0, h.z), q, s.set(h.w, h.h, h.d)));
      walls.setColorAt(i, col.set(h.c));
      roofs.setMatrixAt(i, m.compose(p.set(h.x, h.h, h.z), q, s.set(h.w + 0.6, 0.6, h.d + 0.6)));
      // black water tanks on flat roofs, on roughly every other house
      tanks.setMatrixAt(i, m.compose(p.set(h.x + h.w * 0.2, h.h + 0.6, h.z), q, (i % 2 ? s.set(0.9, 1.4, 0.9) : s.set(0, 0, 0))));
    });
    [walls, roofs, tanks].forEach((x) => { x.castShadow = true; x.receiveShadow = true; });

    const trunkGeo = new THREE.CylinderGeometry(0.25, 0.4, 1, 6).translate(0, 0.5, 0);
    const crownGeo = new THREE.IcosahedronGeometry(1, 1);
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: "#6b5236", roughness: 1 }), trees.length);
    const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), trees.length);
    const greens = ["#3e6b2c", "#4c7a32", "#35602a", "#5a8538", "#42702f"];
    trees.forEach((t, i) => {
      const hgt = 9 * t.s;
      trunks.setMatrixAt(i, m.compose(p.set(t.x, 0, t.z), q.identity(), s.set(1, hgt * 0.6, 1)));
      crowns.setMatrixAt(i, m.compose(p.set(t.x, hgt * 0.75, t.z), q.identity(), s.set(3.2 * t.s, 4.4 * t.s, 3.2 * t.s)));
      crowns.setColorAt(i, col.set(greens[i % greens.length]));
    });
    [trunks, crowns].forEach((x) => { x.castShadow = true; });
    return { walls, roofs, tanks, trunks, crowns };
  }, [world.villages, world.fields]);

  return (
    <group>
      {world.villages.map((v) => (
        <mesh key={v.id} rotation-x={-Math.PI / 2} position={[v.pos[0], 0.08, v.pos[1]]} receiveShadow>
          <circleGeometry args={[270, 40]} />
          <meshStandardMaterial color="#a8926f" roughness={1} />
        </mesh>
      ))}
      <primitive object={walls} />
      <primitive object={roofs} />
      <primitive object={tanks} />
      <primitive object={trunks} />
      <primitive object={crowns} />
    </group>
  );
}
