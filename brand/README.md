# Ambion brand assets

This directory holds the logos, icons, web application files, and font from
the Ambion brand kit, version 1.0. It does not hold the full kit. The full
kit adds a brand guide PDF, a distinctiveness review, and the generator
script.

## Contents

- **`logos/svg`** holds the scalable masters: horizontal, mark, and stacked
  layouts, each in primary, reverse, ink, and white color versions.
- **`logos/png`** holds sRGB screen exports of the horizontal and mark
  layouts, for tools that do not accept SVG.
- **`icons`** holds the favicon set, the Apple and Android touch icons, the
  web manifest, and GitHub avatar exports.
- **`applications`** holds the GitHub social preview image (1280 x 640) and
  the README banner (1600 x 420), each as SVG and PNG.
- **`tokens`** holds the brand colors and type scale as CSS custom
  properties (`ambion.css`) and as a JSON token file (`ambion.tokens.json`).
- **`fonts`** holds `Manrope-Variable.ttf`, the brand typeface, and its SIL
  Open Font License, `OFL.txt`. Keep the two files together.

## Asset rules

Each logo has a transparent background and built-in clear space equal to
one-quarter of the mark width. Do not crop that space away. Primary artwork
belongs on white or paper; reverse artwork belongs on ink or similarly dark
fields.

The minimum visible mark size is 24 px. The horizontal logo needs a canvas
of at least 160 px. Use `icons/favicon.svg` below 24 px.

Use Manrope 400 for body text, 600 for labels, and 700 for headings. Fall
back to `system-ui, sans-serif` where the font is not loaded. The wordmark
in the logo files uses outlined Manrope Bold with adjusted tracking; do not
retype it. The OFL does not grant rights to the Ambion name or logo.

## Web integration

Serve the `icons` directory from a public path. The example below assumes
`/brand/icons/`.

```html
<link rel="icon" href="/brand/icons/favicon.svg" type="image/svg+xml" />
<link rel="alternate icon" href="/brand/icons/favicon.ico" />
<link rel="apple-touch-icon" href="/brand/icons/apple-touch-icon.png" />
<link rel="manifest" href="/brand/icons/site.webmanifest" />
<meta name="theme-color" content="#074F60" />
```

## Source

The full brand kit, with the brand guide PDF and the generator script, is
available from the project's brand owner on request.
