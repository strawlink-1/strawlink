import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtDate } from "../api";
import type { Cell, XZ } from "../sim/geo";
import { useStageMode, type Look } from "../sim/stage";
import { useWorld } from "../sim/world";
import { useFetch } from "../state";
import { Group, InBelow, InPanel, Legend, Seg, Tip } from "../ui/kit";
import { Scrubber } from "../ui/Transport";
import { legend } from "./common";

type Row = { fleet_scale: number; policy: "strawlink" | "baseline"; reach_rate: number; burned_fields_total: number; burned_fields_reached: number };
type Replay = { dates: string[]; cleared: Record<string, string>; burned: Record<string, string>; harvest: Record<string, string> };
type Policy = "strawlink" | "baseline";

const SCALES = [0.75, 1, 1.25];

function tally(r: Replay | null, at: string | undefined) {
  if (!r || !at) return { cleared: 0, burned: 0 };
  let cleared = 0, burned = 0;
  for (const id in r.cleared) if (r.cleared[id] <= at) cleared++;
  for (const id in r.burned) if (r.burned[id] <= at && !(r.cleared[id] && r.cleared[id] <= at)) burned++;
  return { cleared, burned };
}

/** Would it have worked in 2025? The real season replayed day by day, StrawLink against first-come booking. */
export function Results() {
  const { cells, geo } = useWorld();
  const bt = useFetch<{ results: Row[]; caveats: string[] }>("/backtest");
  const [scale, setScale] = useState(1);
  const [policy, setPolicy] = useState<Policy>("strawlink");
  const [d, setD] = useState(0);
  const [playing, setPlaying] = useState(false);
  const file = scale.toFixed(scale === 1 ? 1 : 2);
  const mine = useFetch<Replay>(`/backtest/replay?policy=strawlink&scale=${file}`, [scale]);
  const base = useFetch<Replay>(`/backtest/replay?policy=baseline&scale=${file}`, [scale]);
  const replay = policy === "strawlink" ? mine.data : base.data;
  const n = replay?.dates.length ?? 0;
  const at = replay?.dates[Math.min(d, Math.max(0, n - 1))];

  useEffect(() => {
    if (!playing || !n) return;
    const id = setInterval(() => setD((v) => (v >= n - 1 ? (setPlaying(false), v) : v + 1)), 500);
    return () => clearInterval(id);
  }, [playing, n]);

  const look = useCallback((c: Cell): Look => {
    if (!replay || !at) return "paddy";
    if (replay.cleared[c.id] && replay.cleared[c.id] <= at) return "soil";
    if (replay.burned[c.id] && replay.burned[c.id] <= at) return "burned";
    if (replay.harvest[c.id] && replay.harvest[c.id] <= at) return "straw";
    return "paddy";
  }, [replay, at]);
  const smoke = useMemo<XZ[]>(() => {
    if (!replay || !at) return [];
    const since = replay.dates[Math.max(0, d - 2)];
    return cells.filter((c) => replay.burned[c.id] && replay.burned[c.id] <= at && replay.burned[c.id] >= since && !(replay.cleared[c.id] && replay.cleared[c.id] <= at)).map((c) => [c.x, c.z] as XZ);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replay, at, d, cells.length]);
  useStageMode(() => ({ look, smoke, camera: { key: "results", polar: 0.8, azim: -0.15, dist: (geo?.span ?? 100) * 1.18 } }), [look, smoke, geo]);

  const rows = bt.data?.results ?? [];
  const by = (p: Policy, s: number) => rows.find((r) => r.policy === p && r.fleet_scale === s);
  const a = by("strawlink", scale), b = by("baseline", scale);
  const here = tally(mine.data, at), there = tally(base.data, at);
  const H = 112, y = (v: number) => H - 22 - (v / 0.6) * (H - 34);

  return (
    <>
      <InPanel>
        <h1>Would it have worked in 2025?</h1>
        <p className="lede">We replayed the real 2025 season on these fields, one day at a time, using only what was known on each day. A field counts as reached if it was cleared before the day it burned. Drag the date under the map.</p>
        <Group title="Field colours"><Legend items={legend(cells, look, ["paddy", "straw", "soil", "burned"], { soil: "Cleared in time", burned: "Burned (2025 imagery)", straw: "Harvested, straw on the field" })} /></Group>

        <Group title="Fields reached before they burned" aside="by fleet size">
          {bt.error && <p className="note warn">The backtest is not published yet.</p>}
          {rows.length > 0 && (
            <svg className="bars" viewBox={`0 0 300 ${H}`} role="img" aria-label="Reach rate by fleet size and policy">
              {[0, 0.2, 0.4, 0.6].map((g) => <g key={g}><line x1="26" x2="300" y1={y(g)} y2={y(g)} className="grid" /><text x="22" y={y(g) + 3} textAnchor="end">{g * 100}%</text></g>)}
              {SCALES.map((s, i) => {
                const gx = 40 + i * 88;
                return (
                  <g key={s} className={s === scale ? "" : "faded"}>
                    {(["strawlink", "baseline"] as const).map((p, j) => {
                      const r = by(p, s);
                      if (!r) return null;
                      return (
                        <g key={p}>
                          <rect x={gx + j * 32} y={y(r.reach_rate)} width="28" height={H - 22 - y(r.reach_rate)} rx="3" className={p === "strawlink" ? "bar on" : "bar base"} />
                          <text x={gx + j * 32 + 14} y={y(r.reach_rate) - 4} textAnchor="middle" className="val">{(r.reach_rate * 100).toFixed(1)}</text>
                        </g>
                      );
                    })}
                    <text x={gx + 30} y={H - 6} textAnchor="middle">{s}× fleet</text>
                  </g>
                );
              })}
            </svg>
          )}
          <div className="swatches"><span><i className="on" />StrawLink</span><span><i className="base" />First-come booking</span></div>
          <Seg label="Fleet size" value={scale} onChange={(v) => { setScale(v); setD(0); }} options={SCALES.map((s) => ({ v: s, label: `${s}× the fleet` }))} />
        </Group>

        <Group title="What this shows, honestly">
          {a && b && (
            <p className="note">
              With {scale}× the fleet, StrawLink reached <b>{a.burned_fields_reached}</b> of {a.burned_fields_total} fields that burned and first-come booking reached <b>{b.burned_fields_reached}</b>{" "}
              (<Tip text="Fields reached ÷ fields that burned, from the backtest result file.">{(a.reach_rate * 100).toFixed(1)}% against {(b.reach_rate * 100).toFixed(1)}%</Tip>).
              When both hear about a harvest at the same moment, that is close to a tie.
            </p>
          )}
          <p className="note">In 2025 most fields burned within about two days of harvest, so <b>knowing early</b> matters more than clever routing. That is what the forecast, the farmer's WhatsApp and the rain re-planning are for.</p>
          <details>
            <summary>Limits of this test</summary>
            <ul className="plain">
              {bt.data?.caveats.map((c) => <li key={c}>{c}</li>)}
              <li>Burn detection uses imagery only so far; adding NASA fire data will lower the burn count.</li>
            </ul>
          </details>
        </Group>
      </InPanel>

      <InBelow>
        <Scrubber
          playing={playing}
          onToggle={() => { if (!playing && d >= n - 1) setD(0); setPlaying((p) => !p); }}
          value={Math.min(d, Math.max(0, n - 1))} max={Math.max(1, n - 1)} onSeek={(v) => { setPlaying(false); setD(v); }}
          big={at ? `${fmtDate(at)} 2025` : "—"}
          sub={`${(policy === "strawlink" ? here : there).cleared} cleared · ${(policy === "strawlink" ? here : there).burned} burned`}
          right={
            <div className="versus">
              <span title="Fields cleared so far in the replay, both policies on the same day"><i className="on" />StrawLink <b className="num">{here.cleared}</b></span>
              <span><i className="base" />First-come <b className="num">{there.cleared}</b></span>
              <Seg label="Show on the map" value={policy} onChange={setPolicy} options={[{ v: "strawlink", label: "StrawLink" }, { v: "baseline", label: "First-come" }]} />
            </div>
          }
        />
      </InBelow>
    </>
  );
}
