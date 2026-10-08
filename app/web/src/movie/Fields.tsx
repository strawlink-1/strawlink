import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { clock } from "./clock";
import { fieldPhaseAt, type FieldM, type World } from "./model";
import { lookFor } from "./palette";

/**
 * Field surface = three's MeshStandardMaterial (sun shading, shadows, fog) with crop logic injected:
 * crop rows / straw windrows, a serpentine work front that follows the machine's real progress,
 * glossy wet soil, and emissive edge highlights (hover, selection, at-risk, changed, planned today).
 */
const DECLS = /* glsl */ `
  uniform vec3 uPre; uniform vec3 uPreRow; uniform vec3 uPost; uniform vec3 uPostRow;
  uniform float uProgress; uniform float uPasses; uniform float uTime; uniform vec4 uBox;
  uniform float uHover; uniform float uSel; uniform float uRisk; uniform float uWet; uniform float uFlash;
  uniform float uPlanned; uniform float uRowsFreq; uniform float uSeed;
  varying vec3 vFWorld;
  float slHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)) + uSeed) * 43758.5453); }
  float slNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(slHash(i), slHash(i + vec2(1, 0)), u.x), mix(slHash(i + vec2(0, 1)), slHash(i + vec2(1, 1)), u.x), u.y);
  }
  vec3 slTex(vec3 base, vec3 row, vec2 uv, float far) {
    float rows = smoothstep(0.55, 0.95, sin(uv.y * uRowsFreq) * 0.5 + 0.5) * (1.0 - far);
    float n = slNoise(vFWorld.xz * 0.35) * 0.5 + slNoise(vFWorld.xz * 1.7) * 0.25;
    return mix(base, row, rows * 0.55) * (0.84 + n * 0.32);
  }
`;

const COLOR = /* glsl */ `
  vec2 slUv = (vFWorld.xz - uBox.xy) / uBox.zw;
  float slFar = smoothstep(700.0, 2600.0, length(vViewPosition)); // fade fine rows with distance (no moire)
  float slBand = floor(slUv.y * uPasses);
  float slDone = uProgress * uPasses;
  float slFrac = slDone - floor(slDone);
  float slDir = mod(slBand, 2.0) < 0.5 ? slUv.x : 1.0 - slUv.x;
  float slCovered = slBand < floor(slDone) ? 1.0 : (slBand == floor(slDone) ? step(slDir, slFrac) : 0.0);
  vec3 slCol = mix(slTex(uPre, uPreRow, slUv, slFar), slTex(uPost, uPostRow, slUv, slFar), slCovered);
  float slPuddle = smoothstep(0.62, 0.8, slNoise(vFWorld.xz * 0.08));
  slCol = mix(slCol, slCol * vec3(0.78, 0.8, 0.9) + vec3(0.0, 0.01, 0.03) * slPuddle, uWet);
  float slEdge = min(min(slUv.x, 1.0 - slUv.x), min(slUv.y, 1.0 - slUv.y));
  slCol = mix(slCol, vec3(0.16, 0.12, 0.07), smoothstep(0.022, 0.0, slEdge) * 0.85); // bund
  diffuseColor.rgb = slCol;

  float slRim = smoothstep(0.06, 0.0, slEdge);
  float slPulse = 0.5 + 0.5 * sin(uTime * 4.0);
  float slDash = step(0.5, fract((slUv.x + slUv.y) * 6.0 - uTime * 0.6));
  float slOnBand = (slBand == floor(slDone) && uProgress > 0.0 && uProgress < 1.0) ? 1.0 : 0.0;
  vec3 slEmit = vec3(0.0);
  slEmit += vec3(1.0, 0.75, 0.3) * slOnBand * smoothstep(0.05, 0.0, abs(slDir - slFrac)) * 0.9;
  slEmit += vec3(1.0, 0.72, 0.18) * smoothstep(0.045, 0.012, slEdge) * smoothstep(0.0, 0.012, slEdge) * uPlanned * (0.35 + 0.35 * slDash);
  slEmit += vec3(1.0, 0.28, 0.1) * slRim * uRisk * (0.5 + 0.5 * slPulse);
  slEmit += vec3(0.25, 0.85, 1.0) * slRim * uFlash * 1.2;
  slEmit += vec3(1.0, 0.92, 0.7) * (slRim * 0.9 + 0.08) * uHover;
  slEmit += vec3(1.0) * slRim * uSel * 1.3;
  slEmit += vec3(0.12, 0.18, 0.28) * slPuddle * uWet * 0.18; // soft sky sheen on puddles
`;

