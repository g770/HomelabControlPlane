# Copyright (c) 2026 Homelab Control Plane contributors
# SPDX-License-Identifier: MIT
#
# This file builds the Api container image.
FROM golang:1.23-alpine AS agent-builder
WORKDIR /agent-src
COPY apps/agent/go.mod ./go.mod
COPY apps/agent/cmd ./cmd
COPY apps/agent/internal ./internal
ARG AGENT_BINARY_DEFAULT_VERSION=v0.2.0
RUN mkdir -p "/out/${AGENT_BINARY_DEFAULT_VERSION}" && \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o "/out/${AGENT_BINARY_DEFAULT_VERSION}/labagent-linux-amd64" ./cmd/labagent && \
    CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -o "/out/${AGENT_BINARY_DEFAULT_VERSION}/labagent-linux-arm64" ./cmd/labagent && \
    test -f "/out/${AGENT_BINARY_DEFAULT_VERSION}/labagent-linux-amd64" && \
    test -f "/out/${AGENT_BINARY_DEFAULT_VERSION}/labagent-linux-arm64"

FROM node:22-alpine
WORKDIR /workspace
RUN apk add --no-cache openssh-client sshpass python3 make g++
RUN corepack enable
ARG AGENT_BINARY_DEFAULT_VERSION=v0.2.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile
COPY . .
COPY --from=agent-builder /out/${AGENT_BINARY_DEFAULT_VERSION}/ /opt/homelab-agent-binaries/${AGENT_BINARY_DEFAULT_VERSION}/
EXPOSE 4000
CMD ["pnpm", "--filter", "@homelab/api", "dev"]
