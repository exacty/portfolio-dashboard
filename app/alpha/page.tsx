"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

type Position = {
  tk: string;
  name: string;
  price: number;
  cur: string;
  ret: number;
  eur: number;
  score: number;
  flagged?: boolean;
};

type PortfolioResponse = {
  positions: Position[];
  kpis?: {
    portfolioTotal?: number;
    unrealizedPnl?: number;
    dayChgPct?: number;
    divYield?: number;
  };
  macro?: { items?: Array<{ label: string; value: string }> };
  sectors_allocation?: Array<{ name: string; pct: number; color: string }>;
  news?: Array<{ time: string; headline: string; tag: string }>;
};

const QUICK_ACTIONS = [
  { label: "📊 Portfelli ülevaade", msg: "Anna portfelli ülevaade: kokkuvõte, tugevused ja nõrkused, peamised riskid." },
  { label: "⚠️ Mis vajab tähelepanu?", msg: "Mis positsioonid vajavad tähelepanu? Too välja kriitilised ja riskantsed." },
  { label: "💰 Rebalanseerimisplaan", msg: "Koosta konkreetne rebalanseerimisplaan: mida müüa, mida osta, millised summad." },
  { label: "📈 Parimad võimalused", msg: "Anna 3–5 parimat uue ostu võimalust praeguse makrokeskkonna ja portfelli põhjal." },
  { label: "🔄 Sektori rotatsioon", msg: "Analüüsi sektori rotatsioon: millised sektorid on tõusmas, millised langevad?" },
  { label: "📰 Uudiste mõju", msg: "Analüüsi tänased uudised — mis mõju neil on minu portfellile?" },
  { label: "🎯 Teeside ülevaade", msg: "Kontrolli kõikide positsioonide teese — kas need kehtivad endiselt?" },
];

const SAMPLE_PROMPTS = [
  "Kas peaksin UK infra vähendama?",
  "Leia mulle 3 uut dividendiaktsiat",
  "Mis on minu praegune suurim risk?",
];