type Item = { f: FieldM; mat: THREE.MeshStandardMaterial; u: Record<string, THREE.IUniform>; geo: THREE.BufferGeometry; key: string };

function fieldGeometry(f: FieldM) {
  const shape = new THREE.Shape(f.ring.map(([x, z]) => new THREE.Vector2(x, -z)));
  const g = new THREE.ShapeGeometry(shape);
  g.rotateX(-Math.PI / 2);
  return g;
}

function fieldMaterial(f: FieldM, i: number) {
  const u: Record<string, THREE.IUniform> = {
    uPre: { value: new THREE.Color() }, uPreRow: { value: new THREE.Color() }, uPost: { value: new THREE.Color() }, uPostRow: { value: new THREE.Color() },
    uProgress: { value: 0 }, uPasses: { value: f.work?.passes ?? 6 }, uTime: { value: 0 },
    uBox: { value: new THREE.Vector4(f.box.x0, f.box.z0, f.box.w, f.box.h) },
    uHover: { value: 0 }, uSel: { value: 0 }, uRisk: { value: 0 }, uWet: { value: 0 }, uFlash: { value: 0 }, uPlanned: { value: 0 },
    uRowsFreq: { value: 2 * Math.PI * (f.box.h / 3.2) }, uSeed: { value: i * 1.37 },
  };
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.96, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vFWorld;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvFWorld = (modelMatrix * vec4(position, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>\n${DECLS}`)
      .replace("#include <color_fragment>", `#include <color_fragment>\n${COLOR}`)
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += slEmit;");
  };
  mat.customProgramCacheKey = () => "strawlink-field";
  return { mat, u };
}

export function Fields({
  world, hovered, selected, flash, onHover, onPick,
}: {
  world: World;
  hovered: string | null;
  selected: string | null;
  flash: Map<string, number>;
  onHover: (id: string | null) => void;
  onPick: (id: string) => void;
}) {
  const items = useMemo<Item[]>(
    () => world.fields.map((f, i) => ({ f, ...fieldMaterial(f, i), geo: fieldGeometry(f), key: "" })),
    // rebuild materials only when the set of parcels changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [world.fields.map((f) => f.id).join(",")],
  );
  const live = useRef(items);
  live.current = items;

  useFrame((state) => {
    const t = clock.t;
    const now = performance.now();
    for (const it of live.current) {
      const f = world.fieldById.get(it.f.id) ?? it.f; // latest schedule for this parcel
      const { phase, progress } = fieldPhaseAt(f, t, world.date);
      const key = `${phase}|${f.work?.method ?? ""}|${phase === "standing" ? progress.toFixed(1) : ""}`;
      const u = it.u;
      if (key !== it.key) {
        const look = lookFor(phase, progress, f.work?.method);
        u.uPre.value.copy(look.pre); u.uPreRow.value.copy(look.preRow);
        u.uPost.value.copy(look.post); u.uPostRow.value.copy(look.postRow);
        u.uWet.value = look.wet; u.uRisk.value = look.risk;
        it.key = key;
      }
      u.uProgress.value = phase === "working" ? progress : 0;
      u.uPasses.value = f.work?.passes ?? 6;
      u.uPlanned.value = f.work && (phase === "stubble" || phase === "ripe" || phase === "working" || phase === "wet") ? 1 : 0;
      u.uTime.value = state.clock.elapsedTime;
      u.uHover.value += ((hovered === f.id ? 1 : 0) - u.uHover.value) * 0.25;
      u.uSel.value += ((selected === f.id ? 1 : 0) - u.uSel.value) * 0.25;
      const fl = flash.get(f.id);
      u.uFlash.value = fl ? Math.max(0, 1 - (now - fl) / 4000) * (0.6 + 0.4 * Math.sin(now / 120)) : 0;
    }
  });

  return (
    <group position={[0, 0.6, 0]}>
      {items.map((it) => (
        <mesh
          key={it.f.id}
          geometry={it.geo}
          material={it.mat}
          receiveShadow
          onPointerOver={(e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); onHover(it.f.id); document.body.style.cursor = "pointer"; }}
          onPointerOut={() => { onHover(null); document.body.style.cursor = ""; }}
          onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onPick(it.f.id); }}
        />
      ))}
    </group>
  );
}
