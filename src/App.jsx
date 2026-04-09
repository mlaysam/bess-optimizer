// BESS Optimizer — bess-optimizer-v6
import { useState, useCallback, useRef, useEffect } from "react";
import {
  Line, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine, Area, AreaChart, ComposedChart,
} from "recharts";

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const MONTHS     = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONTH_DAYS = [31,28,31,30,31,30,31,31,30,31,30,31];

// ─── BATTERY CHEMISTRY METADATA ──────────────────────────────────────────────
// Sources: peer-reviewed literature (Preger 2020, Yagci 2025, Zsoldos 2024,
//          Long-term calendar aging study MDPI 2021) + manufacturer warranty data
//          (CATL, BYD, LG, Tesla 2024) + RWTH Aachen 2024 field study.
//
// Cycle curves: DoD% → cycles to EOL capacity (piecewise linear, interpolated).
//   Values represent REAL-WORLD operation at ~28-32°C (warm climate), NOT
//   lab conditions at 25°C. Lab values (e.g. LFP 10% DoD: 9,000-12,000) are
//   reduced ~30% to account for typical installation temperatures.
//   At 25°C reduce calAgingRate by ~0.5%/yr; at >35°C increase by ~0.5-1%/yr.
//
// effRegression: RTE = w*SoH + b  (clamped 0.60–0.98)
// calAgingRate: %/yr at ~30°C ambient — dominant driver in solar BESS applications.
//   Industry standard 10-year warranty logic: ~350 cycles/yr × 10yr = 3,500 cycles.
//   With 1.5%/yr calendar + typical cycle deg, LFP reaches 80% SoH at Year 10.
// selfDischarge: %/month capacity loss while idle.
const CHEMISTRY_META = {
  LFP: {
    label: "LFP (Lithium Iron Phosphate)",
    // Real-world cycle life at ~30°C warm-climate operation.
    // Lab values at 25°C are ~30% higher; reduce calAgingRate for cooler sites.
    // Sources: Preger 2020 (J.Electrochem.Soc.), Yagci 2025, manufacturer data sheets.
    cycleCurve: [
      {dod:10,cycles:6000},{dod:20,cycles:5000},{dod:30,cycles:4000},
      {dod:50,cycles:3000},{dod:80,cycles:2000},{dod:100,cycles:1800},
    ],
    // RTE: ~96% new → ~94% at EOL (LFP barely loses efficiency with age)
    effRegression: {w:0.10, b:0.86},
    // 1.5%/yr matches 10-year industry warranty at ~30°C ambient.
    // Use 1.0%/yr for temperature-controlled sites; 2.0-2.5%/yr for >35°C.
    calAgingRate: 1.5,
    selfDischarge: 2.0,   // %/month
    defaultUnitCost: 280,
  },
  NMC: {
    label: "NMC (Nickel Manganese Cobalt)",
    // NMC is more temperature-sensitive than LFP; cycle life reduced accordingly.
    // Wikipedia: 1,000-2,300 cycles (100% DoD). Field data suggests ~6yr replacement.
    cycleCurve: [
      {dod:10,cycles:5000},{dod:20,cycles:4000},{dod:30,cycles:3000},
      {dod:50,cycles:2200},{dod:80,cycles:1500},{dod:100,cycles:1200},
    ],
    // RTE: ~93% new → ~88% at EOL
    effRegression: {w:0.25, b:0.68},
    // NMC degrades faster; 3%/yr matches observed 6-8yr commercial lifetimes.
    calAgingRate: 3.0,
    selfDischarge: 2.0,
    defaultUnitCost: 320,
  },
  LeadAcid: {
    label: "Lead-Acid (VRLA/AGM)",
    cycleCurve: [
      {dod:10,cycles:2000},{dod:20,cycles:1200},{dod:30,cycles:900},
      {dod:50,cycles:650},{dod:80,cycles:380},{dod:100,cycles:250},
    ],
    // RTE: ~80% new → ~72% at EOL  (eff = 0.40*SoH + 0.40)
    effRegression: {w:0.40, b:0.40},
    // Lead-acid ages very fast — 3-5yr typical field life at EOL=70% SoH.
    calAgingRate: 5.0,
    selfDischarge: 4.0,   // %/month
    defaultUnitCost: 180,
  },
  SodiumIon: {
    label: "Sodium-Ion (Na-Ion) ⚠ Early-stage",
    // Conservative estimates — commercial deployment since 2023, limited field data.
    cycleCurve: [
      {dod:10,cycles:4000},{dod:20,cycles:3200},{dod:30,cycles:2600},
      {dod:50,cycles:2000},{dod:80,cycles:1400},{dod:100,cycles:1000},
    ],
    // RTE: ~90% new → ~85% at EOL
    effRegression: {w:0.25, b:0.65},
    calAgingRate: 1.5,
    selfDischarge: 3.0,
    defaultUnitCost: 260,
    warning: "Limited long-term field data (commercial since 2023) — treat results as estimates",
  },
  FlowBattery: {
    label: "Flow Battery (Vanadium RFB)",
    // Stack replacement ~every 15-20yr; electrolyte is essentially permanent.
    // Cycle life far exceeds project life; calendar aging dominates.
    cycleCurve: [
      {dod:20,cycles:15000},{dod:50,cycles:14000},
      {dod:80,cycles:12000},{dod:100,cycles:10000},
    ],
    // RTE: ~72% new → ~68% at EOL (pump + stack losses)
    effRegression: {w:0.20, b:0.52},
    calAgingRate: 0.5,    // electrolyte essentially doesn't degrade
    selfDischarge: 1.0,
    defaultUnitCost: 450,
  },
};

// ─── AGGREGATE → MONTHLY FOR CHARTS ──────────────────────────────────────────
function aggregateMonthly(periods, timeRes) {
  const agg = Array.from({length:12}, (_,m) => ({
    month:MONTHS[m], pv:0, load:0, pvToLoad:0, pvToBess:0,
    bessToLoad:0, gridToLoad:0, curtailed:0, socPct:0,
  }));
  const stepsPerMonth = timeRes==="hourly"
    ? MONTH_DAYS.map(d=>d*24)
    : MONTH_DAYS;
  let m=0, cnt=0, lim=stepsPerMonth[0];
  for (const p of periods) {
    const r=agg[m];
    r.pv+=p.pv; r.load+=p.load; r.pvToLoad+=p.pvToLoad;
    r.pvToBess+=p.pvToBess; r.bessToLoad+=p.bessToLoad;
    r.gridToLoad+=p.gridToLoad; r.curtailed+=p.curtailed;
    r.socPct=p.socPct;
    cnt++;
    if (cnt>=lim && m<11) { m++; cnt=0; lim=stepsPerMonth[m]; }
  }
  return agg.map(r=>({
    ...r,
    pv:+r.pv.toFixed(1), load:+r.load.toFixed(1), pvToLoad:+r.pvToLoad.toFixed(1),
    pvToBess:+r.pvToBess.toFixed(1), bessToLoad:+r.bessToLoad.toFixed(1),
    gridToLoad:+r.gridToLoad.toFixed(1), curtailed:+r.curtailed.toFixed(1),
    socPct:+r.socPct.toFixed(1),
  }));
}

// ─── MONTHLY BASELINE (no BESS) ──────────────────────────────────────────────
function aggregateMonthlyBaseline(loadData, pvData, timeRes) {
  const agg = Array.from({length:12}, (_,m) => ({
    month:MONTHS[m], pv:0, load:0, pvToLoad:0, gridToLoad:0, curtailed:0,
  }));
  const stepsPerMonth = timeRes==="hourly" ? MONTH_DAYS.map(d=>d*24) : MONTH_DAYS;
  let m=0, cnt=0, lim=stepsPerMonth[0];
  for (let i=0;i<loadData.length;i++) {
    const load=loadData[i], pv=pvData[i];
    const r=agg[m];
    r.pv+=pv; r.load+=load;
    r.pvToLoad+=Math.min(pv,load);
    r.gridToLoad+=Math.max(0,load-pv);
    r.curtailed+=Math.max(0,pv-load);
    cnt++;
    if (cnt>=lim && m<11) { m++; cnt=0; lim=stepsPerMonth[m]; }
  }
  return agg.map(r=>({
    ...r,
    pv:+r.pv.toFixed(1), load:+r.load.toFixed(1),
    pvToLoad:+r.pvToLoad.toFixed(1), gridToLoad:+r.gridToLoad.toFixed(1),
    curtailed:+r.curtailed.toFixed(1),
  }));
}

// ─── CSV PARSER ───────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines=text.trim().split("\n").filter(l=>l.trim());
  const load=[], pv=[];
  const start=isNaN(parseFloat(lines[0].split(/[,;\t]/)[0]))?1:0;
  for (let i=start;i<lines.length;i++) {
    const cols=lines[i].split(/[,;\t]/);
    const l=parseFloat(cols[0]), p=parseFloat(cols[1]);
    if (!isNaN(l)&&!isNaN(p)) { load.push(l); pv.push(p); }
  }
  return { load, pv };
}

// ─── DISPATCH ENGINE ──────────────────────────────────────────────────────────
// minSocPct: hard floor on discharge (e.g. 0.20 = never go below 20% SoC)
// selfDischargePerPeriod: fractional SoC loss per time-step from idle leakage
function simulateBESS({ loadData, pvData, capacityKwh, chargeEff=0.95, dischargeEff=0.95,
                       initialSoc=0.5, maxChargeCrate=1.0, maxDischargeCrate=1.0,
                       minSocPct=0.10, selfDischargePerPeriod=0 }) {
  const minSoc = capacityKwh * minSocPct;
  let soc = capacityKwh * initialSoc;
  const periods=[];
  let tG=0,tPL=0,tPB=0,tBL=0,tCu=0,tLo=0,tPv=0;

  // C-rate limits in consistent AC-side units:
  //   charge:    battery accepts max capacityKwh*Crate kWh internally per period
  //              → AC input limit = internal limit / chargeEff
  //   discharge: battery delivers max capacityKwh*Crate kWh internally per period
  //              → AC output limit = internal limit × dischargeEff
  const maxChargeInput    = (capacityKwh * maxChargeCrate)    / chargeEff;
  const maxDischargeOutput = (capacityKwh * maxDischargeCrate) * dischargeEff;

  for (let i=0; i<loadData.length; i++) {
    // Apply self-discharge before each period
    if (selfDischargePerPeriod > 0) soc = Math.max(minSoc, soc * (1 - selfDischargePerPeriod));

    const load=loadData[i], pv=pvData[i];
    tLo+=load; tPv+=pv;
    let pvToLoad=0, pvToBess=0, bessToLoad=0, gridToLoad=0, curtailed=0;
    const surplus=pv-load;

    if (surplus>=0) {
      pvToLoad=load;
      // canCharge and maxChargeInput are both in AC-input (kWh arriving at charger)
      let canCharge = Math.min(surplus, (capacityKwh-soc)/chargeEff);
      pvToBess = Math.min(canCharge, maxChargeInput);
      soc += pvToBess * chargeEff;          // AC in × eff = kWh stored
      curtailed = surplus - pvToBess;
    } else {
      pvToLoad = pv;
      const def = -surplus;
      // availableEnergy and maxDischargeOutput are both in AC-output (kWh reaching load)
      const availableEnergy = (soc - minSoc) * dischargeEff;
      let canDischarge = Math.min(def, availableEnergy);
      bessToLoad = Math.min(canDischarge, maxDischargeOutput);
      soc -= bessToLoad / dischargeEff;     // AC out / eff = kWh drawn from battery
      gridToLoad = def - bessToLoad;
    }

    soc = Math.max(minSoc, Math.min(capacityKwh, soc));
    periods.push({ idx:i, load:+load.toFixed(4), pv:+pv.toFixed(4),
      pvToLoad:+pvToLoad.toFixed(4), pvToBess:+pvToBess.toFixed(4),
      bessToLoad:+bessToLoad.toFixed(4), gridToLoad:+gridToLoad.toFixed(4),
      curtailed:+curtailed.toFixed(4), soc:+soc.toFixed(3),
      socPct:capacityKwh>0?+((soc/capacityKwh)*100).toFixed(1):0,
    });
    tG+=gridToLoad; tPL+=pvToLoad; tPB+=pvToBess; tBL+=bessToLoad; tCu+=curtailed;
  }
  const selfSufficiency=tLo>0?((tLo-tG)/tLo)*100:0;
  const pvUtilization  =tPv>0?((tPL+tPB)/tPv)*100:0;
  return {
    periods,
    kpis:{
      totalGrid:+tG.toFixed(1), totalPvToLoad:+tPL.toFixed(1),
      totalPvToBess:+tPB.toFixed(1), totalBessToLoad:+tBL.toFixed(1),
      totalCurtailed:+tCu.toFixed(1), selfSufficiency:+selfSufficiency.toFixed(1),
      pvUtilization:+pvUtilization.toFixed(1), totalLoad:+tLo.toFixed(1),
      totalPv:+tPv.toFixed(1),
    },
  };
}

// ─── ROBUST RAINFLOW (ASTM E1049) ─────────────────────────────────────────────
function rainflowEFC(socSeries, binSize=10) {
  if (socSeries.length < 2) return {};
  const reversals = [socSeries[0]];
  for (let i = 1; i < socSeries.length - 1; i++) {
    if ((socSeries[i] - socSeries[i-1]) * (socSeries[i+1] - socSeries[i]) < 0) {
      reversals.push(socSeries[i]);
    }
  }
  reversals.push(socSeries[socSeries.length-1]);

  const cycles = [];
  const stack = [];
  for (const val of reversals) {
    stack.push(val);
    while (stack.length >= 3) {
      const s = stack.length;
      const range1 = Math.abs(stack[s-1] - stack[s-2]);
      const range2 = Math.abs(stack[s-2] - stack[s-3]);
      if (range1 >= range2) {
        cycles.push(range2);
        stack.splice(s-3, 2);
      } else break;
    }
  }
  for (let i = 1; i < stack.length; i++) {
    cycles.push(Math.abs(stack[i] - stack[i-1]) * 0.5);
  }

  const efcByDod = {};
  for (const range of cycles) {
    const dod = Math.max(10, Math.min(100, Math.round(range / binSize) * binSize));
    efcByDod[dod] = (efcByDod[dod] || 0) + 1;
  }
  return efcByDod;
}

function annualDegradation(efcByDod, cycleLifeCurve, capacityKwh, eolThreshold=80) {
  const sortedDods = Object.keys(cycleLifeCurve).map(Number).sort((a,b)=>a-b);

  const lookupLife = (dod) => {
    if (cycleLifeCurve[dod] !== undefined) return cycleLifeCurve[dod];
    const lo = sortedDods.filter(k=>k<=dod).pop();
    const hi = sortedDods.find(k=>k>=dod);
    if (lo === undefined) return cycleLifeCurve[sortedDods[0]];
    if (hi === undefined) return cycleLifeCurve[sortedDods[sortedDods.length-1]];
    const t = (dod - lo) / (hi - lo);
    return cycleLifeCurve[lo] + t * (cycleLifeCurve[hi] - cycleLifeCurve[lo]);
  };

  // eolFraction: fraction of capacity actually lost over rated cycle life.
  // Cycle life is quoted to EOL (e.g. 80% SoH) meaning only 20% capacity is lost.
  // Without this factor degradation is overcounted by 1/(1-eolThreshold/100) — 5x for 80% EOL.
  const eolFraction = 1 - eolThreshold / 100;

  let deg = 0;
  for (const [dodStr, efc] of Object.entries(efcByDod)) {
    const life = lookupLife(Number(dodStr));
    deg += (efc / life) * capacityKwh * eolFraction;
  }
  return deg;
}

// ─── FINANCIAL ENGINE ─────────────────────────────────────────────────────────
function simulateFinancial({
  loadData, pvData, capacityKwh, chargeEff, dischargeEff, initialSoc,
  unitCost, bosPercent, projectLife, discountRate, tariff, tariffEscalation,
  omCost, omEscalation=2.5,
  eolThreshold, replacementCostRatio, replacementYear: userRepYear, calAgingRate,
  cycleLifeCurve, effRegression, maxChargeCrate, maxDischargeCrate,
  minSocPct=0.10, selfDischargePerPeriod=0,
}) {
  if (capacityKwh<=0) return { npv:0, lcos:null, paybackYear:null, irr:null, replacementYear:null, capex:0, yearlyData:[], totalGridImport:0 };

  const capex = capacityKwh * unitCost * (1 + bosPercent/100);
  const baselineAnn = loadData.reduce((s,l,i) => s + Math.max(0, l - pvData[i]), 0);

  let cumCF=-capex, cumDCF=-capex, replacementDone=false;
  let paybackYear=null, discountedPaybackYear=null;
  let pvCosts=capex, pvDispatch=0;
  const yearlyData=[], nominalCFs=[-capex];

  // Initialise from regression at SoH=1.0 for internal consistency.
  // The user's chargeEff slider is the baseline the regression is calibrated to,
  // so w+b should be close to chargeEff, but the regression value is authoritative.
  const initEff = Math.min(0.98, Math.max(0.60, effRegression.w * 1.0 + effRegression.b));
  let effCharge=initEff, effDischarge=initEff;
  let soh=1.0, effectiveCap=capacityKwh;

  for (let t=1; t<=projectLife; t++) {
    // ── 1. Calendar aging ──
    soh -= calAgingRate / 100;

    // ── 2. Single simulation — used for both energy accounting AND cycle counting ──
    const sim = simulateBESS({
      loadData, pvData, capacityKwh:effectiveCap,
      chargeEff:effCharge, dischargeEff:effDischarge,
      initialSoc, maxChargeCrate, maxDischargeCrate,
      minSocPct, selfDischargePerPeriod,
    });
    const annGridImport  = sim.kpis.totalGrid;
    const annBessDispatch = sim.kpis.totalBessToLoad;
    const annGridAvoided  = baselineAnn - annGridImport;

    // ── 3. Rainflow cycle degradation ──
    const socSeries = sim.periods.map(p => p.socPct);
    const efcByDod  = rainflowEFC(socSeries, 10);
    const annualDeg = annualDegradation(efcByDod, cycleLifeCurve, capacityKwh, eolThreshold);
    soh -= annualDeg / capacityKwh;
    soh  = Math.max(0.01, soh);
    effectiveCap = capacityKwh * soh;

    // ── 4. Efficiency regression for next year ──
    const rawEff = effRegression.w * soh + effRegression.b;
    effCharge    = Math.min(0.98, Math.max(0.60, rawEff));
    effDischarge = effCharge;

    // ── 5. EOL replacement check ──
    let replacementCost = 0;
    if (!replacementDone && (soh < eolThreshold/100 || (userRepYear && t===Number(userRepYear)))) {
      replacementDone  = true;
      replacementCost  = capacityKwh * unitCost * (replacementCostRatio / 100);
      soh          = 1.0;
      effectiveCap = capacityKwh;
      effCharge    = Math.min(0.98, Math.max(0.60, effRegression.w + effRegression.b));
      effDischarge = effCharge;
    }

    // ── 6. Financial calcs with O&M escalation ──
    const escTariff  = tariff  * Math.pow(1 + tariffEscalation/100, t-1);
    const escOM      = omCost  * Math.pow(1 + omEscalation/100,     t-1);
    const savings    = annGridAvoided * escTariff;
    const omYear     = escOM * capacityKwh;
    const cf         = savings - omYear - replacementCost;
    const df         = Math.pow(1 + discountRate/100, t);

    cumCF  += cf;
    cumDCF += cf / df;
    if (cumCF  >= 0 && paybackYear         === null) paybackYear         = t;
    if (cumDCF >= 0 && discountedPaybackYear === null) discountedPaybackYear = t;
    pvCosts   += (omYear + replacementCost) / df;
    pvDispatch += annBessDispatch / df;
    nominalCFs.push(cf);

    yearlyData.push({
      year:t, effectiveCap:+effectiveCap.toFixed(1),
      capPct:+(effectiveCap/capacityKwh*100).toFixed(1),
      annGridImport:+annGridImport.toFixed(0),
      savings:+savings.toFixed(0), omCost:+omYear.toFixed(0),
      replacementCost:+replacementCost.toFixed(0),
      cf:+cf.toFixed(0), cumCashFlow:+cumCF.toFixed(0),
      discountedCumCF:+cumDCF.toFixed(0),
      effCharge:+effCharge.toFixed(3), effDischarge:+effDischarge.toFixed(3),
    });
  }

  const npv  = nominalCFs.reduce((s,cf,t) => s + cf / Math.pow(1+discountRate/100, t), 0);
  const lcos = pvDispatch > 0 ? pvCosts / pvDispatch : null;

  // ── IRR: robust bisection — guards against replacement mid-life causing non-monotone NPV ──
  let irr = null;
  const npvAt = (r) => nominalCFs.reduce((s,cf,t) => s + cf / Math.pow(1+r, t), 0);
  if (npvAt(0.0001) > 0 && npvAt(4.99) < 0) {
    let lo=0.0001, hi=4.99;
    for (let i=0; i<80; i++) {
      const mid=(lo+hi)/2;
      npvAt(mid)>0 ? lo=mid : hi=mid;
    }
    irr = lo * 100;
  }

  return {
    npv:+npv.toFixed(0), lcos:lcos?+lcos.toFixed(4):null,
    paybackYear, discountedPaybackYear,
    irr:irr!==null?+irr.toFixed(1):null,
    replacementYear:yearlyData.find(y=>y.replacementCost>0)?.year||null,
    capex:+capex.toFixed(0), yearlyData,
    totalGridImport:+yearlyData.reduce((s,y)=>s+y.annGridImport,0).toFixed(0),
  };
}