const styles = `
:root{--bg:#06080d;--bg2:#0b0e16;--bg3:#10141f;--bg4:#161b2a;--bg5:#1c2235;--border:#1a1f32;--border2:#252b42;--t1:#e8e6df;--t2:#9a98a0;--t3:#5c5a66;--t4:#3a3844;--green:#00d68f;--red:#ff4757;--amber:#ffb830;--blue:#4d8dff;--green-bg:rgba(0,214,143,0.06);--red-bg:rgba(255,71,87,0.06);--amber-bg:rgba(255,184,48,0.06);--font-display:'Outfit',sans-serif;--font-mono:'JetBrains Mono',monospace}
.alpha-page{min-height:100vh;display:grid;grid-template-columns:35% 65%;background:var(--bg);color:var(--t1);font-family:var(--font-display)}
.alpha-left{background:var(--bg2);border-right:1px solid var(--border);overflow-y:auto;padding:16px}
.alpha-right{display:flex;flex-direction:column;overflow:hidden}
.alpha-left h3{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--t3);margin:0 0 8px 0;font-weight:600}
.alpha-summary{display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap}
.alpha-summary span{font-size:12px;font-family:var(--font-mono);font-weight:600}
.alpha-summary .pos{color:var(--green)}
.alpha-summary .neg{color:var(--red)}
.alpha-pos-list{font-size:11px;margin-bottom:16px}
.alpha-pos-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;margin-bottom:2px}
.alpha-pos-row:hover{background:var(--bg4)}
.alpha-pos-row.flagged{background:rgba(255,71,87,0.08);border-left:3px solid var(--red)}
.alpha-pos-row .tk{font-weight:600;font-family:var(--font-mono);min-width:70px}
.alpha-pos-row .price{font-family:var(--font-mono);min-width:70px}
.alpha-pos-row .ret{min-width:50px;font-family:var(--font-mono)}
.alpha-pos-row .eur{min-width:70px;font-family:var(--font-mono);color:var(--t2)}
.alpha-pos-row .score-ring{width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700}
.alpha-macro{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px;font-size:10px;font-family:var(--font-mono)}
.alpha-macro span{background:var(--bg4);padding:4px 8px;border-radius:4px;color:var(--t2)}
.alpha-sectors{display:flex;flex-direction:column;gap:8px}
.alpha-sector-row{display:flex;align-items:center;gap:8px;font-size:11px}
.alpha-sector-row .label{width:70px;color:var(--t2)}
.alpha-sector-row .bar{flex:1;height:6px;background:var(--bg);border-radius:3px;overflow:hidden}
.alpha-sector-row .fill{height:100%;border-radius:3px;transition:width 0.8s}
.alpha-sector-row .pct{width:36px;font-family:var(--font-mono);font-size:10px;color:var(--t3)}
.alpha-chat-header{display:flex;align-items:center;justify-content:space-between;padding:16px 24px;border-bottom:1px solid var(--border);background:var(--bg2)}
.alpha-chat-title{font-size:18px;font-weight:800;font-family:var(--font-mono)}
.alpha-chat-sub{font-size:11px;color:var(--t3);margin-top:4px}
.alpha-online{display:flex;align-items:center;gap:6px;font-size:10px;color:var(--green)}
.alpha-online-dot{width:8px;height:8px;border-radius:50%;background:var(--green);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
.alpha-quick{display:flex;flex-wrap:wrap;gap:8px;padding:12px 24px;border-bottom:1px solid var(--border);background:var(--bg2)}
.alpha-quick-btn{padding:6px 12px;border-radius:8px;font-size:11px;font-weight:500;border:1px solid var(--border);background:var(--bg3);color:var(--t2);cursor:pointer;transition:all 0.12s}
.alpha-quick-btn:hover{background:var(--bg4);color:var(--t1);border-color:var(--border2)}
.alpha-messages{flex:1;overflow-y:auto;padding:24px;display:flex;flex-direction:column;gap:16px}
.alpha-msg{max-width:85%;padding:14px 18px;border-radius:12px;font-size:13px;line-height:1.65}
.alpha-msg.user{align-self:flex-end;background:var(--blue-bg);border:1px solid var(--blue);margin-left:auto}
.alpha-msg.ai{align-self:flex-start;background:var(--bg3);border:1px solid var(--border);font-family:Georgia,serif}
.alpha-msg.ai strong{color:var(--t1)}
.alpha-msg.ai .ticker-highlight{color:var(--green);cursor:pointer;text-decoration:underline}
.alpha-msg.ai .ticker-highlight.neg{color:var(--red)}
.alpha-loading{display:flex;align-items:center;gap:8px;padding:14px 18px;background:var(--bg3);border:1px solid var(--border);border-radius:12px;font-size:12px;color:var(--t3);max-width:200px}
.alpha-loading-dot{width:6px;height:6px;border-radius:50%;background:var(--green);animation:pulse 1s infinite}
.alpha-samples{display:flex;flex-direction:column;gap:8px;margin-top:16px}
.alpha-sample{padding:12px 16px;border-radius:8px;border:1px solid var(--border);background:var(--bg4);font-size:12px;color:var(--t2);cursor:pointer;transition:all 0.12s;text-align:left}
.alpha-sample:hover{background:var(--bg5);color:var(--t1);border-color:var(--border2)}
.alpha-input-wrap{display:flex;gap:12px;padding:16px 24px;border-top:1px solid var(--border);background:var(--bg2);align-items:flex-end}
.alpha-input-wrap textarea{flex:1;min-height:80px;max-height:200px;padding:12px 16px;background:var(--bg4);border:1px solid var(--border);border-radius:10px;color:var(--t1);font-size:13px;font-family:var(--font-mono);resize:vertical;outline:none}
.alpha-input-wrap textarea::placeholder{color:var(--t4)}
.alpha-input-wrap textarea:focus{border-color:var(--blue)}
.alpha-send{background:var(--blue);color:#fff;border:none;border-radius:10px;padding:12px 24px;font-size:13px;font-weight:600;cursor:pointer}
.alpha-send:disabled{opacity:0.5;cursor:not-allowed}
.alpha-mic{background:var(--bg4);border:1px solid var(--border);color:var(--t3);width:44px;height:44px;border-radius:10px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:18px}
.btn{padding:6px 12px;border-radius:6px;font-size:11px;font-weight:500;border:1px solid var(--border);background:var(--bg3);color:var(--t2);cursor:pointer;transition:all 0.12s;text-decoration:none}
.btn:hover{background:var(--bg4);color:var(--t1)}
@media(max-width:900px){.alpha-page{grid-template-columns:1fr}.alpha-left{max-height:40vh}}
`;

