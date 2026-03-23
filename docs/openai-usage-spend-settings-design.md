# TASK-002 Design: OpenAI Usage And Spend In Settings

## Goal

Add a Settings surface that lets an authenticated admin view OpenAI usage and spend without exposing secrets, while staying inside the repo rules for auth, approvals, auditing, and allowlisted behavior.

## Current Baseline

- `apps/web/src/pages/settings-page.tsx` already renders an installation-wide `AI Provider` card and uses React Query mutations with `confirm: true` for write actions.
- `apps/api/src/modules/ai/ai-provider.service.ts` stores the runtime OpenAI API key in `OpsMemory` under `ai_provider_v1`, encrypts it through `SecurityService`, and emits `audit_events` on updates.
- `packages/shared/src/schemas.ts` already defines `aiProviderConfigUpdateSchema` and `AiProviderConfigResponse`, so the new telemetry feature should follow that contract style instead of mutating the existing provider schema.
- `apps/api/src/modules/dashboard-agent/dashboard-agent.service.ts` records per-call OpenAI token usage for dashboard-agent runs, but that is application-local telemetry, not organization-wide usage or spend.

## Verified External Constraints

- OpenAI administration endpoints require an Admin API key, and OpenAI states that Admin API keys cannot be used for non-administration endpoints. Verified from the Administration Overview on March 23, 2026: <https://developers.openai.com/api/reference/administration/overview>
- OpenAI's official usage/cost cookbook shows the organization Costs API at `/v1/organization/costs`, the Completions Usage API, optional `project_ids`, `group_by`, and pagination through `next_page`. Verified on March 23, 2026: <https://developers.openai.com/cookbook/examples/completions_usage_api>
- Inference from the current Administration reference: usage reporting is capability-specific rather than a single generic usage endpoint, so v1 should not assume one universal organization usage API.
- Repo guardrails still apply:
  - every new route must remain behind auth
  - no secrets, tokens, or raw credential payloads may be logged or returned
  - every persisted write requires explicit approval and an `audit_events` record

## Product Outcome

Add a second Settings card named `OpenAI Usage & Spend` directly below `AI Provider`.

User-visible behavior:

1. Admin opens `Settings`.
2. If telemetry is not configured, the card explains that usage/spend reporting requires a separate OpenAI Admin API key and that the existing runtime key is not sufficient.
3. Admin can save or clear a write-only telemetry Admin API key and optionally scope reporting to one or more OpenAI project IDs.
4. Admin can explicitly refresh the cached telemetry snapshot after confirmation.
5. The card shows:
   - configured scope: all projects or selected project IDs
   - last successful refresh timestamp
   - stale/error banner when the latest refresh failed
   - spend today, month-to-date spend, and spend over the selected window
   - request count, input tokens, output tokens, and cached input tokens for text-model usage
   - daily spend and daily text-usage charts
   - grouped breakdowns by model, project, and cost line item where upstream data exists
6. If refresh fails, the UI keeps the last successful snapshot visible and overlays a safe error summary instead of blanking the card.

## Primary Decisions

### 1. Keep runtime inference credentials and telemetry credentials separate

Do not overload `ai_provider_v1`.

Reasoning:

- the runtime key is already used by `AiService`, checks, alerts, service discovery, and dashboard-agent flows
- OpenAI explicitly separates Admin API keys from non-administration usage
- mixing the two credentials would either break runtime inference or over-privilege normal inference traffic

### 2. Use cached snapshots, not live-on-read fetches

`GET` routes should remain read-only in this repo. If a page load caused the backend to fetch from OpenAI and persist fresh data automatically, the UI would trigger an unaudited write.

Therefore v1 uses:

- read-only `GET` routes for safe metadata and the last successful snapshot
- explicit confirmed `PUT` and `POST` routes for telemetry config changes and refreshes
- `audit_events` for every write path

### 3. Scope v1 usage metrics to text-model activity and use the Costs API as the source of truth for spend

Spend and usage are not symmetric in the OpenAI admin APIs.

- Spend should come from the organization Costs API.
- Token and request counts in v1 should come from the Completions Usage API, because those fields align with what this product already surfaces elsewhere and with how this repo currently uses OpenAI.
- If an admin leaves telemetry unscoped at the organization level, spend may include non-text modalities that do not show up in token totals. The UI should call this out.
- If the admin scopes telemetry to the project used by this application, spend and usage totals will be much easier to reconcile.