// ─── SENSITIVITY ANALYSIS (tornado) ──────────────────────────────────────────
// Perturbs each key financial input ±20% independently and measures NPV delta.
// Returns array sorted by impact magnitude (largest swing first).
function runSensitivity({ loadData, pvData, baseNpv, perturbPct=20, ...params }) {
  const tests = [
    {key:"tariff",           label:"Grid tariff"},
    {key:"unitCost",         label:"Unit cost (CAPEX)"},
    {key:"discountRate",     label:"Discount rate (WACC)"},
    {key:"omCost",           label:"O&M cost"},
    {key:"tariffEscalation", label:"Tariff escalation"},
    {key:"calAgingRate",     label:"Calendar aging"},
  ];
  return tests.map(({key,label}) => {
    const base = params[key];
    const lo = simulateFinancial({loadData,pvData,...params,[key]:base*(1-perturbPct/100)}).npv;
    const hi = simulateFinancial({loadData,pvData,...params,[key]:base*(1+perturbPct/100)}).npv;
    return { label, lo:+(lo-baseNpv).toFixed(0), hi:+(hi-baseNpv).toFixed(0) };
  }).sort((a,b)=>Math.max(Math.abs(b.lo),Math.abs(b.hi))-Math.max(Math.abs(a.lo),Math.abs(a.hi)));
}

// ─── GOLDEN SECTION SEARCH OPTIMIZER ─────────────────────────────────────────
// Universal three-phase approach that works for any PV/load dataset:
//   Phase 1 — coarse sweep over a physics-derived autoMax
//   Phase 2 — Golden Section Search for the precise optimum
//   Phase 3 — dense fill around the optimum for a readable chart and table
//
// autoMax derivation:
//   The economically useful BESS capacity is physically bounded by what it can
//   both store (PV surplus) AND discharge (load deficit) in a typical day.
//   Using min(p90_daily_surplus, p90_daily_deficit) × 2.5 ensures:
//     • Solar-dominant systems: bounded by deficit capacity (no point charging
//       more than you can discharge)
//     • Load-dominant systems: bounded by the small surplus (no point charging
//       more than is available to store)
//     • Balanced systems: both constraints are equal and both are respected
//   Adaptive doubling: if the coarse sweep peak lands at the rightmost point,
//   autoMax was too small — double it and re-sweep once.
function runOptimization({ loadData, pvData, ...params }) {
  const periodsPerDay = loadData.length > 1000 ? 24 : 1;

  // ── Compute per-day surplus and deficit distributions ─────────────────────────
  const N_days = Math.ceil(loadData.length / periodsPerDay);
  const dailySurplus = new Array(N_days).fill(0);
  const dailyDeficit = new Array(N_days).fill(0);
  for (let i = 0; i < loadData.length; i++) {
    const d = Math.floor(i / periodsPerDay);
    dailySurplus[d] += Math.max(0, pvData[i] - loadData[i]);
    dailyDeficit[d] += Math.max(0, loadData[i] - pvData[i]);
  }
  const sortS = [...dailySurplus].sort((a, b) => a - b);
  const sortD = [...dailyDeficit].sort((a, b) => a - b);
  const p90s  = sortS[Math.floor(sortS.length * 0.90)];
  const p90d  = sortD[Math.floor(sortD.length * 0.90)];

  // The binding constraint is whichever side is smaller on a p90 basis.
  // Floor of 20 kWh prevents collapse to near-zero for extremely small systems.
  const calcAutoMax = () => Math.max(Math.min(p90s, p90d) * 2.5, 20);

  const evaluate = (cap) => {
    const fin  = simulateFinancial({ loadData, pvData, capacityKwh: cap, ...params });
    const tech = simulateBESS({ loadData, pvData, capacityKwh: cap, ...params });
    return {
      capacity : +cap.toFixed(1),
      npv      : fin.npv,
      irr      : fin.irr,
      payback  : fin.paybackYear,
      selfSuff : tech.kpis.selfSufficiency,
      pvUtil   : tech.kpis.pvUtilization,
    };
  };

  const coarseSweep = (autoMax) => {
    const pts = [];
    for (let i = 0; i <= 25; i++) pts.push(evaluate((autoMax / 25) * i));
    return pts;
  };

  // ── Phase 1: coarse sweep with adaptive expansion ─────────────────────────────
  let autoMax = calcAutoMax();
  let curve   = coarseSweep(autoMax);
  let peakIdx = curve.reduce((best, r, i) => r.npv > curve[best].npv ? i : best, 0);

  // If peak is at the last point, the search space is too narrow — double and retry
  if (peakIdx === curve.length - 1) {
    autoMax *= 2;
    curve    = coarseSweep(autoMax);
    peakIdx  = curve.reduce((best, r, i) => r.npv > curve[best].npv ? i : best, 0);
  }

  const lo0 = curve[Math.max(0, peakIdx - 1)].capacity;
  const hi0 = curve[Math.min(curve.length - 1, peakIdx + 1)].capacity;

  // ── Phase 2: Golden Section Search within the bracket ────────────────────────
  const phi = (Math.sqrt(5) - 1) / 2;  // ≈ 0.618
  let lo = lo0, hi = Math.max(hi0, lo0 + 1);
  let c = hi - phi * (hi - lo);
  let d = lo + phi * (hi - lo);
  let fc = evaluate(c).npv;
  let fd = evaluate(d).npv;

  for (let iter = 0; iter < 40; iter++) {
    if (fc > fd) {
      hi = d; d = c; fd = fc;
      c  = hi - phi * (hi - lo);
      fc = evaluate(c).npv;
    } else {
      lo = c; c = d; fc = fd;
      d  = lo + phi * (hi - lo);
      fd = evaluate(d).npv;
    }
  }

  const optimalCap = Math.round((lo + hi) / 2);

  // ── Phase 3: dense fill around the optimum ───────────────────────────────────
  // 20 points from 0 to min(optimalCap × 2.5, autoMax) give ~15–25 kWh steps
  // regardless of the system size, producing a smooth and readable chart and table.
  const denseMax = Math.min(optimalCap * 2.5, autoMax);
  for (let i = 0; i <= 20; i++) curve.push(evaluate((denseMax / 20) * i));

  // Add the exact optimum, sort, deduplicate within 0.5 kWh
  curve.push(evaluate(optimalCap));
  curve.sort((a, b) => a.capacity - b.capacity);
  const deduped = curve.filter((r, i) =>
    i === 0 || Math.abs(r.capacity - curve[i - 1].capacity) > 0.5
  );

  return { curve: deduped, optimalCap };
}


// ─── ARCHITECTURE SVG ─────────────────────────────────────────────────────────
function ArchDiagram() {
  return (
    <svg width="100%" viewBox="0 0 680 520" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <marker id="ar" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </marker>
      </defs>
      <rect x="336" y="44" width="10" height="420" rx="3" fill="#b0bcd4" stroke="#8898b8" strokeWidth="0.5"/>
      <text x="341" y="36" textAnchor="middle" fill="#8898b8" fontSize="11" fontFamily="inherit">AC Bus</text>
      <circle cx="99" cy="68" r="26" fill="#FFD700" opacity="0.15"/>
      <circle cx="99" cy="68" r="19" fill="#FFB800"/>
      {[[99,42,99,36],[99,94,99,100],[73,68,67,68],[125,68,131,68],[119,49,123,44],[79,87,75,92],[119,87,123,92],[79,49,75,44]].map(([x1,y1,x2,y2],i)=>(
        <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#FFB800" strokeWidth={i<4?2.5:2} strokeLinecap="round"/>
      ))}
      <circle cx="91" cy="62" r="4.5" fill="#FFDE4D" opacity="0.5"/>
      <rect x="34" y="100" width="130" height="78" rx="5" fill="#0d2149" stroke="#1e4a8e" strokeWidth="2"/>
      {[0,1,2,3].map(col=>[106,130,152].map((y,row)=>(
        <rect key={`${col}-${row}`} x={40+col*30} y={y} width="24" height={row===2?18:19} rx="1"
          fill={row===1?"#1e4898":"#1a3d7a"} stroke={row===1?"#4a80e0":"#3060c0"} strokeWidth="0.8"/>
      )))}
      <line x1="34" y1="128" x2="164" y2="128" stroke="#c0c8d8" strokeWidth="0.7" opacity="0.4"/>
      <line x1="34" y1="152" x2="164" y2="152" stroke="#c0c8d8" strokeWidth="0.7" opacity="0.4"/>
      <text x="99" y="194" textAnchor="middle" fill="#FFB800" fontSize="12" fontWeight="500" fontFamily="inherit">Solar PV</text>
      <line x1="166" y1="139" x2="210" y2="139" stroke="#f0a500" strokeWidth="2" strokeLinecap="round" markerEnd="url(#ar)"/>
      <text x="188" y="132" textAnchor="middle" fill="#f0a500" fontSize="10" fontFamily="inherit">DC</text>
      <rect x="212" y="108" width="66" height="62" rx="6" fill="#1a1d28" stroke="#4a5568" strokeWidth="1.5"/>
      <line x1="220" y1="162" x2="270" y2="116" stroke="#4a5068" strokeWidth="1" strokeLinecap="round"/>
      <line x1="222" y1="148" x2="240" y2="148" stroke="#f0a500" strokeWidth="2" strokeLinecap="round"/>
      <line x1="222" y1="154" x2="235" y2="154" stroke="#f0a500" strokeWidth="1.4" strokeLinecap="round"/>
      <path d="M248,126 Q252,119 256,126 Q260,133 264,126 Q268,119 272,126" fill="none" stroke="#30d158" strokeWidth="2" strokeLinecap="round"/>
      <text x="245" y="186" textAnchor="middle" fill="#6b7280" fontSize="10" fontFamily="inherit">Inverter</text>
      <line x1="280" y1="139" x2="334" y2="139" stroke="#30d158" strokeWidth="2" strokeLinecap="round" markerEnd="url(#ar)"/>
      <text x="307" y="132" textAnchor="middle" fill="#30d158" fontSize="10" fontFamily="inherit">AC</text>
      <rect x="68" y="262" width="15" height="8" rx="2" fill="#1a8f4a" stroke="#22b05c" strokeWidth="1"/>
      <rect x="96" y="262" width="24" height="8" rx="2" fill="#1a8f4a" stroke="#22b05c" strokeWidth="1"/>
      <rect x="34" y="270" width="130" height="76" rx="5" fill="#071610" stroke="#1a8f4a" strokeWidth="2.5"/>
      {[[42,"#16703c"],[66,"#1ea850"],[90,"#1ea850"],[114,"#0d5a2a"],[138,"#052010"]].map(([x,fill],i)=>(
        <rect key={i} x={x} y="279" width={i===4?11:19} height="50" rx="2" fill={fill}/>
      ))}
      {[42,66,90].map(x=>(<rect key={x} x={x} y="279" width="19" height="7" rx="2" fill="#3dde7c" opacity="0.3"/>))}
      <text x="99" y="338" textAnchor="middle" fill="#3dde7c" fontSize="10" fontFamily="inherit">75%</text>
      <text x="99" y="358" textAnchor="middle" fill="#22b05c" fontSize="12" fontWeight="500" fontFamily="inherit">BESS</text>
      <text x="99" y="372" textAnchor="middle" fill="#16703c" fontSize="10" fontFamily="inherit">Battery Storage</text>
      <line x1="166" y1="302" x2="210" y2="302" stroke="#22b05c" strokeWidth="2" strokeLinecap="round" markerEnd="url(#ar)"/>
      <line x1="210" y1="314" x2="166" y2="314" stroke="#58a6ff" strokeWidth="2" strokeLinecap="round" markerEnd="url(#ar)"/>
      <rect x="212" y="278" width="66" height="62" rx="6" fill="#1a1d28" stroke="#4a5568" strokeWidth="1.5"/>
      <line x1="220" y1="332" x2="270" y2="286" stroke="#4a5068" strokeWidth="1" strokeLinecap="round"/>
      <line x1="222" y1="316" x2="240" y2="316" stroke="#22b05c" strokeWidth="2" strokeLinecap="round"/>
      <line x1="222" y1="322" x2="235" y2="322" stroke="#22b05c" strokeWidth="1.4" strokeLinecap="round"/>
      <path d="M248,294 Q252,287 256,294 Q260,301 264,294 Q268,287 272,294" fill="none" stroke="#58a6ff" strokeWidth="2" strokeLinecap="round"/>
      <text x="245" y="356" textAnchor="middle" fill="#6b7280" fontSize="10" fontFamily="inherit">Inverter</text>
      <line x1="280" y1="302" x2="334" y2="302" stroke="#58a6ff" strokeWidth="2" strokeLinecap="round" markerEnd="url(#ar)"/>
      <line x1="334" y1="314" x2="280" y2="314" stroke="#58a6ff" strokeWidth="2" strokeLinecap="round" markerEnd="url(#ar)"/>
      <line x1="99" y1="468" x2="99" y2="400" stroke="#bf5010" strokeWidth="3" strokeLinecap="round"/>
      <line x1="56" y1="414" x2="142" y2="414" stroke="#bf5010" strokeWidth="2.5" strokeLinecap="round"/>
      <line x1="63" y1="430" x2="135" y2="430" stroke="#bf5010" strokeWidth="2.2" strokeLinecap="round"/>
      <circle cx="57" cy="415" r="3" fill="#888" stroke="#bf5010" strokeWidth="0.8"/>
      <circle cx="141" cy="415" r="3" fill="#888" stroke="#bf5010" strokeWidth="0.8"/>
      <circle cx="65" cy="431" r="2.5" fill="#888" stroke="#bf5010" strokeWidth="0.8"/>
      <circle cx="133" cy="431" r="2.5" fill="#888" stroke="#bf5010" strokeWidth="0.8"/>
      <line x1="56" y1="414" x2="78" y2="446" stroke="#bf5010" strokeWidth="1.5" strokeLinecap="round"/>
      <line x1="142" y1="414" x2="120" y2="446" stroke="#bf5010" strokeWidth="1.5" strokeLinecap="round"/>
      <line x1="78" y1="446" x2="120" y2="446" stroke="#bf5010" strokeWidth="1.8" strokeLinecap="round"/>
      <line x1="78" y1="446" x2="66" y2="468" stroke="#bf5010" strokeWidth="2" strokeLinecap="round"/>
      <line x1="120" y1="446" x2="132" y2="468" stroke="#bf5010" strokeWidth="2" strokeLinecap="round"/>
      <line x1="62" y1="468" x2="136" y2="468" stroke="#bf5010" strokeWidth="2" strokeLinecap="round"/>
      <path d="M57,415 Q99,422 141,415" fill="none" stroke="#a0a8b8" strokeWidth="1.2" strokeLinecap="round"/>
      <path d="M65,431 Q99,437 133,431" fill="none" stroke="#a0a8b8" strokeWidth="1.2" strokeLinecap="round"/>
      <text x="99" y="488" textAnchor="middle" fill="#e06020" fontSize="12" fontWeight="500" fontFamily="inherit">Grid</text>
      <text x="99" y="502" textAnchor="middle" fill="#c05010" fontSize="10" fontFamily="inherit">Utility Network</text>
      <line x1="166" y1="430" x2="334" y2="430" stroke="#ff453a" strokeWidth="2" strokeLinecap="round" markerEnd="url(#ar)"/>
      <rect x="498" y="232" width="11" height="17" rx="2" fill="#1e3a6a" stroke="#2a5aab" strokeWidth="1"/>
      <circle cx="503" cy="227" r="3.5" fill="none" stroke="#9ca3af" strokeWidth="1" opacity="0.5"/>
      <rect x="422" y="245" width="132" height="11" rx="3" fill="#1e3a6a" stroke="#2a5aab" strokeWidth="1.5"/>
      <rect x="432" y="255" width="114" height="96" rx="4" fill="#0d2149" stroke="#1e5a9e" strokeWidth="2"/>
      {[443,473,503].map(x=>(<g key={x}>
        <rect x={x} y="268" width="21" height="16" rx="2" fill="#ffe066" opacity="0.92" stroke="#f0a500" strokeWidth="0.5"/>
        <rect x={x} y="293" width="21" height="16" rx="2" fill="#ffe066" opacity="0.72" stroke="#f0a500" strokeWidth="0.5"/>
      </g>))}
      <rect x="468" y="324" width="36" height="27" rx="3" fill="#1a3d7a" stroke="#2a5aab" strokeWidth="1"/>
      <circle cx="501" cy="339" r="2.2" fill="#b0bcd4"/>
      <rect x="464" y="350" width="44" height="3" rx="1" fill="#1e3a6a"/>
      <text x="489" y="370" textAnchor="middle" fill="#58a6ff" fontSize="12" fontWeight="500" fontFamily="inherit">Load</text>
      <text x="489" y="384" textAnchor="middle" fill="#4080c0" fontSize="10" fontFamily="inherit">Consumer</text>
      <line x1="348" y1="295" x2="420" y2="295" stroke="#58a6ff" strokeWidth="2.5" strokeLinecap="round" markerEnd="url(#ar)"/>
      <rect x="352" y="412" width="176" height="26" rx="5" fill="#0d1117" stroke="#30d15833" strokeWidth="1"/>
      <text x="440" y="429" textAnchor="middle" fill="#30d158" fontSize="10" fontFamily="inherit">Priority: PV → BESS → Grid</text>
    </svg>
  );
}

