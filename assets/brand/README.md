# Brand assets

Source-of-truth artwork for the OpsCat brand.

- `opscat-mark.png` — primary brand mark (1025×1025, transparent): line-art cat
  watching a monitor, ball of yarn. Derived from the original artwork by keying
  out the brand-green backdrop (`#0BF111`) and cropping to content + 3% margin.

Derived copies live next to their consumers and are regenerated from this file
when it changes (stepped canvas downscale, composited back onto brand green
`#0BF111` — favicons and logo tiles keep the green-tile look):

- `web/src/assets/opscat-mark.png` (256, UI logo tiles)
- `web/public/favicon-{16,32}.png`, `web/public/apple-touch-icon.png`
- `marketing/brand/opscat-mark-{64,512}.png`, `marketing/brand/favicon-{16,32}.png`,
  `marketing/brand/apple-touch-icon.png`
