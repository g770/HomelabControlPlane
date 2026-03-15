# Copyright (c) 2026 Homelab Control Plane contributors
# SPDX-License-Identifier: MIT
#
# This file builds the Agent container image.
FROM golang:1.23-alpine AS builder
WORKDIR /src
COPY apps/agent/go.mod ./go.mod
COPY apps/agent/cmd ./cmd
COPY apps/agent/internal ./internal
ARG TARGETOS=linux
ARG TARGETARCH=amd64
RUN mkdir -p /out && \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -o /out/labagent ./cmd/labagent && \
    cp /out/labagent /out/labagent-${TARGETOS}-${TARGETARCH}

FROM scratch AS artifact
COPY --from=builder /out/ /

FROM alpine:3.20
RUN apk add --no-cache ca-certificates bash curl docker-cli iputils traceroute
COPY --from=builder /out/labagent /usr/local/bin/labagent
ENTRYPOINT ["/usr/local/bin/labagent"]
