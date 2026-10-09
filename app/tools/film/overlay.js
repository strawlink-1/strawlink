// Runs in the page (injected by film.mjs after every load). Everything the film draws on top of
// the app lives here: the "camera" (a transform on the app), subtitles, cards, the cursor, rings.
(() => {
  if (window.__ov) return;
  const css = `
    html, body { overflow: hidden !important; background: radial-gradient(1200px 700px at 50% 40%, #24362c, #121b16) !important; }
    #root { width: 1280px; height: 720px; border-radius: 14px; overflow: hidden; box-shadow: 0 30px 90px rgba(0,0,0,.5); background: #f3f5f0; will-change: transform; }
    #mapbar .muted, #mapbar .check { display: none !important; }
    #side { scrollbar-width: none; }
    #film { position: fixed; inset: 0; z-index: 99999; pointer-events: none; font-family: Inter, system-ui, sans-serif; }
    #film > * { position: absolute; }
    #film-ring { border: 3px solid #f2b632; border-radius: 14px; box-shadow: 0 0 0 5px rgba(242,182,50,.28); opacity: 0; }
    #film-ring.dim { box-shadow: 0 0 0 5px rgba(242,182,50,.28), 0 0 0 3000px rgba(18,27,22,.55); }
    #film-note { background: #17231c; color: #f6f7f2; font-weight: 600; font-size: 17px; line-height: 1.3; padding: 8px 14px; border-radius: 10px; opacity: 0; white-space: nowrap; box-shadow: 0 8px 24px rgba(0,0,0,.3); border: 1px solid #3a4d42; }
    #film-cursor { width: 30px; height: 30px; opacity: 0; transform-origin: 6px 4px; filter: drop-shadow(0 3px 5px rgba(0,0,0,.45)); }
    #film-card { inset: 0; display: flex; align-items: center; justify-content: center; opacity: 0; color: #f6f7f2; }
    #film-card.left { justify-content: flex-start; padding-left: 96px; }
    #film-card .in { max-width: 1040px; }
    #film-card .big { font-size: 68px; font-weight: 700; letter-spacing: -1.5px; line-height: 1.08; }
    #film-card .mid { font-size: 31px; font-weight: 500; line-height: 1.3; color: #dce6df; margin-top: 16px; max-width: 900px; }
    #film-card .small { font-size: 19px; font-weight: 500; color: #a9bcb0; margin-top: 22px; }
    #film-card .eyebrow { font-size: 19px; font-weight: 700; letter-spacing: 3px; text-transform: uppercase; color: #f2b632; margin-bottom: 16px; }
    #film-card .chips { margin-top: 26px; display: flex; flex-wrap: wrap; gap: 14px; }
    #film-card .chip { border: 2px solid #f2b632; color: #f2b632; border-radius: 999px; padding: 9px 22px; font-size: 25px; font-weight: 600; background: rgba(23,35,28,.6); }
    #film-card .chip.plain { border-color: #5d7366; color: #f6f7f2; }
    #film-card .logo { display: flex; align-items: center; gap: 22px; font-size: 104px; font-weight: 700; letter-spacing: -3px; }
    #film-card .mark { width: 92px; height: 92px; border-radius: 22px; background: linear-gradient(135deg, #f2b632 0 50%, #1f7a4d 50% 100%); }
    #film-card .cols { display: flex; gap: 28px; margin-top: 6px; }
    #film-card .col { width: 480px; border: 1px solid #3a4d42; background: rgba(23,35,28,.72); border-radius: 18px; padding: 26px 30px; }
    #film-card .col h4 { margin: 0 0 10px; font-size: 21px; letter-spacing: 3px; text-transform: uppercase; }
    #film-card .col p { margin: 0; font-size: 26px; line-height: 1.4; font-weight: 500; }
    #film-card .num { font-size: 150px; font-weight: 700; letter-spacing: -5px; line-height: 1; color: #f2b632; }
    #film-sub { left: 0; right: 0; bottom: 16px; display: flex; justify-content: center; opacity: 0; }
    #film-sub span { max-width: 1060px; background: rgba(13,20,16,.92); color: #fff; font-size: 22px; font-weight: 500; line-height: 1.35; padding: 9px 20px; border-radius: 12px; text-align: center; }
  `;
  const el = document.createElement("div");
  el.id = "film";
  el.innerHTML = `<style>${css}</style><div id="film-ring"></div><div id="film-note"></div><div id="film-card"></div>
    <svg id="film-cursor" viewBox="0 0 30 30"><path d="M5 3 L5 24 L11 18.5 L15 27 L19 25 L15 16.8 L23 16.5 Z" fill="#fff" stroke="#17231c" stroke-width="1.8" stroke-linejoin="round"/></svg>
    <div id="film-sub"><span></span></div>`;
  document.documentElement.appendChild(el);
  const $ = (id) => document.getElementById(id);
  let cam = { s: 1, x: 0, y: 0 }, cardHtml = "", subText = "", noteText = "";

  // The camera is a CSS transform on the app. Code inside the app that measures itself (the 3D
  // canvas sizes itself this way) must keep seeing its own layout, not the zoomed picture.
  const realRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    const r = realRect.call(this), root = document.getElementById("root");
    if (!root || !root.contains(this)) return r;
    return new DOMRect((r.left - cam.x) / cam.s, (r.top - cam.y) / cam.s, r.width / cam.s, r.height / cam.s);
  };

  window.__ov = {
    /** One frame of film state: camera, ring, note, cursor, card, subtitle. Coordinates are app-layout pixels. */
    apply(st) {
      cam = st.cam;
      const root = $("root");
      root.style.transformOrigin = "0 0";
      root.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.s})`;
      const P = (x, y) => [x * cam.s + cam.x, y * cam.s + cam.y];

      const ring = $("film-ring");
      ring.style.opacity = st.ring.o;
      ring.className = st.ring.dim ? "dim" : "";
      if (st.ring.o > 0) {
        const [x, y] = P(st.ring.x, st.ring.y), g = st.ring.pad ?? 6;
        ring.style.left = `${x - g}px`; ring.style.top = `${y - g}px`;
        ring.style.width = `${st.ring.w * cam.s + 2 * g - 6}px`; ring.style.height = `${st.ring.h * cam.s + 2 * g - 6}px`;
      }
      const note = $("film-note");
      note.style.opacity = st.note.o;
      if (st.note.text !== noteText) { noteText = st.note.text; note.textContent = noteText; }
      if (st.note.o > 0) { const [x, y] = P(st.note.x, st.note.y); note.style.left = `${x}px`; note.style.top = `${y}px`; }

      const cur = $("film-cursor");
      cur.style.opacity = st.cur.o;
      const [cx, cy] = P(st.cur.x, st.cur.y);
      cur.style.left = `${cx - 5}px`; cur.style.top = `${cy - 3}px`;
      cur.style.transform = `scale(${1 - 0.22 * st.cur.press})`;

      const card = $("film-card");
      card.style.opacity = st.card.o;
      card.style.background = `rgba(18, 27, 22, ${st.card.bg})`;
      card.className = st.card.cls || "";
      if (st.card.html !== cardHtml) { cardHtml = st.card.html; card.innerHTML = cardHtml; }
      card.querySelectorAll("[data-k]").forEach((e) => {
        const o = st.card.k[+e.dataset.k] ?? 0;
        e.style.opacity = o; e.style.transform = `translateY(${(1 - o) * 14}px)`;
      });

      const sub = $("film-sub");
      sub.style.opacity = st.sub.o;
      if (st.sub.text !== subText) { subText = st.sub.text; sub.firstElementChild.textContent = subText; }
    },
    /** An element's box in app-layout pixels (the camera's zoom undone). */
    rect(e) {
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    },
    q: (sel, text) => [...document.querySelectorAll(sel)].find((e) => !text || e.textContent.trim().includes(text)) ?? null,
    slider: (label) => [...document.querySelectorAll(".slider")].find((s) => s.querySelector("label")?.textContent.trim() === label)?.querySelector("input[type=range]") ?? null,
    set(e, v) {
      if (!e) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(e, String(v));
      e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    /** Where a range input's thumb is, in app-layout pixels, plus its range. */
    thumb(e) {
      const r = this.rect(e), min = +e.min, max = +e.max;
      return { x0: r.x + 9, x1: r.x + r.w - 9, y: r.y + r.h / 2, min, max, value: +e.value };
    },
    machines: () => [...document.querySelectorAll(".machines button")].map((b) => [b.querySelector("b")?.textContent ?? "", b.querySelector("span")?.textContent ?? ""]),
    status: () => document.querySelector(".status")?.textContent ?? "",
  };
})();