This is the best first version because it is implementable against the current docs and matches the repo's actual OpenAI usage today.

### 4. Store config/error metadata separately from the last successful snapshot

Use two installation-level `OpsMemory` records owned by the local admin account:

- `ai_usage_telemetry_v1`
- `ai_usage_snapshot_v1`

`ai_usage_telemetry_v1` holds the encrypted Admin API key, project scope, and the latest refresh status metadata.

Example shape:

```json
{
  "adminKeyEncrypted": "ciphertext",
  "projectIds": ["proj_123", "proj_456"],
  "lastRefreshAttemptAt": "2026-03-23T10:00:00.000Z",
  "lastRefreshSucceededAt": "2026-03-23T09:15:00.000Z",
  "lastRefreshError": {
    "message": "OpenAI rejected the admin credential.",
    "occurredAt": "2026-03-23T10:00:01.000Z"
  }
}
```

`ai_usage_snapshot_v1` stores only the last successful snapshot.

Example shape:

```json
{
  "source": "openai_admin_api",
  "coverage": {
    "spendSource": "organization.costs",
    "usageSources": ["organization.usage.completions"],
    "usageScope": "text_generation"
  },
  "windowDays": 90,
  "scope": {
    "projectIds": ["proj_123", "proj_456"]
  },
  "syncedAt": "2026-03-23T09:15:00.000Z",
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
  }
}
```

Why `OpsMemory` first:

- it matches the existing installation-wide AI settings pattern
- it avoids a migration for the first release
- this feature is settings-oriented and read-light

If the 90-day payload becomes too large, move snapshots to a dedicated table in a follow-up.

## Backend Design

### Service shape

Add a dedicated service rather than growing `AiProviderService`:

- `apps/api/src/modules/ai/ai-usage.service.ts`
- `apps/api/src/modules/ai/ai.controller.ts` additions
- `apps/api/src/modules/ai/ai.module.ts` wiring

Responsibilities:

- read safe telemetry config metadata
- encrypt and decrypt the telemetry Admin API key through `SecurityService`
- fetch spend and usage data from OpenAI administration endpoints
- normalize upstream bucketed responses into a stable internal snapshot
- preserve the last successful snapshot when refresh fails
- emit safe `audit_events` for config writes and refresh writes

Implementation note:

Use direct `fetch` calls for the administration endpoints instead of assuming the current `openai` SDK surface mirrors the admin API. This keeps the implementation explicit and easy to stub in tests.

### API routes

Keep the routes under the existing authenticated `ai` controller surface.

- `GET /api/ai/usage-config`
  - returns safe metadata only
  - includes `configured`, `projectIds`, `updatedAt`, `lastRefreshAttemptAt`, `lastRefreshSucceededAt`, and `lastRefreshError`

- `PUT /api/ai/usage-config`
  - body requires `confirm: true`
  - saves or clears the Admin API key
  - updates optional `projectIds`
  - writes `audit_events`

- `GET /api/ai/usage-summary?windowDays=7|30|90`
  - returns the last successful snapshot trimmed to the requested window
  - also returns refresh status metadata from `ai_usage_telemetry_v1`
  - never mutates storage

- `POST /api/ai/usage-refresh`
  - body requires `confirm: true`
  - fetches fresh data from OpenAI
  - updates refresh status metadata
  - replaces `ai_usage_snapshot_v1` only after a successful fetch/normalize cycle
  - writes `audit_events`

### Refresh workflow

On refresh:

1. Read and decrypt the stored Admin API key.
2. Resolve scope from `projectIds`, or use org-wide scope when empty.
3. Fetch 90 days of daily costs from `/v1/organization/costs`.
4. Fetch grouped cost breakdowns for the recent window using `group_by`, at minimum:
   - `project_id`
   - `line_item`
5. Fetch 90 days of daily text usage from the Completions Usage API.
6. Fetch grouped text-usage breakdowns using `group_by`, at minimum:
   - `model`
   - `project_id`
7. Apply `project_ids` consistently to every upstream request when scoped.
8. Use pagination and/or bounded request windows; do not assume a single 90-bucket call will always be accepted.
9. Normalize missing numeric fields to `0` and optional grouping fields to `null`.
10. Persist `ai_usage_snapshot_v1` only after the snapshot is complete.
11. Update refresh status metadata and audit the result.

Important upstream details from the cookbook:

