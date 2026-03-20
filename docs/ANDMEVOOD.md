# Kuidas andmed liiguvad (lihtsalt)

## Põhimõte

1. **Väljastpoolt** (Yahoo, uudised, AI jne) andmeid **ei küsita iga lehe laadimisega**.
2. Kõik see käib **ühe “refresh” tsükli** sees (või taustal käivitatud `refresh_portfolio`).
3. Tulemus kirjutatakse **SQLite faili** `data/portfolio.db`.
4. **Veebileht** loeb API kaudu **peamiselt ainult seda andmebaasi** → vähem ootamist, vähem korduvaid päringuid.

```
[Väline maailm]  →  refresh / taustajooks  →  [SQLite]  →  /api/*  →  [UI]
```

## Mis on juba DB-s / cache’is

| Andmed | Kust UI loeb | Millal väljast täidetakse |
|--------|----------------|---------------------------|
| Portfell (hinnad, KPI, uudised, positsioonid jne) | `GET /api/portfolio` → `db_reader.py` | `refresh_portfolio.py` → `portfolio_engine.py` |
| Tickeri graafik (candles, MA jne) | `GET /api/ticker-history` | `market_data_fetch.py` (TTL; `?refresh=1` sunnib uuesti) |
| CANSLIM / earnings | `GET /api/ticker-earnings` | sama |
| Dividendid (mitu allikat, ühendatud seeria + kuvamis-yield) | `GET /api/ticker-dividends` | `market_data_fetch.py` → `dividend_pipeline.py` → tabelid **`dividend_source_snapshots`** (kõik tõmbed) + **`dividend_display`** (kuvatav); valikuline **`FMP_API_KEY`** |
| Performance graafik | `GET /api/performance` | snapshot’ide ajalugu DB-st või `results/history.json` |
| Target, stop, tees | `POST /api/portfolio` → SQLite `positions` | salvestamisel + taust refresh |
| Müüdud lotid (arhiiv) | tabel `position_lot_history` | kui ticker kaob JSON-ist → `migrate` / IBKR sünk sulgeb loti, **ei DELETE** |

## Kiire modal (graafik + earnings ilma ooteta)

Pärast portfelli refresh’i võid käivitada **tickerite cache soojenduse** (vt `WARM_MARKET_CACHE_AFTER_REFRESH` ja `scripts/warm_market_caches.py`).  
Soojendus täidab ka **dividendiveeru** andmed (history + earnings + dividends). Esimesed modalid / tabel **juba DB-st**, mitte Yahoo ootamine.

## AI (Tees / chat)

- **Vastuse genereerimine** käib ikka Anthropic API kaudu (see on loomulikult “väljas”).
- **Portfelli kontekst** AI jaoks tuleb **samast SQLite snapshot’ist** mis UI (`db_reader`), mitte eraldi mootori jooksust.
- Vastused logitakse tabelisse `ai_analyses`; ticker modali **Tees** vestlus laeb ajaloo `GET /api/ai-history` kaudu (kasutaja + AI read, uus sõnum ikka Claude).

## Üks käsk “pane kõik korda”

```bash
# Soovitatav: täis portfelli uuendus + (kui env lubab) tickerite cache soojendus
python3 scripts/full_refresh.py
```

Või ainult portfell (ilma soojenduseta):

```bash
python3 scripts/refresh_portfolio.py
```

## Mis pole (veel) “100% ainult DB”

- Iga **uus AI küsimus** vajab ikka Claude kutset.
- Kui cache on aegunud ja keegi **esimene** avab graafiku, võib üks väline fetch juhtuda (siis tulemus salvestatakse ja järgmised on kiired).
- **`/positions`** + **`/api/portfolio-data`** kasutavad endiselt **`portfolio_data.json`** (manuaalne redaktor); ülejäänud avaleht/sektorid/AI kontekst = snapshot SQLite’ist.

## Puhastatud / ühtlustatud (Node API)

- **`/api/sectors`** — ei käivita enam `portfolio_engine.py`; loeb **`db_reader.py`** (sama snapshot mis portfell).
- **`/api/ai`** — ei loe `portfolio_cache.json` ega `portfolio_data.json`; kontekst tuleb **ainult** snapshotist (target/stop/tees juba positsioonikirjes pärast refresh).
- Avalehel portfelli **automaatpoll** ~**24 h** (+ nupp „Uuenda andmeid“ sunnib `?refresh=1`).

`portfolio_engine.py` võib endiselt kirjutada `scripts/.cache/portfolio_cache.json` **ainult** mootori sisemise fallback’ina (väljaspool Next API-d).

---

Kui tahad järgmise sammu: üks “orkestreerija” (nt cron), mis järjest käivitab `full_refresh` + IBKR sync + logib vigu ühte kohta.
