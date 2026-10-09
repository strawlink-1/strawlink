"""Connect a Twilio WhatsApp sandbox to the deployed StrawLink API.

    python app/tools/setup_twilio.py

Asks for the Twilio account SID, auth token, sandbox number and your own phone number, and stores
them in AWS Systems Manager (encrypted). Nothing is written to the repository or printed back.
Your phone is attached to one field, so messages for that field reach you and your replies are
read as that farmer's.

Before running: `aws login --profile strawlink` (or set AWS_PROFILE), and join the sandbox from
your phone by sending Twilio's join code to the sandbox number on WhatsApp.
"""

from __future__ import annotations

import getpass
import json
import os
import subprocess
import tempfile
import urllib.request

REGION = os.environ.get("REGION", "ap-south-1")
STACK = os.environ.get("STACK", "strawlink")
ENV = {**os.environ, "AWS_PROFILE": os.environ.get("AWS_PROFILE", "strawlink"), "MSYS_NO_PATHCONV": "1"}


def aws(*args: str) -> str:
    r = subprocess.run(["aws", *args, "--region", REGION], env=ENV, capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"AWS said: {r.stderr.strip()[:300]}\nIs the login still valid? Try: aws login --profile strawlink")
    return r.stdout.strip()


def store(name: str, value: dict) -> None:
    """Encrypted parameter; the value goes through a temporary file, not the command line."""
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        f.write(json.dumps(value))
    try:
        aws("ssm", "put-parameter", "--name", name, "--type", "SecureString", "--overwrite", "--value", "file://" + f.name.replace("\\", "/"))
    finally:
        os.unlink(f.name)


def phone(text: str) -> str:
    p = "".join(c for c in text if c.isdigit() or c == "+")
    if not p.startswith("+") or len(p) < 9:
        raise SystemExit("Phone numbers need the country code, for example +9198xxxxxxxx")
    return p


def main() -> None:
    api = aws("cloudformation", "describe-stacks", "--stack-name", STACK,
              "--query", "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue", "--output", "text")
    with urllib.request.urlopen(f"{api}/plan", timeout=30) as r:
        plan = json.load(r)
    stops = sorted((s["arrive"], s["field_id"], a["machine_id"]) for a in plan["assignments"] if a["type"] != "truck" for s in a["stops"])
    suggested = stops[0][1] if stops else "F0001"

    print("Twilio console → Account Info")
    sid = input("  Account SID (starts with AC): ").strip()
    token = getpass.getpass("  Auth token (hidden as you type): ").strip()
    print("Twilio console → Messaging → Try it out → Send a WhatsApp message")
    sandbox = phone(input("  Sandbox number [+14155238886]: ").strip() or "+14155238886")
    mine = phone(input("Your own WhatsApp number, with country code: ").strip())
    field = input(f"Field your phone stands for [{suggested}, a machine comes there today]: ").strip() or suggested

    store("/strawlink/twilio", {"sid": sid, "token": token, "from": f"whatsapp:{sandbox}"})
    store("/strawlink/demo_phone_map", {field: mine})
    print("\nSaved. Two things left:")
    print("1. In the Twilio sandbox settings, set \"When a message comes in\" to (method POST):")
    print(f"     {api}/webhooks/whatsapp")
    print(f"2. To receive the slot message for field {field} on your phone, run:")
    print(f"     curl -X POST {api}/replan -H \"content-type: application/json\" -d \"{{}}\"")
    print("   Then reply on WhatsApp with a question or a harvest date such as 25/10.")


if __name__ == "__main__":
    main()
