import argparse
import json
import os
import subprocess
import sys
import urllib.request
from datetime import datetime
from typing import Any, Dict, List


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
    # The engine script prints ONE JSON object to stdout.
    out = subprocess.check_output([sys.executable, ENGINE_PATH], cwd=ROOT_DIR, timeout=300)
    return json.loads(out.decode("utf-8"))


def _make_report(mode: str, engine: Dict[str, Any]) -> str:
    positions = engine.get("positions") or []
    total_eur = sum(float(p.get("eur") or 0.0) for p in positions)
    movers = sorted(positions, key=lambda p: float(p.get("pct") or 0.0), reverse=True)
    top = movers[:3]
    bottom = movers[-3:]

    if mode == "morning":
        title = "📊 *Hommikuraport*"
        bullet = "Täna jälgi: stop-lossid, targetid ja kõrge volatiilsusega RSI-signaalid."
    else:
        title = "📊 *Õhturaport*"
        bullet = "Pärast turu sulgemist: vaata päeva parimaid/halvimaid positsioone ja võimalikke muudatusi."

    def fmt_row(p: Dict[str, Any]) -> str:
        tk = p.get("tk", "—")
        pct = float(p.get("pct") or 0.0)
        rsi = p.get("rsi", "—")
        return f"• *{tk}*: {pct:+.2f}% | RSI {rsi}"

    lines: List[str] = []
    lines.append(title)
    lines.append("")
    lines.append(f"Portfelli EUR väärtus: *€{total_eur:,.0f}*")
    lines.append(bullet)
    lines.append("")
    lines.append("*Parimad*:")
    for p in top:
        lines.append(fmt_row(p))
    lines.append("")
    lines.append("*Halvimad*:")
    for p in bottom:
        lines.append(fmt_row(p))
    lines.append("")
    lines.append(f"_Koostatud: {datetime.utcnow().isoformat()}Z_")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["morning", "evening"], required=True)
    args = parser.parse_args()

    try:
        engine = _run_engine()
    except Exception as e:
        # Never crash the cron/report job.
        msg = f"Raport ebaõnnestus: {e}"
        print(msg)
        _telegram_send_markdown(f"📊 *{args.mode.title()}-raport* — _viga_:\n{msg}")
        return

    report = _make_report(args.mode, engine)
    _telegram_send_markdown(report)


if __name__ == "__main__":
    main()

