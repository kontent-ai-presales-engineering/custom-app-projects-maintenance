# Content Model Sync for Kontent.ai

A Kontent.ai custom app that keeps the content model of client projects in sync with a master project.

Unity Advisory is moving from one Kontent.ai project with a collection per client to one project per client. Content models cannot be shared between projects. This app runs inside the **master** project, lists every project in the Kontent.ai subscription, and copies content model changes **one way**: from the master to the client projects you choose. It never changes the master.

> **Status: in development.** The access check and the backend foundation are built. Project overview, diff, backup and sync are planned. See [Feature status](#feature-status).

## Contents

- [What the app does](#what-the-app-does)
- [Feature status](#feature-status)
- [Before you start](#before-you-start)
- [Setup](#setup)
- [Adding a client project](#adding-a-client-project)
- [Environment variables](#environment-variables)
- [How access is checked](#how-access-is-checked)
- [Safety rules](#safety-rules)
- [Client-only additions: the reserved prefix](#client-only-additions-the-reserved-prefix)
- [Destructive changes](#destructive-changes)
- [Limitations](#limitations)
- [Security](#security)
- [Not yet verified](#not-yet-verified)
- [Development](#development)

## What the app does

You open the app from **Custom apps** in the master environment. From there you:

1. **See all projects in your subscription**, with their environments, and whether the app has a Management API key for each environment.
2. **Pick a client environment and compare** its content model with the master: added, changed and removed content types, snippets, taxonomies and (optionally) collections, spaces, languages and workflows. Changes that can remove content are highlighted with the number of affected items.
3. **Sync** after you confirm by typing the client project's name. The app backs up the client's content model first, then applies the changes.

Every backup and sync is logged with who ran it, when, the target, and the result.

Client projects can have their own additions (content types, elements, taxonomy terms and so on) if their codename starts with a reserved prefix, `client_` by default. Sync never removes them.

How it fits together:

```
Kontent.ai (master project, signed-in user)
  └─ Custom app (this React app, full screen)
        │  access secret + Kontent.ai user ID and email
        ▼
Vercel Functions (/api/*)
  ├─ access check (secret, then user and role via the Subscription API)
  ├─ Management API keys from Vercel environment variables
  ├─ audit log and backups in Vercel Blob (private)
  └─ diff and sync with @kontent-ai/data-ops
        │
        ├─ Subscription API (read-only): projects, environments, users
        ├─ Management API: master (read), client environments (read/write)
        └─ Delivery API: published content counts
```

All Kontent.ai API calls run in the backend. The browser never sees an API key.

## Feature status

| Feature | Status |
|---|---|
| Access check: access secret, plus an active master-environment user with an allowed role | Built, not yet tested on Vercel |
| Master key check: the app shows whether the master's Management API key is configured | Built, not yet tested on Vercel |
| Project overview: all subscription projects and environments, with key status per environment | Planned (next) |
| Test connection: check that a configured key works | Planned (next) |
| Diff with content impact counts | Planned |
| Backup of the client model before every sync | Planned |
| Sync to one client environment, with typed confirmation and a re-check just before applying | Planned |
| Audit log of backups and syncs | Storage built, entries added with backup and sync |

Later phases: choosing individual entities to sync, exclusions per client, restore from a backup, a drift dashboard across all clients, rollout to several clients at once, and versioned master releases.

## Before you start

You need:

- **Kontent.ai**
  - The master project, and the client projects in the same subscription.
  - Subscription admin rights, to create a Subscription API key.
  - Project manager rights in each project, to create its Management API key.
- **Vercel**: a project for this repository, with permission to set environment variables and create a Blob store. Check that your plan allows long-running functions; a large sync can take minutes because of Kontent.ai rate limits.
- **For local development**: Node.js 22 or later and pnpm 10.

## Setup

### 1. Collect the IDs

| Value | Where to find it |
|---|---|
| Subscription ID | Kontent.ai > **Subscriptions** > your subscription > **Subscription API** |
| Master environment ID | In the master environment: **Environment settings** > **General** > Environment ID |

### 2. Create the API keys

**Subscription API key.** Kontent.ai > **Subscriptions** > your subscription > **Subscription API**. The app uses it to list projects and to check users. It only ever sends GET requests with it, but the key itself can activate and deactivate users, so store it only in Vercel.

**Management API key for the master.** In the master project: **Project settings** > **API keys** > **Management API keys** > **Create Management API key**.

- Permissions: Manage content model, Manage environment settings, Read content, Read assets. The app only reads from the master.
- Limit the key to the master environment. Set an expiry date and note it (maximum 2 years).

Client keys are covered in [Adding a client project](#adding-a-client-project).

### 3. Generate the access secret

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Keep the output: it goes into Vercel and into the custom app settings.

### 4. Deploy to Vercel

1. Create a Vercel project from this repository. `vercel.json` already sets the build and the header that only lets Kontent.ai embed the app.
2. Go to **Storage** > **Create** > **Blob**, choose **private** access, and connect the store to the project. This adds `BLOB_READ_WRITE_TOKEN` automatically.
3. Go to **Settings** > **Environment Variables** and add:

   | Variable | Value |
   |---|---|
   | `KONTENT_SUBSCRIPTION_ID` | Subscription ID from step 1 |
   | `KONTENT_SUBSCRIPTION_API_KEY` | Subscription API key from step 2 |
   | `KONTENT_MASTER_ENVIRONMENT_ID` | Master environment ID from step 1 |
   | `KONTENT_MAPI_KEY_<master environment ID>` | Master Management API key. Replace the hyphens in the ID with underscores, for example `KONTENT_MAPI_KEY_3f2a9c1e_8b7d_4e2f_9a6c_1d2e3f4a5b6c` |
   | `APP_ACCESS_SECRET` | Access secret from step 3 |
   | `ALLOWED_ROLES` | Optional. Who may use the app, see [How access is checked](#how-access-is-checked). Default: `project-manager` |

4. Deploy. Note the production URL.

### 5. Register the custom app in the master environment

1. In the master environment, go to **Environment settings** > **Custom apps** > **Create new custom app**.
2. **App name:** for example, Content Model Sync.
3. **Hosted code URL (HTTPS):** the Vercel production URL.
4. **Roles that can work with this app:** the same roles as `ALLOWED_ROLES`. Users with other roles would see the app but be refused.
5. **Display mode:** Full screen.
6. **Parameters {JSON}:**

   ```json
   {"accessSecret": "<the access secret from step 3>"}
   ```

   Nothing else goes here, and never an API key: Kontent.ai sends these parameters to the browser.
7. Click **Save changes**.

### 6. Check it works

Open **Custom apps** > **Content Model Sync** in the master environment. The app checks your access and shows:

- your name and role, and
- whether the master's Management API key is configured. If it is missing, it shows the exact variable name to add in Vercel.

If you see an error instead:

| Message | Cause |
|---|---|
| This custom app is not configured | `accessSecret` is missing from the custom app parameters |
| The access secret ... is wrong | `accessSecret` and `APP_ACCESS_SECRET` differ, or the deployment predates the variable (redeploy) |
| This user is not an active user of the master environment | Your account is not active in the master environment |
| Your role in the master environment does not allow using this app | Your role is not in `ALLOWED_ROLES` |
| User details do not match | The email from Kontent.ai differs from the Subscription API record for that user ID |
| The server returned an error | Usually a missing or invalid environment variable. The Vercel function log names it. |

## Adding a client project

1. **Create the project** in Kontent.ai, in the same subscription. The app finds it through the Subscription API; there is nothing to register.
2. **Create a Management API key** in the client project: **Project settings** > **API keys** > **Management API keys**.
   - Permissions: Manage content model, Manage environment settings, Read content, Read assets, and Create, edit, and delete assets (needed for asset folders).
   - Limit it to the environments the app should sync. Set an expiry date and note it.
3. **Add the key in Vercel** as an environment variable:
   - per environment: `KONTENT_MAPI_KEY_<environment ID with "-" replaced by "_">`, or
   - once for the whole project: `KONTENT_MAPI_KEY_<project ID with "-" replaced by "_">`. A per-environment variable wins if both exist.

   The project overview (planned) will show the exact variable name for every environment that has no key.
4. **Redeploy** the latest deployment in Vercel. Vercel only applies new environment variables to new deployments. No code change is needed.

## Environment variables

All variables are read by the backend only. The frontend has none.

| Variable | Required | Description |
|---|---|---|
| `KONTENT_SUBSCRIPTION_ID` | Yes | Kontent.ai subscription ID |
| `KONTENT_SUBSCRIPTION_API_KEY` | Yes | Subscription API key. Used for GET requests only. |
| `KONTENT_MASTER_ENVIRONMENT_ID` | Yes | Master environment ID. It can never be a sync target. |
| `KONTENT_MAPI_KEY_<id>` | Per environment or project | Management API key. `<id>` is the environment or project ID with hyphens replaced by underscores. Names are matched case-insensitively. |
| `APP_ACCESS_SECRET` | Yes | At least 32 characters. Same value as `accessSecret` in the custom app parameters. |
| `ALLOWED_ROLES` | No | Comma-separated role codenames or role IDs in the master environment. Default: `project-manager` |
| `CLIENT_PREFIX` | No | Reserved codename prefix for client-only additions. Default: `client_` |
| `BLOB_READ_WRITE_TOKEN` | Yes | Added by Vercel when you connect the Blob store |

If a required variable is missing or invalid, API calls fail and the Vercel function log names the variable (never its value). [.env.example](.env.example) lists the same variables.

## How access is checked

Kontent.ai only shows the app to signed-in users with an allowed role. That protects the screen, but the app's backend is a public URL that anyone could call directly. The user details the app gets from Kontent.ai are not signed, so the backend checks every request itself:

1. **Access secret.** The request must carry the `accessSecret` from the custom app parameters, and it must equal `APP_ACCESS_SECRET`. A wrong secret is refused before any Kontent.ai API is called.
2. **User and role.** The backend looks up the Kontent.ai user with the Subscription API. The user must exist, the email must match, the user must be **active in the master environment**, and must have a role listed in `ALLOWED_ROLES` there.

Roles in `ALLOWED_ROLES`:

- The Project manager role has the codename `project-manager` (the default).
- Custom roles have no codename. Use their role ID.

User lookups are cached for 60 seconds. To rotate the access secret, change `APP_ACCESS_SECRET` in Vercel and `accessSecret` in the custom app parameters, then redeploy.

## Safety rules

These rules are enforced in the backend, not only in the screen:

- **One way only.** The master environment, and every environment in the master project, can never be a sync target.
- **Compare first.** Nothing is written without a diff the user has confirmed.
- **Explicit confirmation.** The user types the target project name. Changes that remove content, or whose impact cannot be counted, need an additional confirmation.
- **No surprises between confirm and run.** The diff is recomputed just before applying. If anything changed since the user confirmed, the sync stops and asks again.
- **One target at a time.** A sync writes to exactly one environment, and never two syncs to the same environment at once.
- **Backup first.** The client's content model is backed up before any change.

## Client-only additions: the reserved prefix

Anything a client adds on top of the master model must have a codename starting with the reserved prefix (`client_` by default, set with `CLIENT_PREFIX`). This applies to:

- content types, snippets and taxonomy groups
- elements inside master content types and snippets (for snippet elements, the part after `<snippet>__` is checked)
- taxonomy terms and multiple choice options
- collections, spaces and asset folders

It does not apply to workflow steps.

Rules:

- **The master may never use the prefix.** A master model that contains it is refused.
- **Sync never removes prefixed items.** Removals of prefixed items are dropped from the diff, and the sync is blocked if one remains.
- **Content groups:** a sync that would remove a content group that still has elements is blocked. Move or remove those elements in the master first.

## Destructive changes

| Change in the master | What happens |
|---|---|
| Element removed that holds content in the client | Shows the number of affected items. Needs confirmation. |
| Content type removed while items use it | Blocked |
| Element type changed | Blocked |
| Snippet or taxonomy group removed | Needs confirmation |
| Taxonomy term or multiple choice option removed | Shows the number of affected items. Needs confirmation. |
| Language deactivated, or default language codename changed | Shows items per language. Needs confirmation. |
| Workflow step removed while items are in it | Blocked until the behaviour has been tested. Allowed when the step is empty. |
| Workflows synced | Warning: role limits on workflows are lost |

Counts include both the latest and the published version of each item. If a count cannot be determined, the app shows **impact unknown** and requires confirmation; it never shows 0 for an unknown count.

## Limitations

- **Not synced:** roles, webhooks, preview URLs, custom apps and custom element settings. These stay as each client configured them.
- **Projects are created by hand** in Kontent.ai. No Kontent.ai API creates projects.
- **Restoring a backup restores the model, not the content.** Content in elements removed by a sync does not come back.
- **Asset folders** cannot be moved (they are deleted and recreated), and cannot be deleted while they contain assets.
- **Languages** are never deleted, only deactivated and renamed.
- **Matching is by codename.** External IDs are not synced.
- **Rate limits:** the Management API allows 10 requests per second and 400 per minute per environment, so large models take time to sync.

## Security

- **API keys** are only in Vercel environment variables. They are never sent to the browser, logged, or written to Vercel Blob.
- **Every API call** is checked for the access secret and an allowed master-environment user.
- **The Subscription API key** is only used for GET requests.
- **Stored data** (audit log, backups) is in private Vercel Blob storage.
- **Embedding** is limited to `https://app.kontent.ai`.

Remaining risks:

- **The access secret and the user details are not proof of identity.** Anyone who can open the app can read the secret. Someone with the secret and the internal user ID and email of an allowed user could call the backend directly. Keep the allowed roles narrow and rotate the secret when someone leaves.
- **Any allowed user can sync to any client environment that has a key.**
- **Anyone with access to the Vercel project's environment variables has every Management API key.** Limit Vercel team access.
- **Management API keys expire** (maximum 2 years). Track the expiry dates.

## Not yet verified

These will be tested on a real deployment, and this README updated:

- That the user ID from the custom app context is the ID the Subscription API uses. The email is cross-checked as well. If they differ, every user is refused until the lookup switches to email.
- Subscription admins without a role in the master environment are refused. It is not yet confirmed how they appear in the Subscription API.
- What the Management API does with items in a removed workflow step (blocked until tested).
- Vercel function time limits on the plan in use, for long syncs.

## Development

```bash
pnpm install
pnpm dev          # frontend only, https://localhost:5173 (self-signed certificate)
vercel dev        # frontend and API (requires the Vercel CLI and a linked project)
```

Kontent.ai only loads custom apps over HTTPS. To try a local version inside Kontent.ai, register a second custom app in a non-production environment that points to a secure tunnel (for example ngrok).

| Command | Description |
|---|---|
| `pnpm build` | Type-check and build |
| `pnpm test` | Unit tests (Vitest), with Kontent.ai APIs and Vercel Blob mocked |
| `pnpm lint` | ESLint |
| `pnpm biome:check` | Biome lint and format check |

CI runs Biome, ESLint, the tests and the build.

Project layout:

```
src/        React custom app
api/        Vercel Functions, one file per endpoint
server/     Backend logic: access check, config, Kontent.ai clients, keys, storage, audit log
```

The diff and sync will use [`@kontent-ai/data-ops`](https://github.com/kontent-ai/data-ops), which already syncs content models between environments by ID and key. Environment IDs are unique across projects, so syncing from the master project to a client project works the same way.

Built on the [Kontent.ai custom app starter for React](https://github.com/kontent-ai/custom-app-starter-react) and the [Custom app SDK](https://github.com/kontent-ai/custom-app-sdk-js).

## Learn more

- [Kontent.ai custom apps](https://kontent.ai/learn/docs/custom-apps)
- [Management API](https://kontent.ai/learn/docs/apis/management-api-v2/introduction)
- [Subscription API](https://kontent.ai/learn/docs/apis/subscription-api/introduction)
- [Vercel Blob private storage](https://vercel.com/docs/vercel-blob/private-storage)

## License

MIT
