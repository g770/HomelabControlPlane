# TASK-002 Design: OpenAI Usage And Spend In Settings

## Objective

Add a Settings experience that lets an authenticated admin view OpenAI usage and spend without exposing secrets, while fitting the current Homelab Control Plane architecture and repo guardrails.

## Current State

- `apps/web/src/pages/settings-page.tsx` exposes a single `AI Provider` card that stores one installation-wide OpenAI runtime API key.
- `apps/api/src/modules/ai/ai-provider.service.ts` persists that key in `OpsMemory` under `ai_provider_v1`, returns only safe metadata, and writes `audit_events` on updates.
- `apps/api/src/modules/ai/ai.service.ts`, `apps/api/src/modules/checks/checks.service.ts`, `apps/api/src/modules/alerts/alerts.service.ts`, `apps/api/src/modules/service-discovery/service-discovery.service.ts`, and `apps/api/src/modules/dashboard-agent/dashboard-agent.service.ts` all depend on that runtime key for inference.
- `apps/api/src/modules/dashboard-agent/dashboard-agent.service.ts` already captures per-call token usage for dashboard-agent runs, but that data is limited to this application's own OpenAI responses and is not an organization spend ledger.
- There is no API or UI surface for OpenAI organization usage or cost data today.

## External Constraints

- OpenAI exposes organization usage and cost endpoints for this data:
  - Usage cookbook example: `https://cookbook.openai.com/examples/completions_usage_api`
  - Costs API reference: `https://platform.openai.com/docs/api-reference/usage/costs`
  - Administration API reference: `https://platform.openai.com/docs/api-reference/administration`
- The cookbook and administration docs indicate organization usage/cost access requires an OpenAI Admin API key.
- OpenAI administration docs also note Admin API keys cannot be used for non-administration endpoints, so the existing runtime inference key and the new telemetry credential must remain separate.
- Repo guardrails still apply:
  - every new API route must stay behind auth
  - secrets must never be logged or echoed back
  - every write requires explicit approval and an `audit_events` record

## Product Outcome

The Settings page gains a new `OpenAI Usage & Spend` card that shows the last cached usage/spend snapshot and lets the admin explicitly refresh it from OpenAI.

### User-visible behavior

1. The admin opens `Settings`.
2. If no OpenAI telemetry Admin API key is configured, the card explains what is missing and why the normal runtime key is insufficient.
3. The admin can save or clear a write-only telemetry Admin API key and optionally scope reporting to specific OpenAI project IDs.
4. After explicit confirmation, the admin can refresh the cached snapshot from OpenAI.
5. The card displays:
   - current scope: all projects or selected project IDs
   - snapshot freshness: last successful refresh and stale/error state
   - totals: spend today, spend month-to-date, spend over selected window
   - usage totals: requests, input tokens, output tokens, cached input tokens
   - daily chart for spend and token volume
   - breakdown tables for model, project, and cost line item where available
6. If the last refresh failed, the UI keeps the last successful snapshot visible and surfaces a safe error summary.

## Why Cached Snapshots Instead Of Live-On-Read

Read-only `GET` requests should stay read-only in this repo. If `GET /api/ai/usage/...` were to fetch from OpenAI and persist the response automatically, the page view would cause an unaudited write. That conflicts with the repo rule that write actions require explicit approval and an audit record.

This design therefore uses:

- read-only `GET` routes to return the last cached snapshot
- explicit confirmed `PUT` or `POST` routes for config changes and manual refreshes
- audit records for every persisted change

## Proposed Backend Design

### 1. Keep runtime AI config and telemetry config separate

Do not overload `ai_provider_v1`. The existing key powers model inference and should keep its current semantics.

Add separate installation-level `OpsMemory` keys owned by the local admin account:

- `ai_usage_telemetry_v1`
- `ai_usage_snapshot_v1`

`ai_usage_telemetry_v1` payload:

```json
{
  "adminKeyEncrypted": "ciphertext",
  "projectIds": ["proj_123", "proj_456"],
  "updatedAt": "derived from row timestamp"
}
```

`ai_usage_snapshot_v1` payload:

```json
{
  "source": "openai_admin_api",
  "windowDays": 90,
  "scope": {
    "projectIds": ["proj_123", "proj_456"]
  },
  "syncedAt": "2026-03-23T00:00:00.000Z",
  "currency": "usd",
  "totals": {
    "spendTotal": 12.34,
    "spendToday": 0.42,
    "spendMonthToDate": 8.91,
    "requests": 1234,
    "inputTokens": 456789,
    "outputTokens": 98765,
    "cachedInputTokens": 12345
  },
  "series": {
    "dailySpend": [],
    "dailyUsage": []
  },
  "breakdowns": {
    "byModel": [],
    "byProject": [],
    "byLineItem": []
  },
  "lastError": null
}
```

