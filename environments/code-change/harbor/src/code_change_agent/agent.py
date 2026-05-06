"""
CodeChangeAgent — Harbor equivalent of Flarbor's PR-replay environment.

Workflow:
  1. Look up a PRReplayTask by TASK_ID
  2. Clone the repo (full history) and check out the base commit
  3. Create a new branch from the base commit
  4. Run an LLM-driven agentic loop that reads/writes files via exec()
  5. Commit changes and push to the remote
  6. Write changed-file metadata for the verifier (test.sh) to score

The agent uses LiteLLM for model inference. It implements its own
tool-calling loop: the LLM receives tool definitions (read_file,
write_file, edit_file, delete_file, find_files, grep_files, list_dir,
execute_command), calls them via tool_calls, and the agent executes
each tool inside the Docker container via environment.exec().

Environment variables required:
  TASK_ID         — PR-replay task identifier (e.g. "zod-5855")

Environment variables optional:
  GITHUB_TOKEN    — GitHub token for clone/push (omit to skip push)
  BRANCH          — Branch name to create (auto-generated if omitted)
  AUTHOR_NAME     — Git author name (default: "Harbor Agent")
  AUTHOR_EMAIL    — Git author email (default: "agent@harbor.dev")
  MAX_STEPS       — Maximum agentic loop steps (default: 30)
  MODEL_NAME      — LiteLLM model identifier (default: provider-specific)
"""

from __future__ import annotations

import base64
import fnmatch
import json
import logging
import os
import shlex
import time
from typing import Any

import litellm
from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from code_change_agent.tasks import TASKS, get_task, PRReplayTask

# Silence litellm's noisy logging
litellm.suppress_debug_info = True

logger = logging.getLogger(__name__)


def _redact_token(text: str) -> str:
    """Strip any embedded GitHub token from error messages / log output."""
    token = os.environ.get("GITHUB_TOKEN", "")
    if token and token in text:
        return text.replace(token, "***")
    return text


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Working directory inside the container where the repo is cloned.
WORKDIR = "/home/agent/repo"

# Protected path patterns — matches Flarbor's protectedPaths config exactly.
# Uses glob syntax: * matches anything except /, ** matches everything.
PROTECTED_PATTERNS = [".git", ".git/**", ".github/workflows", ".github/workflows/**"]

# ---------------------------------------------------------------------------
# Tool definitions (OpenAI function-calling format)
# ---------------------------------------------------------------------------

TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read the contents of a file at the given path.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": f"Absolute path to the file to read (repo root is {WORKDIR}).",
                    }
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Write content to a file, creating it if it doesn't exist. Overwrites existing content.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": f"Absolute path to the file to write (repo root is {WORKDIR}).",
                    },
                    "content": {
                        "type": "string",
                        "description": "The full content to write to the file.",
                    },
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": "Replace an exact string in a file with a new string. The old_string must match exactly (including whitespace and indentation).",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": f"Absolute path to the file to edit (repo root is {WORKDIR}).",
                    },
                    "old_string": {
                        "type": "string",
                        "description": "The exact string to find and replace.",
                    },
                    "new_string": {
                        "type": "string",
                        "description": "The string to replace it with.",
                    },
                },
                "required": ["path", "old_string", "new_string"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "delete_file",
            "description": "Delete a file at the given path.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": f"Absolute path to the file to delete (repo root is {WORKDIR}).",
                    },
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "find_files",
            "description": "Find files matching a glob pattern in the repository.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Glob pattern to match (e.g. '**/*.ts', 'src/**/*.py').",
                    },
                    "path": {
                        "type": "string",
                        "description": f"Directory to search in. Defaults to {WORKDIR}.",
                    },
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "grep_files",
            "description": "Search for a regex pattern in files. Returns matching lines with file paths and line numbers.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Regex pattern to search for.",
                    },
                    "path": {
                        "type": "string",
                        "description": f"Directory to search in. Defaults to {WORKDIR}.",
                    },
                    "include": {
                        "type": "string",
                        "description": "File glob to limit search (e.g. '*.ts').",
                    },
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_dir",
            "description": "List files and directories at the given path.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": f"Absolute path to the directory to list (repo root is {WORKDIR}).",
                    },
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "execute_command",
            "description": "Execute a shell command in the repository working directory. Use for complex multi-file operations, running scripts, or anything not covered by other tools.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The shell command to execute.",
                    },
                },
                "required": ["command"],
            },
        },
    },
]

