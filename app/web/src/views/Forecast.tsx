import { useCallback, useEffect, useMemo, useState } from "react";
import { daysBetween, fmtDate } from "../api";
import type { Cell } from "../sim/geo";
import { useStageMode, type Look } from "../sim/stage";
import { useWorld } from "../sim/world";
import { useFetch } from "../state";
import { Count, Group, InBelow, InPanel, Legend, Stat, Tip } from "../ui/kit";
import { Scrubber } from "../ui/Transport";
import { addDays, legend } from "./common";

type Row = { village_id: string; week_start: string; tonnes_p10: number; tonnes_p50: number; tonnes_p90: number };
type Backtest = { results: { policy: string; fleet_scale: number; window_coverage: number | null }[] };

/** When will each field be harvested? Drag the date and the block turns from green to gold. */
export function Forecast() {
  const { cells, meta, today, geo } = useWorld();
  const deadline = String(meta?.params.sowing_deadline_default ?? `${today.slice(0, 4)}-11-15`);
  const start = `${deadline.slice(0, 4)}-10-01`;
  const span = Math.max(1, daysBetween(start, deadline));
  const [d, setD] = useState(() => Math.min(span, Math.max(0, daysBetween(start, today))));
  const [playing, setPlaying] = useState(false);
  const day = addDays(start, d);
  const volumes = useFetch<{ issued_on: string; rows: Row[] }>("/villages/forecast");
  const backtest = useFetch<Backtest>("/backtest");

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setD((v) => (v >= span ? (setPlaying(false), v) : v + 1)), 450);
    return () => clearInterval(id);
  }, [playing, span]);

  const look = useCallback((c: Cell): Look => {
    const hw = c.props.harvest_window;
    if (!hw) return "paddy";
    return day >= hw.p50 ? "straw" : day >= hw.p10 ? "ripe" : "paddy";
  }, [day]);
  useStageMode(() => ({ look, camera: { key: "forecast", polar: 0.7, azim: 0.1, dist: (geo?.span ?? 100) * 1.18 } }), [look, geo]);

  const cut = cells.filter((c) => c.props.harvest_window && day >= c.props.harvest_window.p50);
  const weeks = useMemo(() => {
    const m = new Map<string, { p10: number; p50: number; p90: number }>();
    for (const r of volumes.data?.rows ?? []) {
      if (r.week_start < addDays(start, -7) || r.week_start > deadline) continue;
      const w = m.get(r.week_start) ?? { p10: 0, p50: 0, p90: 0 };
      w.p10 += r.tonnes_p10; w.p50 += r.tonnes_p50; w.p90 += r.tonnes_p90;
      m.set(r.week_start, w);
    }
    return [...m.entries()].map(([wk, v]) => ({ wk, ...v })).sort((a, b) => a.wk.localeCompare(b.wk));
  }, [volumes.data, start, deadline]);
  const max = Math.max(1, ...weeks.map((w) => w.p90));
  const coverage = backtest.data?.results.find((r) => r.policy === "strawlink" && r.fleet_scale === 1)?.window_coverage ?? null;
  const mae = meta?.forecast_report?.validation?.p50_mae_days;

  return (
    <>
      <InPanel>
        <h1>When will each field be harvested?</h1>
        <p className="lede">Satellite images show each field turning from green to gold. A model trained on four past seasons predicts the harvest date, so machines can be lined up before the straw is on the ground.</p>
        <div className="stat-row">
          <Stat k={`harvested by ${fmtDate(day)}`} v={<><Count value={cut.length} /><small> / {cells.length}</small></>} tip="Fields whose forecast harvest date is on or before the date on the slider under the map." />
          <Stat k="straw on the ground" v={<Count value={cut.reduce((s, c) => s + c.props.straw_t, 0)} />} unit="t" tone="warn" tip="Straw on those fields: field area × straw per hectare, an assumption." />
        </div>
        <Group title="Field colours"><Legend items={legend(cells, look, ["paddy", "ripe", "straw"], { straw: "Harvested, straw on the field" })} /></Group>

        <Group title="Straw arriving each week" aside="whole block">
          <svg className="bars" viewBox="0 0 300 96" role="img" aria-label="Expected straw per week">
            {weeks.map((w, i) => {
              const bw = 300 / weeks.length, x = i * bw + 4, h = (v: number) => (v / max) * 70;
              const on = day >= w.wk && day < addDays(w.wk, 7);
              return (
                <g key={w.wk}>
                  <title>{`Week of ${fmtDate(w.wk)}: ${w.p50.toFixed(0)} t likely (range ${w.p10.toFixed(0)}–${w.p90.toFixed(0)} t)`}</title>
                  <rect x={x} y={78 - h(w.p50)} width={bw - 8} height={Math.max(1, h(w.p50))} rx="3" className={on ? "bar on" : "bar"} />
                  <line x1={x + (bw - 8) / 2} x2={x + (bw - 8) / 2} y1={78 - h(w.p90)} y2={78 - h(w.p10)} className="whisker" />
                  <text x={x + (bw - 8) / 2} y="92" textAnchor="middle">{fmtDate(w.wk)}</text>
                </g>
              );
            })}
          </svg>
          <p className="note">Bars: likely tonnes. Lines: the likely range. Forecast issued {fmtDate(volumes.data?.issued_on)}.</p>
        </Group>

        <Group title="How good is the forecast?">
          <p className="note">
            {mae != null && <>Typically <b>{mae} days</b> off on the 2025 season. </>}
            {coverage != null && (
              <>Its “80% sure” date range held only <Tip text="Share of 2025 forecasts whose range contained the real harvest date. A well-calibrated range would be near 80%."><b>{Math.round(coverage * 100)}%</b></Tip> of real harvests, so the range is too narrow and still needs widening. </>
            )}
            A farmer's own message always overrides the forecast.
          </p>
        </Group>
      </InPanel>

      <InBelow>
        <Scrubber
          playing={playing}
          onToggle={() => { if (!playing && d >= span) setD(0); setPlaying((p) => !p); }}
          value={d} max={span} onSeek={(v) => { setPlaying(false); setD(v); }}
          big={fmtDate(day)}
          sub={`${cut.length} of ${cells.length} harvested`}
          marks={[{ at: Math.min(span, Math.max(0, daysBetween(start, today))), label: "plan day" }, { at: span, label: "sowing deadline", tone: "risk" }]}
        />
      </InBelow>
    </>
  );
}
