// The relay decision and the stall alarm, offline.
//
// The alarm is replayed against the incident that motivated it: the quote the
// chain actually held from Mon 21 Sep 13:43:39 UTC until Wed 23 Sep 07:41:35,
// a TRADED print from the first minutes of Monday's session that nothing
// replaced for 42 hours.
//
//   npm run test:relay

import { decide, stallProblems, MAX_LIVE_AGE, type StoredQuote } from "../src/lib/relay.ts";
import { Provenance, Session } from "../src/lib/types.ts";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

const at = (iso: string) => new Date(iso);
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

// HOOD as stored on Robinhood Chain after the Monday 13:43:39 UTC batch.
const frozen: StoredQuote = {
  price: 12_253_000_000n,
  confidenceBps: 38n,
  session: Session.REGULAR,
  provenance: Provenance.TRADED,
  publishTime: BigInt(sec("2026-09-21T13:43:39Z")),
};

console.log("\n=== the incident, replayed against the stall alarm ===\n");
{
  const one = (now: string) => stallProblems([{ ticker: "HOOD", quote: frozen }], at(now));

  check("Mon 14:00 UTC, 16 minutes into a live session: fine", one("2026-09-21T14:00:00Z").length === 0);
  const regular = one("2026-09-21T15:00:00Z");
  check(
    "Mon 15:00 UTC, a live print 76 minutes old: stalled",
    regular.length === 1 && /stopped/.test(regular[0]),
    regular[0],
  );
  const shut = one("2026-09-22T01:00:00Z");
  check(
    "Mon 21:00 ET, tape shut, chain still says TRADED: flagged as a live print that cannot exist",
    shut.length === 1 && /TRADED on chain/.test(shut[0]),
    shut[0],
  );
  check(
    "Wed 07:38 UTC, when this was found: flagged",
    one("2026-09-23T07:38:00Z").length === 1,
  );
  // Caught end to end, not by this file: the open's grace period briefly let
  // a 42h-old print through because it was measured from the bell.
  check(
    "Wed 08:02 UTC, two minutes into PRE: a 42h-old print gets no grace from the open",
    one("2026-09-23T08:02:00Z").length === 1,
    one("2026-09-23T08:02:00Z")[0],
  );
  check(
    "a close gets STALL_GRACE before a leftover TRADED print is flagged",
    stallProblems(
      [{ ticker: "HOOD", quote: { ...frozen, publishTime: BigInt(sec("2026-09-22T23:55:00Z")), session: Session.POST } }],
      at("2026-09-23T00:10:00Z"),
    ).length === 0,
  );
}

console.log("\n=== the open does not alarm before the first run ===\n");
{
  // Last weekend heartbeat at 05:10 UTC, PRE opens 08:00 UTC.
  const weekend: StoredQuote = {
    ...frozen,
    session: Session.CLOSED,
    provenance: Provenance.DERIVED,
    confidenceBps: 400n,
    publishTime: BigInt(sec("2026-09-23T05:10:00Z")),
  };
  check(
    "08:01 UTC, 2h51m-old weekend quote, one minute into PRE: fine",
    stallProblems([{ ticker: "HOOD", quote: weekend }], at("2026-09-23T08:01:00Z")).length === 0,
  );
  check(
    "08:40 UTC, still not replaced 40 minutes into PRE: stalled",
    stallProblems([{ ticker: "HOOD", quote: weekend }], at("2026-09-23T08:40:00Z")).length === 1,
  );
  check(
    "a closed-market quote 3h10m old is inside the weekend heartbeat",
    stallProblems([{ ticker: "HOOD", quote: weekend }], at("2026-09-23T07:59:00Z")).length === 0,
  );
  check(
    "a never-posted ticker is reported",
    stallProblems([{ ticker: "HOOD", quote: null }], at("2026-09-23T07:59:00Z")).length === 1,
  );
}

console.log("\n=== what the relayer posts ===\n");
{
  // Six minutes after the stored quote, inside the live heartbeat.
  const now = sec("2026-09-21T13:50:00Z");
  const fresh = {
    price: 122.53,
    confidenceBps: 38,
    session: Session.REGULAR,
    provenance: Provenance.TRADED,
    publishTime: now,
  };

  check("an unchanged live quote inside the heartbeat is skipped", !decide(fresh, frozen, now).post);
  check(
    `a live quote older than MAX_LIVE_AGE (${MAX_LIVE_AGE}s) is refreshed even if unchanged`,
    decide({ ...fresh, publishTime: now + MAX_LIVE_AGE }, frozen, now + MAX_LIVE_AGE).post,
  );

  const closing = decide(
    { ...fresh, provenance: Provenance.DERIVED, session: Session.CLOSED, confidenceBps: 45 },
    frozen,
    now,
  );
  check(
    "TRADED -> DERIVED is posted even when price and band barely moved",
    closing.post && /provenance/.test(closing.reason),
    closing.reason,
  );
  const sessionOnly = decide({ ...fresh, session: Session.POST }, frozen, now);
  check(
    "a session change alone is posted",
    sessionOnly.post && /session/.test(sessionOnly.reason),
    sessionOnly.reason,
  );
  check("an 11bps move is posted", decide({ ...fresh, price: 122.53 * 1.0011 }, frozen, now).post);
  check("a 15bps band move is posted", decide({ ...fresh, confidenceBps: 53 }, frozen, now).post);
  check(
    "a quote not newer than the stored one is never posted",
    !decide({ ...fresh, publishTime: Number(frozen.publishTime) }, frozen, now).post,
  );
  check("the first quote for a ticker is posted", decide(fresh, null, now).post);

  const weekendNow = sec("2026-09-19T12:00:00Z");
  const weekend = { ...frozen, session: Session.CLOSED, provenance: Provenance.DERIVED, confidenceBps: 400n, publishTime: BigInt(weekendNow - 3600) };
  check(
    "a quiet weekend quote an hour old is left alone",
    !decide({ price: 122.53, confidenceBps: 405, session: Session.CLOSED, provenance: Provenance.DERIVED, publishTime: weekendNow }, weekend, weekendNow).post,
  );
}

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed) process.exit(1);
