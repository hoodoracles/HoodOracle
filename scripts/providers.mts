import { ALL_PROVIDERS, enabledProviders, fetchConsensus } from "../src/lib/providers/index.ts";
import { fetchProxies, blendedMoveSince, moveSince, recentVolatility } from "../src/lib/providers/proxy.ts";
import { buildQuotes } from "../src/lib/quote.ts";
import { UNIVERSE } from "../src/lib/universe.ts";
import { PROVENANCE_NAME } from "../src/lib/types.ts";

console.log("=== provider registry ===");
for (const p of ALL_PROVIDERS) {
  console.log(`  ${p.enabled ? "ON " : "off"}  ${p.key.padEnd(11)} ${p.terms.padEnd(16)} tradeTime=${String(p.reportsTradeTime).padEnd(5)} ${p.disabledReason ?? ""}`);
}
console.log(`  -> ${enabledProviders().length} enabled\n`);

console.log("=== consensus (HOOD) ===");
const c = await fetchConsensus("HOOD");
for (const r of c.readings) console.log(`  ${r.source.padEnd(11)} $${r.price.toFixed(4).padStart(10)}  lastTrade=${r.lastTradeTime ?? "none"}`);
for (const f of c.failures) console.log(`  FAIL ${f.source}: ${f.error.slice(0,70)}`);
console.log(`  median      $${c.price.toFixed(4)}`);
console.log(`  deviation   ${c.maxDeviationBps.toFixed(2)} bps`);
console.log(`  sourceCount ${c.sourceCount}`);
console.log(`  lastTrade   ${c.lastTradeTime ? new Date(c.lastTradeTime*1000).toISOString() : "none (calendar fallback)"}\n`);

console.log("=== proxies (hourly series, no key) ===");
const px = await fetchProxies();
const since = c.lastTradeTime ?? Math.floor(Date.now()/1000) - 3600;
for (const p of px) console.log(`  ${p.key}  $${p.latest.toFixed(2).padStart(10)}  ${p.points.length} hourly pts  move-since-gap ${(moveSince(p, since)*100).toFixed(3)}%`);
console.log(`  blended over gap  ${(blendedMoveSince(px, since)*100).toFixed(3)}%`);
console.log(`  realised vol 24h  ${(recentVolatility(px,24)*100).toFixed(2)}%\n`);

console.log("=== full board ===");
const { quotes, errors } = await buildQuotes(UNIVERSE);
for (const q of quotes) {
  console.log(`  ${q.ticker.padEnd(5)} $${q.price.toFixed(2).padStart(9)}  ±${(q.confidenceBps/100).toFixed(2)}%  ${PROVENANCE_NAME[q.provenance].padEnd(8)} src=${q.sourceCount} dev=${q.maxDeviationBps.toFixed(1)}bps`);
}
for (const e of errors) console.log(`  ERR ${e.ticker}: ${e.error.slice(0,90)}`);
