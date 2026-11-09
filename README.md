# Content Model Sync for Kontent.ai

A Kontent.ai custom app that keeps the content model of the projects in your subscription in sync with one master project.

Kontent.ai cannot share a content model between projects. When you run several projects on the same model (one per brand, market, site, team or customer), keeping them aligned by hand is slow and error-prone. This app runs inside the **master** project, lists every project in your Kontent.ai subscription, and copies content model changes **one way**: from the master to the **sub-projects** you choose. It never changes the master.

In this README, a **sub-project** is any other project in the same subscription that should follow the master's content model.

> **Status: in development.** All features below are built, but none of it has been tested on a real deployment yet. See [Feature status](#feature-status) and [Not yet verified](#not-yet-verified).

## Contents

- [What the app does](#what-the-app-does)
- [Feature status](#feature-status)
- [Before you start](#before-you-start)
- [Setup on Vercel](#setup-on-vercel)
- [Adding a sub-project](#adding-a-sub-project)
- [Environment variables](#environment-variables)
- [How access is checked](#how-access-is-checked)
- [Safety rules](#safety-rules)
- [Project-specific additions: the reserved prefix](#project-specific-additions-the-reserved-prefix)
- [Project overview](#project-overview)
- [Comparing a sub-project with the master](#comparing-a-sub-project-with-the-master)
- [Backups](#backups)
- [Syncing a sub-project](#syncing-a-sub-project)
- [Restoring from a backup](#restoring-from-a-backup)
- [Drift dashboard](#drift-dashboard)
- [Onboarding a new sub-project](#onboarding-a-new-sub-project)
- [Master releases](#master-releases)
- [Batch rollout](#batch-rollout)
- [Audit log](#audit-log)
- [Destructive changes](#destructive-changes)
- [Limitations](#limitations)
- [Security](#security)
- [Hosting without Vercel](#hosting-without-vercel)
- [Not yet verified](#not-yet-verified)
- [Development](#development)

## What the app does

You open the app from **Custom apps** in the master environment. From there you:

1. **See all projects in your subscription**, with their environments, users, content counts, and whether the app has a Management API key for each environment.
2. **Compare a sub-project environment with the master**: added, changed and removed content types, snippets, taxonomies and (optionally) collections, spaces, languages and workflows. Changes that can remove content are highlighted with the number of affected items.
3. **Sync** after you confirm by typing the sub-project's name. The app backs up the sub-project's content model first, then applies the changes.

On top of that: restore from backups, sync only selected items, exclude items per sub-project, freeze the master as versioned releases, check drift across all sub-projects, roll out to many environments in stages, and onboard new projects. Every backup, sync, restore and configuration change is logged.

Sub-projects can have their own additions (content types, elements, taxonomy terms and so on) if their codename starts with a reserved prefix, `client_` by default. Sync never removes them.

How it fits together (default hosting on Vercel; see [Hosting without Vercel](#hosting-without-vercel)):

```
Kontent.ai (master project, signed-in user)
  └─ Custom app (this React app, full screen)
        │  access secret + Kontent.ai user ID and email
        ▼
Backend functions (/api/*)
  ├─ access check (secret, then user and role via the Subscription API)
  ├─ Management API keys from environment variables
  ├─ audit log, backups, releases and stored results in private storage
  └─ diff and sync with @kontent-ai/data-ops
        │
        ├─ Subscription API (read-only): projects, environments, users
        ├─ Management API: master (read), sub-project environments (read/write)
        └─ Delivery API: published content counts
```

All Kontent.ai API calls run in the backend. The browser never sees an API key.

## Feature status

| Feature | Status |
|---|---|
| Access check: access secret, plus an active master-environment user with an allowed role | Built, not yet tested on a deployment |
| Project overview: all projects and environments, key status, users per project, content item and content type counts per environment | Built, not yet tested on a deployment |
| Test connection: read-only check that a key is accepted for its environment and can read the content model | Built, not yet tested on a deployment |
| Diff with impact counts, blocks and the full data-ops report | Built, not yet tested on a deployment |
| Backups of a sub-project's content model, with download | Built, not yet tested on a deployment |
| Sync to one environment, with typed confirmation, re-check of the diff, automatic backup and validation | Built, not yet tested on a deployment |
| Restore from a backup | Built, not yet tested on a deployment |
| Selective sync of individual items, with automatic dependencies | Built, not yet tested on a deployment |
| Exclusions per sub-project | Built, not yet tested on a deployment |
| Audit log screen | Built, not yet tested on a deployment |
| Drift dashboard across all sub-projects | Built, not yet tested on a deployment |
| Batch rollout: non-production first, then production | Built, not yet tested on a deployment |
| Master releases: frozen, versioned copies of the master model with changelog notes | Built, not yet tested on a deployment |
| Onboarding of a new sub-project, including cloning environments | Built, not yet tested on a deployment |

## Before you start

You need:

- **Kontent.ai**
  - The master project, and the sub-projects in the same subscription.
  - Subscription admin rights, to create a Subscription API key.
  - Project manager rights in each project, to create its Management API key.
- **Hosting.** The default is **Vercel**: a project for this repository, with permission to set environment variables and create a Blob store. Check that your plan allows functions to run for several minutes; a large sync can take minutes because of Kontent.ai rate limits. For other hosts, see [Hosting without Vercel](#hosting-without-vercel).
- **For local development**: Node.js 22 or later and pnpm 10.

## Setup on Vercel

### 1. Collect the IDs

| Value | Where to find it |
|---|---|
| Subscription ID | Kontent.ai > **Subscriptions** > your subscription > **Subscription API** |
| Master environment ID | In the master environment: **Environment settings** > **General** > Environment ID |

### 2. Create the API keys

**Subscription API key.** Kontent.ai > **Subscriptions** > your subscription > **Subscription API**. The app uses it to list projects and users and to check who is calling. It only ever sends GET requests with it, but the key itself can activate and deactivate users, so store it only on the server.

**Management API key for the master.** In the master project: **Project settings** > **API keys** > **Management API keys** > **Create Management API key**.

- Permissions: Manage content model, Manage environment settings, Read content, Read assets. The app only reads from the master.
- Limit the key to the master environment. Set an expiry date and note it (maximum 2 years).

Sub-project keys are covered in [Adding a sub-project](#adding-a-sub-project).

### 3. Generate the access secret

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Keep the output: it goes into the server's environment variables and into the custom app settings.

### 4. Deploy to Vercel

1. Create a Vercel project from this repository. `vercel.json` already sets the build, the function time limits, and the header that only lets Kontent.ai embed the app.
2. Go to **Storage** > **Create** > **Blob**, choose **private** access, and connect the store to the project for every environment you use (Production, and Preview if you test on preview URLs). This adds `BLOB_READ_WRITE_TOKEN` automatically.
3. Go to **Settings** > **Environment Variables** and add:

   | Variable | Value |
   |---|---|
   | `KONTENT_SUBSCRIPTION_ID` | Subscription ID from step 1 |
   | `KONTENT_SUBSCRIPTION_API_KEY` | Subscription API key from step 2 |
   | `KONTENT_MASTER_ENVIRONMENT_ID` | Master environment ID from step 1 |
   | `KONTENT_MAPI_KEY_<master environment ID>` | Master Management API key. Replace the hyphens in the ID with underscores, for example `KONTENT_MAPI_KEY_3f2a9c1e_8b7d_4e2f_9a6c_1d2e3f4a5b6c` |
   | `APP_ACCESS_SECRET` | Access secret from step 3 |
   | `ALLOWED_ROLES` | Optional. Who may use the app, see [How access is checked](#how-access-is-checked). Default: `project-manager` |

4. Deploy. Note the production URL. Vercel only gives environment variables and storage to new deployments, so redeploy whenever you change them.

### 5. Register the custom app in the master environment

1. In the master environment, go to **Environment settings** > **Custom apps** > **Create new custom app**.
2. **App name:** for example, Content Model Sync.
3. **Hosted code URL (HTTPS):** the production URL.
4. **Roles that can work with this app:** the same roles as `ALLOWED_ROLES`. Users with other roles would see the app but be refused.
5. **Display mode:** Full screen.
6. **Parameters {JSON}:**

   ```json
   {"accessSecret": "<the access secret from step 3>"}
   ```

   Nothing else goes here, and never an API key: Kontent.ai sends these parameters to the browser.
7. Click **Save changes**.

### 6. Check it works

Open **Custom apps** > **Content Model Sync** in the master environment. The app checks your access and shows your name and role in the header, and every project in the subscription, master project first, with each environment's key status. For a missing key it shows the exact variable name to add.

Click **Test connection** on the master environment to check its key. A successful test shows the project and environment names. Otherwise it says whether the key was rejected (expired, revoked or limited to other environments) or cannot read the content model (missing the Manage content model permission).

If you see an error instead:

| Message | Cause |
|---|---|
| This custom app is not configured | `accessSecret` is missing from the custom app parameters |
| The access secret ... is wrong | `accessSecret` and `APP_ACCESS_SECRET` differ, or the deployment predates the variable (redeploy) |
| This user is not an active user of the master environment | Your account is not active in the master environment |
| Your role in the master environment does not allow using this app | Your role is not in `ALLOWED_ROLES` |
| User details do not match | The email from Kontent.ai differs from the Subscription API record for that user ID |
| The server returned an error | Usually a missing or invalid environment variable, or storage that is not connected. The function log names the cause. |

## Adding a sub-project

1. **Create the project** in Kontent.ai, in the same subscription. The app finds it through the Subscription API; there is nothing to register.
2. **Create a Management API key** in the sub-project: **Project settings** > **API keys** > **Management API keys**.
   - Permissions: Manage content model, Manage environment settings, Read content, Read assets, and Create, edit, and delete assets (needed for asset folders). Add Manage environments if you want to clone environments from the app during onboarding.
   - Limit it to the environments the app should sync. Set an expiry date and note it.
3. **Add the key** as an environment variable on the server:
   - per environment: `KONTENT_MAPI_KEY_<environment ID with "-" replaced by "_">`, or
   - once for the whole project: `KONTENT_MAPI_KEY_<project ID with "-" replaced by "_">`. A per-environment variable wins if both exist.

   The project overview shows the exact variable name for every environment that has no key.
4. **Optional: Delivery API key.** If secure access is enabled for an environment, add a Delivery API key as `KONTENT_DELIVERY_KEY_<environment ID with "-" replaced by "_">`. Without it, published counts for that environment show as impact unknown.
5. **Redeploy or restart** so the server picks up the new variable. No code change is needed.
6. **Check the key**: in the app, click **Refresh** (the project list is cached for up to a minute), then **Test connection** on the new environment.

The [onboarding checklist](#onboarding-a-new-sub-project) walks through the same steps in the app.

## Environment variables

All variables are read by the backend only. The frontend has none.

| Variable | Required | Description |
|---|---|---|
| `KONTENT_SUBSCRIPTION_ID` | Yes | Kontent.ai subscription ID |
| `KONTENT_SUBSCRIPTION_API_KEY` | Yes | Subscription API key. Used for GET requests only. |
| `KONTENT_MASTER_ENVIRONMENT_ID` | Yes | Master environment ID. Environments of the master project can never be a sync target. |
| `KONTENT_MAPI_KEY_<id>` | Per environment or project | Management API key. `<id>` is the environment or project ID with hyphens replaced by underscores. Names are matched case-insensitively. |
| `APP_ACCESS_SECRET` | Yes | At least 32 characters. Same value as `accessSecret` in the custom app parameters. |
| `ALLOWED_ROLES` | No | Comma-separated role codenames or role IDs in the master environment. Default: `project-manager` |
| `CLIENT_PREFIX` | No | Reserved codename prefix for project-specific additions. Default: `client_` (for example, set `local_` instead) |
| `KONTENT_DELIVERY_KEY_<id>` | No | Delivery API key for an environment with secure access, used for published counts. `<id>` is the environment ID with hyphens replaced by underscores. |
| `BLOB_READ_WRITE_TOKEN` | Yes, on Vercel | Added by Vercel when you connect the Blob store. Other hosts use their own storage settings. |

If a required variable is missing or invalid, API calls fail and the function log names the variable (never its value). [.env.example](.env.example) lists the same variables.

## How access is checked

Kontent.ai only shows the app to signed-in users with an allowed role. That protects the screen, but the app's backend is a public URL that anyone could call directly. The user details the app gets from Kontent.ai are not signed, so the backend checks every request itself:

1. **Access secret.** The request must carry the `accessSecret` from the custom app parameters, and it must equal `APP_ACCESS_SECRET`. A wrong secret is refused before any Kontent.ai API is called.
2. **User and role.** The backend looks up the Kontent.ai user with the Subscription API. The user must exist, the email must match, the user must be **active in the master environment**, and must have a role listed in `ALLOWED_ROLES` there.

Roles in `ALLOWED_ROLES`:

- The Project manager role has the codename `project-manager` (the default).
- Custom roles have no codename. Use their role ID.

User lookups are cached for 60 seconds. To rotate the access secret, change `APP_ACCESS_SECRET` on the server and `accessSecret` in the custom app parameters, then redeploy.

## Safety rules

These rules are enforced in the backend, not only in the screen:

- **One way only.** The master environment, and every environment in the master project, can never be a sync target.
- **Compare first.** Nothing is written without a diff the user has confirmed.
- **Explicit confirmation.** The user types the target project name. Changes that remove content, or whose impact cannot be counted, need an additional confirmation.
- **No surprises between confirm and run.** The diff is recomputed just before applying. If anything changed since the user confirmed, the sync stops and asks again.
- **One target at a time.** A sync writes to exactly one environment, and never two syncs to the same environment at once.
- **Backup first.** The sub-project's content model is backed up before any change.

## Project-specific additions: the reserved prefix

Anything a sub-project adds on top of the master model must have a codename starting with the reserved prefix (`client_` by default, set with `CLIENT_PREFIX`). This applies to:

- content types, snippets and taxonomy groups
- elements inside master content types and snippets (for snippet elements, the part after `<snippet>__` is checked)
- taxonomy terms and multiple choice options
- collections, spaces and asset folders

It does not apply to workflow steps.

Rules:

- **The master may never use the prefix.** A master model that contains it is refused.
- **Sync never removes prefixed items.** Removals of prefixed items are dropped from the diff, and the sync is blocked if one remains.
- **Content groups:** a sync that would remove a content group that still has elements is blocked. Move or remove those elements in the master first.

## Project overview

The overview lists every project in the subscription, master project first, with each environment's key status and **Test connection**. It also shows metrics:

- **Users** next to the project name: users assigned to the project in any environment, and how many of them are active. These come from the Subscription API, refreshed at most every 5 minutes.
- **Content** per environment: the number of content items and content types, with when they were counted. The Management API has no total for content items, so counting reads every page of items. That takes time and API calls for large projects, so counts are stored and only recounted when you click **Refresh** for an environment or **Refresh all metrics** (two environments at a time). A count that could not be read is shown as **?**, never 0.

## Comparing a sub-project with the master

In the project overview, click **Compare with master** on a sub-project environment. Choose the entities to compare (content types, snippets and taxonomies by default; collections, spaces, languages and workflows are opt-in), optionally a [release](#master-releases) instead of the live master, and click **Compare**. Comparing is read-only.

The result shows:

- **Blocked:** problems that must be fixed before this environment can be synced, with the reason.
- **Destructive changes:** changes that remove content in the sub-project, with the number of affected language variants.
- **Warnings**, **All changes** (with the individual operations), and the **project-specific items kept** because they use the reserved prefix.
- **Show full data-ops report:** the detailed data-ops HTML report of the same (filtered) diff.

### Syncing only some items

After a comparison, click **Choose items...**, tick the items to sync in **All changes**, and click **Compare selected items**. The app compares again, limited to those items, and you confirm and sync that smaller diff as usual. Restore works the same way.

Items that the chosen ones need are added automatically and listed under **Selected items only**, with the reason:

- something new that a chosen item uses, for example a new snippet or taxonomy group used by a chosen content type;
- for a chosen deletion, the updates that stop using the deleted item, because data-ops deletes only after it has applied updates.

The selection is part of the diff fingerprint, so a sync applies exactly the selected diff. **Compare all items again** goes back to the full diff.

### Exclusions per sub-project

A sub-project can adapt a master item and keep its own version, for example a content type with a different set of elements. Exclude it, and syncs from the master never change it again.

- Click **Exclude** next to a change in **All changes**. The exclusion is saved for the sub-project, so it applies to all of its environments.
- The **Exclusions for <project>** panel lists them; **Remove** takes one off.
- Changes to excluded items are listed under **Excluded for this sub-project, kept as is** and are not synced.
- If a synced item needs an excluded one (for example a new content type that uses an excluded new snippet), the sync is blocked with the reason. Remove the exclusion, or sync without that item.
- Changing exclusions invalidates the diff on screen: compare again before syncing. A sync with the old diff is refused.
- Restores ignore exclusions: they put back exactly what the backup holds.
- Every change to exclusions is recorded in the audit log.

Use the reserved prefix for things only the sub-project has. Use exclusions for master items the sub-project has changed.

## Backups

The compare screen has a **Backups** section for the sub-project environment:

- **Back up now** makes a snapshot of the environment's content model: content types, snippets, taxonomies, collections, spaces, languages, workflows and asset folders. It does not include content items or assets.
- Every backup is listed with when it was made, by whom, why (manual, before a sync, or before a restore) and how many entries each part has.
- **Download** saves a backup as a JSON file. It contains the files of a data-ops sync snapshot.
- **Restore...** starts a restore from that backup. See [Restoring from a backup](#restoring-from-a-backup).

Backups are kept in private storage until you delete them there. Every backup is recorded in the audit log, including failed attempts. Backups are only made of sub-project environments; the master is never changed by this app.

## Syncing a sub-project

After comparing, a **Sync** section appears below the result when there is something to sync and nothing is blocked.

1. If the diff has destructive changes, tick the box confirming that content will be removed (it also says how many have unknown impact).
2. Type the project name exactly.
3. Click **Sync to <project>**. Keep the page open; a sync can take several minutes.

What happens:

1. **Re-check.** The diff is recomputed and its fingerprint compared with the one you confirmed. If the master or the sub-project changed in the meantime, the sync stops and asks you to compare again.
2. **Lock.** Only one sync per environment runs at a time. A lock older than 15 minutes is treated as abandoned.
3. **Backup.** The environment's content model is backed up (reason: before sync). No backup, no sync.
4. **Validation.** data-ops checks that removed content types and collections are not in use and that no element changes type. If it refuses, nothing is changed and the problems are listed.
5. **Apply.** data-ops applies exactly the confirmed changes, for the chosen entities only, to this one environment.
6. **Audit.** The result is recorded: who, when, target, backup, number of changes, entities, release (if any), outcome.

If a sync fails partway, some changes may already be applied: data-ops applies changes one by one and cannot roll back. The message names the backup made just before. Compare again to see what is left.

## Restoring from a backup

Restore brings an environment's content model back to the state of one of its backups, for example after a sync that went wrong.

1. In the **Backups** section, click **Restore...** on a backup. The compare screen switches to restore mode.
2. Choose the entities and click **Compare with backup**. The result shows what restoring would change, with the same blocks, destructive changes and impact counts as a sync.
3. Confirm and click **Restore <project>**.

A restore uses the same safeguards as a sync: the diff is recomputed and must match, the project name must be typed, destructive changes need confirmation, the current model is backed up first (reason: before restore), data-ops validates, and the restore is recorded in the audit log.

- A backup can only be restored to the environment it was taken from.
- Project-specific items with the reserved prefix that were added after the backup are kept.
- The "master uses the prefix" rule does not apply, because a backup legitimately contains project-specific items.
- Restore covers the content model only. Content in elements that were removed is not brought back.

## Drift dashboard

Click **Drift** in the header for an overview of every sub-project environment (all projects except the master):

- **Synced from:** the live master or the release the environment was last synced from.
- **Status:** In sync, Drift (with the number of changes, destructive changes and excluded items), Blocked, Check failed, Not checked, or No key.
- **Check** compares one environment with the master now; **Check all** checks every environment with a key, two at a time.
- **Compare** opens the full comparison for that environment, where you can sync.
- Tick environments and click **Plan rollout** to start a [batch rollout](#batch-rollout).

A check covers content types, snippets and taxonomies, compares with the live master, respects exclusions and project-specific items, and is read-only. The latest result per environment is stored, with when and by whom it was checked, so everyone sees the same overview. Checks are not recorded in the audit log because they change nothing.

## Onboarding a new sub-project

Kontent.ai has no API to create projects, so create the project in Kontent.ai first. It then appears in the project overview. Click **Onboarding** next to it for a checklist:

1. **Add a Management API key.** The screen shows the project-level variable name. A project-level key covers every environment of the project, including ones cloned later, if the key itself is not limited to specific environments. Redeploy or restart after adding it.
2. **Test the connection** of each environment.
3. **Initial sync.** Opens the comparison with every entity selected (content types, snippets, taxonomies, collections, spaces, languages and workflows), against the live master or a release. Review it and sync as usual.
4. **Optional: create another environment** by cloning one of the project's environments, for example a development environment after the initial sync. By default only the content model and settings are copied; tick the box to copy content items and assets too. The screen follows the cloning progress. The key needs the **Manage environments** permission. Cloning is recorded in the audit log. Environments of the master project are never cloned by this app.

## Master releases

A release is a frozen copy of the master's content model with a version and changelog notes. Rolling out a release instead of the live master means edits that are still in progress in the master do not reach sub-projects.

- Click **Releases** in the header, enter a version (the next `vN` is suggested) and notes, and click **Create release**. The app snapshots the master's content model, in the same format as backups.
- On the compare screen, choose **Compare with: Release vN** instead of **Live master**. On the rollout screen, choose **From: Release vN**.
- A release is treated like the master: exclusions, the reserved prefix rules, the fingerprint check, backups and the audit log all apply.
- After a sync, the app records what the environment was synced from. The **Drift** tab shows it in **Synced from**, and the release list shows how many environments are on each release. A restore does not change this record.
- Creating a release is recorded in the audit log. Versions must be unique.

The drift check always compares with the live master, so an environment on an older release shows the changes made since.

## Batch rollout

To sync several environments in one go:

1. On the **Drift** tab, tick the environments and click **Plan rollout**.
2. The app plans each environment: the changes a sync would apply (with its fingerprint), whether there are destructive changes, and its stage. Environments that the Management API reports as production go in the production stage. If that cannot be determined, the environment is treated as production. Blocked and in-sync environments are skipped.
3. Confirm by typing **ROLLOUT <number of environments>**, and tick the box if any environment has destructive changes.
4. **Stage 1** syncs the non-production environments one at a time.
5. When stage 1 has fully succeeded, check the results and click **Continue to production** for **stage 2**.

Each environment is synced exactly like a single sync: the diff must still match the plan, a backup is made first, data-ops validates, and the sync is recorded in the audit log. The rollout stops at the first failure; later environments are not synced. The rollout runs from the browser, so keep the page open: closing it stops the rollout before the next environment (never in the middle of one).

The typed batch confirmation replaces typing each project name. The plan screen does not show impact counts; use **Compare** first when there are destructive changes.

## Audit log

Click **Audit log** in the header to see every backup, sync, restore, exclusion change, release and environment clone, most recent first: when, who, the action, the target project and environment, the outcome and details (backup ID, number of changes, entities, and the failing step for errors). **Load more** shows older entries.

An entry is written before the action starts and completed afterwards. **Incomplete** means it never recorded an outcome, usually because the function hit its time limit. Every user who can open the app sees the full log. Entries are stored in private storage and never contain API keys.

## Destructive changes

| Change in the master | What happens |
|---|---|
| Element removed that holds content in the sub-project | Counted. Needs confirmation. |
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

- **Not synced:** roles, webhooks, preview URLs, custom apps and custom element settings. These stay as each sub-project configured them.
- **Projects are created by hand** in Kontent.ai. No Kontent.ai API creates projects.
- **A failed sync can leave an environment partly updated.** data-ops is not transactional. Use the pre-sync backup to restore.
- **No live progress during a sync.** data-ops has no progress callback; the screen shows that the sync is running until it finishes.
- **Restoring a backup restores the model, not the content.** Content in elements removed by a sync does not come back.
- **Backups do not include live preview settings**, because reading them needs the Manage environments permission.
- **Backups are not deleted automatically.** Remove old ones from storage if needed.
- **Asset folders** cannot be moved (they are deleted and recreated), and cannot be deleted while they contain assets.
- **Languages** are never deleted, only deactivated and renamed.
- **Matching is by codename.** External IDs are not synced.
- **Rate limits:** the Management API allows 10 requests per second and 400 per minute per environment, so large models take time to sync.

## Security

- **API keys** are only in server environment variables. They are never sent to the browser, logged, or written to storage.
- **Every API call** is checked for the access secret and an allowed master-environment user.
- **The Subscription API key** is only used for GET requests.
- **Stored data** (audit log, backups, releases, stored results) is in private storage.
- **Embedding** is limited to `https://app.kontent.ai`.

Remaining risks:

- **The access secret and the user details are not proof of identity.** Anyone who can open the app can read the secret. Someone with the secret and the internal user ID and email of an allowed user could call the backend directly. Keep the allowed roles narrow and rotate the secret when someone leaves.
- **Any allowed user can sync to any sub-project environment that has a key.**
- **Anyone with access to the server's environment variables has every Management API key.** Limit access to the hosting account.
- **Management API keys expire** (maximum 2 years). Track the expiry dates.

## Hosting without Vercel

The app is not tied to Vercel. Three parts are Vercel-specific, and each sits behind a small seam:

| Part | On Vercel | Where it lives | To replace it |
|---|---|---|---|
| Backend functions | Vercel Functions | `api/*.ts`: each file exports `{ fetch(request) }` and returns a `Response` (web standard) | Mount the same handlers on your host |
| Storage | Vercel Blob (private) | `server/storage/kvStore.ts` (interface) and `server/storage/vercelBlobKvStore.ts` | Implement the interface for your storage and use it in `server/runtime.ts` |
| Configuration | `vercel.json` | Build command, function time limits, response headers | Set the same on your host |

Everything else (React frontend in `dist/` after `pnpm build`, environment variables, Kontent.ai APIs, data-ops) works the same anywhere.

### What any host must provide

- **Node.js 22 or later** (required by data-ops).
- **HTTPS**, because Kontent.ai only loads custom apps over HTTPS.
- **The header** `Content-Security-Policy: frame-ancestors https://app.kontent.ai` on the app's pages.
- **Long requests:** diff, sync, backup, release, drift, rollout plan and metrics requests can take several minutes. Hosts that cut synchronous requests off after seconds (for example some serverless platforms' default limits) are not suitable without changing these endpoints into background jobs, which the app does not do today.
- **A writable temporary folder** (`os.tmpdir()`): data-ops writes snapshots there during backups, releases and restores.
- **Server-side environment variables** with the names in [Environment variables](#environment-variables), kept out of the browser.

### Storage requirements

Storage is a small key-value interface (`KvStore` in `server/storage/kvStore.ts`) with five operations: read JSON, write JSON, delete, list keys by prefix (sorted), and **create if absent**. Any storage works if it offers:

- **Private access**: backups and the audit log must not be publicly readable.
- **Read-after-write consistency**: a value written by one request must be visible to the next.
- **Atomic create-if-absent**: used for the per-environment sync lock. Without it, two syncs to the same environment could run at once.

Options that meet these requirements (not tested with this app):

| Storage | Create-if-absent with |
|---|---|
| Azure Blob Storage | `If-None-Match: *` on Put Blob |
| Amazon S3 | `If-None-Match: *` on PutObject (conditional writes) |
| Netlify Blobs | the `onlyIfNew` option on `set` |
| Redis (for example Upstash) | `SET key value NX` |
| Local disk (single server only) | opening the file with the `wx` flag |

To switch storage:

1. Add a file next to `server/storage/vercelBlobKvStore.ts` that implements `KvStore` for your storage. Keep values as JSON, keys as given (they contain `/`), and `listKeys` sorted ascending; the audit log and backup lists rely on that order.
2. In `server/runtime.ts`, replace `createVercelBlobKvStore("model-sync")` with your store.
3. Add tests like `server/storage/vercelBlobKvStore.test.ts`, especially for create-if-absent.

### Example: a self-hosted Node server

The simplest alternative host is a container or VM running Node (for example Azure App Service, Azure Container Apps, AWS App Runner, Fly.io or your own server). This repository does not include such a server; the sketch below shows how small it can be. It uses [Hono](https://hono.dev) to route requests to the existing handlers and serve the built frontend. Treat it as a starting point: it has not been tested with this app.

```ts
// server.ts (example only, not part of this repository)
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

const endpoints = [
  "me", "projects", "test-connection", "metrics", "diff", "sync", "backups",
  "backup-download", "exclusions", "drift", "rollout-plan", "releases",
  "clone-environment", "audit",
];

const app = new Hono();

app.use("*", async (c, next) => {
  await next();
  c.header("Content-Security-Policy", "frame-ancestors https://app.kontent.ai");
  c.header("X-Content-Type-Options", "nosniff");
});

for (const name of endpoints) {
  const handler = (await import(`./api/${name}.ts`)).default;
  app.all(`/api/${name}`, (c) => handler.fetch(c.req.raw));
}

app.use("/*", serveStatic({ root: "./dist" }));

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) });
```

Build the frontend with `pnpm build`, then run the server with a TypeScript runner such as `tsx server.ts`, behind HTTPS. With local disk storage this works on a single instance; for several instances use shared storage from the table above.

## Not yet verified

These will be tested on a real deployment, and this README updated:

- That the user ID from the custom app context is the ID the Subscription API uses. The email is cross-checked as well. If they differ, every user is refused until the lookup switches to email.
- Subscription admins without a role in the master environment are refused. It is not yet confirmed how they appear in the Subscription API.
- What the Management API does with items in a removed workflow step (blocked until tested).
- Function time limits on the plan in use. Long-running functions are set to 300 seconds on Vercel; long syncs may need more.
- That listing content types requires the Manage content model permission (Test connection relies on it).
- That the Delivery API items feed honours the `elements` projection and the `system.language` filter as used for published counts.
- Cloning an environment: the possible values of the cloning state, and whether a project-level key covers the new environment right away.
- That data-ops can write its snapshot to the function's temporary folder, and that a sub-project key's permissions are enough to read workflows and asset folders for a backup.
- A restore against a sandbox sub-project, including that data-ops accepts the stored snapshot files as a source folder.
- A full sync against a sandbox sub-project: the data-ops apply path is tested with mocks and contract tests only.
- That a sync fits within the function time limit for your largest models, and how long counting content items takes on large projects.
- The diff and impact counts against real projects. They are tested with mocked APIs and the real data-ops report renderer only.
- The alternative hosting and storage options in [Hosting without Vercel](#hosting-without-vercel).

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
| `pnpm test` | Unit tests (Vitest), with Kontent.ai APIs and storage mocked |
| `pnpm lint` | ESLint |
| `pnpm biome:check` | Biome lint and format check |
| `pnpm check:data-ops` | Fails if data-ops is not exactly the validated version or the patch is not applied |

CI runs Biome, ESLint, the data-ops check, the tests and the build.

Project layout:

```
src/        React custom app
api/        Backend endpoints, one file per endpoint (web-standard fetch handlers)
server/     Backend logic: access check, config, Kontent.ai clients, keys, diff, sync,
            backups, releases, drift, metrics, storage, audit log
patches/    pnpm patch for @kontent-ai/data-ops
scripts/    data-ops version check
```

### data-ops

The diff and sync use [`@kontent-ai/data-ops`](https://github.com/kontent-ai/data-ops), which compares and syncs content models between environments by ID and key. Environment IDs are unique across projects, so master-to-sub-project works the same way.

The app needs the structured diff, not only the HTML report, to keep project-specific items and count impact. data-ops has this internally but does not export it, so:

- data-ops is pinned to exactly **2.8.1**.
- `patches/@kontent-ai__data-ops@2.8.1.patch` adds `exports` entries for the internal diff, sync, validation, report and client modules. It changes no code.
- `server/sync/dataOps.ts` is the only file that imports data-ops.
- The diff is restricted to the chosen entities before it is shown, hashed and applied (data-ops' own sync does the same), so the diff you confirm is exactly what sync applies. A test checks this for every combination of entities.
- Contract tests (`server/sync/dataOps.contract.test.ts`) check the entry points and the report renderer, and `pnpm check:data-ops` fails the build if the version changes.

To upgrade data-ops: update the exact version, regenerate the patch with `pnpm patch`, run the tests, compare against a sandbox sub-project, then update `VALIDATED_VERSION` in `scripts/check-data-ops.mjs`.

Built on the [Kontent.ai custom app starter for React](https://github.com/kontent-ai/custom-app-starter-react) and the [Custom app SDK](https://github.com/kontent-ai/custom-app-sdk-js).

## Learn more

- [Kontent.ai custom apps](https://kontent.ai/learn/docs/custom-apps)
- [Management API](https://kontent.ai/learn/docs/apis/management-api-v2/introduction)
- [Subscription API](https://kontent.ai/learn/docs/apis/subscription-api/introduction)
- [data-ops](https://github.com/kontent-ai/data-ops)
- [Vercel Blob private storage](https://vercel.com/docs/vercel-blob/private-storage)

## License

MIT
