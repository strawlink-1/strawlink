import { advance, Canvas, useFrame } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { fmtDate } from "../api";
import { DemoConsole } from "../components/DemoConsole";
import { WhyCard } from "../components/WhyCard";
import { useApp } from "../state";
import { CameraRig, type CamMode } from "./CameraRig";
import { clock, useClockSample } from "./clock";
import { Grass } from "./Grass";
import { Ground, ribbon, Roads, SkyAndLight, Villages } from "./Environment";
import { Fields } from "./Fields";
import { hhmm } from "./geo";
import { LabelProjector, Labels, setOverlay } from "./Labels";
import { Machines } from "./Machines";
import { fieldPhaseAt, poseAt, type FieldPhase, type World } from "./model";
import { PHASE_UI } from "./palette";
import { Plants, Rain } from "./Sites";
import { FOG_DENSITY } from "./fog";
import { Timeline } from "./Timeline";
import { useWorld } from "./useWorld";
import "./movie.css";

const SPEEDS = [2, 6, 15, 30];

const STEP_MODE = import.meta.env.DEV && new URLSearchParams(location.search).has("step");
// dev-only: lets automated checks step frames when the tab is in the background (rAF paused)
if (import.meta.env.DEV) (window as unknown as { __step: (n: number) => void }).__step = (n: number) => {
  for (let i = 0; i < n; i++) advance(performance.now() + i * 16.7, true);
};

export function MovieScreen() {
  const { meta, metaError, date } = useApp();
  const [policy, setPolicy] = useState<"strawlink" | "baseline">("strawlink");
  const { world, error, changes } = useWorld(policy);
  const [hovered, setHovered] = useState<string | null>(null);
  const [hoveredMachine, setHoveredMachine] = useState<string | null>(null);
  const [selField, setSelField] = useState<string | null>(null);
  const [selMachine, setSelMachine] = useState<string | null>(null);
  const [cam, setCam] = useState<CamMode>({ kind: "intro" });
  const [flash, setFlash] = useState(new Map<string, number>());
  const fog = useMemo(() => new THREE.Color("#d9d4c2"), []);
  const demo = new URLSearchParams(location.search).has("demo");

  // set the film's time window from the plan; start at now (IST) when the plan is for today
  useEffect(() => {
    if (!world) return;
    clock.min = world.dayStart;
    clock.max = world.dayEnd;
    const nowIst = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000);
    const today = nowIst.toISOString().slice(0, 10);
    if (clock.t < clock.min || clock.t > clock.max) clock.t = today === world.date ? nowIst.getHours() * 60 + nowIst.getMinutes() : world.dayStart + 20;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world?.dayStart, world?.dayEnd, world?.date]);

  // fields touched by the latest live change pulse cyan for a few seconds
  useEffect(() => {
    const c = changes[0];
    if (!c || c.kind === "first") return;
    setFlash((old) => {
      const n = new Map(old);
      for (const f of c.fields) n.set(f, performance.now());
      return n;
    });
  }, [changes]);

  const pickField = useCallback((id: string) => {
    setSelField(id);
    setSelMachine(null);
    const f = world?.fieldById.get(id);
    if (f) setCam({ kind: "focus", x: f.center[0], z: f.center[1], r: 260 });
  }, [world]);
  const pickMachine = useCallback((id: string) => {
    setSelMachine(id);
    setSelField(null);
    setCam({ kind: "follow", id });
  }, []);
  const toFree = useCallback(() => setCam((c) => (c.kind === "free" ? c : { kind: "free" })), []);

  if (metaError) return <div className="mv-msg">Can't reach the StrawLink API: {metaError}</div>;

  return (
    <div className="mv">
      <div className="mv-canvas">
        {world && (
          <Canvas
            frameloop={STEP_MODE ? "never" : "always"}
            shadows
            dpr={[1, 2]}
            gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.0, preserveDrawingBuffer: true }}
            camera={{ fov: 42, near: 2, far: 120000, position: [0, 4000, 6000] }}
            onCreated={({ scene, gl }) => {
              scene.fog = new THREE.FogExp2(fog.getHex(), FOG_DENSITY);
              if (import.meta.env.DEV) Object.assign(window, { __clock: clock, __gl: gl, __scene: scene });
            }}
            onPointerMissed={() => { setSelField(null); }}
          >
            <SkyAndLight fog={fog} extent={world.extent} />
            <Ground extent={world.extent} />
            <Roads ways={world.roads} />
            <RouteGlow world={world} machineId={selMachine} />
            <Villages world={world} />
            <Fields world={world} hovered={hovered} selected={selField} flash={flash} onHover={setHovered} onPick={pickField} />
            <Grass world={world} />
            <Machines world={world} selected={selMachine} onPick={pickMachine} onHover={setHoveredMachine} />
            <Plants world={world} />
            <Rain world={world} />
            <ClockDriver />
            <CameraRig world={world} mode={cam} onUserMove={toFree} />
            <LabelProjector />
          </Canvas>
        )}
        <div className="mv-labels" ref={setOverlay}>
          {world && <Labels world={world} hovered={hovered} hoveredMachine={hoveredMachine} selectedMachine={selMachine} onPickMachine={pickMachine} />}
        </div>
      </div>

      {!world && !error && <div className="mv-msg">Loading the block, today's plan and machines…</div>}
      {error && !world && <div className="mv-msg">Couldn't load the plan: {error}. Run a re-plan for {date} (add ?demo=1).</div>}

      {world && (
        <>
          {cam.kind === "intro" && <TitleCard world={world} />}
          <TopBar world={world} policy={policy} setPolicy={setPolicy} />
          <Legend world={world} />
          <Toasts changes={changes} />
          <div className="mv-cams" role="group" aria-label="Camera">
            <button aria-pressed={cam.kind === "intro"} onClick={() => setCam({ kind: "intro" })}>Opening shot</button>
            <button aria-pressed={cam.kind === "free"} onClick={() => { setSelMachine(null); setCam({ kind: "free" }); }}>Free camera</button>
            <button
              aria-pressed={cam.kind === "follow"}
              onClick={() => {
                const busy = world.machines.find((m) => m.stops.length && poseAt(m, clock.t).activity !== "idle") ?? world.machines.find((m) => m.stops.length);
                if (busy) pickMachine(busy.id);
              }}
            >
              Follow a machine
            </button>
          </div>
          <Timeline world={world} selected={selMachine} onPickMachine={pickMachine} />
          {(selField || selMachine) && (
            <aside className="mv-inspector" aria-label="Details">
              {selField && <WhyCard id={selField} onClose={() => setSelField(null)} />}
              {selMachine && <MachineCard world={world} id={selMachine} onClose={() => { setSelMachine(null); setCam({ kind: "free" }); }} onPickField={pickField} />}
            </aside>
          )}
        </>
      )}
      {demo && <DemoConsole />}
      {!meta && !metaError && <div className="mv-msg">Connecting…</div>}
    </div>
  );
}

