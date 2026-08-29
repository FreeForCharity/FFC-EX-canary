# Canary drill — smoke-engine failure-class coverage

Deterministic proof that the post-deploy smoke engine catches every failure
class it claims. Tracks issue
[FreeForCharity/FFC-Cloudflare-Automation#755](https://github.com/FreeForCharity/FFC-Cloudflare-Automation/issues/755)
(child of the "monitor the monitors" epic #752).

## What this is

`#755` asks for a quarterly drill that breaks the deployed canary site one
failure class at a time and verifies the engine reds with the **expected**
message. The full live cycle needs a gated `github-pages` deployment, so this
drill runs the engine's **decision logic** deterministically — no deploy, no
gate — and is wired into CI so a regression in the engine's detection surfaces
on every PR, not just once a quarter.

- `smoke-compliance-drill.mjs` — zero-dependency ESM module. Re-implements the
  engine's compliance/asset/failure-marker predicates (lifted from the engine
  sources cited per class) and, for each failure class, checks that a **healthy**
  probe stays green and a **broken** probe reds with the exact expected message.
  A **spec-sync guard** asserts each expected message literal still exists
  verbatim in the engine source, so this copy cannot silently drift.
- `canary-drill.test.ts` — jest wrapper that runs the drill in a child node
  process (the ESM module stays outside the jest/SWC transform) and asserts
  exit 0 + per-class coverage.

## Failure classes covered

| Class                        | Engine source                                            |
| ---------------------------- | -------------------------------------------------------- |
| Footer element removed       | `post-deploy-smoke.yml` · visual.js footer probe         |
| Required policy link missing | `post-deploy-smoke.yml` · visual.js required-links check |
| Zeffy link points at a 404   | `post-deploy-smoke.yml` · visual.js reachability loop    |
| Manifest icon asset 404s     | `scripts/smoke-check.mjs` · manifest icon resolution     |
| Cookie-consent missing       | `post-deploy-smoke.yml` · visual.js cookie-consent check |
| Donation capability lost     | `post-deploy-smoke.yml` · visual.js donation posture     |
| Unrebranded template default | `post-deploy-smoke.yml` · visual.js failureMarkers       |

The first four are the classes named in #755; the last three extend coverage
to the other classes the engine claims.

## Run it

```bash
node __tests__/scripts/smoke-compliance-drill.mjs   # standalone report + exit code
pnpm test canary-drill                            # via jest
```

## What is NOT covered here

This drill proves the engine's **detection** logic. It does not exercise the
live break → deploy → red → revert → auto-close loop against the running canary
site (that needs a `github-pages` gate approval). A gate-capable actor can still
run that live cycle; this drill is the deterministic regression guard that runs
every PR in between.
