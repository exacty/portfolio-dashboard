"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

type PortfolioData = {
  positions: Record<
    string,
    {
      avg_price: number;
      shares: number;
      currency: string;
      tees?: string;
      target?: number;
      stop_loss?: number;
    }
  >;
  fx_rates?: Record<string, number>;
};

type PositionRow = PortfolioData["positions"][string] & { ticker: string };

const pageStyles = `
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#06080d;--bg2:#0b0e16;--bg3:#10141f;--bg4:#161b2a;--bg5:#1c2235;
  --border:#1a1f32;--border2:#252b42;
  --t1:#e8e6df;--t2:#9a98a0;--t3:#5c5a66;--t4:#3a3844;
  --green:#00d68f;--red:#ff4757;--amber:#ffb830;--blue:#4d8dff;--teal:#14b8a6;--cyan:#06b6d4;
  --green-bg:rgba(0,214,143,0.06);--green-border:rgba(0,214,143,0.15);
  --red-bg:rgba(255,71,87,0.06);--red-border:rgba(255,71,87,0.15);
  --amber-bg:rgba(255,184,48,0.06);--amber-border:rgba(255,184,48,0.15);
  --radius:8px;
  --font-display:'Outfit',sans-serif;--font-mono:'JetBrains Mono',monospace;
}
html,body{font-family:var(--font-display);background:var(--bg);color:var(--t1);font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased;overflow-x:hidden}

.app{min-height:100vh;display:grid;grid-template-columns:1fr;grid-template-rows:auto 1fr}
.header{padding:12px 24px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;background:var(--bg2)}
.header h1{font-size:15px;font-weight:600;letter-spacing:-0.3px;display:flex;align-items:center;gap:8px}
.header .meta{font-size:11px;color:var(--t3);font-family:var(--font-mono)}

.btn{padding:5px 12px;border-radius:6px;font-size:11px;font-weight:500;border:1px solid var(--border);background:var(--bg3);color:var(--t2);cursor:pointer;transition:all 0.12s;font-family:var(--font-display);white-space:nowrap}
.btn:hover{background:var(--bg4);color:var(--t1);border-color:var(--border2)}
.btn.primary{background:var(--green-bg);border-color:var(--green-border);color:var(--green)}
.btn.danger{background:var(--red-bg);border-color:var(--red-border);color:var(--red)}
.btn.amber{background:var(--amber-bg);border-color:var(--amber-border);color:var(--amber)}
.btn.sm{padding:3px 8px;font-size:10px}

.wrap{padding:16px 24px;display:grid;gap:14px}
.card{background:var(--bg3);border-radius:var(--radius);padding:14px;border:1px solid var(--border)}
.card h2{font-size:11px;text-transform:uppercase;letter-spacing:1.2px;color:var(--t3);font-weight:500;margin-bottom:10px}

table{width:100%;border-collapse:collapse;table-layout:fixed}
thead th{font-size:9px;text-transform:uppercase;letter-spacing:0.8px;color:var(--t4);padding:6px 8px;text-align:left;border-bottom:1px solid var(--border);background:var(--bg);font-weight:500;white-space:nowrap}
tbody td{padding:8px;border-bottom:1px solid rgba(26,31,50,0.5);vertical-align:middle}

.form{display:grid;grid-template-columns:repeat(12,1fr);gap:10px}
.field{grid-column:span 3;display:grid;gap:6px}
.field.span6{grid-column:span 6}
.label{font-size:9px;text-transform:uppercase;letter-spacing:0.5px;color:var(--t3);font-family:var(--font-mono)}
input, textarea, select{
  width:100%;
  background:rgba(255,255,255,0.03);
  border:1px solid rgba(26,31,50,0.9);
  border-radius:6px;
  color:var(--t1);
  padding:7px 10px;
  outline:none;
  font-family:var(--font-mono);
  font-size:12px;
}
textarea{min-height:60px;resize:vertical}

.row-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
`;

