import json
import os
from datetime import datetime
from typing import Any, Dict, List


ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HISTORY_PATH = os.path.join(ROOT_DIR, "results", "history.json")


def main() -> None:
    # This scaffold tracks basic portfolio-level stats from scan history.
    try:
        with open(HISTORY_PATH, "r", encoding="utf-8") as f:
            history = json.load(f)
    except Exception:
        history = []

    # We don't have a guaranteed portfolio total snapshot in history yet.
    # Still, keep the script safe and extensible.
    generated_at = datetime.utcnow().isoformat() + "Z"
    entry = {"type": "performance", "generatedAt": generated_at, "historyCount": len(history)}

    os.makedirs(os.path.dirname(HISTORY_PATH), exist_ok=True)
    if isinstance(history, list):
        history.append(entry)
    else:
        history = [entry]

    with open(HISTORY_PATH, "w", encoding="utf-8") as f:
        json.dump(history, f, ensure_ascii=False, indent=2)

    print(f"Performance snapshot stored: {generated_at}")


if __name__ == "__main__":
    main()

