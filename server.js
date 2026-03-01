import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

let cache = {
  updatedISO: null,
  data: null,
  ok: false,
};

const COINS = [
  "bitcoin",
  "ethereum",
  "solana",
  "binancecoin",
  "ripple",
  "cardano",
  "dogecoin",
];

async function fetchCoinGecko() {
  try {
    const url = new URL("https://api.coingecko.com/api/v3/simple/price");
    url.searchParams.set("ids", COINS.join(","));
    url.searchParams.set("vs_currencies", "usd");
    url.searchParams.set("include_24hr_change", "true");

    const res = await fetch(url.toString());
    const data = await res.json();

    cache = {
      updatedISO: new Date().toISOString(),
      data,
      ok: true
    };

    console.log("Fetched prices");
  } catch (err) {
    console.log("Fetch error:", err.message);
  }
}

fetchCoinGecko();
setInterval(fetchCoinGecko, 10000);

// SSE
app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const interval = setInterval(() => {
    res.write(`data: ${JSON.stringify(cache)}\n\n`);
  }, 1000);

  req.on("close", () => clearInterval(interval));
});

app.listen(PORT, () => {
  console.log("Server running on", PORT);
});