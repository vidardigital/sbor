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
L.push(`mainnet and published once daily at 11:00 UTC.`);
L.push(`Unsubscribe by replying to this email.`);

const out = L.join("\n") + "\n";
writeFileSync("weekly.txt", out);

/* An HTML version with inline styles, so it can be selected, copied and
   pasted straight into an email client with its formatting intact. */
const P = "#F1F2ED", INK = "#131A1F", SOFT = "#5C646B", AC = "#1D4E6B", RL = "#CBCFC4";
const td = (v, extra="") =>
  `<td style="padding:9px 18px 9px 0;border-bottom:1px solid #DEE1D8;${extra}">${v}</td>`;
const mono = "font-family:'IBM Plex Mono',Menlo,Consolas,monospace";

const rows = Object.entries(latest.indices).map(([label, ix]) => {
  const spread = (ix.borrow - ix.supply).toFixed(2);
  let wow = "";
  if (prior && prior[label]) wow = sign(ix.borrow - prior[label].borrow) + " pts";
  return `<tr>
    ${td(`<strong>${label}</strong>`)}
    ${td(`<span style="${mono};color:${AC}">${ix.borrow.toFixed(2)}%</span>`, "text-align:right")}
    ${td(`<span style="${mono}">${ix.supply.toFixed(2)}%</span>`, "text-align:right")}
    ${td(`<span style="${mono};color:${SOFT}">${spread} pts</span>`, "text-align:right")}
    ${td(`<span style="${mono};color:${SOFT}">${wow}</span>`, "text-align:right")}
  </tr>`;
}).join("");

const cover = Object.entries(latest.indices).map(([label, ix]) => {
  const venues = ix.venues || [...new Set(ix.markets.map(m => m.venue))];
  const largest = ix.largestConstituentWeight ?? Math.max(...ix.markets.map(m => m.weight));
  const depth = ix.markets.reduce((a,m)=>a+m.depthUsd,0);
  return `<li style="margin-bottom:4px"><strong>${label}</strong> ${venues.length} ${venues.length===1?"venue":"venues"}, largest ${(largest*100).toFixed(0)}% of depth, total $${(depth/1e6).toFixed(1)}M</li>`;
}).join("");

const poxLine = latest.poxReference
  ? `<p style="margin:0 0 18px"><strong>Bitcoin staking yield</strong> <span style="${mono};color:${AC}">${latest.poxReference.apy.toFixed(2)}%</span>
     <span style="color:${SOFT}">, paid in bitcoin to STX stackers, cycle ${latest.poxReference.cycle}. A staking yield, not a lending rate.</span></p>`
  : "";

const html = `<div style="background:${P};color:${INK};font-family:'IBM Plex Sans',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;padding:28px;max-width:660px">
  <div style="font-weight:600;letter-spacing:.16em;font-size:18px">S&middot;B&middot;O&middot;R</div>
  <div style="color:${SOFT};font-size:14px;margin-top:2px">Weekly rate report &middot; week ending ${longDate(today)}</div>
  <hr style="border:none;border-top:1px solid ${RL};margin:18px 0">

  <table style="border-collapse:collapse;width:100%;margin-bottom:18px">
    <tr style="color:${SOFT};font-size:13px">
      ${td("Index")}${td("Borrow","text-align:right")}${td("Supply","text-align:right")}${td("Spread","text-align:right")}${td(prior?"WoW borrow":"","text-align:right")}
    </tr>
    ${rows}
  </table>

  ${poxLine}

  <p style="margin:0 0 6px"><strong>Coverage</strong></p>
  <ul style="margin:0 0 18px;padding-left:20px;color:${SOFT};font-size:14px">${cover}</ul>

  <p style="color:${SOFT};font-size:14px;margin:0 0 18px">
    ${prior ? `Compared with the fixing of ${longDate(prior.date)}.`
            : "Week over week comparison begins once the series is long enough to support it."}
  </p>

  <hr style="border:none;border-top:1px solid ${RL};margin:18px 0">
  <p style="color:${SOFT};font-size:13px;margin:0">
    Full data, methodology and history at <a href="https://sbor.xyz" style="color:${AC}">sbor.xyz</a>.
    Rates are read from lending contract state on Stacks mainnet and published once daily at 11:00 UTC.
    SBOR is a statistic, not investment advice.
  </p>
</div>`;

writeFileSync("weekly.html",
`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>SBOR weekly report</title><meta name="robots" content="noindex">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>body{margin:0;background:#fff}</style></head><body>${html}</body></html>\n`);

console.log(out);
console.log("also wrote weekly.html");
