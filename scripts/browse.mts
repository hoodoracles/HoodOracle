// Browser harness.
//
// Drives the real app in Chromium, captures console errors, failed requests
// and screenshots, and asserts that the pieces that carry meaning actually
// rendered. Run against a live dev server.

import { chromium, type ConsoleMessage } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = "screenshots";
mkdirSync(OUT, { recursive: true });

interface Check {
  path: string;
  name: string;
  /** Text that must appear on the page. */
  expect: string[];
  /** Optional wait for a selector before asserting. */
  waitFor?: string;
  full?: boolean;
}

const CHECKS: Check[] = [
  {
    path: "/",
    name: "dashboard",
    expect: ["hoodoracle", "HOOD", "DERIVED", "error bar", "coverage"],
    // Wait for a real ticker row, not the loading placeholder.
    waitFor: ".board tbody .row-link",
    full: true,
  },
  { path: "/why", name: "why", expect: ["dark", "session"], full: true },
  { path: "/docs", name: "docs", expect: ["provenance", "confidence"], full: true },
  {
    path: "/playground",
    name: "playground",
    expect: ["HOOD", "confidenceBps"],
    waitFor: ".stat-n",
    full: true,
  },
  { path: "/integrate", name: "integrate", expect: ["Solidity"], full: true },
  {
    path: "/feed/HOOD",
    name: "feed-hood",
    expect: ["HOOD", "Robinhood", "Published price"],
    waitFor: ".stat-n",
    full: true,
  },
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });

let failures = 0;
const consoleErrors: string[] = [];
const netErrors: string[] = [];

for (const check of CHECKS) {
  const page = await ctx.newPage();
  const pageErrors: string[] = [];

  page.on("console", (m: ConsoleMessage) => {
    if (m.type() === "error") {
      const t = m.text();
      // Next dev overlay noise and favicon 404s are not product faults.
      if (/favicon|Download the React DevTools/i.test(t)) return;
      pageErrors.push(t);
    }
  });
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => {
    const u = r.url();
    if (/favicon/.test(u)) return;
    netErrors.push(`${check.path} -> ${u} (${r.failure()?.errorText})`);
  });

  let status = 0;
  try {
    const res = await page.goto(BASE + check.path, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    status = res?.status() ?? 0;

    if (check.waitFor) {
      await page.waitForSelector(check.waitFor, { timeout: 25_000 });
    }
    await page.waitForTimeout(1600);

    const body = (await page.textContent("body")) ?? "";
    const missing = check.expect.filter(
      (t) => !body.toLowerCase().includes(t.toLowerCase()),
    );

    await page.screenshot({
      path: `${OUT}/${check.name}.png`,
      fullPage: check.full ?? false,
    });

    const ok = status === 200 && missing.length === 0 && pageErrors.length === 0;
    if (!ok) failures++;

    console.log(
      `${ok ? "PASS" : "FAIL"}  ${check.path.padEnd(14)} status=${status}` +
        (missing.length ? `  missing=${JSON.stringify(missing)}` : "") +
        (pageErrors.length ? `  consoleErrors=${pageErrors.length}` : ""),
    );
    for (const e of pageErrors.slice(0, 4)) {
      console.log(`        ! ${e.slice(0, 180)}`);
      consoleErrors.push(`${check.path}: ${e}`);
    }
  } catch (e) {
    failures++;
    console.log(
      `FAIL  ${check.path.padEnd(14)} ${(e as Error).message.split("\n")[0]}`,
    );
  } finally {
    await page.close();
  }
}

// mobile pass on the dashboard
const m = await ctx.newPage();
await m.setViewportSize({ width: 390, height: 844 });
try {
  await m.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await m.waitForTimeout(1500);
  const scrollW = await m.evaluate(() => document.documentElement.scrollWidth);
  const clientW = await m.evaluate(() => document.documentElement.clientWidth);
  await m.screenshot({ path: `${OUT}/mobile.png`, fullPage: true });
  const overflow = scrollW > clientW + 1;
  if (overflow) failures++;
  console.log(
    `${overflow ? "FAIL" : "PASS"}  mobile 390px  scrollW=${scrollW} clientW=${clientW}`,
  );
} catch (e) {
  failures++;
  console.log(`FAIL  mobile  ${(e as Error).message.split("\n")[0]}`);
}
await m.close();

if (netErrors.length) {
  console.log("\nfailed requests:");
  for (const n of netErrors.slice(0, 10)) console.log("  " + n);
}

await browser.close();
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
