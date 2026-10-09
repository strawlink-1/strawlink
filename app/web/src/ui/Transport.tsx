import { useEffect, useState, type ReactNode } from "react";
import { hhmm } from "../sim/dayplan";
import { useWorld } from "../sim/world";
import { Icon } from "./kit";

// speed slider: 0–100 on a log scale from 1 to 60 plan-minutes per second
const MIN = 1, MAX = 60;
const toSpeed = (pos: number) => Math.round(MIN * Math.pow(MAX / MIN, pos / 100));
const toPos = (speed: number) => (Math.log(speed / MIN) / Math.log(MAX / MIN)) * 100;

/** The current simulated time of day, re-read a few times a second. */
export function useNow() {
  const { clock } = useWorld();
  const [now, setNow] = useState(clock.current.t);
  useEffect(() => {
    const id = setInterval(() => setNow(clock.current.t), 200);
    return () => clearInterval(id);
  }, [clock]);
  return now;
}

/** Run, pause and scrub the simulated day, and choose how fast it runs. */
export function TimeBar() {
  const { day, clock, planning } = useWorld();
  const read = useNow();
  const now = day ? Math.min(day.t1, Math.max(day.t0, read)) : read;
  const [playing, setPlaying] = useState(clock.current.playing);
  const [speed, setSpeed] = useState(clock.current.speed);
  useEffect(() => {
    const id = setInterval(() => setPlaying(clock.current.playing), 200);
    return () => clearInterval(id);
  }, [clock]);

  if (!day) return <div className="timebar"><span className="muted">{planning ? "Working out today's plan…" : "No plan yet."}</span></div>;
  const none = day.tracks.length === 0;
  const ended = now >= day.t1 - 0.5;
  const toggle = () => {
    const c = clock.current;
    if (!c.playing && c.t >= day.t1 - 0.5) c.t = day.t0;
    c.playing = !c.playing;
    setPlaying(c.playing);
  };
  return (
    <div className="timebar">
      <button type="button" className="run" onClick={toggle} disabled={none}>
        <Icon name={playing ? "pause" : ended ? "restart" : "play"} size={16} fill={!ended || playing} />
        {playing ? "Pause" : ended ? "Run again" : now > day.t0 + 0.5 ? "Continue" : "Run the day"}
      </button>
      <div className="clock"><b>{hhmm(now)}</b><small>time of day</small></div>
      <div className="scrub">
        <input type="range" min={day.t0} max={day.t1} step={1} value={Math.round(now)} aria-label="Time of day"
               onChange={(e) => { clock.current.t = +e.target.value; }}
               style={{ "--fill": `${((now - day.t0) / (day.t1 - day.t0)) * 100}%` } as React.CSSProperties} />
        <div className="scrub-ends"><span>{hhmm(day.t0)}</span><span>{hhmm(day.t1)}</span></div>
      </div>
      <div className="speed">
        <label htmlFor="speed">Speed</label>
        <input id="speed" type="range" min={0} max={100} value={toPos(speed)}
               onChange={(e) => { const s = toSpeed(+e.target.value); clock.current.speed = s; setSpeed(s); }}
               style={{ "--fill": `${toPos(speed)}%` } as React.CSSProperties} />
        <output htmlFor="speed">1 second = {speed} min</output>
      </div>
    </div>
  );
}

/** A day-by-day scrubber under the map (forecast season, 2025 replay). */
export function Scrubber({ playing, onToggle, value, max, onSeek, big, sub, marks, right }: {
  playing: boolean; onToggle: () => void; value: number; max: number; onSeek: (v: number) => void;
  big: ReactNode; sub: ReactNode; marks?: { at: number; label: string; tone?: string }[]; right?: ReactNode;
}) {
  return (
    <div className="timebar">
      <button type="button" className="run" onClick={onToggle}>
        <Icon name={playing ? "pause" : "play"} size={16} fill />{playing ? "Pause" : "Play"}
      </button>
      <div className="clock"><b>{big}</b><small>{sub}</small></div>
      <div className="scrub">
        <input type="range" min={0} max={max} value={value} onChange={(e) => onSeek(+e.target.value)} aria-label="Day"
               style={{ "--fill": `${(value / (max || 1)) * 100}%` } as React.CSSProperties} />
        <div className="scrub-marks">
          {marks?.map((m) => <span key={m.label} className={m.tone ?? ""} style={{ left: `${(m.at / (max || 1)) * 100}%` }}>{m.label}</span>)}
        </div>
      </div>
      {right}
    </div>
  );
}
