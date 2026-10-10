"""Farmer assistant: Strands Agents + Bedrock. Tools call the StrawLink API (in-process
ASGI client), never the database directly."""

from __future__ import annotations

import re

from common import settings

SYSTEM = """You are StrawLink's assistant for paddy farmers in Punjab.
- Reply in the language the user writes in; default to Punjabi (Gurmukhi script).
- Answer only from tool results. If a tool does not give the answer, say you don't know and suggest
  the block coordinator.
- Never promise a date or time that is not in the current plan returned by get_pickup_slot.
- Never discuss fines, penalties, enforcement, or reporting anyone. Do not ask about burning.
- Keep replies short (2–4 sentences), plain, and practical."""


def _client():
    from fastapi.testclient import TestClient

    from api.main import app

    return TestClient(app)


def build_tools(default_field: str | None):
    from strands import tool

    def get(path: str) -> dict:
        r = _client().get(path)
        return r.json() if r.status_code == 200 else {"error": r.status_code, "detail": r.text[:200]}

    @tool
    def get_field_status(field_id: str = "") -> dict:
        """Current status, harvest window and readiness of a field.

        Args:
            field_id: Field ID like F0001. Leave empty for the farmer's own field.
        """
        d = get(f"/fields/{field_id or default_field}")
        return {k: d.get(k) for k in ("field_id", "village_name", "status", "harvest_window", "dry", "straw_t")}

    @tool
    def get_pickup_slot(field_id: str = "") -> dict:
        """The machine slot assigned to the field in the current plan (or none).

        Args:
            field_id: Field ID like F0001. Leave empty for the farmer's own field.
        """
        d = get(f"/fields/{field_id or default_field}")
        return {"field_id": d.get("field_id"), "slot": d.get("slot"), "unassigned_reason": d.get("unassigned_reason")}

    @tool
    def explain_route(field_id: str = "") -> dict:
        """Why the field was given its clearance route (bale or seed) and its queue priority.

        Args:
            field_id: Field ID like F0001. Leave empty for the farmer's own field.
        """
        d = get(f"/fields/{field_id or default_field}")
        return {k: d.get(k) for k in ("field_id", "route", "route_reason", "priority", "priority_parts", "days_left")}

    @tool
    def list_free_machines(village: str) -> dict:
        """Machines based in a village that are available and not fully booked today.

        Args:
            village: Village name, e.g. Alal.
        """
        ms = get("/machines").get("machines", [])
        v = village.strip().lower()
        return {"village": village, "machines": [
            {k: m.get(k) for k in ("machine_id", "type", "operator_name", "available", "stops_today")}
            for m in ms if str(m.get("village_name", "")).lower() == v and m.get("available")]}

    @tool
    def get_certificate(field_id: str = "") -> dict:
        """Clearance certificate status for a field, if it has been cleared.

        Args:
            field_id: Field ID like F0001. Leave empty for the farmer's own field.
        """
        d = get(f"/fields/{field_id or default_field}")
        cid = d.get("certificate_id")
        return get(f"/verify/{cid}") if cid else {"field_id": d.get("field_id"), "certificate": None}

    return [get_field_status, get_pickup_slot, explain_route, list_free_machines, get_certificate]


def chat(message: str, field_id: str | None) -> dict:
    from strands import Agent
    from strands.models import BedrockModel

    model = BedrockModel(model_id=settings.BEDROCK_MODEL_ID, region_name=settings.REGION, temperature=0.2,
                         max_tokens=500)
    ctx = f"The farmer's field is {field_id}. " if field_id else ""
    agent = Agent(model=model, tools=build_tools(field_id), system_prompt=SYSTEM + "\n" + ctx,
                  callback_handler=None)
    result = agent(message)
    tools_used = []
    for m in agent.messages:
        for c in m.get("content", []):
            if "toolUse" in c:
                tools_used.append(c["toolUse"]["name"])
    return {"reply": clean_reply(str(result)), "tools_used": tools_used, "field_id": field_id}


def clean_reply(text: str) -> str:
    """The words meant for the farmer. Some models (Amazon Nova) write their reasoning first,
    inside <thinking> tags; that is never part of the message."""
    text = re.sub(r"<thinking>.*?</thinking>", "", text, flags=re.S)
    return re.sub(r"</?thinking>", "", text).strip()
