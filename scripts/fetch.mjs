/**
 * SBOR fixing pipeline.
 *
 * Rates are read directly from Zest's on-chain data contract, which publishes
 * both a supply APY and a borrow APY per asset. Depth comes from DefiLlama.
 * Writes api/latest.json, api/history.json and latest.txt. No API key required.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fetchCallReadOnlyFunction, contractPrincipalCV, cvToValue } from "@stacks/transactions";

const POOLS_URL = "https://yields.llama.fi/pools";

/* Zest V2. Deployer, data contract, and the asset principals it keys on. */
const ZEST = {
  venue: "Zest V2",
  deployer: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7",
  dataContract: "v0-1-data",
  assets: [
    { symbol:"sBTC",     currency:"BTC", address:"SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4", contract:"sbtc-token" },
    { symbol:"USDCx",    currency:"USD", address:"SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE", contract:"usdcx" },
    { symbol:"USDh",     currency:"USD", address:"SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG", contract:"usdh-token-v1" },
    { symbol:"STX",      currency:"STX", address:"SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7", contract:"wstx" },
    { symbol:"stSTX",    currency:"STX", address:"SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG", contract:"ststx-token" },
    /* collateral only, reported but never in a fixing */
    { symbol:"stSTXbtc", currency:null,  address:"SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG", contract:"ststxbtc-token-v2" }
  ]
};

/* Granite. Single USDCx market. Rates are derived from the interest rate
   curve and current utilisation, exactly as Granite's own math SDK does. */
const GRANITE = {
  venue: "Granite",
  deployer: "SPSX722NK9V3A8D3CVQT0CDY4EBQ3E9FSDDE61FT",
  irContract: "linear-kinked-ir-v1",
  stateContract: "state-v1",
  asset: "USDCx",
  currency: "USD"
};
const SECONDS_IN_YEAR = 31_536_000;

/* DefiLlama symbol -> our symbol, for matching depth */
const DEPTH_ALIAS = { SBTC:"sBTC", USDC:"USDCx", USDH:"USDh", STX:"STX", STSTX:"stSTX", STSTXBTC:"stSTXbtc" };

const META = {
  USD: { label:"SBOR-USD", currency:"USD",
         headline:"The dollar cost of money on Stacks, published every block." },
  BTC: { label:"SBOR-BTC", currency:"BTC",
         headline:"The cost of borrowing bitcoin against Bitcoin-secured collateral." },
  STX: { label:"SBOR-STX", currency:"STX",
         headline:"The cost of money in STX, the chain's own collateral asset." }
};

const YIELD_SOURCE = {
  sBTC:  "Bitcoin protocol yield via dual stacking, paid on enrolment",
  stSTX: "PoX staking yield on the underlying, managed by StackingDAO"
};

const round = (n, d = 2) => Number(Number(n).toFixed(d));
/* One run per day is the official fixing and is the only run written to
   history. Other runs refresh the current reading only. */
const IS_FIXING = process.env.SBOR_FIXING === "1";
const log = (...a) => console.error(...a);

async function depthBySymbol(){
  const r = await fetch(POOLS_URL, { headers:{ accept:"application/json" } });
  if(!r.ok) throw new Error(`pools responded ${r.status}`);
  const { data = [] } = await r.json();
  const out = {};
  for (const p of data.filter(p => p.chain === "Stacks")){
    const sym = DEPTH_ALIAS[String(p.symbol).toUpperCase()];
    if (sym && p.tvlUsd > 0) out[sym] = Math.round(p.tvlUsd);
  }
  return out;
}

async function apysFor(asset){
  const res = await fetchCallReadOnlyFunction({
    contractAddress: ZEST.deployer,
    contractName: ZEST.dataContract,
    functionName: "get-asset-apys",
    functionArgs: [contractPrincipalCV(asset.address, asset.contract)],
    senderAddress: ZEST.deployer,
    network: "mainnet"
  });
  const v = cvToValue(res, true);
  const t = v?.value ?? v;                       // unwrap (ok ...) if present
  const supply = Number(t["supply-apy"]?.value ?? t["supply-apy"]) / 100;
  const borrow = Number(t["borrow-apy"]?.value ?? t["borrow-apy"]) / 100;
  if (!Number.isFinite(supply) || !Number.isFinite(borrow))
    throw new Error(`unexpected shape: ${JSON.stringify(v).slice(0,200)}`);
  return { supply, borrow };
}

