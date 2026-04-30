FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN git config --global init.defaultBranch main \
    && git config --global advice.detachedHead false

RUN useradd -m -s /bin/bash agent \
    && mkdir -p /logs/agent /logs/verifier \
    && chown -R agent:agent /logs /home/agent

USER agent
WORKDIR /home/agent
