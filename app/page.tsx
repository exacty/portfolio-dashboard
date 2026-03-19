"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type Market = "no" | "us" | "uk" | "dk";
type Currency = "NOK" | "USD" | "GBX" | "DKK";
type SignalKind = "p" | "n" | "w" | "i";
type FilterKey = "all" | "sell" | "buy" | "uk-infra" | "reit" | "growth";
type SortDir = "desc" | "asc";
type Impact = "bull" | "bear" | "neutral";

type Position = {
  tk: string;
  name: string;
  mkt: Market;
  price: number;
  cur: Currency;
  chg: number;
  eur: number;
  pct: number;
  ret: number;
  score: number;
  sigs: string[];
  sigT: SignalKind[];
  spark: number[];
  rsi: number;
  rsiCtx: string;
  pe: string;
  fpe: string;
  div: number;
  cat: string;
  flagged?: boolean;
  target?: number;
  stop_loss?: number;
  tees?: string;
};

type Sector = { name: string; pct: number; color: string };
type NewsItem = { time: string; headline: string; impact: Impact; tag: string };
type EarningItem = { date: string; tk: string; name: string; est: string };
type AlertSeverity = "critical" | "warning" | "success";
type AlertVariant = "danger" | "amber" | "primary";
type AlertItem = {
  ticker: string;
  severity: AlertSeverity;
  message: string;
  messageIsHtml?: boolean;
  buttonLabel: string;
  buttonVariant: AlertVariant;
};

type Kpis = {
  portfolioTotal?: number;
  dayChgEur?: number;
  dayChgPct?: number;
  unrealizedPnl?: number;
  unrealizedPnlPct?: number;
  costBasisEur?: number;
  divYield?: number;
  divYearlyEur?: number;
  divMonthlyEur?: number;
  beta?: number;
  sharpe?: number;
  concentration?: number;
  attention?: number;
};

type MacroItem = { label: string; value: string; raw?: number; chg?: number; chgText?: string };

type PortfolioResponse = {
  generatedAt?: string;
  positions: Position[];
  sectors_allocation: Sector[];
  correlation: { tickers: string[]; matrix: number[][] };
  news: NewsItem[];
  earnings: EarningItem[];
  data_quality?: Record<string, { chosenSource?: string; lastMedian?: number }>;
  kpis?: Kpis;
  macro?: { items: MacroItem[] };
};

type Candle = { time: number; open: number; high: number; low: number; close: number };
type TickerHistoryResponse = {
  ticker: string;
  range?: string;
  chosenSource?: string;
  lastMedian?: number;
  candidates?: Array<{ source: string; lastClose: number; len: number }>;
  candles: Candle[];
};

type AiAnalyzeResponse = {
  ticker: string;
  signal: "OST" | "MÜÜ" | "HOIA" | string;
  score: number;
  target: number;
  stop_loss: number;
  sigs: string[];
  sigT: SignalKind[];
  rationaleHtml: string;
};

type AiChatResponse = { replyHtml: string };
type ChatMessage = { role: "user" | "ai"; text?: string; html?: string };

