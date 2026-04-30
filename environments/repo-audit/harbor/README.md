# Repo Audit Harbor Environment

Harbor/Docker comparison implementation for the Flarbor repo-audit environment. It audits a repository with a real model and does not commit or push.

## Setup

```sh
cd environments/repo-audit/harbor
cp .env.example .env
```

Edit `.env` and set your model/provider keys.

Install Harbor and this local agent package in the environment you use to run Harbor:

```sh
pip install -e .
```

## Run

```sh
./run.sh
```

`run.sh` sources `.env`, writes `task/instruction.md`, and runs Harbor with Docker.

Results are written by the agent to `/logs/agent/repo-audit.json` and `/logs/agent/trial_result.json` inside the trial logs.
