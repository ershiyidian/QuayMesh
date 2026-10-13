import argparse
import json
from collections import Counter
from pathlib import Path
from analysis_common import Numbers, Progress, configure_output, print_summary, reject_constant, utc_time, write_json


def arguments():
    parser = argparse.ArgumentParser(description="逐行汇总真实 QuayMesh JSONL 日志。")
    parser.add_argument("--input", nargs="+", type=Path, required=True)
    parser.add_argument("--from", dest="start", type=utc_time, required=True)
    parser.add_argument("--to", dest="end", type=utc_time, required=True)
    parser.add_argument("--event", action="append", default=[])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--summary-limit", type=int, default=5)
    parser.add_argument("--encoding", default="utf-8")
    args = parser.parse_args()
    if args.start > args.end:
        parser.error("--from 必须早于或等于 --to")
    if args.summary_limit < 0:
        parser.error("--summary-limit 必须非负")
    if args.output.resolve() in [path.resolve() for path in args.input]:
        parser.error("输出不能覆盖输入日志")
    return args


def summarize(args) -> dict:
    tools, sources, events, errors = Counter(), Counter(), Counter(), Counter()
    durations, sizes = Numbers(), Numbers()
    counts = {"lines": 0, "matched": 0, "empty_lines": 0, "missing_timestamp": 0,
              "missing_tool": 0, "missing_source": 0}
    inputs = []
    with Progress(args.output, args.input) as progress:
        for index, path in enumerate(args.input):
            progress.update(phase="reading", current_file=str(path), line=0)
            file_count = 0
            with path.open("r", encoding=args.encoding) as stream:
                for line_number, line in enumerate(stream, 1):
                    counts["lines"] += 1
                    if not line.strip():
                        counts["empty_lines"] += 1
                        continue
                    location = f"{path}:{line_number}"
                    try:
                        event = json.loads(line, parse_constant=reject_constant)
                    except (json.JSONDecodeError, ValueError) as error:
                        progress.update(line=line_number)
                        raise ValueError(f"{location}：{error}") from error
                    if not isinstance(event, dict):
                        raise ValueError(f"{location}：日志记录必须是 JSON 对象")
                    timestamp = event.get("ts")
                    if timestamp is None:
                        counts["missing_timestamp"] += 1
                        continue
                    try:
                        moment = utc_time(timestamp)
                    except (AttributeError, TypeError, ValueError) as error:
                        raise ValueError(f"{location}：ts 无效：{timestamp!r}") from error
                    if moment < args.start or moment > args.end or (args.event and event.get("event") not in args.event):
                        continue
                    counts["matched"] += 1
                    file_count += 1
                    name, source = event.get("tool"), event.get("actor") or event.get("source")
                    if name is None:
                        counts["missing_tool"] += 1
                    elif not isinstance(name, str):
                        raise ValueError(f"{location}：tool 必须是字符串")
                    if source is None:
                        counts["missing_source"] += 1
                    elif not isinstance(source, str):
                        raise ValueError(f"{location}：source/actor 必须是字符串")
                    tools[name or "(missing)"] += 1
                    sources[source or "(missing)"] += 1
                    events[str(event.get("event", "(missing)"))] += 1
                    durations.add(event.get("durationMs"), f"{location}:durationMs")
                    sizes.add(event.get("responseBytes"), f"{location}:responseBytes")
                    status = event.get("httpStatus")
                    if event.get("aborted") is True:
                        errors["aborted"] += 1
                    if event.get("toolError") is True:
                        errors["tool_error"] += 1
                    if isinstance(status, int) and status >= 400:
                        errors[f"http_{status}"] += 1
                    if event.get("level") == "error":
                        errors["log_error"] += 1
                    if line_number % 10000 == 0:
                        progress.update(line=line_number, matched=counts["matched"])
            inputs.append({"path": str(path.resolve()), "matched": file_count, "bytes": path.stat().st_size})
            progress.update(completed_inputs=index + 1, matched=counts["matched"])
        report = {"timezone": "UTC", "from": args.start.isoformat(), "to": args.end.isoformat(),
                  "counts": counts, "inputs": inputs, "tools": dict(tools), "sources": dict(sources),
                  "events": dict(events), "errors": dict(errors),
                  "duration_ms": durations.report(), "response_bytes": sizes.report()}
        progress.update(phase="writing")
        write_json(args.output, report)
        progress.update(phase="completed")
    print_summary(report, args.output, {"matched": counts["matched"], "errors": dict(errors),
                  "tools": tools.most_common(args.summary_limit)})
    return report


if __name__ == "__main__":
    configure_output()
    summarize(arguments())