export default function PositionsPage() {
  const [data, setData] = useState<PortfolioData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [addTicker, setAddTicker] = useState("");
  const [addAvg, setAddAvg] = useState("0");
  const [addShares, setAddShares] = useState("0");
  const [addCurrency, setAddCurrency] = useState("USD");
  const [addTees, setAddTees] = useState("");
  const [addTarget, setAddTarget] = useState("0");
  const [addStop, setAddStop] = useState("0");

  const [editing, setEditing] = useState<string | null>(null);
  const [editTees, setEditTees] = useState("");
  const [editAvg, setEditAvg] = useState("0");
  const [editShares, setEditShares] = useState("0");
  const [editCurrency, setEditCurrency] = useState("USD");
  const [editTarget, setEditTarget] = useState("0");
  const [editStop, setEditStop] = useState("0");

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/portfolio-data");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as PortfolioData;
        setData(json);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const rows = useMemo<PositionRow[]>(() => {
    const positions = data?.positions ?? {};
    return Object.entries(positions).map(([ticker, pos]) => ({
      ticker,
      avg_price: pos.avg_price,
      shares: pos.shares,
      currency: pos.currency,
      tees: pos.tees ?? "",
      target: pos.target ?? 0,
      stop_loss: pos.stop_loss ?? 0,
    }));
  }, [data]);

  const refresh = async () => {
    const res = await fetch("/api/portfolio-data");
    const json = (await res.json()) as PortfolioData;
    setData(json);
  };

  const startEdit = (ticker: string) => {
    const pos = data?.positions?.[ticker];
    if (!pos) return;
    setEditing(ticker);
    setEditTees(pos.tees ?? "");
    setEditAvg(String(pos.avg_price ?? 0));
    setEditShares(String(pos.shares ?? 0));
    setEditCurrency(pos.currency ?? "USD");
    setEditTarget(String(pos.target ?? 0));
    setEditStop(String(pos.stop_loss ?? 0));
  };

  const saveEdit = async () => {
    if (!editing || !data) return;
    const res = await fetch("/api/portfolio-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update",
        ticker: editing,
        patch: {
          tees: editTees,
          target: Number(editTarget),
          stop_loss: Number(editStop),
          avg_price: Number(editAvg),
          shares: Number(editShares),
          currency: editCurrency,
        },
      }),
    });
    if (!res.ok) return;
    setEditing(null);
    await refresh();
  };

  const deleteTicker = async (ticker: string) => {
    const res = await fetch("/api/portfolio-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", ticker }),
    });
    if (!res.ok) return;
    if (editing === ticker) setEditing(null);
    await refresh();
  };

  const addPosition = async () => {
    const ticker = addTicker.trim();
    if (!ticker) return;
    const res = await fetch("/api/portfolio-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add",
        ticker,
        position: {
          avg_price: Number(addAvg),
          shares: Number(addShares),
          currency: addCurrency,
          tees: addTees,
          target: Number(addTarget),
          stop_loss: Number(addStop),
        },
      }),
    });
    if (!res.ok) return;
    setAddTicker("");
    setAddTees("");
    setAddAvg("0");
    setAddShares("0");
    setAddTarget("0");
    setAddStop("0");
    await refresh();
  };

  return (
    <>
      <style>{pageStyles}</style>
      <div className="app">
        <div className="header">
          <h1>
            Portfolio Positions
            <span style={{ fontSize: 10, color: "var(--t3)", fontWeight: 400, marginLeft: 8 }}>
              CRUD
            </span>
          </h1>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div className="meta">Kõik positsioonid (portfolio_data.json)</div>
            <Link className="btn sm" href="/">
              ← Dashboard
            </Link>
          </div>
        </div>

        <div className="wrap">
          <div className="card">
            <h2>Lisa positsioon</h2>
            <div className="form">
              <div className="field">
                <div className="label">Ticker</div>
                <input value={addTicker} onChange={(e) => setAddTicker(e.target.value)} placeholder="EQNR.OL" />
              </div>
              <div className="field">
                <div className="label">Avg price</div>
                <input value={addAvg} onChange={(e) => setAddAvg(e.target.value)} />
              </div>
              <div className="field">
                <div className="label">Shares</div>
                <input value={addShares} onChange={(e) => setAddShares(e.target.value)} />
              </div>
              <div className="field">
                <div className="label">Currency</div>
                <select value={addCurrency} onChange={(e) => setAddCurrency(e.target.value)}>
                  <option value="USD">USD</option>
                  <option value="GBP">GBP</option>
                  <option value="NOK">NOK</option>
                  <option value="DKK">DKK</option>
                  <option value="EUR">EUR</option>
                </select>
              </div>
              <div className="field span6">
                <div className="label">Tees</div>
                <textarea value={addTees} onChange={(e) => setAddTees(e.target.value)} placeholder="Miks sa seda hoiad?" />
              </div>
              <div className="field">
                <div className="label">Target</div>
                <input value={addTarget} onChange={(e) => setAddTarget(e.target.value)} />
              </div>
              <div className="field">
                <div className="label">Stop-loss</div>
                <input value={addStop} onChange={(e) => setAddStop(e.target.value)} />
              </div>
              <div className="field" style={{ gridColumn: "span 12", alignSelf: "end" }}>
                <button className="btn primary" onClick={() => void addPosition()} type="button">
                  Lisa
                </button>
              </div>
            </div>
          </div>

          <div className="card">
            <h2>Positsioonid</h2>
            {loading ? <div style={{ fontFamily: "var(--font-mono)", color: "var(--t2)" }}>Laen...</div> : null}
            {error ? <div style={{ fontFamily: "var(--font-mono)", color: "var(--amber)" }}>{error}</div> : null}

            {!loading && data ? (
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 140 }}>Ticker</th>
                    <th style={{ width: 110 }}>Avg</th>
                    <th style={{ width: 120 }}>Shares</th>
                    <th style={{ width: 110 }}>Currency</th>
                    <th>Tees / Target / Stop</th>
                    <th style={{ width: 240, textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.ticker}>
                      <td style={{ fontFamily: "var(--font-mono)", fontWeight: 700 }}>{r.ticker}</td>
                      <td style={{ fontFamily: "var(--font-mono)" }}>{r.avg_price}</td>
                      <td style={{ fontFamily: "var(--font-mono)" }}>{r.shares}</td>
                      <td style={{ fontFamily: "var(--font-mono)" }}>{r.currency}</td>
                      <td>
                        {editing === r.ticker ? (
                          <div style={{ display: "grid", gap: 8 }}>
                            <textarea value={editTees} onChange={(e) => setEditTees(e.target.value)} />
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                              <div>
                                <div className="label">Avg</div>
                                <input value={editAvg} onChange={(e) => setEditAvg(e.target.value)} />
                              </div>
                              <div>
                                <div className="label">Shares</div>
                                <input value={editShares} onChange={(e) => setEditShares(e.target.value)} />
                              </div>
                              <div>
                                <div className="label">Currency</div>
                                <select value={editCurrency} onChange={(e) => setEditCurrency(e.target.value)}>
                                  <option value="USD">USD</option>
                                  <option value="GBP">GBP</option>
                                  <option value="NOK">NOK</option>
                                  <option value="DKK">DKK</option>
                                  <option value="EUR">EUR</option>
                                </select>
                              </div>
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                              <div>
                                <div className="label">Target</div>
                                <input value={editTarget} onChange={(e) => setEditTarget(e.target.value)} />
                              </div>
                              <div>
                                <div className="label">Stop-loss</div>
                                <input value={editStop} onChange={(e) => setEditStop(e.target.value)} />
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div style={{ display: "grid", gap: 3 }}>
                            <div style={{ color: "var(--t2)" }}>{r.tees || "—"}</div>
                            <div style={{ fontFamily: "var(--font-mono)" }}>
                              Target: {r.target ?? 0} · Stop: {r.stop_loss ?? 0}
                            </div>
                          </div>
                        )}
                      </td>
                      <td>
                        <div className="row-actions">
                          {editing === r.ticker ? (
                            <>
                              <button className="btn primary sm" onClick={() => void saveEdit()} type="button">
                                Salvesta
                              </button>
                              <button className="btn sm" onClick={() => setEditing(null)} type="button">
                                Katkesta
                              </button>
                            </>
                          ) : (
                            <>
                              <button className="btn sm" onClick={() => startEdit(r.ticker)} type="button">
                                Muuda
                              </button>
                              <button className="btn danger sm" onClick={() => void deleteTicker(r.ticker)} type="button">
                                Kustuta
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}

