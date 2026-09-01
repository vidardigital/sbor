/**
 * SBOR fixing pipeline.
 * Pulls Stacks lending markets from DefiLlama, computes the depth-weighted
 * fixing per currency, and writes api/latest.json, latest.txt, api/history.json.
 * No API key required.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const POOLS  = "https://yields.llama.fi/pools";
/* DefiLlama has used both paths for the lend/borrow dataset. Try in order. */
const BORROW_URLS = [
  "https://yields.llama.fi/lendBorrow",
  "https://yields.llama.fi/poolsBorrow"
];

/* Which asset symbols belong to which currency index.
   Symbols are upper-cased before matching. */
const CURRENCY = {
  "USD": ["USDCX", "USDH", "USDC", "USDT", "AEUSDC"],
  "BTC": ["SBTC", "WBTC", "XBTC"],
  "STX": ["STX", "STSTX"]
};

/* Assets that are collateral only and have no meaningful borrow market.
   They are excluded from the fixing but still reported. */
const COLLATERAL_ONLY = ["STSTXBTC"];

const META = {
  USD: { label:"SBOR-USD", currency:"USD",
         headline:"The dollar cost of money on Stacks, published every block." },
  BTC: { label:"SBOR-BTC", currency:"BTC",
         headline:"The cost of borrowing bitcoin against Bitcoin-secured collateral." },
  STX: { label:"SBOR-STX", currency:"STX",
         headline:"The cost of money in STX, the chain's own collateral asset." }
};

const YIELD_SOURCE = {
  SBTC:  "Bitcoin protocol yield via dual stacking, paid on enrolment",
  STSTX: "PoX staking yield on the underlying, managed by StackingDAO"
};

const round = (n, d = 2) => Number(n.toFixed(d));
const aprToApy = apr => (Math.pow(1 + apr / 100 / 365, 365) - 1) * 100;

async function getJson(url) {
  const r = await fetch(url, { headers: { "accept": "application/json" } });
  if (!r.ok) throw new Error(`${url} responded ${r.status}`);
  return r.json();
}

function currencyOf(symbol) {
  const s = symbol.toUpperCase();
  if (COLLATERAL_ONLY.includes(s)) return null;
  for (const [cur, syms] of Object.entries(CURRENCY)) if (syms.includes(s)) return cur;
  return null;
}

const main = async () => {
  const poolsRes = await getJson(POOLS);

  let borrowRes = null, borrowUrl = null;
  for (const url of BORROW_URLS) {
    try { borrowRes = await getJson(url); borrowUrl = url; break; }
    catch (e) { console.error(`borrow source ${url} unavailable: ${e.message}`); }
  }
  if (!borrowRes) throw new Error("No borrow dataset available from any known endpoint.");
  console.error(`borrow source: ${borrowUrl}`);

  const stacks = (poolsRes.data || []).filter(p => p.chain === "Stacks");
  if (!stacks.length) throw new Error("No Stacks pools returned. Aborting rather than writing an empty fixing.");

  /* index borrow data by pool id */
  const borrowList = Array.isArray(borrowRes) ? borrowRes : (borrowRes.data || []);
  const borrowBy = Object.fromEntries(borrowList.map(b => [b.pool, b]));

  const buckets = {};
  for (const p of stacks) {
    const cur = currencyOf(p.symbol);
    if (!cur) continue;

    const b = borrowBy[p.pool] || {};
    /* DefiLlama reports apyBaseBorrow as an APR. Convert to APY. */
    const borrowApr = b.apyBaseBorrow ?? null;
    if (borrowApr == null) continue;              // no borrow side, not a lending market

    const supply    = p.apyBase ?? 0;             // base lending yield only
    const protocol  = p.apyReward ?? 0;           // yield carried by the asset, excluded
    const depth     = p.tvlUsd ?? 0;
    if (depth <= 0) continue;

    (buckets[cur] ||= []).push({
      venue: p.project,
      asset: p.symbol,
      pool: p.pool,
      borrow: round(aprToApy(borrowApr)),
      supply: round(supply),
      protocolYield: round(protocol),
      ...(YIELD_SOURCE[p.symbol.toUpperCase()] && { protocolYieldSource: YIELD_SOURCE[p.symbol.toUpperCase()] }),
      depthUsd: Math.round(depth),
      phaseIn: 1
    });
  }

  const indices = {};
  for (const [cur, markets] of Object.entries(buckets)) {
    markets.sort((a, b) => b.depthUsd - a.depthUsd);
    const total = markets.reduce((a, m) => a + m.depthUsd * m.phaseIn, 0);
    markets.forEach(m => { m.weight = round(m.depthUsd * m.phaseIn / total, 4); });
    indices[META[cur].label] = {
      ...META[cur],
      borrow: round(markets.reduce((a, m) => a + m.borrow * m.weight, 0)),
      supply: round(markets.reduce((a, m) => a + m.supply * m.weight, 0)),
      markets
    };
  }
  if (!Object.keys(indices).length) throw new Error("No index could be computed. Aborting.");

  const now = new Date();
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const day = stamp.slice(0, 10);

  const latest = {
    name: "SBOR",
    description: "Stacks Bitcoin Offered Rate. Benchmark lending rate for Stacks. Public good, free to reference.",
    url: "https://sbor.xyz",
    bns: ["sbor.btc", "sbor.stx"],
    fixing: stamp,
    basis: "APY, annually compounded",
    method: "https://sbor.xyz/llms.txt",
    source: "DefiLlama yields (chain: Stacks)",
    indices,
    notes: [
      "Protocol yield belongs to the asset, not the loan, and is excluded from every fixing.",
      "Currencies are never blended into a single figure.",
      "Borrow rates are published by venues as APR and converted to APY here."
    ]
  };

  mkdirSync("api", { recursive: true });
  writeFileSync("api/latest.json", JSON.stringify(latest, null, 2) + "\n");

  /* plain text */
  const lines = [
    `SBOR fixing ${stamp}`,
    `currency  borrow%  supply%`,
    ...Object.entries(indices).map(([k, v]) =>
      `${k.padEnd(9)} ${String(v.borrow).padEnd(8)} ${v.supply}`),
    `basis=APY source=https://sbor.xyz/api/latest.json`
  ];
  writeFileSync("latest.txt", lines.join("\n") + "\n");

  /* history: one row per day, last write for that day wins */
  let history = [];
  try { history = JSON.parse(readFileSync("api/history.json", "utf8")); } catch {}
  history = history.filter(r => r.date !== day);
  history.push({
    date: day,
    ...Object.fromEntries(Object.entries(indices).map(([k, v]) =>
      [k, { borrow: v.borrow, supply: v.supply }]))
  });
  history.sort((a, b) => a.date.localeCompare(b.date));
  writeFileSync("api/history.json", JSON.stringify(history, null, 2) + "\n");

  console.log(lines.join("\n"));
  console.log(`history rows: ${history.length}`);
};

main().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
