# Phase 2: closing the data-integrity gap

**Status: not built, not scheduled.** This is a scope, not a plan of
record — worth reading if cheating on the leaderboard actually becomes a
problem, not before.

## The problem Phase 1 doesn't solve

Phase 1 ([see README](../README.md)) makes the *submission channel*
trustworthy: identity comes from GitHub's own login system, and nothing
a client holds can write to `scores.json` directly. But the *data* being
submitted — `tags: 797`, `unlockedCount: 6` — is still whatever number the
desktop app's local `achievements.json` says it is, and that file lives
entirely on the player's own machine, under their own control. A secure
upload path doesn't help if the thing being uploaded was fabricated before
the upload ever happened. This is the exact same shape of problem as the
local achievements-tampering issue the desktop app already had to defend
against (see `apps/desktop/src/achievementsFile.ts` in the main
`grognard` repo) — just moved from "can I edit my own local file" to
"can I edit my own local file and then publish the result."

No amount of OAuth, rate-limiting, or backend hardening on this repo's
side touches that. Fixing it means changing *where the source of truth for
progress lives* — a redesign of the achievement system itself, not an
addition to this one.

## What would actually close it

**Move progress tracking server-side, event by event.** Instead of the
app periodically reporting a final tally, it reports individual save
events as they happen:

```json
{ "event": "save", "tagsDelta": 12, "disambiguatedDelta": 3, "at": "..." }
```

The server (not the client) accumulates these into totals and evaluates
rank thresholds — mirroring what
`apps/commons/src/desktop/achievements/evaluate.ts` does locally today,
but running against a log the client can't rewrite after the fact.

This requires:

- **A real backend with a datastore** (not just this static-Pages repo) —
  something has to receive and persist the event stream per player.
- **Identity**, same as Phase 1: GitHub-verified, not free-text.
- **Plausibility limits server-side**: reject a burst of 10,000 tags in
  one event, cap event frequency, etc. — the server now sees a stream
  instead of one trusted final number, which is what makes this
  meaningfully harder to fake than editing a JSON file.
- **Migrating (or duplicating) the evaluation logic** from the desktop
  app's `evaluate.ts` to run server-side against the event log, so rank
  medals/achievements shown on the leaderboard are computed the same way
  the local UI computes them, just from a source the player doesn't
  fully control.

## What it doesn't get you

Even fully built, this raises the cost of cheating from "edit one JSON
field" to "reimplement the save-event reporting protocol and fake a
plausible stream of it in real time." That is a real, meaningful bar for
a casual cheater. It is not a proof against a determined person willing to
reverse-engineer their own copy of an Electron app they have full local
access to — no client-side (or client-originated) telemetry system
achieves that. Same ceiling as every other trust boundary in this
project: raise the cost of casual tampering, don't promise more than that.

## Rough shape, if it's ever worth building

1. Small backend (same candidates as considered for the original Phase 1
   OAuth design: a serverless function, or a simple hosted Node service)
   with a real datastore — this is the part that actually costs ongoing
   maintenance and an account somewhere, which is exactly why Phase 1
   avoided it.
2. Desktop app: replace (or supplement) the "Submit to Leaderboard" button
   with continuous background event reporting, gated behind explicit
   opt-in given it's now a standing network connection, not a one-off
   action.
3. Backend: event ingestion endpoint, per-player event log, a ported copy
   of the rank/achievement evaluation logic, periodic `scores.json`
   publish to this repo (same as Phase 1's publish step, just fed from a
   real database instead of comment parsing).
4. Retire the Phase 1 comment-based submission path once Phase 2 is live,
   or keep both and clearly label which leaderboard entries are
   server-verified vs. self-reported.

Not scoped further than this — the honest answer is that this is a
multi-week project for a problem that may never materialize for a small
group of trusted colleagues, which is exactly why Phase 1 stops short of
it.