/* Read a read-only function and return the plain JS value. */
async function readOnly(address, contract, fn, args = []){
  const res = await fetchCallReadOnlyFunction({
    contractAddress: address, contractName: contract, functionName: fn,
    functionArgs: args, senderAddress: address, network: "mainnet"
  });
  return cvToValue(res, true);
}

const numOf = v => Number(v?.value ?? v);

async function graniteMarket(){
  const ir  = await readOnly(GRANITE.deployer, GRANITE.irContract, "get-ir-params");
  const st0 = await readOnly(GRANITE.deployer, GRANITE.stateContract, "get-accrue-interest-params");
  const st  = st0?.value ?? st0;

  log("  granite raw ir-params:", JSON.stringify(ir));
  log("  granite raw accrue-params:", JSON.stringify(st));

  /* on-chain fixed point: rate params use 1e12, balances use token decimals */
  const ONE12 = 1e12;
  const baseIR = numOf(ir["base-ir"]) / ONE12;
  const slope1 = numOf(ir["ir-slope-1"]) / ONE12;
  const slope2 = numOf(ir["ir-slope-2"]) / ONE12;
  const kink   = numOf(ir["utilization-kink"]) / ONE12;

  const totalAssets = numOf(st["total-assets"]);
  const openInterest = numOf(st["lp-interest"]) + numOf(st["staked-interest"]) + numOf(st["protocol-interest"]);
  const reservePct = numOf(st["protocol-reserve-percentage"]) / ONE12;

  const ur = totalAssets > 0 ? openInterest / totalAssets : 0;
  const apr = ur < kink
    ? slope1 * ur + baseIR
    : slope2 * (ur - kink) + slope1 * kink + baseIR;

  const borrow = ((1 + apr / SECONDS_IN_YEAR) ** SECONDS_IN_YEAR - 1) * 100;
  const lpApr  = apr * (1 - reservePct) * ur;
  const supply = ur === 0 ? 0 : ((1 + lpApr / SECONDS_IN_YEAR) ** SECONDS_IN_YEAR - 1) * 100;

  log(`  granite derived: ur=${(ur*100).toFixed(2)}% apr=${(apr*100).toFixed(2)}% ` +
      `borrow=${borrow.toFixed(2)}% supply=${supply.toFixed(2)}% reservePct=${(reservePct*100).toFixed(2)}%`);

  return { borrow, supply, totalAssetsRaw: totalAssets };
}

