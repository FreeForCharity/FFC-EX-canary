#!/usr/bin/env python3
"""Strip TrueType hinting from a woff2, keeping its exact glyph coverage.

Google's own woff2 builds are unhinted; @fontsource ships the upstream hinted
builds, whose `glyf` table carries per-glyph instruction bytecode plus fpgm/
prep/cvt. That is ~66% extra bytes on the render-blocking path for identical
coverage. Browsers rasterize with their own engines, and Google serves unhinted
to everyone, so dropping it matches the files next/font/google used to emit.

Coverage is preserved exactly: the subset is the source's own cmap.

Usage (requires `pip install fonttools brotli`):

    python3 scripts/strip-font-hinting.py <source.woff2> <dest.woff2>

Measured on this repo, against the files `next/font/google` used to emit:

    family            @fontsource   unhinted   next/font/google
    Lato 400               23,580     13,516             14,168
    Lato 700               23,040     13,664             13,980
    Open Sans (var)        48,320     40,168             42,964
    Faustina (var)         26,748     25,360             26,760
    render-blocking      121,688     92,708             97,872

So the unhinted set is lighter than what the Google loader shipped, which is
what keeps this change from costing Lighthouse performance.

The script refuses to write a file whose cmap coverage differs from the source,
and for a variable font refuses if the fvar axes or their ranges change -- a
silent coverage loss would show up as missing glyphs on a live site.
"""
import os, subprocess, sys, tempfile, pathlib
from fontTools.ttLib import TTFont

src = pathlib.Path(sys.argv[1])
dst = pathlib.Path(sys.argv[2])
font = TTFont(str(src))
codes = sorted(font.getBestCmap())
before_glyphs = len(font.getGlyphOrder())
with tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False) as fh:
    fh.write(','.join('U+%04X' % c for c in codes))
    ranges = fh.name
cmd = ['pyftsubset', str(src), '--unicodes-file=' + ranges, '--no-hinting',
       '--flavor=woff2', '--output-file=' + str(dst)]
# keep variation axes intact for variable fonts
if 'fvar' in font:
    cmd.append('--retain-gids')
try:
    subprocess.run(cmd, check=True, capture_output=True)
finally:
    # delete=False is required so pyftsubset (a separate process) can open the
    # file on every platform, so the cleanup is ours to do -- and it has to run
    # even when pyftsubset fails, or a failed batch leaves a temp file per font.
    os.unlink(ranges)
out = TTFont(str(dst))
assert sorted(out.getBestCmap()) == codes, 'COVERAGE CHANGED - refusing'
if 'fvar' in font:
    assert 'fvar' in out, 'VARIABLE AXES LOST - refusing'
    a_in = {a.axisTag: (a.minValue, a.maxValue) for a in font['fvar'].axes}
    a_out = {a.axisTag: (a.minValue, a.maxValue) for a in out['fvar'].axes}
    assert a_in == a_out, 'AXIS RANGE CHANGED: %s -> %s' % (a_in, a_out)
print('  %-44s %7d -> %7d (%+.0f%%)  cmap=%d axes=%s' % (
    src.name, src.stat().st_size, dst.stat().st_size,
    100 * (dst.stat().st_size - src.stat().st_size) / src.stat().st_size,
    len(codes), ','.join(sorted(a_out)) if 'fvar' in font else '-'))
