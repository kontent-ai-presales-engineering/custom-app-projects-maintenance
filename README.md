# Content Model Sync for Kontent.ai

A Kontent.ai custom app that keeps the content model of client projects in sync with a master project.

Unity Advisory is moving from one Kontent.ai project with a collection per client to one project per client. Content models cannot be shared between projects, so this app runs inside the **master** project and pushes model changes **one way**, from master to client environments. It never syncs from a client to the master.

> **Status: in development.** This README describes the agreed design for Phase 1 and the roadmap. Each feature below is marked with its status. Until a feature is marked **Available**, it does not exist in the code yet. The repository currently contains the React custom app starter this app is built on.

## Contents

- [What it does](#what-it-does)
- [Safety rules](#safety-rules)
- [How it works](#how-it-works)
- [Client extensions: the reserved prefix](#client-extensions-the-reserved-prefix)
- [Destructive changes and content impact](#destructive-changes-and-content-impact)
- [Limitations](#limitations)
- [Requirements](#requirements)
- [Setup](#setup)
- [Environment variables](#environment-variables)
- [Local development](#local-development)
- [The data-ops patch](#the-data-ops-patch)
- [Security model](#security-model)
- [Not yet verified](#not-yet-verified)
- [Project structure](#project-structure)

## What it does

### Phase 1 (MVP)

| Feature | Description | Status |
|---|---|---|
| Sign-in | Microsoft Entra ID sign-in (OIDC, MSAL popup). Two roles, each mapped to Entra security groups: **operators** and **admins**. See [Roles](#roles). | Planned |
| Client registry | Register client projects by picking projects and environments from the Kontent.ai subscription (no manual ID entry). Assign dev and prod stages, notes and per-client sync settings. Flags subscription projects that are unregistered or inactive. | Planned |
| Secret store | Management API keys, the Delivery API key (optional) and the Subscription API key are stored encrypted (AES-256-GCM). Only admins can set, replace or remove keys, and nobody can read a key back in the UI. | Planned |
| Key audit log | Every key change is logged: who, when, which key and what action. The key value is never logged. | Planned |
| Diff | Compares the master environment with one client environment. Shows added, changed and removed entities with destructive changes highlighted, plus the full data-ops HTML report as optional detail. | Planned |
| Content impact | For destructive changes, counts the affected content (latest and published versions). Unknown counts are shown as "impact unknown", never as 0. | Planned |
| Sync | Applies the confirmed diff to **one** target environment after the user types the target project name. Shows progress and the result. | Planned |
| Pre-sync backup | Snapshots the target model before every sync. | Planned |
| Subscription users (optional) | Shows who has access to each client project. | Planned |

Content types, snippets and taxonomies are synced by default. Collections, spaces, languages and workflows are **opt-in per sync**.

### Phase 2

Selective sync of individual entities, exclusion management per client, restore from a pre-sync backup, and an audit log for syncs (user, time, source, target, entities, diff summary, result), extending the Phase 1 key audit log.

### Phase 3

Drift dashboard across all clients, batch rollout (dev environments first, then production), versioned master model releases with changelog notes, and onboarding of a new client project.

## Safety rules

These rules are enforced in the backend, not only in the UI:

- **One way only.** The master environment, and every environment in the master project, can never be a sync target.
- **Diff first.** Nothing is written without a diff the user has confirmed.
- **Explicit confirmation.** The user must type the target project name. Destructive changes and unknown impact need an additional confirmation.
- **No silent drift between confirm and run.** The diff is recomputed when the sync starts and compared with a hash of the confirmed diff. If anything changed, the sync aborts and asks for confirmation again.
- **One target at a time.** A sync writes to exactly one environment. Writes to the same environment never run in parallel.
- **Backup first.** The target model is snapshotted before any change is applied.
- **Client extensions are protected.** See [the reserved prefix](#client-extensions-the-reserved-prefix).

### Roles

Roles come only from the group claim in the Entra ID access token, never from Kontent.ai roles.

| Role | Entra groups | Can |
|---|---|---|
| Operator | `OIDC_ALLOWED_GROUP_IDS` | View the registry, run diffs, backups and syncs. Sees for each key only whether it is set, when it was last changed and by whom. Can never view, set, replace or remove a key. |
| Admin | `OIDC_ADMIN_GROUP_IDS` | Everything an operator can do, plus **Settings > Keys**, **Settings > Re-encrypt secrets**, and adding, changing or removing clients in the registry (a registry entry ties a key to an environment). |

A user in neither group is rejected. A user in an admin group does not also need to be in an operator group.

## How it works

```
Kontent.ai (master project)
  └─ Custom app (this React app, full screen, iframe)
        │  Bearer token (Entra ID)
        ▼
Netlify Functions (/api/*)
  ├─ auth: validate token issuer, audience, signature, group claim
  ├─ registry, secrets, jobs (Netlify Blobs, keys encrypted)
  └─ background functions: snapshot, diff, backup, sync
        │
        ├─ Subscription API (read-only): projects, environments, users
        ├─ Management API: master (read), client environments (read/write)
        └─ Delivery API: published content counts (impact checks)
```

All Kontent.ai API calls and all data-ops calls run in the backend. The browser never sees an API key.

### Sync pipeline

The diff and apply logic comes from [`@kontent-ai/data-ops`](https://github.com/kontent-ai/data-ops), so data-ops is the single source of truth for both. This app only **removes** operations from the data-ops diff and never creates its own.

1. **Pin the master.** Snapshot the master model and store it. The same snapshot is used for diff and sync.
2. **Diff.** data-ops computes the structured diff between the pinned snapshot and the target, for the chosen entity types only.
3. **Filter.** Remove operations that would touch client extensions (reserved prefix).
4. **Check.** Classify destructive changes, count content impact, and apply the blocking rules.
5. **Report.** Show the summary and the data-ops HTML report, both generated from the filtered diff.
6. **Confirm.** The user confirms the target project name and any destructive changes.
7. **Re-diff.** Recompute steps 2 to 4 and compare with the hash of the confirmed diff. Abort if they differ.
8. **Backup.** Snapshot the target model.
9. **Validate and apply.** Run data-ops validation, then data-ops applies the filtered diff.

Long-running steps run as Netlify background functions. The UI polls the job status.

## Client extensions: the reserved prefix

Client-specific additions use a reserved codename prefix, `client_` by default (configurable).

The prefix applies to:

- content types, snippets and taxonomy groups
- elements inside master types and snippets (for snippet elements, the part after `<snippet>__` is checked)
- taxonomy terms
- multiple choice options
- collections, spaces and asset folders

It does **not** apply to workflow steps.

Rules:

- **The master may never use the prefix.** A master snapshot that contains a prefixed codename is refused.
- **Prefixed removals are filtered out automatically.** Sync never deletes or removes anything with the prefix.
- **The sync is blocked** if a prefixed removal is still present after filtering.
- **Content groups:** the sync is blocked if it would remove a content group that still contains elements. Move or remove those elements in the master first.

## Destructive changes and content impact

| Change | Behaviour |
|---|---|
| Master-owned element removed while it holds content in the client | Destructive. Shows the number of affected variants. Requires explicit confirmation. |
| Content type removed while items use it | Blocked by data-ops validation. |
| Element type changed | Blocked by data-ops validation. |
| Snippet or taxonomy group removed | Destructive. Requires confirmation. |
| Taxonomy term or multiple choice option removed | Destructive. Shows affected variants. Requires confirmation. |
| Language deactivated or default language codename changed | Destructive. Shows variants per language. Requires confirmation. |
| Workflow step removed while variants are in it | **Blocked** until the Management API behaviour has been verified on a sandbox. Allowed when no variants are in the step. |
| Workflows synced | Warning: role limitations on workflows are lost (a data-ops limitation). |

Impact counts cover both the latest version (Management API) and the published version (Delivery API). If a count cannot be determined, the UI shows **impact unknown** and requires confirmation.

## Limitations

What this app cannot do, mostly because of data-ops or the Kontent.ai APIs:

- **Not synced:** roles, webhooks, preview URLs, custom apps and custom element settings. These per-client settings are never touched.
- **No projects created through the API.** A new client project is created by hand in Kontent.ai, then registered here. The Subscription API is read-only in this app.
- **Environments can only be created by cloning** within a project (Phase 3 onboarding).
- **Restore covers the model structure, not the content.** Content in elements that a sync removed is not brought back.
- **Asset folders** cannot be moved (data-ops deletes and recreates them) and cannot be deleted while they contain assets.
- **Languages** are never deleted. data-ops deactivates them and renames them to a random 8-character name and codename.
- **External IDs** are not synced. Entities are matched by codename.
- **Rate limits:** the Management API allows 10 requests per second and 400 per minute per environment. Large models take time to sync.

## Requirements

- Node.js 22 or later (required by data-ops)
- pnpm 10
- A Netlify site with Functions, Background Functions and Blobs. Check that your Netlify plan includes Background Functions.
- A Microsoft Entra ID tenant where you can create an app registration and a security group
- Kontent.ai:
  - a master project
  - a Management API key per project (master and each client)
  - a Subscription API key (requires a subscription admin)
  - optionally, a Delivery API key with secure access for environments that have secure access enabled

## Setup

### 1. Install

```bash
pnpm install
```

### 2. Create the Entra ID app registration

1. In Entra ID, create an app registration (single tenant). Note the **Application (client) ID** and **Directory (tenant) ID**.
2. Under **Authentication**, add a **Single-page application** platform with the redirect URI `https://<your-site>/auth/redirect`. Add `https://localhost:5173/auth/redirect` for local development. This path is a blank page that only runs MSAL's redirect bridge (`broadcastResponseToMainFrame` from `@azure/msal-browser/redirect-bridge`) to hand the sign-in result back to the app. It does not load the app itself.
3. Under **Expose an API**, set the application ID URI (for example `api://<client-id>`) and add a scope, for example `access`.
4. In the **Manifest**, set `requestedAccessTokenVersion` (shown as `accessTokenAcceptedVersion` in older manifests) to `2`, so access tokens use the v2 issuer and the client ID as audience.
5. Under **Token configuration**, add the **groups** claim (security groups) to the access token.
6. Create two security groups: one for operators and one for admins. Note their object IDs.

If users belong to many groups, Entra ID may omit the groups from the token. Limit the claim to groups assigned to the application to avoid this. A token without the groups claim is always rejected.

### 3. Create the Kontent.ai API keys

In each project, go to **Project settings > API keys > Management API keys > Create Management API key**. Limit each key to the environments the app needs. Set an expiry date, and note it: the maximum is 2 years.

| Key | Permissions |
|---|---|
| Master project | Manage content model, Manage environment settings, Read content, Read assets. Add Manage environments only if you sync live preview. The master is read-only in this app, but reading the model requires these permissions. |
| Each client project | Manage content model, Manage environment settings, Read content, Read assets, Create, edit, and delete assets (for asset folders). Add Manage environments for live preview sync and Phase 3 onboarding. |
| Subscription API key | From subscription administration. This key can activate and deactivate users across all projects. The app wraps it so only GET requests are possible. |
| Delivery API key (optional) | Secure access, for client environments with secure access enabled. Used for published content counts. |

### 4. Generate the encryption key

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Store the output as `SECRETS_ENCRYPTION_KEY` in Netlify. Never commit it.

### 5. Deploy to Netlify

1. Create a Netlify site from this repository.
2. Set the [environment variables](#environment-variables) in **Site configuration > Environment variables**.
3. Deploy. `netlify.toml` sets `Content-Security-Policy: frame-ancestors https://app.kontent.ai` so the app can only be framed by Kontent.ai.

### 6. Register the custom app in Kontent.ai (master project only)

1. In the master environment, go to **Environment settings > Custom apps > Create new custom app**.
2. **App name:** for example, Content Model Sync.
3. **Hosted code URL (HTTPS):** your Netlify site URL.
4. **Roles that can work with this app:** the roles that should see the app. This only controls visibility in the menu. Access is enforced by the Entra ID group.
5. **Display mode:** Full screen.
6. **Parameters {JSON}:** leave empty. Never put API keys or other secrets here.
7. Click **Save changes**.

### 7. First run

An admin does steps 1 to 4. Operators can then run diffs and syncs.

1. Open the app from **Custom apps** in Kontent.ai and sign in with Entra ID.
2. Under **Settings > Keys**, add the Subscription API key and the master Management API key.
3. Under **Clients**, pick a client project and its environments from the subscription, add its Management API key, and assign stages (dev and prod).
4. Use **Test connection** to check that each key works, then run your first diff.

## Environment variables

Server-side variables are only available to Netlify Functions. `VITE_` variables are embedded in the frontend bundle and must not contain secrets.

| Variable | Side | Description |
|---|---|---|
| `KONTENT_SUBSCRIPTION_ID` | Server | Kontent.ai subscription ID |
| `KONTENT_MASTER_ENVIRONMENT_ID` | Server | Master environment ID. Never accepted as a sync target. |
| `CLIENT_PREFIX` | Server | Reserved prefix for client extensions. Default: `client_` |
| `SECRETS_ENCRYPTION_KEY` | Server | Base64, 32 bytes. Encrypts the stored API keys. |
| `SECRETS_ENCRYPTION_KEY_PREVIOUS` | Server | Optional. The previous key during encryption key rotation. |
| `OIDC_TENANT_ID` | Server | Entra directory (tenant) ID |
| `OIDC_CLIENT_ID` | Server | Application (client) ID of the app registration |
| `OIDC_AUDIENCE` | Server | Optional. Comma-separated accepted `aud` values. Default: `OIDC_CLIENT_ID` (the v2 token audience). |
| `OIDC_ISSUER` | Server | Optional. Default: `https://login.microsoftonline.com/<OIDC_TENANT_ID>/v2.0`. Signing keys are found through the issuer's OpenID configuration. |
| `OIDC_ALLOWED_GROUP_IDS` | Server | Comma-separated group object IDs for **operators** |
| `OIDC_ADMIN_GROUP_IDS` | Server | Comma-separated group object IDs for **admins** |
| `VITE_OIDC_AUTHORITY` | Frontend | For example `https://login.microsoftonline.com/<tenant-id>` |
| `VITE_OIDC_CLIENT_ID` | Frontend | Same value as `OIDC_CLIENT_ID` |
| `VITE_OIDC_SCOPES` | Frontend | For example `api://<client-id>/access` |

The backend refuses to start a request if a required server variable is missing or if `OIDC_ALLOWED_GROUP_IDS` and `OIDC_ADMIN_GROUP_IDS` are both empty.

`.env.example` lists the same variables for local development.

### Rotating keys

Both are admin tasks, and both are recorded in the audit log.

- **Kontent.ai API keys:** regenerate the key in Kontent.ai, then enter the new value in the app. The old value is overwritten. Keys are never shown again after they are saved.
- **Encryption key:** set the new key as `SECRETS_ENCRYPTION_KEY` and the old one as `SECRETS_ENCRYPTION_KEY_PREVIOUS`, deploy, run **Settings > Re-encrypt secrets**, then remove the previous key.

## Local development

```bash
pnpm dev          # frontend only, https://localhost:5173 (self-signed certificate)
netlify dev       # frontend + functions + Blobs (requires the Netlify CLI)
```

Kontent.ai only loads custom apps over HTTPS. To open your local app inside Kontent.ai, register a separate custom app in a non-production environment that points to a secure tunnel to your machine (for example ngrok).

### Scripts

| Command | Description |
|---|---|
| `pnpm build` | Type-check and build |
| `pnpm test` | Unit tests (Vitest), with Kontent.ai APIs and data-ops mocked |
| `pnpm lint` | ESLint |
| `pnpm biome:check` | Biome lint and format check |
| `pnpm check:data-ops` | Fails if the installed data-ops version differs from the validated version |

CI runs Biome, ESLint, the tests, the data-ops version check and the build.

## The data-ops patch

This app uses four data-ops functions that are part of the package but not part of its public API: the structured diff, diff validation, applying a diff, and the HTML report. They are exposed through a small `pnpm patch` that only adds `exports` entries to the data-ops `package.json`. No data-ops code is changed.

Safeguards:

- data-ops is pinned to an **exact** version in `package.json`.
- The patch lives in `patches/` and is covered by contract tests on the diff format.
- `pnpm check:data-ops` fails the build when the installed version differs from the validated version.
- An upstream request asks data-ops to make these functions public. Once released, the patch will be removed.

### Upgrading data-ops

1. Update the exact version in `package.json` and regenerate the patch with `pnpm patch`.
2. Run `pnpm test`. The contract tests must pass, including the test that diff and sync produce the same operations for each entity combination.
3. Run a diff and sync against a sandbox client environment.
4. Update the validated version used by `pnpm check:data-ops`.

## Security model

- **Authorisation** is based only on the Entra ID access token. The backend validates its issuer, audience, signature, expiry and group claim on every request, and checks the role for each endpoint. The Kontent.ai custom app context is used for display only, never for authorisation: Kontent.ai does not sign it.
- **Tokens** are kept in memory and sent as bearer tokens. No cookies are used.
- **API keys** are encrypted with AES-256-GCM in Netlify Blobs. They are never sent to the browser. Only admins can set them. The secret store is behind an interface so Azure Key Vault can replace it later.
- **Audit log:** every key change and re-encryption is recorded (user, time, key, action), without the key value.
- **The Subscription API key** is wrapped so only GET requests are possible.
- **Framing** is limited to `https://app.kontent.ai`.

Remaining risks:

- Any operator can sync to any registered client. Keep both groups small.
- Anyone with access to the Netlify site's environment variables, together with the Blobs data, can decrypt all keys. Limit Netlify team access.
- `frame-ancestors` restricts framing, not direct calls to the API. The API relies on token validation.
- Kontent.ai API keys expire (maximum 2 years for Management API keys). Track expiry dates in the registry.

## Not yet verified

These points will be tested during Phase 1, and this README will be updated with the results:

- Entra ID sign-in through an MSAL popup opened from the sandboxed Kontent.ai iframe
- What the Management API does with variants in a workflow step that is removed (blocked until verified)
- Whether the Netlify plan in use includes Background Functions, and the synchronous function timeout
- Whether data-ops fits comfortably within the Netlify function bundle size limits

## Project structure

Planned layout:

```
src/                  React custom app (frontend)
netlify/functions/    API endpoints and background functions
server/               Service layer: auth, secrets, registry, jobs, Kontent.ai clients, sync engine adapter
patches/              pnpm patch for @kontent-ai/data-ops
scripts/              Build checks (data-ops version guard)
```

Built on the [Kontent.ai custom app starter for React](https://github.com/kontent-ai/custom-app-starter-react) and the [Custom app SDK](https://github.com/kontent-ai/custom-app-sdk-js).

## Learn more

- [Kontent.ai custom apps](https://kontent.ai/learn/docs/custom-apps)
- [Management API](https://kontent.ai/learn/docs/apis/management-api-v2/introduction)
- [Subscription API](https://kontent.ai/learn/docs/apis/subscription-api/introduction)
- [data-ops](https://github.com/kontent-ai/data-ops)

## License

MIT
