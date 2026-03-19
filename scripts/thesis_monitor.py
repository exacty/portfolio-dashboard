import json
import os
import subprocess
import sys
import urllib.request
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple


ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE_PATH = os.path.join(ROOT_DIR, "scripts", "portfolio_engine.py")
PORTFOLIO_DATA_PATH = os.path.join(ROOT_DIR, "portfolio_data.json")


def _telegram_send_markdown(text: str) -> None:
    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not bot_token or not chat_id or bot_token == "placeholder_setup_later" or chat_id == "placeholder_setup_later":
        print("[telegram] (placeholder) ", text[:500])
        return

    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    payload = json.dumps(
        {
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "Markdown",
            "disable_web_page_preview": True,
        }
    ).encode("utf-8")
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=20) as resp:
        _ = resp.read()


def _run_engine() -> Dict[str, Any]:
    out = subprocess.check_output([sys.executable, ENGINE_PATH], cwd=ROOT_DIR, timeout=300)
    return json.loads(out.decode("utf-8"))


def main() -> None:
    now = datetime.utcnow()
    weekday = now.weekday()  # Mon=0..Sun=6
    hour = now.hour

    try:
        with open(PORTFOLIO_DATA_PATH, "r", encoding="utf-8") as f:
            portfolio_data = json.load(f)
    except Exception as e:
        _telegram_send_markdown(f"⚠️ *Tees monitor* — ei saanud lugeda `portfolio_data.json`: {e}")
        return

    positions = portfolio_data.get("positions") or {}
    teases = {tk: v.get("tees", "") for tk, v in positions.items() if str(v.get("tees", "")).strip()}

    if not teases:
        return

    engine = _run_engine()
    pos_by_tk: Dict[str, Any] = {p.get("tk"): p for p in (engine.get("positions") or []) if p.get("tk")}

    # Urgent check (run daily): tees broken approximated by score < 30
    urgent: List[str] = []
    for tk, thesis in teases.items():
        p = pos_by_tk.get(tk)
        if not p:
            continue
        score = float(p.get("score") or 0)
        price = float(p.get("price") or 0)
        if score < 30:
            urgent.append(f"❌ *{tk}*: tees katkenud (skoor {score:.0f}).\nHind: {price:.2f}\nTees: {thesis[:160]}")

    if urgent:
        for msg in urgent:
            _telegram_send_markdown(f"🔴 {msg}\n▸ _Soovitus: analüüsi ümber ja vajadusel tegutse._")

    # Weekly overview (Sunday 20:00 UTC-ish). Spec says Sunday 20:00 local; this is simplified.
    if weekday == 6 and hour == 20:
        lines = ["📋 *Nädala teeside ülevaade*"]
        for tk, thesis in sorted(teases.items()):
            p = pos_by_tk.get(tk)
            score = float(p.get("score") or 0) if p else 0
            if score < 30:
                lines.append(f"❌ {tk}: tees katkenud (skoor {score:.0f})")
            elif score < 45:
                lines.append(f"⚠️ {tk}: jälgi (skoor {score:.0f})")
            else:
                lines.append(f"✅ {tk}: tees kehtib (skoor {score:.0f})")
        _telegram_send_markdown("\n".join(lines))


if __name__ == "__main__":
    main()

