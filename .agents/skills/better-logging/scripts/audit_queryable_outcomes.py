#!/usr/bin/env python3
"""Audit a repository for better-logging readiness."""

from __future__ import annotations

import argparse
import json
import os
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Iterable, TypedDict


class FileEntry(TypedDict):
    path: str
    labels: list[str]


class SectionReport(TypedDict):
    counts: dict[str, int]
    files: list[FileEntry]


class AuditReport(TypedDict):
    files_scanned: int
    likely_runtimes: list[str]
    gaps: list[str]
    sections: dict[str, SectionReport]

CODE_EXTENSIONS = {
    ".c",
    ".cc",
    ".cpp",
    ".cs",
    ".go",
    ".java",
    ".js",
    ".jsx",
    ".kt",
    ".m",
    ".mm",
    ".py",
    ".rb",
    ".rs",
    ".swift",
    ".ts",
    ".tsx",
}

IGNORE_DIRS = {
    ".agents",
    ".claude",
    ".context",
    ".git",
    ".next",
    ".nuxt",
    ".pnpm",
    ".turbo",
    ".venv",
    "build",
    "coverage",
    "dist",
    "dist-electron",
    "node_modules",
    "out",
    "Pods",
    "target",
    "vendor",
}

PATTERN_GROUPS: dict[str, dict[str, re.Pattern[str]]] = {
    "boundaries": {
        "electron_ipc": re.compile(r"\bipc(?:Main|Renderer)\.(?:handle|invoke|on)\b"),
        "http_routes": re.compile(
            r"\b(?:app|router)\.(?:get|post|put|patch|delete)\b|\bfastify\.(?:get|post|put|patch|delete|route)\b"
        ),
        "jobs": re.compile(
            r"\b(?:cron(?:\.schedule)?|background job|queue\.process|new\s+Bull|new\s+Agenda|registerWorker|\.consume\()",
            re.IGNORECASE,
        ),
        "trpc": re.compile(r"\b(?:initTRPC|createTRPCRouter|tProcedure|\.mutation\(|\.query\()"),
    },
    "instrumentation": {
        "analytics": re.compile(
            r"\b(?:posthog|amplitude|mixpanel|segment|captureBackendEvent|captureUiEvent|trackFeatureUsed)\b",
            re.IGNORECASE,
        ),
        "correlation_fields": re.compile(
            r"\b(?:request(?:Id|_id)|trace(?:Id|_id)|correlation(?:Id|_id)|session(?:Id|_id))\b",
            re.IGNORECASE,
        ),
        "error_reporting": re.compile(r"\b(?:sentry|captureException|reportError)\b", re.IGNORECASE),
        "logging": re.compile(
            r"\b(?:console\.(?:info|warn|error|debug)|electron-log|pino|winston|bunyan|logger\.|log\.)\b"
        ),
        "timing_fields": re.compile(r"\b(?:duration_ms|durationMs|latency_ms|latencyMs)\b"),
    },
    "durable_signals": {
        "error_fields": re.compile(r"\b(?:errorCode|error_code|errorMessage|error_message)\b"),
        "outcome_terms": re.compile(
            r"\b(?:OperationOutcome|operationOutcome|PipelineRunLog|JobMetric|AuditLog|EventLog)\b"
        ),
        "status_fields": re.compile(r"\b(?:success|status|statusCode|status_code)\b"),
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".", help="Repository root to scan")
    parser.add_argument("--format", choices=("json", "markdown"), default="markdown")
    parser.add_argument(
        "--limit",
        type=int,
        default=8,
        help="Maximum files to show per section",
    )
    return parser.parse_args()


def iter_code_files(root: Path) -> Iterable[Path]:
    for current_root, dirs, files in os.walk(root):
        dirs[:] = [dir_name for dir_name in dirs if dir_name not in IGNORE_DIRS]
        base = Path(current_root)
        for file_name in files:
            path = base / file_name
            if path.suffix not in CODE_EXTENSIONS and path.name != "schema.prisma":
                continue
            yield path


def scan_file(path: Path) -> dict[str, list[str]]:
    try:
        content = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        content = path.read_text(encoding="utf-8", errors="ignore")

    hits: dict[str, list[str]] = defaultdict(list)
    for group_name, patterns in PATTERN_GROUPS.items():
        for label, pattern in patterns.items():
            if pattern.search(content):
                hits[group_name].append(label)
    return dict(hits)


def build_report(root: Path, limit: int) -> AuditReport:
    files_scanned = 0
    group_counts: dict[str, Counter[str]] = {
        group_name: Counter() for group_name in PATTERN_GROUPS
    }
    files_by_group: dict[str, list[FileEntry]] = {
        group_name: [] for group_name in PATTERN_GROUPS
    }

    for path in iter_code_files(root):
        files_scanned += 1
        hits = scan_file(path)
        for group_name, labels in hits.items():
            group_counts[group_name].update(labels)
            # First `limit` files encountered per group; order follows os.walk traversal.
            if len(files_by_group[group_name]) < limit:
                files_by_group[group_name].append(
                    {
                        "path": str(path.relative_to(root)),
                        "labels": sorted(labels),
                    }
                )

    runtimes = []
    if group_counts["boundaries"]["trpc"]:
        runtimes.append("tRPC")
    if group_counts["boundaries"]["electron_ipc"]:
        runtimes.append("Electron IPC")
    if group_counts["boundaries"]["http_routes"]:
        runtimes.append("HTTP routes")
    if group_counts["boundaries"]["jobs"]:
        runtimes.append("Background jobs")

    gaps = []
    if not group_counts["instrumentation"]["correlation_fields"]:
        gaps.append("No obvious correlation ID fields found.")
    if not group_counts["durable_signals"]["outcome_terms"]:
        gaps.append("No obvious durable outcome model or outcome naming found.")
    if not group_counts["instrumentation"]["timing_fields"]:
        gaps.append("No obvious duration or latency fields found.")
    if not files_by_group["boundaries"]:
        gaps.append("No clear operation boundaries detected in scanned files.")

    return {
        "files_scanned": files_scanned,
        "likely_runtimes": runtimes,
        "gaps": gaps,
        "sections": {
            group_name: {
                "counts": dict(group_counts[group_name].most_common()),
                "files": files_by_group[group_name],
            }
            for group_name in PATTERN_GROUPS
        },
    }


def to_markdown(report: AuditReport) -> str:
    sections = report["sections"]
    lines = [
        "# Better Logging Audit",
        "",
        f"- Files scanned: {report['files_scanned']}",
        f"- Likely runtimes: {', '.join(report['likely_runtimes']) or 'none detected'}",
    ]

    gaps = report["gaps"]
    lines.append(f"- Gaps: {len(gaps)}")
    if gaps:
        lines.append("")
        lines.append("## Gaps")
        lines.append("")
        for gap in gaps:
            lines.append(f"- {gap}")

    for section_name, title in (
        ("boundaries", "Operation Boundaries"),
        ("instrumentation", "Existing Instrumentation"),
        ("durable_signals", "Durable Outcome Signals"),
    ):
        section = sections[section_name]
        lines.extend(["", f"## {title}", ""])
        counts = section["counts"]
        if counts:
            for label, count in counts.items():
                lines.append(f"- `{label}`: {count}")
        else:
            lines.append("- none found")

        files = section["files"]
        if files:
            lines.extend(["", "Representative files:"])
            for file_info in files:
                labels = ", ".join(file_info["labels"])
                lines.append(f"- `{file_info['path']}` [{labels}]")

    return "\n".join(lines) + "\n"


def main() -> int:
    args = parse_args()
    root = Path(args.root).resolve()
    report = build_report(root, args.limit)

    if args.format == "json":
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(to_markdown(report), end="")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
