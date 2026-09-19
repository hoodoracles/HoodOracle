import { classifySession, etClock, nextSessionChange, lastTradableInstant, describeGap } from "../src/lib/session";
import { SESSION_NAME } from "../src/lib/types";
import { UNIVERSE, findInstrument } from "../src/lib/universe";
import { buildQuote } from "../src/lib/quote.ts";
import { signQuote, verifySignedQuote, signerAddress } from "../src/lib/sign";

function line(s = "") { console.log(s); }

// --- session classifier over known instants -------------------------------
const cases: [string, string][] = [
  ["2026-09-18T13:45:00Z", "Fri 09:45 ET -> REGULAR"],
  ["2026-09-18T19:59:00Z", "Fri 15:59 ET -> REGULAR"],
  ["2026-09-18T20:30:00Z", "Fri 16:30 ET -> POST"],
  ["2026-09-19T00:30:00Z", "Fri 20:30 ET -> CLOSED"],
  ["2026-09-19T18:00:00Z", "Sat 14:00 ET -> CLOSED"],
  ["2026-09-21T12:00:00Z", "Mon 08:00 ET -> PRE"],
  ["2026-09-07T15:00:00Z", "Labor Day     -> HOLIDAY"],
  ["2026-11-26T15:00:00Z", "Thanksgiving  -> HOLIDAY"],
  ["2026-11-27T18:30:00Z", "Early close 13:30 ET -> POST"],
];
line("=== session classifier ===");
let pass = 0;
for (const [iso, label] of cases) {
  const d = new Date(iso);
  const s = classifySession(d);
  const c = etClock(d);
  const expected = label.split("-> ")[1].trim();
  const ok = SESSION_NAME[s] === expected;
  if (ok) pass++;
  line(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(26)} got=${SESSION_NAME[s].padEnd(8)} et=${c.date} ${String(c.hh).padStart(2,"0")}:${String(c.mm).padStart(2,"0")}`);
}
line(`  ${pass}/${cases.length} passed`);
line();

// --- calendar reconciliation ---------------------------------------------
line("=== timestamp reconciliation ===");
const sat = new Date("2026-09-19T18:00:00Z");
const ceiling = lastTradableInstant(sat);
line(`  now (Sat 14:00 ET):        ${sat.toISOString()}`);
line(`  last tradable instant:     ${ceiling.toISOString()}`);
line(`  gap:                       ${describeGap((sat.getTime()-ceiling.getTime())/1000)}`);
const nx = nextSessionChange(sat);
line(`  next session:              ${SESSION_NAME[nx.nextSession]} in ${describeGap(nx.inSeconds)}`);
line();

// --- live quote ------------------------------------------------------------
line("=== live quotes (real provider calls) ===");
line(`  signer: ${signerAddress()}`);
for (const inst of UNIVERSE.slice(0, 4)) {
  try {
    const { quote } = await buildQuote(inst);
    const signed = await signQuote(quote);
    const ok = await verifySignedQuote(signed);
    line(`  ${quote.ticker.padEnd(5)} $${quote.price.toFixed(2).padStart(9)}  anchor=$${quote.anchorPrice.toFixed(2).padStart(9)}  ±${(quote.confidenceBps/100).toFixed(2)}%  ${SESSION_NAME[quote.session]}/${["TRADED","DERIVED","STALE"][quote.provenance]}  stale=${describeGap(quote.stalenessSeconds)}  drift=${quote.driftBps.toFixed(1)}bps  sig=${ok?"ok":"BAD"}`);
    line(`        ${quote.method}`);
  } catch (e) {
    line(`  ${inst.ticker.padEnd(5)} ERROR ${(e as Error).message}`);
  }
}
line();
line("=== guard: unsupported ticker ===");
// GLD is a real Yahoo symbol, so use one that genuinely does not exist.
try {
  const bogus = { ...UNIVERSE[0], ticker: "ZZZZNOTREAL" } as any;
  await buildQuote(bogus);
  line("  FAIL: a bogus symbol was accepted");
} catch (e) {
  line(`  PASS: rejected -> ${(e as Error).message.slice(0, 110)}`);
}
