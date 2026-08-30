import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  EU_CONSENT_REGIONS,
  CONSENT_WAIT_FOR_UPDATE_MS,
  CONSENT_MODE_BOOTSTRAP,
  updateGoogleConsent,
  type ConsentPreferences,
} from '../../src/lib/consent-mode'
import { isConfigured } from '../../src/lib/analytics.config'

describe('EU_CONSENT_REGIONS', () => {
  it('contains exactly the 32 codes Google’s EU User Consent Policy covers', () => {
    // 27 EU member states + 3 non-EU EEA states + UK + Switzerland
    expect(EU_CONSENT_REGIONS).toHaveLength(32)
    const expected = [
      // EU 27
      'AT',
      'BE',
      'BG',
      'HR',
      'CY',
      'CZ',
      'DK',
      'EE',
      'FI',
      'FR',
      'DE',
      'GR',
      'HU',
      'IE',
      'IT',
      'LV',
      'LT',
      'LU',
      'MT',
      'NL',
      'PL',
      'PT',
      'RO',
      'SK',
      'SI',
      'ES',
      'SE',
      // Non-EU EEA
      'IS',
      'LI',
      'NO',
      // UK + Switzerland
      'GB',
      'CH',
    ]
    expect([...EU_CONSENT_REGIONS].sort()).toEqual([...expected].sort())
    // No duplicates
    expect(new Set(EU_CONSENT_REGIONS).size).toBe(32)
  })
})

describe('CONSENT_MODE_BOOTSTRAP', () => {
  it('emits the region-scoped denial BEFORE the unscoped grant', () => {
    const denialIdx = CONSENT_MODE_BOOTSTRAP.indexOf("'analytics_storage': 'denied'")
    const grantIdx = CONSENT_MODE_BOOTSTRAP.indexOf("'analytics_storage': 'granted'")
    expect(denialIdx).toBeGreaterThan(-1)
    expect(grantIdx).toBeGreaterThan(-1)
    expect(denialIdx).toBeLessThan(grantIdx)
  })

  it('scopes the denial to the full region array with wait_for_update', () => {
    expect(CONSENT_MODE_BOOTSTRAP).toContain(`'region': ${JSON.stringify([...EU_CONSENT_REGIONS])}`)
    expect(CONSENT_MODE_BOOTSTRAP).toContain(`'wait_for_update': ${CONSENT_WAIT_FOR_UPDATE_MS}`)
    expect(CONSENT_WAIT_FOR_UPDATE_MS).toBe(500)
  })

  it('enables url_passthrough and ads_data_redaction', () => {
    expect(CONSENT_MODE_BOOTSTRAP).toContain("gtag('set', 'url_passthrough', true)")
    expect(CONSENT_MODE_BOOTSTRAP).toContain("gtag('set', 'ads_data_redaction', true)")
  })

  it('defines gtag as a function declaration sharing one dataLayer queue', () => {
    expect(CONSENT_MODE_BOOTSTRAP).toContain('window.dataLayer = window.dataLayer || []')
    expect(CONSENT_MODE_BOOTSTRAP).toContain('function gtag(){dataLayer.push(arguments);}')
  })
})

describe('root layout consent bootstrap ordering', () => {
  // The layout is a server component excluded from jest rendering (font
  // imports), so assert on its source: the consent-mode bootstrap <script>
  // must be emitted in <head> BEFORE <GoogleTagManager />, or the regional
  // defaults would arrive after the Google tags initialise.
  const layoutSource = readFileSync(join(process.cwd(), 'src/app/layout.tsx'), 'utf8')

  it('imports the bootstrap from the consent-mode lib', () => {
    expect(layoutSource).toContain("import { CONSENT_MODE_BOOTSTRAP } from '@/lib/consent-mode'")
  })

  it('emits the bootstrap script before <GoogleTagManager />', () => {
    const bootstrapIdx = layoutSource.indexOf(
      'dangerouslySetInnerHTML={{ __html: CONSENT_MODE_BOOTSTRAP }}'
    )
    const gtmIdx = layoutSource.indexOf('<GoogleTagManager />')
    expect(bootstrapIdx).toBeGreaterThan(-1)
    expect(gtmIdx).toBeGreaterThan(-1)
    expect(bootstrapIdx).toBeLessThan(gtmIdx)
  })
})

describe('updateGoogleConsent', () => {
  afterEach(() => {
    delete window.gtag
  })

  const allGranted: ConsentPreferences = {
    necessary: true,
    functional: true,
    analytics: true,
    marketing: true,
  }

  it('does nothing (and does not throw) when gtag is absent', () => {
    expect(() => updateGoogleConsent(allGranted)).not.toThrow()
  })

  it('maps analytics to analytics_storage and marketing to the ad signals', () => {
    const gtag = jest.fn()
    window.gtag = gtag
    updateGoogleConsent({ necessary: true, functional: true, analytics: true, marketing: false })
    expect(gtag).toHaveBeenCalledWith('consent', 'update', {
      analytics_storage: 'granted',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      personalization_storage: 'denied',
      functionality_storage: 'granted',
      security_storage: 'granted',
    })
  })

  it('always grants security_storage, even on full decline', () => {
    const gtag = jest.fn()
    window.gtag = gtag
    updateGoogleConsent({
      necessary: true,
      functional: false,
      analytics: false,
      marketing: false,
    })
    expect(gtag).toHaveBeenCalledWith(
      'consent',
      'update',
      expect.objectContaining({
        analytics_storage: 'denied',
        functionality_storage: 'denied',
        security_storage: 'granted',
      })
    )
  })
})

describe('isConfigured (placeholder guard)', () => {
  it('treats the shipped placeholders as unset', () => {
    expect(isConfigured('G-XXXXXXXXXX')).toBe(false)
    expect(isConfigured('XXXXXXXXXXXXXXX')).toBe(false)
    expect(isConfigured('XXXXXXXXXX')).toBe(false)
  })

  it('treats falsy values as unset', () => {
    expect(isConfigured('')).toBe(false)
    expect(isConfigured(undefined)).toBe(false)
    expect(isConfigured(null)).toBe(false)
  })

  it('accepts real-looking IDs', () => {
    expect(isConfigured('G-ABC1234567')).toBe(true)
    expect(isConfigured('GTM-TQ5H8HPR')).toBe(true)
    expect(isConfigured('abcdefghij')).toBe(true)
  })
})
