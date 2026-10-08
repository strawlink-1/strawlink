"""Clearance certificates: PDF with QR to the public verify page; status follows burn checks."""

from __future__ import annotations

import hashlib
import io

from common import settings, store

FOOTER = "Evidence to support an incentive claim. Not an official approval."


def cert_id_for(field_id: str, cleared_on: str) -> str:
    return "C" + hashlib.sha1(f"{field_id}|{cleared_on}".encode()).hexdigest()[:10].upper()


def verify_url(cert_id: str) -> str:
    return f"{settings.PUBLIC_WEB_URL.rstrip('/')}/verify/{cert_id}"


def render_pdf(cert: dict) -> bytes:
    from reportlab.graphics import renderPDF
    from reportlab.graphics.barcode.qr import QrCodeWidget
    from reportlab.graphics.shapes import Drawing
    from reportlab.lib.pagesizes import A5
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A5)
    w, h = A5
    c.setFillColorRGB(0.12, 0.16, 0.14)
    c.setFont("Helvetica-Bold", 18)
    c.drawString(36, h - 56, "StrawLink clearance certificate")
    c.setFont("Helvetica", 10)
    c.drawString(36, h - 74, f"Certificate {cert['cert_id']}")
    rows = [("Field", cert["field_id"]), ("Village", cert.get("village_name", "")),
            ("Cleared on", cert["cleared_on"]), ("Method", {"bale": "Baled and hauled", "seed": "Super Seeder (in-situ)"}.get(cert.get("method"), cert.get("method") or "—")),
            ("Machine", cert.get("machine_id") or "—"), ("Straw", f"{cert.get('straw_t', 0):.1f} t (estimate)")]
    y = h - 110
    for k, v in rows:
        c.setFont("Helvetica", 9)
        c.drawString(36, y, k.upper())
        c.setFont("Helvetica-Bold", 12)
        c.drawString(130, y, str(v))
        y -= 22
    c.setFont("Helvetica-Bold", 11)
    status = cert["status"]
    if status == "no_burn_detected":
        line = f"No burn scar detected in imagery of {', '.join(cert.get('image_dates', []))}"
    elif status == "burn_detected":
        line = "Satellite check found a possible burn scar after clearance."
    else:
        line = "Satellite no-burn check pending (needs 2 clear images after clearance)."
    c.drawString(36, y - 8, line[:90])
    qr = QrCodeWidget(verify_url(cert["cert_id"]))
    b = qr.getBounds()
    d = Drawing(110, 110, transform=[110 / (b[2] - b[0]), 0, 0, 110 / (b[3] - b[1]), 0, 0])
    d.add(qr)
    renderPDF.draw(d, c, w - 146, 60)
    c.setFont("Helvetica", 7)
    c.drawString(w - 146, 52, "Scan to verify")
    if cert.get("synthetic"):
        c.drawString(36, 76, "Demo data: field boundary and fleet are synthetic.")
    c.setFont("Helvetica-Oblique", 8)
    c.drawString(36, 40, FOOTER)
    c.showPage()
    c.save()
    return buf.getvalue()


def issue(field: dict, cleared_on: str, method: str | None, machine_id: str | None) -> dict:
    cid = cert_id_for(field["field_id"], cleared_on)
    cert = {"cert_id": cid, "field_id": field["field_id"], "village_name": field.get("village_name"),
            "village_id": field["village_id"], "cleared_on": cleared_on, "method": method,
            "machine_id": machine_id, "straw_t": float(field.get("straw_t", 0)), "status": "pending_check",
            "image_dates": [], "created_at": settings.now_iso(), "synthetic": True,
            "pdf_key": f"certificates/{cid}.pdf"}
    store.s3_put_bytes(cert["pdf_key"], render_pdf(cert), "application/pdf")
    store.put("certificates", cert)
    return cert


def apply_burn_status(cid: str, status: str, image_dates: list[str]) -> dict | None:
    cert = store.get("certificates", cert_id=cid)
    if not cert or status not in ("pending", "no_burn_detected", "burn_detected"):
        return None
    cert["status"] = "pending_check" if status == "pending" else status
    cert["image_dates"] = image_dates
    store.s3_put_bytes(cert["pdf_key"], render_pdf(cert), "application/pdf")
    store.put("certificates", cert)
    return cert


def public_view(cert: dict) -> dict:
    keep = ("cert_id", "field_id", "village_name", "cleared_on", "method", "machine_id", "status", "image_dates",
            "synthetic")
    return {**{k: cert.get(k) for k in keep}, "footer": FOOTER}