SYSTEM_PROMPT = f"""\
You are a code modification agent. You have access to a cloned git repository at {WORKDIR}.
A bug has been reported. Your job is to fix it and add tests.

Use the provided tools (read_file, write_file, edit_file, delete_file, find_files, grep_files, list_dir, execute_command) to understand the codebase and make the requested changes.
Use the execute_command tool to run shell commands when you need to process multiple files or do complex operations.

Guidelines:
- Read the existing code to understand patterns before writing.
- Make minimal, targeted changes — only modify what's needed.
- Add tests that cover the fix.
- Do not modify files unnecessarily.
- When you are done, summarize what you changed and why.\
"""


# ---------------------------------------------------------------------------
# Protected-path matching — mirrors Flarbor's matchesProtectedPath()
# ---------------------------------------------------------------------------


def _matches_protected_path(filepath: str) -> bool:
    """
    Check if *filepath* matches any of the PROTECTED_PATTERNS.

    Mirrors Flarbor's ``matchesProtectedPath`` in environment.ts which
    converts glob patterns like ``.git/**`` into regexes where ``*``
    matches ``[^/]*`` and ``**`` matches ``.*``.

    Python's ``fnmatch`` uses the same single-star / double-star
    semantics, so we can delegate to it directly.

    The filepath may be absolute (``/home/agent/repo/.git/config``) or
    relative (``.git/config``).  We normalise to a repo-relative path
    before matching.
    """
    # Normalise to repo-relative
    rel = filepath
    if rel.startswith(WORKDIR + "/"):
        rel = rel[len(WORKDIR) + 1 :]
    elif rel.startswith("/"):
        # Some other absolute path — not inside the repo, leave as-is.
        pass

    for pattern in PROTECTED_PATTERNS:
        if fnmatch.fnmatch(rel, pattern):
            return True
    return False


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------


