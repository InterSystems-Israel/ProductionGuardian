#!/usr/bin/env python3
"""Render docs/Brochure-A3.pdf to the raster the dashboard imports.

WHY A PDF IS NOW THE SOURCE OF TRUTH, measured rather than assumed. `docs/Brochure.png` --
the original marketing export, still in the repo and still the provenance cited by
`apps/dashboard/src/styles/tokens.css` -- is 1024 x 1536 with NO pHYs chunk, so every printer
guesses its density. 1024 px across an A4 page with 10 mm margins is 131 PPI of true detail
against a 300 PPI print spec, body copy lands at ~5.8 pt, and there is no larger copy
anywhere: one commit in `git log --all`, and `ppt/media/` inside the deck is empty. 126,721
distinct colours in flat artwork is a generated raster, not a vector save. So it could not be
printed well and could not be made to; `docs/Brochure-A3.pdf` replaces it as the print master
-- 297 x 420 mm, one page, embedded Lato subsets, ZERO images, which is what makes it sharp at
A3 or on a roll-up banner alike.

WHAT THIS SCRIPT IS FOR, given the PDF prints by itself: the dashboard's Brochure view renders
an `<img>`, and an `<img>` cannot be a PDF. So exactly one raster is derived from the master,
by this script, rather than exported by hand from a viewer -- the same reasoning as
`build-iris.sh`: an operation that ships an artefact and is typed at a prompt drifts.

THE TWO CHOICES IN HERE, both measured, both non-obvious:

  200 DPI (2339 x 3308). Not 300. The reader's top zoom is 4x the stage width, which no raster
  satisfies -- at 300 DPI the file is 3508 x 4961, which the browser decodes to ~70 MB of RAM
  on a presenter's laptop for a page it displays at a fraction of that. 200 DPI is 2.3x the
  linear resolution of the PNG it replaces and decodes to ~31 MB.

  LOSSLESS WebP. Not PNG, and not lossy WebP, and the surprise is that lossless is SMALLER
  than quality 88 on this artwork: 285 KB against 381 KB, because flat fills and vector edges
  are what lossless WebP's predictors are good at. So the usual "lossy for size" trade does not
  exist here -- q88 would cost bytes AND put ringing on 6 pt body copy. Against the 1.7 MB PNG
  it supersedes: 4.5x smaller at 2.3x the resolution, and the dashboard inlines this asset
  (BrochureView.tsx explains why), so those bytes are base64 in `dist/index.html`.

Usage:  python tools/brochure-render.py           # writes docs/Brochure-A3.webp
        python tools/brochure-render.py --check   # verifies the committed asset matches, no write
"""
import os
import sys

import pypdfium2 as pdfium
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(HERE, os.pardir, "docs")
SRC = os.path.join(DOCS, "Brochure-A3.pdf")
DST = os.path.join(DOCS, "Brochure-A3.webp")

DPI = 200
A3_MM = (297.0, 420.0)

doc = pdfium.PdfDocument(SRC)
# ASSERT THE PAGE, do not trust the filename. A master that is silently A4, or that has grown a
# second page, would render to a differently shaped asset and the dashboard would just show it.
assert len(doc) == 1, f"{SRC}: {len(doc)} pages, expected 1"
pts = doc[0].get_size()
mm = tuple(round(p / 72 * 25.4, 1) for p in pts)
assert mm == A3_MM, f"{SRC}: page is {mm} mm, expected {A3_MM}"

page = doc[0].render(scale=DPI / 72).to_pil().convert("RGB")
print(f"{os.path.basename(SRC)}: {mm[0]} x {mm[1]} mm -> {page.size[0]} x {page.size[1]} px at {DPI} DPI")

if "--check" in sys.argv:
    have = Image.open(DST).convert("RGB")
    assert have.size == page.size, f"{DST} is {have.size}, this script renders {page.size}"
    assert have.tobytes() == page.tobytes(), f"{DST} does not match a fresh render of {SRC}"
    print(f"OK: {os.path.basename(DST)} is pixel-identical to a fresh render")
else:
    page.save(DST, lossless=True, quality=100, method=6)
    print(f"wrote {os.path.basename(DST)}: {os.path.getsize(DST) / 1024:.0f} KB lossless WebP")
