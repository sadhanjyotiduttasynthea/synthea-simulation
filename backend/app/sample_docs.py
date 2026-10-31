"""Generate a clearly-labelled SYNTHETIC test PDF for exercising the paper-ingestion and
extraction workflow. Every page states that the document is not a real publication and
that all values are invented for software testing. It must never be cited.
"""
from __future__ import annotations

import io

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

BANNER = "SYNTHETIC TEST DOCUMENT - values invented for software testing; not a real publication. Do not cite."


def build_sample_pdf() -> bytes:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=20 * mm, rightMargin=20 * mm, topMargin=22 * mm, bottomMargin=18 * mm,
                            title="Rheology and thermal behaviour of pea protein isolate dispersions (synthetic test document)",
                            author="A. Testauthor; B. Placeholder; C. Example", subject="Synthea Simulation test document")
    ss = getSampleStyleSheet()
    h = ParagraphStyle("t", parent=ss["Title"], fontSize=17, leading=21)
    body = ParagraphStyle("b", parent=ss["BodyText"], fontSize=10, leading=13.5)
    sec = ParagraphStyle("s", parent=ss["Heading2"], fontSize=12, spaceBefore=8)
    small = ParagraphStyle("sm", parent=body, fontSize=8.5, textColor=colors.HexColor("#555555"))
    eq = ParagraphStyle("eq", parent=body, alignment=1, fontSize=11, spaceBefore=4, spaceAfter=4)

    def banner(canvas, d):
        canvas.saveState()
        canvas.setFillColor(colors.HexColor("#b91c1c"))
        canvas.setFont("Helvetica-Bold", 8)
        canvas.drawCentredString(A4[0] / 2, A4[1] - 12 * mm, BANNER)
        canvas.setFillColor(colors.HexColor("#666666"))
        canvas.setFont("Helvetica", 8)
        canvas.drawRightString(A4[0] - 20 * mm, 10 * mm, f"Page {d.page}")
        canvas.restoreState()

    s = [
        Paragraph("Synthea Test Documents, Vol. 1 (2026) 1-3", small),
        Paragraph("Rheology and thermal behaviour of pea protein isolate dispersions (synthetic test document)", h),
        Paragraph("A. Testauthor, B. Placeholder, C. Example", body),
        Paragraph("Synthea Simulation Test Laboratory (fictitious). Received 3 March 2026; accepted 1 June 2026. doi:10.0000/synthea.test.0001", small),
        Spacer(1, 6),
        Paragraph("<b>Abstract</b> - This synthetic document mimics the structure of a food-science article so that automated extraction can be tested. "
                  "Aqueous dispersions of pea protein isolate (PPI) at 10-20 % (w/w) were characterised by steady-shear rheology, differential scanning "
                  "calorimetry and transient hot-wire measurements. All numbers are invented.", body),
        Paragraph("2. Materials and methods", sec),
        Paragraph("Pea protein isolate (protein content 82.0 % on a dry basis, moisture content 6.5 %) was dispersed in deionised water at pH 7.0. "
                  "Flow curves were measured with a rotational rheometer (cone-plate, 40 mm) at 25 and 50 &deg;C between 0.1 and 100 s-1. "
                  "Thermal transitions were measured by DSC at a heating rate of 10 K/min. Thermal conductivity was measured with a transient hot-wire probe at 25 &deg;C. "
                  "Water holding capacity was determined by centrifugation (3000 g, 20 min).", body),
        Paragraph("3. Results", sec),
        Paragraph("The apparent viscosity of the 15 % (w/w) dispersion was 2.4 &plusmn; 0.2 Pa&middot;s at 10 s-1 and 25 &deg;C (n = 3), and decreased to 1.3 &plusmn; 0.1 Pa&middot;s at 50 &deg;C. "
                  "All dispersions were shear-thinning with an apparent yield stress, and the flow curves were fitted with the Herschel-Bulkley model:", body),
        Paragraph("&tau; = &tau;<sub>0</sub> + K &middot; &gamma;&#775;<super>n</super> &nbsp;&nbsp;&nbsp;&nbsp; (1)", eq),
        Paragraph("where &tau; is the shear stress (Pa), &tau;<sub>0</sub> the yield stress (Pa), K the consistency index (Pa&middot;s<super>n</super>), "
                  "&gamma;&#775; the shear rate (s-1) and n the flow behaviour index (-). The fitted parameters are given in Table 1; the model is valid for shear rates between 0.1 and 100 s-1.", body),
        PageBreak(),
        Paragraph("Table 1. Herschel-Bulkley parameters of PPI dispersions (synthetic values).", body),
    ]
    data = [["Concentration (% w/w)", "Temperature (°C)", "τ0 (Pa)", "K (Pa·s^n)", "n (-)", "R²"],
            ["10", "25", "4.2", "1.8", "0.62", "0.998"],
            ["15", "25", "18.5", "9.6", "0.48", "0.997"],
            ["15", "50", "12.1", "5.3", "0.51", "0.996"],
            ["20", "25", "55.0", "31.0", "0.39", "0.995"]]
    t = Table(data, colWidths=[38 * mm, 30 * mm, 22 * mm, 26 * mm, 18 * mm, 18 * mm])
    t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black), ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eeeeee")),
                           ("FONTSIZE", (0, 0), (-1, -1), 9), ("ALIGN", (0, 0), (-1, -1), "CENTER")]))
    s += [t, Spacer(1, 8),
          Paragraph("The temperature dependence of the apparent viscosity at 10 s-1 followed an Arrhenius-type relationship:", body),
          Paragraph("&eta; = A &middot; exp(E<sub>a</sub> / (R &middot; T)) &nbsp;&nbsp;&nbsp;&nbsp; (2)", eq),
          Paragraph("with a flow activation energy E<sub>a</sub> = 19.8 kJ/mol and A = 8.1 x 10<super>-4</super> Pa&middot;s for the 15 % dispersion between 25 and 50 &deg;C, where R is the gas constant and T the absolute temperature (K).", body),
          Paragraph("DSC thermograms showed a single endotherm with a denaturation temperature of 84.6 &plusmn; 0.4 &deg;C and a denaturation enthalpy of 9.2 J/g. "
                    "Heat-induced denaturation followed first-order kinetics, with a rate constant k = 2.1 x 10<super>-3</super> s-1 at 85 &deg;C and an activation energy of 250 kJ/mol.", body),
          Paragraph("The thermal conductivity of the 15 % dispersion was 0.52 W/(m&middot;K) at 25 &deg;C, and its specific heat capacity was 3.75 kJ/(kg&middot;K). "
                    "The water holding capacity of the isolate was 3.1 &plusmn; 0.2 g/g.", body),
          Paragraph("4. Conclusions", sec),
          Paragraph("The synthetic data set provides concentration- and temperature-dependent rheological parameters for testing. "
                    "Values outside 10-20 % (w/w), 25-50 &deg;C and 0.1-100 s-1 were not studied.", body),
          Spacer(1, 10),
          Paragraph(BANNER, small)]
    doc.build(s, onFirstPage=banner, onLaterPages=banner)
    return buf.getvalue()