const styles = `
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#06080d;--bg2:#0b0e16;--bg3:#10141f;--bg4:#161b2a;--bg5:#1c2235;
  --border:#1a1f32;--border2:#252b42;
  --t1:#e8e6df;--t2:#9a98a0;--t3:#5c5a66;--t4:#3a3844;
  --green:#00d68f;--green2:#00b377;--green-bg:rgba(0,214,143,0.06);--green-border:rgba(0,214,143,0.15);
  --red:#ff4757;--red2:#e63e4f;--red-bg:rgba(255,71,87,0.06);--red-border:rgba(255,71,87,0.15);
  --amber:#ffb830;--amber-bg:rgba(255,184,48,0.06);--amber-border:rgba(255,184,48,0.15);
  --blue:#4d8dff;--blue2:#3672db;--blue-bg:rgba(77,141,255,0.06);
  --purple:#8b5cf6;--purple-bg:rgba(139,92,246,0.06);
  --teal:#14b8a6;--cyan:#06b6d4;
  --font-display:'Outfit',sans-serif;--font-mono:'JetBrains Mono',monospace;
  --radius:8px;--radius-lg:12px;--radius-xl:16px;
}
html,body{font-family:var(--font-display);background:var(--bg);color:var(--t1);font-size:13px;line-height:1.5;overflow-x:hidden;-webkit-font-smoothing:antialiased}
::selection{background:rgba(77,141,255,0.3)}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border2);border-radius:3px}

/* LAYOUT */
.app{display:grid;grid-template-columns:1fr;grid-template-rows:auto auto 1fr;height:100vh;overflow:hidden}
.header{padding:12px 24px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;background:var(--bg2)}
.header h1{font-size:15px;font-weight:600;letter-spacing:-0.3px;display:flex;align-items:center;gap:8px}
.header h1 .pulse{width:8px;height:8px;border-radius:50%;background:var(--green);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(0,214,143,0.4)}50%{opacity:0.8;box-shadow:0 0 0 6px rgba(0,214,143,0)}}
.header .meta{font-size:11px;color:var(--t3);font-family:var(--font-mono)}
.header-actions{display:flex;gap:6px}

/* BUTTONS */
.btn{padding:5px 12px;border-radius:6px;font-size:11px;font-weight:500;border:1px solid var(--border);background:var(--bg3);color:var(--t2);cursor:pointer;transition:all 0.12s;font-family:var(--font-display);white-space:nowrap}
.btn:hover{background:var(--bg4);color:var(--t1);border-color:var(--border2)}
.btn.primary{background:var(--green-bg);border-color:var(--green-border);color:var(--green)}
.btn.primary:hover{background:rgba(0,214,143,0.12)}
.btn.danger{background:var(--red-bg);border-color:var(--red-border);color:var(--red)}
.btn.danger:hover{background:rgba(255,71,87,0.12)}
.btn.amber{background:var(--amber-bg);border-color:var(--amber-border);color:var(--amber)}
.btn.danger:hover{background:rgba(255,71,87,0.12)}
.btn.amber:hover{background:rgba(255,184,48,0.12)}
.btn.sm{padding:3px 8px;font-size:10px}

/* KPI ROW */
.kpi-strip{display:grid;grid-template-columns:repeat(7,1fr);gap:1px;background:var(--border);border-bottom:1px solid var(--border)}
.kpi{background:var(--bg2);padding:12px 16px;position:relative;overflow:hidden}
.kpi::after{content:'';position:absolute;top:0;left:0;right:0;height:2px}
.kpi.green::after{background:linear-gradient(90deg,var(--green),transparent)}
.kpi.red::after{background:linear-gradient(90deg,var(--red),transparent)}
.kpi.blue::after{background:linear-gradient(90deg,var(--blue),transparent)}
.kpi.amber::after{background:linear-gradient(90deg,var(--amber),transparent)}
.kpi .label{font-size:9px;text-transform:uppercase;letter-spacing:1px;color:var(--t3);margin-bottom:4px;font-weight:500}
.kpi .val{font-size:20px;font-weight:700;letter-spacing:-0.8px;font-family:var(--font-mono)}
.kpi .sub{font-size:10px;color:var(--t2);margin-top:2px;font-family:var(--font-mono)}

/* MAIN GRID */
.main{display:grid;grid-template-columns:1fr 340px;overflow:hidden}
.main-content{overflow-y:auto;padding:0}
.sidebar-right{border-left:1px solid var(--border);overflow-y:auto;background:var(--bg2)}

/* ALERTS */
.alerts{padding:12px 20px;display:flex;flex-direction:column;gap:4px}
.alert{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:var(--radius);font-size:11px;cursor:pointer;transition:all 0.15s}
.alert:hover{filter:brightness(1.2)}
.alert.critical{background:var(--red-bg);border:1px solid var(--red-border)}
.alert.warning{background:var(--amber-bg);border:1px solid var(--amber-border)}
.alert.success{background:var(--green-bg);border:1px solid var(--green-border)}
.alert .dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;animation:pulse 2s infinite}
.alert.critical .dot{background:var(--red)}
.alert.warning .dot{background:var(--amber)}
.alert.success .dot{background:var(--green)}
.alert .ticker-badge{font-weight:700;font-family:var(--font-mono);font-size:11px;padding:1px 6px;border-radius:3px;background:rgba(255,255,255,0.05)}
.alert .action-btn{margin-left:auto;flex-shrink:0}

/* TABLE */
.table-wrap{padding:0 20px 20px}
.section-head{display:flex;justify-content:space-between;align-items:center;padding:12px 20px 8px;position:sticky;top:0;background:var(--bg);z-index:10}
.section-head h2{font-size:11px;text-transform:uppercase;letter-spacing:1.2px;color:var(--t3);font-weight:500}
.filters{display:flex;gap:4px}
.filter-btn{padding:3px 10px;border-radius:4px;font-size:10px;font-weight:500;border:none;background:transparent;color:var(--t3);cursor:pointer;font-family:var(--font-display)}
.filter-btn.active{background:var(--bg4);color:var(--t1)}
.filter-btn:hover{color:var(--t2)}

table{width:100%;border-collapse:collapse;table-layout:fixed}
thead{position:sticky;top:40px;z-index:5}
thead th{font-size:9px;text-transform:uppercase;letter-spacing:0.8px;color:var(--t4);padding:6px 8px;text-align:left;border-bottom:1px solid var(--border);background:var(--bg);font-weight:500;white-space:nowrap}
thead th.sortable{cursor:pointer}
tbody td{padding:8px;border-bottom:1px solid rgba(26,31,50,0.5);vertical-align:middle}
tbody tr{cursor:pointer;transition:background 0.1s}
tbody tr:hover{background:rgba(255,255,255,0.012)}
tbody tr.flagged{background:rgba(255,71,87,0.02)}
tbody tr.flagged:hover{background:rgba(255,71,87,0.04)}

.cell-ticker{width:140px}
.cell-mkt{width:36px}
.cell-price{width:90px}
.cell-pos{width:85px}
.cell-ret{width:60px}
.cell-score{width:44px}
.cell-signals{width:100px}
.cell-chart{width:72px}
.cell-rsi{width:70px}
.cell-val{width:80px}
.cell-div{width:60px}

.tk{font-weight:700;font-size:13px;letter-spacing:-0.3px;font-family:var(--font-mono)}
.tk-name{font-size:10px;color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:130px}
.mkt-tag{display:inline-block;padding:2px 5px;border-radius:3px;font-size:9px;font-weight:600;letter-spacing:0.4px}
.mkt-tag.no{background:rgba(255,71,87,0.1);color:#fca5a5}
.mkt-tag.us{background:rgba(139,92,246,0.1);color:#c4b5fd}
.mkt-tag.uk{background:rgba(20,184,166,0.1);color:#5eead4}
.mkt-tag.eu{background:rgba(77,141,255,0.1);color:#93c5fd}
.mkt-tag.dk{background:rgba(255,184,48,0.1);color:#fcd34d}
.mkt-tag.etf{background:rgba(100,100,120,0.1);color:#a0a0b0}
.price-main{font-weight:500;font-family:var(--font-mono);font-size:12px}
.chg{font-size:11px;font-weight:600;font-family:var(--font-mono)}
.pos{color:var(--green)}.neg{color:var(--red)}
.eur-val{font-weight:600;font-family:var(--font-mono);font-size:12px}
.pct-port{font-size:10px;color:var(--t3);font-family:var(--font-mono)}

/* SCORE RING */
.score{width:36px;height:36px;position:relative}
.score svg{transform:rotate(-90deg)}
.score .val{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;font-family:var(--font-mono)}

/* SIGNAL TAGS */
.sigs{display:flex;gap:2px;flex-wrap:wrap}
.sig{font-size:8px;padding:2px 4px;border-radius:2px;font-weight:600;letter-spacing:0.3px;font-family:var(--font-mono)}
.sig.p{background:rgba(0,214,143,0.1);color:var(--green)}
.sig.n{background:rgba(255,71,87,0.1);color:var(--red)}
.sig.w{background:rgba(255,184,48,0.1);color:var(--amber)}
.sig.i{background:rgba(77,141,255,0.1);color:var(--blue)}

/* MINI SPARKLINE */
.spark{height:24px;display:flex;align-items:end;gap:1px}
.spark-bar{width:3px;border-radius:1px 1px 0 0;transition:height 0.3s}

/* RSI */
.rsi-wrap{display:flex;flex-direction:column;gap:2px}
.rsi-num{font-family:var(--font-mono);font-size:11px;font-weight:500}
.rsi-track{width:100%;height:3px;background:var(--bg);border-radius:2px;overflow:hidden}
.rsi-fill{height:100%;border-radius:2px;transition:width 0.5s}
.rsi-ctx{font-size:9px;color:var(--t3)}

/* VALUATION PILLS */
.vpills{display:flex;gap:3px;flex-wrap:wrap}
.vpill{font-size:9px;padding:2px 5px;border-radius:3px;background:rgba(255,255,255,0.03);color:var(--t2);font-family:var(--font-mono);white-space:nowrap}

/* RIGHT SIDEBAR */
.sb-section{padding:14px 16px;border-bottom:1px solid var(--border)}
.sb-title{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--t3);font-weight:500;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center}
.sb-title .live{font-size:8px;color:var(--green);text-transform:none;letter-spacing:0;font-weight:400;display:flex;align-items:center;gap:4px}
.sb-title .live::before{content:'';width:5px;height:5px;border-radius:50%;background:var(--green);animation:pulse 2s infinite}

/* MACRO */
.macro-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.macro-item{background:var(--bg3);border-radius:6px;padding:8px 10px}
.macro-item .mi-label{font-size:9px;color:var(--t3);text-transform:uppercase;letter-spacing:0.5px}
.macro-item .mi-val{font-size:16px;font-weight:700;font-family:var(--font-mono);margin-top:2px}
.macro-item .mi-chg{font-size:10px;font-family:var(--font-mono);margin-top:1px}
.macro-item .mi-bar{height:2px;border-radius:1px;margin-top:4px;background:var(--bg5);overflow:hidden}
.macro-item .mi-bar-fill{height:100%;border-radius:1px}

/* SECTOR ALLOCATION */
.alloc-bars{display:flex;flex-direction:column;gap:4px}
.alloc-row{display:flex;align-items:center;gap:8px;font-size:11px}
.alloc-label{width:80px;color:var(--t2);font-size:10px;text-align:right;flex-shrink:0}
.alloc-track{flex:1;height:6px;background:var(--bg);border-radius:3px;overflow:hidden}
.alloc-fill{height:100%;border-radius:3px;transition:width 0.8s}
.alloc-pct{width:32px;font-family:var(--font-mono);font-size:10px;color:var(--t2)}

/* AI ADVISOR */
.advisor{background:var(--bg3);border-radius:var(--radius);padding:12px;border:1px solid var(--border)}
.advisor-header{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.advisor-avatar{width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,var(--blue),var(--purple));display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700}
.advisor-name{font-size:12px;font-weight:600}
.advisor-role{font-size:9px;color:var(--t3)}
.advisor-msg{font-size:11px;line-height:1.6;color:var(--t2);margin-bottom:10px}
.advisor-msg strong{color:var(--t1)}
.advisor-actions{display:flex;gap:4px;flex-wrap:wrap}

/* NEWS FEED */
.news-item{padding:8px 0;border-bottom:1px solid rgba(26,31,50,0.4)}
.news-item:last-child{border:none}
.news-time{font-size:9px;color:var(--t4);font-family:var(--font-mono)}
.news-headline{font-size:11px;color:var(--t2);margin-top:2px;line-height:1.4}
.news-headline strong{color:var(--t1)}
.news-impact{display:inline-flex;align-items:center;gap:3px;font-size:9px;font-weight:600;margin-top:3px;padding:1px 5px;border-radius:3px}
.news-impact.bull{background:var(--green-bg);color:var(--green)}
.news-impact.bear{background:var(--red-bg);color:var(--red)}
.news-impact.neutral{background:rgba(255,255,255,0.03);color:var(--t3)}

/* CORRELATION HEATMAP */
.corr-grid{display:grid;gap:1px;font-family:var(--font-mono);font-size:8px}
.corr-cell{display:flex;align-items:center;justify-content:center;aspect-ratio:1;border-radius:2px;font-weight:500;transition:transform 0.1s}
.corr-cell:hover{transform:scale(1.3);z-index:2}
.corr-label{display:flex;align-items:center;justify-content:center;font-size:8px;color:var(--t3);font-weight:500}

/* RISK METER */
.risk-meter{display:flex;align-items:center;gap:8px;margin:6px 0}
.rm-track{flex:1;height:8px;border-radius:4px;background:linear-gradient(90deg,var(--green),var(--amber),var(--red));position:relative}
.rm-needle{width:3px;height:14px;background:var(--t1);border-radius:2px;position:absolute;top:-3px;transition:left 0.5s}
.rm-labels{display:flex;justify-content:space-between;font-size:9px;color:var(--t3)}

/* TEES DETAIL */
.tees-card{background:var(--bg3);border-radius:var(--radius);padding:12px;border:1px solid var(--border);margin-top:8px}
.tees-card h3{font-size:12px;font-weight:600;margin-bottom:8px;display:flex;justify-content:space-between}
.tees-row{display:flex;gap:12px;margin-bottom:8px}
.tees-field{flex:1}
.tees-field .tf-label{font-size:9px;text-transform:uppercase;letter-spacing:0.5px;color:var(--t3);margin-bottom:3px}
.tees-field .tf-val{font-size:11px;line-height:1.4}
.tees-break{border-top:1px solid var(--border);padding-top:8px;margin-top:8px}
.tees-break .tb-label{font-size:9px;text-transform:uppercase;letter-spacing:0.5px;color:var(--red);margin-bottom:3px}
.tees-break .tb-val{font-size:11px;color:var(--t2);line-height:1.4}

/* ANIMATIONS */
@keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
@keyframes slideIn{from{opacity:0;transform:translateX(-8px)}to{opacity:1;transform:translateX(0)}}
.fade-in{animation:fadeIn 0.4s ease-out forwards}
.alert{animation:slideIn 0.3s ease-out forwards}
tbody tr{animation:fadeIn 0.3s ease-out forwards}
tbody tr:nth-child(1){animation-delay:0.02s}
tbody tr:nth-child(2){animation-delay:0.04s}
tbody tr:nth-child(3){animation-delay:0.06s}
tbody tr:nth-child(4){animation-delay:0.08s}
tbody tr:nth-child(5){animation-delay:0.1s}
tbody tr:nth-child(6){animation-delay:0.12s}
tbody tr:nth-child(7){animation-delay:0.14s}
tbody tr:nth-child(8){animation-delay:0.16s}
tbody tr:nth-child(9){animation-delay:0.18s}
tbody tr:nth-child(10){animation-delay:0.2s}
tbody tr:nth-child(n+11){animation-delay:0.22s}

/* SKELETON LOADER */
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
.skel{background:linear-gradient(90deg,rgba(255,255,255,0.03),rgba(255,255,255,0.09),rgba(255,255,255,0.03));background-size:200% 100%;animation:shimmer 1.1s ease-in-out infinite;border-radius:4px}
.skel-line{height:10px}
.skel-short{height:8px}
.skel-num{height:14px;width:70%}
.skel-pill{height:16px;width:80%}

/* RESPONSIVE */
@media(max-width:1100px){.main{grid-template-columns:1fr}.sidebar-right{display:none}.kpi-strip{grid-template-columns:repeat(4,1fr)}}
`;

