# Brand assets

Source-of-truth artwork for the OpsCat brand.

- `opscat-mark.png` — primary brand mark (1025×1025, transparent): line-art cat
  watching a monitor, ball of yarn. Derived from the original designer export by
  keying out its green-screen backdrop (production artifact, NOT a CI color) and
  cropping to content + 3% margin.

CI colors: indigo gradient `#6366f1 → #4338ca` (buttons, icon tiles), accents
from the artwork (blue `#35B7EA`, orange `#F0730F`). No green anywhere.

Derived copies live next to their consumers and are regenerated from this file
when it changes (stepped canvas downscale). On-page logos use the transparent
mark directly — light strokes on dark themes, an ink-stroke recolor
(`-dark` variants, accents kept) on light themes. Favicons, touch icons and the
og:image sit on the CI indigo gradient (rounded tile for favicons), since they
render on arbitrary browser/OS surfaces:

- `web/src/assets/opscat-mark{,-dark}.png` (256, `BrandMark` in `web/src/ui.tsx`)
- `web/public/favicon-{16,32}.png`, `web/public/apple-touch-icon.png`
- `marketing/brand/opscat-mark{,-dark}-64.png` (nav + footer logos)
- `marketing/brand/opscat-mark-512.png` (og:image),
  `marketing/brand/favicon-{16,32}.png`, `marketing/brand/apple-touch-icon.png`
