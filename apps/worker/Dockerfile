# Copyright (c) 2026 Homelab Control Plane contributors
# SPDX-License-Identifier: MIT
#
# This file builds the Worker container image.
FROM node:22-alpine
WORKDIR /workspace
RUN apk add --no-cache iputils python3 make g++
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --filter @homelab/api... --filter @homelab/worker... --frozen-lockfile
COPY . .
CMD ["pnpm", "--filter", "@homelab/worker", "dev"]
