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

# Create logs directory (NOT /app — git clone needs it to not exist)
RUN mkdir -p /logs/agent /logs/verifier \
    && chown -R agent:agent /logs

# Let the agent own /home/agent where clone will happen if /app fails
USER agent
WORKDIR /home/agent