Why `OpsMemory` first:

- it matches the current pattern for installation-wide AI settings
- it avoids a Prisma migration for the first version
- the feature is settings-only, so query flexibility is less important than controlled rollout

If the snapshot payload becomes too large in practice, a later follow-up can move snapshots to a dedicated table.

### 2. Add a dedicated `AiUsageService`

Create a new API module and service, for example:

- `apps/api/src/modules/ai/ai-usage.service.ts`
- `apps/api/src/modules/ai/ai-usage.controller.ts`

Responsibilities:

- read safe telemetry config metadata
- encrypt/decrypt the telemetry Admin API key through `SecurityService`
- fetch organization usage and cost data from OpenAI
- normalize OpenAI bucketed responses into a stable internal snapshot
- persist refreshed snapshots only on explicit write actions
- write safe audit events for config changes and refreshes

Implementation note:

Use direct HTTPS requests via Node `fetch` rather than assuming the current `openai` SDK exposes the administration endpoints the same way it exposes `responses.create`. This keeps the implementation explicit and easy to mock in tests.

### 3. New authenticated API routes

All routes stay under the existing authenticated `ai` controller/module surface or a sibling authenticated module.

Recommended routes:

- `GET /api/ai/usage-config`
  - returns safe metadata only
  - response:

```json
{
  "configured": true,
  "projectIds": ["proj_123"],
  "updatedAt": "2026-03-23T00:00:00.000Z",
  "lastSyncedAt": "2026-03-23T00:15:00.000Z"
}
```

- `PUT /api/ai/usage-config`
  - body includes `confirm: true`
  - saves or clears the Admin API key
  - updates optional project scope
  - writes `audit_events`

- `GET /api/ai/usage-summary?windowDays=7|30|90`
  - returns the last cached snapshot, trimmed to the requested window
  - never mutates storage

- `POST /api/ai/usage-refresh`
  - body includes `confirm: true`
  - fetches fresh usage/cost data from OpenAI
  - persists a new cached snapshot
  - writes `audit_events`

### 4. OpenAI fetch plan

On refresh:

1. Read and decrypt the telemetry Admin API key.
2. Fetch daily usage buckets from the organization usage endpoint for the last 90 days.
3. Fetch daily cost buckets from the organization costs endpoint for the last 90 days.
4. Fetch grouped 30-day rollups for:
   - model
   - project
   - cost line item
5. Apply optional `project_ids` filtering to every request when the admin scoped the telemetry config.
6. Normalize null or missing fields to `0` or `null` according to the shared schema.
7. Persist a single snapshot record with `syncedAt`, scope, totals, series, and breakdowns.

If OpenAI returns an error:

- do not erase the previous snapshot
- store a safe `lastError` summary inside the snapshot metadata or config metadata
- return the failure to the client without logging raw headers, raw credentials, or full upstream payloads

### 5. Shared contracts

Add new Zod schemas and exported types in `packages/shared/src/schemas.ts` and `packages/shared/src/index.ts`.

New contract families:

- telemetry config request/response
- usage summary response
- refresh request/response
- series item schemas
- breakdown row schemas

Keep the current `AiProviderConfigResponse` unchanged for this task. The runtime provider card and the telemetry card should be adjacent but independent.

## Proposed Frontend Design

### Settings layout

Add a new card directly below `AI Provider` in `apps/web/src/pages/settings-page.tsx`:

- title: `OpenAI Usage & Spend`
- description: `View cached organization usage and spend from OpenAI administration APIs.`

The card should have four UI states.

### State A: telemetry not configured

Show:

- explanation that this feature requires an OpenAI Admin API key
- explanation that the existing runtime key only powers inference and chat features
- write-only password field for the telemetry Admin API key
- optional textarea or tokenized input for project ID scoping
- `Save Telemetry Key` button

### State B: configured, no snapshot yet

Show:

- safe config metadata
- `Refresh Usage Data` button
- empty-state message: `No usage snapshot has been captured yet. Refresh to pull data from OpenAI.`

### State C: snapshot available

Show:

- freshness banner with last sync timestamp
- window selector: `7d`, `30d`, `90d`
- summary metrics:
  - spend today
  - month-to-date spend
  - window spend total
  - request count
  - input tokens
  - output tokens
- visualizations:
  - daily spend bars
  - daily token/request line or stacked area
- breakdown tables:
  - by model
  - by project
  - by line item

### State D: partial failure / stale cache

Show:

- previous snapshot
- warning banner with last failure timestamp and safe message
- refresh CTA

## Security And Audit Requirements

- Never return the telemetry Admin API key after save.
- Never log OpenAI authorization headers or raw upstream response bodies that may echo metadata unexpectedly.
- Require `confirm: true` on:
  - `PUT /api/ai/usage-config`
  - `POST /api/ai/usage-refresh`
