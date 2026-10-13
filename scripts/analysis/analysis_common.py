import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def configure_output() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")


def reject_constant(value: str) -> None:
    raise ValueError(f"JSON 含非有限数值：{value}")


def utc_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError(f"时间必须带时区：{value}")
    return parsed.astimezone(timezone.utc)


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(path)


class Progress:
    def __init__(self, output: Path, inputs: list[Path]) -> None:
        self.path = output.with_name(output.stem + ".progress.json")
        self.value = {
            "phase": "starting", "started_at": datetime.now(timezone.utc).isoformat(),
            "inputs": [str(path.resolve()) for path in inputs], "completed_inputs": 0,
            "current_file": None, "line": None, "output": str(output.resolve()),
            "operation_id": os.environ.get("QUAYMESH_OPERATION_ID"),
        }

    def __enter__(self):
        self.save()
        return self

    def update(self, **values: Any) -> None:
        self.value.update(values)
        self.save()

    def save(self) -> None:
        self.value["updated_at"] = datetime.now(timezone.utc).isoformat()
        write_json(self.path, self.value)

    def __exit__(self, kind, error, traceback):
        if error is not None:
            self.update(phase="failed", error=str(error))
        return False


class Numbers:
    def __init__(self) -> None:
        self.count, self.missing, self.total = 0, 0, 0.0
        self.minimum, self.maximum = None, None

    def add(self, value: Any, position: str) -> None:
        if value is None:
            self.missing += 1
            return
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"{position}：指标必须是有限数值，实际为 {value!r}")
        self.count += 1
        self.total += value
        if not math.isfinite(self.total):
            raise ValueError(f"{position}：聚合数值超出可表示范围")
        self.minimum = value if self.minimum is None else min(self.minimum, value)
        self.maximum = value if self.maximum is None else max(self.maximum, value)

    def report(self) -> dict:
        return {"count": self.count, "missing": self.missing, "sum": self.total,
                "min": self.minimum, "max": self.maximum,
                "mean": self.total / self.count if self.count else None}


def print_summary(report: dict, output: Path, summary: dict) -> None:
    print(json.dumps({**summary, "report": str(output.resolve())}, ensure_ascii=False, allow_nan=False))