// ─── TOOLTIP ──────────────────────────────────────────────────────────────────
const CTip = ({ active, payload, label }) => {
  if (!active||!payload?.length) return null;
  return (
    <div style={{background:"#0d1117",border:"1px solid #30d158",borderRadius:6,padding:"9px 13px",fontSize:13,fontFamily:"monospace"}}>
      <p style={{color:"#8b949e",marginBottom:5}}>{label}</p>
      {payload.map((p,i)=><p key={i} style={{color:p.color,margin:"2px 0"}}>{p.name}: <b>{typeof p.value==="number"?p.value.toLocaleString():p.value}</b></p>)}
    </div>
  );
};

// ─── FILE SAVE (Electron-native) ──────────────────────────────────────────────
async function electronSave(content, defaultName, isReport=false) {
  const api = window.electronAPI;
  if (!api) {
    // Fallback for browser dev mode
    const uri = `data:text/plain;charset=utf-8,${encodeURIComponent(content)}`;
    const a = document.createElement('a'); a.href=uri; a.download=defaultName;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    return { ok:true };
  }
  return isReport ? api.saveReport(content, defaultName) : api.saveCSV(content, defaultName);
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab]         = useState("project");
  const [currency, setCurrency] = useState("$");
  const sym = currency;

  const [project, setProject] = useState({
    name:"", client:"", location:"", date:new Date().toISOString().slice(0,10),
    preparedBy:"", pvCapacity:"", loadDescription:"", notes:"",
  });

  const [timeRes, setTimeRes]     = useState("hourly");   // "hourly" | "daily"
  const [inputMode, setInputMode] = useState("csv");
  const [csvData, setCsvData]     = useState(null);
  const [manualLoad, setManualLoad] = useState("");
  const [manualPv,   setManualPv]   = useState("");

  const [techP, setTechP] = useState({
    maxCapacity:100, chargeEff:95, dischargeEff:95, initialSoc:50,
    minSocPct:10,
    maxChargeCrate:1.0, maxDischargeCrate:1.0,
  });
  const [finP, setFinP] = useState({
    unitCost:280, bosPercent:20, projectLife:15,
    discountRate:8, tariff:0.18, tariffEscalation:3,
    omCost:5, omEscalation:2.5,
    eolThreshold:80, replacementCostRatio:60,
    replacementYear:"", calAgingRate:1.5,  // LFP default — see CHEMISTRY_META
    chemistry:"LFP", effW:0.10, effB:0.86,
  });

  function handleChemistryChange(chem) {
    const meta = CHEMISTRY_META[chem];
    if (!meta) return;
    setFinP(p => ({
      ...p,
      chemistry:   chem,
      effW:        meta.effRegression.w,
      effB:        meta.effRegression.b,
      calAgingRate: meta.calAgingRate,
      unitCost:    meta.defaultUnitCost,
    }));
  }

  function normalizeParams(fp) {
    const meta = CHEMISTRY_META[fp.chemistry] || CHEMISTRY_META.LFP;
    // Build cycleLifeCurve lookup table from meta curve array
    const cycleLifeCurve = Object.fromEntries(meta.cycleCurve.map(r=>[r.dod, r.cycles]));
    return {
      ...fp,
      cycleLifeCurve,
      effRegression:       { w: fp.effW, b: fp.effB },
      selfDischargeMonthly: meta.selfDischarge,
      chemistryWarning:    meta.warning || null,
    };
  }

  const [simCap, setSimCap]       = useState(50);
  const [simResult, setSimResult] = useState(null);
  const [finResult, setFinResult] = useState(null);
  const [optResult, setOptResult] = useState(null);
  const [sensiResult, setSensiResult] = useState(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState("");
  const [notice, setNotice]       = useState("");
  const [showHelp, setShowHelp]   = useState(false);
  const fileRef = useRef();

  // Dynamically load SheetJS for XLSX read/write
  useEffect(()=>{
    if(!window.XLSX){
      const s=document.createElement('script');
      s.src='https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
      document.head.appendChild(s);
    }
  },[]);

  const fmt  = (n,d=0)=>n==null?"N/A":Number(n).toLocaleString(undefined,{maximumFractionDigits:d});
  const fmtM = (n)=>n==null?"N/A":`${sym}${fmt(n)}`;

  const getData = useCallback(()=>{
    if (inputMode==="csv" && csvData) return csvData;
    if (inputMode==="manual") {
      const load=manualLoad.split(/[\n,\s]+/).map(Number).filter(n=>!isNaN(n)&&n>=0);
      const pv  =manualPv  .split(/[\n,\s]+/).map(Number).filter(n=>!isNaN(n)&&n>=0);
      if (load.length<10) throw new Error(`Enter ${timeRes==="hourly"?8760:365} values for Load and PV`);
      const n=Math.min(load.length,pv.length);
      return {load:load.slice(0,n), pv:pv.slice(0,n)};
    }
    throw new Error("No data loaded");
  },[inputMode,csvData,manualLoad,manualPv,timeRes]);

  // Build the tech param object passed to both simulateBESS and simulateFinancial
  const simP = () => ({
    chargeEff:        techP.chargeEff / 100,
    dischargeEff:     techP.dischargeEff / 100,
    initialSoc:       techP.initialSoc / 100,
    minSocPct:        techP.minSocPct / 100,
    maxChargeCrate:   techP.maxChargeCrate,
    maxDischargeCrate:techP.maxDischargeCrate,
  });

  const runSim = useCallback((cap, load, pv) => {
    const normalized = normalizeParams(finP);
    const periodsPerYear = timeRes === "hourly" ? 8760 : 365;
    // Per-period self-discharge fraction from monthly rate
    const selfDischargePerPeriod = normalized.selfDischargeMonthly > 0
      ? 1 - Math.pow(1 - normalized.selfDischargeMonthly / 100, 12 / periodsPerYear)
      : 0;
    const tp = { ...simP(), selfDischargePerPeriod };

    const tech = simulateBESS({ loadData:load, pvData:pv, capacityKwh:cap, ...tp });
    tech.monthly = aggregateMonthly(tech.periods, timeRes);
    if (!tech.monthly || tech.monthly.length===0) {
      tech.monthly = Array.from({length:12},(_,i)=>({month:MONTHS[i],pv:0,load:0,pvToLoad:0,pvToBess:0,bessToLoad:0,gridToLoad:0,curtailed:0,socPct:0}));
    }
    tech.monthlyBaseline = aggregateMonthlyBaseline(load, pv, timeRes);
    const fin = simulateFinancial({
      loadData:load, pvData:pv, capacityKwh:cap,
      ...tp, ...normalized,
      replacementYear: normalized.replacementYear || null,
    });
    return { tech, fin, tp, normalized };
  },[timeRes,techP,finP]);

  const handleOpt = () => {
    setLoading(true); setError("");
    setTimeout(() => {
      try {
        const {load, pv} = getData();
        const normalized = normalizeParams(finP);
        const periodsPerYear = timeRes === "hourly" ? 8760 : 365;
        const selfDischargePerPeriod = normalized.selfDischargeMonthly > 0
          ? 1 - Math.pow(1 - normalized.selfDischargeMonthly/100, 12/periodsPerYear) : 0;
        const tp = { ...simP(), selfDischargePerPeriod };
        const allParams = { ...tp, ...normalized, replacementYear: normalized.replacementYear || null };

        const opt = runOptimization({ loadData:load, pvData:pv, ...allParams });
        setOptResult(opt);
        const {tech, fin} = runSim(opt.optimalCap, load, pv);
        setSimResult(tech); setFinResult(fin); setSimCap(opt.optimalCap);

        // Sensitivity analysis at the optimal capacity
        const sensi = runSensitivity({ loadData:load, pvData:pv, ...allParams,
          capacityKwh:opt.optimalCap, baseNpv:fin.npv });
        setSensiResult(sensi);
        setTab("financial");
      } catch (e) { setError(e.message); }
      setLoading(false);
    }, 200);
  };

  const handleSim = () => {
    setLoading(true); setError("");
    setTimeout(() => { try {
      const {load,pv} = getData();
      const {tech,fin,tp,normalized} = runSim(simCap,load,pv);
      setSimResult(tech); setFinResult(fin);
      // Sensitivity at the manually chosen cap
      const allParams = { ...tp, ...normalized, replacementYear: normalized.replacementYear || null };
      const sensi = runSensitivity({ loadData:load, pvData:pv, ...allParams,
        capacityKwh:simCap, baseNpv:fin.npv });
      setSensiResult(sensi);
      setTab("simulation");
    } catch(e){setError(e.message);} setLoading(false); }, 60);
  };

  // ── EXPORT CSV ──
  const handleExportCSV = useCallback(async ()=>{
    if (!simResult){setError("Run a simulation first.");return;}
    const rows=simResult.periods;
    const tl=timeRes==="hourly"?"Hour":"Day";
    const hdr=[tl,"PV(kWh)","Load(kWh)","PV→Load(kWh)","PV→BESS(kWh)","BESS→Load(kWh)","Curtailed(kWh)",`Grid(kWh)`,`Grid(${sym})`,`SOC(kWh)`,`SOC(%)`];
    const lines=[hdr.join(",")];
    rows.forEach((r,i)=>{
      lines.push([i+1,r.pv,r.load,r.pvToLoad,r.pvToBess,r.bessToLoad,r.curtailed,r.gridToLoad,
        +(r.gridToLoad*finP.tariff).toFixed(4),r.soc,r.socPct].join(","));
    });
    const t=simResult.kpis;
    lines.push(["TOTAL",t.totalPv,t.totalLoad,t.totalPvToLoad,t.totalPvToBess,t.totalBessToLoad,
      t.totalCurtailed,t.totalGrid,+(t.totalGrid*finP.tariff).toFixed(2),"",""].join(","));
    const fname=`${(project.name||"BESS").replace(/\s+/g,"_")}_${timeRes==="hourly"?"8760h":"365d"}_data.csv`;
    const res=await electronSave(lines.join("\n"),fname,false);
    if (res.ok) setNotice(`✓ CSV saved: ${res.filePath||fname}`);
    else if (res.reason!=="canceled") setError(`Save failed: ${res.reason}`);
  },[simResult,finP,sym,project,timeRes]);

  // ── EXPORT XLSX ──
  const handleExportXLSX = useCallback(()=>{
    if (!simResult){setError("Run a simulation first.");return;}
    const XLSX=window.XLSX;
    if(!XLSX){setError("XLSX library not available in this environment. Use CSV export.");return;}
    const rows=simResult.periods;
    const tl=timeRes==="hourly"?"Hour":"Day";
    const hdr=[tl,"PV(kWh)","Load(kWh)","PV→Load","PV→BESS","BESS→Load","Curtailed",`Grid(kWh)`,`Grid(${sym})`,`SOC(kWh)`,`SOC(%)`];
    const data=[hdr];
    rows.forEach((r,i)=>data.push([i+1,r.pv,r.load,r.pvToLoad,r.pvToBess,r.bessToLoad,r.curtailed,r.gridToLoad,
      +(r.gridToLoad*finP.tariff).toFixed(4),r.soc,r.socPct]));
    const t=simResult.kpis;
    data.push(["TOTAL",t.totalPv,t.totalLoad,t.totalPvToLoad,t.totalPvToBess,t.totalBessToLoad,
      t.totalCurtailed,t.totalGrid,+(t.totalGrid*finP.tariff).toFixed(2),"",""]);
    const ws=XLSX.utils.aoa_to_sheet(data);
    const wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,ws,"Dispatch Data");
    if(finResult?.yearlyData?.length){
      const fhdr=["Year","Cap(%)","Effective Cap(kWh)","Grid Import(kWh)","Savings","O&M","Replacement","Net CF","Cum CF","Disc. Cum CF"];
      const fdata=[fhdr,...finResult.yearlyData.map(r=>[r.year,r.capPct,r.effectiveCap,r.annGridImport,r.savings,r.omCost,r.replacementCost,r.cf,r.cumCashFlow,r.discountedCumCF])];
      XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(fdata),"Financial");
    }
    const fname=`${(project.name||"BESS").replace(/[^a-zA-Z0-9]/g,"_")}_${timeRes==="hourly"?"8760h":"365d"}_data.xlsx`;
    XLSX.writeFile(wb,fname);
    setNotice(`✓ XLSX saved: ${fname}`);
  },[simResult,finResult,finP,sym,project,timeRes]);

  // ── EXPORT REPORT (HTML or PDF via print dialog) ──
  const generateReportHTML = () => {
    if (!simResult&&!finResult){setError("Run a simulation first.");return null;}
    const kpis=simResult?.kpis;
    const rows=finResult?.yearlyData||[];
    const c=sym;
    const fM=(n)=>n==null?"N/A":`${c}${Number(n).toLocaleString(undefined,{maximumFractionDigits:0})}`;
    const f=(n,d=1)=>n==null?"N/A":Number(n).toLocaleString(undefined,{maximumFractionDigits:d});
    const html=`<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><title>BESS Report — ${project.name||"Untitled"}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',Arial,sans-serif;font-size:14px;color:#1a1a2e;background:#fff;padding:30px 38px}
h2{font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#0a2040;margin:22px 0 12px;padding-bottom:5px;border-bottom:2px solid #22b05c}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:22px;padding-bottom:14px;border-bottom:3px solid #0a2040}
.hdr h1{font-size:22px;font-weight:800;color:#0a2040}
.tag{font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#1d6fa5;margin-bottom:5px}
.hdr-r{text-align:right;font-size:13px;color:#555;line-height:2}
.g4{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:16px}
.kpi{border:1px solid #dde;border-radius:7px;padding:12px 14px;border-left:4px solid #22b05c}
.kpi .v{font-size:20px;font-weight:800;color:#0a6630}
.kpi .l{font-size:10px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px}
th{background:#0a2040;color:#fff;padding:7px 10px;text-align:right;font-size:11px;text-transform:uppercase}
th:first-child,td:first-child{text-align:left}
td{padding:7px 10px;text-align:right;border-bottom:1px solid #f0f0f0}
.pos{color:#0a6630;font-weight:700}.neg{color:#c00;font-weight:700}
.good{color:#0a6630;font-weight:700}.bad{color:#c00}
.ar{display:flex;justify-content:space-between;padding:5px 10px;background:#f6f7fb;border-radius:3px;font-size:12px;margin-bottom:4px}
.concl{background:#f0fff6;border:1px solid #22b05c55;border-radius:7px;padding:16px;line-height:2;font-size:13px;margin-top:16px}
footer{margin-top:24px;padding-top:10px;border-top:1px solid #ddd;font-size:11px;color:#aaa;text-align:center}
@media print{body{padding:12mm 14mm}@page{size:A4;margin:0}}
</style></head><body>
<div class="hdr">
  <div>
    <div class="tag">BESS SIZING REPORT · BATTERY ENERGY STORAGE SYSTEM OPTIMIZER</div>
    <h1>${project.name||"Untitled Project"}</h1>
    ${project.client?`<div style="color:#1d6fa5;font-size:13px;margin-top:3px">${project.client}</div>`:""}
    ${project.location?`<div style="font-size:11px;color:#555;margin-top:2px">${project.location}</div>`:""}
  </div>
  <div class="hdr-r">
    ${project.date?`<div>Date: <b>${project.date}</b></div>`:""}
    ${project.preparedBy?`<div>By: <b>${project.preparedBy}</b></div>`:""}
    ${project.pvCapacity?`<div>PV: <b>${project.pvCapacity}</b></div>`:""}
    <div style="margin-top:5px;background:#e8fff2;display:inline-block;padding:2px 8px;border-radius:3px;font-weight:700;color:#0a6630">BESS: ${simCap} kWh</div>
  </div>
</div>
${kpis?`<h2>Technical Performance (${simCap} kWh BESS · ${timeRes==="hourly"?"8,760h":"365d"} dataset)</h2>
<div class="g4">
  <div class="kpi"><div class="v">${kpis.selfSufficiency}%</div><div class="l">Self-Sufficiency</div></div>
  <div class="kpi" style="border-left-color:#f0a500"><div class="v" style="color:#b06000">${kpis.pvUtilization}%</div><div class="l">PV Utilization</div></div>
  <div class="kpi" style="border-left-color:#e03020"><div class="v" style="color:#b02000">${f(kpis.totalGrid,0)} kWh</div><div class="l">Annual Grid Import</div></div>
  <div class="kpi" style="border-left-color:#9040c0"><div class="v" style="color:#702090">${f(kpis.totalCurtailed,0)} kWh</div><div class="l">PV Curtailed</div></div>
</div>
<table><thead><tr><th>Flow</th><th>kWh/yr</th><th>%</th></tr></thead><tbody>
  <tr><td>PV→Load</td><td>${f(kpis.totalPvToLoad,0)}</td><td>${f(kpis.totalPv>0?(kpis.totalPvToLoad/kpis.totalPv)*100:0,1)}% of PV</td></tr>
  <tr><td>PV→BESS</td><td>${f(kpis.totalPvToBess,0)}</td><td>${f(kpis.totalPv>0?(kpis.totalPvToBess/kpis.totalPv)*100:0,1)}% of PV</td></tr>
  <tr><td>BESS→Load</td><td>${f(kpis.totalBessToLoad,0)}</td><td>${f(kpis.totalLoad>0?(kpis.totalBessToLoad/kpis.totalLoad)*100:0,1)}% of load</td></tr>
  <tr><td>Grid→Load</td><td>${f(kpis.totalGrid,0)}</td><td>${f(kpis.totalLoad>0?(kpis.totalGrid/kpis.totalLoad)*100:0,1)}% of load</td></tr>
</tbody></table>`:""}
${finResult?`<h2>Financial Summary</h2>
<div class="g2">
  <div><table><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody>
    <tr><td>CAPEX</td><td><b>${fM(finResult.capex)}</b></td></tr>
    <tr><td>NPV (${finP.projectLife}yr, ${finP.discountRate}% WACC)</td><td class="${finResult.npv>=0?"pos":"neg"}">${fM(finResult.npv)}</td></tr>
    <tr><td>IRR</td><td>${finResult.irr!=null?finResult.irr+"%":"N/A"}</td></tr>
    <tr><td>Discounted Payback</td><td>${finResult.discountedPaybackYear?finResult.discountedPaybackYear+" yr":"&gt;"+finP.projectLife+" yr"}</td></tr><tr><td>Simple Payback</td><td>${finResult.paybackYear?finResult.paybackYear+" yr":"&gt;"+finP.projectLife+" yr"}</td></tr>
    <tr><td>LCOS</td><td>${finResult.lcos?c+finResult.lcos.toFixed(3)+"/kWh":"N/A"}</td></tr>
    <tr><td>Replacement</td><td>${finResult.replacementYear?"Year "+finResult.replacementYear:"None"}</td></tr>
  </tbody></table></div>
  <div>${[["Unit Cost",`${c}${finP.unitCost}/kWh`],["BOS+Install",`${finP.bosPercent}%`],["Life",`${finP.projectLife}yr`],["WACC",`${finP.discountRate}%`],["Tariff",`${c}${finP.tariff}/kWh`],["Tariff Escl.",`${finP.tariffEscalation}%/yr`],["O&M",`${c}${finP.omCost}/kWh/yr`],["O&M Escl.",`${finP.omEscalation}%/yr`],["EOL",`${finP.eolThreshold}%`],["Rep.Cost",`${finP.replacementCostRatio}% CAPEX`],["Chemistry",finP.chemistry],["Min SoC",`${techP.minSocPct}%`]].map(([l,v])=>`<div class="ar"><span>${l}</span><b>${v}</b></div>`).join("")}</div>
</div>
${rows.length>0?`<h2>Annual Cash Flow & Degradation</h2>
<table><thead><tr><th>Year</th><th>Cap(%)</th><th>Savings(${c})</th><th>O&M(${c})</th><th>Repl(${c})</th><th>CF(${c})</th><th>CumCF(${c})</th></tr></thead>
<tbody>${rows.map(r=>`<tr><td>Y${r.year}</td><td>${r.capPct}%</td><td>${f(r.savings,0)}</td><td>${f(r.omCost,0)}</td><td>${r.replacementCost>0?f(r.replacementCost,0):"—"}</td><td class="${r.cf>=0?"pos":"neg"}">${f(r.cf,0)}</td><td class="${r.cumCashFlow>=0?"pos":"neg"}">${f(r.cumCashFlow,0)}</td></tr>`).join("")}</tbody></table>`:""}
${(()=>{
  if(!simResult||!simResult.monthlyBaseline) return "";
  const bkpi=simResult.monthlyBaseline;
  const bGrid=bkpi.reduce((s,r)=>s+r.gridToLoad,0);
  const bPvToLoad=bkpi.reduce((s,r)=>s+r.pvToLoad,0);
  const bCurtailed=bkpi.reduce((s,r)=>s+r.curtailed,0);
  const bSelf=kpis.totalLoad>0?((kpis.totalLoad-bGrid)/kpis.totalLoad*100):0;
  const bPvUtil=kpis.totalPv>0?(bPvToLoad/kpis.totalPv*100):0;
  const cmpRows=[
    ["Self-Sufficiency",bSelf.toFixed(1)+"%",kpis.selfSufficiency.toFixed(1)+"%","+"+(kpis.selfSufficiency-bSelf).toFixed(1)+" pp",kpis.selfSufficiency>bSelf],
    ["PV Utilization",bPvUtil.toFixed(1)+"%",kpis.pvUtilization.toFixed(1)+"%","+"+(kpis.pvUtilization-bPvUtil).toFixed(1)+" pp",kpis.pvUtilization>bPvUtil],
    ["Grid Import (kWh/yr)",f(bGrid,0),f(kpis.totalGrid,0),"-"+f(bGrid-kpis.totalGrid,0)+" kWh",kpis.totalGrid<bGrid],
    ["Grid Cost/yr",c+f(bGrid*finP.tariff,0),c+f(kpis.totalGrid*finP.tariff,0),"-"+c+f((bGrid-kpis.totalGrid)*finP.tariff,0),kpis.totalGrid<bGrid],
    ["Annual Grid Savings","—",c+f((bGrid-kpis.totalGrid)*finP.tariff,0),c+f((bGrid-kpis.totalGrid)*finP.tariff,0)+" vs no BESS",true],
    ["PV Curtailed (kWh/yr)",f(bCurtailed,0),f(kpis.totalCurtailed,0),"-"+f(bCurtailed-kpis.totalCurtailed,0)+" kWh",kpis.totalCurtailed<bCurtailed],
  ];
  const tBody=cmpRows.map(function(r){return "<tr><td><b>"+r[0]+"</b></td><td>"+r[1]+"</td><td class="+(r[4]?"'pos'":"''")+">"  +r[2]+"</td><td class="+(r[4]?"'good'":"'bad'")+">"  +r[3]+"</td></tr>";}).join("");
  return "<h2>With vs Without BESS &#8212; Annual Comparison</h2><table><thead><tr><th>Metric</th><th style='color:#c04040'>Without BESS</th><th style='color:#208040'>With BESS ("+simCap+" kWh)</th><th style='color:#2060a0'>Improvement</th></tr></thead><tbody>"+tBody+"</tbody></table>";
})()}
<div class="concl"><b>Conclusion:</b> ${isOptimal
  ? `This analysis identifies a <b>${simCap} kWh</b> NPV-optimal BESS for <b>${project.name||"this project"}</b>.`
  : `This simulation evaluates a user-selected <b>${simCap} kWh BESS</b> for <b>${project.name||"this project"}</b>. Run <i>Find Optimal Size</i> for the economically optimal sizing.`}
Self-sufficiency <b>${kpis?.selfSufficiency}%</b>, PV utilization <b>${kpis?.pvUtilization}%</b>.
NPV <b>${fM(finResult.npv)}</b> over ${finP.projectLife} years, IRR <b>${finResult.irr!=null?finResult.irr+"%":"N/A"}</b>, discounted payback <b>${finResult.discountedPaybackYear?finResult.discountedPaybackYear+" years":"&gt;"+finP.projectLife+" years"}</b> (simple: ${finResult.paybackYear?finResult.paybackYear+" years":"&gt;"+finP.projectLife+" years"}).
${finResult.replacementYear?`Replacement in Year ${finResult.replacementYear} at approx. ${c}${Math.round(simCap*finP.unitCost*(finP.replacementCostRatio/100)).toLocaleString()}.`:""}
</div>`:""}
<footer>BESS Optimizer · ${new Date().toLocaleDateString()} · Open in browser → Print → Save as PDF</footer>
</body></html>`;
    return html;
  };
  const handleSaveHTML = useCallback(async ()=>{
    const html = generateReportHTML(); if(!html) return;
    const fname=`${(project.name||"BESS").replace(/\s+/g,"_")}_Report.html`;
    const res=await electronSave(html,fname,true);
    if (res.ok) setNotice(`✓ HTML report saved: ${res.filePath||fname}`);
    else if (res.reason!=="canceled") setError(`Save failed: ${res.reason}`);
  },[project,simResult,finResult,finP,techP,simCap,sym,timeRes]);
  const handleSavePDF = useCallback(()=>{
    const html = generateReportHTML(); if(!html) return;
    const win=window.open("","_blank");
    if(!win){setError("Pop-up blocked. Allow pop-ups to print as PDF.");return;}
    win.document.write(html); win.document.close();
    win.onload=()=>{ win.focus(); win.print(); };
    setNotice("✓ Report opened — use browser Print → Save as PDF");
  },[project,simResult,finResult,finP,techP,simCap,sym,timeRes]);

  // ─── STYLES ────────────────────────────────────────────────────────────────
  const S={
    root:{minHeight:"100vh",background:"#080c10",color:"#e6edf3",fontFamily:"'IBM Plex Mono','Courier New',monospace",paddingBottom:60},
    header:{background:"linear-gradient(135deg,#0d1117,#0a1628)",borderBottom:"1px solid #21262d",padding:"18px 32px 14px",display:"flex",justifyContent:"space-between",alignItems:"center"},
    logoIcon:{width:40,height:40,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"},
    tabs:{display:"flex",gap:2,background:"#0d1117",borderBottom:"1px solid #21262d",padding:"0 32px",overflowX:"auto"},
    tab:(a)=>({padding:"11px 16px",fontSize:12,letterSpacing:1,textTransform:"uppercase",cursor:"pointer",border:"none",background:"none",color:a?"#30d158":"#8b949e",borderBottom:a?"2px solid #30d158":"2px solid transparent",fontFamily:"inherit",whiteSpace:"nowrap"}),
    content:{padding:"22px 32px"},
    card:{background:"#0d1117",border:"1px solid #21262d",borderRadius:10,padding:18},
    cardTitle:{fontSize:12,letterSpacing:2,textTransform:"uppercase",color:"#8b949e",marginBottom:13},
    g2:{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16},
    g4:{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:13},
    kpi:(c)=>({background:"#0d1117",border:`1px solid ${c}22`,borderRadius:10,padding:"13px 14px",borderLeft:`3px solid ${c}`}),
    kpiV:(c)=>({fontSize:26,fontWeight:700,color:c,lineHeight:1}),
    kpiL:{fontSize:11,color:"#8b949e",letterSpacing:1.5,textTransform:"uppercase",marginTop:5},
    kpiS:{fontSize:11,color:"#6e7681",marginTop:3},
    label:{fontSize:12,color:"#8b949e",letterSpacing:1,textTransform:"uppercase",marginBottom:5,display:"block"},
    input:{background:"#161b22",border:"1px solid #30363d",borderRadius:6,color:"#e6edf3",padding:"8px 10px",fontSize:14,fontFamily:"inherit",width:"100%",outline:"none",boxSizing:"border-box"},
    textarea:{background:"#161b22",border:"1px solid #30363d",borderRadius:6,color:"#e6edf3",padding:"9px 10px",fontSize:13,fontFamily:"inherit",width:"100%",outline:"none",resize:"vertical",minHeight:68,boxSizing:"border-box"},
    btn:(c="#30d158")=>({background:`${c}18`,border:`1px solid ${c}`,color:c,padding:"9px 18px",borderRadius:6,cursor:"pointer",fontSize:12,letterSpacing:1,textTransform:"uppercase",fontFamily:"inherit"}),
    btnPrimary:{background:"linear-gradient(135deg,#30d158,#0aff6c)",border:"none",color:"#080c10",padding:"10px 22px",borderRadius:6,cursor:"pointer",fontSize:12,letterSpacing:1.5,textTransform:"uppercase",fontFamily:"inherit",fontWeight:700},
    modeBtn:(a)=>({padding:"7px 14px",fontSize:12,letterSpacing:1,cursor:"pointer",border:`1px solid ${a?"#30d158":"#30363d"}`,background:a?"#30d15822":"transparent",color:a?"#30d158":"#8b949e",borderRadius:5,fontFamily:"inherit"}),
    resBtn:(a)=>({padding:"7px 16px",fontSize:12,letterSpacing:1,cursor:"pointer",border:`1px solid ${a?"#58a6ff":"#30363d"}`,background:a?"#58a6ff22":"transparent",color:a?"#58a6ff":"#8b949e",borderRadius:5,fontFamily:"inherit",fontWeight:a?700:400}),
    rangRow:{display:"flex",alignItems:"center",gap:10},
    rangeVal:{minWidth:60,textAlign:"right",color:"#30d158",fontSize:13,fontWeight:700},
    divider:{border:"none",borderTop:"1px solid #21262d",margin:"18px 0"},
    badge:(c)=>({display:"inline-block",background:`${c}18`,border:`1px solid ${c}44`,color:c,borderRadius:4,padding:"2px 8px",fontSize:12,letterSpacing:1}),
    secTitle:{fontSize:11,color:"#58a6ff",letterSpacing:2,textTransform:"uppercase",marginBottom:10,marginTop:16},
    numInput:{background:"#161b22",border:"1px solid #30363d",borderRadius:6,color:"#e6edf3",padding:"7px 10px",fontSize:14,fontFamily:"inherit",width:"100%",outline:"none",boxSizing:"border-box"},
  };
  const COLORS={pv:"#f0a500",bess:"#30d158",ac:"#58a6ff",grid:"#ff453a",curtail:"#bf5af2"};
  const kpi=simResult?.kpis;
  // Pre-compute derived values used in JSX (avoids IIFEs in JSX which break some Babel builds)
  const isOptimal  = !!(optResult && simCap === optResult.optimalCap);
  const heroColor  = isOptimal ? "#30d158" : "#58a6ff";
  const heroBg     = isOptimal ? "linear-gradient(135deg,#30d15818,#0aff6c0a)" : "linear-gradient(135deg,#58a6ff14,#0aff6c0a)";
  const heroBorder = isOptimal ? "1px solid #30d15866" : "1px solid #58a6ff44";
  const bkpi = simResult?.monthlyBaseline ? {
    totalGrid:       simResult.monthlyBaseline.reduce((s,r)=>s+r.gridToLoad,0),
    totalPvToLoad:   simResult.monthlyBaseline.reduce((s,r)=>s+r.pvToLoad,0),
    totalCurtailed:  simResult.monthlyBaseline.reduce((s,r)=>s+r.curtailed,0),
    selfSufficiency: kpi&&kpi.totalLoad>0 ? ((kpi.totalLoad - simResult.monthlyBaseline.reduce((s,r)=>s+r.gridToLoad,0)) / kpi.totalLoad * 100) : 0,
    pvUtilization:   kpi&&kpi.totalPv>0   ? (simResult.monthlyBaseline.reduce((s,r)=>s+r.pvToLoad,0) / kpi.totalPv * 100) : 0,
  } : null;

  // ─── HELP DEFINITIONS ─────────────────────────────────────────────────────
  const HELP=[
    {group:"CAPEX & Investment",color:"#58a6ff",items:[
      {label:"BESS Unit Cost ($/kWh)",def:"Per-kWh purchase price including cells and BMS. The single largest cost driver.",typical:"$150–$450/kWh for Li-ion (2024). Falling ~8–12%/year.",link:"https://www.nrel.gov/docs/fy24osti/88461.pdf",linkLabel:"NREL Battery Cost Report"},
      {label:"BOS + Installation (%)",def:"Balance of System — inverters, wiring, civil works, commissioning, engineering.",typical:"15–35% depending on project scale and location.",link:"https://www.irena.org/Publications/2023/Aug/Renewable-Power-Generation-Costs-in-2022",linkLabel:"IRENA Cost Report"},
      {label:"Project Lifetime (years)",def:"Period over which costs and savings are evaluated. Match to operational life or financing term.",typical:"10–20 years for Li-ion BESS projects.",link:"https://www.energy.gov/eere/articles/how-long-do-batteries-last",linkLabel:"DOE — Battery Lifetimes"},
    ]},
    {group:"Electricity Tariff",color:"#30d158",items:[
      {label:"Grid Import Tariff ($/kWh)",def:"Unit price paid to import electricity. Determines the value of every kWh the BESS avoids.",typical:"Check your utility bill or national energy regulator.",link:"https://www.globalpetrolprices.com/electricity_prices/",linkLabel:"Global Electricity Prices"},
      {label:"Tariff Escalation (%/year)",def:"Expected annual electricity price increase. Higher escalation improves NPV.",typical:"2–6%/year in most markets.",link:"https://www.iea.org/reports/electricity-market-report-2024",linkLabel:"IEA Electricity Market Report"},
      {label:"Annual O&M ($/kWh/year)",def:"Ongoing maintenance per kWh installed — inspection, insurance, monitoring, repairs.",typical:"$3–$10/kWh/year for utility-scale Li-ion.",link:"https://www.lazard.com/research-insights/levelized-cost-of-energyplus/",linkLabel:"Lazard LCOE+ Report"},
      {label:"Discount Rate / WACC (%)",def:"Weighted Average Cost of Capital — reflects financing cost. Used to discount future cash flows.",typical:"5–12% for energy projects.",link:"https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/wacc.html",linkLabel:"Damodaran WACC Database"},
    ]},
    {group:"Replacement & EOL",color:"#f0a500",items:[
      {label:"EOL Capacity Threshold (%)",def:"End-of-Life declared when effective capacity falls below this % of nameplate. Triggers replacement.",typical:"70–80% of original capacity (industry standard).",link:"https://www.iec.ch/blog/batteries-iec-standards-ensure-safety-and-performance",linkLabel:"IEC Battery Standards"},
      {label:"Replacement Cost (% of CAPEX)",def:"Cost of replacing the battery at EOL as % of original CAPEX. Future prices expected lower.",typical:"50–70% of original CAPEX.",link:"https://about.bnef.com/blog/battery-pack-prices-hit-record-low-of-139-kwh/",linkLabel:"BNEF Battery Price Outlook"},
    ]},
    {group:"Degradation Model",color:"#bf5af2",items:[
      {label:"Calendar Aging (%/year)",def:"Annual capacity loss due to time — electrolyte decomposition and SEI layer growth. Affects even idle batteries.",typical:"LFP: 1.0–2.5%/yr. NMC: 2–4%/yr. Doubles per 10°C rise above 25°C.",link:"https://www.nature.com/articles/s41560-021-00827-4",linkLabel:"Nature — Battery Degradation Review"},
      {label:"Cycle Aging",def:"Capacity loss from charge/discharge cycling, computed via Rainflow cycle counting (ASTM E1049). Deeper cycles cause disproportionately more wear.",typical:"LFP: 3,000–6,000 cycles to 80% SoH at 30% DoD. Lead-Acid: 500–1,200 cycles.",link:"https://www.iec.ch/blog/batteries-iec-standards-ensure-safety-and-performance",linkLabel:"IEC Battery Cycling Standards"},
      {label:"Battery Chemistry",def:"Selects the degradation curve, calendar aging rate, self-discharge rate, and default RTE. Each chemistry has different temperature sensitivity and lifetime characteristics.",typical:"LFP for solar BESS (long life, safe). NMC for higher energy density. Lead-Acid for low-cost backup.",link:"https://batteryuniversity.com/article/bu-205-types-of-lithium-ion",linkLabel:"Battery University — Chemistry Comparison"},
    ]},
    {group:"Technical Parameters",color:"#30d158",items:[
      {label:"Charge / Discharge Efficiency (%)",def:"One-way terminal efficiency of the inverter/charger. Round-trip efficiency (RTE) = charge × discharge. Declines slightly with age via the efficiency regression.",typical:"Li-ion BESS: 94–97% one-way. Lead-Acid: 80–87%.",link:"https://www.irena.org/publications/2017/Mar/Electricity-storage-and-renewables-costs-and-markets",linkLabel:"IRENA — Storage Costs & Efficiency"},
      {label:"Initial SoC (%)",def:"State of Charge at the start of the simulation (year 1, period 1). Affects early-year dispatch but has negligible impact on annual totals.",typical:"50% is neutral. Use 80–100% if the battery starts fully charged after commissioning."},
      {label:"Minimum SoC (%)",def:"Hard discharge floor — the BESS will never discharge below this level. Protects cells from deep discharge damage.",typical:"10–20% for Li-ion. 40–50% for Lead-Acid (prevents sulfation).",link:"https://batteryuniversity.com/article/bu-214-summary-table-of-lead-based-batteries",linkLabel:"Battery University — Lead-Acid Limits"},
      {label:"Max Charge C-rate",def:"Maximum charge power as a multiple of capacity (1C = full charge in 1 hour). Limits how quickly PV surplus can be stored.",typical:"0.5C–1C for Li-ion BESS. Higher C-rates increase degradation.",link:"https://batteryuniversity.com/article/bu-501a-discharge-characteristics-of-li-ion",linkLabel:"Battery University — C-rate"},
      {label:"Max Discharge C-rate",def:"Maximum discharge power as a multiple of capacity. Limits peak power delivery to load.",typical:"0.5C–1C continuous. Some Li-ion support 2C peak for short durations."},
    ]},
    {group:"Financial Metrics",color:"#58a6ff",items:[
      {label:"NPV (Net Present Value)",def:"Sum of all discounted cash flows over the project life. Positive NPV means the project earns more than the cost of capital. The primary optimisation objective.",typical:"Positive NPV required for investment justification.",link:"https://www.investopedia.com/terms/n/npv.asp",linkLabel:"Investopedia — NPV"},
      {label:"IRR (Internal Rate of Return)",def:"The discount rate that makes NPV = 0. Compare to WACC: if IRR > WACC, the project creates value.",typical:"Energy storage projects: 6–15% IRR. Below WACC = value-destroying.",link:"https://www.investopedia.com/terms/i/irr.asp",linkLabel:"Investopedia — IRR"},
      {label:"LCOS (Levelised Cost of Storage)",def:"Present value of all costs divided by present value of all energy dispatched. Directly comparable to grid tariff.",typical:"Li-ion BESS: $0.10–$0.30/kWh (2024). Below tariff = economically viable.",link:"https://www.lazard.com/research-insights/levelized-cost-of-energyplus/",linkLabel:"Lazard LCOE+ Report"},
      {label:"Discounted Payback Period",def:"Year when cumulative discounted cash flows turn positive. Accounts for time value of money. Always longer than simple payback.",typical:"Solar BESS projects: 8–14 years discounted payback."},
      {label:"O&M Escalation (%/year)",def:"Annual inflation rate applied to O&M costs. Without escalation, lifetime O&M is underestimated by ~20% over 15 years at 2.5%.",typical:"2–3%/year — typically tracks general inflation."},
    ]},
  ];

  return (
    <div style={S.root}>
      {/* Header */}
      <div style={S.header}>
        <div style={{display:"flex",alignItems:"center",gap:11}}>
          <div style={S.logoIcon}>
            <svg width="40" height="40" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
              {/* Rounded background tile */}
              <rect x="1" y="1" width="38" height="38" rx="9" fill="#30d15814" stroke="#30d15830" strokeWidth="1"/>
              {/* Battery terminal cap */}
              <rect x="14" y="4" width="12" height="5" rx="2.5" fill="#30d158"/>
              {/* Battery body outline */}
              <rect x="6" y="8" width="28" height="29" rx="4" fill="none" stroke="#30d158" strokeWidth="1.8"/>
              {/* 4 charge-level bars (bottom to top, fading) */}
              <rect x="9"  y="31" width="22" height="4" rx="2" fill="#30d158" opacity="0.95"/>
              <rect x="9"  y="25" width="22" height="4" rx="2" fill="#30d158" opacity="0.65"/>
              <rect x="9"  y="19" width="22" height="4" rx="2" fill="#30d158" opacity="0.35"/>
              <rect x="9"  y="13" width="22" height="4" rx="2" fill="#30d158" opacity="0.15"/>
              {/* Solar accent — small sun at top-right corner */}
              <circle cx="34" cy="7" r="3.5" fill="#f0a500" opacity="0.9"/>
              <line x1="34" y1="1.5" x2="34" y2="3.5" stroke="#f0a500" strokeWidth="1.2" strokeLinecap="round"/>
              <line x1="38.5" y1="7" x2="36.5" y2="7" stroke="#f0a500" strokeWidth="1.2" strokeLinecap="round"/>
              <line x1="37.2" y1="3.8" x2="35.8" y2="5.2" stroke="#f0a500" strokeWidth="1.2" strokeLinecap="round"/>
              <line x1="37.2" y1="10.2" x2="35.8" y2="8.8" stroke="#f0a500" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </div>
          <div>
            <div style={{fontSize:18,fontWeight:700,color:"#fff"}}>BESS Sizing Tool</div>
            <div style={{fontSize:10,color:"#58a6ff",letterSpacing:3,textTransform:"uppercase",marginTop:2}}>BATTERY ENERGY STORAGE SYSTEM OPTIMIZER</div>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:11,color:"#8b949e",letterSpacing:1}}>CURRENCY</span>
          {["$","€"].map(c=>(
            <button key={c} onClick={()=>setCurrency(c)} style={{background:currency===c?"#30d15822":"transparent",border:`1px solid ${currency===c?"#30d158":"#30363d"}`,color:currency===c?"#30d158":"#8b949e",borderRadius:5,padding:"4px 13px",cursor:"pointer",fontSize:16,fontFamily:"inherit",fontWeight:700}}>{c}</button>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div style={S.tabs}>
        {[["project","01 · Project"],["data","02 · Data & Config"],["simulation","03 · Simulation"],["financial","04 · Financial Opt."],["export","05 · Data Export"],["report","06 · Report"]].map(([id,lbl])=>(
          <button key={id} style={S.tab(tab===id)} onClick={()=>setTab(id)}>{lbl}</button>
        ))}
      </div>

      <div style={S.content}>
        {/* Notices */}
        {error  &&<div style={{background:"#ff453a18",border:"1px solid #ff453a44",color:"#ff453a",padding:"8px 14px",borderRadius:6,marginBottom:12,fontSize:13,display:"flex",justifyContent:"space-between"}}><span>⚠ {error}</span><button onClick={()=>setError("")}  style={{background:"none",border:"none",color:"#ff453a",cursor:"pointer",fontSize:16}}>✕</button></div>}
        {notice &&<div style={{background:"#30d15818",border:"1px solid #30d15844",color:"#30d158",padding:"8px 14px",borderRadius:6,marginBottom:12,fontSize:13,display:"flex",justifyContent:"space-between"}}><span>{notice}</span><button onClick={()=>setNotice("")} style={{background:"none",border:"none",color:"#30d158",cursor:"pointer",fontSize:16}}>✕</button></div>}

        {/* ═══ TAB 1: PROJECT ═══ */}
        {tab==="project"&&(
          <div style={S.g2}>

            {/* ── Left: form ── */}
            <div>
              <div style={S.card}>
                <div style={S.cardTitle}>Project Information</div>
                <div style={{display:"grid",gap:12}}>
                  {[{k:"name",        l:"Project Name",             p:"e.g. Solar + BESS — Dar es Salaam Site A"},
                    {k:"client",      l:"Client / Company",         p:"e.g. Tanzania Energy Ltd."},
                    {k:"location",    l:"Project Location",         p:"e.g. Dar es Salaam, Tanzania"},
                    {k:"date",        l:"Date",                     p:"",t:"date"},
                    {k:"preparedBy",  l:"Prepared By",              p:"Engineer name or firm"},
                    {k:"pvCapacity",  l:"PV System Capacity (kWp)", p:"e.g. 500 kWp"},
                    {k:"loadDescription",l:"Load Description",      p:"e.g. Commercial — 24 h operation"},
                  ].map(({k,l,p,t})=>(
                    <div key={k}><label style={S.label}>{l}</label>
                      <input type={t||"text"} style={S.input} value={project[k]} placeholder={p}
                        onChange={e=>setProject(pr=>({...pr,[k]:e.target.value}))}/>
                    </div>
                  ))}
                  <div><label style={S.label}>Notes / Scope</label>
                    <textarea style={S.textarea} rows={3} value={project.notes}
                      placeholder="Describe scope, objectives, constraints..."
                      onChange={e=>setProject(p=>({...p,notes:e.target.value}))}/>
                  </div>
                </div>
              </div>

              {(project.name||project.client)&&(
                <div style={{...S.card,marginTop:14,background:"linear-gradient(135deg,#0d1117,#0a1628)",border:"1px solid #30d15844"}}>
                  <div style={S.cardTitle}>Project Summary</div>
                  {[["Project",project.name,"#fff"],["Client",project.client,"#58a6ff"],
                    ["Location",project.location,"#e6edf3"],["Date",project.date,"#e6edf3"],
                    ["Prepared By",project.preparedBy,"#f0a500"],["PV Capacity",project.pvCapacity,"#30d158"],
                    ["Load",project.loadDescription,"#8b949e"],
                  ].filter(([,v])=>v).map(([l,v,c])=>(
                    <div key={l} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0",borderBottom:"1px solid #161b22",fontSize:13}}>
                      <span style={{color:"#8b949e"}}>{l}</span>
                      <span style={{color:c,fontWeight:600,textAlign:"right",maxWidth:"65%",wordBreak:"break-word"}}>{v}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── Right: workflow guide + status ── */}
            <div style={{display:"flex",flexDirection:"column",gap:14}}>

              {/* Workflow steps */}
              <div style={S.card}>
                <div style={S.cardTitle}>Analysis Workflow</div>
                {[
                  {n:"01",tab:"data",   color:"#58a6ff",title:"Load & configure",  body:"Upload hourly or daily Load + PV data (CSV or XLSX). Set battery chemistry, technical parameters, and financial assumptions."},
                  {n:"02",tab:"simulation",color:"#30d158",title:"Run simulation", body:"Enter any BESS capacity and run a dispatch simulation to inspect energy flows, self-sufficiency, and annual degradation."},
                  {n:"03",tab:"financial",color:"#f0a500",title:"Find optimal size",body:"Run the optimizer to find the capacity that maximises NPV. Generates the sweep table, IRR/payback curves, and sensitivity tornado."},
                  {n:"04",tab:"report",  color:"#bf5af2",title:"Export & report",  body:"Download dispatch data as CSV or XLSX. Generate an HTML/PDF report with the with-vs-without comparison table."},
                ].map(({n,tab:t,color,title,body})=>(
                  <div key={n} onClick={()=>setTab(t)}
                    style={{display:"flex",gap:14,padding:"10px 0",borderBottom:"1px solid #161b22",cursor:"pointer",borderRadius:4,
                      transition:"background 0.15s"}}
                    onMouseEnter={e=>e.currentTarget.style.background="#ffffff08"}
                    onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                    <div style={{minWidth:32,height:32,borderRadius:8,background:`${color}18`,border:`1px solid ${color}44`,
                      display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,color,flexShrink:0}}>
                      {n}
                    </div>
                    <div>
                      <div style={{fontSize:13,fontWeight:600,color,marginBottom:3}}>{title}</div>
                      <div style={{fontSize:12,color:"#8b949e",lineHeight:1.6}}>{body}</div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Current session status */}
              <div style={S.card}>
                <div style={S.cardTitle}>Session Status</div>
                <div style={{display:"grid",gap:7}}>
                  {[
                    {label:"Data loaded",    ok:!!(csvData||(inputMode==="manual"&&manualLoad)), val:csvData?`${csvData.load.length.toLocaleString()} rows · ${timeRes}`:"—"},
                    {label:"Simulation run", ok:!!simResult, val:simResult?`${simCap} kWh · ${simResult.periods.length.toLocaleString()} periods`:"—"},
                    {label:"Optimised",      ok:!!optResult, val:optResult?`${optResult.optimalCap} kWh (NPV-optimal)`:"—"},
                    {label:"Chemistry",      ok:true,         val:finP.chemistry},
                    {label:"Project life",   ok:true,         val:`${finP.projectLife} yr · ${finP.discountRate}% WACC`},
                    {label:"Tariff",         ok:true,         val:`${sym}${finP.tariff}/kWh · +${finP.tariffEscalation}%/yr`},
                  ].map(({label,ok,val})=>(
                    <div key={label} style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                      padding:"5px 8px",background:"#161b22",borderRadius:5,fontSize:12}}>
                      <span style={{color:"#8b949e"}}>{label}</span>
                      <span style={{color:ok&&val!=="—"?"#30d158":"#6e7681",fontWeight:500}}>{val}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* About */}
              <div style={{...S.card,borderColor:"#30d15822"}}>
                <div style={S.cardTitle}>About</div>
                <div style={{fontSize:12,color:"#8b949e",lineHeight:1.8}}>
                  BESS Optimizer models grid-connected solar + storage systems using a four-engine chain: hourly dispatch, ASTM E1049 Rainflow degradation, 15-year DCF financials, and Golden Section Search capacity optimisation.
                </div>
                <div style={{marginTop:10,display:"flex",gap:8,flexWrap:"wrap"}}>
                  {[["Dispatch","#30d158"],["Degradation","#f0a500"],["Finance","#58a6ff"],["Optimisation","#bf5af2"]].map(([l,c])=>(
                    <span key={l} style={{...S.badge(c),fontSize:11}}>{l}</span>
                  ))}
                </div>
              </div>

            </div>
          </div>
        )}

        {/* ═══ TAB 2: DATA & CONFIG ═══ */}
        {tab==="data"&&(
          <div>
            <div style={S.g2}>
              <div style={S.card}>
                <div style={S.cardTitle}>Input Data</div>

                {/* Time resolution */}
                <div style={{marginBottom:14}}>
                  <label style={S.label}>Time Resolution</label>
                  <div style={{display:"flex",gap:8}}>
                    <button style={S.resBtn(timeRes==="hourly")}  onClick={()=>setTimeRes("hourly")}>Hourly · 8,760 pts/yr</button>
                    <button style={S.resBtn(timeRes==="daily")}   onClick={()=>setTimeRes("daily")}>Daily · 365 pts/yr</button>
                  </div>
                  <div style={{fontSize:11,color:"#6e7681",marginTop:5}}>
                    {timeRes==="daily"?"Daily totals (kWh/day). Fast simulation, suitable for initial sizing.":"Hourly values (kWh/hr). High-accuracy sub-daily dispatch. ~8,760 values per year."}
                  </div>
                </div>

                {/* Input mode */}
                <div style={{display:"flex",gap:8,marginBottom:14}}>
                  {[["csv","Upload File"],["manual","Manual Entry"]].map(([m,l])=>(
                    <button key={m} style={S.modeBtn(inputMode===m)} onClick={()=>setInputMode(m)}>{l}</button>
                  ))}
                </div>
                {inputMode==="csv"&&(
                  <div>
                    <div style={{border:"2px dashed #30363d",borderRadius:8,padding:20,textAlign:"center",cursor:"pointer"}} onClick={()=>fileRef.current?.click()}>
                      <div style={{fontSize:26,marginBottom:5}}>📂</div>
                      <div style={{color:"#58a6ff",fontSize:14}}>Click to upload CSV</div>
                      <div style={{color:"#8b949e",fontSize:12,marginTop:3}}>
                        Col 1: Load (kWh) · Col 2: PV (kWh) · CSV or XLSX · {timeRes==="daily"?"365 rows":"8,760 rows"}
                      </div>
                      <input ref={fileRef} type="file" accept=".csv,.txt,.xlsx,.xls" style={{display:"none"}} onChange={e=>{
                        const f=e.target.files[0]; if(!f)return;
                        const r=new FileReader();
                        if(f.name.endsWith('.xlsx')||f.name.endsWith('.xls')){
                          r.onload=(ev)=>{
                            try{
                              const XLSX=window.XLSX;
                              if(!XLSX){setError("XLSX library not loaded. Use CSV instead.");return;}
                              const wb=XLSX.read(ev.target.result,{type:'array'});
                              const ws=wb.Sheets[wb.SheetNames[0]];
                              const rows=XLSX.utils.sheet_to_json(ws,{header:1});
                              const start=isNaN(parseFloat(rows[0]?.[0]))?1:0;
                              const load=[],pv=[];
                              for(let i=start;i<rows.length;i++){
                                const l=parseFloat(rows[i]?.[0]),p=parseFloat(rows[i]?.[1]);
                                if(!isNaN(l)&&!isNaN(p)){load.push(l);pv.push(p);}
                              }
                              if(load.length<2){setError("Need at least 2 data rows");return;}
                              setCsvData({load,pv});setNotice(`✓ ${load.length} rows loaded from XLSX`);
                            }catch(e){setError("Failed to parse XLSX: "+e.message);}
                          };
                          r.readAsArrayBuffer(f);
                        }else{
                          r.onload=(ev)=>{try{const p=parseCSV(ev.target.result);if(p.load.length<2){setError("Need at least 2 rows");return;}setCsvData(p);setNotice(`✓ ${p.load.length} rows loaded`);}catch{setError("Failed to parse CSV");}};
                          r.readAsText(f);
                        }
                      }}/>
                    </div>
                    {csvData&&<div style={{marginTop:10}}><span style={S.badge("#30d158")}>✓ {csvData.load.length} rows loaded</span></div>}
                  </div>
                )}
                {inputMode==="manual"&&(
                  <div style={{display:"grid",gap:12}}>
                    <div style={{background:"#0d1117",borderRadius:6,padding:"8px 12px",fontSize:12,color:"#8b949e"}}>
                      {timeRes==="daily"?"Enter 365 daily values (Jan 1 → Dec 31), comma-separated or one per line.":"Enter 8,760 hourly values, comma-separated or one per line."}
                    </div>
                    <div><label style={S.label}>Load ({timeRes==="daily"?"kWh/day":"kWh/hr"})</label>
                      <textarea style={S.textarea} rows={4} value={manualLoad} placeholder={timeRes==="daily"?"12.5, 11.8, 13.2, ... (365 values)":"0.45, 0.40, 0.38, ... (8760 values)"} onChange={e=>setManualLoad(e.target.value)}/>
                    </div>
                    <div><label style={S.label}>PV Generation ({timeRes==="daily"?"kWh/day":"kWh/hr"})</label>
                      <textarea style={S.textarea} rows={4} value={manualPv} placeholder={timeRes==="daily"?"0, 0, 5.2, 8.1, ... (365 values)":"0, 0, 0, 0, 0, 0, 0.8, 2.1, ... (8760 values)"} onChange={e=>setManualPv(e.target.value)}/>
                    </div>
                  </div>
                )}
              </div>

              <div style={S.card}>
                <div style={S.cardTitle}>Technical BESS Parameters</div>
                <div style={{display:"grid",gap:13}}>
                  {[
                    {key:"chargeEff",        label:"Charge Efficiency",         min:70, max:100,step:1,  unit:"%", color:"#f0a500"},
                    {key:"dischargeEff",     label:"Discharge Efficiency",      min:70, max:100,step:1,  unit:"%", color:"#f0a500"},
                    {key:"initialSoc",       label:"Initial State of Charge",   min:0,  max:100,step:5,  unit:"%", color:"#bf5af2"},
                    {key:"minSocPct",        label:"Min SoC (discharge floor)", min:0,  max:40, step:5,  unit:"%", color:"#ff453a"},
                    {key:"maxChargeCrate",   label:"Max Charge C-rate",         min:0.2,max:3,  step:0.1,unit:"C", color:"#f0a500"},
                    {key:"maxDischargeCrate",label:"Max Discharge C-rate",      min:0.2,max:3,  step:0.1,unit:"C", color:"#58a6ff"},
                  ].map(({key,label,min,max,step,unit,color})=>(
                    <div key={key}><label style={S.label}>{label}</label>
                      <div style={S.rangRow}>
                        <input type="range" min={min} max={max} step={step} value={techP[key]} onChange={e=>setTechP(p=>({...p,[key]:Number(e.target.value)}))} style={{flex:1,accentColor:color}}/>
                        <span style={S.rangeVal}>{techP[key]}{unit}</span>
                      </div>
                    </div>
                  ))}
                  {/* Self-discharge info from chemistry */}
                  {(()=>{const m=CHEMISTRY_META[finP.chemistry];return m?(
                    <div style={{background:"#161b22",borderRadius:5,padding:"6px 10px",fontSize:11,color:"#8b949e",display:"flex",justifyContent:"space-between"}}>
                      <span>Self-discharge ({finP.chemistry})</span>
                      <span style={{color:"#58a6ff",fontWeight:700}}>{m.selfDischarge}%/month</span>
                    </div>
                  ):null;})()}
                </div>
              </div>
            </div>

            {/* Help modal */}
            {showHelp&&(
              <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",zIndex:1000,display:"flex",alignItems:"flex-start",justifyContent:"center",padding:"20px 16px",overflowY:"auto"}} onClick={e=>{if(e.target===e.currentTarget)setShowHelp(false)}}>
                <div style={{background:"#0d1117",border:"1px solid #30363d",borderRadius:12,width:"100%",maxWidth:740,padding:26}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
                    <div><div style={{fontSize:15,fontWeight:700,color:"#fff"}}>Financial Parameters Guide</div>
                      <div style={{fontSize:11,color:"#8b949e",marginTop:2,letterSpacing:1}}>DEFINITIONS · TYPICAL VALUES · REFERENCES</div>
                    </div>
                    <button onClick={()=>setShowHelp(false)} style={{background:"#21262d",border:"1px solid #30363d",color:"#8b949e",borderRadius:6,padding:"5px 11px",cursor:"pointer",fontSize:13,fontFamily:"inherit"}}>✕ Close</button>
                  </div>
                  {HELP.map(g=>(
                    <div key={g.group} style={{marginBottom:20}}>
                      <div style={{fontSize:11,color:g.color,letterSpacing:2,textTransform:"uppercase",marginBottom:10,paddingBottom:5,borderBottom:`1px solid ${g.color}33`}}>{g.group}</div>
                      <div style={{display:"grid",gap:10}}>
                        {g.items.map(item=>(
                          <div key={item.label} style={{background:"#161b22",borderRadius:7,padding:"11px 14px",borderLeft:`3px solid ${g.color}66`}}>
                            <div style={{fontSize:13,fontWeight:700,color:"#e6edf3",marginBottom:5}}>{item.label}</div>
                            <div style={{fontSize:13,color:"#c9d1d9",lineHeight:1.7,marginBottom:5}}>{item.def}</div>
                            {item.typical&&<div style={{fontSize:12,color:"#58a6ff",background:"#58a6ff0d",borderRadius:4,padding:"3px 8px",marginBottom:5}}>💡 {item.typical}</div>}
                            {item.link&&<a href={item.link} target="_blank" rel="noopener noreferrer" style={{fontSize:12,color:"#30d158",textDecoration:"none"}}>🔗 {item.linkLabel} ↗</a>}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Financial params */}
            <div style={{...S.card,marginTop:16}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                <div style={{fontSize:12,letterSpacing:2,textTransform:"uppercase",color:"#8b949e"}}>Financial Parameters</div>
                <button onClick={()=>setShowHelp(true)} style={{background:"#58a6ff18",border:"1px solid #58a6ff66",color:"#58a6ff",borderRadius:5,padding:"5px 13px",cursor:"pointer",fontSize:12,letterSpacing:1,fontFamily:"inherit"}}>
                  ? Parameter Help
                </button>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:18}}>
                <div>
                  <div style={S.secTitle}>CAPEX & Investment</div>
                  <div style={{display:"grid",gap:10}}>
                    <div><label style={S.label}>BESS Unit Cost ({sym}/kWh)</label><input type="number" style={S.numInput} value={finP.unitCost} onChange={e=>setFinP(p=>({...p,unitCost:Number(e.target.value)}))}/></div>
                    <div><label style={S.label}>BOS + Installation (%)</label><input type="number" style={S.numInput} value={finP.bosPercent} onChange={e=>setFinP(p=>({...p,bosPercent:Number(e.target.value)}))}/></div>
                    <div><label style={S.label}>Project Lifetime (yrs)</label><input type="number" style={S.numInput} value={finP.projectLife} onChange={e=>setFinP(p=>({...p,projectLife:Number(e.target.value)}))}/></div>
                  </div>
                </div>
                <div>
                  <div style={S.secTitle}>Electricity & O&M</div>
                  <div style={{display:"grid",gap:10}}>
                    <div><label style={S.label}>Grid Tariff ({sym}/kWh)</label><input type="number" step="0.01" style={S.numInput} value={finP.tariff} onChange={e=>setFinP(p=>({...p,tariff:Number(e.target.value)}))}/></div>
                    <div><label style={S.label}>Tariff Escalation (%/yr)</label><input type="number" style={S.numInput} value={finP.tariffEscalation} onChange={e=>setFinP(p=>({...p,tariffEscalation:Number(e.target.value)}))}/></div>
                    <div><label style={S.label}>Annual O&M ({sym}/kWh/yr)</label><input type="number" style={S.numInput} value={finP.omCost} onChange={e=>setFinP(p=>({...p,omCost:Number(e.target.value)}))}/></div>
                    <div><label style={S.label}>O&M Escalation (%/yr)</label>
                      <input type="number" step="0.5" style={S.numInput} value={finP.omEscalation} onChange={e=>setFinP(p=>({...p,omEscalation:Number(e.target.value)}))}/>
                      <div style={{fontSize:11,color:"#6e7681",marginTop:3}}>O&M costs rise with inflation each year</div>
                    </div>
                    <div><label style={S.label}>Discount Rate / WACC (%)</label><input type="number" style={S.numInput} value={finP.discountRate} onChange={e=>setFinP(p=>({...p,discountRate:Number(e.target.value)}))}/></div>
                  </div>
                </div>
                <div>
                  <div style={S.secTitle}>Replacement</div>
                  <div style={{display:"grid",gap:10}}>
                    <div><label style={S.label}>EOL Threshold (%)</label><input type="number" style={S.numInput} value={finP.eolThreshold} onChange={e=>setFinP(p=>({...p,eolThreshold:Number(e.target.value)}))}/></div>
                    <div><label style={S.label}>Replacement Cost (% CAPEX)</label><input type="number" style={S.numInput} value={finP.replacementCostRatio} onChange={e=>setFinP(p=>({...p,replacementCostRatio:Number(e.target.value)}))}/></div>
                    <div><label style={S.label}>Replacement Year (override)</label>
                      <input type="number" style={S.numInput} value={finP.replacementYear} placeholder={`Auto (EOL @ ${finP.eolThreshold}%)`} onChange={e=>setFinP(p=>({...p,replacementYear:e.target.value}))}/>
                      <div style={{fontSize:11,color:"#6e7681",marginTop:3}}>Blank = auto-detect from degradation</div>
                    </div>
                  </div>
                </div>
                <div>
                  <div style={S.secTitle}>Degradation Model</div>
                  <div style={{display:"grid",gap:10}}>
                    <div><label style={S.label}>Calendar Aging (%/yr)</label>
                      <input type="number" step="0.1" style={S.numInput} value={finP.calAgingRate} onChange={e=>setFinP(p=>({...p,calAgingRate:Number(e.target.value)}))}/>
                      <div style={{fontSize:11,color:"#6e7681",marginTop:3}}>At ~30°C ambient. Use 1.0%/yr for cool/controlled sites; 2.0-2.5%/yr for &gt;35°C (tropical)</div>
                    </div>
                    <div><label style={S.label}>Efficiency Regression w</label><input type="number" step="0.01" style={S.numInput} value={finP.effW} onChange={e=>setFinP(p=>({...p,effW:Number(e.target.value)}))}/></div>
                    <div><label style={S.label}>Efficiency Regression b</label><input type="number" step="0.01" style={S.numInput} value={finP.effB} onChange={e=>setFinP(p=>({...p,effB:Number(e.target.value)}))}/></div>
                    <div>
                      <label style={S.label}>Battery Chemistry</label>
                      <select style={S.numInput} value={finP.chemistry} onChange={e=>handleChemistryChange(e.target.value)}>
                        {Object.entries(CHEMISTRY_META).map(([k,v])=>(
                          <option key={k} value={k}>{v.label}</option>
                        ))}
                      </select>
                      <div style={{fontSize:11,color:"#6e7681",marginTop:3}}>Loads cycle curve, RTE, aging & self-discharge</div>
                      {CHEMISTRY_META[finP.chemistry]?.warning&&(
                        <div style={{marginTop:5,background:"#f0a50018",border:"1px solid #f0a50044",borderRadius:4,padding:"4px 8px",fontSize:11,color:"#f0a500"}}>
                          ⚠ {CHEMISTRY_META[finP.chemistry].warning}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <hr style={S.divider}/>
            <div style={{display:"flex",gap:14,alignItems:"flex-end",flexWrap:"wrap"}}>
              <div style={{flex:1,minWidth:220}}>
                <label style={S.label}>BESS Capacity for Single Simulation (kWh)</label>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <input
                    type="number" min={0} step={1}
                    value={simCap}
                    onChange={e=>setSimCap(Math.max(0,Number(e.target.value)))}
                    style={{...S.numInput,maxWidth:160,fontSize:16,fontWeight:700,color:"#30d158"}}
                    placeholder="e.g. 200"
                  />
                  <span style={{fontSize:13,color:"#8b949e"}}>kWh</span>
                </div>
              </div>
              <button style={S.btn("#58a6ff")} onClick={handleSim} disabled={loading}>{loading?"⏳ Running...":"▶ Run Simulation"}</button>
              <button style={S.btnPrimary} onClick={handleOpt} disabled={loading}>{loading?"⏳ Optimizing...":"Find Optimal Size (NPV)"}</button>
            </div>
          </div>
        )}

        {/* ═══ TAB 3: SIMULATION ═══ */}
        {tab==="simulation"&&simResult&&simResult.kpis&&simResult.monthly&&(
          <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div style={{fontSize:14,color:"#8b949e"}}>
                Simulation — <span style={{color:"#30d158",fontWeight:700}}>{simCap} kWh</span> BESS ·{" "}
                {simResult.periods.length.toLocaleString()} {timeRes==="hourly"?"hours":"days"} · aggregated monthly
              </div>
              <span style={S.badge("#30d158")}>{timeRes==="hourly"?"8,760h":"365d"} · annual totals</span>
            </div>
            <div style={{...S.g4,marginBottom:14}}>
              <div style={S.kpi("#30d158")}><div style={S.kpiV("#30d158")}>{kpi.selfSufficiency}%</div><div style={S.kpiL}>Self-Sufficiency</div><div style={S.kpiS}>{fmt(kpi.totalLoad,0)} kWh/yr load</div></div>
              <div style={S.kpi("#f0a500")}><div style={S.kpiV("#f0a500")}>{kpi.pvUtilization}%</div><div style={S.kpiL}>PV Utilization</div><div style={S.kpiS}>{fmt(kpi.totalPv,0)} kWh/yr PV</div></div>
              <div style={S.kpi("#ff453a")}><div style={S.kpiV("#ff453a")}>{fmt(kpi.totalGrid,0)}</div><div style={S.kpiL}>Grid Import kWh/yr</div><div style={S.kpiS}>{fmt((kpi.totalGrid/kpi.totalLoad)*100,1)}% of load</div></div>
              <div style={S.kpi("#bf5af2")}><div style={S.kpiV("#bf5af2")}>{fmt(kpi.totalCurtailed,0)}</div><div style={S.kpiL}>PV Curtailed kWh/yr</div><div style={S.kpiS}>{fmt(kpi.totalPv>0?(kpi.totalCurtailed/kpi.totalPv)*100:0,1)}% of PV</div></div>
            </div>
            {finResult&&(
              <div style={{...S.g4,marginBottom:14}}>
                <div style={S.kpi("#30d158")}><div style={S.kpiV("#30d158")}>{fmtM(finResult.npv)}</div><div style={S.kpiL}>Project NPV</div><div style={S.kpiS}>{finP.projectLife}yr · {finP.discountRate}% WACC</div></div>
                <div style={S.kpi("#58a6ff")}><div style={S.kpiV("#58a6ff")}>{finResult.irr!=null?`${finResult.irr}%`:"N/A"}</div><div style={S.kpiL}>IRR</div><div style={S.kpiS}>Internal rate of return</div></div>
                <div style={S.kpi("#f0a500")}>
                  <div style={S.kpiV("#f0a500")}>{finResult.discountedPaybackYear!=null?`${finResult.discountedPaybackYear} yrs`:`>${finP.projectLife}`}</div>
                  <div style={S.kpiL}>Discounted Payback</div>
                  <div style={S.kpiS}>Simple: {finResult.paybackYear!=null?`${finResult.paybackYear} yrs`:`>${finP.projectLife}`} · at {finP.discountRate}% WACC</div>
                </div>
                <div style={S.kpi("#bf5af2")}><div style={S.kpiV("#bf5af2")}>{finResult.lcos!=null?`${sym}${finResult.lcos.toFixed(3)}`:"N/A"}</div><div style={S.kpiL}>LCOS</div><div style={S.kpiS}>{sym}/kWh dispatched</div></div>
              </div>
            )}
            <div style={{...S.g2,marginBottom:14}}>
              <div style={S.card}>
                <div style={S.cardTitle}>Monthly Energy Flow — With BESS (kWh)</div>
                <ResponsiveContainer width="100%" height={230}>
                  <ComposedChart data={simResult.monthly||[]} margin={{top:5,right:14,bottom:5,left:0}}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#21262d"/>
                    <XAxis dataKey="month" stroke="#8b949e" tick={{fontSize:13,fontWeight:500}}/>
                    <YAxis stroke="#8b949e" tick={{fontSize:13,fontWeight:500}} unit="kWh"/>
                    <Tooltip content={<CTip/>}/>
                    <Legend wrapperStyle={{fontSize:13,fontWeight:500}}/>
                    <Bar dataKey="pvToLoad"   name="PV→Load"    stackId="a" fill={COLORS.pv}/>
                    <Bar dataKey="pvToBess"   name="PV→BESS"    stackId="a" fill={COLORS.bess}/>
                    <Bar dataKey="bessToLoad" name="BESS→Load"  stackId="a" fill={COLORS.ac}/>
                    <Bar dataKey="gridToLoad" name="Grid→Load"  stackId="a" fill={COLORS.grid}/>
                    <Bar dataKey="curtailed"  name="Curtailed"  stackId="a" fill={COLORS.curtail}/>
                    <Line dataKey="load" name="Load" dot={false} strokeWidth={2} stroke="#e6edf3" strokeDasharray="4 2"/>
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              <div style={S.card}>
                <div style={S.cardTitle}>Monthly Energy Flow — Without BESS (kWh)</div>
                <ResponsiveContainer width="100%" height={230}>
                  <ComposedChart data={simResult.monthlyBaseline||[]} margin={{top:5,right:14,bottom:5,left:0}}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#21262d"/>
                    <XAxis dataKey="month" stroke="#8b949e" tick={{fontSize:13,fontWeight:500}}/>
                    <YAxis stroke="#8b949e" tick={{fontSize:13,fontWeight:500}} unit="kWh"/>
                    <Tooltip content={<CTip/>}/>
                    <Legend wrapperStyle={{fontSize:13,fontWeight:500}}/>
                    <Bar dataKey="pvToLoad"   name="PV→Load (no BESS)"  stackId="b" fill={COLORS.pv}/>
                    <Bar dataKey="curtailed"  name="Curtailed (no BESS)" stackId="b" fill={COLORS.curtail}/>
                    <Bar dataKey="gridToLoad" name="Grid→Load (no BESS)" stackId="b" fill={COLORS.grid}/>
                    <Line dataKey="load" name="Load" dot={false} strokeWidth={2} stroke="#e6edf3" strokeDasharray="4 2"/>
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
            {finResult?.yearlyData?.length>0&&simResult?.monthly&&(
              <div style={S.card}>
                <div style={S.cardTitle}>Capacity Degradation & Annual Cash Flows</div>
                <ResponsiveContainer width="100%" height={200}>
                  <ComposedChart data={finResult.yearlyData} margin={{top:5,right:14,bottom:5,left:0}}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#21262d"/>
                    <XAxis dataKey="year" stroke="#8b949e" tick={{fontSize:13,fontWeight:500}} tickFormatter={v=>`Y${v}`}/>
                    <YAxis yAxisId="cap" stroke="#30d158" tick={{fontSize:13,fontWeight:500}} unit="%" domain={[0,110]}/>
                    <YAxis yAxisId="cf" orientation="right" stroke="#58a6ff" tick={{fontSize:13,fontWeight:500}} tickFormatter={v=>`${sym}${(v/1000).toFixed(0)}k`}/>
                    <Tooltip content={<CTip/>}/>
                    <Legend wrapperStyle={{fontSize:13,fontWeight:500}}/>
                    <ReferenceLine yAxisId="cap" y={finP.eolThreshold} stroke="#ff453a" strokeDasharray="4 2" label={{value:`EOL ${finP.eolThreshold}%`,fill:"#ff453a",fontSize:10}}/>
                    {finResult.replacementYear&&<ReferenceLine yAxisId="cap" x={finResult.replacementYear} stroke="#f0a500" strokeDasharray="4 2" label={{value:"Replace",fill:"#f0a500",fontSize:13}}/>}
                    <Area yAxisId="cap" type="monotone" dataKey="capPct" name="Capacity %" fill="#30d15818" stroke="#30d158" strokeWidth={2} dot={false}/>
                    <Bar yAxisId="cf" dataKey="cf" name={`CF (${sym})`} fill="#58a6ff" opacity={0.65}/>
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        )}
        {tab==="simulation"&&!simResult&&(
          <div style={{textAlign:"center",padding:"70px 0",color:"#8b949e"}}>
            <div style={{fontSize:36,marginBottom:12}}>🔋</div>
            <div>Go to <b style={{color:"#30d158"}}>Data & Config</b> → Run Simulation</div>
          </div>
        )}

        {/* ═══ TAB 4: FINANCIAL OPTIMIZATION ═══ */}
        {tab==="financial"&&optResult&&finResult&&(
          <div>
            <div style={{background:heroBg,border:heroBorder,borderRadius:10,padding:"14px 20px",marginBottom:16,display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
              <div>
                <div style={{fontSize:11,color:heroColor,letterSpacing:2,textTransform:"uppercase",marginBottom:4}}>
                  {isOptimal ? "NPV-Optimal BESS Size" : "📊 Simulated BESS Size"}
                </div>
                <div style={{fontSize:34,fontWeight:700,color:"#fff"}}>{simCap} <span style={{fontSize:15,color:"#8b949e"}}>kWh</span></div>
                <div style={{fontSize:11,color:"#8b949e",marginTop:3}}>{finP.projectLife}yr · {finP.discountRate}% WACC · CAPEX {fmtM(finResult.capex)}</div>
                <div style={{marginTop:7,display:"flex",gap:7,flexWrap:"wrap"}}>
                  {!isOptimal&&<span style={S.badge("#58a6ff")}>Optimal: {optResult.optimalCap} kWh — run ⚡ to apply</span>}
                  <span style={S.badge("#f0a500")}>CAPEX: {fmtM(finResult.capex)}</span>
                  {finResult.replacementYear&&<span style={S.badge("#bf5af2")}>Replacement: Y{finResult.replacementYear}</span>}
                  {finResult.npv<0&&<span style={S.badge("#ff453a")}>⚠ Negative NPV</span>}
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:9}}>
                {[["NPV",fmtM(finResult.npv),"#30d158"],["IRR",finResult.irr!=null?`${finResult.irr}%`:"N/A","#58a6ff"],["Disc. Payback",finResult.discountedPaybackYear?`${finResult.discountedPaybackYear} yrs`:`>${finP.projectLife}`,"#f0a500"],["LCOS",finResult.lcos?`${sym}${finResult.lcos.toFixed(3)}/kWh`:"N/A","#bf5af2"]].map(([l,v,c])=>(
                  <div key={l} style={{background:"#0d1117",borderRadius:7,padding:"8px 13px",minWidth:105}}>
                    <div style={{fontSize:15,fontWeight:700,color:c}}>{v}</div>
                    <div style={{fontSize:10,color:"#8b949e",letterSpacing:1,marginTop:2}}>{l}</div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{...S.g2,marginBottom:14}}>
              <div style={S.card}>
                <div style={S.cardTitle}>NPV vs BESS Capacity</div>
                <ResponsiveContainer width="100%" height={190}>
                  <ComposedChart data={optResult.curve} margin={{top:5,right:14,bottom:5,left:0}}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#21262d"/>
                    <XAxis dataKey="capacity" stroke="#8b949e" tick={{fontSize:13,fontWeight:500}} unit="kWh"/>
                    <YAxis stroke="#8b949e" tick={{fontSize:13,fontWeight:500}} tickFormatter={v=>`${sym}${(v/1000).toFixed(0)}k`}/>
                    <Tooltip content={<CTip/>}/>
                    <ReferenceLine x={optResult.optimalCap} stroke="#30d158" strokeWidth={2.5} strokeDasharray="6 3"/>
                    <ReferenceLine y={0} stroke="#ff453a" strokeWidth={2} strokeDasharray="6 3"/>
                    <Area type="monotone" dataKey="npv" name="NPV" fill="#30d15818" stroke="#30d158" strokeWidth={2} dot={false}/>
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              <div style={S.card}>
                <div style={S.cardTitle}>IRR & Payback vs Capacity</div>
                <ResponsiveContainer width="100%" height={190}>
                  <ComposedChart data={optResult.curve} margin={{top:5,right:14,bottom:5,left:0}}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#21262d"/>
                    <XAxis dataKey="capacity" stroke="#8b949e" tick={{fontSize:13,fontWeight:500}} unit="kWh"/>
                    <YAxis yAxisId="irr" stroke="#58a6ff" tick={{fontSize:13,fontWeight:500}} unit="%"/>
                    <YAxis yAxisId="pb" orientation="right" stroke="#f0a500" tick={{fontSize:13,fontWeight:500}} unit="yr"/>
                    <Tooltip content={<CTip/>}/>
                    <Legend wrapperStyle={{fontSize:13,fontWeight:500}}/>
                    <ReferenceLine yAxisId="irr" x={optResult.optimalCap} stroke="#30d158" strokeDasharray="4 2"/>
                    <Line yAxisId="irr" type="monotone" dataKey="irr" name="IRR(%)" stroke="#58a6ff" strokeWidth={2} dot={false} connectNulls/>
                    <Line yAxisId="pb" type="monotone" dataKey="payback" name="Payback(yr)" stroke="#f0a500" strokeWidth={2} dot={false} connectNulls/>
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div style={{...S.g2,marginBottom:14}}>
              <div style={S.card}>
                <div style={S.cardTitle}>Cumulative Cash Flow — Optimal Size</div>
                <ResponsiveContainer width="100%" height={230}>
                  <ComposedChart data={finResult.yearlyData} margin={{top:14,right:20,bottom:5,left:10}}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#21262d"/>
                    <XAxis dataKey="year" stroke="#8b949e" tick={{fontSize:13,fontWeight:500}} tickFormatter={v=>`Y${v}`}/>
                    <YAxis stroke="#8b949e" tick={{fontSize:13}} tickFormatter={v=>`${sym}${(v/1000).toFixed(0)}k`} width={56}/>
                    <Tooltip content={<CTip/>}/>
                    <ReferenceLine y={0} stroke="#ff453a" strokeWidth={2} strokeDasharray="6 3"/>
                    {finResult.discountedPaybackYear&&(
                      <ReferenceLine x={finResult.discountedPaybackYear} stroke="#30d158" strokeWidth={2} strokeDasharray="6 3"/>
                    )}
                    <Bar dataKey="cf" name="Net annual CF" fill="#30d158" opacity={0.82} radius={[3,3,0,0]}/>
                    <Line type="monotone" dataKey="cumCashFlow" name="Cumulative CF" stroke="#58a6ff" strokeWidth={3} dot={{r:3,fill:"#58a6ff"}} activeDot={{r:5}}/>
                  </ComposedChart>
                </ResponsiveContainer>
                <div style={{display:"flex",gap:20,marginTop:8,fontSize:12,color:"#8b949e",flexWrap:"wrap",alignItems:"center"}}>
                  <span style={{display:"flex",alignItems:"center",gap:6}}>
                    <span style={{display:"inline-block",width:14,height:14,background:"#30d158",borderRadius:3,opacity:0.82,flexShrink:0}}/>
                    <span>Net annual CF (savings − O&M − replacement)</span>
                  </span>
                  <span style={{display:"flex",alignItems:"center",gap:6}}>
                    <span style={{display:"inline-block",width:22,height:3,background:"#58a6ff",borderRadius:1,flexShrink:0}}/>
                    <span>Cumulative CF</span>
                  </span>
                  <span style={{display:"flex",alignItems:"center",gap:6}}>
                    <span style={{display:"inline-block",width:22,height:3,background:"#ff453a",borderRadius:1,flexShrink:0}}/>
                    <span>Break-even (y=0)</span>
                  </span>
                  {finResult.discountedPaybackYear&&(
                    <span style={{display:"flex",alignItems:"center",gap:6}}>
                      <span style={{display:"inline-block",width:22,height:3,background:"#30d158",borderRadius:1,flexShrink:0}}/>
                      <span>Discounted payback Y{finResult.discountedPaybackYear}</span>
                    </span>
                  )}
                </div>
              </div>
              <div style={S.card}>
                <div style={S.cardTitle}>Capacity Degradation Profile</div>
                <ResponsiveContainer width="100%" height={210}>
                  <AreaChart data={finResult.yearlyData} margin={{top:14,right:20,bottom:5,left:0}}>
                    <defs><linearGradient id="dg" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#30d158" stopOpacity={0.35}/><stop offset="95%" stopColor="#30d158" stopOpacity={0.02}/></linearGradient></defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#21262d"/>
                    <XAxis dataKey="year" stroke="#8b949e" tick={{fontSize:13,fontWeight:500}} tickFormatter={v=>`Y${v}`}/>
                    <YAxis stroke="#8b949e" tick={{fontSize:13,fontWeight:500}} unit="%" domain={[0,110]}/>
                    <Tooltip content={<CTip/>}/>
                    <ReferenceLine y={finP.eolThreshold} stroke="#ff453a" strokeWidth={3} strokeDasharray="6 3"/>
                    {finResult.replacementYear&&<ReferenceLine x={finResult.replacementYear} stroke="#f0a500" strokeWidth={2} strokeDasharray="4 2"/>}
                    <Area type="monotone" dataKey="capPct" name="Effective capacity %" fill="url(#dg)" stroke="#30d158" strokeWidth={2} dot={false}/>
                  </AreaChart>
                </ResponsiveContainer>
                <div style={{display:"flex",gap:20,marginTop:8,fontSize:12,color:"#6e7681",flexWrap:"wrap"}}>
                  <span style={{display:"flex",alignItems:"center",gap:6}}>
                    <span style={{display:"inline-block",width:20,height:3,background:"#30d158",borderRadius:1}}/>
                    <span>Effective capacity</span>
                  </span>
                  <span style={{display:"flex",alignItems:"center",gap:6}}>
                    <span style={{display:"inline-block",width:20,height:3,background:"#ff453a",borderRadius:1,opacity:0.85}}/>
                    <span>EOL threshold ({finP.eolThreshold}%)</span>
                  </span>
                  {finResult.replacementYear&&(
                    <span style={{display:"flex",alignItems:"center",gap:6}}>
                      <span style={{display:"inline-block",width:20,height:3,background:"#f0a500",borderRadius:1}}/>
                      <span>Battery replacement (Y{finResult.replacementYear})</span>
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div style={S.card}>
              <div style={S.cardTitle}>Optimization Sweep Table</div>
              <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                  <thead><tr style={{borderBottom:"1px solid #21262d"}}>
                    {[`kWh`,`CAPEX`,`NPV`,`IRR`,`Payback`,`LCOS`,`Self-Suff`,`PV Util`].map(h=>(
                      <th key={h} style={{padding:"6px 9px",color:"#8b949e",textAlign:"right",fontSize:11,letterSpacing:1,textTransform:"uppercase"}}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {optResult.curve.filter((_,i)=>i%Math.ceil(optResult.curve.length/16)===0||optResult.curve[i]?.capacity===optResult.optimalCap).map((row,i)=>{
                      const isOpt=row.capacity===optResult.optimalCap;
                      const cx=row.capacity*finP.unitCost*(1+finP.bosPercent/100);
                      return (
                        <tr key={i} style={{borderBottom:"1px solid #161b22",background:isOpt?"#30d15510":"transparent"}}>
                          <td style={{padding:"6px 9px",color:isOpt?"#30d158":"#e6edf3",fontWeight:isOpt?700:400,textAlign:"right"}}>{row.capacity}{isOpt&&" ⭐"}</td>
                          <td style={{padding:"6px 9px",color:"#8b949e",textAlign:"right"}}>{fmtM(cx)}</td>
                          <td style={{padding:"6px 9px",color:row.npv>0?"#30d158":"#ff453a",textAlign:"right",fontWeight:isOpt?700:400}}>{fmtM(row.npv)}</td>
                          <td style={{padding:"6px 9px",color:"#58a6ff",textAlign:"right"}}>{row.irr!=null?`${row.irr}%`:"—"}</td>
                          <td style={{padding:"6px 9px",color:"#f0a500",textAlign:"right"}}>{row.payback??`>${finP.projectLife}`}</td>
                          <td style={{padding:"6px 9px",color:"#bf5af2",textAlign:"right"}}>{row.lcos?`${sym}${row.lcos.toFixed(3)}`:"—"}</td>
                          <td style={{padding:"6px 9px",color:"#30d158",textAlign:"right"}}>{row.selfSuff}%</td>
                          <td style={{padding:"6px 9px",color:"#f0a500",textAlign:"right"}}>{row.pvUtil}%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ── SENSITIVITY / TORNADO CHART ── */}
            {sensiResult&&sensiResult.length>0&&(
              <div style={{...S.card,marginTop:14}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:13}}>
                  <div style={S.cardTitle}>Sensitivity Analysis — NPV Impact at ±20% Parameter Change</div>
                  <span style={S.badge("#8b949e")}>{simCap} kWh basis</span>
                </div>
                <div style={{display:"grid",gap:10}}>
                  {sensiResult.map((row,i)=>{
                    const maxAbs = Math.max(...sensiResult.map(r=>Math.max(Math.abs(r.lo),Math.abs(r.hi))));
                    const scale  = maxAbs > 0 ? 220 / maxAbs : 1;
                    const loW    = Math.abs(row.lo) * scale;
                    const hiW    = Math.abs(row.hi) * scale;
                    return (
                      <div key={i} style={{display:"grid",gridTemplateColumns:"160px 1fr",gap:12,alignItems:"center"}}>
                        <div style={{fontSize:13,color:"#8b949e",textAlign:"right",fontWeight:500}}>{row.label}</div>
                        <div style={{position:"relative",height:30}}>
                          <div style={{position:"absolute",left:"50%",top:0,bottom:0,width:1.5,background:"#444"}}/>
                          <div style={{position:"absolute",right:"50%",height:22,top:4,
                            width:loW, background:row.lo>=0?"#30d158":"#ff453a",opacity:0.75,
                            borderRadius:"4px 0 0 4px",display:"flex",alignItems:"center",justifyContent:"flex-start",paddingLeft:6}}>
                            {loW>44&&<span style={{fontSize:12,color:"#fff",whiteSpace:"nowrap",fontWeight:600}}>{row.lo>=0?"+":""}{fmtM(row.lo)}</span>}
                          </div>
                          <div style={{position:"absolute",left:"50%",height:22,top:4,
                            width:hiW, background:row.hi>=0?"#30d158":"#ff453a",opacity:0.75,
                            borderRadius:"0 4px 4px 0",display:"flex",alignItems:"center",justifyContent:"flex-end",paddingRight:6}}>
                            {hiW>44&&<span style={{fontSize:12,color:"#fff",whiteSpace:"nowrap",fontWeight:600}}>{row.hi>=0?"+":""}{fmtM(row.hi)}</span>}
                          </div>
                          {loW<=44&&row.lo!==0&&<div style={{position:"absolute",right:`calc(50% + ${loW}px + 4px)`,top:8,fontSize:12,color:row.lo>=0?"#30d158":"#ff453a",whiteSpace:"nowrap"}}>{row.lo>=0?"+":""}{fmtM(row.lo)}</div>}
                          {hiW<=44&&row.hi!==0&&<div style={{position:"absolute",left:`calc(50% + ${hiW}px + 4px)`,top:8,fontSize:12,color:row.hi>=0?"#30d158":"#ff453a",whiteSpace:"nowrap"}}>{row.hi>=0?"+":""}{fmtM(row.hi)}</div>}
                        </div>
                      </div>
                    );
                  })}
                  <div style={{display:"grid",gridTemplateColumns:"160px 1fr",gap:12,marginTop:4}}>
                    <div/>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#6e7681",paddingTop:2}}>
                      <span>← −20% worse NPV</span><span style={{color:"#444"}}>base</span><span>+20% better NPV →</span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
        {tab==="financial"&&!optResult&&finResult&&(
          <div>
            <div style={{background:"linear-gradient(135deg,#58a6ff18,#0aff6c0a)",border:"1px solid #58a6ff44",borderRadius:10,padding:"14px 20px",marginBottom:16,display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
              <div>
                <div style={{fontSize:11,color:"#58a6ff",letterSpacing:2,textTransform:"uppercase",marginBottom:4}}>📊 Simulated BESS Size</div>
                <div style={{fontSize:34,fontWeight:700,color:"#fff"}}>{simCap} <span style={{fontSize:15,color:"#8b949e"}}>kWh</span></div>
                <div style={{fontSize:11,color:"#8b949e",marginTop:3}}>{finP.projectLife}yr · {finP.discountRate}% WACC · CAPEX {fmtM(finResult.capex)}</div>
                <div style={{marginTop:7,display:"flex",gap:7,flexWrap:"wrap"}}>
                  <span style={S.badge("#8b949e")}>Manual simulation — run Find Optimal Size for NPV optimisation</span>
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:9}}>
                {[["NPV",fmtM(finResult.npv),"#30d158"],["IRR",finResult.irr!=null?`${finResult.irr}%`:"N/A","#58a6ff"],["Disc. Payback",finResult.discountedPaybackYear?`${finResult.discountedPaybackYear} yrs`:`>${finP.projectLife}`,"#f0a500"],["LCOS",finResult.lcos?`${sym}${finResult.lcos.toFixed(3)}/kWh`:"N/A","#bf5af2"]].map(([l,v,c])=>(
                  <div key={l} style={{background:"#0d1117",borderRadius:7,padding:"8px 13px",minWidth:105}}>
                    <div style={{fontSize:15,fontWeight:700,color:c}}>{v}</div>
                    <div style={{fontSize:10,color:"#8b949e",letterSpacing:1,marginTop:2}}>{l}</div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{...S.g2,marginBottom:14}}>
              <div style={S.card}>
                <div style={S.cardTitle}>Cumulative Cash Flow — {simCap} kWh</div>
                <ResponsiveContainer width="100%" height={230}>
                  <ComposedChart data={finResult.yearlyData} margin={{top:14,right:20,bottom:5,left:10}}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#21262d"/>
                    <XAxis dataKey="year" stroke="#8b949e" tick={{fontSize:13,fontWeight:500}} tickFormatter={v=>`Y${v}`}/>
                    <YAxis stroke="#8b949e" tick={{fontSize:13}} tickFormatter={v=>`${sym}${(v/1000).toFixed(0)}k`} width={56}/>
                    <Tooltip content={<CTip/>}/>
                    <ReferenceLine y={0} stroke="#ff453a" strokeWidth={2} strokeDasharray="6 3"/>
                    {finResult.discountedPaybackYear&&<ReferenceLine x={finResult.discountedPaybackYear} stroke="#30d158" strokeWidth={2} strokeDasharray="6 3"/>}
                    <Bar dataKey="cf" name="Net annual CF" fill="#30d158" opacity={0.82} radius={[3,3,0,0]}/>
                    <Line type="monotone" dataKey="cumCashFlow" name="Cumulative CF" stroke="#58a6ff" strokeWidth={3} dot={{r:3,fill:"#58a6ff"}} activeDot={{r:5}}/>
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              <div style={S.card}>
                <div style={S.cardTitle}>Capacity Degradation Profile</div>
                <ResponsiveContainer width="100%" height={210}>
                  <AreaChart data={finResult.yearlyData} margin={{top:14,right:20,bottom:5,left:0}}>
                    <defs><linearGradient id="dg2" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#30d158" stopOpacity={0.35}/><stop offset="95%" stopColor="#30d158" stopOpacity={0.02}/></linearGradient></defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#21262d"/>
                    <XAxis dataKey="year" stroke="#8b949e" tick={{fontSize:13,fontWeight:500}} tickFormatter={v=>`Y${v}`}/>
                    <YAxis stroke="#8b949e" tick={{fontSize:13,fontWeight:500}} unit="%" domain={[0,110]}/>
                    <Tooltip content={<CTip/>}/>
                    <ReferenceLine y={finP.eolThreshold} stroke="#ff453a" strokeWidth={3} strokeDasharray="6 3"/>
                    {finResult.replacementYear&&<ReferenceLine x={finResult.replacementYear} stroke="#f0a500" strokeWidth={2} strokeDasharray="4 2"/>}
                    <Area type="monotone" dataKey="capPct" name="Effective capacity %" fill="url(#dg2)" stroke="#30d158" strokeWidth={2} dot={false}/>
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
            {sensiResult&&sensiResult.length>0&&(
              <div style={{...S.card,marginTop:14}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:13}}>
                  <div style={S.cardTitle}>Sensitivity Analysis — NPV Impact at ±20% Parameter Change</div>
                  <span style={S.badge("#8b949e")}>{simCap} kWh basis</span>
                </div>
                <div style={{display:"grid",gap:10}}>
                  {sensiResult.map((row,i)=>{
                    const maxAbs=Math.max(...sensiResult.map(r=>Math.max(Math.abs(r.lo),Math.abs(r.hi))));
                    const scale=maxAbs>0?220/maxAbs:1;
                    const loW=Math.abs(row.lo)*scale, hiW=Math.abs(row.hi)*scale;
                    return (
                      <div key={i} style={{display:"grid",gridTemplateColumns:"160px 1fr",gap:12,alignItems:"center"}}>
                        <div style={{fontSize:13,color:"#8b949e",textAlign:"right",fontWeight:500}}>{row.label}</div>
                        <div style={{position:"relative",height:30}}>
                          <div style={{position:"absolute",left:"50%",top:0,bottom:0,width:1.5,background:"#444"}}/>
                          <div style={{position:"absolute",right:"50%",height:22,top:4,width:loW,background:row.lo>=0?"#30d158":"#ff453a",opacity:0.75,borderRadius:"4px 0 0 4px",display:"flex",alignItems:"center",justifyContent:"flex-start",paddingLeft:6}}>
                            {loW>44&&<span style={{fontSize:12,color:"#fff",whiteSpace:"nowrap",fontWeight:600}}>{row.lo>=0?"+":""}{fmtM(row.lo)}</span>}
                          </div>
                          <div style={{position:"absolute",left:"50%",height:22,top:4,width:hiW,background:row.hi>=0?"#30d158":"#ff453a",opacity:0.75,borderRadius:"0 4px 4px 0",display:"flex",alignItems:"center",justifyContent:"flex-end",paddingRight:6}}>
                            {hiW>44&&<span style={{fontSize:12,color:"#fff",whiteSpace:"nowrap",fontWeight:600}}>{row.hi>=0?"+":""}{fmtM(row.hi)}</span>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
        {tab==="financial"&&!optResult&&!finResult&&(
          <div style={{textAlign:"center",padding:"70px 0",color:"#8b949e"}}>
            <div style={{fontSize:36,marginBottom:12}}>💹</div>
            <div>Go to <b style={{color:"#30d158"}}>Data & Config</b> → Run Simulation or <b style={{color:"#30d158"}}>Find Optimal Size</b></div>
          </div>
        )}

        {/* ═══ TAB 5: DATA EXPORT ═══ */}
        {tab==="export"&&(
          <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
              <div>
                <div style={{fontSize:14,color:"#8b949e"}}>Energy dispatch data — {simResult?`${simResult.periods.length.toLocaleString()} ${timeRes==="hourly"?"hourly":"daily"} periods`:"no simulation yet"}</div>
                <div style={{fontSize:12,color:"#6e7681",marginTop:3}}>Downloads as .csv|.xlsx</div>
              </div>
              <div style={{display:"flex",gap:8}}>
                <button style={S.btn("#58a6ff")} onClick={handleExportCSV} disabled={!simResult}>
                  ⬇ Save CSV
                </button>
                <button style={S.btnPrimary} onClick={handleExportXLSX} disabled={!simResult}>
                  ⬇ Save XLSX
                </button>
              </div>
            </div>
            {!simResult&&(
              <div style={{textAlign:"center",padding:"60px 0",color:"#8b949e"}}>
                <div style={{fontSize:36,marginBottom:12}}>📊</div>
                <div>Run a simulation first</div>
              </div>
            )}
            {simResult&&(
              <div>
                <div style={{...S.g4,marginBottom:14}}>
                  {[
                    ["Annual PV",`${fmt(kpi.totalPv,0)} kWh`,"#f0a500"],
                    ["Annual Load",`${fmt(kpi.totalLoad,0)} kWh`,"#e6edf3"],
                    ["Annual Grid Import",`${fmt(kpi.totalGrid,0)} kWh`,"#ff453a"],
                    ["Annual Grid Cost",`${fmtM((kpi.totalGrid*finP.tariff).toFixed(0))}`,"#ff453a"],
                  ].map(([l,v,c])=>(
                    <div key={l} style={S.kpi(c)}><div style={S.kpiV(c)}>{v}</div><div style={S.kpiL}>{l}</div></div>
                  ))}
                </div>
                <div style={S.card}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:13}}>
                    <div style={S.cardTitle}>Monthly Aggregated Preview (full {timeRes} data in CSV)</div>
                    <div style={{display:"flex",gap:6}}>
                      <button style={S.btn("#8b949e")} onClick={handleExportCSV}>⬇ CSV</button>
                      <button style={S.btn("#30d158")} onClick={handleExportXLSX}>⬇ XLSX</button>
                    </div>
                  </div>
                  <div style={{overflowX:"auto"}}>
                    <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
                      <thead><tr style={{borderBottom:"1px solid #21262d"}}>
                        {["Month","PV(kWh)","Load(kWh)","PV→Load","PV→BESS","BESS→Load","Curtailed","Grid(kWh)",`Grid(${sym})`].map(h=>(
                          <th key={h} style={{padding:"7px 10px",color:"#8b949e",textAlign:"right",fontSize:11,letterSpacing:1,textTransform:"uppercase"}}>{h}</th>
                        ))}
                      </tr></thead>
                      <tbody>
                        {(simResult.monthly||[]).map((r,i)=>(
                          <tr key={i} style={{borderBottom:"1px solid #161b22",background:i%2===0?"#0d1117":"#0a0e14"}}>
                            <td style={{padding:"7px 10px",color:"#58a6ff",textAlign:"right",fontWeight:700}}>{r.month}</td>
                            <td style={{padding:"7px 10px",color:"#f0a500",textAlign:"right"}}>{fmt(r.pv,1)}</td>
                            <td style={{padding:"7px 10px",color:"#e6edf3",textAlign:"right"}}>{fmt(r.load,1)}</td>
                            <td style={{padding:"7px 10px",color:"#f0a500",textAlign:"right"}}>{fmt(r.pvToLoad,1)}</td>
                            <td style={{padding:"7px 10px",color:"#30d158",textAlign:"right"}}>{fmt(r.pvToBess,1)}</td>
                            <td style={{padding:"7px 10px",color:"#58a6ff",textAlign:"right"}}>{fmt(r.bessToLoad,1)}</td>
                            <td style={{padding:"7px 10px",color:"#bf5af2",textAlign:"right"}}>{fmt(r.curtailed,1)}</td>
                            <td style={{padding:"7px 10px",color:"#ff453a",textAlign:"right"}}>{fmt(r.gridToLoad,1)}</td>
                            <td style={{padding:"7px 10px",color:"#ff453a",textAlign:"right"}}>{sym}{(r.gridToLoad*finP.tariff).toFixed(1)}</td>
                          </tr>
                        ))}
                        <tr style={{borderTop:"2px solid #30d15844",background:"#0d1117",fontWeight:700}}>
                          <td style={{padding:"8px 10px",color:"#30d158",textAlign:"right"}}>TOTAL</td>
                          <td style={{padding:"8px 10px",color:"#f0a500",textAlign:"right"}}>{fmt(kpi.totalPv,0)}</td>
                          <td style={{padding:"8px 10px",color:"#e6edf3",textAlign:"right"}}>{fmt(kpi.totalLoad,0)}</td>
                          <td style={{padding:"8px 10px",color:"#f0a500",textAlign:"right"}}>{fmt(kpi.totalPvToLoad,0)}</td>
                          <td style={{padding:"8px 10px",color:"#30d158",textAlign:"right"}}>{fmt(kpi.totalPvToBess,0)}</td>
                          <td style={{padding:"8px 10px",color:"#58a6ff",textAlign:"right"}}>{fmt(kpi.totalBessToLoad,0)}</td>
                          <td style={{padding:"8px 10px",color:"#bf5af2",textAlign:"right"}}>{fmt(kpi.totalCurtailed,0)}</td>
                          <td style={{padding:"8px 10px",color:"#ff453a",textAlign:"right"}}>{fmt(kpi.totalGrid,0)}</td>
                          <td style={{padding:"8px 10px",color:"#ff453a",textAlign:"right"}}>{sym}{(kpi.totalGrid*finP.tariff).toFixed(0)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ═══ TAB 6: REPORT ═══ */}
        {tab==="report"&&(
          <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
              <div>
                <div style={{fontSize:14,color:"#8b949e"}}>Auto-generated HTML|PDF report</div>
              </div>
              <div style={{display:"flex",gap:8}}>
                <button style={S.btn("#58a6ff")} onClick={handleSaveHTML}>⬇ Save HTML</button>
                <button style={S.btnPrimary} onClick={handleSavePDF}>⬇ Save PDF</button>
              </div>
            </div>
            {(!simResult&&!finResult)&&(
              <div style={{textAlign:"center",padding:"50px 0",color:"#8b949e"}}>
                <div style={{fontSize:36,marginBottom:12}}>📄</div>
                <div>Run a simulation or optimization first</div>
              </div>
            )}
            {(simResult||finResult)&&(
              <div>
                <div style={{...S.card,marginBottom:14,background:"linear-gradient(135deg,#0d1117,#0a1628)",border:"1px solid #30d15844"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:14}}>
                    <div>
                      <div style={{fontSize:11,color:"#58a6ff",letterSpacing:3,textTransform:"uppercase",marginBottom:5}}>BESS SIZING REPORT</div>
                      <div style={{fontSize:22,fontWeight:700,color:"#fff"}}>{project.name||"Untitled Project"}</div>
                      {project.client&&<div style={{fontSize:14,color:"#58a6ff",marginTop:3}}>{project.client}</div>}
                      {project.location&&<div style={{fontSize:12,color:"#8b949e",marginTop:2}}>{project.location}</div>}
                    </div>
                    <div style={{textAlign:"right",fontSize:12,color:"#8b949e"}}>
                      {project.date&&<div>Date: <span style={{color:"#e6edf3"}}>{project.date}</span></div>}
                      {project.preparedBy&&<div>By: <span style={{color:"#e6edf3"}}>{project.preparedBy}</span></div>}
                      {project.pvCapacity&&<div>PV: <span style={{color:"#f0a500"}}>{project.pvCapacity}</span></div>}
                      <div style={{marginTop:5}}><span style={S.badge("#30d158")}>BESS: {simCap} kWh</span></div>
                    </div>
                  </div>
                  {project.notes&&<div style={{marginTop:10,padding:"8px 12px",background:"#161b22",borderRadius:6,fontSize:12,color:"#8b949e",lineHeight:1.7}}>{project.notes}</div>}
                </div>
                {simResult&&kpi&&(<>
                  <div style={{...S.card,marginBottom:14}}>
                    <div style={S.cardTitle}>Technical Performance — Annual Summary</div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
                      {[["Self-Sufficiency",`${kpi.selfSufficiency}%`,"#30d158","% of load without grid"],["PV Utilization",`${kpi.pvUtilization}%`,"#f0a500","% of PV on-site"],["Annual Grid Import",`${fmt(kpi.totalGrid,0)} kWh`,"#ff453a","kWh/year from grid"],["PV Curtailed",`${fmt(kpi.totalCurtailed,0)} kWh`,"#bf5af2","Excess PV not used"],["PV→Load",`${fmt(kpi.totalPvToLoad,0)} kWh`,"#f0a500","Direct PV to load"],["PV→BESS",`${fmt(kpi.totalPvToBess,0)} kWh`,"#30d158","Charged from PV"],["BESS→Load",`${fmt(kpi.totalBessToLoad,0)} kWh`,"#58a6ff","Discharged to load"],["Grid Cost/yr",`${sym}${fmt(kpi.totalGrid*finP.tariff,0)}`,"#ff453a","Annual grid spend"]].map(([l,v,c,h])=>(
                        <div key={l} style={{background:"#161b22",borderRadius:7,padding:"10px 12px",borderLeft:`3px solid ${c}33`}}>
                          <div style={{fontSize:16,fontWeight:700,color:c}}>{v}</div>
                          <div style={{fontSize:11,color:"#8b949e",letterSpacing:1,marginTop:3,textTransform:"uppercase"}}>{l}</div>
                          <div style={{fontSize:11,color:"#6e7681",marginTop:2}}>{h}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                  {bkpi&&(
                  <div style={{...S.card,marginBottom:14,borderColor:"#30d15833"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                      <div style={S.cardTitle}>With vs Without BESS — Annual Comparison</div>
                      <span style={S.badge("#30d158")}>{simCap} kWh {finP.chemistry}</span>
                    </div>
                    <div style={{overflowX:"auto"}}>
                      <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
                        <thead>
                          <tr style={{borderBottom:"2px solid #21262d"}}>
                            <th style={{padding:"8px 12px",color:"#8b949e",textAlign:"left",fontSize:11,letterSpacing:1,textTransform:"uppercase",fontWeight:400}}>Metric</th>
                            <th style={{padding:"8px 12px",color:"#ff453a",textAlign:"right",fontSize:11,letterSpacing:1,textTransform:"uppercase",fontWeight:400}}>Without BESS</th>
                            <th style={{padding:"8px 12px",color:"#30d158",textAlign:"right",fontSize:11,letterSpacing:1,textTransform:"uppercase",fontWeight:400}}>With BESS</th>
                            <th style={{padding:"8px 12px",color:"#58a6ff",textAlign:"right",fontSize:11,letterSpacing:1,textTransform:"uppercase",fontWeight:400}}>Improvement</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[
                            {
                              label:"Self-Sufficiency",
                              wo:bkpi.selfSufficiency.toFixed(1)+"%",
                              wi:kpi.selfSufficiency.toFixed(1)+"%",
                              delta:"+"+(kpi.selfSufficiency-bkpi.selfSufficiency).toFixed(1)+" pp",
                              good:kpi.selfSufficiency>bkpi.selfSufficiency,
                            },{
                              label:"PV Utilization",
                              wo:bkpi.pvUtilization.toFixed(1)+"%",
                              wi:kpi.pvUtilization.toFixed(1)+"%",
                              delta:"+"+(kpi.pvUtilization-bkpi.pvUtilization).toFixed(1)+" pp",
                              good:kpi.pvUtilization>bkpi.pvUtilization,
                            },{
                              label:"Grid Import (kWh/yr)",
                              wo:fmt(bkpi.totalGrid,0),
                              wi:fmt(kpi.totalGrid,0),
                              delta:"-"+fmt(bkpi.totalGrid-kpi.totalGrid,0)+" kWh",
                              good:kpi.totalGrid<bkpi.totalGrid,
                            },{
                              label:"Grid Cost/yr",
                              wo:`${sym}${fmt(bkpi.totalGrid*finP.tariff,0)}`,
                              wi:`${sym}${fmt(kpi.totalGrid*finP.tariff,0)}`,
                              delta:`-${sym}${fmt((bkpi.totalGrid-kpi.totalGrid)*finP.tariff,0)}`,
                              good:kpi.totalGrid<bkpi.totalGrid,
                            },{
                              label:"Annual Grid Savings",
                              wo:"—",
                              wi:`${sym}${fmt((bkpi.totalGrid-kpi.totalGrid)*finP.tariff,0)}`,
                              delta:"vs no storage",
                              good:true,
                            },{
                              label:"PV Curtailed (kWh/yr)",
                              wo:fmt(bkpi.totalCurtailed,0),
                              wi:fmt(kpi.totalCurtailed,0),
                              delta:"-"+fmt(bkpi.totalCurtailed-kpi.totalCurtailed,0)+" kWh",
                              good:kpi.totalCurtailed<bkpi.totalCurtailed,
                            },{
                              label:"PV→Load Direct (kWh/yr)",
                              wo:fmt(bkpi.totalPvToLoad,0),
                              wi:fmt(kpi.totalPvToLoad,0),
                              delta:kpi.totalPvToLoad>=bkpi.totalPvToLoad?"+"+fmt(kpi.totalPvToLoad-bkpi.totalPvToLoad,0)+" kWh":"-"+fmt(bkpi.totalPvToLoad-kpi.totalPvToLoad,0)+" kWh",
                              good:true,
                            },
                          ].map((r,i)=>(
                            <tr key={i} style={{borderBottom:"1px solid #161b22",background:i%2===0?"#0d1117":"transparent"}}>
                              <td style={{padding:"8px 12px",color:"#e6edf3",fontWeight:500}}>{r.label}</td>
                              <td style={{padding:"8px 12px",color:"#ff453a",textAlign:"right"}}>{r.wo}</td>
                              <td style={{padding:"8px 12px",color:"#30d158",textAlign:"right",fontWeight:600}}>{r.wi}</td>
                              <td style={{padding:"8px 12px",color:r.good?"#58a6ff":"#f0a500",textAlign:"right",fontWeight:600}}>{r.delta}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {finResult&&(
                      <div style={{marginTop:12,padding:"10px 14px",background:"#161b22",borderRadius:6,borderLeft:"3px solid #30d158"}}>
                        <div style={{fontSize:11,color:"#8b949e",letterSpacing:1,textTransform:"uppercase",marginBottom:4}}>Financial Impact of Adding {simCap} kWh BESS</div>
                        <div style={{display:"flex",gap:20,flexWrap:"wrap",fontSize:13}}>
                          <span>CAPEX: <b style={{color:"#f0a500"}}>{fmtM(finResult.capex)}</b></span>
                          <span>NPV: <b style={{color:finResult.npv>=0?"#30d158":"#ff453a"}}>{fmtM(finResult.npv)}</b></span>
                          <span>Disc. Payback: <b style={{color:"#58a6ff"}}>{finResult.discountedPaybackYear?finResult.discountedPaybackYear+" yrs":">"+finP.projectLife+" yrs"}</b></span>
                          <span>LCOS: <b style={{color:"#bf5af2"}}>{finResult.lcos?`${sym}${finResult.lcos.toFixed(3)}/kWh`:"N/A"}</b></span>
                        </div>
                      </div>
                    )}
                  </div>
                  )}
                </>)}
                {finResult&&(
                  <div style={{...S.card,marginBottom:14}}>
                    <div style={S.cardTitle}>Financial Summary</div>
                    <div style={S.g2}>
                      <div style={{display:"grid",gap:6}}>
                        {[["BESS Capacity",`${simCap} kWh`,"#30d158"],["Total CAPEX",fmtM(finResult.capex),"#f0a500"],["Project NPV",fmtM(finResult.npv),finResult.npv>=0?"#30d158":"#ff453a"],["IRR",finResult.irr!=null?`${finResult.irr}%`:"N/A","#58a6ff"],["Discounted Payback",finResult.discountedPaybackYear?`${finResult.discountedPaybackYear} years`:`>${finP.projectLife} years`,"#f0a500"],["Simple Payback",finResult.paybackYear?`${finResult.paybackYear} years`:`>${finP.projectLife} years`,"#8b949e"],["LCOS",finResult.lcos?`${sym}${finResult.lcos.toFixed(3)}/kWh`:"N/A","#bf5af2"],["Replacement Year",finResult.replacementYear?`Year ${finResult.replacementYear}`:"None within project life","#ff453a"]].map(([l,v,c])=>(
                          <div key={l} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 10px",background:"#161b22",borderRadius:5}}>
                            <span style={{fontSize:12,color:"#8b949e"}}>{l}</span>
                            <span style={{fontSize:14,fontWeight:700,color:c}}>{v}</span>
                          </div>
                        ))}
                      </div>
                      <div>
                        <div style={{fontSize:11,color:"#8b949e",letterSpacing:2,textTransform:"uppercase",marginBottom:8}}>Operational &amp; Financial Data</div>
                        <div style={{display:"grid",gap:4,fontSize:12}}>
                          {[["BESS Unit Cost",`${sym}${finP.unitCost}/kWh`],["BOS+Install",`${finP.bosPercent}%`],["Project Life",`${finP.projectLife}yr`],["WACC",`${finP.discountRate}%`],["Grid Tariff",`${sym}${finP.tariff}/kWh`],["Tariff Escl.",`${finP.tariffEscalation}%/yr`],["O&M",`${sym}${finP.omCost}/kWh/yr`],["O&M Escl.",`${finP.omEscalation}%/yr`],["EOL",`${finP.eolThreshold}%`],["Replacement",`${finP.replacementCostRatio}% CAPEX`],["Chemistry",finP.chemistry]].map(([l,v])=>(
                            <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"3px 8px",background:"#0d1117",borderRadius:3}}>
                              <span style={{color:"#6e7681"}}>{l}</span><span style={{color:"#e6edf3"}}>{v}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                <div style={{...S.card,border:"1px solid #30d15844"}}>
                  <div style={S.cardTitle}>Conclusion & Recommendation</div>
                  <div style={{fontSize:13,color:"#e6edf3",lineHeight:1.9}}>
                    {finResult&&kpi&&(<>
                      <p style={{margin:"0 0 8px"}}>
                        {isOptimal
                          ? <>This analysis identifies <b style={{color:"#30d158"}}>{simCap} kWh</b> as the NPV-optimal BESS size for <b>{project.name||"this project"}</b>.</>
                          : <>This simulation evaluates a user-selected <b style={{color:"#58a6ff"}}>{simCap} kWh BESS</b> for <b>{project.name||"this project"}</b>. To find the economically optimal size, run <b>Find Optimal Size</b>.</>
                        }{" "}The system achieves <b style={{color:"#30d158"}}>{kpi.selfSufficiency}%</b> self-sufficiency and utilizes <b style={{color:"#f0a500"}}>{kpi.pvUtilization}%</b> of available annual PV generation.
                      </p>
                      <p style={{margin:"0 0 8px"}}>The project yields an NPV of <b style={{color:finResult.npv>=0?"#30d158":"#ff453a"}}>{fmtM(finResult.npv)}</b> over {finP.projectLife} years at a {finP.discountRate}% discount rate, IRR of <b style={{color:"#58a6ff"}}>{finResult.irr!=null?`${finResult.irr}%`:"N/A"}</b> and payback of <b style={{color:"#f0a500"}}>{finResult.paybackYear?`${finResult.paybackYear} years`:`>${finP.projectLife} years`}</b>.</p>
                      {finResult.replacementYear&&<p style={{margin:0}}>Battery replacement projected in <b style={{color:"#bf5af2"}}>Year {finResult.replacementYear}</b> at approx. {sym}{fmt(simCap*finP.unitCost*(finP.replacementCostRatio/100))}, included in NPV.</p>}
                    </>)}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
