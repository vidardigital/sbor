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

const EXPECTED = ["SBOR-USD","SBOR-BTC","SBOR-STX"];
const missing = EXPECTED.filter(l => !latest.indices[l]);

const L = [];
L.push(`SBOR WEEKLY RATE REPORT`);
L.push(`Week ending ${longDate(today)}`);
L.push(``);
L.push(`Benchmark lending rates for Stacks, read from contract state.`);
L.push(`Full data and methodology: https://sbor.xyz`);
L.push(``);
L.push(`--------------------------------------------------------------`);
L.push(`${pad("INDEX",10)} ${rpad("BORROW",8)} ${rpad("SUPPLY",8)} ${rpad("SPREAD",8)}${prior ? "  WoW BORROW" : ""}`);
L.push(`--------------------------------------------------------------`);

for (const [label, ix] of Object.entries(latest.indices)){
  const spread = ix.borrow - ix.supply;
  let wow = "";
  if (prior && prior[label]){
    const d = ix.borrow - prior[label].borrow;
    wow = `${sign(d)} pts`;
  }
  L.push(`${pad(label,10)} ${rpad(ix.borrow.toFixed(2)+"%",8)} ${rpad(ix.supply.toFixed(2)+"%",8)} ${rpad(spread.toFixed(2)+" pts",8)}${wow ? "  "+wow : ""}`);
}
if (missing.length){
  L.push(`NOT PUBLISHED THIS WEEK`);
  for (const m of missing){
    L.push(`  ${m}: no readable lending market. When a venue's contract state`);
    L.push(`  cannot be read, the index is omitted rather than published with a`);
    L.push(`  figure that is not real.`);
  }
  L.push(``);
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
L.push(`ABOUT SBOR`);
L.push(``);
L.push(`SBOR is the benchmark lending rate for Stacks. Every lending market`);
L.push(`prices money differently, so there was no way to say what capital`);
L.push(`actually costs on the chain without checking each venue by hand.`);
L.push(`SBOR publishes one borrow rate and one supply rate per currency,`);
L.push(`weighted by market depth and read directly from contract state`);
L.push(`rather than from any venue's published figure.`);
L.push(``);
L.push(`Use it as a yardstick. Borrowing above SBOR means paying more than`);
L.push(`the market. Supplying below it means earning less.`);
L.push(``);
L.push(`It is published as a public good. Free to reference, no key, no`);
L.push(`registration, no fee. It is an independent benchmark and is not`);
L.push(`affiliated with Stacks, the Stacks Foundation, or any venue it`);
L.push(`measures.`);
L.push(``);
L.push(`  Data and methodology   https://sbor.xyz`);
L.push(`  API                    https://sbor.xyz/api/v1/latest.json`);
L.push(`  Source                 https://github.com/vidardigital/sbor`);
L.push(`  X                      https://x.com/SBORindex`);
L.push(`  Contact                contact@sbor.xyz`);
L.push(``);
L.push(`--------------------------------------------------------------`);
L.push(`Rates are read from lending contract state on Stacks mainnet and`);
L.push(`published once daily at 11:00 UTC. SBOR is a statistic, not`);
L.push(`investment advice, and is provided as is without warranty.`);
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
    ${prior ? td(`<span style="${mono};color:${SOFT}">${wow}</span>`, "text-align:right") : ""}
  </tr>`;
}).join("");

const cover = Object.entries(latest.indices).map(([label, ix]) => {
  const venues = ix.venues || [...new Set(ix.markets.map(m => m.venue))];
  const largest = ix.largestConstituentWeight ?? Math.max(...ix.markets.map(m => m.weight));
  const depth = ix.markets.reduce((a,m)=>a+m.depthUsd,0);
  return `<li style="margin-bottom:4px"><strong>${label}</strong> ${venues.length} ${venues.length===1?"venue":"venues"}, largest ${(largest*100).toFixed(0)}% of depth, total $${(depth/1e6).toFixed(1)}M</li>`;
}).join("");

const poxLine = latest.poxReference
  ? `<p style="margin:0 0 18px"><strong>Bitcoin staking yield</strong> <span style="${mono};color:${AC}">${latest.poxReference.apy.toFixed(2)}%</span><span style="color:${SOFT}">, paid in bitcoin to STX stackers, cycle ${latest.poxReference.cycle}. A staking yield, not a lending rate.</span></p>`
  : "";

const html = `<div style="background:${P};color:${INK};font-family:'IBM Plex Sans',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;padding:28px;max-width:660px">
  <div style="font-weight:600;letter-spacing:.16em;font-size:18px">S&middot;B&middot;O&middot;R</div>
  <div style="color:${SOFT};font-size:14px;margin-top:2px">Weekly rate report &middot; week ending ${longDate(today)}</div>
  <hr style="border:none;border-top:1px solid ${RL};margin:18px 0">

  <table style="border-collapse:collapse;width:100%;margin-bottom:18px">
    <tr style="color:${SOFT};font-size:13px">
      ${td("Index")}${td("Borrow","text-align:right")}${td("Supply","text-align:right")}${td("Spread","text-align:right")}${prior ? td("WoW borrow","text-align:right") : ""}
    </tr>
    ${rows}
  </table>

  ${missing.length ? `<p style="margin:0 0 6px"><strong>Not published this week</strong></p>
  <ul style="margin:0 0 18px;padding-left:20px;color:${SOFT};font-size:14px">
    ${missing.map(m => `<li><strong>${m}</strong> no readable lending market. When contract state cannot be read, the index is omitted rather than published with a figure that is not real.</li>`).join("")}
  </ul>` : ""}

  ${poxLine}

  <p style="margin:0 0 6px"><strong>Coverage</strong></p>
  <ul style="margin:0 0 18px;padding-left:20px;color:${SOFT};font-size:14px">${cover}</ul>

  <p style="color:${SOFT};font-size:14px;margin:0 0 18px">
    ${prior ? `Compared with the fixing of ${longDate(prior.date)}.`
            : "Week over week comparison begins once the series is long enough to support it."}
  </p>

  <hr style="border:none;border-top:1px solid ${RL};margin:18px 0">

  <p style="margin:0 0 8px"><strong>About SBOR</strong></p>
  <p style="color:${SOFT};font-size:14px;margin:0 0 12px">
    SBOR is the benchmark lending rate for Stacks. Every lending market prices money
    differently, so there was no way to say what capital actually costs on the chain
    without checking each venue by hand. SBOR publishes one borrow rate and one supply
    rate per currency, weighted by market depth and read directly from contract state
    rather than from any venue's published figure.
  </p>
  <p style="color:${SOFT};font-size:14px;margin:0 0 12px">
    Use it as a yardstick. Borrowing above SBOR means paying more than the market.
    Supplying below it means earning less.
  </p>
  <p style="color:${SOFT};font-size:14px;margin:0 0 14px">
    It is published as a public good. Free to reference, no key, no registration, no fee.
    SBOR is an independent benchmark and is not affiliated with Stacks, the Stacks
    Foundation, or any venue it measures.
  </p>

  <table style="border-collapse:collapse;font-size:13px;margin-bottom:18px">
    <tr><td style="padding:2px 18px 2px 0;color:${SOFT}">Data and methodology</td>
        <td style="padding:2px 0"><a href="https://sbor.xyz" style="color:${AC}">sbor.xyz</a></td></tr>
    <tr><td style="padding:2px 18px 2px 0;color:${SOFT}">API</td>
        <td style="padding:2px 0"><a href="https://sbor.xyz/api/v1/latest.json" style="color:${AC}">sbor.xyz/api/v1/latest.json</a></td></tr>
    <tr><td style="padding:2px 18px 2px 0;color:${SOFT}">Source</td>
        <td style="padding:2px 0"><a href="https://github.com/vidardigital/sbor" style="color:${AC}">github.com/vidardigital/sbor</a></td></tr>
    <tr><td style="padding:2px 18px 2px 0;color:${SOFT}">X</td>
        <td style="padding:2px 0"><a href="https://x.com/SBORindex" style="color:${AC}">@SBORindex</a></td></tr>
    <tr><td style="padding:2px 18px 2px 0;color:${SOFT}">Contact</td>
        <td style="padding:2px 0"><a href="mailto:contact@sbor.xyz" style="color:${AC}">contact@sbor.xyz</a></td></tr>
  </table>

  <hr style="border:none;border-top:1px solid ${RL};margin:18px 0">
  <p style="color:${SOFT};font-size:12.5px;margin:0">
    Rates are read from lending contract state on Stacks mainnet and published once daily
    at 11:00 UTC. SBOR is a statistic, not investment advice, and is provided as is without
    warranty. Unsubscribe by replying to this email.
  </p>
</div>`;

writeFileSync("weekly.html",
`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>SBOR weekly report</title><meta name="robots" content="noindex">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>body{margin:0;background:#fff}</style></head><body>${html}</body></html>\n`);

console.log(out);
console.log("also wrote weekly.html");
