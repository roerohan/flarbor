FROM python:3.12-slim

# Install git and other essentials for code operations
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Configure git defaults
RUN git config --global init.defaultBranch main \
    && git config --global advice.detachedHead false

# Create a non-root user for the agent
RUN useradd -m -s /bin/bash agent

# Create working directory and logs directory
RUN mkdir -p /app /logs/agent /logs/verifier \
    && chown -R agent:agent /app /logs

USER agent
WORKDIR /app
