# Content Model Sync for Kontent.ai

A Kontent.ai custom app that keeps the content model of client projects in sync with a master project.

Unity Advisory is moving from one Kontent.ai project with a collection per client to one project per client. Content models cannot be shared between projects. This app runs inside the **master** project, lists every project in the Kontent.ai subscription, and copies content model changes **one way**: from the master to the client projects you choose. It never changes the master.

> **Status: in development.** The access check, the project overview, Test connection, the diff with impact counts, backups and sync are built. Phase 1 is complete in code, but has not been tested on a real deployment yet. See [Feature status](#feature-status).

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
- [Comparing a client with the master](#comparing-a-client-with-the-master)
- [Backups](#backups)
- [Syncing a client](#syncing-a-client)
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
| Project overview: all subscription projects and environments, with key status per environment and the variable to add for a missing key | Built, not yet tested on Vercel |
| Test connection: read-only check that a key is accepted for its environment and can read the content model | Built, not yet tested on Vercel |
| Diff: compare the master with one client environment, with blocks, destructive changes, impact counts and the full data-ops report | Built, not yet tested on Vercel |
| Backup of a client's content model: on demand now, and automatically before every sync once sync is built. Download as JSON. | Built, not yet tested on Vercel |
| Sync to one client environment: typed confirmation, extra confirmation for destructive changes, re-check of the diff just before applying, automatic backup, data-ops validation, one sync per environment at a time | Built, not yet tested on Vercel |
| Audit log of backups and syncs | Built (stored in Vercel Blob; there is no screen for it yet) |

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

- your name and role in the header, and
- every project in the subscription, master project first, with each environment's key status. For a missing key it shows the exact variable name to add in Vercel.

Click **Test connection** on the master environment to check its key. A successful test shows the project and environment names. Otherwise it says whether the key was rejected (expired, revoked or limited to other environments) or cannot read the content model (missing the Manage content model permission).

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

   The project overview shows the exact variable name for every environment that has no key.
4. **Optional: Delivery API key.** If secure access is enabled for a client environment, add a Delivery API key as `KONTENT_DELIVERY_KEY_<environment ID with "-" replaced by "_">`. Without it, published counts for that environment show as impact unknown.
5. **Redeploy** the latest deployment in Vercel. Vercel only applies new environment variables to new deployments. No code change is needed.
6. **Check the key**: in the app, click **Refresh** (the project list is cached for up to a minute), then **Test connection** on the new environment.

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
| `KONTENT_DELIVERY_KEY_<id>` | No | Delivery API key for an environment with secure access, used for published counts. `<id>` is the environment ID with hyphens replaced by underscores. |
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

## Comparing a client with the master

In the project overview, click **Compare with master** on a client environment. Choose the entities to compare (content types, snippets and taxonomies by default; collections, spaces, languages and workflows are opt-in) and click **Compare**. Comparing is read-only.

The result shows:

- **Blocked:** problems that must be fixed before this client can be synced, with the reason.
- **Destructive changes:** changes that remove content in the client, with the number of affected language variants.
- **Warnings**, **All changes** (with the individual operations), and the **client items kept** because they use the reserved prefix.
- **Show full data-ops report:** the detailed data-ops HTML report of the same (filtered) diff.

## Backups

The compare screen has a **Backups** section for the client environment:

- **Back up now** makes a snapshot of the client's content model: content types, snippets, taxonomies, collections, spaces, languages, workflows and asset folders. It does not include content items or assets.
- Every backup is listed with when it was made, by whom, why (manual, or before a sync) and how many entries each part has.
- **Download** saves a backup as a JSON file. It contains the files of a data-ops sync snapshot, the format data-ops can sync back from, which restore (Phase 2) will use.

Backups are stored in private Vercel Blob storage and kept until you delete them from the Blob store. Every backup is recorded in the audit log, including failed attempts. Backups are only made of client environments; the master is never changed by this app.

## Syncing a client

After comparing, a **Sync** section appears below the result when there is something to sync and nothing is blocked.

1. If the diff has destructive changes, tick the box confirming that content will be removed (it also says how many have unknown impact).
2. Type the client project name exactly.
3. Click **Sync to <project>**. Keep the page open; a sync can take several minutes.

What happens:

1. **Re-check.** The diff is recomputed and its fingerprint compared with the one you confirmed. If the master or the client changed in the meantime, the sync stops and asks you to compare again.
2. **Lock.** Only one sync per client environment runs at a time. A lock older than 15 minutes is treated as abandoned.
3. **Backup.** The client's content model is backed up (reason: before sync). No backup, no sync.
4. **Validation.** data-ops checks that removed content types and collections are not in use and that no element changes type. If it refuses, nothing is changed and the problems are listed.
5. **Apply.** data-ops applies exactly the confirmed changes, for the chosen entities only, to this one environment.
6. **Audit.** The result is recorded: who, when, target, backup, number of changes, entities, outcome.

If a sync fails partway, some changes may already be applied: data-ops applies changes one by one and cannot roll back. The message names the backup made just before. Compare again to see what is left.

## Destructive changes

| Change in the master | What happens |
|---|---|
| Element removed that holds content in the client | Counted. Needs confirmation. |
| Multiple choice option removed | Counted. Needs confirmation. |
| Taxonomy term removed (with its child terms) | Counted across all types and snippets that use the group. Needs confirmation. |
| Taxonomy group removed | Counted. Needs confirmation. |
| Content type removed | Counted. data-ops refuses the sync while items use the type. |
| Snippet removed, or removed from a type | Impact unknown. Needs confirmation. |
| Collection, space or language removed, or a language codename changed | Impact unknown. Needs confirmation. |
| Element type changed | Refused by data-ops validation at sync time |
| Workflow or workflow step removed | Blocked until the behaviour has been tested on a sandbox |
| Workflows synced | Warning: role limits on workflows are lost |

Counts are made for the **latest** version (Management API) and the **published** version (Delivery API, per active language). A count is **impact unknown**, never 0, when it cannot be determined, for example when the type is also used as a component in rich text, or when the Delivery API refuses because secure access is enabled and no Delivery API key is set.

## Limitations

- **Not synced:** roles, webhooks, preview URLs, custom apps and custom element settings. These stay as each client configured them.
- **Projects are created by hand** in Kontent.ai. No Kontent.ai API creates projects.
- **A failed sync can leave the client partly updated.** data-ops is not transactional. Restoring from the pre-sync backup is planned for Phase 2.
- **No live progress during a sync.** data-ops has no progress callback; the screen shows that the sync is running until it finishes.
- **Restoring a backup restores the model, not the content.** Content in elements removed by a sync does not come back.
- **Backups do not include live preview settings**, because reading them needs the Manage environments permission.
- **Backups are not deleted automatically.** Remove old ones from the Vercel Blob store if needed.
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
- Vercel function time limits on the plan in use. The diff function is set to 300 seconds; long syncs may need more.
- That listing content types requires the Manage content model permission (Test connection relies on it).
- That the Delivery API items feed honours the `elements` projection and the `system.language` filter as used for published counts.
- That data-ops can write its snapshot to the function's temporary folder on Vercel, and that the client key's permissions are enough to read workflows and asset folders for a backup.
- A full sync against a sandbox client: the data-ops apply path is tested with mocks and contract tests only.
- That a sync fits within the 300-second function limit for your largest client models.
- The diff and impact counts against real projects. They are tested with mocked APIs and the real data-ops report renderer only.

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
| `pnpm check:data-ops` | Fails if data-ops is not exactly the validated version or the patch is not applied |

CI runs Biome, ESLint, the data-ops check, the tests and the build.

Project layout:

```
src/        React custom app
api/        Vercel Functions, one file per endpoint
server/     Backend logic: access check, config, Kontent.ai clients, keys, diff, storage, audit log
patches/    pnpm patch for @kontent-ai/data-ops
scripts/    data-ops version check
```

### data-ops

The diff (and later the sync) uses [`@kontent-ai/data-ops`](https://github.com/kontent-ai/data-ops), which compares and syncs content models between environments by ID and key. Environment IDs are unique across projects, so master-to-client works the same way.

The app needs the structured diff, not only the HTML report, to keep client items and count impact. data-ops has this internally but does not export it, so:

- data-ops is pinned to exactly **2.8.1**.
- `patches/@kontent-ai__data-ops@2.8.1.patch` adds `exports` entries for the internal diff, sync, validation, report and client modules. It changes no code.
- `server/sync/dataOps.ts` is the only file that imports data-ops.
- The diff is restricted to the chosen entities before it is shown, hashed and applied (data-ops' own sync does the same), so the diff you confirm is exactly what sync applies. A test checks this for every combination of entities.
- Contract tests (`server/sync/dataOps.contract.test.ts`) check the entry points and the report renderer, and `pnpm check:data-ops` fails the build if the version changes.

To upgrade data-ops: update the exact version, regenerate the patch with `pnpm patch`, run the tests, compare against a sandbox client, then update `VALIDATED_VERSION` in `scripts/check-data-ops.mjs`.

Built on the [Kontent.ai custom app starter for React](https://github.com/kontent-ai/custom-app-starter-react) and the [Custom app SDK](https://github.com/kontent-ai/custom-app-sdk-js).

## Learn more

- [Kontent.ai custom apps](https://kontent.ai/learn/docs/custom-apps)
- [Management API](https://kontent.ai/learn/docs/apis/management-api-v2/introduction)
- [Subscription API](https://kontent.ai/learn/docs/apis/subscription-api/introduction)
- [Vercel Blob private storage](https://vercel.com/docs/vercel-blob/private-storage)

## License

MIT
