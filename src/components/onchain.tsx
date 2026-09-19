"use client";

import { Tag } from "./ui";

/** Live deployment panel. Renders nothing when no contract is configured. */
export function OnChainPanel() {
  const address = process.env.NEXT_PUBLIC_ORACLE_ADDRESS;
  const chain = process.env.NEXT_PUBLIC_ORACLE_CHAIN;
  const chainId = process.env.NEXT_PUBLIC_ORACLE_CHAIN_ID;
  const rpc = process.env.NEXT_PUBLIC_ORACLE_RPC;

  if (!address) return null;

  return (
    <section>
      <div className="sec-head">
        <h2 className="d2">Live on-chain</h2>
        <span className="sec-rule" />
        <span className="sec-note">
          <Tag live box>
            deployed
          </Tag>
        </span>
      </div>

      <div className="grid g2">
        <div className="card">
          <div className="card-title">Contract</div>
          <div
            className="mono"
            style={{
              fontSize: 13,
              wordBreak: "break-all",
              lineHeight: 1.6,
              color: "var(--ink)",
            }}
          >
            {address}
          </div>
          <div className="stat-s">
            {chain}
            {chainId ? ` · chainId ${chainId}` : ""}
          </div>
        </div>

        <div className="card">
          <div className="card-title">Verify it yourself</div>
          <pre style={{ margin: 0, fontSize: 11.5, border: "none", padding: 0, background: "none" }}>
            <span className="c"># a liquidation path, tape shut</span>
            {"\n"}cast call {address.slice(0, 10)}… \{"\n"}
            {"  "}&quot;getPriceIfTraded(string,uint64)&quot; \{"\n"}
            {"  "}&quot;HOOD&quot; 50 --rpc-url {rpc ? new URL(rpc).host : ""}
            {"\n"}
            <span className="g">→ reverted: not a live print</span>
          </pre>
        </div>
      </div>
    </section>
  );
}
