'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'
import { analyticsConfig, isConfigured } from '@/lib/analytics.config'
import {
  updateGoogleConsent,
  hasSaleShareOptOut,
  SALE_SHARE_OPT_OUT_EVENT,
} from '@/lib/consent-mode'
import { scriptString } from '@/lib/script-string'

// Tracking IDs live in src/lib/analytics.config.ts — edit them there.
const GA_MEASUREMENT_ID = analyticsConfig.gaMeasurementId
const META_PIXEL_ID = analyticsConfig.metaPixelId
const CLARITY_PROJECT_ID = analyticsConfig.clarityProjectId

// Define type for GTM dataLayer events
interface DataLayerEvent {
  event: string
  [key: string]: string | number | boolean | undefined
}

/**
 * A dataLayer write that deliberately carries NO `event` key.
 *
 * GTM merges dataLayer keys, so a push without `event` updates the variables
 * a container reads without firing any trigger. That is what the sale/share
 * opt-out needs: it has to correct the published `marketing_consent` mid-page
 * without re-firing `consent_update`, which would re-trigger every tag keyed
 * on that event and send a duplicate pageview from any whose conditions still
 * hold.
 *
 * `event?: never` rather than `event?: string`: this is not "an event where
 * the name is optional", it is the other kind of write, and keeping them
 * distinct is what stops a push that MEANT to name an event from compiling
 * silently without one.
 */
interface DataLayerValues {
  event?: never
  [key: string]: string | number | boolean | undefined
}

// Extend Window interface to include dataLayer and openCookiePreferences
declare global {
  interface Window {
    dataLayer: (DataLayerEvent | DataLayerValues)[]
    openCookiePreferences?: () => void
  }
}

// The scriptString helper used to be DEFINED here, and a second copy lived
// in the GTM loader. One implementation now lives in src/lib/script-string.ts;
// this module re-exports it so existing importers and its own test keep
// working. Re-exported via import + export rather than
// `export { x } from ...`, because that form creates no local binding and
// this file calls scriptString itself further down.
export { scriptString }

interface CookiePreferences {
  necessary: boolean
  functional: boolean
  analytics: boolean
  marketing: boolean
}

