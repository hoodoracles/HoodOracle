import "./env.mts";

import { buildQuote, buildQuotes } from "../src/lib/quote.ts";
import { findInstrument, UNIVERSE } from "../src/lib/universe.ts";
import { SESSION_NAME, PROVENANCE_NAME } from "../src/lib/types.ts";
import { describeGap } from "../src/lib/session.ts";
import { fetchProxies } from "../src/lib/providers/proxy.ts";

const hood = findInstrument("HOOD")!;
const proxies = await fetchProxies();

console.log("=== HOOD confidence across the weekend dark window ===");
console.log("    (real DIA anchor, simulated clock)\n");
console.log("  ET time              session   prov      price      band      gap");
console.log("  " + "-".repeat(74));

// Friday 15:00 ET through Monday 10:00 ET
const start = Date.parse("2026-09-18T19:00:00Z"); // Fri 15:00 ET
const marks = [0, 1, 5, 5.5, 8, 12, 24, 36, 48, 56, 60, 62, 63, 66, 70];
for (const h of marks) {
  const at = new Date(start + h * 3600_000);
  const { quote: q } = await buildQuote(hood, { now: at, proxies });
  const et = at.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  console.log(
    `  ${et.padEnd(20)} ${SESSION_NAME[q.session].padEnd(9)} ${PROVENANCE_NAME[q.provenance].padEnd(9)} $${q.price.toFixed(2).padStart(8)}  ±${(q.confidenceBps/100).toFixed(2).padStart(5)}%  ${describeGap(q.stalenessSeconds)}`
  );
}

console.log("\n=== batch consistency (single proxy snapshot) ===");
const t0 = Date.now();
const { quotes, errors } = await buildQuotes(UNIVERSE);
console.log(`  ${quotes.length} quotes, ${errors.length} errors, ${Date.now()-t0}ms`);
for (const q of quotes) {
  console.log(`  ${q.ticker.padEnd(5)} $${q.price.toFixed(2).padStart(9)}  ±${(q.confidenceBps/100).toFixed(2)}%  ${PROVENANCE_NAME[q.provenance].padEnd(8)} drift=${q.driftBps.toFixed(1)}bps`);
}
for (const e of errors) console.log(`  ERR ${e.ticker}: ${e.error}`);
const t1 = Date.now();
await buildQuotes(UNIVERSE);
console.log(`  cached re-run: ${Date.now()-t1}ms`);
