import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 10000;

const app = express();
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// ---------- CONFIG ----------
const COINS = [
  { id: "bitcoin", symbol: "BTC", name: "Bitcoin" },
  { id: "ethereum", symbol: "ETH", name: "Ethereum" },
  { id: "solana", symbol: "SOL", name: "Solana" },
  { id: "binancecoin", symbol: "BNB", name: "BNB" },
  { id: "ripple", symbol: "XRP", name: "XRP" },
  { id: "cardano", symbol: "ADA", name: "Cardano" },
  { id: "dogecoin", symbol: "DOGE", name: "Dogecoin" }
];

const FIAT = "usd";

// 你原来是 10s，CoinGecko 很容易 429
// 建议：本地开发 20-30s；部署看情况
const BASE_FETCH_MS = 20_000;

// 429/错误时最大退避到 5 分钟
const MAX_BACKOFF_MS = 300_000;

// ---------- STOCK INDICES (Chart only, via Stooq daily) ----------
const INDEX_ASSETS = [
  { id: "^spx",  symbol: "SPX",  name: "S&P 500" },
  { id: "^ndx",  symbol: "NDX",  name: "Nasdaq 100" },
  { id: "^dji",  symbol: "DJI",  name: "Dow Jones" },
  { id: "^rut",  symbol: "RUT",  name: "Russell 2000" },
  { id: "^vix",  symbol: "VIX",  name: "VIX" },
  { id: "^dax",  symbol: "DAX",  name: "DAX" },
  { id: "^ftse", symbol: "FTSE", name: "FTSE 100" },
  { id: "^n225", symbol: "N225", name: "Nikkei 225" },
  { id: "^hsi",  symbol: "HSI",  name: "Hang Seng" }
];

function isIndexCoin(coin) {
  const c = String(coin || "");
  return c.startsWith("^") || INDEX_ASSETS.some(x => x.id === c);
}

// 简单缓存，避免每次切换都打 Stooq
const indexCache = new Map(); // coin -> { ts, rows }
const INDEX_CACHE_TTL_MS = 60_000;

async function fetchStooqDailyRows(symbol) {
  const coin = String(symbol || "");
  const now = Date.now();

  const cached = indexCache.get(coin);
  if (cached && (now - cached.ts) < INDEX_CACHE_TTL_MS) return cached.rows;

  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(coin)}&i=d`;
  const res = await fetch(url, { headers: { accept: "text/csv" } });
  if (!res.ok) throw new Error(`stooq HTTP ${res.status}`);

  const csv = await res.text();
  const lines = csv.trim().split("\n");
  const rows = lines
    .slice(1)
    .map(l => l.split(","))
    .filter(r => r.length >= 5);

  const out = rows
    .map(r => {
      const t = Date.parse(r[0] + "T00:00:00Z");
      return { t, o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]) };
    })
    .filter(x => Number.isFinite(x.t) && Number.isFinite(x.c));

  indexCache.set(coin, { ts: now, rows: out });
  return out;
}

function seriesFromDaily(rows, days) {
  const end = Date.now();
  const start = end - days * 24 * 60 * 60 * 1000;
  return rows.filter(r => r.t >= start && r.t <= end).map(r => ({ t: r.t, v: r.c }));
}

function bucketKey(t, mode) {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const day = d.getUTCDate();

  if (mode === "1w") {
    const dt = new Date(Date.UTC(y, d.getUTCMonth(), day));
    const wd = dt.getUTCDay() || 7;
    dt.setUTCDate(dt.getUTCDate() - (wd - 1));
    return dt.getTime();
  }

  if (mode === "1mo") return Date.UTC(y, d.getUTCMonth(), 1);
  return Date.UTC(y, d.getUTCMonth(), day);
}

function ohlcFromDaily(rows, mode) {
  const map = new Map();
  for (const r of rows) {
    const k = bucketKey(r.t, mode);
    const cur = map.get(k);
    if (!cur) map.set(k, { t: k, o: r.o, h: r.h, l: r.l, c: r.c });
    else {
      cur.h = Math.max(cur.h, r.h);
      cur.l = Math.min(cur.l, r.l);
      cur.c = r.c;
    }
  }
  return [...map.values()].sort((a, b) => a.t - b.t);
}

// ---------- DB (SQLite) ----------
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const DB_PATH = path.join(dataDir, "prices.db");

const db = await open({
  filename: DB_PATH,
  driver: sqlite3.Database
});

await db.exec(`
  PRAGMA journal_mode=WAL;

  CREATE TABLE IF NOT EXISTS ticks (
    coin TEXT NOT NULL,
    ts   INTEGER NOT NULL,
    price REAL NOT NULL,
    PRIMARY KEY (coin, ts)
  );

  CREATE INDEX IF NOT EXISTS idx_ticks_coin_ts ON ticks (coin, ts);

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ---------- In-memory cache ----------
let latest = {
  ok: false,
  ts: Date.now(),
  prices: {},
  error: null
};

