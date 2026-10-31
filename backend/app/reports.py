"""PDF report generation (ReportLab)."""
from __future__ import annotations

import io
from datetime import datetime, timezone

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import ListFlowable, ListItem, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

RED = colors.HexColor("#b91c1c")
GREY = colors.HexColor("#4b5563")

STANDARD_LIMITATIONS = [
    "Nutritional composition and raw-material cost are exact linear mass balances of the library values; they are only as reliable as those values. Values labelled 'illustrative' are placeholders for demonstration.",
    "Thermophysical properties use the Choi & Okos (1986) composition model (0-150 degC); porosity and phase changes are neglected.",
    "Rheology-dependent results (pipe, die and nozzle pressure) require measured Herschel-Bulkley parameters; they are not inferred from ingredient data.",
    "Surrogate-model predictions (Gaussian process) are reported with uncertainty and must be validated experimentally. Synthetic demonstration data have no physical meaning.",
    "Process simulation consists of steady-state lumped mass and energy balances, not CFD or multiphysics simulation.",
    "Experimental cost-saving scenarios are illustrative calculations based on user-entered assumptions, not measured outcomes.",
    "Simulation supports decision-making; it does not replace physical validation.",
]


def _esc(s) -> str:
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def build_pdf(payload: dict) -> bytes:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=16 * mm, rightMargin=16 * mm, topMargin=16 * mm, bottomMargin=16 * mm,
                            title=payload.get("title", "Synthea Simulation report"))
    ss = getSampleStyleSheet()
    h1 = ParagraphStyle("h1", parent=ss["Heading1"], textColor=colors.black, fontSize=18, spaceAfter=4)
    h2 = ParagraphStyle("h2", parent=ss["Heading2"], textColor=RED, fontSize=12.5, spaceBefore=10, spaceAfter=4)
    body = ParagraphStyle("b", parent=ss["BodyText"], fontSize=9, leading=12)
    small = ParagraphStyle("s", parent=body, fontSize=7.5, textColor=GREY, leading=10)
    cell = ParagraphStyle("c", parent=body, fontSize=7.8, leading=9.5)
    story = [
        Paragraph("SYNTHEA SIMULATION", ParagraphStyle("brand", parent=small, textColor=RED, fontSize=8)),
        Paragraph(_esc(payload.get("title", "Formulation report")), h1),
        Paragraph(f"Project: {_esc(payload.get('project', '-'))} &nbsp;|&nbsp; Generated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}", small),
        Spacer(1, 6),
    ]
    for sec in payload.get("sections", []):
        story.append(Paragraph(_esc(sec.get("title", "")), h2))
        for p in sec.get("paragraphs", []):
            story.append(Paragraph(_esc(p), body))
            story.append(Spacer(1, 3))
        for t in sec.get("tables", []):
            headers = t.get("headers", [])
            rows = t.get("rows", [])
            data = [[Paragraph(f"<b>{_esc(h)}</b>", cell) for h in headers]] + [[Paragraph(_esc(c if c is not None else "-"), cell) for c in r] for r in rows]
            if not data or not data[0]:
                continue
            ncol = max(len(r) for r in data)
            width = (A4[0] - 32 * mm) / ncol
            tbl = Table(data, colWidths=[width] * ncol, repeatRows=1)
            tbl.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f3f4f6")),
                ("LINEBELOW", (0, 0), (-1, 0), 0.8, colors.black),
                ("LINEBELOW", (0, 1), (-1, -1), 0.25, colors.HexColor("#d1d5db")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
            ]))
            if t.get("caption"):
                story.append(Paragraph(_esc(t["caption"]), small))
            story.append(tbl)
            story.append(Spacer(1, 5))
        if sec.get("bullets"):
            story.append(ListFlowable([ListItem(Paragraph(_esc(b), body), leftIndent=8) for b in sec["bullets"]], bulletType="bullet", start="-", leftIndent=8))
    story.append(Paragraph("Scientific assumptions and limitations", h2))
    story.append(ListFlowable([ListItem(Paragraph(_esc(b), body), leftIndent=8) for b in STANDARD_LIMITATIONS], bulletType="bullet", start="-", leftIndent=8))
    story.append(Spacer(1, 8))
    story.append(Paragraph("Data provenance legend: MEASURED (experimental), LITERATURE (published reference), CALCULATED (engine), PREDICTED (model), ILLUSTRATIVE (assumption/placeholder), SYNTHETIC (generated demo data), MISSING.", small))

    def footer(canvas, d):
        canvas.saveState()
        canvas.setFont("Helvetica", 7)
        canvas.setFillColor(GREY)
        canvas.drawString(16 * mm, 9 * mm, "Synthea Simulation - computational decision support; validate experimentally.")
        canvas.drawRightString(A4[0] - 16 * mm, 9 * mm, f"Page {d.page}")
        canvas.restoreState()

    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return buf.getvalue()
