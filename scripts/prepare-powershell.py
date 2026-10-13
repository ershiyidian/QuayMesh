from pathlib import Path
import sys

if len(sys.argv) < 2:
    raise ValueError("请提供需要在 Windows PowerShell 中执行的 .ps1 文件。")
for filename in sys.argv[1:]:
    path = Path(filename)
    if path.suffix.lower() != ".ps1":
        raise ValueError(f"只接受 PowerShell 脚本：{path}")
    # Windows PowerShell 5 使用 BOM 识别包含中文的 UTF-8 文件。
    path.write_text(path.read_text(encoding="utf-8-sig"), encoding="utf-8-sig")
print(f"已准备 {len(sys.argv) - 1} 个 PowerShell 文件。")
