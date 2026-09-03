/**
 * Weekly SBOR report.
 * Reads api/latest.json and api/history.json, writes weekly.txt:
 * a plain-text summary sized for pasting straight into an email.
 */
import { readFileSync, writeFileSync } from "node:fs";

const pad  = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
const sign = n => (n > 0 ? "+" : n < 0 ? "" : " ") + n.toFixed(2);

const MONTHS = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"];
function longDate(iso){
  const [y,m,d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m-1]} ${y}`;
}

const latest  = JSON.parse(readFileSync("api/v1/latest.json", "utf8"));
let history = [];
try { history = JSON.parse(readFileSync("api/v1/history.json", "utf8")); } catch {}

const today = latest.fixing.slice(0,10);
const cutoff = new Date(Date.parse(today) - 7*864e5).toISOString().slice(0,10);
/* nearest recorded fixing on or before one week ago */
const prior = [...history].reverse().find(r => r.date <= cutoff) || null;

const L = [];
L.push(`SBOR WEEKLY RATE REPORT`);
L.push(`Week ending ${longDate(today)}`);
L.push(``);
L.push(`Benchmark lending rates for Stacks, read from contract state.`);
L.push(`Full data and methodology: https://sbor.xyz`);
L.push(``);
L.push(`--------------------------------------------------------------`);
L.push(`${pad("INDEX",10)} ${rpad("BORROW",8)} ${rpad("SUPPLY",8)} ${rpad("SPREAD",8)}  ${prior ? "WoW BORROW" : ""}`);
L.push(`--------------------------------------------------------------`);

for (const [label, ix] of Object.entries(latest.indices)){
  const spread = ix.borrow - ix.supply;
  let wow = "";
  if (prior && prior[label]){
    const d = ix.borrow - prior[label].borrow;
    wow = `${sign(d)} pts`;
  }
  L.push(`${pad(label,10)} ${rpad(ix.borrow.toFixed(2)+"%",8)} ${rpad(ix.supply.toFixed(2)+"%",8)} ${rpad(spread.toFixed(2)+" pts",8)}  ${wow}`);
}
L.push(`--------------------------------------------------------------`);
L.push(``);

if (prior){
  L.push(`Compared with the fixing of ${longDate(prior.date)}.`);
} else {
  L.push(`No fixing from a week ago is on record yet, so week over week`);
  L.push(`comparisons begin once the series is long enough to support them.`);
}
L.push(``);

L.push(`COVERAGE`);
for (const [label, ix] of Object.entries(latest.indices)){
  const venues = ix.venues || [...new Set(ix.markets.map(m => m.venue))];
  const n = venues.length;
  const largest = ix.largestConstituentWeight ?? Math.max(...ix.markets.map(m => m.weight));
  const pct = (largest*100).toFixed(0);
  const depth = ix.markets.reduce((a,m)=>a+m.depthUsd,0);
  L.push(`  ${pad(label,10)} ${n} ${n===1?"venue ":"venues"}  largest ${rpad(pct+"%",4)} of depth  ` +
         `total $${(depth/1e6).toFixed(1)}M`);
}
L.push(``);

L.push(`CONSTITUENTS`);
for (const [label, ix] of Object.entries(latest.indices)){
  L.push(`  ${label}`);
  for (const m of ix.markets){
    L.push(`    ${pad(m.venue+" "+m.asset, 22)} borrow ${rpad(m.borrow.toFixed(2)+"%",7)}  ` +
           `supply ${rpad(m.supply.toFixed(2)+"%",7)}  weight ${rpad((m.weight*100).toFixed(1)+"%",6)}`);
  }
}
L.push(``);

const withProtocolYield = Object.values(latest.indices)
  .flatMap(ix => ix.markets)
  .filter(m => m.protocolYieldSource);
if (withProtocolYield.length){
  L.push(`EXCLUDED FROM THE FIXING`);
  for (const m of withProtocolYield){
    L.push(`  ${m.asset}: ${m.protocolYieldSource}.`);
  }
  L.push(`  Protocol yield belongs to the asset, not the loan.`);
  L.push(``);
}

L.push(`--------------------------------------------------------------`);
L.push(`SBOR is published as a public good. It is a statistic, not an`);
L.push(`investment. Rates are read from lending contract state on Stacks`);
L.push(`mainnet and published once daily at 14:00 UTC.`);
L.push(`Unsubscribe by replying to this email.`);

const out = L.join("\n") + "\n";
writeFileSync("weekly.txt", out);
console.log(out);
