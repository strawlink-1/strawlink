import { useEffect, useRef, useState } from "react";
import { fmtDate, fmtTime, machineName, post } from "../api";
import { useStageMode } from "../sim/stage";
import { useWorld } from "../sim/world";
import { useApp, useFetch } from "../state";
import { Group, InPanel, Seg } from "../ui/kit";
import { byStatus } from "./common";

type Msg = { ts: string; direction: "in" | "out"; body: string; body_en?: string | null; status?: string; channel?: string };
type FieldInfo = {
  village_name: string; cleared_on?: string | null; certificate_id?: string | null;
  slot?: { date: string; machine_id: string; arrive: string; depart: string; method: string } | null;
  harvest_window?: { p50: string; source: string } | null;
};

const QUICK = [
  { text: "ਅੱਜ ਕਟਾਈ ਹੋ ਗਈ", en: "Harvest done today" },
  { text: "1", en: "Confirm my slot" },
  { text: "ਮੇਰੀ ਮਸ਼ੀਨ ਕਦੋਂ ਆਵੇਗੀ?", en: "When will my machine come?" },
];

/** What a farmer sees: a WhatsApp thread in Punjabi, a time slot, and a clearance certificate. */
export function Farmers() {
  const { cellById, meta, selected, select, say, refresh, today } = useWorld();
  const { version } = useApp();
  const demo = meta?.demo_fields ?? [];
  const [fid, setFid] = useState(selected ?? demo[0] ?? "F0001");
  const [lang, setLang] = useState<"pa" | "en">("pa");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (selected) { setFid(selected); select(null); } }, [selected, select]);

  const thread = useFetch<{ messages: Msg[] }>(`/messages?field_id=${fid}`, [version, fid]);
  const info = useFetch<FieldInfo>(today ? `/fields/${fid}?date=${today}` : null, [version, fid]);
  const cell = cellById.get(fid);
  useStageMode(() => ({
    look: byStatus,
    pin: fid,
    camera: { key: `farmer-${fid}`, target: cell ? [cell.x, cell.z] : undefined, dist: 28, polar: 0.95, azim: -0.4 },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [fid, !!cell]);

  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [thread.data]);

  const send = async (t: string) => {
    if (!t.trim() || busy) return;
    setBusy(true);
    try {
      await post("/farmer/message", { field_id: fid, text: t, plan_date: today });
      setText("");
      refresh();
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      say(msg.includes("404") ? "This field has no phone number on file." : "Answering questions needs the assistant on Amazon Bedrock (the deployed API).");
    } finally {
      setBusy(false);
    }
  };
  // stored actions (unlike the simulator's sliders, these change the saved plan until "start over")
  const act = async (path: string, body: object, done: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await post(path, body);
      refresh();
      say(done);
    } catch (e) {
      say(`That did not work: ${String((e as Error).message ?? e).slice(0, 90)}`);
    } finally {
      setBusy(false);
    }
  };
  const f = info.data;

  return (
    <InPanel>
      <h1>What the farmer sees</h1>
      <p className="lede">No app to install. The farmer gets a WhatsApp message in Punjabi with a time slot, and can answer with a harvest date, a missed call, or a question. The pin on the map is this farmer's field.</p>

      <div className="chips">
        {[...new Set([...demo, fid])].map((id) => <button key={id} type="button" className="chip" aria-pressed={fid === id} onClick={() => setFid(id)}>Field {id}</button>)}
      </div>
      <Seg label="Language" value={lang} onChange={setLang} options={[{ v: "pa", label: <span className="pa">ਪੰਜਾਬੀ</span> }, { v: "en", label: "English" }]} />

      <div className="phone" aria-label="WhatsApp thread">
        <header><b>StrawLink</b><span>{f?.village_name ?? cell?.props.village_name} · field {fid}</span></header>
        <div className="thread">
          {!thread.data?.messages.length && <div className="bubble out quiet">No messages yet. Send one of the replies below; a harvest date makes the planner re-plan (about 10 seconds).</div>}
          {thread.data?.messages.map((m) => (
            <div key={m.ts} className={`bubble ${m.direction} ${lang === "pa" ? "pa" : ""}`}>
              {lang === "en" && m.body_en ? m.body_en : m.body}
              <small>{m.ts.slice(11, 16)} · {m.direction === "in" ? m.channel ?? "farmer" : m.status ?? "sent"}</small>
            </div>
          ))}
          <div ref={end} />
        </div>
        <div className="quick">
          {QUICK.map((q) => <button key={q.text} type="button" className="chip pa" disabled={busy} onClick={() => send(q.text)} title={q.en}>{lang === "pa" ? q.text : q.en}</button>)}
        </div>
        <form className="composer" onSubmit={(e) => { e.preventDefault(); send(text); }}>
          <input aria-label="Message" placeholder="Reply, e.g. 25/10" value={text} onChange={(e) => setText(e.target.value)} disabled={busy} />
          <button type="submit" disabled={busy}>{busy ? "…" : "Send"}</button>
        </form>
      </div>
      <p className="note">Simulated thread. On AWS the same code runs behind the Twilio WhatsApp webhook; Bedrock translates and answers only from the current plan.</p>

      <Group title="This field in the saved plan">
        {f?.slot ? (
          <p className="note"><b>{machineName(f.slot.machine_id)}</b> comes on {fmtDate(f.slot.date)}, <span className="num">{fmtTime(f.slot.arrive)}–{fmtTime(f.slot.depart)}</span> ({f.slot.method === "bale" ? "baling" : "Super Seeder"}).</p>
        ) : f?.cleared_on ? (
          <p className="note">Cleared on {fmtDate(f.cleared_on)}.</p>
        ) : (
          <p className="note">No slot yet. Harvest {f?.harvest_window?.source === "confirmed" ? "confirmed for" : "expected"} {fmtDate(f?.harvest_window?.p50)}.</p>
        )}
        {f?.certificate_id
          ? <a className="btn ghost" href={`/verify/${f.certificate_id}`} target="_blank" rel="noreferrer">Open clearance certificate</a>
          : <p className="note">Once the field is cleared the farmer receives a certificate with a QR code — evidence to support an incentive claim.</p>}
        {f && !f.cleared_on && (
          <button type="button" className="btn ghost" disabled={busy}
                  onClick={() => act(`/fields/${fid}/cleared`, { date: today }, "Field marked cleared. A certificate was issued.")}>
            The machine has finished: mark cleared
          </button>
        )}
      </Group>
      <p className="note">
        <button type="button" className="link" disabled={busy}
                onClick={() => act("/demo/reset", {}, "Started over: messages, confirmations and certificates removed.")}>
          Start the demo over
        </button>{" "}
        removes the messages, confirmations, cleared marks and certificates made on this page, then re-plans.
      </p>
    </InPanel>
  );
}
