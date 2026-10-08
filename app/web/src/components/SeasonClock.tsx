import { useMemo, useState } from "react";
import { daysBetween, fmtDate } from "../api";
import { useApp, useFetch } from "../state";

type Row = { village_id: string; week_start: string; tonnes_p10: number; tonnes_p50: number; tonnes_p90: number };

/**
 * Signature strip: the season from Oct 1 to the sowing deadline. Each bar is a week of expected
 * straw for the block (P50), with the P10–P90 range as a thin whisker. Today and the deadline are marked.
 */
export function SeasonClock() {
  const { meta, date } = useApp();
  const { data } = useFetch<{ issued_on: string; rows: Row[] }>(meta ? "/villages/forecast" : null);
  const [hover, setHover] = useState<number | null>(null);
  const deadline = String(meta?.params.sowing_deadline_default ?? "2026-11-15");
  const year = deadline.slice(0, 4);
  const start = `${year}-10-01`;
  const end = deadline;
  const span = daysBetween(start, end) + 7;

  const weeks = useMemo(() => {
    const m = new Map<string, { p10: number; p50: number; p90: number }>();
    for (const r of data?.rows ?? []) {
      const w = m.get(r.week_start) ?? { p10: 0, p50: 0, p90: 0 };
      // block totals: sum village P50; sum of quantiles is an upper/lower envelope, labelled as such
      w.p10 += r.tonnes_p10;
      w.p50 += r.tonnes_p50;
      w.p90 += r.tonnes_p90;
      m.set(r.week_start, w);
    }
    return [...m.entries()]
      .map(([wk, v]) => ({ wk, ...v }))
      .filter((w) => w.wk >= `${year}-09-24` && w.wk <= end)
      .sort((a, b) => a.wk.localeCompare(b.wk));
  }, [data, year, end]);

  const max = Math.max(1, ...weeks.map((w) => w.p90));
  const x = (d: string) => (Math.max(0, Math.min(span, daysBetween(start, d))) / span) * 100;
  const left = date ? daysBetween(date, deadline) : null;
  const H = 52;

  return (
    <div className="clock">
      <div className="clock-head">
        <h2>
          Season clock <span className="muted" style={{ fontWeight: 400 }}>· straw expected per week, whole block</span>
        </h2>
        {left !== null && (
          <div className="days-left" aria-live="polite">
            {left}
            <small>days to sowing deadline ({fmtDate(deadline)}) · assumption</small>
          </div>
        )}
      </div>
      <svg viewBox="0 0 100 74" preserveAspectRatio="none" role="img" aria-label="Weekly straw volume forecast across the season">
        <line x1="0" x2="100" y1={H} y2={H} stroke="var(--line)" strokeWidth="0.6" vectorEffect="non-scaling-stroke" />
        {weeks.map((w, i) => {
          const x0 = x(w.wk);
          const bw = (7 / span) * 100 - 0.4;
          const h50 = (w.p50 / max) * (H - 6);
          const y10 = H - (w.p10 / max) * (H - 6);
          const y90 = H - (w.p90 / max) * (H - 6);
          return (
            <g key={w.wk} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={x0} y={0} width={bw + 0.4} height={H} fill="transparent" />
              <rect x={x0 + 0.2} y={H - h50} width={bw} height={h50} rx="0.4" fill="var(--bale)" opacity={hover === null || hover === i ? 0.85 : 0.4} />
              <line x1={x0 + 0.2 + bw / 2} x2={x0 + 0.2 + bw / 2} y1={y10} y2={y90} stroke="var(--ink)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            </g>
          );
        })}
        {date && (
          <g>
            <line x1={x(date)} x2={x(date)} y1="-2" y2={H + 4} stroke="var(--ink)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </g>
        )}
        <line x1={x(deadline)} x2={x(deadline)} y1="-2" y2={H + 4} stroke="var(--risk)" strokeWidth="2" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      </svg>
      <div style={{ position: "relative", height: 16, font: "11px var(--mono)", color: "var(--muted)" }}>
        {["10-01", "10-15", "11-01", "11-15"].map((md) => (
          <span key={md} style={{ position: "absolute", left: `${x(`${year}-${md}`)}%`, transform: "translateX(-50%)" }}>
            {fmtDate(`${year}-${md}`)}
          </span>
        ))}
        {date && (
          <span style={{ position: "absolute", left: `${x(date)}%`, transform: "translateX(-50%)", color: "var(--ink)", fontWeight: 600, top: -2, background: "var(--surface)", padding: "0 4px" }}>
            plan day {fmtDate(date)}
          </span>
        )}
      </div>
      {hover !== null && weeks[hover] && (
        <div className="chip" style={{ marginTop: 4 }}>
          week of {fmtDate(weeks[hover].wk)}: <b className="num">{weeks[hover].p50.toFixed(0)} t</b> expected (sum of village
          P50) · range <span className="num">{weeks[hover].p10.toFixed(0)}–{weeks[hover].p90.toFixed(0)} t</span> · forecast issued{" "}
          {fmtDate(data?.issued_on)}
        </div>
      )}
      {!weeks.length && <div className="muted" style={{ fontSize: 12 }}>Weekly volumes appear once a live forecast is published.</div>}
    </div>
  );
}