const positions: Position[] = [
  {
    tk: "EQNR.OL",
    name: "Equinor ASA",
    mkt: "no",
    price: 355.1,
    cur: "NOK",
    chg: 1.95,
    eur: 30894,
    pct: 2.6,
    ret: 41.9,
    score: 87,
    sigs: ["Turg+", "Fund+", "Mom+"],
    sigT: ["p", "p", "p"],
    spark: [60, 55, 50, 45, 40, 35, 30, 25],
    rsi: 52,
    rsiCtx: "Üle 50p MA",
    pe: "8.5",
    fpe: "7.2",
    div: 4.0,
    cat: "energy",
  },
  {
    tk: "AKRBP.OL",
    name: "Aker BP ASA",
    mkt: "no",
    price: 340.5,
    cur: "NOK",
    chg: 1.58,
    eur: 35540,
    pct: 3.0,
    ret: 36.9,
    score: 82,
    sigs: ["Turg+", "Fund+", "Div!"],
    sigT: ["p", "p", "w"],
    spark: [58, 52, 48, 42, 38, 34, 30, 28],
    rsi: 48,
    rsiCtx: "Üle 50p MA",
    pe: "5.8",
    fpe: "5.2",
    div: 7.2,
    cat: "energy",
  },
  {
    tk: "AGNC",
    name: "AGNC Investment",
    mkt: "us",
    price: 10.5,
    cur: "USD",
    chg: 1.65,
    eur: 104161,
    pct: 8.8,
    ret: 10.1,
    score: 64,
    sigs: ["Div+", "Rate?", "Vol-"],
    sigT: ["p", "w", "n"],
    spark: [50, 46, 44, 42, 40, 38, 36, 34],
    rsi: 58,
    rsiCtx: "Üle 200p MA",
    pe: "—",
    fpe: "—",
    div: 13.7,
    cat: "reit",
  },
  {
    tk: "VZ",
    name: "Verizon",
    mkt: "us",
    price: 50.52,
    cur: "USD",
    chg: -0.88,
    eur: 120989,
    pct: 10.2,
    ret: 20.9,
    score: 72,
    sigs: ["Div+", "Fund~", "Val+"],
    sigT: ["p", "w", "p"],
    spark: [42, 40, 38, 36, 34, 32, 30, 28],
    rsi: 61,
    rsiCtx: "Üle 50p MA",
    pe: "10.2",
    fpe: "9.1",
    div: 5.4,
    cat: "telecom",
  },
  {
    tk: "LGEN.L",
    name: "Legal & General",
    mkt: "uk",
    price: 251.1,
    cur: "GBX",
    chg: 1.29,
    eur: 142976,
    pct: 12.0,
    ret: -3.2,
    score: 55,
    sigs: ["Div+", "Fund~", "Rate?"],
    sigT: ["p", "w", "w"],
    spark: [34, 36, 38, 40, 42, 40, 38, 36],
    rsi: 46,
    rsiCtx: "50p MA juures",
    pe: "11.8",
    fpe: "9.4",
    div: 8.6,
    cat: "uk-infra",
  },
  {
    tk: "INPP.L",
    name: "Intl Public Partners",
    mkt: "uk",
    price: 132.6,
    cur: "GBX",
    chg: 2.31,
    eur: 121973,
    pct: 10.3,
    ret: 4.4,
    score: 51,
    sigs: ["Div+", "Rate?", "Konts!"],
    sigT: ["p", "w", "n"],
    spark: [38, 40, 42, 44, 42, 40, 38, 36],
    rsi: 44,
    rsiCtx: "All 50p MA",
    pe: "—",
    fpe: "—",
    div: 8.0,
    cat: "uk-infra",
  },
  {
    tk: "HICL.L",
    name: "HICL Infrastructure",
    mkt: "uk",
    price: 122.0,
    cur: "GBX",
    chg: 0.99,
    eur: 133738,
    pct: 11.3,
    ret: 2.8,
    score: 49,
    sigs: ["Div+", "Rate?", "Konts!"],
    sigT: ["p", "w", "n"],
    spark: [40, 42, 44, 42, 40, 38, 36, 34],
    rsi: 42,
    rsiCtx: "All 50p MA",
    pe: "—",
    fpe: "—",
    div: 6.8,
    cat: "uk-infra",
  },
  {
    tk: "TRIG.L",
    name: "Renewables Infra",
    mkt: "uk",
    price: 67.9,
    cur: "GBX",
    chg: 2.57,
    eur: 95063,
    pct: 8.0,
    ret: -2.2,
    score: 47,
    sigs: ["ESG+", "Rate?", "Konts!"],
    sigT: ["i", "w", "n"],
    spark: [44, 42, 40, 38, 36, 34, 32, 30],
    rsi: 38,
    rsiCtx: "All 50p MA",
    pe: "—",
    fpe: "—",
    div: 11.1,
    cat: "uk-infra",
  },
  {
    tk: "SEQI.L",
    name: "Sequoia Econ Infra",
    mkt: "uk",
    price: 80.9,
    cur: "GBX",
    chg: 1.51,
    eur: 120722,
    pct: 10.2,
    ret: 3.4,
    score: 46,
    sigs: ["Div+", "Rate?", "Konts!"],
    sigT: ["p", "w", "n"],
    spark: [42, 40, 38, 36, 34, 32, 30, 28],
    rsi: 40,
    rsiCtx: "All 50p MA",
    pe: "—",
    fpe: "—",
    div: 8.5,
    cat: "uk-infra",
  },
  {
    tk: "MSFT",
    name: "Microsoft",
    mkt: "us",
    price: 399.42,
    cur: "USD",
    chg: -0.13,
    eur: 110240,
    pct: 9.3,
    ret: -4.8,
    score: 58,
    sigs: ["Fund+", "Mom-", "Val?"],
    sigT: ["p", "n", "w"],
    spark: [28, 30, 34, 38, 40, 42, 44, 46],
    rsi: 42,
    rsiCtx: "All 50p MA",
    pe: "35",
    fpe: "28",
    div: 0.9,
    cat: "kasv",
  },
  {
    tk: "NOVO-B.CO",
    name: "Novo Nordisk",
    mkt: "dk",
    price: 249.45,
    cur: "DKK",
    chg: 0.46,
    eur: 83567,
    pct: 7.0,
    ret: 0.0,
    score: 61,
    sigs: ["Fund+", "Earn⏳", "Vol~"],
    sigT: ["p", "w", "w"],
    spark: [50, 48, 44, 40, 38, 36, 34, 36],
    rsi: 44,
    rsiCtx: "Neutraalne",
    pe: "24",
    fpe: "19",
    div: 4.7,
    cat: "kasv",
  },
  {
    tk: "O",
    name: "Realty Income",
    mkt: "us",
    price: 64.25,
    cur: "USD",
    chg: -1.03,
    eur: 124267,
    pct: 10.5,
    ret: 16.2,
    score: 68,
    sigs: ["Div+", "REIT+", "Val+"],
    sigT: ["p", "p", "p"],
    spark: [40, 38, 36, 34, 32, 30, 28, 26],
    rsi: 48,
    rsiCtx: "Üle 50p MA",
    pe: "56",
    fpe: "16",
    div: 5.0,
    cat: "reit",
  },
  {
    tk: "PYPL",
    name: "PayPal",
    mkt: "us",
    price: 46.29,
    cur: "USD",
    chg: 1.92,
    eur: 68131,
    pct: 5.7,
    ret: -36.9,
    score: 31,
    sigs: ["Turg-", "Fund-", "Tees✗"],
    sigT: ["n", "n", "n"],
    spark: [22, 26, 30, 34, 38, 42, 46, 50],
    rsi: 32,
    rsiCtx: "All 50p MA",
    pe: "18",
    fpe: "14",
    div: 0.6,
    cat: "kasv",
    flagged: true,
  },
  {
    tk: "ADBE",
    name: "Adobe",
    mkt: "us",
    price: 254.79,
    cur: "USD",
    chg: 1.16,
    eur: 35161,
    pct: 3.0,
    ret: -30.0,
    score: 28,
    sigs: ["AI risk", "Mom-", "Val?"],
    sigT: ["n", "n", "w"],
    spark: [20, 24, 28, 34, 40, 44, 48, 52],
    rsi: 36,
    rsiCtx: "Ülemüüdud",
    pe: "22",
    fpe: "17",
    div: 0,
    cat: "kasv",
    flagged: true,
  },
  {
    tk: "SEVN",
    name: "Seven Hills Realty",
    mkt: "us",
    price: 8.4,
    cur: "USD",
    chg: -0.71,
    eur: 62840,
    pct: 5.3,
    ret: -39.3,
    score: 18,
    sigs: ["Stop!", "Div✗", "Fund-"],
    sigT: ["n", "n", "n"],
    spark: [18, 22, 28, 34, 40, 46, 52, 56],
    rsi: 28,
    rsiCtx: "Ülemüüdud",
    pe: "8.4",
    fpe: "—",
    div: 14.2,
    cat: "reit",
    flagged: true,
  },
];

const sectors: Sector[] = [
  { name: "UK Infrastr.", pct: 28.4, color: "var(--teal)" },
  { name: "USA REITid", pct: 18.2, color: "var(--purple)" },
  { name: "Energia", pct: 5.6, color: "var(--red)" },
  { name: "Kasv/Tech", pct: 15.0, color: "var(--blue)" },
  { name: "Telecom", pct: 10.2, color: "var(--cyan)" },
  { name: "Dividendid", pct: 12.8, color: "var(--green)" },
  { name: "Võlakirjad", pct: 6.4, color: "var(--amber)" },
  { name: "Muu", pct: 3.4, color: "var(--t3)" },
];

const news: NewsItem[] = [
  {
    time: "18:30",
    headline:
      "<strong>BoE</strong> intressiotsus homme — turg ootab püsimist 4.50% juures.",
    impact: "bear",
    tag: "UK Infra mõju",
  },
  {
    time: "17:45",
    headline: "<strong>Brent</strong> nafta +0.8% $71.40-le. OPEC+ kärped püsivad.",
    impact: "bull",
    tag: "EQNR, AKRBP",
  },
  {
    time: "16:20",
    headline: "<strong>PayPal</strong> kaotab turuosa Stripe\'ile. Analüütikud langetavad targeti.",
    impact: "bear",
    tag: "PYPL müügisignaal",
  },
  {
    time: "15:10",
    headline: "<strong>Microsoft</strong> Azure kasv aeglustub 28%-le. Oodati 31%.",
    impact: "bear",
    tag: "MSFT",
  },
  {
    time: "14:30",
    headline: "<strong>Novo Nordisk</strong> Ozempic konkurent Eli Lilly saab FDA heakskiidu.",
    impact: "bear",
    tag: "NOVO-B.CO",
  },
  {
    time: "12:15",
    headline: '<strong>Fed</strong> Waller: "Inflatsioon langeb, aga pole veel valmis langetama."',
    impact: "neutral",
    tag: "TLT, AGNC",
  },
];

const earnings: EarningItem[] = [
  { date: "20.03", tk: "VZ", name: "Verizon Q4", est: "EPS $1.23" },
  { date: "24.03", tk: "NOVO-B.CO", name: "Novo Q4", est: "Rev DKK 72.8B" },
  { date: "28.03", tk: "LGEN.L", name: "L&G FY", est: "Div 20.3p" },
  { date: "02.04", tk: "MSFT", name: "Microsoft Q3", est: "EPS $3.22" },
];

const fallbackCorrelation: PortfolioResponse["correlation"] = {
  tickers: ["TRIG", "SEQI", "HICL", "INPP", "SUPR", "LGEN"],
  matrix: [
    [1, 0.89, 0.86, 0.91, 0.72, 0.45],
    [0.89, 1, 0.88, 0.85, 0.68, 0.42],
    [0.86, 0.88, 1, 0.84, 0.7, 0.4],
    [0.91, 0.85, 0.84, 1, 0.74, 0.48],
    [0.72, 0.68, 0.7, 0.74, 1, 0.38],
    [0.45, 0.42, 0.4, 0.48, 0.38, 1],
  ],
};

const fallbackAdvisorHtml = `<strong>Tänane prioriteet:</strong> Portfell on liialt kontsentreeritud UK infrastruktuuri (28.4%). BoE otsus homme — kui intresse ei langetata, langeb see klaster 3-5%. Soovitan:<br><br>1. <strong>Müü PYPL ja SEVN</strong> — mõlemad teesid katkenud<br>2. <strong>Realiseeri EQNR 50%</strong> — target saavutatud<br>3. <strong>Vabastatud ~€180K</strong> → suuna kvaliteetkasvusse (NVDA, ASML) ja USA quality-dividendi (JNJ, PG)<br>4. <strong>UK infra alla 20%</strong> — müü SUPR.L (kõige nõrgem fundamentaal)`;

