# Deployment notes (Cloudflare Workers static assets)

HPOGraph is a static site (no server logic, no build step) deployed on
Cloudflare's free tier. This document covers how it's actually configured
today, plus the pitfalls hit while setting it up, so a redeploy from scratch
doesn't repeat them.

## Why Workers, not classic Pages

As of 2026, Cloudflare's dashboard funnels new git-connected sites into the
unified **Workers with static assets** deployment path (`npx wrangler
deploy` in the build log) rather than the older, separate "Pages" product.
Classic Pages still works for existing projects, but new "Import an existing
Git repository" flows create a Workers project even from the Pages tab.

This repo is configured for that Workers path via **`wrangler.jsonc`** at
the repo root:

```jsonc
{
  "name": "hpograph",
  "compatibility_date": "2026-07-06",
  "workers_dev": true,
  "assets": {
    "directory": "."
  }
}
```

- `assets.directory: "."` tells `wrangler deploy` to upload everything in
  the repo as static files and serve them directly — no Worker script, no
  `main` entry point needed (confirmed: `main` is optional for
  assets-only Workers).
- Without this file, the build falls back to ambiguous auto-detection, which
  is what produces a build that "succeeds" but never actually serves the
  site (stalls at "Detected Project Settings: Worker Name: ...").
- `.assetsignore` (same syntax as `.gitignore`) excludes `scripts/`,
  `README.md`, and config files from being uploaded as publicly-servable
  static files.

## First-time setup

1. In the [Cloudflare dashboard](https://dash.cloudflare.com/), go to
   **Workers & Pages → Create application → Pages tab → Import an existing
   Git repository**, authorize the GitHub app, select `aardes/hpograph`,
   **Begin setup**.
2. Build settings: Framework preset **None**, build command empty, build
   output directory `/`. (These matter less than usual since
   `wrangler.jsonc` drives the actual deploy behavior.)
3. **Save and Deploy.**
4. **Enable the public URL** — this is a separate, easy-to-miss step for
   Workers projects (classic Pages auto-assigned a `*.pages.dev` URL;
   Workers projects do not by default). Go to the project → **Domains** tab
   → toggle on the `*.workers.dev` **Production** URL. If the toggle seems
   unresponsive, check whether a build is currently in progress — Cloudflare
   locks this control while a deployment is running; wait for it to finish
   and refresh.
5. Current live URL: **https://hpograph.amin-davani.workers.dev**

After this one-time setup, every push to `main` redeploys automatically —
no dashboard changes needed for routine updates.

## The 25 MiB file-size limit

Cloudflare rejects individual deployed files over 25 MiB. The compiled
database (`data/hpo.db`) is ~46MB uncompressed, so it is **never committed**
(gitignored). Instead, `scripts/build_db.py` also writes a gzip-compressed
`data/hpo.db.gz` (~11.6MB), which *is* committed and deployed. The browser
fetches the `.gz` file and decompresses it itself using the native
`DecompressionStream` API (`assets/js/db.js`) before handing the bytes to
sql.js — no extra JS library, no server-side gzip negotiation required.

If you ever see the app fail to load with a fetch/404 error on
`data/hpo.db.gz`, check first that the file is actually committed (`git
ls-files | grep hpo.db`) and under 25 MiB (`ls -la data/hpo.db.gz`).

## Verifying a deploy worked

Quick checks against the live URL, no browser needed:

```bash
curl -sI https://hpograph.amin-davani.workers.dev/            | head -5
curl -sI https://hpograph.amin-davani.workers.dev/data/hpo.db.gz | head -5
```

The first should return `200` with `content-type: text/html`; the second
`200` with `content-type: application/gzip` and a `content-length` in the
11-12MB range. Then load the page in a real browser and confirm: the loading
bar completes, searching a term (e.g. "Arachnodactyly") shows results, and
selecting a couple of terms produces a ranked disease/gene list.

**Edge caching after a push:** the very first fetch of `/` right after a
push can occasionally return a stale, previously-cached copy of `index.html`
for a short window before Cloudflare's edge cache picks up the new
deployment. If a just-pushed UI change (e.g. a new tab) doesn't show up
immediately, append a throwaway query string (`?v=2`) or hard-refresh before
concluding the deploy failed — a cache-busted fetch reliably shows the new
content even when the bare URL momentarily doesn't.

## Analytics

Cloudflare Web Analytics is enabled manually (the `workers.dev` subdomain
isn't proxied through a Cloudflare-managed DNS zone, so the automatic
one-click Pages/zone setup doesn't apply). The beacon snippet is embedded
directly in `index.html` before `</body>`. It only reports page
visits/referrers/performance — no query strings, search terms, or selected
HPO terms are ever sent anywhere, consistent with the rest of the app's
"nothing leaves the browser" design.

## Relative paths

All asset references (`assets/js/*.js`, `assets/css/style.css`,
`data/hpo.db.gz`) are relative, not absolute (`assets/...`, not
`/assets/...`), and there are no `file://`- or server-relative-path
assumptions anywhere in the codebase — this is what makes the same
`index.html` work identically under `python3 -m http.server`, a raw git
checkout opened with any static file server, the deployed Workers URL, and
the Docker image below.

## Docker (optional, for local/self-hosted use)

This is a second, independent way to run HPOGraph — not a replacement for
the Cloudflare deploy above, just an option for people who'd rather run it
locally or on their own infrastructure. See
[README.md § Running with Docker](README.md#running-with-docker) for the
end-user instructions (`docker run` / `docker build`); this section is
about *publishing* the image to Docker Hub.

**One-time: create the repository on Docker Hub**

1. Log into https://hub.docker.com/ (account `aardeshi`).
2. **Create Repository** → name it `hpograph` → set visibility (Public, so
   people can `docker pull` without logging in) → **Create**.
   (Docker Hub can also auto-create a public repo on first `docker push` if
   you skip this step, but creating it explicitly first lets you set the
   description/README before anyone pulls it.)

**Every time you want to publish a new image** (e.g. after a monthly data
refresh, per `MAINTENANCE.md`):

```bash
# 1. Log in once per machine/session (prompts for a Docker Hub password
#    or, better, an access token from Account Settings -> Security ->
#    New Access Token -- avoids putting your real password in shell history).
docker login

# 2. Build, tagged for your Docker Hub namespace.
docker build -t aardeshi/hpograph:latest .

# 3. (Optional but recommended) also tag with the schema version so old
#    pulls stay reproducible -- check data/hpo.db.gz's schema_version via
#    the meta table, or the number in README's "Versioning" section.
docker tag aardeshi/hpograph:latest aardeshi/hpograph:1.3

# 4. Push both tags.
docker push aardeshi/hpograph:latest
docker push aardeshi/hpograph:1.3
```

Anyone can then run it with just:

```bash
docker run --rm -p 8080:80 aardeshi/hpograph:latest
```

No login needed to *pull* a public image — only `docker login` (as the
`aardeshi` account) is needed to *push* new versions.
