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
const FETCH_EVERY_MS = 10_000; // Fetch CoinGecko every 10s (avoid rate limit)

// ---------- DB (SQLite) ----------
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const DB_PATH = path.join(dataDir, "prices.db");

// NOTE: On Render, if you want persistence, attach a Persistent Disk and mount it to /opt/render/project/src/data
// so this file survives restarts. Starter plan supports persistent disks.

const db = await open({
  filename: DB_PATH,
  driver: sqlite3.Database
});

await db.exec(`
  PRAGMA journal_mode=WAL;

  CREATE TABLE IF NOT EXISTS ticks (
    coin TEXT NOT NULL,
    ts   INTEGER NOT NULL, -- ms since epoch
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
  prices: {}, // { coinId: { price, chg24 } }
  error: null
};

function nowMs() {
  return Date.now();
}

function coinIds() {
  return COINS.map(c => c.id);
}

async function fetchCoinGecko() {
  const ids = coinIds().join(",");
  const url = new URL("https://api.coingecko.com/api/v3/simple/price");
  url.searchParams.set("ids", ids);
  url.searchParams.set("vs_currencies", FIAT);
  url.searchParams.set("include_24hr_change", "true");

  try {
    const res = await fetch(url.toString(), { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error("HTTP " + res.status);

    const data = await res.json();
    const ts = nowMs();

    // Build latest cache + insert ticks
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

    // Also broadcast top gainers occasionally (every fetch)
    const gainers = await getTopGainers(8);
    broadcast({ type: "gainers", payload: { ts, gainers } });

    console.log("Fetched prices @", new Date(ts).toISOString());
  } catch (e) {
    latest = { ...latest, ok: false, error: String(e?.message || e), ts: nowMs() };
    broadcast({ type: "tick", payload: latest });
    console.log("Fetch error:", latest.error);
  }
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// ---------- Aggregations ----------
function roundTo(n, stepMs) {
  return Math.floor(n / stepMs) * stepMs;
}

// Get time-series for chart
// windowMs: range (e.g. 60_000, 300_000, 3_600_000)
// bucketMs: group interval (e.g. 1000, 5000, 60000)
// returns [{t, v}]
async function getSeries(coin, windowMs, bucketMs) {
  const end = nowMs();
  const start = end - windowMs;

  // Pull raw points and bucket in JS to keep SQLite simple
  const rows = await db.all(
    "SELECT ts, price FROM ticks WHERE coin=? AND ts>=? AND ts<=? ORDER BY ts ASC",
    [coin, start, end]
  );

  // bucket by rounding ts down to bucketMs, take last price in bucket
  const map = new Map();
  for (const r of rows) {
    const b = roundTo(r.ts, bucketMs);
    map.set(b, r.price);
  }

  const points = [];
  const firstBucket = roundTo(start, bucketMs);
  const lastBucket = roundTo(end, bucketMs);

  // Fill missing buckets by carrying forward last known value (smoother chart)
  let last = null;
  for (let t = firstBucket; t <= lastBucket; t += bucketMs) {
    if (map.has(t)) last = map.get(t);
    if (last !== null) points.push({ t, v: last });
  }

  return points;
}

// 24h OHLC candles for a coin
// intervalMs e.g. 60_000 (1m), 300_000 (5m), 900_000 (15m)
async function getOHLC(coin, intervalMs) {
  const end = nowMs();
  const start = end - 24 * 60 * 60 * 1000;

  const rows = await db.all(
    "SELECT ts, price FROM ticks WHERE coin=? AND ts>=? AND ts<=? ORDER BY ts ASC",
    [coin, start, end]
  );

  const buckets = new Map(); // b -> {o,h,l,c}
  for (const r of rows) {
    const b = roundTo(r.ts, intervalMs);
    const cur = buckets.get(b);
    if (!cur) {
      buckets.set(b, { t: b, o: r.price, h: r.price, l: r.price, c: r.price });
    } else {
      cur.h = Math.max(cur.h, r.price);
      cur.l = Math.min(cur.l, r.price);
      cur.c = r.price;
    }
  }

  // ensure sorted
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

// Top gainers (24h) based on DB: (lastPrice - firstPrice) / firstPrice
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

    gainers.push({
      coin: c.id,
      symbol: c.symbol,
      name: c.name,
      pct,
      last: last.price
    });
  }

  gainers.sort((a, b) => b.pct - a.pct);
  return gainers.slice(0, limit);
}

// ---------- API endpoints (optional debug) ----------
app.get("/api/series", async (req, res) => {
  const coin = String(req.query.coin || "bitcoin");
  const tf = String(req.query.tf || "1m");
  const map = {
    "1m":  { windowMs: 60_000, bucketMs: 1_000 },
    "5m":  { windowMs: 300_000, bucketMs: 5_000 },
    "1h":  { windowMs: 3_600_000, bucketMs: 60_000 }
  };
  const cfg = map[tf] || map["1m"];
  const series = await getSeries(coin, cfg.windowMs, cfg.bucketMs);
  res.json({ coin, tf, series });
});

app.get("/api/ohlc", async (req, res) => {
  const coin = String(req.query.coin || "bitcoin");
  const interval = String(req.query.interval || "5m");
  const intervalMs = interval === "1m" ? 60_000 : interval === "15m" ? 900_000 : 300_000;
  const candles = await getOHLC(coin, intervalMs);
  res.json({ coin, interval, candles });
});

app.get("/api/gainers", async (req, res) => {
  const limit = Math.max(1, Math.min(50, Number(req.query.limit || 10)));
  const gainers = await getTopGainers(limit);
  res.json({ gainers });
});

// ---------- WebSocket ----------
wss.on("connection", async (ws) => {
  // Send snapshot immediately
  ws.send(JSON.stringify({
    type: "snapshot",
    payload: {
      latest,
      coins: COINS,
      fiat: FIAT
    }
  }));

  // Send initial gainers
  const gainers = await getTopGainers(8);
  ws.send(JSON.stringify({ type: "gainers", payload: { ts: nowMs(), gainers } }));

  // Send initial chart series for BTC 1m/5m/1h
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

    // Client asks for chart series
    if (msg?.type === "get_series") {
      const coin = String(msg.coin || "bitcoin");
      const tf = String(msg.tf || "1m");

      const cfg =
        tf === "5m" ? { windowMs: 300_000, bucketMs: 5_000 } :
        tf === "1h" ? { windowMs: 3_600_000, bucketMs: 60_000 } :
                      { windowMs: 60_000, bucketMs: 1_000 };

      const series = await getSeries(coin, cfg.windowMs, cfg.bucketMs);
      ws.send(JSON.stringify({ type: "series", payload: { coin, tf, series } }));
    }

    // Client asks for 24h candles
    if (msg?.type === "get_ohlc") {
      const coin = String(msg.coin || "bitcoin");
      const interval = String(msg.interval || "5m");
      const intervalMs = interval === "1m" ? 60_000 : interval === "15m" ? 900_000 : 300_000;
      const candles = await getOHLC(coin, intervalMs);
      ws.send(JSON.stringify({ type: "ohlc", payload: { coin, interval, candles } }));
    }
  });
});

// ---------- Start ----------
server.listen(PORT, () => {
  console.log("Server running on", PORT);
  fetchCoinGecko();
  setInterval(fetchCoinGecko, FETCH_EVERY_MS);
});