/** The selected machine's road route for the rest of the day, glowing in its paint colour. */
function RouteGlow({ world, machineId }: { world: World; machineId: string | null }) {
  const m = world.machines.find((x) => x.id === machineId);
  const mesh = useMemo(() => {
    if (!m) return null;
    const lines = m.legs.filter((l) => l.kind === "drive").map((l) => (l as { path: [number, number][] }).path);
    const mat = new THREE.MeshBasicMaterial({ color: m.color, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false });
    const me = new THREE.Mesh(ribbon(lines, 7, 1.2), mat);
    me.renderOrder = 3;
    return me;
  }, [m]);
  useFrame(({ clock: c }) => {
    if (mesh) (mesh.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.35 * Math.sin(c.elapsedTime * 3);
  });
  return mesh ? <primitive object={mesh} /> : null;
}

/** Advances the film inside the render loop so time and motion stay in lock-step. */
function ClockDriver() {
  useFrame((_, dt) => clock.tick(Math.min(dt, 0.1)));
  return null;
}

function TitleCard({ world }: { world: World }) {
  const machines = world.machines.filter((m) => m.stops.length).length;
  const tonnes = world.totals.tonnes_planned;
  return (
    <div className="mv-title" aria-hidden>
      <small>{fmtDate(world.date)} · {world.villages.map((v) => v.name).join(" · ")}</small>
      <h1>
        {world.fields.length} paddy fields.{" "}
        {world.deadline ? `${Math.max(0, Math.round((Date.parse(world.deadline) - Date.parse(world.date)) / 86400000))} days to sow wheat.` : ""}
      </h1>
      <p>Today's plan sends {machines} machines to {world.totals.fields_planned} fields — {tonnes.toFixed(0)} tonnes of straw that won't be burned.</p>
    </div>
  );
}

function TopBar({ world, policy, setPolicy }: { world: World; policy: "strawlink" | "baseline"; setPolicy: (p: "strawlink" | "baseline") => void }) {
  const c = useClockSample(10);
  const working = world.machines.filter((m) => poseAt(m, c.t).activity === "work").length;
  const moving = world.machines.filter((m) => ["drive", "load", "unload"].includes(poseAt(m, c.t).activity)).length;
  return (
    <header className="mv-top">
      <div className="mv-brand">
        <b>StrawLink</b>
        <span>{fmtDate(world.date)} · Sangrur block</span>
      </div>
      <div className="mv-clock">
        <button className="mv-play" onClick={() => { if (!c.playing && c.t >= c.max) c.seek(c.min); c.playing = !c.playing; }} aria-label={c.playing ? "Pause" : "Play"}>
          {c.playing ? "❚❚" : "▶"}
        </button>
        <div className="mv-time">
          <b className="num">{hhmm(c.t)}</b>
          <small>{working} working · {moving} on the move</small>
        </div>
        <div className="mv-speed" role="group" aria-label="Playback speed">
          {SPEEDS.map((s) => (
            <button key={s} aria-pressed={c.speed === s} onClick={() => { c.speed = s; }} title={`${s} plan-minutes per second`}>{s}×</button>
          ))}
        </div>
      </div>
      <div className="mv-policy" role="group" aria-label="Plan">
        <button aria-pressed={policy === "strawlink"} onClick={() => setPolicy("strawlink")}>StrawLink plan</button>
        <button aria-pressed={policy === "baseline"} onClick={() => setPolicy("baseline")}>First-come</button>
      </div>
    </header>
  );
}

function Legend({ world }: { world: World }) {
  const c = useClockSample(4);
  const counts: Partial<Record<FieldPhase, number>> = {};
  let straw = 0;
  for (const f of world.fields) {
    const { phase } = fieldPhaseAt(f, c.t, world.date);
    counts[phase] = (counts[phase] ?? 0) + 1;
    if (phase === "baled" || phase === "seeded" || phase === "cleared") straw += f.straw;
  }
  const order: FieldPhase[] = ["standing", "ripe", "stubble", "working", "baled", "seeded", "cleared", "wet", "risk"];
  return (
    <aside className="mv-legend" aria-label="Field states">
      <div className="mv-kpi">
        <b className="num">{straw.toFixed(0)} t</b>
        <small title="Straw on fields baled or sown by this time in the plan (area × 6 t/ha assumption)">straw handled by {hhmm(c.t)}</small>
      </div>
      <div className="mv-kpi">
        <b className="num">{world.totals.fields_planned}</b>
        <small>fields in today's plan · {world.unassigned.size} waiting</small>
      </div>
      <ul>
        {order.filter((p) => counts[p]).map((p) => (
          <li key={p}><i style={{ background: PHASE_UI[p].color }} />{PHASE_UI[p].label}<span className="num">{counts[p]}</span></li>
        ))}
      </ul>
      <p className="mv-note">Parcels approximate · fleet &amp; plants synthetic</p>
    </aside>
  );
}

function Toasts({ changes }: { changes: { id: number; at: number; text: string; kind: string }[] }) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => force((x) => x + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  const live = changes.filter((c) => Date.now() - c.at < 9000);
  return (
    <div className="mv-toasts" aria-live="polite">
      {live.map((c) => (
        <div key={c.id} className={`mv-toast ${c.kind}`}>
          <i />{c.text}
        </div>
      ))}
    </div>
  );
}

function MachineCard({ world, id, onClose, onPickField }: { world: World; id: string; onClose: () => void; onPickField: (id: string) => void }) {
  const c = useClockSample(4);
  const m = world.machines.find((x) => x.id === id);
  if (!m) return null;
  const pose = poseAt(m, c.t);
  const total = m.stops.reduce((s, st) => s + (world.fieldById.get(st.fieldId)?.straw ?? 0), 0);
  return (
    <div className="mv-card">
      <div className="mv-card-head" style={{ ["--mc" as string]: m.color }}>
        <i />
        <div>
          <h2>{m.id}</h2>
          <small>{m.type === "baler_set" ? "Rake + square baler" : m.type === "seeder" ? "Super Seeder" : "Tractor-trolley"} · {m.operator}</small>
        </div>
        <button className="btn" onClick={onClose}>Close</button>
      </div>
      <p className="mv-card-now">
        Now: <b>{pose.activity === "work" ? `working ${Math.round(pose.progress * 100)}%` : pose.activity}</b>
        {pose.loaded ? " · carrying straw" : ""}
      </p>
      <p className="muted" style={{ fontSize: 13 }}>{m.stops.length} stops · {total.toFixed(1)} t straw in today's plan</p>
      <ol className="mv-stops">
        {m.stops.map((s) => {
          const f = world.fieldById.get(s.fieldId);
          const state = c.t >= s.depart ? "done" : c.t >= s.arrive ? "now" : "next";
          return (
            <li key={s.fieldId + s.arrive} className={state}>
              <button onClick={() => onPickField(s.fieldId)}>
                <span className="num">{hhmm(s.arrive)}–{hhmm(s.depart)}</span>
                <b>{s.fieldId}</b>
                <small>{f?.villageName} · {f?.straw.toFixed(1)} t{m.type === "truck" ? " · load" : ""}</small>
              </button>
            </li>
          );
        })}
      </ol>
      {!m.stops.length && <p className="muted">No stops for this machine in the current plan.</p>}
    </div>
  );
}
