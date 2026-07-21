#!/usr/bin/env node
/**
 * Canary drill — proves the post-deploy smoke engine catches each failure
 * class it claims (issue FreeForCharity/FFC-Cloudflare-Automation#755,
 * child of the "monitor the monitors" epic #752).
 *
 * The live drill described in #755 breaks the deployed canary site one
 * failure class at a time, waits for a real Pages deploy, and checks that
 * the engine reds with the expected message. That cycle needs a gated
 * `github-pages` deployment a cloud sandbox cannot approve, so this module
 * runs the *same decision logic* deterministically instead:
 *
 *   1. It re-implements the engine's compliance/asset decision predicates
 *      (lifted from the engine sources cited per class below).
 *   2. For every failure class it feeds a HEALTHY probe (must stay green)
 *      and a BROKEN probe (must red with the exact expected message).
 *   3. A spec-sync guard asserts each expected message literal still exists
 *      verbatim in the engine sources, so this re-implementation cannot
 *      silently drift from the workflow it is meant to prove.
 *
 * Engine sources (this repo, inherited from the FFC Single Page Template):
 *   - .github/workflows/post-deploy-smoke.yml  (step "Visual check +
 *     screenshot + compliance assertions", the visual.js heredoc)
 *   - scripts/smoke-check.mjs                   (manifest icon resolution)
 *
 * Run standalone:  node __tests__/scripts/smoke-compliance-drill.mjs
 *   exit 0 = every class caught with the expected message + specs in sync
 *   exit 1 = a class was missed, a healthy probe red, or a spec drifted
 *
 * Zero dependencies; pure ESM so it stays outside the jest/SWC transform
 * (the jest wrapper executes it in a child node process — the same pattern
 * check-site-config.test.ts uses for the other ESM scripts).
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ENGINE_WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'post-deploy-smoke.yml')
const ENGINE_SMOKE_CHECK = join(REPO_ROOT, 'scripts', 'smoke-check.mjs')

// ---------------------------------------------------------------------------
// Decision predicates — faithful re-implementation of the engine logic.
// visual.js references are line numbers in post-deploy-smoke.yml at authoring
// time; the spec-sync guard below pins the message text, not the line.
// ---------------------------------------------------------------------------

/**
 * Mirror of visual.js compliance assertions (post-deploy-smoke.yml, the
 * `if (!placeholder) {…}` block through the donation reachability loop).
 * `probe` is the shape visual.js builds from its Playwright DOM inspection.
 */
