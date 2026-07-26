# Brand assets

Source-of-truth artwork for the OpsCat brand.

- `opscat-mark.png` — primary brand mark (1025×1025, transparent): line-art cat
  watching a monitor, ball of yarn. Derived from the original artwork by keying
  out the brand-green backdrop (`#0BF111`) and cropping to content + 3% margin.

Derived copies live next to their consumers and are regenerated from this file
when it changes (stepped canvas downscale). On-page logos use the transparent
mark directly — light strokes on dark themes, an ink-stroke recolor
(`-dark` variants, accents kept) on light themes. Only favicons, touch icons
and the og:image are composited onto brand green, since they render on
arbitrary browser/OS surfaces:

- `web/src/assets/opscat-mark{,-dark}.png` (256, `BrandMark` in `web/src/ui.tsx`)
- `web/public/favicon-{16,32}.png`, `web/public/apple-touch-icon.png` (green tile)
- `marketing/brand/opscat-mark{,-dark}-64.png` (nav + footer logos)
- `marketing/brand/opscat-mark-512.png` (og:image, green tile),
  `marketing/brand/favicon-{16,32}.png`, `marketing/brand/apple-touch-icon.png`
