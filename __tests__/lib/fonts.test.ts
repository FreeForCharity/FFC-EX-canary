import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Mock next/font/local so it echoes the call's configuration back out.
// next/jest's default mock returns literal "variable", which strips the
// data we care about (the configured CSS variable name and the src files).
jest.mock('next/font/local', () => ({
  __esModule: true,
  default: (config: Record<string, unknown>) => ({
    className: 'mock-className',
    style: { fontFamily: 'mock-family' },
    variable: config.variable,
    src: config.src,
    display: config.display,
  }),
}))

import { openSans, lato, faustina } from '../../src/lib/fonts'

const ROOT = join(__dirname, '..', '..')
const SRC_DIR = join(ROOT, 'src')
// next/font/local resolves each `path` relative to the calling module.
const FONTS_MODULE_DIR = join(SRC_DIR, 'lib')

type LocalSrc = { path: string; weight: string; style: string }
type MockFont = { variable?: string; src?: LocalSrc[]; display?: string }

const allFonts = { openSans, lato, faustina } as const
type FontName = keyof typeof allFonts

const srcOf = (font: unknown) => (font as MockFont).src ?? []

describe('fonts module exports', () => {
  it('exports exactly the three expected font instances', () => {
    expect(Object.keys(allFonts).sort()).toEqual(['faustina', 'lato', 'openSans'].sort())
    for (const font of Object.values(allFonts)) {
      expect(font).toBeDefined()
      expect(typeof font).toBe('object')
    }
  })

  it('exposes a CSS variable name on every font matching --font-<kebab-name>', () => {
    const expected: Record<FontName, string> = {
      openSans: '--font-open-sans',
      lato: '--font-lato',
      faustina: '--font-faustina',
    }
    for (const [name, font] of Object.entries(allFonts)) {
      expect({ name, variable: (font as MockFont).variable }).toEqual({
        name,
        variable: expected[name as FontName],
      })
    }
  })

  it('uses swap display for every font', () => {
    for (const [name, font] of Object.entries(allFonts)) {
      expect({ name, display: (font as MockFont).display }).toEqual({ name, display: 'swap' })
    }
  })

  // A `weight` is either one weight ('400', a static file) or a range
  // ('300 800', a variable file covering every weight in between).
  const covers = (weight: string, w: string) => {
    const [lo, hi = lo] = weight.split(' ').map(Number)
    return Number(w) >= lo && Number(w) <= hi
  }

  it('covers every normal-style weight the Google definition had', () => {
    const expectedWeights: Record<FontName, string[]> = {
      openSans: ['400', '500', '600', '700', '800'],
      lato: ['400', '700'],
      faustina: ['400', '500', '600', '700'],
    }
    for (const [name, font] of Object.entries(allFonts)) {
      const src = srcOf(font)
      const missing = expectedWeights[name as FontName].filter(
        (w) => !src.some((s) => covers(s.weight, w))
      )
      expect({ name, missing }).toEqual({ name, missing: [] })
      expect({ name, styles: [...new Set(src.map((s) => s.style))] }).toEqual({
        name,
        styles: ['normal'],
      })
    }
  })

  it('loads the variable families from ONE file each, as the Google loader did', () => {
    // A file per weight added seven preloaded requests and cost Lighthouse
    // performance (FreeForCharity/FFC-IN-FFC_Single_Page_Template#479).
    expect(srcOf(openSans).map((s) => s.weight)).toEqual(['300 800'])
    expect(srcOf(faustina).map((s) => s.weight)).toEqual(['300 800'])
    expect(Object.values(allFonts).flatMap(srcOf)).toHaveLength(4)
  })

  it('points every source at a committed latin woff2 file that exists', () => {
    for (const [name, font] of Object.entries(allFonts)) {
      const src = srcOf(font)
      expect(src.length).toBeGreaterThan(0)
      for (const { path, weight } of src) {
        const abs = resolve(FONTS_MODULE_DIR, path)
        const expectedSuffix = weight.includes(' ')
          ? '-latin-wght-normal.woff2'
          : `-latin-${weight}-normal.woff2`
        expect({ name, path, suffix: path.endsWith(expectedSuffix) }).toEqual({
          name,
          path,
          suffix: true,
        })
        expect({ name, path, exists: existsSync(abs) }).toEqual({ name, path, exists: true })
        // woff2 magic number: the file is a real font, not an LFS pointer or stub.
        expect(readFileSync(abs).subarray(0, 4).toString('latin1')).toBe('wOF2')
      }
    }
  })

  it('ships the OFL license alongside every self-hosted family', () => {
    const familyDirs = new Set(
      Object.values(allFonts).flatMap((f) =>
        srcOf(f).map((s) => resolve(FONTS_MODULE_DIR, s.path, '..'))
      )
    )
    expect(familyDirs.size).toBe(3)
    for (const dir of familyDirs) {
      const license = join(dir, 'OFL.txt')
      expect({ dir, exists: existsSync(license) }).toEqual({ dir, exists: true })
      expect(readFileSync(license, 'utf8')).toContain('SIL Open Font License, Version 1.1')
    }
  })
})