function nowMs() { return Date.now(); }
function coinIds() { return COINS.map(c => c.id); }

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// ---------- CoinGecko fetch with backoff ----------
let fetchTimer = null;
let backoffMs = BASE_FETCH_MS;

function scheduleNextFetch(delayMs) {
  clearTimeout(fetchTimer);
  fetchTimer = setTimeout(async () => {
    await fetchCoinGecko();
    scheduleNextFetch(backoffMs);
  }, delayMs);
}

async function fetchCoinGecko() {
  const ids = coinIds().join(",");
  const url = new URL("https://api.coingecko.com/api/v3/simple/price");
  url.searchParams.set("ids", ids);
  url.searchParams.set("vs_currencies", FIAT);
  url.searchParams.set("include_24hr_change", "true");

  try {
    const res = await fetch(url.toString(), { headers: { accept: "application/json" } });

    // 429: 退避
    if (res.status === 429) {
      backoffMs = Math.min(MAX_BACKOFF_MS, Math.floor(backoffMs * 1.8));
      latest = { ...latest, ok: false, error: "HTTP 429 (rate limited)", ts: nowMs() };
      broadcast({ type: "tick", payload: latest });
      console.log("CoinGecko rate limited. Backoff to", backoffMs, "ms");
      return;
    }

    if (!res.ok) throw new Error("HTTP " + res.status);

    const data = await res.json();
    const ts = nowMs();

    const prices = {};
    const insert = await db.prepare("INSERT OR IGNORE INTO ticks (coin, ts, price) VALUES (?, ?, ?)");
    try {
      for (const c of COINS) {
        const row = data?.[c.id];
        const price = row?.[FIAT];
        const chg24 = row?.[`${FIAT}_24h_change`];

        if (typeof price === "number") {
          prices[c.id] = { price, chg24: (typeof chg24 === "number" ? chg24 : null) };
          await insert.run(c.id, ts, price);
        }
      }
    } finally {
      await insert.finalize();
    }

    latest = { ok: true, ts, prices, error: null };
    broadcast({ type: "tick", payload: latest });

    const gainers = await getTopGainers(8);
    broadcast({ type: "gainers", payload: { ts, gainers } });

    // 成功后回到基础间隔
    backoffMs = BASE_FETCH_MS;

    console.log("Fetched prices @", new Date(ts).toISOString());
  } catch (e) {
    // 网络/解析错误也退避一点点
    backoffMs = Math.min(MAX_BACKOFF_MS, Math.floor(backoffMs * 1.3));
    latest = { ...latest, ok: false, error: String(e?.message || e), ts: nowMs() };
    broadcast({ type: "tick", payload: latest });
    console.log("Fetch error:", latest.error, "| backoff:", backoffMs);
  }
}

// ---------- Aggregations ----------
function roundTo(n, stepMs) { return Math.floor(n / stepMs) * stepMs; }

