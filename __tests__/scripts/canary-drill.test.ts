import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Canary drill (issue FreeForCharity/FFC-Cloudflare-Automation#755) —
 * proves the post-deploy smoke engine catches every failure class it claims.
 *
 * The drill logic is the zero-dependency ESM module smoke-compliance-drill.mjs,
 * which must stay outside the jest/SWC transform, so — like
 * check-site-config.test.ts — it is exercised by running it in a child node
 * process and by importing individual predicates via `node --input-type=module`.
 */
const drill = join(__dirname, 'smoke-compliance-drill.mjs')
const drillHref = pathToFileURL(drill).href

/** Runs a small ESM snippet that imports the drill module; returns stdout. */
function evalInChild(snippet: string): string {
  return execFileSync(process.execPath, ['--input-type=module', '-e', snippet], {
    encoding: 'utf8',
  }).trim()
}

describe('canary drill — smoke-engine failure-class coverage (#755)', () => {
  it('runs the full drill and every claimed failure class is caught', () => {
    // The module exits 0 only when, for every class, the healthy probe stays
    // green, the broken probe reds with the expected message, AND the message
    // literal is still present verbatim in the engine source (spec-in-sync).
    const out = execFileSync(process.execPath, [drill], { encoding: 'utf8' })
    expect(out).toContain('ALL CLASSES CAUGHT')
    for (const id of [
      'footer-removed',
      'policy-link-broken',
      'zeffy-link-404',
      'asset-path-broken',
      'cookie-consent-missing',
      'donation-capability-lost',
      'template-default-content',
    ]) {
      expect(out).toContain(`✓ ${id}`)
    }
  })

  it('every failure class stays green on a healthy probe and reds on a broken one', () => {
    const out = evalInChild(`
      import { FAILURE_CLASSES } from ${JSON.stringify(drillHref)}
      const bad = FAILURE_CLASSES.filter(c => {
        const healthy = c.run(false)
        const broken = c.run(true)
        const healthyClean = healthy.length === 0
        const brokenCaught = broken.some(m => m.includes(c.expect))
        return !(healthyClean && brokenCaught)
      }).map(c => c.id)
      console.log(JSON.stringify(bad))
    `)
    expect(JSON.parse(out)).toEqual([])
  })

  it('evaluateCompliance flags a missing footer with the engine message', () => {
    const out = evalInChild(`
      import { evaluateCompliance } from ${JSON.stringify(drillHref)}
      const green = evaluateCompliance({ footer: { hrefs: ['/privacy-policy', '/terms-of-service'] }, cookieConsent: true, donationSurfaces: [{ provider: 'zeffy', kind: 'link', url: 'https://zeffy.com/x' }] })
      const red = evaluateCompliance({ footer: null, cookieConsent: true, donationSurfaces: [{ provider: 'zeffy', kind: 'link', url: 'https://zeffy.com/x' }] })
      console.log(JSON.stringify({ green, red }))
    `)
    const { green, red } = JSON.parse(out)
    expect(green).toEqual([])
    expect(red).toContain('No <footer> or [role="contentinfo"] element found in rendered page')
  })
})