export default function CookieConsent() {
  const [showBanner, setShowBanner] = useState(false)
  const [showPreferences, setShowPreferences] = useState(false)
  const [preferences, setPreferences] = useState<CookiePreferences>({
    necessary: true, // Always true, cannot be changed
    functional: true, // Always true, cannot be changed - includes Zeffy donation forms
    analytics: false,
    marketing: false,
  })
  const [savedPreferencesBackup, setSavedPreferencesBackup] =
    useState<CookiePreferences>(preferences)
  const modalRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  // Google tags speak Consent Mode, so loading is NOT gated on the
  // analytics toggle: the direct GA4 tag loads on every pageview (like GTM
  // in the layout) and the Consent Mode defaults/updates decide whether it
  // may use cookies. With the shipped placeholder ID this loader is inert —
  // fleet sites get GA4 delivered through GTM instead.
  const loadGoogleAnalytics = useCallback(() => {
    if (!isConfigured(GA_MEASUREMENT_ID)) return
    if (
      typeof window !== 'undefined' &&
      !document.querySelector('script[src*="googletagmanager.com/gtag"]')
    ) {
      const gaScript = document.createElement('script')
      gaScript.async = true
      gaScript.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`
      document.head.appendChild(gaScript)

      const gaConfigScript = document.createElement('script')
      const secureFlag =
        typeof window !== 'undefined' && window.location.protocol === 'https:' ? ';Secure' : ''
      gaConfigScript.textContent = `
        window.dataLayer = window.dataLayer || [];
        function gtag(){dataLayer.push(arguments);}
        gtag('js', new Date());
        gtag('config', ${scriptString(GA_MEASUREMENT_ID)}, {
          'anonymize_ip': true,
          'cookie_flags': 'SameSite=Lax${secureFlag}'
        });
      `
      document.head.appendChild(gaConfigScript)
    }
  }, [])

  // Meta Pixel does NOT speak Consent Mode, so it stays strictly opt-in:
  // it loads only on an explicit marketing grant, everywhere in the world.
  const loadMetaPixel = useCallback(() => {
    if (!isConfigured(META_PIXEL_ID)) return
    if (typeof window !== 'undefined' && !document.querySelector('script[src*="fbevents.js"]')) {
      const fbScript = document.createElement('script')
      fbScript.textContent = `
        !function(f,b,e,v,n,t,s)
        {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
        n.callMethod.apply(n,arguments):n.queue.push(arguments)};
        if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
        n.queue=[];t=b.createElement(e);t.async=!0;
        t.src=v;s=b.getElementsByTagName(e)[0];
        s.parentNode.insertBefore(t,s)}(window, document,'script',
        'https://connect.facebook.net/en_US/fbevents.js');
        fbq('init', ${scriptString(META_PIXEL_ID)});
        fbq('track', 'PageView');
      `
      document.head.appendChild(fbScript)

      const fbNoScript = document.createElement('noscript')
      const img = document.createElement('img')
      img.height = 1
      img.width = 1
      img.style.display = 'none'
      img.src = `https://www.facebook.com/tr?id=${META_PIXEL_ID}&ev=PageView&noscript=1`
      fbNoScript.appendChild(img)
      document.body.appendChild(fbNoScript)
    }
  }, [])

  // Microsoft Clarity does NOT speak Consent Mode, so it stays strictly
  // opt-in: it loads only on an explicit analytics grant, everywhere.
  const loadMicrosoftClarity = useCallback(() => {
    if (!isConfigured(CLARITY_PROJECT_ID)) return
    if (typeof window !== 'undefined' && !document.querySelector('script[src*="clarity.ms"]')) {
      const clarityScript = document.createElement('script')
      clarityScript.textContent = `
        (function(c,l,a,r,i,t,y){
          c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
          t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
          y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
        })(window, document, "clarity", "script", ${scriptString(CLARITY_PROJECT_ID)});
      `
      document.head.appendChild(clarityScript)
    }
  }, [])

  const expireCookies = useCallback((names: string[]) => {
    // A cookie can only be deleted by a request whose domain attribute
    // MATCHES the one it was set with. GA4 scopes `_ga` to the registrable
    // domain with a leading dot (e.g. `.example.org`) so it is readable
    // across subdomains — expiring it with only the bare hostname silently
    // does nothing and the visitor keeps the identifier they just asked us
    // to drop.
    //
    // Best-effort candidate set, no public-suffix list needed: walk up the
    // hostname's labels and try every suffix that keeps at least two
    // labels, each with and without a leading dot, plus the host-only
    // form. Candidates that happen to be public suffixes (e.g. `co.uk`)
    // are harmless no-ops — browsers reject cookie writes (and therefore
    // expirations) scoped to a public suffix.
    const labels = window.location.hostname.split('.')
    const domains = new Set<string>()
    for (let i = 0; i < labels.length - 1; i++) {
      const suffix = labels.slice(i).join('.')
      domains.add(suffix)
      domains.add(`.${suffix}`)
    }

    names.forEach((name) => {
      const expiry = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`
      // Host-only (no domain attribute).
      document.cookie = expiry
      domains.forEach((domain) => {
        document.cookie = `${expiry} domain=${domain};`
      })
    })
  }, [])

  // Expires the cookies of each category NOT granted in `prefs` — analytics
  // covers GA4 + Clarity, marketing covers the Meta Pixel. Called with no
  // argument it drops both.
  //
  // Scoped by category because a visitor who keeps analytics but drops
  // marketing must not have their `_ga` client id wiped along with the
  // Pixel's.
  const deleteTrackingCookies = useCallback(
    (prefs?: CookiePreferences) => {
      const deleteAnalytics = !prefs || !prefs.analytics
      // A sale/share opt-out (footer control, GPC, or a child-directed site)
      // forces the marketing cookies out regardless of the banner's marketing
      // toggle: it is a statutory right, and it outranks an earlier accept.
      const deleteMarketing = !prefs || !prefs.marketing || hasSaleShareOptOut()

      // Static cookie names: GA4, Microsoft Clarity, Meta Pixel
      expireCookies([
        ...(deleteAnalytics ? ['_ga', '_gid', '_clck', '_clsk'] : []),
        ...(deleteMarketing ? ['_fbp', 'fr'] : []),
      ])

      // Dynamically delete all cookies matching _ga_* (e.g., _ga_G-XXXXXXXXXX)
      if (deleteAnalytics && typeof document !== 'undefined') {
        const dynamicNames = document.cookie
          .split(';')
          .map((cookie) => cookie.split('=')[0].trim())
          .filter((cookieName) => cookieName.startsWith('_ga_'))
        expireCookies(dynamicNames)
      }
    },
    [expireCookies]
  )

  const applyConsent = useCallback(
    (prefs: CookiePreferences) => {
      // Set a cookie to indicate consent status with Secure flag (only on HTTPS)
      const cookieValue = JSON.stringify(prefs)
      const secureFlag =
        typeof window !== 'undefined' && window.location.protocol === 'https:' ? '; Secure' : ''
      document.cookie = `cookie-consent=${encodeURIComponent(cookieValue)}; path=/; max-age=31536000; SameSite=Lax${secureFlag}`

      // Delete each non-granted category's cookies on EVERY apply — not only on
      // withdrawal of a stored grant. Storage was GRANTED outside the EEA/UK/CH
      // under this site's earlier defaults, so cookies can already exist the
      // first time a visitor declines, and a restore from storage carries no
      // previous state at all. Keying on the resulting preferences covers both.
      // `adsDenied` is in the CONDITION, not only inside
      // deleteTrackingCookies, and that matters: an opted-out visitor whose
      // stored choice is accept-everything has both categories granted, so
      // without it this branch never runs and the Pixel keeps its cookies.
      // The clause was first added inside the helper alone, where it was
      // unreachable for exactly that visitor — a mutation run found it inert.
      // The opt-out, read once for the value this apply publishes.
      //
      // It is NOT the only read: deleteTrackingCookies and the Meta loader
      // below call hasSaleShareOptOut() themselves, and an earlier version of
      // this comment claimed otherwise -- it said "ONE read for the whole
      // apply" when there were four. What makes those reads safe is that the
      // helper LATCHES an observed opt-out for the session, so a later read
      // can never be less restrictive than this one; threading a snapshot
      // through every call site would have had to be remembered at each new
      // one. Reported by Copilot, who read the claim against the code.
      const adsDenied = hasSaleShareOptOut()

      if (!prefs.analytics || !prefs.marketing || adsDenied) {
        deleteTrackingCookies(prefs)
      }

      // Push the Google Consent Mode `update` mirroring this choice. This is
      // what lifts the denied-by-default state to granted for any visitor who
      // accepts; for one who declines it pins storage to denied and GA4 stays
      // on cookieless pings.
      //
      // Queued BEFORE the custom `consent_update` event pushed below: both
      // writes land in the same dataLayer queue and GTM processes it in order,
      // so a container trigger keyed on that event would otherwise evaluate
      // consent state before this choice had been applied. The ordering case
      // in this repo's test suite fails if the two are swapped.
      updateGoogleConsent(prefs, { adsDenied })

      // Push consent update to GTM dataLayer
      if (typeof window !== 'undefined') {
        window.dataLayer = window.dataLayer || []
        window.dataLayer.push({
          event: 'consent_update',
          functional_consent: prefs.functional ? 'granted' : 'denied',
          analytics_consent: prefs.analytics ? 'granted' : 'denied',
          // The EFFECTIVE state, not the raw preference. A sale/share opt-out
          // -- footer control, GPC, or a child-directed site -- denies
          // advertising regardless of what the banner's marketing toggle says,
          // and this event is documented for container tags to key on. Until
          // this read `prefs.marketing`, an opted-out visitor who had earlier
          // accepted marketing had 'granted' republished on every pageview,
          // and any GTM tag trusting it fired: the opt-out was honoured for
          // Google tags via Consent Mode and discarded for everything else.
          //
          // `analytics_consent` is deliberately NOT gated the same way. The
          // opt-out is of sale/sharing for advertising; first-party analytics
          // is a separate choice the visitor still holds, and denying it here
          // would withdraw consent they never withdrew.
          marketing_consent: prefs.marketing && !adsDenied ? 'granted' : 'denied',
        })
      }

      // Google tags load regardless of the toggle — Consent Mode (above)
      // gates whether they may use cookies. Inert with a placeholder ID.
      loadGoogleAnalytics()

      // Non-Google tags don't speak Consent Mode, so they stay strictly
      // opt-in everywhere: Clarity needs an explicit analytics grant, Meta
      // Pixel an explicit marketing grant.
      if (prefs.analytics) {
        loadMicrosoftClarity()
      }
      // The Pixel does NOT speak Consent Mode, so denying ad_storage does
      // nothing to it. It has to be gated here, by hand, or the footer
      // control would claim advertising sharing is off while Meta kept
      // receiving PageView data on every later page. This is also what makes
      // the child-directed guarantee true for non-Google tags:
      // hasSaleShareOptOut() returns true whenever that knob is set.
      if (prefs.marketing && !hasSaleShareOptOut()) {
        loadMetaPixel()
      }
    },
    [deleteTrackingCookies, loadGoogleAnalytics, loadMetaPixel, loadMicrosoftClarity]
  )

  // Helper to load preferences from localStorage and update state
  const loadPreferencesFromLocalStorage = useCallback(
    (showBannerIfMissing = true) => {
      try {
        const consent = localStorage.getItem('cookie-consent')
        if (!consent) {
          // No stored choice: the Consent Mode defaults set in the layout
          // <head> govern, so the Google tag loads now (a first-time visitor
          // anywhere is measured cookielessly until they accept) and we ask.
          // Ordering matters — when a stored choice DOES exist, applyConsent
          // below pushes the consent update BEFORE loading GA, so a stored
          // denial is on the queue ahead of the tag's first hit.
          loadGoogleAnalytics()
          if (showBannerIfMissing) setShowBanner(true)
          return
        }
        let savedPreferences: CookiePreferences
        try {
          savedPreferences = JSON.parse(consent)
        } catch {
          loadGoogleAnalytics()
          if (showBannerIfMissing) setShowBanner(true)
          return
        }

        // Validate the structure (functional is optional for backward compatibility)
        if (
          typeof savedPreferences === 'object' &&
          savedPreferences !== null &&
          typeof savedPreferences.necessary === 'boolean' &&
          typeof savedPreferences.analytics === 'boolean' &&
          typeof savedPreferences.marketing === 'boolean'
        ) {
          // Ensure functional is always true (for backward compatibility with old saved preferences)
          // Create a new object to avoid mutation
          const updatedPreferences: CookiePreferences = {
            ...savedPreferences,
            functional: true,
          }
          setPreferences(updatedPreferences)
          setSavedPreferencesBackup(updatedPreferences)
          applyConsent(updatedPreferences)
        } else {
          // Invalid data, show banner again
          loadGoogleAnalytics()
          if (showBannerIfMissing) setShowBanner(true)
        }
      } catch {
        // If localStorage is unavailable or data is corrupted, show banner
        loadGoogleAnalytics()
        if (showBannerIfMissing) setShowBanner(true)
      }
    },
    [applyConsent, loadGoogleAnalytics]
  )

  const handleCancelPreferences = useCallback(() => {
    // Restore the backed-up preferences
    setPreferences(savedPreferencesBackup)
    setShowPreferences(false)
  }, [savedPreferencesBackup])

  // Initialize state from localStorage on mount - this is the correct pattern for hydration
  useEffect(() => {
    // Expose method to window for reopening preferences from other components
    window.openCookiePreferences = () => {
      setShowBanner(true)
      setShowPreferences(true)
      loadPreferencesFromLocalStorage(false)
    }

    // Check if user has already made a choice with error handling. This is
    // also what loads the Google tag on every pageview: with no stored
    // choice it loads GA directly (Consent Mode defaults govern), and with
    // a stored choice applyConsent pushes the consent update FIRST and then
    // loads GA — never load GA ahead of this call, or a returning visitor's
    // stored denial would reach the queue after the tag's config.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadPreferencesFromLocalStorage(true)

    // The footer's "Do Not Sell or Share" control reaches the non-Google tags
    // through this event. Consent Mode governs Google only, so without it the
    // control would deny ad_storage while the Meta Pixel carried on with the
    // cookies it had already set.
    //
    // What this does NOT claim: a Pixel already executing in this page cannot
    // be unloaded. Expiring its cookies and refusing to load it again is the
    // most a client-side control can honestly do, and the policy text says so
    // rather than promising more.
    const onSaleShareOptOut = () => {
      expireCookies(['_fbp', 'fr'])

      // applyConsent published the pre-opt-out `marketing_consent`, and for an
      // opt-out that happens DURING this page nothing republishes it: a GTM
      // container reading that variable would go on seeing 'granted' until the
      // next navigation re-ran applyConsent.
      //
      // Pushed with NO `event` key on purpose. GTM merges dataLayer keys, so
      // this corrects the variable without firing a second `consent_update`.
      // Re-firing it would re-trigger every tag keyed on that event, and any
      // whose conditions still hold -- an analytics tag, for a visitor who
      // consented to analytics -- would send a duplicate pageview. Fixing a
      // privacy defect must not buy a measurement one.
      if (typeof window !== 'undefined') {
        window.dataLayer = window.dataLayer || []
        window.dataLayer.push({ marketing_consent: 'denied' })
      }
    }
    window.addEventListener(SALE_SHARE_OPT_OUT_EVENT, onSaleShareOptOut)

    // Cleanup function to remove the window method
    return () => {
      delete window.openCookiePreferences
      window.removeEventListener(SALE_SHARE_OPT_OUT_EVENT, onSaleShareOptOut)
    }
  }, [loadPreferencesFromLocalStorage, expireCookies])

  // Focus management for modal
  useEffect(() => {
    if (showPreferences && modalRef.current) {
      // Store the previously focused element
      previousFocusRef.current = document.activeElement as HTMLElement

      // Focus the first focusable element in the modal
      const focusableElements = modalRef.current.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
      if (focusableElements.length > 0) {
        ;(focusableElements[0] as HTMLElement).focus()
      }

      // Handle Escape key
      const handleEscape = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          handleCancelPreferences()
        }
      }
      document.addEventListener('keydown', handleEscape)

      return () => {
        document.removeEventListener('keydown', handleEscape)
        // Restore focus when modal closes
        if (previousFocusRef.current) {
          previousFocusRef.current.focus()
        }
      }
    }
  }, [showPreferences, handleCancelPreferences])

  const handleAcceptAll = () => {
    const allAccepted: CookiePreferences = {
      necessary: true,
      functional: true,
      analytics: true,
      marketing: true,
    }
    setPreferences(allAccepted)
    try {
      localStorage.setItem('cookie-consent', JSON.stringify(allAccepted))
    } catch (e) {
      // If localStorage is unavailable, continue anyway
      console.warn('Unable to save preferences to localStorage:', e)
    }
    applyConsent(allAccepted)
    setSavedPreferencesBackup(allAccepted)
    setShowBanner(false)
  }

  const handleDeclineAll = () => {
    const onlyNecessary: CookiePreferences = {
      necessary: true,
      functional: true, // Functional cookies (Zeffy) are always enabled for donations
      analytics: false,
      marketing: false,
    }
    setPreferences(onlyNecessary)
    try {
      localStorage.setItem('cookie-consent', JSON.stringify(onlyNecessary))
    } catch (e) {
      // If localStorage is unavailable, continue anyway
      console.warn('Unable to save preferences to localStorage:', e)
    }

    applyConsent(onlyNecessary)
    setSavedPreferencesBackup(onlyNecessary)
    setShowBanner(false)
  }

  const handleSavePreferences = () => {
    try {
      localStorage.setItem('cookie-consent', JSON.stringify(preferences))
    } catch (e) {
      // If localStorage is unavailable, continue anyway
      console.warn('Unable to save preferences to localStorage:', e)
    }
    applyConsent(preferences)
    setSavedPreferencesBackup(preferences)
    setShowBanner(false)
    setShowPreferences(false)
  }

  const handleShowPreferences = () => {
    // Backup current preferences in case user cancels
    setSavedPreferencesBackup(preferences)
    setShowPreferences(true)
  }

  if (!showBanner) {
    return null
  }

  if (showPreferences) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cookie-preferences-title"
        onClick={(e) => {
          // Only close if clicking the overlay itself, not the modal content
          if (e.target === e.currentTarget) {
            handleCancelPreferences()
          }
        }}
      >
        <div
          ref={modalRef}
          className="bg-white rounded-lg shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        >
          <div className="p-6">
            <h2 id="cookie-preferences-title" className="text-2xl font-bold text-gray-900 mb-4">
              Cookie Preferences
            </h2>
            <p className="text-gray-600 mb-6">
              We use cookies to enhance your browsing experience and analyze our traffic. You can
              choose which types of cookies you allow.
            </p>

            {/* Necessary Cookies */}
            <div className="mb-6 p-4 bg-gray-50 rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-lg font-semibold text-gray-900">Necessary Cookies</h3>
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    checked={preferences.necessary}
                    disabled
                    className="w-5 h-5 text-blue-600 bg-gray-300 rounded cursor-not-allowed"
                  />
                  <span className="ml-2 text-sm text-gray-500">Always Active</span>
                </div>
              </div>
              <p className="text-sm text-gray-600">
                These cookies are essential for the website to function properly. They enable basic
                features like page navigation and access to secure areas. The website cannot
                function properly without these cookies.
              </p>
            </div>

            {/* Functional Cookies */}
            <div className="mb-6 p-4 bg-gray-50 rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-lg font-semibold text-gray-900">Functional Cookies</h3>
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    checked={preferences.functional}
                    disabled
                    className="w-5 h-5 text-blue-600 bg-gray-300 rounded cursor-not-allowed"
                  />
                  <span className="ml-2 text-sm text-gray-500">Always Active</span>
                </div>
              </div>
              <p className="text-sm text-gray-600 mb-2">
                These cookies enable enhanced functionality and features that are essential for our
                core services. This includes our donation processing and application form systems
                which require cookies to function properly.
              </p>
              <p className="text-xs text-gray-500">
                Services: Zeffy (Donation Processing), Microsoft Forms (Application Forms - may
                include HubSpot analytics)
              </p>
            </div>

            {/* Analytics Cookies */}
            <div className="mb-6 p-4 bg-gray-50 rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-lg font-semibold text-gray-900">Analytics Cookies</h3>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={preferences.analytics}
                    onChange={(e) =>
                      setPreferences({ ...preferences, analytics: e.target.checked })
                    }
                    className="sr-only peer"
                    aria-label="Enable analytics cookies"
                  />
                  <div className="w-11 h-6 bg-gray-300 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                </label>
              </div>
              <p className="text-sm text-gray-600 mb-2">
                These cookies help us understand how visitors interact with our website by
                collecting and reporting information anonymously. We use Google Analytics and
                Microsoft Clarity.
              </p>
              <p className="text-xs text-gray-500">Services: Google Analytics, Microsoft Clarity</p>
            </div>

            {/* Marketing Cookies */}
            <div className="mb-6 p-4 bg-gray-50 rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-lg font-semibold text-gray-900">Marketing Cookies</h3>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={preferences.marketing}
                    onChange={(e) =>
                      setPreferences({ ...preferences, marketing: e.target.checked })
                    }
                    className="sr-only peer"
                    aria-label="Enable marketing cookies"
                  />
                  <div className="w-11 h-6 bg-gray-300 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                </label>
              </div>
              <p className="text-sm text-gray-600 mb-2">
                These cookies are used to track visitors across websites. The intention is to
                display ads that are relevant and engaging for the individual user.
              </p>
              <p className="text-xs text-gray-500">Services: Meta Pixel (Facebook)</p>
            </div>

            <div className="flex flex-col sm:flex-row gap-3 mt-6">
              <button
                onClick={handleSavePreferences}
                className="flex-1 px-6 py-3 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition-colors"
              >
                Save Preferences
              </button>
              <button
                onClick={handleCancelPreferences}
                className="flex-1 px-6 py-3 bg-gray-200 text-gray-700 rounded-lg font-semibold hover:bg-gray-300 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-50 bg-white border-t-2 border-gray-200 shadow-2xl"
      role="region"
      aria-label="Cookie consent notice"
    >
      <div className="max-w-7xl mx-auto p-4 sm:p-6">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="flex-1">
            <h3 className="text-lg font-bold text-gray-900 mb-2">We Value Your Privacy</h3>
            <p className="text-sm text-gray-600 mb-3">
              We use cookies to improve your experience on our site, analyze traffic, and enable
              certain features. By clicking &quot;Accept All&quot;, you consent to our use of
              cookies for analytics and marketing purposes. You can manage your preferences or
              decline non-essential cookies.
            </p>
            <div className="flex items-center gap-4 text-xs text-gray-500">
              <Link href="/privacy-policy" className="text-blue-600 underline">
                Privacy Policy
              </Link>
              <Link href="/cookie-policy" className="text-blue-600 underline">
                Cookie Policy
              </Link>
            </div>
          </div>
          <div className="flex flex-col sm:flex-row gap-2 w-full md:w-auto">
            <button
              onClick={handleDeclineAll}
              className="px-6 py-2.5 bg-gray-200 text-gray-700 rounded-lg font-semibold hover:bg-gray-300 transition-colors text-sm whitespace-nowrap"
            >
              Decline All
            </button>
            <button
              onClick={handleShowPreferences}
              className="px-6 py-2.5 bg-gray-200 text-gray-700 rounded-lg font-semibold hover:bg-gray-300 transition-colors text-sm whitespace-nowrap"
            >
              Customize
            </button>
            <button
              onClick={handleAcceptAll}
              className="px-6 py-2.5 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition-colors text-sm whitespace-nowrap"
            >
              Accept All
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
