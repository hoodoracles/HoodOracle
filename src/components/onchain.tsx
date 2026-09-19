"use client";

import { Glyph, Tag } from "./ui";

/** Live deployment panel. Renders nothing when no contract is configured. */
export function OnChainPanel() {
  const address = process.env.NEXT_PUBLIC_ORACLE_ADDRESS;
  const chain = process.env.NEXT_PUBLIC_ORACLE_CHAIN;
  const chainId = process.env.NEXT_PUBLIC_ORACLE_CHAIN_ID;
  const rpc = process.env.NEXT_PUBLIC_ORACLE_RPC;

  if (!address) return null;

  return (
    <section>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 14,
          flexWrap: "wrap",
          marginBottom: 18,
        }}
      >
        <h2 className="d2">Live on-chain</h2>
        <Tag live onDark>
          deployed
        </Tag>
      </div>

      <div className="grid g2">
        <div className="card fill-mint">
          <Glyph kind="bolt" />
          <div className="stat-k">Contract</div>
          <div
            style={{
              fontSize: 13,
              wordBreak: "break-all",
              fontWeight: 600,
              lineHeight: 1.5,
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
          <div className="stat-k">Verify it yourself</div>
          <pre style={{ margin: 0, fontSize: 11 }}>
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
