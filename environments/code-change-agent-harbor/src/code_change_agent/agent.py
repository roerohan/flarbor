"""
CodeChangeAgent — Harbor equivalent of Flarbor's code-change-agent.

Workflow:
  1. Clone a repo into the container
  2. Create a new branch
  3. Run an LLM-driven agentic loop that reads/writes files via exec()
  4. Commit changes and push to the remote

The agent uses LiteLLM for model inference (matching Flarbor's use of
Workers AI with @cf/moonshotai/kimi-k2.5). It implements its own
tool-calling loop: the LLM receives tool definitions (read_file,
write_file, edit_file, find_files, grep_files, list_dir, execute_command),
calls them via tool_calls, and the agent executes each tool inside the
Docker container via environment.exec().

Environment variables required:
  REPO_URL        — Repository URL to clone
  BRANCH          — Branch name to create (optional, auto-generated if omitted)
  GITHUB_TOKEN    — GitHub token for clone/push authentication
  AUTHOR_NAME     — Git author name (default: "Harbor Agent")
  AUTHOR_EMAIL    — Git author email (default: "agent@harbor.dev")
  MAX_STEPS       — Maximum agentic loop steps (default: 30)
  MODEL_NAME      — LiteLLM model identifier (default: provider-specific)
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any

import litellm
from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

# Silence litellm's noisy logging
litellm.suppress_debug_info = True

logger = logging.getLogger(__name__)

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
                        "description": "Absolute path to the file to read.",
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
                        "description": "Absolute path to the file to write.",
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
                        "description": "Absolute path to the file to edit.",
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
                        "description": "Directory to search in. Defaults to /app.",
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
                        "description": "Directory to search in. Defaults to /app.",
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
                        "description": "Absolute path to the directory to list.",
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

# Protected paths — agent cannot modify these
PROTECTED_PATHS = [".git/", ".github/workflows/"]

SYSTEM_PROMPT = """\
You are a code modification agent. You have access to a cloned git repository at /app.
Use the provided tools (read_file, write_file, edit_file, find_files, grep_files, list_dir, execute_command) to understand the codebase and make the requested changes.
Use the execute_command tool to run shell commands when you need to process multiple files or do complex operations.
Be precise and make only the changes requested. Do not modify files unnecessarily.
When you are done, summarize what you changed and why.\
"""


def _is_protected(path: str) -> bool:
    """Check if a path falls under a protected directory."""
    for prefix in PROTECTED_PATHS:
        if path.startswith(f"/app/{prefix}") or path.startswith(prefix):
            return True
    return False


class CodeChangeAgent(BaseAgent):
    """
    Harbor agent that clones a repo, uses an LLM to make code changes
    via tool calls, then commits and pushes. Mirrors the Flarbor
    code-change-agent's workflow exactly.
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
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        """
        Execute the code-change workflow:
        1. Clone the repository
        2. Create a branch
        3. Run the agentic loop (LLM + tool calls)
        4. Commit and push
        """
        repo_url = os.environ.get("REPO_URL", "")
        github_token = os.environ.get("GITHUB_TOKEN", "")
        branch = os.environ.get("BRANCH", f"harbor/{int(time.time()):x}")
        author_name = os.environ.get("AUTHOR_NAME", "Harbor Agent")
        author_email = os.environ.get("AUTHOR_EMAIL", "agent@harbor.dev")
        max_steps = int(os.environ.get("MAX_STEPS", "30"))
        model_name = self.model_name or os.environ.get(
            "MODEL_NAME", "openrouter/moonshotai/kimi-k2.5"
        )

        if not repo_url:
            raise ValueError("REPO_URL environment variable is required")

        logger.info(
            "[code-change-agent-harbor] Starting task: repo=%s branch=%s",
            repo_url,
            branch,
        )

        # --- Step 1: Clone the repository ---
        logger.info("[code-change-agent-harbor] Step 1: Cloning repository...")
        clone_url = repo_url
        if github_token:
            # Insert token into HTTPS URL for authentication
            clone_url = repo_url.replace(
                "https://", f"https://x-access-token:{github_token}@"
            )
        result = await environment.exec(
            command=f"git clone --depth 1 {clone_url} /app",
            timeout_sec=120,
        )
        if result.return_code != 0:
            raise RuntimeError(
                f"git clone failed: {result.stderr or result.stdout}"
            )
        logger.info("[code-change-agent-harbor] Step 1: Clone complete")

        # --- Step 2: Create the branch ---
        logger.info(
            "[code-change-agent-harbor] Step 2: Creating branch: %s", branch
        )
        result = await environment.exec(
            command=f"git checkout -b {branch}",
            cwd="/app",
        )
        if result.return_code != 0:
            raise RuntimeError(
                f"git checkout -b failed: {result.stderr or result.stdout}"
            )
        logger.info("[code-change-agent-harbor] Step 2: Branch created")

        # --- Step 3: Agentic loop ---
        logger.info("[code-change-agent-harbor] Step 3: Running agentic loop...")
        total_input_tokens = 0
        total_output_tokens = 0

        messages: list[dict[str, Any]] = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": instruction},
        ]

        for step in range(max_steps):
            logger.info(
                "[code-change-agent-harbor] Step 3: agentic step %d/%d",
                step + 1,
                max_steps,
            )

            response = litellm.completion(
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
                        "content": tool_result[:50000],  # Truncate large outputs
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
            cwd="/app",
        )
        # Also check untracked files
        untracked = await environment.exec(
            command="git ls-files --others --exclude-standard",
            cwd="/app",
        )

        changed_files = []
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
            # Write result metadata to logs
            self._write_result_log(
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
        commit_message = f"harbor: {instruction[:72]}"

        # Configure git user
        await environment.exec(
            command=f'git config user.name "{author_name}"',
            cwd="/app",
        )
        await environment.exec(
            command=f'git config user.email "{author_email}"',
            cwd="/app",
        )

        # Stage all changes
        await environment.exec(command="git add -A", cwd="/app")

        # Commit
        result = await environment.exec(
            command=f'git commit -m "{commit_message}"',
            cwd="/app",
        )
        if result.return_code != 0:
            raise RuntimeError(
                f"git commit failed: {result.stderr or result.stdout}"
            )

        # Get commit SHA
        sha_result = await environment.exec(
            command="git rev-parse HEAD",
            cwd="/app",
        )
        commit_sha = (sha_result.stdout or "").strip()

        # Push if we have a token
        if github_token:
            push_url = repo_url.replace(
                "https://", f"https://x-access-token:{github_token}@"
            )
            result = await environment.exec(
                command=f"git push {push_url} {branch}",
                cwd="/app",
                timeout_sec=120,
            )
            if result.return_code != 0:
                raise RuntimeError(
                    f"git push failed: {result.stderr or result.stdout}"
                )

        logger.info(
            "[code-change-agent-harbor] Step 5: Push complete, commitSha=%s",
            commit_sha,
        )

        # Populate context with results
        context.n_input_tokens = total_input_tokens
        context.n_output_tokens = total_output_tokens
        context.metadata = {
            "branch": branch,
            "commit_sha": commit_sha,
            "files_changed": changed_files,
        }

        # Write result log
        self._write_result_log(
            success=True,
            branch=branch,
            commit_sha=commit_sha,
            files_changed=changed_files,
            input_tokens=total_input_tokens,
            output_tokens=total_output_tokens,
        )

    async def _execute_tool(
        self,
        name: str,
        args: dict[str, Any],
        environment: BaseEnvironment,
    ) -> str:
        """Execute a tool call inside the Docker container."""
        try:
            if name == "read_file":
                return await self._tool_read_file(args, environment)
            elif name == "write_file":
                return await self._tool_write_file(args, environment)
            elif name == "edit_file":
                return await self._tool_edit_file(args, environment)
            elif name == "find_files":
                return await self._tool_find_files(args, environment)
            elif name == "grep_files":
                return await self._tool_grep_files(args, environment)
            elif name == "list_dir":
                return await self._tool_list_dir(args, environment)
            elif name == "execute_command":
                return await self._tool_execute_command(args, environment)
            else:
                return f"Error: Unknown tool '{name}'"
        except Exception as e:
            return f"Error executing {name}: {e}"

    async def _tool_read_file(
        self, args: dict[str, Any], env: BaseEnvironment
    ) -> str:
        path = args["path"]
        result = await env.exec(command=f"cat {_shell_quote(path)}", cwd="/app")
        if result.return_code != 0:
            return f"Error reading {path}: {result.stderr or 'file not found'}"
        return result.stdout or ""

    async def _tool_write_file(
        self, args: dict[str, Any], env: BaseEnvironment
    ) -> str:
        path = args["path"]
        content = args["content"]
        if _is_protected(path):
            return f"Error: Path '{path}' is protected and cannot be modified."
        # Use a heredoc to write content safely
        # Encode content as base64 to avoid shell escaping issues
        import base64

        encoded = base64.b64encode(content.encode()).decode()
        result = await env.exec(
            command=f"mkdir -p $(dirname {_shell_quote(path)}) && echo '{encoded}' | base64 -d > {_shell_quote(path)}",
            cwd="/app",
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
        if _is_protected(path):
            return f"Error: Path '{path}' is protected and cannot be modified."
        # Read the file, do the replacement in Python, write it back
        read_result = await env.exec(
            command=f"cat {_shell_quote(path)}", cwd="/app"
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
            return f"Error: Found {count} matches for old_string in {path}. Provide more context to identify the correct match."
        new_content = content.replace(old_string, new_string, 1)
        # Write back using base64 to avoid escaping issues
        import base64

        encoded = base64.b64encode(new_content.encode()).decode()
        write_result = await env.exec(
            command=f"echo '{encoded}' | base64 -d > {_shell_quote(path)}",
            cwd="/app",
        )
        if write_result.return_code != 0:
            return f"Error writing {path}: {write_result.stderr}"
        return f"Successfully edited {path}"

    async def _tool_find_files(
        self, args: dict[str, Any], env: BaseEnvironment
    ) -> str:
        pattern = args["pattern"]
        search_path = args.get("path", "/app")
        # Use find with -name or -path depending on the pattern
        if "**" in pattern or "/" in pattern:
            # Convert glob to find pattern
            find_pattern = pattern.replace("**", "*")
            result = await env.exec(
                command=f"find {_shell_quote(search_path)} -path {_shell_quote(find_pattern)} -type f 2>/dev/null | head -200",
                cwd="/app",
            )
        else:
            result = await env.exec(
                command=f"find {_shell_quote(search_path)} -name {_shell_quote(pattern)} -type f 2>/dev/null | head -200",
                cwd="/app",
            )
        if result.return_code != 0:
            return f"Error: {result.stderr}"
        return result.stdout or "No files found."

    async def _tool_grep_files(
        self, args: dict[str, Any], env: BaseEnvironment
    ) -> str:
        pattern = args["pattern"]
        search_path = args.get("path", "/app")
        include = args.get("include", "")
        include_flag = f"--include={_shell_quote(include)}" if include else ""
        result = await env.exec(
            command=f"grep -rn {include_flag} {_shell_quote(pattern)} {_shell_quote(search_path)} 2>/dev/null | head -200",
            cwd="/app",
        )
        if result.return_code not in (0, 1):
            return f"Error: {result.stderr}"
        return result.stdout or "No matches found."

    async def _tool_list_dir(
        self, args: dict[str, Any], env: BaseEnvironment
    ) -> str:
        path = args["path"]
        result = await env.exec(
            command=f"ls -la {_shell_quote(path)} 2>/dev/null",
            cwd="/app",
        )
        if result.return_code != 0:
            return f"Error listing {path}: {result.stderr or 'directory not found'}"
        return result.stdout or ""

    async def _tool_execute_command(
        self, args: dict[str, Any], env: BaseEnvironment
    ) -> str:
        command = args["command"]
        result = await env.exec(command=command, cwd="/app", timeout_sec=60)
        output = ""
        if result.stdout:
            output += result.stdout
        if result.stderr:
            output += f"\nSTDERR: {result.stderr}"
        output += f"\nExit code: {result.return_code}"
        return output or "Command completed with no output."

    def _write_result_log(
        self,
        success: bool,
        branch: str,
        commit_sha: str,
        files_changed: list[str],
        error: str | None = None,
        input_tokens: int = 0,
        output_tokens: int = 0,
    ) -> None:
        """Write a JSON result log to the logs directory (mirrors Flarbor's TrialResult)."""
        result = {
            "success": success,
            "branch": branch,
            "commitSha": commit_sha,
            "filesChanged": files_changed,
            "usage": {
                "inputTokens": input_tokens,
                "outputTokens": output_tokens,
                "totalTokens": input_tokens + output_tokens,
            },
        }
        if error:
            result["error"] = error

        log_path = self.logs_dir / "trial_result.json"
        log_path.write_text(json.dumps(result, indent=2))


def _shell_quote(s: str) -> str:
    """Quote a string for safe use in shell commands."""
    import shlex

    return shlex.quote(s)
