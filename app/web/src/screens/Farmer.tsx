import { useEffect, useRef, useState } from "react";
import { fmtDate, post } from "../api";
import { useApp, useFetch } from "../state";

type Msg = { ts: string; direction: "in" | "out"; body: string; body_en?: string | null; status?: string; channel?: string };

export function Farmer() {
  const { meta, date, version, bump } = useApp();
  const fields = meta?.demo_fields ?? ["F0001"];
  const [fid, setFid] = useState(fields[0]);
  const [lang, setLang] = useState<"pa" | "en">("pa");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const thread = useFetch<{ messages: Msg[] }>(`/messages?field_id=${fid}`, [version, fid]);
  const field = useFetch<{ village_name: string; slot?: { date: string; arrive: string; depart: string; method: string } | null; harvest_window?: { p50: string; source: string } }>(`/fields/${fid}?date=${date}`, [version, fid]);
  const [chat, setChat] = useState<{ q: string; a: string; tools: string[] }[]>([]);
  const [q, setQ] = useState("ਮੇਰੀ ਮਸ਼ੀਨ ਕਦੋਂ ਆਵੇਗੀ?");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [thread.data]);

  const send = async (t: string) => {
    if (!t.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await post("/farmer/message", { field_id: fid, text: t, plan_date: date });
      setText("");
      bump();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <h1>What the farmer sees</h1>
      <p className="lede">
        WhatsApp in Punjabi by default. Reply with a harvest date, “ਅੱਜ” (today) or 1 to confirm; questions go to the assistant, which only
        answers from the current plan. <span className="synthetic-tag">simulated thread</span>
      </p>
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <label className="muted" htmlFor="fsel" style={{ alignSelf: "center" }}>Demo field</label>
        <select id="fsel" className="btn" value={fid} onChange={(e) => setFid(e.target.value)}>
          {fields.map((f) => <option key={f}>{f}</option>)}
        </select>
        <div className="seg" role="group" aria-label="Language" style={{ display: "flex", border: "1px solid var(--line)", borderRadius: 10, padding: 3, background: "var(--surface)" }}>
          <button aria-pressed={lang === "pa"} onClick={() => setLang("pa")} className="pa">ਪੰਜਾਬੀ</button>
          <button aria-pressed={lang === "en"} onClick={() => setLang("en")}>English</button>
        </div>
      </div>
      <div className="farmer">
        <div className="phone" aria-label="WhatsApp thread">
          <header>
            <span>StrawLink · {field.data?.village_name ?? ""}</span>
            <span style={{ fontSize: 12, opacity: 0.8 }}>{fid}</span>
          </header>
          <div className="thread">
            {!thread.data?.messages.length && (
              <div className="bubble out" style={{ opacity: 0.7 }}>
                No messages yet. Messages arrive when a re-plan gives this field a slot.
              </div>
            )}
            {thread.data?.messages.map((m) => (
              <div key={m.ts} className={`bubble ${m.direction} ${lang === "pa" ? "pa" : ""}`}>
                {lang === "en" && m.body_en ? m.body_en : m.body}
                <small>{m.ts.slice(11, 16)} · {m.direction === "in" ? (m.channel ?? "farmer") : (m.status ?? "")}</small>
              </div>
            ))}
            <div ref={end} />
          </div>
          <form className="composer" onSubmit={(e) => { e.preventDefault(); send(text); }}>
            <input aria-label="Message" placeholder="Type a reply (e.g. 25/10)" value={text} onChange={(e) => setText(e.target.value)} disabled={busy} />
            <button className="btn primary" disabled={busy}>Send</button>
          </form>
        </div>
        <div style={{ display: "grid", gap: 16 }}>
          <div className="card">
            <h2>Current plan for {fid}</h2>
            {field.data?.slot ? (
              <p>
                {field.data.slot.method === "bale" ? "Baling crew" : "Super Seeder"} on <b>{fmtDate(field.data.slot.date)}</b>,{" "}
                <span className="num">{field.data.slot.arrive.slice(11, 16)}–{field.data.slot.depart.slice(11, 16)}</span>
              </p>
            ) : (
              <p className="muted">No slot in the current plan. Harvest {field.data?.harvest_window?.source === "confirmed" ? "confirmed" : "expected"} {fmtDate(field.data?.harvest_window?.p50)}.</p>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn" disabled={busy} onClick={() => send("ਅੱਜ ਕਟਾਈ ਹੋ ਗਈ")}>Send “harvest done today”</button>
              <button className="btn" disabled={busy} onClick={() => send("1")}>Send “1” (confirm slot)</button>
              <button className="btn" disabled={busy} onClick={async () => { setBusy(true); await post("/simulate/missed-call", { field_id: fid, plan_date: date }).catch((e) => setErr(String(e))); setBusy(false); bump(); }}>Simulate missed call</button>
            </div>
            {err && <div className="alert" style={{ marginTop: 8 }}>{err}</div>}
          </div>
          <div className="card">
            <h2>Ask the assistant</h2>
            <p className="muted" style={{ fontSize: 13 }}>Strands agent on Amazon Bedrock. Its tools read the StrawLink API; it never promises a time outside the plan.</p>
            <form style={{ display: "flex", gap: 8 }} onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                const r = await post<{ reply: string; tools_used: string[] }>("/assistant/chat", { field_id: fid, message: q });
                setChat((c) => [...c, { q, a: r.reply, tools: r.tools_used }]);
              } catch (e2) {
                setErr(String(e2));
              } finally {
                setBusy(false);
              }
            }}>
              <input className="btn pa" style={{ flex: 1, textAlign: "left" }} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Question" />
              <button className="btn primary" disabled={busy}>Ask</button>
            </form>
            {chat.map((c, i) => (
              <div key={i} style={{ marginTop: 12 }}>
                <div className="muted pa">{c.q}</div>
                <div className="pa" style={{ marginTop: 4 }}>{c.a}</div>
                <div className="muted num" style={{ fontSize: 11 }}>tools: {c.tools.join(", ") || "none"}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
