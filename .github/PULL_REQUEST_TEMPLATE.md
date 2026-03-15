<!--
Copyright (c) 2026 Homelab Control Plane contributors
SPDX-License-Identifier: MIT

This document describes pull request template behavior and expectations.
-->

## Summary

- describe the user-visible or operator-visible change
- call out any config, migration, or doc updates

## Checks

- [ ] `pnpm repo:hygiene`
- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] relevant targeted tests or e2e suites

## Security Review

- [ ] non-public API routes remain guarded
- [ ] no secrets or credential payloads are logged
- [ ] write actions still require approval and audit records
- [ ] diagnostics remain allowlisted
