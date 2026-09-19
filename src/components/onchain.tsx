"use client";

/** Live deployment banner. Renders nothing when no contract is configured. */
export function OnChainPanel() {
  const address = process.env.NEXT_PUBLIC_ORACLE_ADDRESS;
  const chain = process.env.NEXT_PUBLIC_ORACLE_CHAIN;
  const chainId = process.env.NEXT_PUBLIC_ORACLE_CHAIN_ID;
  const rpc = process.env.NEXT_PUBLIC_ORACLE_RPC;

  if (!address) return null;

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-title">Live on-chain</span>
        <span className="tag tag-ok">
          <span className="dot dot-pulse" />
          deployed
        </span>
        <span className="muted small" style={{ marginLeft: "auto" }}>
          quotes posted from this service
        </span>
      </div>
      <div className="panel-body">
        <div className="grid grid-2">
          <div>
            <div className="stat-label">Contract</div>
            <div
              style={{
                fontSize: 12.5,
                wordBreak: "break-all",
                color: "var(--accent-bright)",
              }}
            >
              {address}
            </div>
          </div>
          <div>
            <div className="stat-label">Network</div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              {chain}
              {chainId ? (
                <span className="muted small"> · chainId {chainId}</span>
              ) : null}
            </div>
          </div>
        </div>
        <pre className="code" style={{ marginTop: 12 }}>
          <span className="c"># read the live quote straight from the chain</span>
          {"\n"}cast call {address} \{"\n"}
          {"  "}&quot;getQuote(string)((uint128,uint64,uint8,uint8,uint8,uint64,uint64,uint64))&quot;
          \{"\n"}
          {"  "}&quot;HOOD&quot; --rpc-url {rpc}
          {"\n\n"}
          <span className="c">
            # a liquidation path reverts while the tape is shut
          </span>
          {"\n"}cast call {address} \{"\n"}
          {"  "}&quot;getPriceIfTraded(string,uint64)(uint128)&quot; &quot;HOOD&quot; 50 --rpc-url {rpc}
          {"\n"}
          <span className="c"># → execution reverted: not a live print</span>
        </pre>
      </div>
    </section>
  );
}
