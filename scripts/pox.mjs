/**
 * SBOR-POX: the native Bitcoin staking yield on Stacks.
 *
 * PoX pays stackers in BTC from what miners commit. The rate is therefore
 *   cycle yield = BTC paid to stackers over one cycle, in USD
 *                 / STX locked over that cycle, in USD
 * annualised over the number of reward cycles in a year.
 *
 * This is a staking yield, not a lending rate. It is published beside the
 * lending indices, never blended into them.
 *
 * Run standalone to check the figure:  node scripts/pox.mjs
 */
const HIRO   = "https://api.hiro.so";
const PRICES = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,blockstack&vs_currencies=usd";

const round = (n,d=2) => Number(Number(n).toFixed(d));
const log = (...a) => console.error(...a);

async function getJson(u){
  const r = await fetch(u, { headers:{ accept:"application/json" } });
  if(!r.ok) throw new Error(`${u} responded ${r.status}`);
  return r.json();
}

export async function poxReference(){
  /* 1. cycle geometry and how much STX is locked */
  const pox = await getJson(`${HIRO}/v2/pox`);
  const cycleLen = pox.reward_cycle_length;                 // burn blocks per cycle
  const cur      = pox.current_cycle;
  const cycleId  = cur.id;
  const stackedUstx = Number(cur.stacked_ustx);
  log(`pox: cycle ${cycleId}, length ${cycleLen} blocks, stacked ${(stackedUstx/1e6).toFixed(0)} STX`);

  /* 2. the last completed cycle, so the figure is not a partial period */
  const target   = cycleId - 1;
  const firstBlk = pox.first_burnchain_block_height + (target - pox.first_burnchain_block_height/cycleLen|0)*0; // placeholder, computed below
  const startBlk = pox.first_burnchain_block_height + (target * cycleLen) - (pox.first_burnchain_block_height % cycleLen);
  const endBlk   = startBlk + cycleLen - 1;
  log(`measuring completed cycle ${target}, burn blocks ${startBlk} to ${endBlk}`);

  /* 3. sum the BTC miners paid out across that window */
  let sats = 0, seen = 0, offset = 0, pages = 0;
  const LIMIT = 250;
  while (pages < 40){
    const page = await getJson(`${HIRO}/extended/v1/burnchain/rewards?limit=${LIMIT}&offset=${offset}`);
    const rows = page.results || [];
    if (!rows.length) break;
    let below = false;
    for (const r of rows){
      const h = Number(r.burn_block_height);
      if (h > endBlk) continue;
      if (h < startBlk){ below = true; continue; }
      sats += Number(r.reward_amount);
      seen++;
    }
    offset += LIMIT; pages++;
    if (below) break;                       // walked past the start of the cycle
  }
  log(`rewards found in window: ${seen} payouts, ${sats} sats (${(sats/1e8).toFixed(4)} BTC), ${pages} pages`);
  if (!seen) throw new Error("No reward payouts found in the cycle window. Check the block range.");

  /* 4. price both legs */
  const px = await getJson(PRICES);
  const btcUsd = Number(px.bitcoin?.usd);
  const stxUsd = Number(px.blockstack?.usd);
  log(`prices: BTC $${btcUsd}, STX $${stxUsd}`);
  if (!btcUsd || !stxUsd) throw new Error("Missing a price.");

  const rewardUsd  = (sats/1e8) * btcUsd;
  const stakedUsd  = (stackedUstx/1e6) * stxUsd;
  const cycleYield = rewardUsd / stakedUsd;
  const cyclesPerYear = 52560 / cycleLen;   // ~52560 bitcoin blocks a year
  const apy = ((1 + cycleYield) ** cyclesPerYear - 1) * 100;

  log(`reward $${rewardUsd.toFixed(0)} on staked $${stakedUsd.toFixed(0)} ` +
      `= ${(cycleYield*100).toFixed(4)}% per cycle, ${cyclesPerYear.toFixed(2)} cycles a year`);

  return {
    label: "SBOR-POX",
    headline: "The native Bitcoin yield paid to STX stakers.",
    kind: "staking yield",
    apy: round(apy),
    cycle: target,
    cycleYieldPct: round(cycleYield*100, 4),
    btcPaid: round(sats/1e8, 6),
    stxLocked: Math.round(stackedUstx/1e6),
    prices: { btcUsd, stxUsd },
    note: "Paid in bitcoin from miner commitments. Denominated in dollars here so it can be compared with the lending indices. It is a staking yield, not a lending rate, and is never blended into them."
  };
}

if (import.meta.url === `file://${process.argv[1]}`){
  poxReference()
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch(e => { console.error("FAILED:", e.message); process.exit(1); });
}
