/**
 * Who last called the relayer endpoint, and what happened.
 *
 * Setting up a scheduler has two failure modes that look identical from the
 * outside: the scheduler never fires, or it fires and is rejected. Both leave
 * the chain unchanged, and the operator cannot tell which without reading
 * platform logs they may not have.
 *
 * This records the last call so /api/health can say which it was.
 *
 * Deliberately in memory. Serverless instances are recycled, so this is
 * best-effort: an empty record means "no call reached *this* instance", never
 * "no call happened". It is a diagnostic, not an audit log — for an audit log
 * the transactions themselves are on chain.
 */

export type CallOutcome =
  | "unauthorised"
  | "not-configured"
  | "dry-run"
  | "published";

export interface LastCall {
  at: string;
  outcome: CallOutcome;
  /** Trimmed: enough to recognise a scheduler, not enough to be a fingerprint. */
  userAgent: string | null;
  posted?: number;
  skipped?: number;
  failed?: number;
}

let last: LastCall | null = null;

export function recordCall(call: LastCall): void {
  last = call;
}

export function lastCall(): LastCall | null {
  return last;
}

export function callerAgent(req: Request): string | null {
  const ua = req.headers.get("user-agent");
  return ua ? ua.slice(0, 80) : null;
}
