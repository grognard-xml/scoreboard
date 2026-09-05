# Grognard Service Record Leaderboard

Static leaderboard for [Grognard](https://github.com/grognard/grognard).
`index.html` reads `scores.json` and renders a ranked table — no build
step, served as-is via GitHub Pages at
[grognard.github.io/scoreboard](https://grognard.github.io/scoreboard/).

## How submission works (Phase 1.5, implemented)

The desktop app's "Submit to Leaderboard" button logs the player in via
GitHub OAuth Device Flow (once — the token is cached locally after that)
and calls the [`worker/`](worker/) directly:

1. **Identity**: the Worker takes the player's token and calls GitHub's
   own `GET /user` with it — a client can claim anything else in the
   request, but not this. The OAuth app only ever requests read-your-own-
   profile access; it can't touch the org, its repos, or anything else.
2. **Write access**: the Worker publishes `scores.json` to this repo using
   a fine-grained PAT scoped to only this repo's contents, set as a Worker
   secret. No client, including the desktop app, ever holds a credential
   that can write here.
3. **Rate limiting**: 15 minutes between submissions per GitHub account
   id, tracked in the Worker's KV store.

See [`worker/README.md`](worker/README.md) for the Worker itself.

### Fallback: comment-based submission (Phase 1, still live)

If the Worker is ever down, [issue #1](https://github.com/grognard/scoreboard/issues/1)
(a permanent, pinned thread) still works as a manual fallback: post a
comment there with your stats as a fenced ` ```json ` block, and
[`.github/workflows/process-submission.yml`](.github/workflows/process-submission.yml)
validates, rate-limits, and updates `scores.json` the same way, using only
the repo's own automatic `GITHUB_TOKEN` — no separate credential. This is
a comment on an existing issue rather than a new issue per submission
deliberately: opening an issue is a public GitHub contribution (shows up
in the submitter's profile graph); commenting is not.

## `scores.json` schema

```json
[
  {
    "id": "the submitter's numeric GitHub user id",
    "displayName": "their GitHub login",
    "commission": "Caporal, Order of the Chevron",
    "metrics": {
      "texts": 1,
      "tags": 797,
      "disambiguated": 53,
      "places": 4,
      "entities": 50,
      "published": 25
    },
    "unlockedCount": 6,
    "totalAchievements": 66,
    "updatedAt": "2026-07-18T00:00:00.000Z"
  }
]
```

`id` is the de-duplication key — a resubmission from the same GitHub
account updates that entry rather than creating a new row.

## Phase 2

Not built. Totals are still self-reported by the client, same as the
local `achievements.json` file the desktop app already tracks — a secured
submission channel (either path above) stops people from tampering with
_each other's_ rows, but not from lying about their own. See
[`docs/PHASE_2.md`](docs/PHASE_2.md) for the scope of what closing that gap
would actually require.