export function evaluateCompliance(probe = {}, env = {}) {
  const {
    footer = null, // { tag, text, hrefs[] } or null
    cookieConsent = null, // truthy when a consent banner is visible
    donationSurfaces = [], // [{ provider, kind, url }]
    statusOf = () => 200, // url -> HTTP status the engine's fetch would see
  } = probe

  const placeholder =
    String(env.SMOKE_PLACEHOLDER || '').toLowerCase() === 'true' ||
    String(env.SMOKE_MODE || '') === 'default'
  const requiredLinks = (
    env.SMOKE_REQUIRED_FOOTER_LINKS || '/privacy-policy,/terms-of-service|/tos'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const requireCookieConsent =
    String(env.SMOKE_REQUIRE_COOKIE_CONSENT || 'true').toLowerCase() !== 'false'
  const donationScope = String(env.SMOKE_DONATION_SCOPE || '').toLowerCase()
  const requireDonation = String(env.SMOKE_REQUIRE_DONATION_EMBED || '').toLowerCase() === 'true'
  const isApex = String(env.SMOKE_MODE || '') !== 'default'

  const zeffySurfaces = donationSurfaces.filter((s) => s.provider === 'zeffy')
  const donationEmbeds = zeffySurfaces.filter((s) => s.kind === 'embed').map((s) => s.url)

  const complianceFailures = []
  if (!placeholder) {
    if (!footer) {
      complianceFailures.push('No <footer> or [role="contentinfo"] element found in rendered page')
    } else {
      const missing = requiredLinks.filter(
        (needed) => !needed.split('|').some((alt) => footer.hrefs.some((h) => h.includes(alt)))
      )
      if (missing.length > 0) {
        complianceFailures.push(`Footer missing required policy links: ${missing.join(', ')}`)
      }
    }
    if (requireCookieConsent && !cookieConsent) {
      complianceFailures.push(
        'No cookie-consent UI visible on first load (required because site likely uses analytics/cookies; set SMOKE_REQUIRE_COOKIE_CONSENT=false to skip)'
      )
    }
  }
  if (requireDonation && donationEmbeds.length === 0) {
    complianceFailures.push(
      'SMOKE_REQUIRE_DONATION_EMBED=true but no Zeffy iframe found on the page'
    )
  }
  if (isApex && !placeholder && donationSurfaces.length === 0 && donationScope !== 'none') {
    complianceFailures.push(
      'No donation capability detected (no Zeffy, PayPal, or other donation provider found). Wire a Zeffy campaign, or set SMOKE_DONATION_SCOPE=none only if this site intentionally takes no donations.'
    )
  }
  for (const s of donationSurfaces) {
    if (s.kind === 'page') continue
    const status = statusOf(s.url)
    if (status >= 400) {
      complianceFailures.push(`${s.provider} donation ${s.kind} unreachable (${status}): ${s.url}`)
    }
  }
  return complianceFailures
}

/**
 * Mirror of scripts/smoke-check.mjs manifest-icon resolution: every icon the
 * manifest advertises must resolve 200, or the PWA install prompt fails
 * silently (the basePath-404 class from #319 / #748). Returns the list of
 * unresolved-icon failure records the engine would print.
 */
export function evaluateManifestIcons(manifest = {}, statusOf = () => 200) {
  const failures = []
  for (const icon of manifest.icons || []) {
    if (!icon?.src) continue
    if (statusOf(icon.src) !== 200) {
      failures.push(`manifest icon ${icon.src} resolves`)
    }
  }
  return failures
}

/**
 * Mirror of visual.js known-bad body markers (the `failureMarkers` list and
 * `matches` filter). A default-Pages-URL site that never got rebranded still
 * serves the FFC template default; a 200 HTTP check misses it, the engine
 * does not.
 */
export function evaluateFailureMarkers(page = {}, env = {}) {
  const bodyText = page.bodyText || ''
  const title = page.title || ''
  const allowTemplateDefault =
    String(env.SMOKE_ALLOW_TEMPLATE_DEFAULT || '').toLowerCase() === 'true'
  const markers = [
    "There isn't a GitHub Pages site here",
    'Site not found',
    '404 Not Found',
    'This page could not be found',
    'Free For Charity | Reduce Costs, Increase Impact',
    'Reduce Costs, Increase Impact',
  ].filter((m) => !(allowTemplateDefault && m.includes('Reduce Costs, Increase Impact')))
  return markers.filter((m) => bodyText.includes(m) || title.includes(m))
}

// ---------------------------------------------------------------------------
// Failure-class catalog. Each class is exercised HEALTHY (stays green) and
// BROKEN (reds with `expect`). `spec` is the literal that must remain in the
// cited engine source so this drill cannot drift from the real engine.
// ---------------------------------------------------------------------------

const HEALTHY_FOOTER = { tag: 'footer', hrefs: ['/privacy-policy', '/terms-of-service'] }
const ZEFFY_DONATE_URL = 'https://www.zeffy.com/donate'
const HEALTHY_ZEFFY = [{ provider: 'zeffy', kind: 'link', url: ZEFFY_DONATE_URL }]

export const FAILURE_CLASSES = [
  {
    id: 'footer-removed',
    label: 'Footer element removed',
    engine: 'post-deploy-smoke.yml · visual.js footer probe',
    spec: 'No <footer> or [role="contentinfo"] element found in rendered page',
    specFile: 'workflow',
    expect: 'No <footer> or [role="contentinfo"] element found in rendered page',
    run: (broken) =>
      evaluateCompliance({
        footer: broken ? null : HEALTHY_FOOTER,
        cookieConsent: true,
        donationSurfaces: HEALTHY_ZEFFY,
      }),
  },
  {
    id: 'policy-link-broken',
    label: 'Required policy link missing from footer',
    engine: 'post-deploy-smoke.yml · visual.js required-links check',
    spec: 'Footer missing required policy links: ',
    specFile: 'workflow',
    expect: 'Footer missing required policy links: /privacy-policy',
    run: (broken) =>
      evaluateCompliance({
        footer: broken ? { tag: 'footer', hrefs: ['/terms-of-service'] } : HEALTHY_FOOTER,
        cookieConsent: true,
        donationSurfaces: HEALTHY_ZEFFY,
      }),
  },
  {
    id: 'zeffy-link-404',
    label: 'Zeffy donation link points at a 404',
    engine: 'post-deploy-smoke.yml · visual.js donation reachability loop',
    spec: 'donation ${s.kind} unreachable (${r.status}): ${s.url}',
    specFile: 'workflow',
    expect: 'zeffy donation link unreachable (404): https://www.zeffy.com/donate',
    run: (broken) =>
      evaluateCompliance({
        footer: HEALTHY_FOOTER,
        cookieConsent: true,
        donationSurfaces: HEALTHY_ZEFFY,
        // Exact-match the fixture URL, not a host substring: CodeQL rightly
        // flags `url.includes('zeffy.com')` as incomplete URL sanitization
        // (arbitrary hosts can embed the string). Deterministic fixture, so
        // equality is both correct and clean.
        statusOf: (url) => (broken && url === ZEFFY_DONATE_URL ? 404 : 200),
      }),
  },
  {
    id: 'asset-path-broken',
    label: 'Manifest icon asset path 404s (basePath regression)',
    engine: 'scripts/smoke-check.mjs · manifest icon resolution',
    spec: 'manifest icon ${icon.src} resolves',
    specFile: 'smoke-check',
    expect: 'manifest icon /icon.png resolves',
    run: (broken) =>
      evaluateManifestIcons({ icons: [{ src: '/icon.png' }] }, (src) =>
        broken && src === '/icon.png' ? 404 : 200
      ),
  },
  {
    id: 'cookie-consent-missing',
    label: 'Cookie-consent banner missing on first load',
    engine: 'post-deploy-smoke.yml · visual.js cookie-consent check',
    spec: 'No cookie-consent UI visible on first load',
    specFile: 'workflow',
    expect: 'No cookie-consent UI visible on first load',
    run: (broken) =>
      evaluateCompliance({
        footer: HEALTHY_FOOTER,
        cookieConsent: broken ? null : true,
        donationSurfaces: HEALTHY_ZEFFY,
      }),
  },
  {
    id: 'donation-capability-lost',
    label: 'All donation surfaces removed',
    engine: 'post-deploy-smoke.yml · visual.js donation-posture check',
    spec: 'No donation capability detected (no Zeffy, PayPal, or other donation provider found).',
    specFile: 'workflow',
    expect: 'No donation capability detected',
    run: (broken) =>
      evaluateCompliance(
        {
          footer: HEALTHY_FOOTER,
          cookieConsent: true,
          donationSurfaces: broken ? [] : HEALTHY_ZEFFY,
        },
        { SMOKE_MODE: 'apex' }
      ),
  },
  {
    id: 'template-default-content',
    label: 'Unrebranded FFC template default served',
    engine: 'post-deploy-smoke.yml · visual.js failureMarkers',
    spec: 'Reduce Costs, Increase Impact',
    specFile: 'workflow',
    expect: 'Reduce Costs, Increase Impact',
    run: (broken) =>
      evaluateFailureMarkers({
        bodyText: broken
          ? 'Free For Charity | Reduce Costs, Increase Impact'
          : 'Canary drill — this is a real rebranded page body.',
        title: 'Canary',
      }),
  },
]

// ---------------------------------------------------------------------------
// Drill runner
// ---------------------------------------------------------------------------

export async function runDrill() {
  const [workflowSrc, smokeCheckSrc] = await Promise.all([
    readFile(ENGINE_WORKFLOW, 'utf8'),
    readFile(ENGINE_SMOKE_CHECK, 'utf8'),
  ])
  const sourceOf = (specFile) => (specFile === 'smoke-check' ? smokeCheckSrc : workflowSrc)

  const rows = []
  for (const c of FAILURE_CLASSES) {
    const healthy = c.run(false)
    const broken = c.run(true)
    const healthyClean = healthy.length === 0
    const brokenCaught = broken.some((m) => m.includes(c.expect))
    const specInSync = sourceOf(c.specFile).includes(c.spec)
    rows.push({
      id: c.id,
      label: c.label,
      engine: c.engine,
      healthyClean,
      brokenCaught,
      specInSync,
      brokenMessage: broken.find((m) => m.includes(c.expect)) || broken[0] || '(no failure raised)',
      ok: healthyClean && brokenCaught && specInSync,
    })
  }
  return { ok: rows.every((r) => r.ok), rows }
}

function formatReport({ ok, rows }) {
  const lines = []
  lines.push('# Canary drill — smoke-engine failure-class coverage (issue #755)')
  lines.push('')
  lines.push(`Result: ${ok ? '✅ ALL CLASSES CAUGHT' : '❌ DRILL FAILED'} (${rows.length} classes)`)
  lines.push('')
  for (const r of rows) {
    const mark = r.ok ? '✓' : '✗'
    lines.push(`${mark} ${r.id} — ${r.label}`)
    lines.push(`    engine: ${r.engine}`)
    lines.push(
      `    healthy-clean: ${r.healthyClean ? 'yes' : 'NO'} · broken-caught: ${
        r.brokenCaught ? 'yes' : 'NO'
      } · spec-in-sync: ${r.specInSync ? 'yes' : 'NO'}`
    )
    lines.push(`    expected-red: ${r.brokenMessage}`)
  }
  return lines.join('\n')
}

// Executed directly (node …/smoke-compliance-drill.mjs) -> print + exit code.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runDrill()
    .then((result) => {
      console.log(formatReport(result))
      process.exit(result.ok ? 0 : 1)
    })
    .catch((err) => {
      console.error('Canary drill crashed:', err && err.stack ? err.stack : err)
      process.exit(1)
    })
}
