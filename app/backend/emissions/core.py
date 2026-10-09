"""What burning a given amount of straw in the field would emit:
tonnes × combustion_factor × emission_factor × assumed_burn_probability.

Every factor comes from config/params.yaml with its source. Shows "estimate pending source"
if the config does not carry cited values.
"""

from __future__ import annotations

from common import settings

FORMULA = "tonnes of straw × combustion factor × emission factor × assumed burn probability"


def estimate(tonnes: float, basis: str = "cleared") -> dict:
    """`basis` says what the tonnes are: fields marked cleared, or a tonnage the caller asked about."""
    p = settings.params()
    ef, prob, cf = p.get("emission_factors"), p.get("assumed_burn_probability"), p.get("combustion_factor")
    out = {"tonnes": round(tonnes, 2), "tonnes_cleared": round(tonnes, 2), "basis": basis, "formula": FORMULA}
    if not isinstance(ef, dict) or not isinstance(prob, (int, float)):
        return {**out, "status": "pending_source",
                "message": "Estimate pending source: emission factors and burn probability are not cited yet.",
                "emission_factors": ef, "assumed_burn_probability": prob}
    burnt = float(cf["value"]) if isinstance(cf, dict) else 1.0
    rows = []
    for pol, spec in ef.items():
        # g per kg of dry matter is the same number as kg per tonne
        kg = tonnes * burnt * float(spec["g_per_kg"]) * float(prob)
        rows.append({"pollutant": pol, "label": spec.get("label", pol), "kg": round(kg, 1), "kg_avoided": round(kg, 1),
                     "g_per_kg": spec["g_per_kg"], "source": spec.get("source")})
    return {**out, "status": "ok", "assumed_burn_probability": prob,
            "combustion_factor": cf if isinstance(cf, dict) else {"value": 1.0, "source": None},
            "note": "Upper estimate: every field is counted as one that would otherwise be burned, straw tonnes are "
                    "treated as dry matter, and the factors are published global averages for crop residue.",
            "pollutants": rows}
