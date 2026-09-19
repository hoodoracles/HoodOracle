// Brand asset renderer.
//
// Chromium is the rasteriser. It is already a dependency for the browser
// tests, it honours the same CSS and web fonts the product uses, and it makes
// the exported PNG provably the same rendering the site would produce -- which
// a separate design file never can.
//
//   npm run brand            render every target
//   npm run brand -- variants  render one

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/* ───────────────────────────────────────────────────────── the mark ──
 * Generated, never hand-edited. Five files have to stay in lockstep
 * (paper, ink, single-colour, and two favicon reductions) and editing
 * them individually is how one of them ends up truncated or out of step.
 *
 * Note the comment text: an XML comment may not contain a double hyphen.
 * An <img src="*.svg"> is parsed by the strict XML parser, so a stray "--"
 * does not throw, it just yields a broken image at full banner size.
 */

const MARK_NOTE = `  <!-- Two confidence intervals sharing one estimate axis: same price, two
       different degrees of certainty about it. That pairing is what this
       oracle publishes and the others do not. The spine is load bearing;
       without it the two intervals read as unrelated objects. -->`;

const SIMPLE_NOTE = `  <!-- Favicon scale reduction: one interval. Two bars and a spine turn to
       mush below about 24px, so small sizes keep the idea and drop the pair. -->`;

function open_(label: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100" role="img" aria-label="${label}">\n  <title>${label}</title>\n`;
}

/** The pair: a wide interval and a tight one, crossed by the estimate axis. */
function markSvg(ink: string, accent: string, spineOpacity: string): string {
  const rows: [number, number][] = [
    [34, 40],
    [66, 23],
  ];
  // Stroke weights are set to sit optically level with Source Serif 600 at
  // the lockup size. Lighter than this and the mark looks like a diagram
  // pasted next to the wordmark rather than part of it.
  const parts = [
    `  <rect x="48.5" y="23" width="3" height="54" rx="1.5" fill="${ink}" opacity="${spineOpacity}"/>`,
  ];
  for (const [cy, half] of rows) {
    const x0 = 50 - half;
    const w = half * 2;
    parts.push(
      `  <rect x="${x0}" y="${cy - 3}" width="${w}" height="6" rx="3" fill="${ink}"/>`,
      `  <rect x="${x0}" y="${cy - 11}" width="6" height="22" rx="3" fill="${ink}"/>`,
      `  <rect x="${x0 + w - 6}" y="${cy - 11}" width="6" height="22" rx="3" fill="${ink}"/>`,
    );
  }
  for (const [cy] of rows) {
    parts.push(`  <circle cx="50" cy="${cy}" r="7" fill="${accent}"/>`);
  }
  return open_("hoodoracle") + MARK_NOTE + "\n" + parts.join("\n") + "\n</svg>\n";
}

function simpleSvg(ink: string, accent: string): string {
  return (
    open_("hoodoracle") +
    SIMPLE_NOTE +
    `\n  <g fill="${ink}">
    <rect x="12" y="47" width="76" height="6" rx="3"/>
    <rect x="12" y="35" width="6" height="30" rx="3"/>
    <rect x="82" y="35" width="6" height="30" rx="3"/>
  </g>
  <circle cx="50" cy="50" r="10.5" fill="${accent}"/>
</svg>\n`
  );
}

const INK = "#16161a";
const ACCENT = "#1b3f60";
const PAPER = "#fbfaf8";
const ACCENT_ON_INK = "#9dc2e0";

function writeMarks(): void {
  const files: Record<string, string> = {
    "brand/mark.svg": markSvg(INK, ACCENT, ".38"),
    "brand/mark-ink.svg": markSvg(PAPER, ACCENT_ON_INK, ".42"),
    "brand/mark-mono.svg": markSvg(INK, INK, ".38"),
    "brand/mark-simple.svg": simpleSvg(INK, ACCENT),
    "brand/mark-simple-ink.svg": simpleSvg(PAPER, ACCENT_ON_INK),
  };
  for (const [path, body] of Object.entries(files)) {
    if (body.includes("--", body.indexOf("<!--") + 4)) {
      const afterOpen = body.slice(body.indexOf("<!--") + 4);
      if (afterOpen.slice(0, afterOpen.indexOf("-->")).includes("--")) {
        throw new Error(`${path}: XML comment contains a double hyphen`);
      }
    }
    writeFileSync(path, body);
  }
  console.log(`wrote ${Object.keys(files).length} mark files`);
}

interface Target {
  /** html file in brand/, without extension */
  page: string;
  out: string;
  width: number;
  height: number;
  /** 2 gives a retina-grade export; DEX Screener compresses on their side. */
  scale?: number;
}

