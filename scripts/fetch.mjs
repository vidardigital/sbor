/**
 * SBOR fixing pipeline.
 * Pulls Stacks lending markets from DefiLlama, computes the depth-weighted
 * fixing per currency, and writes api/latest.json, latest.txt, api/history.json.
 * No API key required.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const POOLS = "https://yields.llama.fi/pools";
const BORROW_URLS = [
  "https://yields.llama.fi/lendBorrow",
  "https://yields.llama.fi/poolsBorrow"
];

const CURRENCY = {
  "USD": ["USDCX", "USDH", "USDC", "USDT", "AEUSDC"],
  "BTC": ["SBTC", "WBTC", "XBTC"],
  "STX": ["STX", "STSTX"]
};
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
const log = (...a) => console.error(...a);

async function getJson(url){
  const r = await fetch(url, { headers:{ accept:"application/json" } });
  if(!r.ok) throw new Error(`${url} responded ${r.status}`);
  return r.json();
}

function currencyOf(symbol){
  const s = String(symbol).toUpperCase();
  if (COLLATERAL_ONLY.includes(s)) return null;
  for (const [cur, syms] of Object.entries(CURRENCY)) if (syms.includes(s)) return cur;
  return null;
}

/* Pull a borrow APR out of whatever shape the record has. */
function borrowAprOf(rec){
  if (!rec) return null;
  for (const k of ["apyBaseBorrow","apyBorrow","borrowApy","apyBaseBorrowUsd"]){
    if (typeof rec[k] === "number") return rec[k];
  }
  return null;
}

const main = async () => {
  const poolsRes = await getJson(POOLS);
  const stacks = (poolsRes.data || []).filter(p => p.chain === "Stacks");
  log(`Stacks pools found: ${stacks.length}`);
  if (!stacks.length) throw new Error("No Stacks pools returned. Aborting rather than writing an empty fixing.");
  for (const p of stacks){
    log(`  ${p.project} ${p.symbol} tvl=${Math.round(p.tvlUsd||0)} apyBase=${p.apyBase} apyReward=${p.apyReward} pool=${p.pool}`);
  }

  let borrowRes = null, borrowUrl = null;
  for (const url of BORROW_URLS){
    try { borrowRes = await getJson(url); borrowUrl = url; break; }
    catch(e){ log(`borrow source ${url} unavailable: ${e.message}`); }
  }
  const borrowList = !borrowRes ? []
    : (Array.isArray(borrowRes) ? borrowRes : (borrowRes.data || []));
  const borrowBy = Object.fromEntries(borrowList.map(b => [b.pool, b]));
  log(`borrow source: ${borrowUrl || "none"} (${borrowList.length} records)`);
  if (borrowList.length) log(`borrow record keys: ${Object.keys(borrowList[0]).join(", ")}`);

  const buckets = {};
  let matched = 0, skipped = 0;
  for (const p of stacks){
    const cur = currencyOf(p.symbol);
    if (!cur){ log(`  skip ${p.symbol}: not mapped to a currency`); skipped++; continue; }
    const depth = p.tvlUsd ?? 0;
    if (depth <= 0){ log(`  skip ${p.symbol}: no depth`); skipped++; continue; }

    const bRec = borrowBy[p.pool];
    const borrowApr = borrowAprOf(bRec);
    if (borrowApr == null) log(`  ${p.symbol}: no borrow record, supply-only`);
    else matched++;

    const sym = String(p.symbol).toUpperCase();
    (buckets[cur] ||= []).push({
      venue: p.project,
      asset: p.symbol,
      pool: p.pool,
      borrow: borrowApr == null ? null : round(aprToApy(borrowApr)),
      supply: round(p.apyBase ?? 0),
      protocolYield: round(p.apyReward ?? 0),
      ...(YIELD_SOURCE[sym] && { protocolYieldSource: YIELD_SOURCE[sym] }),
      depthUsd: Math.round(depth),
      phaseIn: 1
    });
  }
  log(`markets kept: ${Object.values(buckets).flat().length}, with borrow data: ${matched}, skipped: ${skipped}`);

  const indices = {};
  for (const [cur, markets] of Object.entries(buckets)){
    markets.sort((a,b) => b.depthUsd - a.depthUsd);
    const total = markets.reduce((a,m) => a + m.depthUsd * m.phaseIn, 0);
    markets.forEach(m => { m.weight = round(m.depthUsd * m.phaseIn / total, 4); });

    /* borrow fixing uses only markets that have a borrow side, reweighted */
    const withBorrow = markets.filter(m => m.borrow != null);
    const bTotal = withBorrow.reduce((a,m) => a + m.depthUsd * m.phaseIn, 0);
    const borrow = bTotal > 0
      ? round(withBorrow.reduce((a,m) => a + m.borrow * (m.depthUsd*m.phaseIn/bTotal), 0))
      : null;

    indices[META[cur].label] = {
      ...META[cur],
      borrow,
      supply: round(markets.reduce((a,m) => a + m.supply * m.weight, 0)),
      borrowCoverage: round(bTotal / total, 4),
      markets
    };
  }
  if (!Object.keys(indices).length) throw new Error("No index could be computed. Aborting.");

  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const day = stamp.slice(0,10);

  const latest = {
    name:"SBOR",
    description:"Stacks Bitcoin Offered Rate. Benchmark lending rate for Stacks. Public good, free to reference.",
    url:"https://sbor.xyz",
    bns:["sbor.btc","sbor.stx"],
    fixing: stamp,
    basis:"APY, annually compounded",
    method:"https://sbor.xyz/llms.txt",
    source:"DefiLlama yields (chain: Stacks)",
    indices,
    notes:[
      "Protocol yield belongs to the asset, not the loan, and is excluded from every fixing.",
      "Currencies are never blended into a single figure.",
      "Borrow rates are published by venues as APR and converted to APY here.",
      "borrowCoverage is the share of index depth for which a borrow rate was available."
    ]
  };

  mkdirSync("api", { recursive:true });
  writeFileSync("api/latest.json", JSON.stringify(latest, null, 2) + "\n");

  const lines = [
    `SBOR fixing ${stamp}`,
    `currency  borrow%  supply%`,
    ...Object.entries(indices).map(([k,v]) =>
      `${k.padEnd(9)} ${String(v.borrow ?? "n/a").padEnd(8)} ${v.supply}`),
    `basis=APY source=https://sbor.xyz/api/latest.json`
  ];
  writeFileSync("latest.txt", lines.join("\n") + "\n");

  let history = [];
  try { history = JSON.parse(readFileSync("api/history.json","utf8")); } catch {}
  history = history.filter(r => r.date !== day);
  history.push({ date: day, ...Object.fromEntries(Object.entries(indices)
    .map(([k,v]) => [k, { borrow:v.borrow, supply:v.supply }])) });
  history.sort((a,b) => a.date.localeCompare(b.date));
  writeFileSync("api/history.json", JSON.stringify(history, null, 2) + "\n");

  console.log(lines.join("\n"));
  console.log(`history rows: ${history.length}`);
};

main().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