const fallbackAlerts: AlertItem[] = [
  {
    ticker: "PYPL",
    severity: "critical",
    message:
      "Skoor 87→31. Tees katkeb: fintech turnaround ei realiseeru, konkurents Stripe/Block. <strong>AI: MÜÜ.</strong>",
    buttonLabel: "Kinnita müük",
    buttonVariant: "danger",
  },
  {
    ticker: "SEVN",
    severity: "critical",
    message:
      "Alla stop-lossi. Div yield 14.2% ebajätkusuutlik, payout &gt;100%. <strong>AI: MÜÜ.</strong>",
    buttonLabel: "Kinnita müük",
    buttonVariant: "danger",
  },
  {
    ticker: "ADBE",
    severity: "critical",
    message:
      "-30% avg-st. AI genereerimine kannibaliseerib Creative Cloud. Skoor 28. <strong>AI: MÜÜ/vaheta.</strong>",
    buttonLabel: "Analüüsi",
    buttonVariant: "danger",
  },
  {
    ticker: "EQNR.OL",
    severity: "success",
    message: "Target 360 NOK saavutatud! +41.9% tootlus. <strong>AI: realiseeri 50% kasumit, tõsta stop.</strong>",
    buttonLabel: "Kinnita",
    buttonVariant: "primary",
  },
  {
    ticker: "UK INFRA",
    severity: "warning",
    message: "TRIG/SEQI/HICL/INPP = 28.4% portfellist. BoE otsus 20.03. Intressitundlik klaster.",
    buttonLabel: "Risk analüüs",
    buttonVariant: "amber",
  },
];

function scoreColor(score: number) {
  return score >= 70 ? "var(--green)" : score >= 45 ? "var(--amber)" : "var(--red)";
}

function ScoreRing({ score }: { score: number }) {
  const r = 16;
  const c = Math.PI * 2 * r;
  const offset = c - (score / 100) * c;
  const col = scoreColor(score);

  return (
    <div className="score">
      <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden>
        <circle cx="18" cy="18" r={r} fill="none" stroke="var(--bg)" strokeWidth="3" />
        <circle
          cx="18"
          cy="18"
          r={r}
          fill="none"
          stroke={col}
          strokeWidth="3"
          strokeDasharray={c}
          strokeDashoffset={offset}
          strokeLinecap="round"
        />
      </svg>
      <div className="val" style={{ color: col }}>
        {score}
      </div>
    </div>
  );
}

function Sparkline({ data, ret }: { data: number[]; ret: number }) {
  const col = ret >= 0 ? "var(--green)" : "var(--red)";
  const max = Math.max(...data);
  const min = Math.min(...data);

  return (
    <div className="spark" aria-hidden>
      {data.map((v, i) => {
        const h = Math.max(3, ((v - min) / (max - min || 1)) * 22);
        const opacity = 0.3 + 0.7 * (i / data.length);
        return (
          <div
            key={i}
            className="spark-bar"
            style={{
              height: `${h}px`,
              background: col,
              opacity,
            }}
          />
        );
      })}
    </div>
  );
}