class CodeChangeAgent(BaseAgent):
    """
    Harbor agent that replays a PR: clones a repo at a pre-PR commit,
    uses an LLM to re-implement the changes via tool calls, then commits
    and pushes.  Mirrors the Flarbor code-change environment's workflow.
    """

    SUPPORTS_ATIF: bool = False

    @staticmethod
    def name() -> str:
        return "code-change-agent"

    def version(self) -> str | None:
        return "0.0.1"

    async def setup(self, environment: BaseEnvironment) -> None:
        """No installation needed — we use exec() for everything."""
        pass

    async def run(
        self,
        _instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        """
        Execute the PR-replay workflow:
        1. Resolve task from TASK_ID
        2. Clone the repository (full history) at the base commit
        3. Create a branch from the base commit
        4. Run the agentic loop (LLM + tool calls)
        5. Commit and push
        6. Write changed-file metadata for the verifier
        """
        # --- Resolve task ---
        task_id = os.environ.get("TASK_ID", "")
        if not task_id:
            raise ValueError(
                "TASK_ID environment variable is required. "
                f"Available tasks: {', '.join(TASKS.keys())}"
            )

        task = get_task(task_id)
        if task is None:
            raise ValueError(
                f"Unknown task ID: \"{task_id}\". "
                f"Available: {', '.join(TASKS.keys())}"
            )

        github_token = os.environ.get("GITHUB_TOKEN", "")
        branch = os.environ.get("BRANCH", "") or f"harbor/{task.id}-{int(time.time()):x}"
        author_name = os.environ.get("AUTHOR_NAME", "Harbor Agent")
        author_email = os.environ.get("AUTHOR_EMAIL", "agent@harbor.dev")
        max_steps_raw = os.environ.get("MAX_STEPS") or "30"
        try:
            max_steps = int(max_steps_raw)
        except ValueError:
            raise ValueError(
                f"MAX_STEPS must be a positive integer, got \"{max_steps_raw}\""
            ) from None
        if max_steps <= 0:
            raise ValueError(
                f"MAX_STEPS must be a positive integer, got {max_steps}"
            )
        model_name = self.model_name or os.environ.get(
            "MODEL_NAME", "anthropic/claude-sonnet-4-20250514"
        )

        logger.info(
            "[code-change-agent-harbor] Starting PR-replay: task=%s repo=%s base=%s branch=%s",
            task.id,
            task.repo_url,
            task.base_commit[:8],
            branch,
        )

        # Wrap the main execution in try/except so we always write a result log,
        # even on unexpected failures (clone, LLM, commit, push).
        try:
            await self._run_pr_replay(
                task, environment, context,
                github_token=github_token,
                branch=branch,
                author_name=author_name,
                author_email=author_email,
                max_steps=max_steps,
                model_name=model_name,
            )
        except Exception as exc:
            logger.error(
                "[code-change-agent-harbor] Unhandled error: %s", exc, exc_info=True
            )
            self._write_result_log(
                task=task,
                success=False,
                branch=branch,
                commit_sha="",
                files_changed=[],
                error=str(exc),
                input_tokens=context.n_input_tokens or 0,
                output_tokens=context.n_output_tokens or 0,
            )
            raise

    async def _run_pr_replay(
        self,
        task: PRReplayTask,
        environment: BaseEnvironment,
        context: AgentContext,
        *,
        github_token: str,
        branch: str,
        author_name: str,
        author_email: str,
        max_steps: int,
        model_name: str,
    ) -> None:
        """Inner execution body — separated so the caller can catch and log failures."""

        # --- Step 1: Clone the repository (full history) ---
        logger.info("[code-change-agent-harbor] Step 1: Cloning repository (full history)...")
        clone_url = task.repo_url
        if github_token:
            clone_url = task.repo_url.replace(
                "https://", f"https://x-access-token:{github_token}@"
            )
        result = await environment.exec(
            command=f"git clone {shlex.quote(clone_url)} {WORKDIR}",
            timeout_sec=300,
        )
        if result.return_code != 0:
            raise RuntimeError(
                f"git clone failed: {_redact_token(result.stderr or result.stdout)}"
            )
        # Strip token from stored origin URL immediately after clone.
        if github_token:
            await environment.exec(
                command=f"git remote set-url origin {shlex.quote(task.repo_url)}",
                cwd=WORKDIR,
            )
        logger.info("[code-change-agent-harbor] Step 1: Clone complete")

        # --- Step 2: Checkout base commit and create branch ---
        logger.info(
            "[code-change-agent-harbor] Step 2: Checking out base commit %s",
            task.base_commit[:8],
        )
        result = await environment.exec(
            command=f"git checkout {shlex.quote(task.base_commit)}",
            cwd=WORKDIR,
        )
        if result.return_code != 0:
            raise RuntimeError(
                f"git checkout base commit failed: {result.stderr or result.stdout}"
            )

        logger.info(
            "[code-change-agent-harbor] Step 2: Creating branch: %s", branch
        )
        result = await environment.exec(
            command=f"git checkout -b {shlex.quote(branch)}",
            cwd=WORKDIR,
        )
        if result.return_code != 0:
            raise RuntimeError(
                f"git checkout -b failed: {result.stderr or result.stdout}"
            )
        logger.info("[code-change-agent-harbor] Step 2: Branch created from base commit")

        # --- Step 3: Agentic loop ---
        # Use task instructions (from PR title + body), not the Harbor instruction.md.
        logger.info("[code-change-agent-harbor] Step 3: Running agentic loop...")
        total_input_tokens = 0
        total_output_tokens = 0

        messages: list[dict[str, Any]] = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": task.instructions},
        ]

        for step in range(max_steps):
            logger.info(
                "[code-change-agent-harbor] Step 3: agentic step %d/%d",
                step + 1,
                max_steps,
            )

            response = await litellm.acompletion(
                model=model_name,
                messages=messages,
                tools=TOOLS,
                tool_choice="auto",
            )

            # Track token usage
            usage = response.usage
            if usage:
                total_input_tokens += usage.prompt_tokens or 0
                total_output_tokens += usage.completion_tokens or 0

            choice = response.choices[0]
            message = choice.message

            # Append the assistant message
            messages.append(message.model_dump())

            # If no tool calls, the agent is done
            if not message.tool_calls:
                logger.info(
                    "[code-change-agent-harbor] Step 3: Agent finished (no more tool calls)"
                )
                break

            # Execute each tool call
            for tool_call in message.tool_calls:
                fn_name = tool_call.function.name
                try:
                    fn_args = json.loads(tool_call.function.arguments)
                except json.JSONDecodeError:
                    fn_args = {}

                logger.info(
                    "[code-change-agent-harbor] Tool call: %s(%s)",
                    fn_name,
                    json.dumps(fn_args)[:200],
                )

                tool_result = await self._execute_tool(
                    fn_name, fn_args, environment
                )

                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": tool_result[:50_000],  # Truncate large outputs
                    }
                )
        else:
            logger.warning(
                "[code-change-agent-harbor] Step 3: Reached max_steps (%d)",
                max_steps,
            )

        logger.info("[code-change-agent-harbor] Step 3: Agentic loop complete")

        # --- Step 4: Check for changes ---
        logger.info(
            "[code-change-agent-harbor] Step 4: Checking for changes..."
        )
        result = await environment.exec(
            command="git diff --name-only HEAD",
            cwd=WORKDIR,
        )
        # Also check untracked files
        untracked = await environment.exec(
            command="git ls-files --others --exclude-standard",
            cwd=WORKDIR,
        )

        changed_files: list[str] = []
        if result.stdout:
            changed_files.extend(result.stdout.strip().split("\n"))
        if untracked.stdout:
            changed_files.extend(untracked.stdout.strip().split("\n"))
        changed_files = [f for f in changed_files if f]

        logger.info(
            "[code-change-agent-harbor] Step 4: Changed files: %s",
            changed_files,
        )

        if not changed_files:
            logger.warning(
                "[code-change-agent-harbor] Agent made no changes to the repository"
            )
            self._write_result_log(
                task=task,
                success=False,
                branch=branch,
                commit_sha="",
                files_changed=[],
                error="Agent made no changes to the repository",
                input_tokens=total_input_tokens,
                output_tokens=total_output_tokens,
            )
            context.n_input_tokens = total_input_tokens
            context.n_output_tokens = total_output_tokens
            return

        # --- Step 5: Commit and push ---
        logger.info(
            "[code-change-agent-harbor] Step 5: Committing and pushing..."
        )
        commit_message = f"harbor: {task.name}"

        # Configure git user
        await environment.exec(
            command=f"git config user.name {shlex.quote(author_name)}",
            cwd=WORKDIR,
        )
        await environment.exec(
            command=f"git config user.email {shlex.quote(author_email)}",
            cwd=WORKDIR,
        )

        # Stage all changes
        await environment.exec(command="git add -A", cwd=WORKDIR)

        # Commit
        result = await environment.exec(
            command=f"git commit -m {shlex.quote(commit_message)}",
            cwd=WORKDIR,
        )
        if result.return_code != 0:
            raise RuntimeError(
                f"git commit failed: {result.stderr or result.stdout}"
            )

        # Get commit SHA
        sha_result = await environment.exec(
            command="git rev-parse HEAD",
            cwd=WORKDIR,
        )
        commit_sha = (sha_result.stdout or "").strip()

        # Push if we have a token.
        if github_token:
            push_url = task.repo_url.replace(
                "https://", f"https://x-access-token:{github_token}@"
            )
            await environment.exec(
                command=f"git remote set-url origin {shlex.quote(push_url)}",
                cwd=WORKDIR,
            )
            try:
                result = await environment.exec(
                    command=f"git push origin {shlex.quote(branch)}",
                    cwd=WORKDIR,
                    timeout_sec=120,
                )
            finally:
                # Always reset remote URL to strip token, even on exception.
                await environment.exec(
                    command=f"git remote set-url origin {shlex.quote(task.repo_url)}",
                    cwd=WORKDIR,
                )
            if result.return_code != 0:
                raise RuntimeError(
                    f"git push failed: {_redact_token(result.stderr or result.stdout)}"
                )

        if github_token:
            logger.info(
                "[code-change-agent-harbor] Step 5: Push complete, commitSha=%s",
                commit_sha,
            )
        else:
            logger.info(
                "[code-change-agent-harbor] Step 5: Commit complete (push skipped, no GITHUB_TOKEN), commitSha=%s",
                commit_sha,
            )

        # Populate context with results
        context.n_input_tokens = total_input_tokens
        context.n_output_tokens = total_output_tokens
        context.metadata = {
            "branch": branch,
            "commit_sha": commit_sha,
            "files_changed": changed_files,
            "task_id": task.id,
        }

        # Write result log + changed-file metadata for verifier
        self._write_result_log(
            task=task,
            success=True,
            branch=branch,
            commit_sha=commit_sha,
            files_changed=changed_files,
            input_tokens=total_input_tokens,
            output_tokens=total_output_tokens,
        )

    # ------------------------------------------------------------------
    # Tool dispatch
    # ------------------------------------------------------------------

    async def _execute_tool(
        self,
        name: str,
        args: dict[str, Any],
        environment: BaseEnvironment,
    ) -> str:
        """Execute a tool call inside the Docker container."""
        handlers = {
            "read_file": self._tool_read_file,
            "write_file": self._tool_write_file,
            "edit_file": self._tool_edit_file,
            "delete_file": self._tool_delete_file,
            "find_files": self._tool_find_files,
            "grep_files": self._tool_grep_files,
            "list_dir": self._tool_list_dir,
            "execute_command": self._tool_execute_command,
        }
        handler = handlers.get(name)
        if handler is None:
            return f"Error: Unknown tool '{name}'"
        try:
            return await handler(args, environment)
        except Exception as e:
            return f"Error executing {name}: {e}"

    # ------------------------------------------------------------------
    # Tool implementations
    # ------------------------------------------------------------------

    async def _tool_read_file(
        self, args: dict[str, Any], env: BaseEnvironment
    ) -> str:
        path = args["path"]
        result = await env.exec(
            command=f"cat {shlex.quote(path)}", cwd=WORKDIR
        )
        if result.return_code != 0:
            return f"Error reading {path}: {result.stderr or 'file not found'}"
        return result.stdout or "(empty file)"

    async def _tool_write_file(
        self, args: dict[str, Any], env: BaseEnvironment
    ) -> str:
        path = args["path"]
        content = args["content"]
        if _matches_protected_path(path):
            return f"Error: Path \"{path}\" is protected and cannot be modified."

        # Encode content as base64 and pipe through stdin to avoid
        # shell ARG_MAX limits on large files.
        encoded = base64.b64encode(content.encode()).decode()
        result = await env.exec(
            command=(
                f"mkdir -p \"$(dirname {shlex.quote(path)})\" "
                f"&& printf '%s' {shlex.quote(encoded)} | base64 -d > {shlex.quote(path)}"
            ),
            cwd=WORKDIR,
        )
        if result.return_code != 0:
            return f"Error writing {path}: {result.stderr}"
        return f"Successfully wrote to {path}"

    async def _tool_edit_file(
        self, args: dict[str, Any], env: BaseEnvironment
    ) -> str:
        path = args["path"]
        old_string = args["old_string"]
        new_string = args["new_string"]
        if _matches_protected_path(path):
            return f"Error: Path \"{path}\" is protected and cannot be modified."

        # Read the file
        read_result = await env.exec(
            command=f"cat {shlex.quote(path)}", cwd=WORKDIR
        )
        if read_result.return_code != 0:
            return (
                f"Error reading {path}: {read_result.stderr or 'file not found'}"
            )
        content = read_result.stdout or ""

        if old_string not in content:
            return f"Error: old_string not found in {path}"
        count = content.count(old_string)
        if count > 1:
            return (
                f"Error: Found {count} matches for old_string in {path}. "
                "Provide more context to identify the correct match."
            )

        new_content = content.replace(old_string, new_string, 1)

        # Write back via base64 to avoid escaping issues and ARG_MAX.
        encoded = base64.b64encode(new_content.encode()).decode()
        write_result = await env.exec(
            command=(
                f"printf '%s' {shlex.quote(encoded)} | base64 -d > {shlex.quote(path)}"
            ),
            cwd=WORKDIR,
        )
        if write_result.return_code != 0:
            return f"Error writing {path}: {write_result.stderr}"
        return f"Successfully edited {path}"

    async def _tool_delete_file(
        self, args: dict[str, Any], env: BaseEnvironment
    ) -> str:
        path = args["path"]
        if _matches_protected_path(path):
            return f"Error: Path \"{path}\" is protected and cannot be modified."
        result = await env.exec(
            command=f"rm {shlex.quote(path)}", cwd=WORKDIR
        )
        if result.return_code != 0:
            return f"Error deleting {path}: {result.stderr or 'file not found'}"
        return f"Successfully deleted {path}"

    async def _tool_find_files(
        self, args: dict[str, Any], env: BaseEnvironment
    ) -> str:
        pattern = args["pattern"]
        search_path = args.get("path", WORKDIR)
        # Use find with -name or -path depending on the pattern
        if "**" in pattern or "/" in pattern:
            find_pattern = pattern.replace("**", "*")
            result = await env.exec(
                command=(
                    f"find {shlex.quote(search_path)} "
                    f"-path {shlex.quote(find_pattern)} "
                    "-type f 2>/dev/null | head -200"
                ),
                cwd=WORKDIR,
            )
        else:
            result = await env.exec(
                command=(
                    f"find {shlex.quote(search_path)} "
                    f"-name {shlex.quote(pattern)} "
                    "-type f 2>/dev/null | head -200"
                ),
                cwd=WORKDIR,
            )
        if result.return_code != 0:
            return f"Error: {result.stderr}"
        return result.stdout or "No files found."

    async def _tool_grep_files(
        self, args: dict[str, Any], env: BaseEnvironment
    ) -> str:
        pattern = args["pattern"]
        search_path = args.get("path", WORKDIR)
        include = args.get("include", "")
        include_flag = (
            f"--include={shlex.quote(include)}" if include else ""
        )
        result = await env.exec(
            command=(
                f"grep -rn {include_flag} "
                f"-- {shlex.quote(pattern)} "
                f"{shlex.quote(search_path)} "
                "2>/dev/null | head -200"
            ),
            cwd=WORKDIR,
        )
        if result.return_code not in (0, 1):  # 1 = no matches (normal)
            return f"Error: {result.stderr}"
        return result.stdout or "No matches found."

    async def _tool_list_dir(
        self, args: dict[str, Any], env: BaseEnvironment
    ) -> str:
        path = args["path"]
        result = await env.exec(
            command=f"ls -la {shlex.quote(path)} 2>/dev/null",
            cwd=WORKDIR,
        )
        if result.return_code != 0:
            return f"Error listing {path}: {result.stderr or 'directory not found'}"
        return result.stdout or "(empty directory)"

    async def _tool_execute_command(
        self, args: dict[str, Any], env: BaseEnvironment
    ) -> str:
        command = args["command"]
        result = await env.exec(command=command, cwd=WORKDIR, timeout_sec=60)
        output = ""
        if result.stdout:
            output += result.stdout
        if result.stderr:
            output += f"\nSTDERR: {result.stderr}"
        output += f"\nExit code: {result.return_code}"
        return output or "Command completed with no output."

    # ------------------------------------------------------------------
    # Result logging
    # ------------------------------------------------------------------

    def _write_result_log(
        self,
        task: PRReplayTask,
        success: bool,
        branch: str,
        commit_sha: str,
        files_changed: list[str],
        error: str | None = None,
        input_tokens: int = 0,
        output_tokens: int = 0,
    ) -> None:
        """Write a JSON result log to the logs directory (mirrors Flarbor's TrialResult)."""
        self.logs_dir.mkdir(parents=True, exist_ok=True)

        result: dict[str, Any] = {
            "success": success,
            "branch": branch,
            "commitSha": commit_sha,
            "filesChanged": files_changed,
            "usage": {
                "inputTokens": input_tokens,
                "outputTokens": output_tokens,
                "totalTokens": input_tokens + output_tokens,
            },
            "metadata": {
                "taskId": task.id,
                "prNumber": task.pr_number,
                "baseCommit": task.base_commit,
            },
        }
        if error:
            result["error"] = error

        log_path = self.logs_dir / "trial_result.json"
        log_path.write_text(json.dumps(result, indent=2))

        # Write changed-file metadata for the verifier to read.
        # The verifier needs the task ID and changed files to score.
        verifier_meta = {
            "taskId": task.id,
            "filesChanged": files_changed,
            "success": success,
        }
        verifier_path = self.logs_dir / "verifier_metadata.json"
        verifier_path.write_text(json.dumps(verifier_meta, indent=2))
