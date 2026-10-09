# OpenNavo logo

An N and a North Star. N stands for Navo and for North on a compass. The star's longest ray points north. Its vertical axis aligns with the N's right stem, which is shortened to make room: the route ends at the star.

## Colors

All colors come from `packages/tokens/tokens.json`:

| Part | Token | Value |
|---|---|---|
| N, upper left to lower right | `brand.logoGradient` | `#FFB347 → #FF7356 (55%) → #FF4E3A` |
| Star on dark backgrounds | `brand.logoCoreGradient` | `#FFF6D6 → #FFC861` |
| Star on light backgrounds | `brand.logoCoreGradientOnLight` | `#FFB347 → #FF8F3F` (warm white disappears on light backgrounds) |
| Wordmark | `text.primary` / `text.inverse` / `brand.coral` | Dark background / light background / coral variant |

## Construction

Using stem width s as the unit, the N is about 4.5 s high and 3.8 s wide, with diagonal thickness s and outer corner radius 0.6 s. The star is 2 s wide, with an upper ray of about 2 s and a lower ray of about 1 s. The gap above the right stem is about 0.55 s. `source/geom.js` generates the geometry from the `MASTER` and `SMALL` parameters in `source/build.js`. `SMALL` is for 32 px and below, with thicker strokes, a fuller star, and a wider gap.

- Clear space: at least x on every side, where x is the star's width.
- Minimum size: mark 16 px (use the small variant at 32 px and below); horizontal lockup 22 px high; stacked lockup 64 px wide. The standalone star (`OnLogo star`, `OnBadge star`) decorates 13–14 px badges.
- Use a warm-white star on dark backgrounds and an amber star on light backgrounds. Do not stretch, rotate, recolor, move the star, add outlines, or add shadows.
- Beside text, vertically center the N with the text, matching the horizontal lockup and UI. Square and tight view boxes center the combined N/star, leaving the N lower: shift up by the geometry's `nCenterOffset` times the view-box height. Center standalone stars by area, shifting up by `LOGO.starCenterOffset` times the side length. `logoConstants()` in `source/assets.js` computes the master and `LOGO.small` ratios.
- Wordmark: Inter Display SemiBold, `cv11` single-storey a matching the UI, −2% tracking, converted to outlines.

## Files

`svg/` contains vector sources:

| Files | Contents |
|---|---|
| `mark.svg`, `mark-on-light.svg`, `mark-mono.svg`, `mark-white.svg`, `mark-black.svg` | Optically centered mark in a 24 × 24 square view box |
| `mark-tight.svg`, `mark-on-light-tight.svg`, `mark-mono-tight.svg` | Tight bounding box |
| `mark-small.svg`, `mark-small-on-light.svg` | Small variant, 32 × 32 |
| `logo-horizontal-*.svg`, `logo-stacked-*.svg`, `wordmark-*.svg` | Horizontal, stacked, and wordmark variants: on-dark / on-light / coral / white / black |
| `app-icon.svg`, `app-icon-small.svg` | macOS icon masters (1024); small master is used for 16 and 32 px |
| `favicon.svg` | Web icon whose star follows the system color scheme |
| `trayTemplate.svg` | Menu-bar template source: small variant flattened to polygons |

Application assets derive from these sources:

| Destination | Source |
|---|---|
| `LOGO` in `packages/shared/src/brand.ts` | Paths/view boxes from `MASTER` and `SMALL`; small geometry in `LOGO.small`, tight `markViewBox`, standalone `starViewBox`, and text-alignment offsets `nCenterOffset` / `starCenterOffset` |
| PNGs, `icon.icns`, `app-icon.svg` in `apps/desktop/src-tauri/icons/` | `app-icon.svg` for 64 px and above; `app-icon-small.svg` for 16/32 px |
| `apps/desktop/src-tauri/icons/trayTemplate*.png` | `examples/generate_tray_icons.rs` rasterizes the adjacent `trayTemplate.svg` |
| Web `favicon.svg`, `favicon.ico`, `favicon-32.png`, `apple-touch-icon.png`, `icon-512.png`; admin `favicon.svg` | `favicon.svg`, `mark-small-on-light.svg`, `mark.svg`, `app-icon.svg` |

## Regeneration

```sh
cd docs/design/logo/source
node build.js   # Reuses apps/web's installed @resvg/resvg-js; writes ignored source/out/.
```

Output directories correspond to repository assets: `logo/svg`, `app-icon/`, `tauri-icons/`, `web/`, `menubar/`, and `integration/brand-logo.ts`. Review before copying according to the table above. After changing `trayTemplate.svg`, regenerate menu-bar PNGs from the repository root:

```sh
cargo run --example generate_tray_icons --manifest-path apps/desktop/src-tauri/Cargo.toml
```

macOS `.icns` generation requires the system `iconutil`. Wordmark outlines are stored in `source/wordmark-outline.json`. After a name or font change, install `fonttools` and `uharfbuzz`, and extract again from Inter Display SemiBold (Inter 4.1, SIL OFL 1.1):

```sh
cd docs/design/logo/source
uv run --no-project --with fonttools --with uharfbuzz python -I wordmark.py /path/to/InterDisplay-SemiBold.ttf OpenNavo cv11 -0.02 wordmark-outline.json
```

## Social banner

`social/x-banner.png` is the upload-ready X (Twitter) header (1500 × 500); `social/x-banner.svg` is its outlined vector equivalent. The avatar/logo overlays the lower left; glow and concentric dashed rings radiate from it, with app tiles on the orbits and a headline on the right. Colors, glow, and tile palettes come from tokens; tile rules match `packages/shared/src/icons.ts`.

- Keep-out regions: the X web avatar including border is approximately centered at (217, 494), radius 177 in banner coordinates. Mobile is similar and slightly smaller, with back/more buttons in the upper corners. Keep text and tiles clear of these regions.
- Regenerate with `cd source && node social.js`. Review `source/out/social/`, including `x-banner-preview.png` with avatar overlay, before copying to `social/`.
- Change copy in `source/social_text.py` under `LINES`, re-extract outlines from Inter 4.1 static fonts, then run `node social.js`:

```sh
uv run --no-project --with fonttools --with uharfbuzz python -I social_text.py /path/to/Inter-font-directory
```
