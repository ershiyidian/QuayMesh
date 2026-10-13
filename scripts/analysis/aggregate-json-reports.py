import argparse
import json
from pathlib import Path
from analysis_common import Numbers, Progress, configure_output, print_summary, reject_constant, write_json


def arguments():
    parser = argparse.ArgumentParser(description="按明确字段汇总 JSON 报告，不推断实验指标。")
    parser.add_argument("--input", nargs="+", type=Path, required=True)
    parser.add_argument("--metrics", nargs="+", required=True)
    parser.add_argument("--group-by", nargs="*", default=[])
    parser.add_argument("--records-key", default="records")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--summary-limit", type=int, default=5)
    parser.add_argument("--encoding", default="utf-8")
    args = parser.parse_args()
    if args.summary_limit < 0:
        parser.error("--summary-limit 必须非负")
    if args.output.resolve() in [path.resolve() for path in args.input]:
        parser.error("输出不能覆盖输入报告")
    return args


def field(record: dict, path: str):
    current = record
    for key in path.split("."):
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def summarize(args) -> dict:
    groups, sources = {}, []
    total = {name: Numbers() for name in args.metrics}
    count = 0
    with Progress(args.output, args.input) as progress:
        for file_index, path in enumerate(args.input):
            progress.update(phase="reading", current_file=str(path), line=None)
            try:
                payload = json.loads(path.read_text(encoding=args.encoding), parse_constant=reject_constant)
            except (json.JSONDecodeError, ValueError) as error:
                raise ValueError(f"{path}：{error}") from error
            records = payload if isinstance(payload, list) else field(payload, args.records_key) if isinstance(payload, dict) else None
            if not isinstance(records, list):
                raise ValueError(f"{path}：需要 JSON 数组或含 {args.records_key!r} 数组的对象")
            per_file = {name: Numbers() for name in args.metrics}
            for index, record in enumerate(records):
                location = f"{path}:records[{index}]"
                if not isinstance(record, dict):
                    raise ValueError(f"{location}：记录必须是对象")
                key_values = {name: field(record, name) for name in args.group_by}
                if any(isinstance(value, (dict, list)) for value in key_values.values()):
                    raise ValueError(f"{location}：分组字段需要标量")
                key = json.dumps(key_values, ensure_ascii=False, sort_keys=True, allow_nan=False)
                if key not in groups:
                    groups[key] = {"group": key_values, "records": 0,
                                   "values": {name: Numbers() for name in args.metrics}}
                group = groups[key]
                group["records"] += 1
                count += 1
                for name in args.metrics:
                    value = field(record, name)
                    for stats in (total[name], per_file[name], group["values"][name]):
                        stats.add(value, f"{location}:{name}")
            sources.append({"path": str(path.resolve()), "records": len(records),
                            "metrics": {name: stats.report() for name, stats in per_file.items()}})
            progress.update(completed_inputs=file_index + 1, records=count)
        result_groups = [{"group": group["group"], "records": group["records"],
                          "metrics": {name: stats.report() for name, stats in group["values"].items()}}
                         for _, group in sorted(groups.items())]
        report = {"records": count, "group_by": args.group_by, "metrics": {name: stats.report() for name, stats in total.items()},
                  "sources": sources, "groups": result_groups}
        progress.update(phase="writing")
        write_json(args.output, report)
        progress.update(phase="completed")
    print_summary(report, args.output, {"records": count, "metrics": report["metrics"],
                                      "groups": result_groups[:args.summary_limit]})
    return report


if __name__ == "__main__":
    configure_output()
    summarize(arguments())
