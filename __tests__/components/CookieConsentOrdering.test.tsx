import React from 'react'
import { render, waitFor } from '@testing-library/react'
import CookieConsent from '../../src/components/cookie-consent'

// The shipped GA measurement ID is the inert placeholder, which keeps the
// direct GA4 loader from injecting anything — give this suite a real-looking
// ID so the injection (and its ordering against the consent update) is
// observable. isConfigured keeps its real implementation.
jest.mock('../../src/lib/analytics.config', () => {
  const actual = jest.requireActual('../../src/lib/analytics.config')
  return {
    ...actual,
    analyticsConfig: { ...actual.analyticsConfig, gaMeasurementId: 'G-TEST1234567' },
  }
})

const GA_SCRIPT_SELECTOR = 'script[src*="googletagmanager.com/gtag"]'

/**
 * Locks the fix for the returning-decliner race: the unscoped Consent Mode
 * default is GRANTED, so if the GA tag were injected before the stored
 * choice is restored, a returning visitor outside the EEA/UK/CH who
 * previously DECLINED analytics could be sent a cookie-based hit before
 * their stored denial reaches the queue. Both default calls do carry
 * wait_for_update as a mitigation, but that is a bounded grace window, not
 * an ordering guarantee — the component must still push the
 * `consent update` BEFORE injecting GA on a stored-choice restore.
 */
describe('CookieConsent restore/load ordering', () => {
  beforeEach(() => {
    window.localStorage.clear()
    document.querySelectorAll('script').forEach((s) => s.remove())
    window.dataLayer = []
  })

  afterEach(() => {
    // jsdom executes the injected GA config script, whose `function gtag()`
    // declaration lands on window as a non-configurable (but writable)
    // property — so reset by assignment, not delete.
    window.gtag = undefined
  })

  it('pushes the stored denial consent update BEFORE injecting the GA script', async () => {
    // Record, at the moment of every consent update, whether the GA script
    // tag had already been injected. Keep our own reference to the mock:
    // the injected GA config script re-declares window.gtag when it runs,
    // so window.gtag is not guaranteed to still BE the mock afterwards.
    const gaPresentAtUpdate: boolean[] = []
    const gtagMock = jest.fn((...args: unknown[]) => {
      if (args[0] === 'consent' && args[1] === 'update') {
        gaPresentAtUpdate.push(document.querySelector(GA_SCRIPT_SELECTOR) !== null)
      }
    })
    window.gtag = gtagMock

    // Returning visitor who previously declined analytics + marketing.
    window.localStorage.setItem(
      'cookie-consent',
      JSON.stringify({ necessary: true, functional: true, analytics: false, marketing: false })
    )

    render(<CookieConsent />)

    // GA still loads (Consent Mode gates storage, not loading)…
    await waitFor(() => {
      expect(document.querySelector(GA_SCRIPT_SELECTOR)).not.toBeNull()
    })

    // …but every consent update fired while GA was NOT yet injected, so the
    // stored denial sits on the queue ahead of the tag's config.
    expect(gaPresentAtUpdate.length).toBeGreaterThanOrEqual(1)
    expect(gaPresentAtUpdate.every((gaWasPresent) => gaWasPresent === false)).toBe(true)

    // And the update carried the stored denial.
    expect(gtagMock).toHaveBeenCalledWith(
      'consent',
      'update',
      expect.objectContaining({ analytics_storage: 'denied', ad_storage: 'denied' })
    )
  })

  it('queues the Consent Mode update BEFORE the custom consent_update event', async () => {
    // In production both writes reach the same dataLayer queue and GTM
    // processes it in order, so a container trigger keyed on `consent_update`
    // must not be able to run before this choice's consent state is queued.
    //
    // What this case asserts is the CALL order that produces that queue
    // order: window.gtag is a mock here, so the Consent Mode update never
    // actually reaches dataLayer during the test. That is enough to
    // discriminate the defect — swapping the two makes this fail — but it is
    // not a direct assertion about dataLayer contents.
    const hasCustomEvent = () =>
      (window.dataLayer ?? []).some(
        (entry) => (entry as { event?: string } | undefined)?.event === 'consent_update'
      )

    const customEventPresentAtUpdate: boolean[] = []
    window.gtag = jest.fn((...args: unknown[]) => {
      if (args[0] === 'consent' && args[1] === 'update') {
        customEventPresentAtUpdate.push(hasCustomEvent())
      }
    })

    window.localStorage.setItem(
      'cookie-consent',
      JSON.stringify({ necessary: true, functional: true, analytics: false, marketing: false })
    )

    render(<CookieConsent />)

    await waitFor(() => {
      expect(customEventPresentAtUpdate.length).toBeGreaterThanOrEqual(1)
    })

    // The custom event had not been pushed yet at any consent update…
    expect(customEventPresentAtUpdate.every((present) => present === false)).toBe(true)
    // …and it did get pushed, so this is an ordering assertion rather than an
    // assertion that the event never fires.
    await waitFor(() => {
      expect(hasCustomEvent()).toBe(true)
    })
  })

  it('still injects the GA script when no choice is stored (defaults govern)', async () => {
    render(<CookieConsent />)

    await waitFor(() => {
      expect(document.querySelector(GA_SCRIPT_SELECTOR)).not.toBeNull()
    })
  })
})
