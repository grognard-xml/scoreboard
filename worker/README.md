# Grognard Leaderboard Worker

Cloudflare Worker backend for the leaderboard: verifies each submitter's
GitHub identity, rate-limits, and publishes `scores.json` to
[`grognard/scoreboard`](https://github.com/grognard/scoreboard).

Replaces the Phase 1 GitHub-Issues submission flow with a single API call
from the desktop app — no copy/paste required — while keeping the same
guarantee: identity is verified by asking GitHub who a token belongs to,
never trusted from the client's say-so.

## How it works

`POST /submit` with `{ token, commission, metrics, unlockedCount, totalAchievements }`:

1. `token` is a GitHub OAuth access token the desktop app obtained via
   [Device Flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow) —
   the Worker calls `GET /user` with it to get the real, GitHub-verified
   account id/login. A client can lie about anything else in the request
   body except this.
2. Rate-limited to one submission per 15 minutes per GitHub account id,
   tracked in `LEADERBOARD_KV`.
3. The full set of entries is stored in KV (`score:<id>` keys) and
   re-published to `scores.json` in the scoreboard repo on every accepted
   submission, using a fine-grained PAT (`GITHUB_WRITE_TOKEN`) scoped to
   only that repo's Contents — set as a Worker secret, never present in
   source or shipped to any client.

## Admin: removing entries

`scores.json` in the repo is only ever a *rendering* of KV — every
accepted submission rebuilds the whole file from every `score:` key. So
editing (or emptying) that file directly does not remove anyone: the row
stays in KV and the next unrelated submission republishes it. Clearing
has to go through KV, and these two endpoints are how:

```sh
export GH_TOKEN=...   # any GitHub token; only ever used for GET /user

# Remove one player, by GitHub account id
curl -X POST https://<worker>.workers.dev/admin/delete \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$GH_TOKEN\",\"id\":\"76396963\"}"

# Empty the leaderboard entirely
curl -X POST https://<worker>.workers.dev/admin/clear \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$GH_TOKEN\"}"
```

Both drop the KV row(s) and the matching `ratelimit:` key(s), delete the
portrait(s) from `avatars/`, and republish `scores.json` — so the site and
KV can't drift apart again.

Authorization is the same identity check as `/submit`, not a shared admin
password: the Worker asks GitHub who `token` belongs to, then requires
that account id to be in `ADMIN_GITHUB_IDS` (a plain var in
`wrangler.toml` — public account ids, useless without that account's own
token). Any token GitHub accepts for `GET /user` works, including a PAT
with no scopes at all.

## Setup

```sh
npm install
npx wrangler secret put GITHUB_WRITE_TOKEN   # paste the fine-grained PAT when prompted
npm run deploy
```

## Local dev

```sh
cp .dev.vars.example .dev.vars   # fill in GITHUB_WRITE_TOKEN
npm run dev
```
