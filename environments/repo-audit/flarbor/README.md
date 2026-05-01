# Repo Audit Flarbor Environment

Audits repositories with a real model and returns structured read-only results. This environment does not create branches, commit, or push.

## Setup

```sh
cp environments/repo-audit/flarbor/.dev.vars.example environments/repo-audit/flarbor/.dev.vars
```

Edit `.dev.vars` and set `ANTHROPIC_API_KEY`. `MODEL_NAME` defaults to `claude-opus-4-6`.

## Run

```sh
pnpm --filter repo-audit-flarbor run dev
```

## Single Audit

```sh
curl -X POST http://localhost:8787/run \
  -H 'content-type: application/json' \
  -d '{
    "repoUrl": "https://github.com/roerohan/flarbor",
    "instructions": "Audit docs, tests, packaging, maintainability, and deployment readiness."
  }'
```

## In-Request Batch Audit With `flarbor-job`

```sh
curl -X POST http://localhost:8787/jobs/run \
  -H 'content-type: application/json' \
  -d '{
    "id": "audit-small-set",
    "name": "Audit small repo set",
    "attempts": 1,
    "concurrency": 2,
    "tasks": [
      {
        "id": "flarbor",
        "task": {
          "repoUrl": "https://github.com/roerohan/flarbor",
          "instructions": "Audit docs, tests, packaging, maintainability, and deployment readiness."
        }
      }
    ]
  }'
```

The response is a `JobResult`. Each trial contains `metadata.audit` with the structured report.

## Durable Job Audit

`POST /jobs` runs the same batch through the `JobObject` Durable Object helper and persists job state after each trial. The job ID is either the submitted `id` or a stable ID derived from the config.

```sh
curl -X POST http://localhost:8787/jobs \
  -H 'content-type: application/json' \
  -d '{
    "id": "audit-small-set",
    "name": "Audit small repo set",
    "attempts": 1,
    "concurrency": 2,
    "tasks": [
      {
        "id": "flarbor",
        "task": {
          "repoUrl": "https://github.com/roerohan/flarbor",
          "instructions": "Audit docs, tests, packaging, maintainability, and deployment readiness."
        }
      }
    ]
  }'
```

Inspect or cancel persisted state:

```sh
curl http://localhost:8787/jobs/audit-small-set
curl -X POST http://localhost:8787/jobs/audit-small-set/cancel
```

## Notes

- This is read-only. `branch`, `commitSha`, and `filesChanged` are empty in successful results.
- The repo snapshot is bounded to keep model input size manageable.
- `/jobs/run` is an in-request batch runner. `/jobs` uses persisted Durable Object job state, but still runs the small batch inside the current RPC call. Larger background jobs will require a future Queue backend.
