"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  CartesianGrid,
  ReferenceLine,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type Phase = "Juht" | "Taastumine" | "Nõrgenemine" | "Mahajääja";
type SectorRotationItem = {
  ticker: string;
  ytd: number;
  mom_1m: number;
  mom_3m: number;
  rsi: number;
  phase: Phase | string;
};

type TooltipPoint = {
  ticker: string;
  ytd: number;
  mom_1m: number;
  mom_3m: number;
  rsi: number;
  phase: string;
};

type SectorsResponse = {
  sectors_rotation: SectorRotationItem[];
  sectors_allocation?: Array<{ name: string; pct: number; color: string }>;
};

export default function SectorsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SectorsResponse>({ sectors_rotation: [] });
  const [aiHtml, setAiHtml] = useState<string>("");
  const [scanLabel, setScanLabel] = useState("Analüüsi rotatsiooni");
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setLoading(true);
        setError(null);
        const res = await fetch("/api/sectors");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as SectorsResponse;
        setData(json);
        setLastLoadedAt(new Date().toISOString());
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const points = useMemo(() => {
    return (data.sectors_rotation ?? []).map((s) => ({
      key: s.ticker,
      ticker: s.ticker,
      phase: s.phase,
      x: s.mom_1m,
      y: s.ytd,
      rsi: s.rsi,
      mom_3m: s.mom_3m,
      mom_1m: s.mom_1m,
      ytd: s.ytd,
    }));
  }, [data]);

  const phaseColor = (phase: string) => {
    if (phase === "Juht") return "var(--teal)";
    if (phase === "Taastumine") return "var(--purple)";
    if (phase === "Nõrgenemine") return "var(--amber)";
    return "var(--red)";
  };

  const onAnalyzeRotation = async () => {
    try {
      setScanLabel("Analüüsin...");
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "scan",
          message: "Fookus: sektori rotatsioon. Selgita Juhid/Taastumine/Nõrgenemine/Mahajääja faasid ja soovita konkreetsed positsioonimuudatused.",
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ai = await res.json();
      if (typeof ai.advisorMessage === "string") setAiHtml(ai.advisorMessage);
    } catch (e) {
      setAiHtml(`<em>AI analüüs ebaõnnestus: ${String(e)}</em>`);
    } finally {
      window.setTimeout(() => setScanLabel("Analüüsi rotatsiooni"), 1500);
    }
  };

  return (
    <div className="app">
      <style>{`
        .app{min-height:100vh;background:var(--bg);color:var(--t1);font-family:var(--font-display);}
        .header{padding:12px 24px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;background:var(--bg2)}
        .btn{padding:5px 12px;border-radius:6px;font-size:11px;font-weight:500;border:1px solid var(--border);background:var(--bg3);color:var(--t2);cursor:pointer;transition:all 0.12s;white-space:nowrap}
        .btn:hover{background:var(--bg4);color:var(--t1);border-color:var(--border2)}
        .btn.primary{background:var(--green-bg);border-color:var(--green-border);color:var(--green)}
        .wrap{padding:16px 24px}
        .card{background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);padding:14px}
        .card h2{font-size:11px;text-transform:uppercase;letter-spacing:1.2px;color:var(--t3);font-weight:500;margin-bottom:10px}
        table{width:100%;border-collapse:collapse;table-layout:fixed}
        thead th{font-size:9px;text-transform:uppercase;letter-spacing:0.8px;color:var(--t4);padding:6px 8px;text-align:left;border-bottom:1px solid var(--border);font-weight:500}
        tbody td{padding:8px;border-bottom:1px solid rgba(26,31,50,0.5);vertical-align:middle}
      `}</style>

      <div className="header">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ fontWeight: 700 }}>Sektori rotatsioon</div>
          <div style={{ fontSize: 10, color: "var(--t3)", fontFamily: "var(--font-mono)" }}>
            {lastLoadedAt ? `Laetud: ${new Date(lastLoadedAt).toLocaleTimeString("et-EE", { hour: "2-digit", minute: "2-digit" })}` : null}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Link className="btn" href="/">
            ← Dashboard
          </Link>
          <button className="btn primary" onClick={() => void onAnalyzeRotation()} type="button">
            {scanLabel}
          </button>
        </div>
      </div>

      <div className="wrap">
        <div className="card">
          <h2>Scatter chart: 1kuu momentum vs YTD tootlus</h2>
          {loading ? (
            <div style={{ fontFamily: "var(--font-mono)", color: "var(--t2)" }}>Laen...</div>
          ) : error ? (
            <div style={{ fontFamily: "var(--font-mono)", color: "var(--amber)" }}>{error}</div>
          ) : (
            <div style={{ width: "100%", height: 420 }}>
              <ScatterChart width={900} height={420} margin={{ top: 10, right: 10, bottom: 10, left: 10 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.06)" />
                <ReferenceLine x={0} stroke="rgba(255,255,255,0.25)" strokeDasharray="3 3" />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.25)" strokeDasharray="3 3" />
                <XAxis
                  type="number"
                  dataKey="x"
                  name="1kuu momentum"
                  tick={{ fill: "var(--t3)", fontSize: 10, fontFamily: "var(--font-mono)" }}
                  axisLine={{ stroke: "rgba(255,255,255,0.08)" }}
                  tickLine={false}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  name="YTD tootlus"
                  tick={{ fill: "var(--t3)", fontSize: 10, fontFamily: "var(--font-mono)" }}
                  axisLine={{ stroke: "rgba(255,255,255,0.08)" }}
                  tickLine={false}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const p = payload[0]?.payload as unknown as TooltipPoint;
                    return (
                      <div
                        style={{
                          background: "rgba(0,0,0,0.6)",
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                          padding: 10,
                          color: "var(--t1)",
                        }}
                      >
                        <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800 }}>{p.ticker}</div>
                        <div style={{ fontFamily: "var(--font-mono)" }}>YTD: {p.ytd.toFixed(2)}%</div>
                        <div style={{ fontFamily: "var(--font-mono)" }}>1m: {p.mom_1m.toFixed(2)}%</div>
                        <div style={{ fontFamily: "var(--font-mono)" }}>3m: {p.mom_3m.toFixed(2)}%</div>
                        <div style={{ fontFamily: "var(--font-mono)" }}>RSI: {p.rsi}</div>
                        <div style={{ fontFamily: "var(--font-mono)" }}>Faasis: {p.phase}</div>
                      </div>
                    );
                  }}
                />
                <Scatter
                  data={points}
                  fillOpacity={0.8}
                  shape={(props: { cx?: number; cy?: number; payload?: unknown }) => {
                    const p = props.payload as unknown as TooltipPoint;
                    return (
                      <circle
                        cx={props.cx ?? 0}
                        cy={props.cy ?? 0}
                        r={5}
                        fill={phaseColor(p.phase)}
                        stroke="rgba(255,255,255,0.15)"
                        strokeWidth={1}
                      />
                    );
                  }}
                />
              </ScatterChart>
            </div>
          )}
        </div>

        <div style={{ height: 14 }} />

        <div className="card">
          <h2>Faasi detailtabel</h2>
          {loading ? (
            <div style={{ fontFamily: "var(--font-mono)", color: "var(--t2)" }}>—</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th style={{ width: 160 }}>ETF</th>
                  <th style={{ width: 110 }}>YTD%</th>
                  <th style={{ width: 110 }}>1kuu%</th>
                  <th style={{ width: 110 }}>3kuu%</th>
                  <th style={{ width: 100 }}>RSI</th>
                  <th>Faasi</th>
                </tr>
              </thead>
              <tbody>
                {data.sectors_rotation.map((s) => (
                  <tr key={s.ticker}>
                    <td style={{ fontFamily: "var(--font-mono)", fontWeight: 800 }}>{s.ticker}</td>
                    <td style={{ fontFamily: "var(--font-mono)" }}>{s.ytd.toFixed(2)}%</td>
                    <td style={{ fontFamily: "var(--font-mono)" }}>{s.mom_1m.toFixed(2)}%</td>
                    <td style={{ fontFamily: "var(--font-mono)" }}>{s.mom_3m.toFixed(2)}%</td>
                    <td style={{ fontFamily: "var(--font-mono)" }}>{s.rsi}</td>
                    <td style={{ color: phaseColor(s.phase) }}>{s.phase}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {aiHtml ? (
          <>
            <div style={{ height: 14 }} />
            <div className="card">
              <h2>AI analüüs</h2>
              <div dangerouslySetInnerHTML={{ __html: aiHtml }} />
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

