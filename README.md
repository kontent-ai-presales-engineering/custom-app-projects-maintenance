# Content Model Sync for Kontent.ai

A Kontent.ai custom app that keeps the content model of client projects in sync with a master project.

Unity Advisory is moving from one Kontent.ai project with a collection per client to one project per client. Content models cannot be shared between projects, so this app runs inside the **master** project, lists every project in the Kontent.ai subscription, and pushes model changes **one way**, from the master to client projects. It never syncs from a client to the master.

> **Status: in development.** This README describes the agreed design for Phase 1 and the roadmap. Each feature below is marked with its status. Until a feature is marked **Available**, it does not exist in the code yet.

## Contents

- [What it does](#what-it-does)
- [Safety rules](#safety-rules)
- [How it works](#how-it-works)
- [Access control](#access-control)
- [Management API keys](#management-api-keys)
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
| Access check | Every API call needs the access secret from the custom app parameters and a Kontent.ai user who is active in the master environment with an allowed role. See [Access control](#access-control). | In progress |
| Project overview | Lists all projects and environments in the Kontent.ai subscription and shows, per environment, whether a Management API key is configured. For a missing key it shows the exact environment variable to add. | Planned |
| Diff | Compares the master environment with one client environment. Shows added, changed and removed entities with destructive changes highlighted, plus the full data-ops HTML report as optional detail. | Planned |
| Content impact | For destructive changes, counts the affected content (latest and published versions). Unknown counts are shown as "impact unknown", never as 0. | Planned |
| Pre-sync backup | Snapshots the target model before every sync. | Planned |
| Sync | Applies the confirmed diff to **one** target environment after the user types the target project name. Shows progress and the result. | Planned |
| Audit log | Records every backup and sync: who, when, which target, result. | Planned |

Content types, snippets and taxonomies are synced by default. Collections, spaces, languages and workflows are **opt-in per sync**.

### Phase 2

Selective sync of individual entities, exclusion management per client, and restore from a pre-sync backup.

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

## How it works

```
Kontent.ai (master project, signed-in user)
  └─ Custom app (this React app, full screen, iframe)
        │  access secret + Kontent.ai user ID and email (from the custom app context)
        ▼
Vercel Functions (/api/*)
  ├─ access check: secret, then user and role via the Subscription API
  ├─ Management API keys: read from environment variables per environment
  ├─ audit log, backups, job state: Vercel Blob (private)
  └─ diff, backup, sync: @kontent-ai/data-ops
        │
        ├─ Subscription API (read-only): projects, environments, users
        ├─ Management API: master (read), client environments (read/write)
        └─ Delivery API: published content counts (impact checks)
```

All Kontent.ai API calls and all data-ops calls run in the backend. The browser never sees an API key.

data-ops identifies the source and the target by environment ID, each with its own API key. Environment IDs are unique across projects, so syncing from the master project to a client project works the same way as syncing between environments of one project.

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

## Access control

Kontent.ai shows the custom app only to signed-in users whose role is allowed in the custom app settings. That protects the user interface, but the Vercel Functions are public URLs that anyone could call directly. The custom app context (user ID, email, roles) is read in the browser and Kontent.ai does not sign it, so the backend cannot take it on trust.

Every API request is therefore checked in the backend:

1. **Access secret.** The request must carry the secret from the custom app **Parameters {JSON}** (`{"accessSecret": "..."}`). The backend compares it with `APP_ACCESS_SECRET` in constant time. A wrong secret is rejected before any Kontent.ai API is called.
2. **User.** The request carries the Kontent.ai user ID and email from the custom app context. The backend looks the user up with the Subscription API and requires that:
   - the user exists and the email matches,
   - the user is **active in the master environment**, and
   - the user has an allowed role there (`ALLOWED_ROLES`, default `project-manager`; custom roles by role ID).

User lookups are cached for 60 seconds per function instance. A failed Subscription API call is not cached.

The access secret is visible to everyone who can open the app (it is part of the custom app context). It only unlocks this app's API, never a Kontent.ai API key. Rotate it by changing `APP_ACCESS_SECRET` in Vercel and the custom app parameters, then redeploying.

## Management API keys

No Kontent.ai API returns Management API keys, so they are configured as environment variables in Vercel, one per environment:

```
KONTENT_MAPI_KEY_<environment ID with "-" replaced by "_">
```

For example, environment `3f2a9c1e-8b7d-4e2f-9a6c-1d2e3f4a5b6c` uses `KONTENT_MAPI_KEY_3f2a9c1e_8b7d_4e2f_9a6c_1d2e3f4a5b6c`.

- **Project fallback.** A Management API key belongs to a project and can cover several environments. Instead of one variable per environment you can set `KONTENT_MAPI_KEY_<project ID with "-" replaced by "_">`. The environment variable wins if both exist.
- **Case.** Variable names are matched case-insensitively.
- **No code change for a new client.** The backend reads the variables on every request. The project overview shows every environment without a key, with the exact variable name to add.
- **Redeploy after adding a key.** Vercel applies environment variable changes to new deployments only. After adding a key, redeploy the latest deployment (no code change needed).
- **Never in Parameters {JSON}.** The custom app parameters are sent to the browser. Keys must only be in Vercel environment variables.

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
- **No projects created through the API.** A new client project is created by hand in Kontent.ai. It then appears in the project overview automatically.
- **Environments can only be created by cloning** within a project (Phase 3 onboarding).
- **Restore covers the model structure, not the content.** Content in elements that a sync removed is not brought back.
- **Asset folders** cannot be moved (data-ops deletes and recreates them) and cannot be deleted while they contain assets.
- **Languages** are never deleted. data-ops deactivates them and renames them to a random 8-character name and codename.
- **External IDs** are not synced. Entities are matched by codename.
- **Rate limits:** the Management API allows 10 requests per second and 400 per minute per environment. Large models take time to sync.

## Requirements

- Node.js 22 or later (required by data-ops)
- pnpm 10
- A Vercel project with a **Vercel Blob** store connected (private access)
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

### 2. Create the Kontent.ai API keys

In each project, go to **Project settings > API keys > Management API keys > Create Management API key**. Limit each key to the environments the app needs. Set an expiry date, and note it: the maximum is 2 years.

| Key | Permissions |
|---|---|
| Master project | Manage content model, Manage environment settings, Read content, Read assets. Add Manage environments only if you sync live preview. The app only reads from the master. |
| Each client project | Manage content model, Manage environment settings, Read content, Read assets, Create, edit, and delete assets (for asset folders). Add Manage environments for live preview sync and Phase 3 onboarding. |
| Subscription API key | From **Subscriptions > your subscription > Subscription API**. This key can activate and deactivate users across all projects. The app only ever sends GET requests with it. |
| Delivery API key (optional) | Secure access, for client environments with secure access enabled. Used for published content counts. |

### 3. Generate the access secret

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

### 4. Deploy to Vercel

1. Create a Vercel project from this repository. `vercel.json` sets the build and the `Content-Security-Policy: frame-ancestors https://app.kontent.ai` header.
2. Under **Storage**, create a **Blob** store with private access and connect it to the project. This sets `BLOB_READ_WRITE_TOKEN`.
3. Under **Settings > Environment Variables**, add the [environment variables](#environment-variables), including `APP_ACCESS_SECRET` and one `KONTENT_MAPI_KEY_...` per environment (at least the master).
4. Deploy.

### 5. Register the custom app in Kontent.ai (master environment only)

1. In the master environment, go to **Environment settings > Custom apps > Create new custom app**.
2. **App name:** for example, Content Model Sync.
3. **Hosted code URL (HTTPS):** your Vercel production URL.
4. **Roles that can work with this app:** the roles that should see the app. Keep this in line with `ALLOWED_ROLES`: users with other roles see the app but are refused by the backend.
5. **Display mode:** Full screen.
6. **Parameters {JSON}:** `{"accessSecret": "<the value of APP_ACCESS_SECRET>"}`. Nothing else, and never an API key.
7. Click **Save changes**.

### 6. First run

1. Open the app from **Custom apps** in Kontent.ai. It checks your access and shows whether the master key is configured.
2. Open the project overview. For each client environment marked **Key missing**, add the variable it shows in Vercel, then redeploy.
3. Run your first diff.

## Environment variables

All variables are server-side and only read by the Vercel Functions. The frontend has no build-time variables.

| Variable | Required | Description |
|---|---|---|
| `KONTENT_SUBSCRIPTION_ID` | Yes | Kontent.ai subscription ID |
| `KONTENT_SUBSCRIPTION_API_KEY` | Yes | Subscription API key. Used for GET requests only. |
| `KONTENT_MASTER_ENVIRONMENT_ID` | Yes | Master environment ID (GUID). Never accepted as a sync target. |
| `KONTENT_MAPI_KEY_<id>` | Per environment | Management API key, see [Management API keys](#management-api-keys) |
| `APP_ACCESS_SECRET` | Yes | At least 32 characters. Same value as `accessSecret` in the custom app parameters. |
| `ALLOWED_ROLES` | No | Comma-separated role codenames or role IDs in the master environment. Default: `project-manager` |
| `CLIENT_PREFIX` | No | Reserved prefix for client extensions. Default: `client_` |
| `BLOB_READ_WRITE_TOKEN` | Yes | Set by Vercel when a Blob store is connected |

A request fails with a server error if a required variable is missing or invalid. The function log names the variable, never its value. `.env.example` lists the same variables for local development.

## Local development

```bash
pnpm dev          # frontend only, https://localhost:5173 (self-signed certificate)
vercel dev        # frontend + functions (requires the Vercel CLI and a linked project)
```

Kontent.ai only loads custom apps over HTTPS. To open your local app inside Kontent.ai, register a separate custom app in a non-production environment that points to a secure tunnel to your machine (for example ngrok).

### Scripts

| Command | Description |
|---|---|
| `pnpm build` | Type-check and build |
| `pnpm test` | Unit tests (Vitest), with Kontent.ai APIs, Vercel Blob and data-ops mocked |
| `pnpm lint` | ESLint |
| `pnpm biome:check` | Biome lint and format check |
| `pnpm check:data-ops` | Planned. Fails if the installed data-ops version differs from the validated version |

CI runs Biome, ESLint, the tests and the build.

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

- **API keys** are only in Vercel environment variables. They are never sent to the browser, never logged and never stored in Vercel Blob.
- **Every API request** is checked for the access secret and for an active master-environment user with an allowed role (see [Access control](#access-control)).
- **The Subscription API key** is only used for GET requests: the client has no way to send anything else.
- **Storage** (audit log, backups, job state) uses private Vercel Blob storage.
- **Framing** is limited to `https://app.kontent.ai`.

Remaining risks:

- **The access secret and the user ID are not proof of identity.** Anyone who can open the app can read the secret. Someone who has the secret and knows the internal user ID and email of an allowed user can call the API directly. Keep the set of people who can open the app small and rotate the secret when someone leaves.
- **Any allowed user can sync to any client environment that has a key.**
- **Anyone with access to the Vercel project's environment variables** has every Management API key. Limit Vercel team access.
- **Kontent.ai API keys expire** (maximum 2 years for Management API keys). Track expiry dates.

## Not yet verified

These points will be tested during Phase 1, and this README will be updated with the results:

- That the `userId` from the custom app context is the same ID the Subscription API uses for users (the email is cross-checked as well)
- How subscription admins without a role in the master environment appear in the Subscription API (they are currently refused)
- What the Management API does with variants in a workflow step that is removed (blocked until verified)
- Vercel Function duration limits on the plan in use, for long syncs
- Whether data-ops fits comfortably within the Vercel Function size limit

## Project structure

```
src/                  React custom app (frontend)
api/                  Vercel Functions (one file per endpoint)
server/               Service layer: access check, config, Kontent.ai clients, keys, storage, audit
patches/              Planned: pnpm patch for @kontent-ai/data-ops
scripts/              Planned: build checks (data-ops version guard)
```

Built on the [Kontent.ai custom app starter for React](https://github.com/kontent-ai/custom-app-starter-react) and the [Custom app SDK](https://github.com/kontent-ai/custom-app-sdk-js).

## Learn more

- [Kontent.ai custom apps](https://kontent.ai/learn/docs/custom-apps)
- [Management API](https://kontent.ai/learn/docs/apis/management-api-v2/introduction)
- [Subscription API](https://kontent.ai/learn/docs/apis/subscription-api/introduction)
- [data-ops](https://github.com/kontent-ai/data-ops)
- [Vercel Blob private storage](https://vercel.com/docs/vercel-blob/private-storage)

## License

MIT
