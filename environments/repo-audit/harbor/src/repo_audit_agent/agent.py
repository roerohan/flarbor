from __future__ import annotations

import json
import os
import re
import shlex
from pathlib import Path
from typing import Any

import litellm
from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

litellm.suppress_debug_info = True

WORKDIR = "/home/agent/repo"
SNAPSHOT_FILES = [
    "README.md",
    "README.mdx",
    "README.txt",
    "LICENSE",
    "LICENSE.md",
    "package.json",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "wrangler.jsonc",
    "Dockerfile",
    ".github/workflows/ci.yml",
    ".github/workflows/ci.yaml",
]


class RepoAuditAgent(BaseAgent):
    async def setup(self, environment: BaseEnvironment) -> None:
        result = await environment.exec("git --version && python3 --version", timeout_sec=30)
        if result.return_code != 0:
            raise RuntimeError(f"repo-audit setup failed: {result.stderr}")

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        repo_url = os.environ.get("REPO_URL")
        if not repo_url:
            raise RuntimeError("REPO_URL is required")

        model = os.environ.get("MODEL_NAME") or getattr(context, "model", None) or "anthropic/claude-opus-4-6"
        clone = await environment.exec(
            f"rm -rf {shlex.quote(WORKDIR)} && git clone --depth 1 {shlex.quote(repo_url)} {shlex.quote(WORKDIR)}",
            timeout_sec=300,
        )
        if clone.return_code != 0:
            raise RuntimeError(f"git clone failed: {clone.stderr}")

        snapshot = await self._collect_snapshot(environment)
        prompt = self._build_prompt(repo_url, instruction, snapshot, model)
        response = litellm.completion(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0,
        )
        text = response.choices[0].message.content or ""
        report = self._parse_report(text)
        usage = getattr(response, "usage", None)
        token_usage = {
            "inputTokens": int(getattr(usage, "prompt_tokens", 0) or 0),
            "outputTokens": int(getattr(usage, "completion_tokens", 0) or 0),
            "totalTokens": int(getattr(usage, "total_tokens", 0) or 0),
        }
        reward = self._reward(report)
        trial_result = {
            "success": True,
            "branch": "",
            "commitSha": "",
            "filesChanged": [],
            "usage": token_usage,
            "reward": reward,
            "metadata": {"audit": report},
        }

        await environment.exec("mkdir -p /logs/agent", timeout_sec=30)
        await self._write_json(environment, "/logs/agent/repo-audit.json", report)
        await self._write_json(environment, "/logs/agent/trial_result.json", trial_result)

    async def _collect_snapshot(self, environment: BaseEnvironment) -> dict[str, Any]:
        tree_result = await environment.exec(
            "python3 - <<'PY'\n"
            "from pathlib import Path\n"
            f"root=Path({WORKDIR!r})\n"
            "items=[]\n"
            "for p in root.rglob('*'):\n"
            "    rel=p.relative_to(root).as_posix()\n"
            "    if '.git/' in rel or rel.startswith('.git') or 'node_modules/' in rel:\n"
            "        continue\n"
            "    depth=rel.count('/')\n"
            "    if depth <= 1:\n"
            "        items.append(('directory' if p.is_dir() else 'file') + ':' + rel)\n"
            "    if len(items) >= 160:\n"
            "        break\n"
            "print('\n'.join(items))\n"
            "PY",
            timeout_sec=60,
        )
        files: list[dict[str, Any]] = []
        total_chars = 0
        for path in SNAPSHOT_FILES:
            if len(files) >= 12 or total_chars >= 40000:
                break
            result = await environment.exec(
                f"python3 - <<'PY'\n"
                "from pathlib import Path\n"
                f"p=Path({str(Path(WORKDIR) / path)!r})\n"
                "print(p.read_text(errors='replace') if p.exists() and p.is_file() else '')\n"
                "PY",
                timeout_sec=30,
            )
            content = result.stdout
            if not content:
                continue
            remaining = 40000 - total_chars
            sliced = content[: min(8000, remaining)]
            total_chars += len(sliced)
            files.append({"path": path, "content": sliced, "truncated": len(sliced) < len(content)})
        return {"tree": tree_result.stdout.splitlines(), "files": files}

    def _build_prompt(self, repo_url: str, instruction: str, snapshot: dict[str, Any], model: str) -> str:
        shape = {
            "repoUrl": repo_url,
            "model": model,
            "summary": "short audit summary",
            "scores": {
                "documentation": 0.5,
                "testing": 0.5,
                "packaging": 0.5,
                "maintainability": 0.5,
                "deploymentReadiness": 0.5,
            },
            "findings": [
                {
                    "severity": "medium",
                    "category": "testing",
                    "title": "Finding title",
                    "evidence": "Specific evidence from inspected files or tree",
                    "recommendation": "Actionable recommendation",
                }
            ],
            "inspectedFiles": ["README.md"],
        }
        files = "\n".join(
            f"\n--- {f['path']}{' (truncated)' if f.get('truncated') else ''} ---\n{f['content']}"
            for f in snapshot["files"]
        )
        return "\n".join(
            [
                "You are auditing a repository read-only. Do not propose or perform direct modifications in this run.",
                "Use only the repository snapshot below as evidence. Return strict JSON only, no markdown.",
                "Scores must be numbers from 0 to 1. The JSON shape is:",
                json.dumps(shape, indent=2),
                "\nUser audit instructions:",
                instruction,
                "\nRepository tree:",
                "\n".join(snapshot["tree"]) or "(empty)",
                "\nInspected files:",
                files,
            ]
        )

    def _parse_report(self, text: str) -> dict[str, Any]:
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            match = re.search(r"```(?:json)?\s*([\s\S]*?)```", text) or re.search(r"\{[\s\S]*\}", text)
            if not match:
                raise
            return json.loads(match.group(1) if match.lastindex else match.group(0))

    def _reward(self, report: dict[str, Any]) -> dict[str, Any]:
        scores = report.get("scores", {})
        criteria = [
            {"name": "documentation", "score": float(scores.get("documentation", 0)), "weight": 1},
            {"name": "testing", "score": float(scores.get("testing", 0)), "weight": 1},
            {"name": "packaging", "score": float(scores.get("packaging", 0)), "weight": 1},
            {"name": "maintainability", "score": float(scores.get("maintainability", 0)), "weight": 1},
            {
                "name": "deployment_readiness",
                "score": float(scores.get("deploymentReadiness", 0)),
                "weight": 1,
            },
        ]
        score = sum(c["score"] for c in criteria) / len(criteria)
        return {
            "score": score,
            "totalCriteria": len(criteria),
            "errors": 0,
            "rewards": [{"name": "repo_audit", "score": score, "criteria": criteria, "aggregation": "weighted_mean"}],
        }

    async def _write_json(self, environment: BaseEnvironment, path: str, value: dict[str, Any]) -> None:
        payload = shlex.quote(json.dumps(value, indent=2))
        result = await environment.exec(f"cat > {shlex.quote(path)} <<'JSON'\n{json.dumps(value, indent=2)}\nJSON", timeout_sec=30)
        if result.return_code != 0:
            raise RuntimeError(f"failed to write {path}: {result.stderr}; payload={payload[:80]}")