export default function Home() {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [scoreDir, setScoreDir] = useState<SortDir>("desc");
  const [scanLabel, setScanLabel] = useState("⟳ Skaneeri");

  const [portfolioData, setPortfolioData] = useState<PortfolioResponse>(() => ({
    generatedAt: undefined,
    positions,
    sectors_allocation: sectors,
    correlation: fallbackCorrelation,
    news,
    earnings,
    data_quality: undefined,
  }));
  const [portfolioLoading, setPortfolioLoading] = useState(true);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);

  const [aiAdvisorHtml, setAiAdvisorHtml] = useState<string>(fallbackAdvisorHtml);
  const [aiAlerts] = useState<AlertItem[]>(fallbackAlerts);
  const [aiPositionUpdates, setAiPositionUpdates] = useState<
    Record<string, { score?: number; sigs?: string[]; sigT?: SignalKind[]; target?: number; stop_loss?: number; flagged?: boolean }>
  >({});

  const [lastScan, setLastScan] = useState<{ generatedAt?: string; alerts?: { urgent: string[]; warning: string[]; info: string[] } }>({
    generatedAt: undefined,
    alerts: { urgent: [], warning: [], info: [] },
  });

  const [performanceData, setPerformanceData] = useState<{
    portfolio: Array<{ date: string; value: number }>;
    spy: Array<{ date: string; value: number }>;
  }>({ portfolio: [], spy: [] });

  const monitorAlerts = useMemo<AlertItem[]>(() => {
    const alerts = lastScan.alerts ?? { urgent: [], warning: [], info: [] };

    const sanitizeText = (s: string) =>
      s.replace(/\r/g, "").replace(/\*/g, "").replace(/_/g, "").replace(/▸\s*/g, "").trim();

    const parseTicker = (msg: string) => {
      const m = msg.match(/\*([^*]+)\*/);
      if (m?.[1]) return m[1].trim();
      // Last resort: first token-like uppercase chunk (incl. dots/dashes)
      const m2 = msg.match(/\b[A-Z0-9][A-Z0-9.\-]{1,}\b/);
      return m2?.[0] ?? "—";
    };

    const toItems = (list: string[], severity: AlertSeverity, variant: AlertVariant, buttonLabel: string) => {
      return list.map((msg) => {
        const ticker = parseTicker(msg);
        return {
          ticker,
          severity,
          message: sanitizeText(msg),
          messageIsHtml: false,
          buttonLabel,
          buttonVariant: variant,
        };
      });
    };

    return [
      ...toItems(alerts.urgent ?? [], "critical", "danger", "Analüüsi"),
      ...toItems(alerts.warning ?? [], "warning", "amber", "Risk analüüs"),
      ...toItems(alerts.info ?? [], "success", "primary", "Vaata"),
    ];
  }, [lastScan]);

  const alertsToRender = monitorAlerts.length ? monitorAlerts : aiAlerts;
  const lastScanUrgentCount = lastScan.alerts?.urgent?.length ?? 0;
  const lastScanWarningCount = lastScan.alerts?.warning?.length ?? 0;
  const lastScanInfoCount = lastScan.alerts?.info?.length ?? 0;

  const uiPositions = useMemo(() => {
    const updates = aiPositionUpdates;
    return portfolioData.positions.map((p) => {
      const u = updates[p.tk];
      if (!u) return p;
      return {
        ...p,
        ...(typeof u.score === "number" ? { score: u.score } : {}),
        ...(u.sigs ? { sigs: u.sigs } : {}),
        ...(u.sigT ? { sigT: u.sigT } : {}),
        ...(typeof u.target === "number" ? { target: u.target } : {}),
        ...(typeof u.stop_loss === "number" ? { stop_loss: u.stop_loss } : {}),
        ...(typeof u.flagged === "boolean" ? { flagged: u.flagged } : {}),
      };
    });
  }, [aiPositionUpdates, portfolioData.positions]);

  const filteredAndSortedPositions = useMemo(() => {
    let arr = [...uiPositions];
    if (filter === "sell") arr = arr.filter((p) => !!p.flagged);
    if (filter === "buy") arr = arr.filter((p) => !p.flagged);
    if (filter === "uk-infra") arr = arr.filter((p) => p.cat === "uk-infra");
    if (filter === "reit") arr = arr.filter((p) => p.cat === "reit");
    if (filter === "growth") arr = arr.filter((p) => p.cat === "kasv");

    arr.sort((a, b) => (scoreDir === "desc" ? b.score - a.score : a.score - b.score));
    return arr;
  }, [filter, scoreDir, uiPositions]);

  const fetchPortfolio = useCallback(async () => {
    setPortfolioLoading(true);
    setPortfolioError(null);
    try {
      const res = await fetch("/api/portfolio", { method: "GET" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as PortfolioResponse;

      setPortfolioData((prev) => ({
        ...prev,
        ...data,
        // Fallbacks if backend misses a field:
        positions: Array.isArray(data.positions) ? data.positions : prev.positions,
        sectors_allocation: Array.isArray(data.sectors_allocation) ? data.sectors_allocation : prev.sectors_allocation,
        correlation: data.correlation ?? prev.correlation,
        news: Array.isArray(data.news) ? data.news : prev.news,
        earnings: Array.isArray(data.earnings) ? data.earnings : prev.earnings,
        kpis: data.kpis ?? prev.kpis,
        macro: data.macro ?? prev.macro,
      }));
    } catch (e) {
      setPortfolioError(`Portfolio laadimine ebaõnnestus: ${String(e)}`);
    } finally {
      setPortfolioLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPortfolio();
    const id = window.setInterval(() => void fetchPortfolio(), 5 * 60 * 1000);
    void (async () => {
      try {
        const res = await fetch("/api/cron/last-scan");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as {
          generatedAt?: string;
          alerts?: { urgent: string[]; warning: string[]; info: string[] };
        };
        setLastScan(json);
      } catch {
        // If last scan fails, keep the default empty alert state.
        setLastScan((prev) => ({
          ...prev,
          alerts: { urgent: prev.alerts?.urgent ?? [], warning: prev.alerts?.warning ?? [], info: prev.alerts?.info ?? [] },
        }));
      }
    })();
    void (async () => {
      try {
        const res = await fetch("/api/performance");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { portfolio: Array<{ date: string; value: number }>; spy: Array<{ date: string; value: number }> };
        setPerformanceData({ portfolio: json.portfolio ?? [], spy: json.spy ?? [] });
      } catch {
        setPerformanceData({ portfolio: [], spy: [] });
      }
    })();
    return () => window.clearInterval(id);
  }, [fetchPortfolio]);

  const handleScan = async (message?: string) => {
    setScanLabel("⟳ Skaneerib...");
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "scan", message }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ai = await res.json();

      if (typeof ai.advisorMessage === "string") setAiAdvisorHtml(ai.advisorMessage);
      if (ai.positionUpdates && typeof ai.positionUpdates === "object") setAiPositionUpdates(ai.positionUpdates);
    } catch {
      // Keep old advisor state on failure
    } finally {
      window.setTimeout(() => setScanLabel("⟳ Skaneeri"), 2000);
    }
  };

  const handleAlertAnalyze = async (ticker: string) => {
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "analyze", ticker }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ai = await res.json();

      if (typeof ai.rationaleHtml === "string") setAiAdvisorHtml(ai.rationaleHtml);

      const signal: string = ai.signal ?? "";
      setAiPositionUpdates((prev) => ({
        ...prev,
        [ticker]: {
          score: typeof ai.score === "number" ? ai.score : prev[ticker]?.score,
          sigs: Array.isArray(ai.sigs) ? (ai.sigs as string[]) : prev[ticker]?.sigs,
          sigT: Array.isArray(ai.sigT) ? (ai.sigT as SignalKind[]) : prev[ticker]?.sigT,
          target: typeof ai.target === "number" ? ai.target : prev[ticker]?.target,
          stop_loss: typeof ai.stop_loss === "number" ? ai.stop_loss : prev[ticker]?.stop_loss,
          flagged: signal === "MÜÜ" ? true : false,
        },
      }));
    } catch {
      // Keep old AI state on failure
    }
  };

  const handleToggleView = () => {
    // Placeholder: mockup.html has empty toggleView().
    window.console.log("toggleView");
  };

  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [tickerHistory, setTickerHistory] = useState<TickerHistoryResponse | null>(null);
  const [tickerHistoryLoading, setTickerHistoryLoading] = useState(false);
  const [tickerHistoryError, setTickerHistoryError] = useState<string | null>(null);
  const [aiAnalyze, setAiAnalyze] = useState<AiAnalyzeResponse | null>(null);
  const [aiAnalyzeLoading, setAiAnalyzeLoading] = useState(false);

  const [teesDraft, setTeesDraft] = useState("");
  const [targetDraft, setTargetDraft] = useState<number>(0);
  const [stopDraft, setStopDraft] = useState<number>(0);

  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");

  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const lightweightChartRef = useRef<{ chart: { remove: () => void } } | null>(null);

  const selectedPos = useMemo(() => {
    if (!selectedTicker) return null;
    return uiPositions.find((p) => p.tk === selectedTicker) ?? portfolioData.positions.find((p) => p.tk === selectedTicker) ?? null;
  }, [selectedTicker, uiPositions, portfolioData.positions]);

  useEffect(() => {
    if (!modalOpen || !selectedTicker) return;

    setTickerHistoryLoading(true);
    setTickerHistoryError(null);
    setAiAnalyze(null);
    setChat([]);
    setChatInput("");

    setTeesDraft(selectedPos?.tees ?? "");
    setTargetDraft(typeof selectedPos?.target === "number" ? selectedPos?.target : 0);
    setStopDraft(typeof selectedPos?.stop_loss === "number" ? selectedPos?.stop_loss : 0);

    void (async () => {
      try {
        const res = await fetch(`/api/ticker-history?ticker=${encodeURIComponent(selectedTicker)}&range=3mo`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as TickerHistoryResponse;
        setTickerHistory(json);
      } catch (e) {
        setTickerHistoryError(String(e));
      } finally {
        setTickerHistoryLoading(false);
      }
    })();
  }, [modalOpen, selectedTicker, selectedPos]);

  useEffect(() => {
    if (!modalOpen) return;
    const el = chartContainerRef.current;
    if (!el) return;
    if (!tickerHistory) return;
    if (!tickerHistory.candles?.length) return;

    void (async () => {
      // Ensure we don't stack multiple charts.
      if (lightweightChartRef.current?.chart) {
        try {
          lightweightChartRef.current.chart.remove();
        } catch {
          // ignore
        }
      }

      const lc = await import("lightweight-charts");
      const chart = lc.createChart(el, {
        width: el.clientWidth,
        height: 340,
        layout: { background: { color: "transparent" }, textColor: "var(--t1)" },
        grid: { vertLines: { color: "rgba(255,255,255,0.06)" }, horzLines: { color: "rgba(255,255,255,0.06)" } },
        timeScale: { timeVisible: true, secondsVisible: false },
      });

      const candles = tickerHistory.candles.map((c) => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));

      const chartWithSeries = chart as unknown as {
        addCandlestickSeries: (opts: unknown) => {
          setData: (data: Array<{ time: number; open: number; high: number; low: number; close: number }>) => void;
        };
        addLineSeries: (opts: { color: string; lineWidth?: number }) => {
          setData: (data: Array<{ time: number; value: number }>) => void;
        };
      };

      const candleSeries = chartWithSeries.addCandlestickSeries({
        upColor: "var(--green)",
        downColor: "var(--red)",
        borderUpColor: "var(--green)",
        borderDownColor: "var(--red)",
        wickUpColor: "var(--green)",
        wickDownColor: "var(--red)",
      });
      candleSeries.setData(candles);

      const close = candles.map((c) => c.close);
      const times = candles.map((c) => c.time);

      const addLine = (color: string) => chartWithSeries.addLineSeries({ color, lineWidth: 2 });
      const ma50 = addLine("var(--purple)");
      const ma200 = addLine("var(--t2)");
      const ema21 = addLine("var(--amber)");

      const computeSMA = (window: number) => {
        const out: Array<{ time: number; value: number }> = [];
        for (let i = window - 1; i < close.length; i++) {
          const slice = close.slice(i - window + 1, i + 1);
          const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
          out.push({ time: times[i], value: avg });
        }
        return out;
      };

      const computeEMA = (span: number) => {
        const k = 2 / (span + 1);
        const out: Array<{ time: number; value: number }> = [];
        let ema = close[0];
        out.push({ time: times[0], value: ema });
        for (let i = 1; i < close.length; i++) {
          ema = close[i] * k + ema * (1 - k);
          out.push({ time: times[i], value: ema });
        }
        return out;
      };

      ma50.setData(computeSMA(50));
      ma200.setData(computeSMA(200));
      ema21.setData(computeEMA(21));

      lightweightChartRef.current = { chart };
    })();

    return () => {
      // Keep it lightweight: chart will be removed when modal closes.
    };
  }, [modalOpen, tickerHistory]);

  return (
    <>
      <style>{styles}</style>

      <div className="app">
        {/* HEADER */}
        <div className="header">
          <h1>
            <div className="pulse" />
            Portfolio Command Center
            <span
              style={{
                fontSize: "10px",
                color: "var(--t3)",
                fontWeight: 400,
                marginLeft: "8px",
              }}
            >
              IBKR U16376652
            </span>
          </h1>
          <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
            <div className="meta">
              18.03.2026 18:42 CET · Järgmine skan: 19:00
              <br />
              Viimati skaneeritud:{" "}
              {lastScan.generatedAt ? new Date(lastScan.generatedAt).toLocaleTimeString("et-EE", { hour: "2-digit", minute: "2-digit" }) : "—"}
            </div>
            {portfolioError ? (
              <div style={{ fontSize: "10px", color: "var(--amber)", fontFamily: "var(--font-mono)" }}>{portfolioError}</div>
            ) : null}
            <div className="header-actions">
              {(() => {
                const alertCount = lastScanUrgentCount + lastScanWarningCount + lastScanInfoCount;
                return alertCount > 0 ? (
                  <div
                    className="notification-badge"
                    title={`${alertCount} hoiust`}
                    style={{
                      position: "relative",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      minWidth: 22,
                      height: 22,
                      borderRadius: 11,
                      background: "var(--red)",
                      color: "#fff",
                      fontSize: 11,
                      fontWeight: 700,
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {alertCount > 99 ? "99+" : alertCount}
                  </div>
                ) : null;
              })()}
              <div className="btn primary" onClick={() => void handleScan()} role="button" tabIndex={0}>
                {scanLabel}
              </div>
              <div className="btn" onClick={handleToggleView} role="button" tabIndex={0}>
                ◫ Vaade
              </div>
              <Link className="btn" href="/positions" style={{ textDecoration: "none" }}>
                Positsioonid
              </Link>
              <Link className="btn" href="/sectors" style={{ textDecoration: "none" }}>
                Sektori rotatsioon
              </Link>
            </div>
          </div>
        </div>

        {/* KPI STRIP */}
        <div className="kpi-strip">
          <div className="kpi blue">
            <div className="label">Portfell</div>
            <div className="val" style={{ color: "var(--t1)" }}>
              {portfolioLoading && !portfolioData.kpis ? (
                <span className="skel skel-num" style={{ display: "inline-block", width: 100 }} />
              ) : (
                `€${(portfolioData.kpis?.portfolioTotal ?? 0).toLocaleString()}`
              )}
            </div>
            <div className="sub">
              {portfolioLoading && !portfolioData.kpis ? (
                <span className="skel skel-short" style={{ width: 80 }} />
              ) : (
                <>
                  <span className={((portfolioData.kpis?.dayChgEur ?? 0) >= 0 ? "pos" : "neg")}>
                    {(portfolioData.kpis?.dayChgEur ?? 0) >= 0 ? "+" : ""}€{(portfolioData.kpis?.dayChgEur ?? 0).toLocaleString()}
                  </span>
                  {" · "}
                  {((portfolioData.kpis?.dayChgPct ?? 0) >= 0 ? "+" : "")}
                  {(portfolioData.kpis?.dayChgPct ?? 0).toFixed(2)}% täna
                </>
              )}
            </div>
          </div>
          <div className={`kpi ${((portfolioData.kpis?.unrealizedPnl ?? 0) >= 0 ? "green" : "red")}`}>
            <div className="label">Unrealized P&L</div>
            <div className="val" style={{ color: ((portfolioData.kpis?.unrealizedPnl ?? 0) >= 0 ? "var(--green)" : "var(--red)") }}>
              {portfolioLoading && !portfolioData.kpis ? (
                <span className="skel skel-num" style={{ display: "inline-block", width: 80 }} />
              ) : (
                <>
                  {(portfolioData.kpis?.unrealizedPnl ?? 0) >= 0 ? "+" : ""}€{(portfolioData.kpis?.unrealizedPnl ?? 0).toLocaleString()}
                </>
              )}
            </div>
            <div className="sub">
              {portfolioLoading && !portfolioData.kpis ? (
                <span className="skel skel-short" style={{ width: 100 }} />
              ) : (
                `${(portfolioData.kpis?.unrealizedPnlPct ?? 0) >= 0 ? "+" : ""}${(portfolioData.kpis?.unrealizedPnlPct ?? 0).toFixed(1)}% · kostbasis €${((portfolioData.kpis?.costBasisEur ?? 0) / 1000).toFixed(0)}K`
              )}
            </div>
          </div>
          <div className="kpi green">
            <div className="label">Div. tootlus (TTM)</div>
            <div className="val" style={{ color: "var(--green)" }}>
              {portfolioLoading && !portfolioData.kpis ? (
                <span className="skel skel-num" style={{ display: "inline-block", width: 50 }} />
              ) : (
                `${(portfolioData.kpis?.divYield ?? 0).toFixed(1)}%`
              )}
            </div>
            <div className="sub">
              {portfolioLoading && !portfolioData.kpis ? (
                <span className="skel skel-short" style={{ width: 90 }} />
              ) : (
                `€${(portfolioData.kpis?.divYearlyEur ?? 0).toLocaleString()}/a · €${(portfolioData.kpis?.divMonthlyEur ?? 0).toLocaleString()}/kuu`
              )}
            </div>
          </div>
          <div className="kpi">
            <div className="label">Portfelli beta</div>
            <div className="val">
              {portfolioLoading && !portfolioData.kpis ? (
                <span className="skel skel-num" style={{ display: "inline-block", width: 40 }} />
              ) : (
                portfolioData.kpis?.beta ?? "—"
              )}
            </div>
            <div className="sub">Madalam turu vol · drawdown -22%</div>
          </div>
          <div className="kpi">
            <div className="label">Sharpe ratio</div>
            <div className="val">
              {portfolioLoading && !portfolioData.kpis ? (
                <span className="skel skel-num" style={{ display: "inline-block", width: 40 }} />
              ) : (
                portfolioData.kpis?.sharpe ?? "—"
              )}
            </div>
            <div className="sub">Sortino 0.58 · risk-adj nõrk</div>
          </div>
          <div className="kpi amber">
            <div className="label">Kontsentratsioon</div>
            <div className="val" style={{ color: "var(--amber)" }}>
              {portfolioLoading && !portfolioData.kpis ? (
                <span className="skel skel-num" style={{ display: "inline-block", width: 40 }} />
              ) : (
                `${(portfolioData.kpis?.concentration ?? 0).toFixed(1)}%`
              )}
            </div>
            <div className="sub">UK infra klaster · max 20% soov</div>
          </div>
          <div className="kpi red">
            <div className="label">Tähelepanu</div>
            <div className="val" style={{ color: "var(--red)" }}>
              {portfolioLoading && !portfolioData.kpis ? (
                <span className="skel skel-num" style={{ display: "inline-block", width: 24 }} />
              ) : (
                Math.max(
                  portfolioData.kpis?.attention ?? 0,
                  lastScanUrgentCount + lastScanWarningCount + lastScanInfoCount
                )
              )}
            </div>
            <div className="sub">
              {lastScanUrgentCount} müü · {lastScanWarningCount} RSI · {lastScanInfoCount} target
            </div>
          </div>
        </div>

        {/* MAIN AREA */}
        <div className="main">
          {/* LEFT: ALERTS + TABLE */}
          <div className="main-content">
            {/* ALERTS */}
            <div className="alerts">
              {alertsToRender.map((a) => {
                const alertBtnClass =
                  a.buttonVariant === "danger"
                    ? "btn danger sm action-btn"
                    : a.buttonVariant === "amber"
                      ? "btn amber sm action-btn"
                      : "btn primary sm action-btn";

                const isHtml = a.messageIsHtml ?? a.message.includes("<");

                return (
                  <div key={a.ticker} className={`alert ${a.severity}`}>
                    <div className="dot" />
                    <span className="ticker-badge">{a.ticker === "EQNR.OL" ? "EQNR" : a.ticker}</span>
                    {isHtml ? (
                      <span dangerouslySetInnerHTML={{ __html: a.message }} />
                    ) : (
                      <span style={{ whiteSpace: "pre-wrap" }}>{a.message}</span>
                    )}
                    <div
                      className={alertBtnClass}
                      onClick={() => {
                        if (a.ticker === "UK INFRA") {
                          void handleScan("Fookus: portfelli kontsentratsioon UK infrastruktuuri klastris (TRIG/SEQI/HICL/INPP) ja risk/rebalanss.");
                          return;
                        }
                        void handleAlertAnalyze(a.ticker);
                      }}
                      role="button"
                      tabIndex={0}
                    >
                      {a.buttonLabel}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* TABLE SECTION */}
            <div className="section-head">
              <h2>{filteredAndSortedPositions.length} positsiooni · sort: AI skoor</h2>
              <div className="filters">
                <button
                  className={`filter-btn ${filter === "all" ? "active" : ""}`}
                  onClick={() => setFilter("all")}
                >
                  Kõik
                </button>
                <button
                  className={`filter-btn ${filter === "sell" ? "active" : ""}`}
                  onClick={() => setFilter("sell")}
                >
                  Müü ⚠
                </button>
                <button
                  className={`filter-btn ${filter === "buy" ? "active" : ""}`}
                  onClick={() => setFilter("buy")}
                >
                  Osta ↑
                </button>
                <button
                  className={`filter-btn ${filter === "uk-infra" ? "active" : ""}`}
                  onClick={() => setFilter("uk-infra")}
                >
                  UK Infra
                </button>
                <button
                  className={`filter-btn ${filter === "reit" ? "active" : ""}`}
                  onClick={() => setFilter("reit")}
                >
                  REITid
                </button>
                <button
                  className={`filter-btn ${filter === "growth" ? "active" : ""}`}
                  onClick={() => setFilter("growth")}
                >
                  Kasv
                </button>
              </div>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="cell-ticker">Aktsia</th>
                    <th className="cell-mkt">Turg</th>
                    <th className="cell-price">Hind · päev</th>
                    <th className="cell-pos">Positsioon €</th>
                    <th className="cell-ret">Tootlus</th>
                    <th
                      className="cell-score sortable"
                      onClick={() => setScoreDir((d) => (d === "desc" ? "asc" : "desc"))}
                      role="button"
                      tabIndex={0}
                    >
                      Skoor
                    </th>
                    <th className="cell-signals">Signaalid</th>
                    <th className="cell-chart">4 näd</th>
                    <th className="cell-rsi">RSI · trendi</th>
                    <th className="cell-val">Valuatsioon</th>
                    <th className="cell-div">Div %</th>
                  </tr>
                </thead>
                <tbody id="positions-body">
                  {portfolioLoading
                    ? Array.from({ length: 15 }).map((_, idx) => (
                        <tr key={`sk-${idx}`}>
                          <td className="cell-ticker">
                            <div className="skel skel-num" />
                            <div className="skel skel-short" style={{ marginTop: 4 }} />
                          </td>
                          <td className="cell-mkt">
                            <div className="skel skel-short" style={{ width: 48 }} />
                          </td>
                          <td className="cell-price">
                            <div className="skel skel-num" />
                            <div className="skel skel-short" style={{ marginTop: 4, width: 55 }} />
                          </td>
                          <td className="cell-pos">
                            <div className="skel skel-num" />
                            <div className="skel skel-short" style={{ marginTop: 4, width: 60 }} />
                          </td>
                          <td className="cell-ret">
                            <div className="skel skel-short" style={{ width: 60 }} />
                          </td>
                          <td className="cell-score">
                            <div className="skel skel-short" style={{ width: 36, height: 36, borderRadius: 18 }} />
                          </td>
                          <td className="cell-signals">
                            <div className="skel skel-pill" style={{ width: 80 }} />
                            <div className="skel skel-pill" style={{ width: 60, marginTop: 4 }} />
                          </td>
                          <td className="cell-chart">
                            <div className="skel skel-short" style={{ width: 60, height: 24 }} />
                          </td>
                          <td className="cell-rsi">
                            <div className="skel skel-short" style={{ width: 40 }} />
                            <div className="skel skel-line" style={{ marginTop: 4 }} />
                            <div className="skel skel-short" style={{ width: 90, marginTop: 4 }} />
                          </td>
                          <td className="cell-val">
                            <div className="skel skel-pill" style={{ width: 70 }} />
                            <div className="skel skel-pill" style={{ width: 60, marginTop: 4 }} />
                          </td>
                          <td className="cell-div">
                            <div className="skel skel-short" style={{ width: 52 }} />
                          </td>
                        </tr>
                      ))
                    : filteredAndSortedPositions.map((p) => {
                    const rsiCol =
                      p.rsi > 70
                        ? "var(--red)"
                        : p.rsi > 60
                          ? "var(--amber)"
                          : p.rsi < 35
                            ? "var(--red)"
                            : "var(--green)";

                    const pricePrefix = p.cur === "GBX" ? "£" : p.cur === "USD" ? "$" : "";
                    const displayPrice = `${pricePrefix}${p.price.toFixed(2)}`;

                    const chosenSource = portfolioData.data_quality?.[p.tk]?.chosenSource;

                    return (
                      <tr
                        key={p.tk}
                        className={p.flagged ? "flagged" : undefined}
                        onClick={() => {
                          setSelectedTicker(p.tk);
                          setModalOpen(true);
                        }}
                      >
                        <td className="cell-ticker">
                          <div className="tk" title={chosenSource ? `Data source: ${chosenSource}` : undefined}>
                            {p.tk}
                            {p.flagged ? " ⚠" : ""}
                          </div>
                          <div className="tk-name">{p.name}</div>
                        </td>

                        <td className="cell-mkt">
                          <span className={`mkt-tag ${p.mkt}`}>{p.mkt.toUpperCase()}</span>
                        </td>

                        <td className="cell-price">
                          <div className="price-main">{displayPrice}</div>
                          <div className={`chg ${p.chg >= 0 ? "pos" : "neg"}`}>
                            {p.chg >= 0 ? "+" : ""}
                            {p.chg.toFixed(2)}%
                          </div>
                        </td>

                        <td className="cell-pos">
                          <div className="eur-val">€{p.eur.toLocaleString()}</div>
                          <div className="pct-port">{p.pct}%</div>
                        </td>

                        <td className="cell-ret">
                          <div className={`chg ${p.ret >= 0 ? "pos" : "neg"}`} style={{ fontSize: 13, fontWeight: 700 }}>
                            {p.ret >= 0 ? "+" : ""}
                            {p.ret.toFixed(1)}%
                          </div>
                        </td>

                        <td className="cell-score">
                          <ScoreRing score={p.score} />
                        </td>

                        <td className="cell-signals">
                          <div className="sigs">
                            {p.sigs.map((s, i) => (
                              <span key={`${p.tk}-${i}`} className={`sig ${p.sigT[i]}`}>
                                {s}
                              </span>
                            ))}
                          </div>
                        </td>

                        <td className="cell-chart">
                          <Sparkline data={p.spark} ret={p.ret} />
                        </td>

                        <td className="cell-rsi">
                          <div className="rsi-wrap">
                            <div className="rsi-num" style={{ color: rsiCol }}>
                              {p.rsi}
                            </div>
                            <div className="rsi-track">
                              <div
                                className="rsi-fill"
                                style={{
                                  width: `${p.rsi}%`,
                                  background: rsiCol,
                                }}
                              />
                            </div>
                            <div className="rsi-ctx">{p.rsiCtx}</div>
                          </div>
                        </td>

                        <td className="cell-val">
                          <div className="vpills">
                            {p.pe !== "—" ? <span className="vpill">P/E {p.pe}</span> : null}
                            {p.fpe !== "—" ? <span className="vpill">fP {p.fpe}</span> : null}
                          </div>
                        </td>

                        <td className="cell-div">
                          <span
                            style={{
                              color: p.div >= 6 ? "var(--green)" : p.div >= 3 ? "var(--t1)" : "var(--t3)",
                              fontFamily: "var(--font-mono)",
                              fontWeight: 500,
                            }}
                          >
                            {p.div > 0 ? `${p.div.toFixed(1)}%` : "—"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* RIGHT SIDEBAR */}
          <div className="sidebar-right">
            {/* AI ADVISOR */}
            <div className="sb-section">
              <div className="sb-title">
                AI nõunik <span className="live">reaalajas</span>
              </div>
              <div className="advisor">
                <div className="advisor-header">
                  <div className="advisor-avatar">AI</div>
                  <div>
                    <div className="advisor-name">Portfellihaldur</div>
                    <div className="advisor-role">30a kogemus · Bridgewater, Citadel, Renaissance</div>
                  </div>
                </div>
                <div className="advisor-msg" dangerouslySetInnerHTML={{ __html: aiAdvisorHtml }} />
                <div className="advisor-actions">
                  <div className="btn primary sm" onClick={() => window.console.log("Kinnita plaan")} role="button" tabIndex={0}>
                    Kinnita plaan
                  </div>
                  <div className="btn sm" onClick={() => window.console.log("Muuda")} role="button" tabIndex={0}>
                    Muuda
                  </div>
                  <div className="btn sm" onClick={() => window.console.log("Arutle vastu")} role="button" tabIndex={0}>
                    Arutle vastu
                  </div>
                </div>
              </div>
            </div>

            {/* PERFORMANCE GRAPH */}
            <div className="sb-section">
              <div className="sb-title">Performance · portfell vs S&P500</div>
              <div style={{ width: "100%", height: 180, marginTop: 8 }}>
                {performanceData.portfolio.length > 0 || performanceData.spy.length > 0 ? (
                  (() => {
                    const byDate = new Map<string, { date: string; portfolio: number; spy: number }>();
                    for (const p of performanceData.portfolio) {
                      byDate.set(p.date, { date: p.date, portfolio: p.value, spy: 0 });
                    }
                    for (const s of performanceData.spy) {
                      const ex = byDate.get(s.date);
                      if (ex) ex.spy = s.value;
                      else byDate.set(s.date, { date: s.date, portfolio: 0, spy: s.value });
                    }
                    const chartData = Array.from(byDate.values())
                      .filter((d) => d.portfolio > 0 || d.spy > 0)
                      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
                      .map((d) => ({
                        ...d,
                        dateShort: new Date(d.date).toLocaleDateString("et-EE", { day: "2-digit", month: "2-digit" }),
                      }));
                    return (
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                          <CartesianGrid stroke="rgba(255,255,255,0.06)" />
                          <XAxis
                            dataKey="dateShort"
                            tick={{ fill: "var(--t3)", fontSize: 9, fontFamily: "var(--font-mono)" }}
                            axisLine={false}
                            tickLine={false}
                          />
                          <YAxis
                            tick={{ fill: "var(--t3)", fontSize: 9, fontFamily: "var(--font-mono)" }}
                            axisLine={false}
                            tickLine={false}
                            tickFormatter={(v) => `${v}%`}
                          />
                          <Tooltip
                            contentStyle={{ background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 8 }}
                            labelFormatter={(_, payload) => payload?.[0]?.payload?.date}
                            formatter={(v) => [typeof v === "number" ? `${v.toFixed(1)}%` : "—", ""]}
                          />
                          <Legend wrapperStyle={{ fontSize: 10 }} />
                          <Line
                            type="monotone"
                            dataKey="portfolio"
                            name="Portfell"
                            stroke="var(--green)"
                            strokeWidth={2}
                            dot={false}
                            connectNulls
                          />
                          <Line
                            type="monotone"
                            dataKey="spy"
                            name="S&P500"
                            stroke="var(--purple)"
                            strokeWidth={2}
                            dot={false}
                            connectNulls
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    );
                  })()
                ) : (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      height: "100%",
                      color: "var(--t3)",
                      fontSize: 11,
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    Puuduvad andmed · cron skan täidab history.json
                  </div>
                )}
              </div>
            </div>

            {/* MACRO CONTEXT */}
            <div className="sb-section">
              <div className="sb-title">
                Makro kontekst <span className="live">reaalajas</span>
              </div>
              <div className="macro-grid">
                {portfolioLoading && !portfolioData.macro?.items?.length
                  ? Array.from({ length: 8 }).map((_, idx) => (
                      <div key={`sk-macro-${idx}`} className="macro-item">
                        <div className="mi-label">
                          <span className="skel skel-short" style={{ width: 60 }} />
                        </div>
                        <div className="mi-val">
                          <span className="skel skel-num" style={{ width: 50, marginTop: 4 }} />
                        </div>
                        <div className="mi-chg">
                          <span className="skel skel-short" style={{ width: 80, marginTop: 4 }} />
                        </div>
                      </div>
                    ))
                  : (portfolioData.macro?.items ?? []).map((m) => (
                      <div key={m.label} className="macro-item">
                        <div className="mi-label">{m.label}</div>
                        <div className="mi-val">{m.value}</div>
                        <div
                          className="mi-chg"
                          style={{
                            color: (m.chg ?? 0) > 0 ? "var(--green)" : (m.chg ?? 0) < 0 ? "var(--red)" : "var(--t3)",
                          }}
                        >
                          {m.chgText ?? "—"}
                        </div>
                      </div>
                    ))}
              </div>
            </div>

            {/* SECTOR ALLOCATION */}
            <div className="sb-section">
              <div className="sb-title">Sektori jaotus</div>
              <div className="alloc-bars" id="sector-bars">
                {portfolioLoading
                  ? Array.from({ length: 8 }).map((_, idx) => (
                      <div className="alloc-row" key={`sk-sec-${idx}`}>
                        <div className="alloc-label">
                          <div className="skel skel-short" style={{ width: 70 }} />
                        </div>
                        <div className="alloc-track">
                          <div className="skel skel-short" style={{ height: 6 }} />
                        </div>
                        <div className="alloc-pct">
                          <div className="skel skel-short" style={{ width: 32 }} />
                        </div>
                      </div>
                    ))
                  : portfolioData.sectors_allocation.map((s) => (
                      <div className="alloc-row" key={s.name}>
                        <div className="alloc-label">{s.name}</div>
                        <div className="alloc-track">
                          <div className="alloc-fill" style={{ width: `${s.pct}%`, background: s.color }} />
                        </div>
                        <div className="alloc-pct">{s.pct}%</div>
                      </div>
                    ))}
              </div>
            </div>

            {/* CORRELATION WARNING */}
            <div className="sb-section">
              <div className="sb-title">Korrelatsioon · risk</div>
              <div style={{ marginBottom: "8px" }}>
                <div style={{ fontSize: "10px", color: "var(--t3)", marginBottom: "4px" }}>Portfelli kontsentratsioon</div>
                <div className="risk-meter">
                  <span style={{ fontSize: "9px", color: "var(--green)" }}>Madal</span>
                  <div className="rm-track">
                    <div className="rm-needle" style={{ left: "68%" }} />
                  </div>
                  <span style={{ fontSize: "9px", color: "var(--red)" }}>Kõrge</span>
                </div>
              </div>

              <div id="corr-map" style={{ marginTop: "8px" }}>
                {portfolioLoading ? (
                  <div className="corr-grid" style={{ gridTemplateColumns: `40px repeat(28,1fr)` }}>
                    {Array.from({ length: (28 + 1) * (28 + 1) }).map((_, idx) => (
                      <div key={`sk-corr-${idx}`} className="corr-cell skel" />
                    ))}
                  </div>
                ) : (
                  (() => {
                    const tickers = portfolioData.correlation.tickers ?? [];
                    const data = portfolioData.correlation.matrix ?? [];
                    const n = tickers.length || 1;
                    const gridStyle: CSSProperties = {
                      gridTemplateColumns: `40px repeat(${n},1fr)`,
                    };

                    const cells: ReactNode[] = [];
                    cells.push(<div key="tl" />);
                    tickers.forEach((t) =>
                      cells.push(
                        <div key={`col-${t}`} className="corr-label">
                          {t}
                        </div>
                      )
                    );
                    data.forEach((row, i) => {
                      cells.push(
                        <div key={`row-${tickers[i]}`} className="corr-label">
                          {tickers[i]}
                        </div>
                      );
                      row.forEach((v, j) => {
                        const intensity = Math.abs(v);
                        const hue = v > 0.7 ? "var(--red)" : v > 0.5 ? "var(--amber)" : "var(--green)";
                        const rgb = v > 0.7 ? "255,71,87" : v > 0.5 ? "255,184,48" : "0,214,143";
                        const bg = i === j ? "var(--bg4)" : `rgba(${rgb},${intensity * 0.3})`;

                        return cells.push(
                          <div
                            key={`cell-${i}-${j}`}
                            className="corr-cell"
                            style={{ background: bg, color: i === j ? "var(--t3)" : hue }}
                          >
                            {i === j ? "—" : v.toFixed(2)}
                          </div>
                        );
                      });
                    });

                    return (
                      <div className="corr-grid" style={gridStyle}>
                        {cells}
                      </div>
                    );
                  })()
                )}
              </div>

              <div style={{ fontSize: "10px", color: "var(--t3)", marginTop: "6px" }}>
                ⚠ UK infra klaster (TRIG/SEQI/HICL/INPP) korrelatsioon{" "}
                <strong style={{ color: "var(--red)" }}>0.89</strong> — liiguvad koos. Hajutamine nõutav.
              </div>
            </div>

            {/* NEWS FEED */}
            <div className="sb-section">
              <div className="sb-title">
                Uudised · mõju <span className="live">reaalajas</span>
              </div>
              <div id="news-feed">
                {portfolioLoading
                  ? Array.from({ length: 5 }).map((_, idx) => (
                      <div className="news-item" key={`sk-news-${idx}`}>
                        <div className="skel skel-short" style={{ width: 90, height: 10 }} />
                        <div className="skel skel-short" style={{ width: 240, height: 12, marginTop: 6 }} />
                        <div className="skel skel-short" style={{ width: 160, height: 16, marginTop: 10 }} />
                      </div>
                    ))
                  : portfolioData.news.map((n) => (
                      <div className="news-item" key={`${n.time}-${n.tag}`}>
                        <div className="news-time">{n.time} CET</div>
                        <div className="news-headline" dangerouslySetInnerHTML={{ __html: n.headline }} />
                        <div className={`news-impact ${n.impact}`}>
                          {n.impact === "bull" ? "↑ Bullish" : n.impact === "bear" ? "↓ Bearish" : "— Neutraalne"} · {n.tag}
                        </div>
                      </div>
                    ))}
              </div>
            </div>

            {/* EARNINGS CALENDAR */}
            <div className="sb-section">
              <div className="sb-title">Earningute kalender</div>
              <div id="earnings-cal">
                {portfolioLoading
                  ? Array.from({ length: 4 }).map((_, idx) => (
                      <div
                        key={`sk-earn-${idx}`}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                          padding: "6px 0",
                          borderBottom: "1px solid rgba(26,31,50,0.4)",
                          fontSize: "11px",
                        }}
                      >
                        <div className="skel skel-short" style={{ width: 40, height: 10 }} />
                        <div className="skel skel-short" style={{ width: 50, height: 12 }} />
                        <div className="skel skel-short" style={{ width: 140, height: 12, flex: 1 }} />
                        <div className="skel skel-short" style={{ width: 80, height: 12 }} />
                      </div>
                    ))
                  : portfolioData.earnings.map((e) => (
                      <div
                        key={`${e.date}-${e.tk}`}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                          padding: "6px 0",
                          borderBottom: "1px solid rgba(26,31,50,0.4)",
                          fontSize: "11px",
                        }}
                      >
                        <div style={{ width: "40px", fontFamily: "var(--font-mono)", color: "var(--amber)", fontWeight: 600, fontSize: "10px" }}>
                          {e.date}
                        </div>
                        <div style={{ fontWeight: 600, fontFamily: "var(--font-mono)" }}>{e.tk}</div>
                        <div style={{ color: "var(--t2)", flex: 1 }}>{e.name}</div>
                        <div style={{ color: "var(--t3)", fontFamily: "var(--font-mono)", fontSize: "10px" }}>{e.est}</div>
                      </div>
                    ))}
              </div>
            </div>
          </div>
        </div>

      {modalOpen && selectedTicker ? (
        <div
          className="modal-backdrop"
          onClick={() => {
            setModalOpen(false);
            setSelectedTicker(null);
            setTickerHistory(null);
            setAiAnalyze(null);
            setChat([]);
            try {
              if (lightweightChartRef.current?.chart) lightweightChartRef.current.chart.remove();
            } catch {
              // ignore
            }
            lightweightChartRef.current = null;
          }}
          role="dialog"
          aria-modal="true"
        >
          <style>{`
            .modal-backdrop{
              position:fixed; inset:0; background:rgba(0,0,0,0.62);
              display:flex; align-items:flex-start; justify-content:center;
              padding:72px 18px 18px; z-index:9999;
            }
            .modal{
              width:min(1100px, 100%);
              background:var(--bg2); border:1px solid var(--border);
              border-radius:16px; overflow:hidden;
              box-shadow:0 18px 60px rgba(0,0,0,0.55);
            }
            .modal-head{
              padding:12px 16px; display:flex; justify-content:space-between; align-items:center;
              border-bottom:1px solid rgba(26,31,50,0.55);
              background:linear-gradient(180deg, rgba(11,14,22,0.92), rgba(11,14,22,0.78));
            }
            .modal-title{font-family:var(--font-mono); font-weight:800;}
            .icon-btn{background:transparent; border:1px solid var(--border); color:var(--t2);
              padding:6px 10px; border-radius:10px; cursor:pointer; font-family:var(--font-mono);}
            .modal-body{padding:14px 16px;}
            .modal-grid{display:grid; grid-template-columns: 1.35fr 1fr; gap:12px;}
            .modal-card{background:var(--bg3); border:1px solid var(--border); border-radius:14px; padding:12px;}
            .modal-row{display:flex; gap:10px; align-items:center; flex-wrap:wrap;}
            input, textarea{
              background:rgba(0,0,0,0); border:1px solid rgba(26,31,50,0.9);
              color:var(--t1); border-radius:10px; padding:8px 10px; font-family:var(--font-mono);
              outline:none;
            }
            textarea{width:100%; min-height:70px; resize:vertical;}
            .modal-actions{display:flex; gap:10px; flex-wrap:wrap; margin-top:10px;}
            .btn{cursor:pointer;}
          `}</style>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div className="modal-title">
                {selectedTicker} · positsioon detailid
              </div>
              <button className="icon-btn" type="button" onClick={() => setModalOpen(false)}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              <div className="modal-grid">
                <div className="modal-card">
                  <div className="section-head" style={{ marginBottom: 10 }}>
                    <h2 style={{ margin: 0 }}>Küünlakuju + MA</h2>
                    <div style={{ color: "var(--t3)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
                      {tickerHistoryLoading ? "Laen graafikut..." : tickerHistoryError ? "Graafik ebaõnnestus" : `Allikas: ${tickerHistory?.chosenSource ?? "—"}`}
                    </div>
                  </div>
                  <div ref={chartContainerRef} style={{ width: "100%", height: 340 }} />
                </div>
                <div className="modal-card">
                  <div className="section-head" style={{ marginBottom: 10 }}>
                    <h2 style={{ margin: 0 }}>AI analüüs + salvestus</h2>
                    <div style={{ color: "var(--t3)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
                      {aiAnalyzeLoading ? "Analüüsin..." : "Valmis, kui vajutad nupule"}
                    </div>
                  </div>

                  {aiAnalyze ? (
                    <>
                      <div
                        className="advisor-msg"
                        style={{ marginBottom: 10 }}
                        dangerouslySetInnerHTML={{
                          __html: `<strong>Signal:</strong> ${aiAnalyze.signal}<br/><strong>Skoor:</strong> ${aiAnalyze.score}<br/><strong>Target:</strong> ${aiAnalyze.target}<br/><strong>Stop:</strong> ${aiAnalyze.stop_loss}`,
                        }}
                      />
                      <div dangerouslySetInnerHTML={{ __html: aiAnalyze.rationaleHtml }} />
                    </>
                  ) : (
                    <div style={{ color: "var(--t2)", fontFamily: "var(--font-mono)", fontSize: 12, marginBottom: 10 }}>
                      Vajuta “Analüüsi” et saada SIGNAAL/SKOOR/TARGET/STOP_LOSS.
                    </div>
                  )}

                  <div className="modal-actions">
                    <div className="btn primary sm" onClick={() => void (async () => {
                      if (!selectedTicker) return;
                      setAiAnalyzeLoading(true);
                      try {
                        const res = await fetch("/api/ai", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ action: "analyze", ticker: selectedTicker }),
                        });
                        if (!res.ok) throw new Error(`HTTP ${res.status}`);
                        const ai = await res.json();
                        setAiAnalyze(ai as AiAnalyzeResponse);
                        if (typeof ai?.target === "number") setTargetDraft(ai.target);
                        if (typeof ai?.stop_loss === "number") setStopDraft(ai.stop_loss);
                      } catch {
                        setAiAnalyze(null);
                      } finally {
                        setAiAnalyzeLoading(false);
                      }
                    })()} role="button" tabIndex={0}>
                      Analüüsi
                    </div>
                  </div>

                  <div style={{ height: 10 }} />

                  <div className="modal-row" style={{ marginBottom: 8 }}>
                    <div style={{ color: "var(--t3)", fontFamily: "var(--font-mono)", fontSize: 11 }}>Tees</div>
                  </div>
                  <textarea value={teesDraft} onChange={(e) => setTeesDraft(e.target.value)} placeholder="Sinu thesis..." />

                  <div className="modal-row" style={{ marginTop: 10 }}>
                    <div style={{ flex: 1, minWidth: 160 }}>
                      <div style={{ color: "var(--t3)", fontFamily: "var(--font-mono)", fontSize: 11 }}>Target</div>
                      <input type="number" value={targetDraft} onChange={(e) => setTargetDraft(Number(e.target.value))} />
                    </div>
                    <div style={{ flex: 1, minWidth: 160 }}>
                      <div style={{ color: "var(--t3)", fontFamily: "var(--font-mono)", fontSize: 11 }}>Stop-loss</div>
                      <input type="number" value={stopDraft} onChange={(e) => setStopDraft(Number(e.target.value))} />
                    </div>
                  </div>

                  <div className="modal-actions">
                    <div
                      className="btn sm"
                      onClick={() => {
                        if (!selectedTicker) return;
                        void (async () => {
                          try {
                            await fetch("/api/portfolio", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                action: "update",
                                ticker: selectedTicker,
                                target: targetDraft,
                                stop_loss: stopDraft,
                                tees: teesDraft,
                              }),
                            });
                          } finally {
                            // Refresh will happen on the next 5-minute tick.
                          }
                        })();
                      }}
                      role="button"
                      tabIndex={0}
                    >
                      Salvesta
                    </div>
                  </div>
                </div>
              </div>

              <div style={{ height: 12 }} />

              <div className="modal-card">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 10 }}>
                  <div>
                    <div style={{ fontWeight: 800, fontFamily: "var(--font-mono)" }}>Tees chat</div>
                    <div style={{ color: "var(--t3)", fontFamily: "var(--font-mono)", fontSize: 11 }}>Vestlus + AI vastus</div>
                  </div>
                </div>
                <div style={{ maxHeight: 220, overflow: "auto", paddingRight: 6 }}>
                  {chat.length ? (
                    chat.map((m, idx) => (
                      <div key={idx} style={{ padding: "8px 0", borderBottom: "1px solid rgba(26,31,50,0.45)" }}>
                        <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, color: m.role === "user" ? "var(--t1)" : "var(--purple)" }}>
                          {m.role === "user" ? "Sina" : "AI"}
                        </div>
                        {m.html ? <div dangerouslySetInnerHTML={{ __html: m.html }} /> : <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>}
                      </div>
                    ))
                  ) : (
                    <div style={{ color: "var(--t2)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                      Alusta küsimusega: “Kuidas see tees tänase hinnaga vastu peab?”
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                  <input
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="Kirjuta küsimus..."
                    style={{ flex: 1 }}
                  />
                  <div
                    className="btn primary sm"
                    onClick={() => {
                      if (!selectedTicker || !chatInput.trim()) return;
                      const msg = chatInput.trim();
                      setChatInput("");
                      setChat((prev) => [...prev, { role: "user", text: msg }]);
                      void (async () => {
                        try {
                          const res = await fetch("/api/ai", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ action: "chat", ticker: selectedTicker, message: msg }),
                          });
                          if (!res.ok) throw new Error(`HTTP ${res.status}`);
                          const ai = (await res.json()) as AiChatResponse;
                          setChat((prev) => [...prev, { role: "ai", html: ai.replyHtml }]);
                        } catch {
                          setChat((prev) => [...prev, { role: "ai", text: "AI vastus ebaõnnestus." }]);
                        }
                      })();
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    Saada
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      </div>
    </>
  );
}
