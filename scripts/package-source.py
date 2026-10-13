import argparse
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

parser = argparse.ArgumentParser()
parser.add_argument("--directory", type=Path, default=Path(__file__).resolve().parent.parent)
parser.add_argument("--output", type=Path)
args = parser.parse_args()
root = args.directory.resolve()
output = (args.output or root.parent / f"{root.name}.zip").resolve()
excluded = {".git", ".build", ".planning", ".quaymesh", "__pycache__", "test-results", "playwright-report"}
source_package = not (root / "release.json").exists()
if source_package:
    excluded |= {"node_modules", "dist", "releases", ".releases"}
with ZipFile(output, "w", compression=ZIP_DEFLATED, compresslevel=6) as archive:
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if any(part in excluded for part in relative.parts) or not path.is_file() or path.resolve() == output:
            continue
        if path.suffix.lower() in {".ttf", ".otf", ".woff", ".woff2"}:
            continue
        if path.name in {"secrets.env", "auth.json", "owner.json", "cluster.token"}:
            continue
        archive.write(path, Path(root.name) / relative)
print(output)
