import argparse
import json
import os
import subprocess
import sys
import urllib.request
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple


ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE_PATH = os.path.join(ROOT_DIR, "scripts", "portfolio_engine.py")


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


def _parse_dd_mm(s: str, year: int) -> Optional[datetime]:
    # Engine provides dd.mm (no year). Interpret as current year.
    try:
        day, month = s.split(".")
        d = datetime(year=year, month=int(month), day=int(day))
        return d
    except Exception:
        return None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=7)
    args = parser.parse_args()

    engine = _run_engine()
    earnings: List[Dict[str, Any]] = engine.get("earnings") or []

    today = datetime.utcnow().date()
    year = datetime.utcnow().year

    for e in earnings:
        tk = e.get("tk", "—")
        date_str = e.get("date", "")
        est = e.get("est", "")

        d = _parse_dd_mm(date_str, year)
        if not d:
            continue

        delta_days = (d.date() - today).days
        if delta_days == 7 - 1:
            _telegram_send_markdown(f"📅 *{tk}* earnings {('täna' if delta_days == 0 else 'lähipäevil')}!\nOotus: {est}")
        elif 0 < delta_days <= 7:
            # 1 day before (delta 1)
            if delta_days == 1:
                _telegram_send_markdown(
                    f"📅 *{tk}* earnings homme!\nOotus: {est}\nAI: Hoia positsiooni (skeem), kuni tulemused kinnitavad."
                )


if __name__ == "__main__":
    main()

