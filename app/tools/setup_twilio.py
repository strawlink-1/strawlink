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


def phone(text: str) -> str | None:
    p = "".join(c for c in text if c.isdigit() or c == "+")
    return p if p.startswith("+") and len(p) >= 9 else None


def ask(prompt: str, ok, hint: str, hidden: bool = False, default: str = "") -> str:
    """Keep asking until the answer looks right; nothing is stored until every answer does."""
    while True:
        text = (getpass.getpass(prompt) if hidden else input(prompt)).strip() or default
        if ok(text):
            return text
        print(f"    {hint}")


def main() -> None:
    api = aws("cloudformation", "describe-stacks", "--stack-name", STACK,
              "--query", "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue", "--output", "text")
    with urllib.request.urlopen(f"{api}/plan", timeout=30) as r:
        plan = json.load(r)
    stops = sorted((s["arrive"], s["field_id"], a["machine_id"]) for a in plan["assignments"] if a["type"] != "truck" for s in a["stops"])
    suggested = stops[0][1] if stops else "F0001"

    print("Answer each question and press Enter. Paste with a right-click.")
    print()
    print("1 of 5. From the Twilio Console home page, box \"Account Info\":")
    sid = ask("   Account SID: ", lambda t: t.startswith("AC") and len(t) == 34,
              "That is not an Account SID. It starts with AC and is 34 characters long. Copy it from Twilio and paste it here.")
    print("2 of 5. Same box. Nothing appears while you paste this one; that is normal.")
    token = ask("   Auth Token: ", lambda t: len(t) >= 20, "Nothing (or too little) arrived. Click the copy icon next to Auth Token in Twilio, right-click here, press Enter.", hidden=True)
    print("3 of 5. The sandbox number on Twilio's WhatsApp page. Just press Enter if it is +1 415 523 8886.")
    sandbox = phone(ask("   Sandbox number: ", phone, "Type it with the plus sign, like +14155238886.", default="+14155238886"))
    print("4 of 5. Your own WhatsApp number, the phone that joined the sandbox.")
    mine = phone(ask("   Your number: ", phone, "Start with the plus sign and country code, like +9198xxxxxxxx."))
    print(f"5 of 5. Which field your phone stands for. Just press Enter for {suggested}, where a machine comes today.")
    field = input("   Field: ").strip() or suggested

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