describe('no Google-hosted fonts', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const full = join(dir, n)
      return statSync(full).isDirectory() ? walk(full) : [full]
    })

  // Same rule as check:drift's googleFontFindings: an import, re-export, dynamic
  // import or require of the module counts; naming it in a comment does not
  // (src/lib/fonts.ts explains in a comment why it is banned).
  // Exercise the REAL detector that scripts/check-drift.mjs exports, not a copy
  // of it. An earlier version of this test re-implemented the regex and the
  // comment scanner here; that validated a duplicate, so a regression in the
  // actual detector could not fail this test and the two copies could drift
  // apart. The script is ESM and must stay outside the jest/ts transform, so it
  // is imported in a child node process -- the same pattern
  // __tests__/scripts/check-drift.test.ts uses for these pure detectors.
  const DRIFT_SCRIPT = join(ROOT, 'scripts', 'check-drift.mjs')

  type GoogleFontFinding = { path: string; line: number; label: string }

  /** Runs the exported `googleFontFindings(files)` in a child node process. */
  const findingsInChild = (files: { path: string; body: string }[]): GoogleFontFinding[] => {
    const href = pathToFileURL(DRIFT_SCRIPT).href
    // The payload goes in on STDIN, not in argv: the whole of src/ as a
    // command-line argument exceeds the OS limit and spawn fails with E2BIG.
    const out = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const m = await import(${JSON.stringify(href)});` +
          `let s = '';` +
          `for await (const c of process.stdin) s += c;` +
          `process.stdout.write(JSON.stringify(m.googleFontFindings(JSON.parse(s))))`,
      ],
      { encoding: 'utf8', input: JSON.stringify(files), maxBuffer: 32 * 1024 * 1024 }
    )
    return JSON.parse(out) as GoogleFontFinding[]
  }

  const flagged = (code: string) =>
    findingsInChild([{ path: 'src/probe.ts', body: code }]).length > 0

  it('never imports next/font/google anywhere under src/', () => {
    const files = walk(SRC_DIR)
      .filter((f) => /\.(tsx?|jsx?|mjs|cjs|css)$/.test(f))
      .map((f) => ({ path: f.slice(ROOT.length + 1), body: readFileSync(f, 'utf8') }))
    expect(findingsInChild(files)).toEqual([])
  })

  it('the child harness really reaches the detector (a planted offender is caught)', () => {
    // Guards the harness itself: if the child import silently failed and always
    // returned [], the sweep above would pass on a repo full of offenders.
    const planted = findingsInChild([
      { path: 'src/planted.ts', body: "import { Lato } from 'next/font/google'" },
    ])
    expect(planted).toHaveLength(1)
    expect(planted[0]).toMatchObject({ path: 'src/planted.ts', label: 'a next/font/google import' })
  })

  it('applies that rule to imports but not to comments', () => {
    expect(flagged("import { Lato } from 'next/font/google'")).toBe(true)
    expect(flagged("const u = 'https://x.example'; import('next/font/google')")).toBe(true)
    expect(flagged("await import(/* webpackPrefetch: true */ 'next/font/google')")).toBe(true)
    expect(flagged("// import { Lato } from 'next/font/google'")).toBe(false)
    expect(flagged("const u = '//cdn.example'; import('next/font/google')")).toBe(true)
    expect(flagged("const x = 1// import('next/font/google')")).toBe(false)
    expect(flagged("const s = '/*'; import('next/font/google')")).toBe(true)
    expect(flagged("/*\n import { Lato } from 'next/font/google'\n*/")).toBe(false)
  })

  it('imports next/font/local in src/lib/fonts.ts', () => {
    const body = readFileSync(join(FONTS_MODULE_DIR, 'fonts.ts'), 'utf8')
    expect(body).toMatch(/from\s+['"]next\/font\/local['"]/)
  })
})
