#!/usr/bin/env python3
"""Push breakfast analysis summary to WeCom aibot (WebSocket)."""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SUMMARIES = ROOT / "data" / "summaries"


def extract_section(md: str, heading: str) -> str:
    pat = rf"^## {re.escape(heading)}\s*$"
    m = re.search(pat, md, re.M)
    if not m:
        return ""
    start = m.end()
    nxt = re.search(r"^## ", md[start:], re.M)
    end = start + nxt.start() if nxt else len(md)
    return md[start:end].strip()


def extract_exec_summary(md: str) -> str:
    body = extract_section(md, "Executive Summary")
    if not body:
        return ""
    bullets = [ln.strip().lstrip("- ").strip() for ln in body.splitlines() if ln.strip().startswith("-")]
    return "\n".join(f"• {b}" for b in bullets[:5])


def build_push_body(md: str, date: str) -> str:
    parts = [f"## 早盘分析 {date}"]
    es = extract_exec_summary(md)
    if es:
        parts.append("### Executive Summary\n" + es)
    sec7 = extract_section(md, "七、A 股战术配置建议（中国市场）")
    if sec7:
        # compact: table + recommendations
        keep = []
        for ln in sec7.splitlines():
            if ln.startswith("### 推荐方向") or ln.startswith("- **标的**") or ln.startswith("- **今日策略**") or ln.startswith("| 标的 |") or ln.startswith("| 半导体") or ln.startswith("| 中芯"):
                keep.append(ln)
            elif ln.startswith("**综合结论**"):
                keep.append(ln)
        if keep:
            parts.append("### 战术配置\n" + "\n".join(keep[:20]))
    sec8 = extract_section(md, "八、技术分析与操作价位")
    if sec8:
        keep = []
        for ln in sec8.splitlines():
            if ln.startswith("### ") or ln.startswith("- **"):
                keep.append(ln)
        if keep:
            parts.append("### 操作价位\n" + "\n".join(keep[:24]))
    return "\n\n".join(parts)


def push_via_bun(title: str, body: str) -> bool:
    env = os.environ.copy()
    env["WECOM_PUSH_DIRECT"] = "1"
    script = ROOT / "scripts" / "push-wecom-markdown.ts"
    runners = [
        ["bun", "run", str(script), "--title", title, "--text", body],
        ["npx", "--yes", "tsx", str(script), "--title", title, "--text", body],
    ]
    for cmd in runners:
        try:
            proc = subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True)
        except FileNotFoundError:
            continue
        out = (proc.stdout or "") + (proc.stderr or "")
        print(out)
        if proc.returncode == 0:
            print("PUSH_OK mode=ws")
            return True
    return False


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--date", required=True, help="YYYY-MM-DD")
    args = p.parse_args()
    path = SUMMARIES / f"{args.date}-analysis.md"
    if not path.exists():
        print(f"分析文件不存在: {path}", file=sys.stderr)
        sys.exit(1)
    md = path.read_text(encoding="utf-8")
    body = build_push_body(md, args.date)
    title = f"早盘分析·{args.date}"
    ok = push_via_bun(title, body)
    if not ok:
        print("首次推送失败，重试...", file=sys.stderr)
        ok = push_via_bun(title, body)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