- Emit `audit_events` for:
  - `ai.usage.config.update`
  - `ai.usage.refresh`
- Audit payloads should include only safe metadata such as:
  - configured `true/false`
  - project scope count
  - window days
  - success/failure
  - row ids or logical target ids

## Multi-Agent Execution Plan

Implementation should be split into serial phases so schema and API contracts stabilize before UI work starts.

### Agent 1: Contract And Persistence Agent

Goal:

- define shared schemas and backend persistence contracts

Files:

- `packages/shared/src/schemas.ts`
- `packages/shared/src/index.ts`
- `apps/web/src/types/api.ts` if generated or maintained manually in this repo
- `apps/api/src/modules/ai/ai.module.ts`
- new backend files for usage config/snapshot service contracts

Tasks:

- add Zod schemas for telemetry config, usage snapshot, refresh actions, series rows, and breakdown rows
- add safe TypeScript exports
- define `OpsMemory` key names and service method contracts
- preserve the current `AiProviderConfigResponse` contract

Verification:

- shared schema tests covering valid, null, and malformed snapshot payloads

### Agent 2: Backend OpenAI Usage Integration Agent

Goal:

- implement authenticated usage config and refresh APIs

Files:

- `apps/api/src/modules/ai/ai.controller.ts` or sibling controller
- new `apps/api/src/modules/ai/ai-usage.service.ts`
- `apps/api/src/modules/ai/ai.module.ts`
- `apps/api/test/...`

Tasks:

- store encrypted telemetry Admin API keys in `OpsMemory`
- implement safe metadata reads
- call OpenAI organization usage and costs endpoints with `fetch`
- normalize 90-day daily buckets plus 30-day grouped breakdowns
- persist snapshots only on explicit refresh
- write audit events for config changes and refreshes
- ensure all new routes remain behind auth guards

Verification:

- unit tests for config save/clear
- unit tests for upstream normalization
- integration-style controller tests for auth, validation, and safe responses

### Agent 3: Settings UI Agent

Goal:

- expose telemetry config and cached snapshot data in Settings

Files:

- `apps/web/src/pages/settings-page.tsx`
- `apps/web/src/types/api.ts`
- `apps/web/test/settings-page.test.tsx`

Tasks:

- add queries for telemetry config and cached summary
- add mutations for save/clear and refresh
- add four-state UI behavior described above
- add window selector and summary/breakdown rendering
- keep the existing AI Provider card unchanged except for nearby explanatory copy if needed

Verification:

- UI tests for unconfigured, configured-empty, ready, and stale-error states
- query invalidation tests after save/clear/refresh

### Agent 4: Quality And Security Agent

Goal:

- validate guardrails and regressions

Files:

- targeted test files in `apps/api/test` and `apps/web/test`

Tasks:

- verify all new routes are authenticated
- verify secrets never appear in responses or audit payloads
- verify write endpoints require `confirm: true`
- verify stale cache behavior does not blank out old data after failed refresh

Verification:

- `pnpm --filter @homelab/api test`
- `pnpm --filter @homelab/web test`

### Agent 5: Docs And Operations Agent

Goal:

- document operator setup and failure modes

Files:

- `docs/OPERATIONS.md`
- `docs/ENVIRONMENT_SETUP.md`

Tasks:

- document the difference between runtime key and telemetry Admin API key
- document optional project scoping
- document refresh semantics and stale snapshot behavior
- document common OpenAI failure modes: unauthorized, missing admin privileges, empty project scope

Verification:

- doc review plus any repo hygiene checks used for markdown changes

## Suggested Test Matrix

- save telemetry key with `confirm: true`
- clear telemetry key with `confirm: true`
- reject save without `confirm: true`
- reject refresh without configured telemetry key
- reject refresh without `confirm: true`
- successful refresh with unscoped org-wide data
- successful refresh with project-scoped data
- upstream 401 leaves prior snapshot intact
- upstream malformed bucket is normalized or rejected safely
- settings page renders cached data when refresh previously succeeded
- settings page shows stale warning when the last refresh failed

## Rollout Notes

- release as OpenAI-only first; do not tie this work to provider-selection changes from TASK-001
- keep the runtime AI card stable so existing chat/analysis features are unaffected
- prefer cached read models over live fetches to preserve auditability

## Open Questions

- Should month-to-date spend be org-wide calendar month only, or should the UI also offer a billing-cycle-aligned view?
- Do we want optional automatic scheduled refresh later, and if so, how should that interact with the repo rule requiring explicit approval for writes?
- Is `OpsMemory` snapshot size still acceptable once 90-day daily series plus grouped breakdowns are stored, or should the implementation jump directly to a dedicated table?