- grouped fields like `model` and `project_id` are only meaningful when `group_by` is supplied
- admin responses are paginated with `next_page`
- the Costs API example is daily-bucket based, with `bucket_width: "1d"`

### Error handling

If OpenAI returns an error or malformed data:

- do not delete or overwrite the previous successful snapshot
- update only refresh status metadata with a safe summary
- surface a safe client error message
- never log headers, secrets, or full upstream response bodies

## Shared Contracts

Add new shared Zod schemas in `packages/shared/src/schemas.ts` and exports in `packages/shared/src/index.ts`.

Contract families:

- telemetry config response
- telemetry config update request
- usage summary response
- refresh request and refresh response
- daily series row schemas
- breakdown row schemas

Keep `AiProviderConfigResponse` unchanged. The runtime AI configuration and telemetry configuration are adjacent concerns, not one merged payload.

## Frontend Design

Add a new card directly below `AI Provider` in `apps/web/src/pages/settings-page.tsx`.

Card copy:

- title: `OpenAI Usage & Spend`
- description: `View cached OpenAI administration telemetry for this installation.`

### UI state A: telemetry not configured

Render:

- explanation that the feature requires an OpenAI Admin API key
- explanation that the existing runtime key only powers inference
- write-only password input for the Admin API key
- optional project ID scoping input
- `Save Telemetry Key` button

### UI state B: configured, no successful snapshot yet

Render:

- safe config metadata
- `Refresh Usage Data` button
- empty state copy: `No usage snapshot has been captured yet. Refresh to pull data from OpenAI.`

### UI state C: successful snapshot available

Render:

- freshness banner with last successful sync timestamp
- scope badge showing `All projects` or the selected project IDs
- a short caveat when org-wide spend may include non-text usage outside the text-model token totals
- window selector: `7d`, `30d`, `90d`
- summary metrics:
  - spend today
  - month-to-date spend
  - spend over selected window
  - request count
  - input tokens
  - output tokens
  - cached input tokens
- visualizations:
  - daily spend chart
  - daily request/token chart
- breakdown tables:
  - by model
  - by project
  - by line item

### UI state D: stale cache after failed refresh

Render:

- previous successful snapshot
- warning banner with failure timestamp and safe message
- refresh CTA

Mutation behavior:

- save/clear config invalidates telemetry config and usage summary queries
- refresh invalidates usage summary and telemetry config queries
- existing `AI Provider` behavior remains unchanged

## Security And Audit Requirements

- All new routes must remain authenticated and must not be marked public.
- Never return the Admin API key after save.
- Never log authorization headers, raw secrets, or upstream payloads.
- Require `confirm: true` on:
  - `PUT /api/ai/usage-config`
  - `POST /api/ai/usage-refresh`
- Emit `audit_events` for:
  - `ai.usage.config.update`
  - `ai.usage.refresh`
- Audit payloads may include only safe metadata:
  - configured `true/false`
  - number of project IDs
  - selected window
  - success/failure
  - logical ids or `OpsMemory` row ids

## Multi-Agent Rollout

Implementation should be executed serially because this repo does not allow parallel code-modification tasks.

Parent-agent instructions:

1. Spawn one implementation subagent per phase.
2. Pass this document plus the previous phase's diff and verification results into the next phase.
3. Do not let later agents redefine shared contracts without reopening the earlier phase.

### Agent 1: Contracts And Storage Agent

Goal:

- define shared types, request/response schemas, and persistence record shapes

Primary files:

- `packages/shared/src/schemas.ts`
- `packages/shared/src/index.ts`
- `apps/web/src/types/api.ts` if this repo maintains it manually
- `apps/api/src/modules/ai/ai.module.ts`
- any new backend contract files required by the AI module

Tasks:

- add schemas for telemetry config metadata, telemetry config updates, usage summary responses, refresh responses, series rows, and breakdown rows
- define the `ai_usage_telemetry_v1` and `ai_usage_snapshot_v1` record shapes
- preserve `AiProviderConfigResponse` and existing dashboard-agent usage contracts
- document any enum choices directly in schema comments if the values are not obvious

Handoff to Agent 2:

- exact schema names
- final JSON shapes for both `OpsMemory` values
- validation rules for `projectIds` and `windowDays`

Verification:

- schema tests for valid payloads
- schema tests for malformed snapshot data
- schema tests for `confirm: true` write requests

### Agent 2: Backend Telemetry Integration Agent

Goal:

- implement authenticated telemetry config, refresh, and read APIs

