# hoodoracle brand

Everything here is generated. `npm run brand` rewrites the mark files and
re-renders every export, so nothing in this directory should be hand-edited
except the composition HTML.

```
npm run brand              rebuild marks + render all exports
npm run brand -- og        render one target
```

Chromium is the rasteriser. It already ships with the browser tests, it obeys
the same CSS and web fonts the product uses, and it makes each export provably
the same rendering the site would produce — which a separate design file
cannot.

## The mark

Two confidence intervals sharing one estimate axis: the same price, two
different degrees of certainty about it. That pairing is the thing this oracle
publishes and other equity oracles do not, so it is the thing the mark draws.

The vertical spine is load bearing. Without it the two intervals read as
unrelated objects rather than one diagram — that was the first version, and it
looked like two dumbbells.

Below roughly 24px the pair turns to mush, so small sizes use
`mark-simple.svg`: one interval, same idea, no detail to lose. The favicon is
that reduction.

| File | Use |
|---|---|
| `mark.svg` | Primary, on paper grounds |
| `mark-ink.svg` | On ink grounds |
| `mark-mono.svg` | Single-colour reproduction |
| `mark-simple.svg` | 24px and below, favicon |
| `mark-simple-ink.svg` | Same, on ink |

## Exports

| File | Size | Where |
|---|---|---|
| `twitter-header.png` | 3000×1000 (1500×500 @2x) | X profile header |
| `dexscreener-header.png` | 3000×1000 | DEX Screener token header, paper |
| `dexscreener-header-ink.png` | 3000×1000 | DEX Screener, ink — matches their dark UI |
| `avatar.png` / `avatar-ink.png` | 800×800 | Profile pictures |
| `og-image.png` | 2400×1260 | Link previews |
| `apple-icon.png` | 180×180 | iOS home screen |
| `icon-192/512.png` | 192, 512 | Web manifest |
| `icon-512-maskable.png` | 512×512 | Android adaptive icon, 80% safe zone |

`src/app/favicon.ico` is built separately by `scripts/ico.mts`, which runs as
the second half of `npm run brand`.

Both headers are 3:1. [DEX Screener](https://docs.dexscreener.com) wants 3:1 at
600px wide or more and compresses on their side, so these are exported at 2x.

X overlays the profile picture on the bottom-left of the header, roughly a
200px circle inside `x < 300 / y > 350`. That corner is empty on purpose.
The DEX Screener composition has no such constraint, so it runs a live board
across the right instead.

## Rules

- **One accent.** `#1b3f60` on paper, `#9dc2e0` on ink, and only the estimate
  dots carry it. Everything else is ink on paper.
- **Colour is reserved for the confidence band.** The four severity tones
  appear on band drawings and their numbers, never on a surface.
- **Light by default.** The ink variants exist for dark host UIs, not as a
  theme.
- Source Serif 4 for the wordmark and headings, Inter for prose, JetBrains
  Mono for every figure.

## Two failure modes the renderer now catches

An **XML comment may not contain `--`**. An `<img src="*.svg">` is parsed by
the strict XML parser, so a stray double hyphen does not throw — it silently
yields a broken-image placeholder, at full banner size. The generator refuses
to write one and the renderer fails if any image decodes to nothing.

**Chromium will not encode an RGBA PNG** for a fully opaque image, and Next's
`.ico` decoder rejects any member that is not RGBA — failing the whole build,
not just the icon. So `scripts/ico.mts` uses the browser only to rasterise,
pulls raw pixels back through `getImageData`, and writes the PNG itself with
colour type 6 guaranteed. The SVG goes in as a data URI because an image
fetched over `file://` taints the canvas and `getImageData` then throws.

A **web font that never arrived** renders in a fallback that looks plausible
and is not the brand. The renderer checks each text element at the weight and
size it actually asks for. Checking a bare `16px "Source Serif 4"` tests
weight 400, which this design never uses, and reports a failure that is not
real.
