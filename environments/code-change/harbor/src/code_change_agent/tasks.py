"""
Static task suite for PR replay — Python equivalent of flarbor's tasks.ts.

Each entry captures enough metadata to replay a real-world PR:
check out a repo at ``base_commit``, give the agent ``instructions``,
then verify the result against the known-good diff.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class FilePattern:
    """A deterministic content check on a specific file."""

    path: str
    contains: str
    regex: bool = False


@dataclass(frozen=True)
class PRReplayTask:
    """Everything needed to replay and verify one PR."""

    id: str
    name: str
    repo_url: str
    base_commit: str
    merge_commit: str
    pr_number: int
    instructions: str
    expected_files: tuple[str, ...]
    setup_command: str | None
    test_command: str
    expected_patterns: tuple[FilePattern, ...] = ()


# ---------------------------------------------------------------------------
# Task suite
# ---------------------------------------------------------------------------

TASKS: dict[str, PRReplayTask] = {}


def _register(task: PRReplayTask) -> None:
    TASKS[task.id] = task


_register(
    PRReplayTask(
        id="zod-5855",
        name="zod: clone Map and Set in shallowClone",
        repo_url="https://github.com/colinhacks/zod.git",
        base_commit="b6b1288277e6ca87dab0ad1c7251b92612b7445c",
        merge_commit="34f601590351e5d3a57fe20c001155940ba65324",
        pr_number=5855,
        instructions=(
            "Fix a bug in Zod v4: when using `.default()` with mutable values like `Map` or `Set`,\n"
            "every call to `.parse(undefined)` returns the same reference. Mutations on one parse\n"
            "result leak into subsequent parses.\n"
            "\n"
            "Example of the bug:\n"
            "```ts\n"
            "const schema = z.map(z.string(), z.number()).default(new Map());\n"
            "const result1 = schema.parse(undefined);\n"
            'result1.set("key", 42);\n'
            "const result2 = schema.parse(undefined);\n"
            "console.log(result2.size); // 1 — should be 0\n"
            "```\n"
            "\n"
            "This already works correctly for plain objects and arrays via `shallowClone` in\n"
            "`packages/zod/src/v4/core/util.ts`, but `Map` and `Set` fall through to `return o`\n"
            "(same reference).\n"
            "\n"
            "Fix `shallowClone` to handle `Map` and `Set`, and add tests to\n"
            "`packages/zod/src/v4/classic/tests/default.test.ts` covering:\n"
            "- Shallow clone returns distinct instances for Map and Set\n"
            "- Mutations on one parse result do not affect another (both directions)"
        ),
        expected_files=(
            "packages/zod/src/v4/core/util.ts",
            "packages/zod/src/v4/classic/tests/default.test.ts",
        ),
        setup_command="pnpm install --frozen-lockfile",
        test_command="pnpm vitest run packages/zod/src/v4/classic/tests/default.test.ts",
        expected_patterns=(
            FilePattern(
                path="packages/zod/src/v4/core/util.ts",
                contains="instanceof Map) return new Map",
            ),
            FilePattern(
                path="packages/zod/src/v4/core/util.ts",
                contains="instanceof Set) return new Set",
            ),
            FilePattern(
                path="packages/zod/src/v4/classic/tests/default.test.ts",
                contains="defaulted Map",
            ),
            FilePattern(
                path="packages/zod/src/v4/classic/tests/default.test.ts",
                contains="defaulted Set",
            ),
        ),
    )
)


def get_task(task_id: str) -> PRReplayTask | None:
    return TASKS.get(task_id)
