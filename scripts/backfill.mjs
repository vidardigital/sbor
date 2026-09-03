/**
 * One-off backfill of SBOR history from DefiLlama.
 *
 * DefiLlama publishes daily base APY and TVL per pool but no borrow rate for
 * these markets, so backfilled rows carry a supply figure only. Every row it
 * writes is marked {"backfilled": true} and rows already produced by the live
 * pipeline are never overwritten.
 *
 * Run once:  node scripts/backfill.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";

const POOLS = "https://yields.llama.fi/pools";
const CHART = p => `https://yields.llama.fi/chart/${p}`;

const CURRENCY = {
  "SBOR-USD": ["USDCX","USDH","USDC","USDT","AEUSDC"],
  "SBOR-BTC": ["SBTC","WBTC","XBTC"],
  "SBOR-STX": ["STX","STSTX"]
};
const EXCLUDE = ["STSTXBTC"];

const round = (n,d=2) => Number(Number(n).toFixed(d));
const log = (...a) => console.error(...a);

const labelFor = sym => {
  const s = String(sym).toUpperCase();
  if (EXCLUDE.includes(s)) return null;
  for (const [k,v] of Object.entries(CURRENCY)) if (v.includes(s)) return k;
  return null;
};

async function getJson(u){
  const r = await fetch(u, { headers:{ accept:"application/json" } });
  if(!r.ok) throw new Error(`${u} responded ${r.status}`);
  return r.json();
}

const main = async () => {
  const { data = [] } = await getJson(POOLS);
  const stacks = data.filter(p => p.chain === "Stacks" && labelFor(p.symbol));
  log(`pools to backfill: ${stacks.length}`);

  /* date -> label -> [{supply, depth}] */
  const grid = {};
  for (const p of stacks){
    const label = labelFor(p.symbol);
    let chart;
    try { chart = await getJson(CHART(p.pool)); }
    catch(e){ log(`  ${p.symbol}: chart unavailable, skipped. ${e.message}`); continue; }
    const rows = chart.data || [];
    log(`  ${p.symbol} -> ${label}: ${rows.length} daily points`);
    for (const r of rows){
      const date = String(r.timestamp).slice(0,10);
      const depth = Number(r.tvlUsd) || 0;
      const supply = Number(r.apyBase ?? 0);
      if (depth <= 0) continue;
      ((grid[date] ||= {})[label] ||= []).push({ supply, depth });
    }
  }

  const backfilled = Object.entries(grid).map(([date, byLabel]) => {
    const row = { date, backfilled: true };
    for (const [label, ms] of Object.entries(byLabel)){
      const total = ms.reduce((a,m)=>a+m.depth,0);
      row[label] = {
        borrow: null,
        supply: round(ms.reduce((a,m)=>a+m.supply*m.depth/total,0))
      };
    }
    return row;
  });

  /* The official record is never touched. Reconstruction lives in its own
     file and is presented as context, not as the fixing history. */
  backfilled.sort((a,b) => a.date.localeCompare(b.date));
  mkdirSync("api/v1", { recursive:true });
  writeFileSync("api/v1/backfill.json", JSON.stringify({
    note: "Reconstructed from DefiLlama daily records. Supply side only, because no borrow history exists for these markets. This is context, not the SBOR fixing record, which begins the day the index went live.",
    source: "https://yields.llama.fi",
    generated: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    rows: backfilled
  }, null, 2) + "\n");

  console.log(`backfill rows: ${backfilled.length}`);
  console.log(`range: ${backfilled[0]?.date} to ${backfilled[backfilled.length-1]?.date}`);
  console.log("written to api/v1/backfill.json. The official history is untouched.");
};

main().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