const main = async () => {
  const depth = await depthBySymbol();
  log("depth from DefiLlama:", JSON.stringify(depth));

  const markets = [];
  for (const a of ZEST.assets){
    try {
      const { supply, borrow } = await apysFor(a);
      const d = depth[a.symbol] ?? 0;
      log(`  ${a.symbol}: supply=${round(supply)}% borrow=${round(borrow)}% depth=${d}`);
      if (!a.currency){ log(`    (collateral only, excluded from fixings)`); continue; }
      if (d <= 0){ log(`    (no depth, skipped)`); continue; }
      markets.push({
        venue: ZEST.venue, asset: a.symbol, currency: a.currency,
        borrow: round(borrow), supply: round(supply),
        ...(YIELD_SOURCE[a.symbol] && { protocolYieldSource: YIELD_SOURCE[a.symbol] }),
        depthUsd: d, phaseIn: 1
      });
    } catch(e){
      log(`  ${a.symbol}: read failed, excluded. ${e.message}`);
    }
  }
  /* Granite, USDCx market. Depth read on-chain, USDCx is dollar denominated. */
  try {
    const g = await graniteMarket();
    const depthUsd = Math.round(g.totalAssetsRaw / 1e6);   // USDCx has 6 decimals
    if (depthUsd > 0 && Number.isFinite(g.borrow) && Number.isFinite(g.supply)){
      log(`  Granite ${GRANITE.asset}: supply=${round(g.supply)}% borrow=${round(g.borrow)}% depth=${depthUsd}`);
      markets.push({
        venue: GRANITE.venue, asset: GRANITE.asset, currency: GRANITE.currency,
        borrow: round(g.borrow), supply: round(g.supply),
        depthUsd, phaseIn: 1
      });
    } else {
      log(`  Granite: implausible values, excluded. depth=${depthUsd} borrow=${g.borrow} supply=${g.supply}`);
    }
  } catch(e){
    log(`  Granite: read failed, excluded. ${e.message}`);
  }

  if (!markets.length) throw new Error("No markets could be read. Aborting rather than writing an empty fixing.");

  const indices = {};
  for (const cur of Object.keys(META)){
    const ms = markets.filter(m => m.currency === cur)
                      .sort((a,b) => b.depthUsd - a.depthUsd);
    if (!ms.length) continue;
    const total = ms.reduce((a,m) => a + m.depthUsd * m.phaseIn, 0);
    ms.forEach(m => { m.weight = round(m.depthUsd * m.phaseIn / total, 4); });
    const venues = [...new Set(ms.map(m => m.venue))];
    indices[META[cur].label] = {
      ...META[cur],
      borrow: round(ms.reduce((a,m) => a + m.borrow * m.weight, 0)),
      supply: round(ms.reduce((a,m) => a + m.supply * m.weight, 0)),
      venues,
      largestConstituentWeight: round(Math.max(...ms.map(m => m.weight)), 4),
      markets: ms.map(({ currency, ...rest }) => rest)
    };
  }

  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const day = stamp.slice(0,10);

  const latest = {
    name:"SBOR",
    description:"Stacks Bitcoin Offered Rate. Benchmark lending rate for Stacks. Public good, free to reference.",
    url:"https://sbor.xyz",
    bns:["sbor.btc","sbor.stx"],
    fixing: stamp,
    isDailyFixing: IS_FIXING,
    basis:"APY, annually compounded",
    method:"https://sbor.xyz/llms.txt",
    source:"Rates read from lending contract state on Stacks mainnet. Zest depth from DefiLlama, Granite depth read on-chain.",
    indices,
    notes:[
      "The daily fixing at 14:00 UTC is the official reference. Other readings are intraday refreshes.",
      "Rates are read from contract state, not from any venue's published figure.",
      "Protocol yield belongs to the asset, not the loan, and is excluded from every fixing.",
      "Currencies are never blended into a single figure.",
      "stSTXbtc is collateral only and is excluded from all fixings."
    ]
  };

  mkdirSync("api", { recursive:true });
  writeFileSync("api/latest.json", JSON.stringify(latest, null, 2) + "\n");

  const lines = [
    `SBOR fixing ${stamp}`,
    `currency  borrow%  supply%`,
    ...Object.entries(indices).map(([k,v]) =>
      `${k.padEnd(9)} ${String(v.borrow).padEnd(8)} ${v.supply}`),
    `basis=APY source=https://sbor.xyz/api/latest.json`
  ];
  writeFileSync("latest.txt", lines.join("\n") + "\n");

  if (IS_FIXING){
    let history = [];
    try { history = JSON.parse(readFileSync("api/history.json","utf8")); } catch {}
    history = history.filter(r => r.date !== day);
    history.push({ date: day, ...Object.fromEntries(Object.entries(indices)
      .map(([k,v]) => [k, { borrow:v.borrow, supply:v.supply }])) });
    history.sort((a,b) => a.date.localeCompare(b.date));
    writeFileSync("api/history.json", JSON.stringify(history, null, 2) + "\n");
    console.log(`daily fixing recorded, history rows: ${history.length}`);
  } else {
    console.log("intraday refresh, history unchanged");
  }

  console.log(lines.join("\n"));
};

main().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