async function getSeries(coin, windowMs, bucketMs) {
  const end = nowMs();
  const start = end - windowMs;

  const rows = await db.all(
    "SELECT ts, price FROM ticks WHERE coin=? AND ts>=? AND ts<=? ORDER BY ts ASC",
    [coin, start, end]
  );

  const map = new Map();
  for (const r of rows) map.set(roundTo(r.ts, bucketMs), r.price);

  const points = [];
  const firstBucket = roundTo(start, bucketMs);
  const lastBucket = roundTo(end, bucketMs);

  let last = null;
  for (let t = firstBucket; t <= lastBucket; t += bucketMs) {
    if (map.has(t)) last = map.get(t);
    if (last !== null) points.push({ t, v: last });
  }
  return points;
}

async function getOHLC(coin, intervalMs) {
  const end = nowMs();
  const start = end - 24 * 60 * 60 * 1000;

  const rows = await db.all(
    "SELECT ts, price FROM ticks WHERE coin=? AND ts>=? AND ts<=? ORDER BY ts ASC",
    [coin, start, end]
  );

  const buckets = new Map();
  for (const r of rows) {
    const b = roundTo(r.ts, intervalMs);
    const cur = buckets.get(b);
    if (!cur) buckets.set(b, { t: b, o: r.price, h: r.price, l: r.price, c: r.price });
    else {
      cur.h = Math.max(cur.h, r.price);
      cur.l = Math.min(cur.l, r.price);
      cur.c = r.price;
    }
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

async function getTopGainers(limit = 10) {
  const end = nowMs();
  const start = end - 24 * 60 * 60 * 1000;

  const gainers = [];
  for (const c of COINS) {
    const first = await db.get(
      "SELECT price FROM ticks WHERE coin=? AND ts>=? ORDER BY ts ASC LIMIT 1",
      [c.id, start]
    );
    const last = await db.get(
      "SELECT price FROM ticks WHERE coin=? AND ts<=? ORDER BY ts DESC LIMIT 1",
      [c.id, end]
    );

    if (!first?.price || !last?.price) continue;
    const pct = ((last.price - first.price) / first.price) * 100;

    gainers.push({ coin: c.id, symbol: c.symbol, name: c.name, pct, last: last.price });
  }

  gainers.sort((a, b) => b.pct - a.pct);
  return gainers.slice(0, limit);
}

// ---------- API endpoints (optional debug) ----------
app.get("/api/series", async (req, res) => {
  const coin = String(req.query.coin || "bitcoin");
  const tf = String(req.query.tf || "1m");

  if (isIndexCoin(coin)) {
    const days = tf === "5m" ? 180 : tf === "1h" ? 365 : 30;
    const rows = await fetchStooqDailyRows(coin);
    const series = seriesFromDaily(rows, days);
    return res.json({ coin, tf, series, source: "stooq" });
  }

  const map = {
    "1m": { windowMs: 60_000, bucketMs: 1_000 },
    "5m": { windowMs: 300_000, bucketMs: 5_000 },
    "1h": { windowMs: 3_600_000, bucketMs: 60_000 }
  };
  const cfg = map[tf] || map["1m"];
  const series = await getSeries(coin, cfg.windowMs, cfg.bucketMs);
  res.json({ coin, tf, series, source: "sqlite" });
});

app.get("/api/ohlc", async (req, res) => {
  const coin = String(req.query.coin || "bitcoin");
  const interval = String(req.query.interval || "5m");

  if (isIndexCoin(coin)) {
    const mode = interval === "1m" ? "1d" : interval === "15m" ? "1mo" : "1w";
    const rows = await fetchStooqDailyRows(coin);
    const candles = ohlcFromDaily(rows, mode);
    return res.json({ coin, interval, candles, source: "stooq" });
  }

  const intervalMs = interval === "1m" ? 60_000 : interval === "15m" ? 900_000 : 300_000;
  const candles = await getOHLC(coin, intervalMs);
  res.json({ coin, interval, candles, source: "sqlite" });
});

app.get("/api/gainers", async (req, res) => {
  const limit = Math.max(1, Math.min(50, Number(req.query.limit || 10)));
  const gainers = await getTopGainers(limit);
  res.json({ gainers });
});

// ---------- WebSocket ----------
wss.on("connection", async (ws) => {
  ws.send(JSON.stringify({
    type: "snapshot",
    payload: { latest, coins: COINS, fiat: FIAT }
  }));

  const gainers = await getTopGainers(8);
  ws.send(JSON.stringify({ type: "gainers", payload: { ts: nowMs(), gainers } }));

  const defaultCoin = "bitcoin";
  const s1m = await getSeries(defaultCoin, 60_000, 1_000);
  const s5m = await getSeries(defaultCoin, 300_000, 5_000);
  const s1h = await getSeries(defaultCoin, 3_600_000, 60_000);
  ws.send(JSON.stringify({
    type: "series_init",
    payload: { coin: defaultCoin, series: { "1m": s1m, "5m": s5m, "1h": s1h } }
  }));

  ws.on("message", async (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString("utf8")); } catch { return; }

    if (msg?.type === "get_series") {
      const coin = String(msg.coin || "bitcoin");
      const tf = String(msg.tf || "1m");

      if (isIndexCoin(coin)) {
        const days = tf === "5m" ? 180 : tf === "1h" ? 365 : 30;
        try {
          const rows = await fetchStooqDailyRows(coin);
          const series = seriesFromDaily(rows, days);
          ws.send(JSON.stringify({ type: "series", payload: { coin, tf, series } }));
        } catch (e) {
          ws.send(JSON.stringify({ type: "series", payload: { coin, tf, series: [], error: String(e?.message || e) } }));
        }
        return;
      }

      const cfg =
        tf === "5m" ? { windowMs: 300_000, bucketMs: 5_000 } :
        tf === "1h" ? { windowMs: 3_600_000, bucketMs: 60_000 } :
                      { windowMs: 60_000, bucketMs: 1_000 };

      const series = await getSeries(coin, cfg.windowMs, cfg.bucketMs);
      ws.send(JSON.stringify({ type: "series", payload: { coin, tf, series } }));
      return;
    }

    if (msg?.type === "get_ohlc") {
      const coin = String(msg.coin || "bitcoin");
      const interval = String(msg.interval || "5m");

      if (isIndexCoin(coin)) {
        const mode = interval === "1m" ? "1d" : interval === "15m" ? "1mo" : "1w";
        try {
          const rows = await fetchStooqDailyRows(coin);
          const candlesAll = ohlcFromDaily(rows, mode);
          const cutoff = Date.now() - 730 * 24 * 60 * 60 * 1000;
          const candles = candlesAll.filter(c => c.t >= cutoff);

          ws.send(JSON.stringify({ type: "ohlc", payload: { coin, interval, candles } }));
        } catch (e) {
          ws.send(JSON.stringify({ type: "ohlc", payload: { coin, interval, candles: [], error: String(e?.message || e) } }));
        }
        return;
      }

      const intervalMs = interval === "1m" ? 60_000 : interval === "15m" ? 900_000 : 300_000;
      const candles = await getOHLC(coin, intervalMs);
      ws.send(JSON.stringify({ type: "ohlc", payload: { coin, interval, candles } }));
      return;
    }
  });
});







// ---------- Start ----------
server.listen(PORT, () => {
  console.log("Server running on", PORT);

  // 立即抓一次，然后用“自适应退避调度”
  fetchCoinGecko().then(() => {
    backoffMs = BASE_FETCH_MS;
    scheduleNextFetch(backoffMs);
  }).catch(() => {
    scheduleNextFetch(backoffMs);
  });
});