const TARGETS: Target[] = [
  { page: "twitter-header", out: "twitter-header", width: 1500, height: 500 },
  { page: "dex-header", out: "dexscreener-header", width: 1500, height: 500 },
  {
    page: "dex-header-ink",
    out: "dexscreener-header-ink",
    width: 1500,
    height: 500,
  },
  { page: "avatar", out: "avatar", width: 400, height: 400, scale: 2 },
  { page: "avatar-ink", out: "avatar-ink", width: 400, height: 400, scale: 2 },
  { page: "apple-icon", out: "apple-icon", width: 180, height: 180, scale: 1 },
  { page: "og", out: "og-image", width: 1200, height: 630 },
  // 1x proof copy, small enough to eyeball without downscaling
  { page: "og", out: "og-preview", width: 1200, height: 630, scale: 1 },
];

const only = process.argv[2];
const targets = only ? TARGETS.filter((t) => t.page === only) : TARGETS;
if (targets.length === 0) {
  console.error(`no target named "${only}"`);
  process.exit(1);
}

const OUT = "brand/exports";
mkdirSync(OUT, { recursive: true });
writeMarks();

const browser = await chromium.launch();
let failures = 0;

for (const t of targets) {
  const scale = t.scale ?? 2;
  const page = await browser.newPage({
    viewport: { width: t.width, height: t.height },
    deviceScaleFactor: scale,
  });

  // A subresource that fails to load does not stop the render, it just leaves
  // a hole. That is how a broken-image placeholder where the logo should be
  // gets exported at 3000x1000 and posted. Collect them and refuse to claim
  // success.
  const broken: string[] = [];
  page.on("requestfailed", (r) => broken.push(`${r.url()} (${r.failure()?.errorText})`));
  page.on("response", (r) => {
    if (r.status() >= 400) broken.push(`${r.url()} (HTTP ${r.status()})`);
  });

  const url = "file://" + resolve(`brand/${t.page}.html`);
  await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });

  // Web fonts load asynchronously. Screenshotting before they resolve exports
  // the fallback face, which is the single easiest way to ship a wrong logo.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);

  // An <img> pointing at malformed SVG loads "successfully" and then decodes
  // to nothing, so the network is not enough: ask the document.
  const emptyImages = await page.evaluate(() =>
    [...document.images]
      .filter((i) => !i.complete || i.naturalWidth === 0)
      .map((i) => i.getAttribute("src") ?? "(inline)"),
  );

  // Two things a screenshot hides. A web font that never arrived renders in
  // a fallback that looks plausible but is not the brand; and an element
  // wider than the canvas is silently cropped at the edge.
  const typeAndFit = await page.evaluate(() => {
    // Check the faces actually in use, at the weight and size each element
    // asks for. A bare `check('16px "Source Serif 4"')` tests weight 400,
    // which this design never uses, and reports a fallback that is not real.
    const missing: string[] = [];
    const seen = new Set<string>();
    document.querySelectorAll<HTMLElement>(".canvas *").forEach((el) => {
      if (!el.textContent?.trim()) return;
      const cs = getComputedStyle(el);
      const family = cs.fontFamily.split(",")[0].replace(/["']/g, "").trim();
      if (!family || family.startsWith("-apple")) return;
      const spec = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} "${family}"`;
      if (seen.has(spec)) return;
      seen.add(spec);
      if (!document.fonts.check(spec, el.textContent)) missing.push(spec);
    });
    const canvas = document.querySelector(".canvas") as HTMLElement | null;
    const w = canvas?.clientWidth ?? 0;
    const h = canvas?.clientHeight ?? 0;
    const spills: string[] = [];
    document.querySelectorAll<HTMLElement>(".canvas *").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      if (r.right > w + 1 || r.left < -1 || r.bottom > h + 1 || r.top < -1) {
        spills.push(
          `${el.tagName.toLowerCase()}.${el.className || "-"}`.slice(0, 44),
        );
      }
    });
    return { missing, spills: [...new Set(spills)].slice(0, 6) };
  });

  const path = `${OUT}/${t.out}.png`;
  await page.screenshot({ path, scale: "device" });

  const problems = [
    ...broken,
    ...emptyImages.map((s) => `${s} (decoded to nothing)`),
    ...typeAndFit.missing.map((f) => `${f} fell back to a system face`),
    ...typeAndFit.spills.map((s) => `${s} overflows the canvas`),
  ];
  if (problems.length) {
    failures++;
    console.log(`FAIL  ${path}`);
    for (const p of problems) console.log(`        ! ${p}`);
  } else {
    console.log(
      `ok    ${path.padEnd(42)} ${t.width}x${t.height} @${scale}x = ${t.width * scale}x${t.height * scale}`,
    );
  }
  await page.close();
}

await browser.close();

if (failures) {
  console.log(`\n${failures} target(s) rendered with missing artwork`);
  process.exit(1);
}