Primary files:

- `apps/api/src/modules/ai/ai.controller.ts`
- `apps/api/src/modules/ai/ai-usage.service.ts`
- `apps/api/src/modules/ai/ai.module.ts`
- targeted tests in `apps/api/test`

Tasks:

- implement config read/save/clear flows using `OpsMemory`, `SecurityService`, and `AuditService`
- fetch costs and completions usage from OpenAI admin endpoints with `fetch`
- support `project_ids`, `group_by`, and pagination
- normalize daily series and grouped breakdowns into the shared snapshot shape
- on failed refresh, preserve the old snapshot and update only refresh status metadata
- ensure route handlers use the shared Zod validation pipe and require `confirm: true` on writes

Handoff to Agent 3:

- final route list
- example API responses for each UI state
- exact safe error strings that the UI should display

Verification:

- unit tests for config save/clear
- unit tests for normalization and pagination handling
- controller tests for auth, validation, and confirm gating
- tests proving secrets never appear in responses or audit payloads

### Agent 3: Settings UI Agent

Goal:

- expose telemetry configuration and cached usage/spend data in Settings

Primary files:

- `apps/web/src/pages/settings-page.tsx`
- `apps/web/src/types/api.ts`
- `apps/web/test/settings-page.test.tsx`

Tasks:

- add React Query reads for telemetry config and usage summary
- add save/clear and refresh mutations with the same confirmation style used elsewhere on the page
- implement the four UI states defined above
- add the `7d`, `30d`, `90d` selector as a view filter over cached data
- show a caveat when spend may include non-text usage outside the token totals
- leave the existing `AI Provider` card behavior intact

Handoff to Agent 4:

- screenshots or DOM-level expectations for each UI state
- any copy strings that are intentionally user-facing API contracts

Verification:

- tests for unconfigured, configured-empty, ready, and stale-cache states
- tests for save/clear/refresh invalidation behavior
- tests that the stale banner does not hide the last successful snapshot

### Agent 4: QA And Security Agent

Goal:

- validate guardrails, regressions, and cross-layer behavior

Primary files:

- targeted API tests in `apps/api/test`
- targeted web tests in `apps/web/test`

Tasks:

- verify every new route is authenticated
- verify write endpoints reject requests without `confirm: true`
- verify refresh failures keep the last snapshot visible
- verify secrets are absent from responses, logs under test, and audit payloads
- verify project-scoped and org-wide responses both render correctly

Verification:

- targeted API test runs for the new AI telemetry coverage
- targeted web test runs for settings coverage
- `git diff --check` before handoff

### Agent 5: Operations And Follow-Through Agent

Goal:

- finish operator-facing documentation and release notes after code lands

Primary files:

- `docs/OPERATIONS.md`
- `docs/ENVIRONMENT_SETUP.md`
- release notes or changelog location used by the repo, if any

Tasks:

- document the difference between the runtime key and telemetry Admin API key
- document project scoping and the reconciliation caveat for org-wide spend vs text-only usage totals
- document manual refresh behavior and stale-cache behavior
- document common failure modes: invalid Admin API key, insufficient admin privileges, empty scoped project set, and upstream pagination or rate-limit failures

Verification:

- markdown formatting check
- doc review against the implemented route names and UI copy

## Suggested Test Matrix

- save telemetry key with `confirm: true`
- clear telemetry key with `confirm: true`
- reject save without `confirm: true`
- reject refresh without configured telemetry key
- reject refresh without `confirm: true`
- successful refresh with unscoped org-wide data
- successful refresh with project-scoped data
- grouped breakdowns populate when `group_by` is supplied
- upstream 401 leaves the prior snapshot intact
- upstream paginated response is fully aggregated
- malformed bucket payload is rejected or normalized safely
- settings page renders cached data after prior success
- settings page shows stale warning after failed refresh without blanking previous values

## Risks And Follow-Ups

- Org-wide spend may include non-text modalities that do not map cleanly onto token/request totals. The UI should make that caveat explicit.
- A future scheduled refresh feature would need a policy decision because repo rules require explicit approval for writes.
- If snapshot size grows beyond what is comfortable in `OpsMemory`, the snapshot should move to a dedicated table while keeping the same API contract.

## References

- OpenAI Administration Overview: <https://developers.openai.com/api/reference/administration/overview>
- OpenAI usage and costs cookbook: <https://developers.openai.com/cookbook/examples/completions_usage_api>
