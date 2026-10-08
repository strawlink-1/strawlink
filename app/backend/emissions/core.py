"""Emissions avoided estimate: tonnes_cleared × emission_factor × assumed_burn_probability.

Shows "estimate pending source" until config/params.yaml carries cited values.
"""

from __future__ import annotations

from common import settings

FORMULA = "tonnes_cleared × emission_factor × assumed_burn_probability"


def estimate(tonnes_cleared: float) -> dict:
    p = settings.params()
    ef, prob = p.get("emission_factors"), p.get("assumed_burn_probability")
    out = {"tonnes_cleared": round(tonnes_cleared, 2), "formula": FORMULA}
    if not isinstance(ef, dict) or not isinstance(prob, (int, float)):
        return {**out, "status": "pending_source",
                "message": "Estimate pending source: emission factors and burn probability are not cited yet.",
                "emission_factors": ef, "assumed_burn_probability": prob}
    # expected shape: {pollutant: {g_per_kg: float, source: str}}
    rows = []
    for pol, spec in ef.items():
        kg = tonnes_cleared * 1000 * float(spec["g_per_kg"]) / 1000 * float(prob)
        rows.append({"pollutant": pol, "kg_avoided": round(kg, 1), "g_per_kg": spec["g_per_kg"],
                     "source": spec.get("source")})
    return {**out, "status": "ok", "assumed_burn_probability": prob, "pollutants": rows}