export default function AlphaPage() {
  const [portfolio, setPortfolio] = useState<PortfolioResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState<Array<{ role: "user" | "ai"; content: string }>>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/portfolio");
        if (!res.ok) throw new Error("Failed to fetch");
        const data = (await res.json()) as PortfolioResponse;
        setPortfolio(data);
      } catch {
        setPortfolio({ positions: [] });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, sending, scrollToBottom]);

  const sendMessage = useCallback(
    async (msg: string) => {
      const m = msg.trim();
      if (!m || sending) return;
      setMessages((prev) => [...prev, { role: "user", content: m }]);
      setInput("");
      setSending(true);
      try {
        const res = await fetch("/api/ai", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "portfolio_chat", message: m }),
        });
        const data = (await res.json()) as { replyHtml?: string; error?: string };
        const reply = typeof data.replyHtml === "string" ? data.replyHtml : data.error ?? "Vastus puudub.";
        setMessages((prev) => [...prev, { role: "ai", content: reply }]);
      } catch {
        setMessages((prev) => [...prev, { role: "ai", content: "Viga ühendusel." }]);
      } finally {
        setSending(false);
      }
    },
    [sending]
  );

  const handleQuickAction = (msg: string) => () => sendMessage(msg);
  const handleSampleClick = (msg: string) => () => sendMessage(msg);
  const handleNewChat = () => setMessages([]);

  const handleSubmit = () => {
    sendMessage(input);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const kpis = portfolio?.kpis;
  const positions = portfolio?.positions ?? [];
  const macro = portfolio?.macro?.items ?? [];
  const sectors = portfolio?.sectors_allocation ?? [];
  const showSamples = messages.length === 0 && !sending;

  return (
    <div className="alpha-page">
      <style>{styles}</style>

      {/* LEFT: Portfolio context */}
      <div className="alpha-left">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <Link className="btn" href="/" style={{ textDecoration: "none", padding: "6px 12px", fontSize: 11 }}>
            ← Dashboard
          </Link>
        </div>

        <div className="alpha-summary">
          {loading ? (
            <span>Laen...</span>
          ) : (
            <>
              <span>Portfell €{(kpis?.portfolioTotal ?? 0).toLocaleString("de-DE", { maximumFractionDigits: 0 })}</span>
              <span className={(kpis?.unrealizedPnl ?? 0) >= 0 ? "pos" : "neg"}>
                P&L {(kpis?.unrealizedPnl ?? 0) >= 0 ? "+" : ""}€{(kpis?.unrealizedPnl ?? 0).toLocaleString("de-DE", { maximumFractionDigits: 0 })}
              </span>
              <span>Div {(kpis?.divYield ?? 0).toFixed(1)}%</span>
            </>
          )}
        </div>

        <h3>Positsioonid</h3>
        <div className="alpha-pos-list">
          {positions.slice(0, 25).map((p) => (
            <div
              key={p.tk}
              className={`alpha-pos-row ${p.flagged ? "flagged" : ""}`}
              onClick={() => handleSampleClick(`Räägi mulle ${p.tk}-ist`)}
              role="button"
              tabIndex={0}
            >
              <span className="tk">{p.tk}</span>
              <span className="price">{p.price.toFixed(2)}</span>
              <span className={`ret ${p.ret >= 0 ? "pos" : "neg"}`} style={{ color: p.ret >= 0 ? "var(--green)" : "var(--red)" }}>
                {p.ret >= 0 ? "+" : ""}{p.ret.toFixed(1)}%
              </span>
              <span className="eur">€{p.eur.toLocaleString("de-DE", { maximumFractionDigits: 0 })}</span>
              <div
                className="score-ring"
                style={{
                  background: (p.score ?? 50) >= 60 ? "var(--green-bg)" : (p.score ?? 50) < 40 ? "var(--red-bg)" : "var(--amber-bg)",
                  color: (p.score ?? 50) >= 60 ? "var(--green)" : (p.score ?? 50) < 40 ? "var(--red)" : "var(--amber)",
                }}
              >
                {p.score ?? 50}
              </div>
            </div>
          ))}
        </div>

        <h3>Makro</h3>
        <div className="alpha-macro">
          {macro.slice(0, 6).map((m) => (
            <span key={m.label}>
              {m.label} {m.value}
            </span>
          ))}
        </div>

        <h3>Sektori jaotus</h3>
        <div className="alpha-sectors">
          {sectors.slice(0, 8).map((s) => (
            <div key={s.name} className="alpha-sector-row">
              <span className="label">{s.name}</span>
              <div className="bar">
                <div className="fill" style={{ width: `${s.pct}%`, background: s.color || "var(--blue)" }} />
              </div>
              <span className="pct">{s.pct.toFixed(1)}%</span>
            </div>
          ))}
        </div>
      </div>

      {/* RIGHT: Chat */}
      <div className="alpha-right">
        <div className="alpha-chat-header">
          <div>
            <div className="alpha-chat-title">ALPHA — Portfellihaldur</div>
            <div className="alpha-chat-sub">35a kogemus · Bridgewater, Renaissance, Citadel, Goldman, Berkshire</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div className="alpha-online">
              <span className="alpha-online-dot" />
              Online
            </div>
            <button type="button" className="btn" onClick={handleNewChat} style={{ padding: "6px 12px", fontSize: 11 }}>
              Uus vestlus
            </button>
          </div>
        </div>

        <div className="alpha-quick">
          {QUICK_ACTIONS.map((q) => (
            <button key={q.label} type="button" className="alpha-quick-btn" onClick={handleQuickAction(q.msg)} disabled={sending}>
              {q.label}
            </button>
          ))}
        </div>

        <div className="alpha-messages">
          {showSamples ? (
            <div style={{ fontSize: 12, color: "var(--t3)", marginBottom: 8 }}>
              Näide: vajuta ühele või kirjuta oma küsimus
            </div>
          ) : null}
          {showSamples
            ? SAMPLE_PROMPTS.map((s, i) => (
                <div key={i} className="alpha-sample" onClick={handleSampleClick(s)} role="button" tabIndex={0}>
                  {s}
                </div>
              ))
            : null}
          {messages.map((m, i) => (
            <div key={i} className={`alpha-msg ${m.role}`}>
              {m.role === "user" ? <div>{m.content}</div> : <div dangerouslySetInnerHTML={{ __html: m.content }} />}
            </div>
          ))}
          {sending ? (
            <div className="alpha-loading">
              <span className="alpha-loading-dot" />
              <span>ALPHA mõtleb...</span>
            </div>
          ) : null}
          <div ref={messagesEndRef} />
        </div>

        <div className="alpha-input-wrap">
          <textarea
            ref={textareaRef}
            placeholder="Küsi ALPHAlt... nt 'Kas peaksin UK infra vähendama?' või 'Leia mulle 3 uut dividendiaktsiat'"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={sending}
            rows={3}
          />
          <button type="button" className="alpha-send" onClick={handleSubmit} disabled={!input.trim() || sending}>
            Saada
          </button>
          <button type="button" className="alpha-mic" title="Tuleviku funktsioon" disabled>
            🎤
          </button>
        </div>
      </div>
    </div>
  );
}
