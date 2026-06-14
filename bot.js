// ================================================================
// CryptoPro Telegram Scalp Signal Bot
// 7/24 çalışır, yüksek güvenli scalp sinyallerini Telegram'a gönderir
// Dashboard'daki aynı analiz motorunu kullanır
// ================================================================

// Tırnak, boşluk, gizli karakterleri agresif temizle (Railway tırnak ekleyebilir)
function clean(v) {
  if (!v) return '';
  return String(v)
    .replace(/[\r\n\t]/g, '')        // satır sonu, tab
    .replace(/^[\s"']+|[\s"']+$/g, '') // baştaki/sondaki boşluk ve tırnaklar
    .trim();
}
const TG_TOKEN   = clean(process.env.TG_TOKEN)   || 'BURAYA_BOT_TOKEN';
const TG_CHAT_ID = clean(process.env.TG_CHAT_ID) || 'BURAYA_CHAT_ID';

// DEBUG: Railway'in gerçekte ne aktardığını gör (token'ın sadece güvenli kısmı)
console.log('🔍 Token uzunluğu:', TG_TOKEN.length, '| İlk 12:', TG_TOKEN.slice(0, 12), '| Son 4:', TG_TOKEN.slice(-4));
console.log('🔍 Chat ID:', JSON.stringify(TG_CHAT_ID), '| uzunluk:', TG_CHAT_ID.length);

// Ayarlar
const CONFIG = {
  minConfidence:   75,        // Min sinyal güveni (%)
  minVolume:       50000000,  // Min günlük hacim ($50M)
  scanTopN:        15,        // Kaç coin taranacak
  scanInterval:    120000,    // Tarama sıklığı (ms) = 2 dakika
  dedupeMinutes:   30,        // Aynı coin için tekrar uyarı engeli (dk)
  scalpTF:         '5m',      // Scalp zaman dilimi
  requireBacktest: true,      // Backtest kârlı olmalı mı
  minWinRate:      50,        // Min backtest kazanma oranı (%)
};

const alarmHistory = {};

// ── Telegram mesaj gönder ──
async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const d = await r.json();
    if (!d.ok) console.error('Telegram error:', d.description);
    return d.ok;
  } catch (e) {
    console.error('Telegram send failed:', e.message);
    return false;
  }
}

// ================================================================
// INDICATOR MATH (dashboard'dan birebir)
// ================================================================
function ema(values, period) {
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function rsiArr(prices, period = 14) {
  const out = Array(prices.length).fill(null);
  if (prices.length < period + 1) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = prices[i] - prices[i - 1];
    if (ch >= 0) avgGain += ch; else avgLoss -= ch;
  }
  avgGain /= period; avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < prices.length; i++) {
    const ch = prices[i] - prices[i - 1];
    const g = ch >= 0 ? ch : 0, l = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function calcATR(bars, period = 14) {
  if (bars.length < period + 1) return null;
  let trSum = 0;
  for (let i = 1; i <= period; i++) {
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c)
    );
    trSum += tr;
  }
  let atr = trSum / period;
  for (let i = period + 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c)
    );
    atr = (atr * (period - 1) + tr) / period;
  }
  return atr;
}

function calcMomentum(bars, period = 10) {
  if (bars.length < period + 2) return null;
  const c = bars.map(b => b.c);
  const n = c.length;
  const roc = (c[n - 1] - c[n - 1 - period]) / c[n - 1 - period] * 100;
  const rocPrev = (c[n - 2] - c[n - 2 - period]) / c[n - 2 - period] * 100;
  return { roc, accel: roc - rocPrev, rising: (roc - rocPrev) > 0 };
}

function calcOrderFlow(bars) {
  if (bars.length < 10) return null;
  const recent = bars.slice(-10);
  let buyVol = 0, sellVol = 0;
  recent.forEach(b => {
    const range = b.h - b.l || 0.0001;
    const vol = b.vol || 1;
    const closePos = (b.c - b.l) / range;
    buyVol += vol * closePos;
    sellVol += vol * (1 - closePos);
  });
  const total = buyVol + sellVol;
  const buyPct = total > 0 ? buyVol / total * 100 : 50;
  return { buyPct, sellPct: 100 - buyPct, delta: buyPct - 50 };
}

function calcEMARibbon(bars) {
  if (bars.length < 21) return null;
  const c = bars.map(b => b.c);
  const e8 = ema(c, 8), e13 = ema(c, 13), e21 = ema(c, 21);
  const price = c[c.length - 1];
  const bullStack = e8 > e13 && e13 > e21 && price > e8;
  const bearStack = e8 < e13 && e13 < e21 && price < e8;
  return {
    trend: bullStack ? 'GUCLU YUKSELIS' : bearStack ? 'GUCLU DUSUS' :
           price > e21 ? 'YUKSELIS' : 'DUSUS',
  };
}

// ── MASTER SCALP SIGNAL ──
function calcScalpSignal(bars, price) {
  if (bars.length < 22) return null;
  const mom = calcMomentum(bars, 10);
  const flow = calcOrderFlow(bars);
  const ribbon = calcEMARibbon(bars);
  const rsiData = rsiArr(bars.map(b => b.c), 14);
  const rsiNow = rsiData[rsiData.length - 1];
  const atr = calcATR(bars, 14);

  let longSig = 0, shortSig = 0;
  const signals = { long: [], short: [] };

  if (mom) {
    if (mom.roc > 0 && mom.rising) { longSig += 20; signals.long.push('Momentum yukarı + hızlanıyor'); }
    if (mom.roc < 0 && !mom.rising) { shortSig += 20; signals.short.push('Momentum aşağı + hızlanıyor'); }
  }
  if (flow) {
    if (flow.delta > 10) { longSig += 25; signals.long.push(`Güçlü alım baskısı (%${flow.buyPct.toFixed(0)})`); }
    else if (flow.delta > 3) { longSig += 12; signals.long.push('Alım baskısı'); }
    if (flow.delta < -10) { shortSig += 25; signals.short.push(`Güçlü satım baskısı (%${flow.sellPct.toFixed(0)})`); }
    else if (flow.delta < -3) { shortSig += 12; signals.short.push('Satım baskısı'); }
  }
  if (ribbon) {
    if (ribbon.trend === 'GUCLU YUKSELIS') { longSig += 22; signals.long.push('EMA ribbon boğa dizilimi'); }
    else if (ribbon.trend === 'YUKSELIS') { longSig += 10; signals.long.push('EMA yukarı'); }
    if (ribbon.trend === 'GUCLU DUSUS') { shortSig += 22; signals.short.push('EMA ribbon ayı dizilimi'); }
    else if (ribbon.trend === 'DUSUS') { shortSig += 10; signals.short.push('EMA aşağı'); }
  }
  if (rsiNow !== null) {
    if (rsiNow > 40 && rsiNow < 65) { longSig += 8; signals.long.push('RSI sağlıklı (40-65)'); }
    if (rsiNow < 60 && rsiNow > 35) { shortSig += 8; signals.short.push('RSI sağlıklı (35-60)'); }
    if (rsiNow < 30) { longSig += 15; signals.long.push('RSI aşırı satım dönüş'); }
    if (rsiNow > 70) { shortSig += 15; signals.short.push('RSI aşırı alım dönüş'); }
  }

  const dir = longSig >= shortSig ? 'LONG' : 'SHORT';
  const confidence = Math.min(100, Math.round(Math.max(longSig, shortSig) / 90 * 100));
  return {
    dir, confidence,
    signals: dir === 'LONG' ? signals.long : signals.short,
    atr, rsiNow, orderFlow: flow,
  };
}

// ── BACKTEST ──
function backtestScalp(bars, tfId) {
  if (bars.length < 60) return null;
  let wins = 0, losses = 0, totalPnl = 0;
  const slPctMax = { '1m': 0.005, '5m': 0.008, '15m': 0.012 }[tfId] || 0.008;
  for (let i = 30; i < bars.length - 10; i++) {
    const window = bars.slice(0, i + 1);
    const sig = calcScalpSignal(window, bars[i].c);
    if (!sig || sig.confidence < 65) continue;
    const entry = bars[i].c;
    const atr = sig.atr || entry * 0.005;
    const slDist = Math.min(atr * 0.8, entry * slPctMax);
    const sl = sig.dir === 'LONG' ? entry - slDist : entry + slDist;
    const tp = sig.dir === 'LONG' ? entry + slDist * 2 : entry - slDist * 2;
    let outcome = null;
    for (let j = i + 1; j < Math.min(i + 11, bars.length); j++) {
      const bar = bars[j];
      if (sig.dir === 'LONG') {
        if (bar.l <= sl) { outcome = 'loss'; break; }
        if (bar.h >= tp) { outcome = 'win'; break; }
      } else {
        if (bar.h >= sl) { outcome = 'loss'; break; }
        if (bar.l <= tp) { outcome = 'win'; break; }
      }
    }
    if (outcome === 'win') { wins++; totalPnl += slDist * 2 / entry * 100; }
    if (outcome === 'loss') { losses++; totalPnl -= slDist / entry * 100; }
    i += 5;
  }
  const total = wins + losses;
  return {
    total, wins, losses,
    winRate: total > 0 ? (wins / total * 100).toFixed(1) : 0,
    totalPnl: totalPnl.toFixed(2),
    profitable: totalPnl > 0,
  };
}

// ================================================================
// DATA FETCHING
// ================================================================

// Bybit kline (OHLC) - en güvenilir CORS-free kaynak
// ================================================================
// SEMBOL KAYDI - tüm borsalardaki coinleri başlangıçta yükle
// Kullanıcı "PEPE" yazınca borsadaki gerçek sembolü ("1000PEPEUSDT") bulur
// ================================================================
const SYMBOL_REGISTRY = {
  binance: {},  // { PEPE: "1000PEPEUSDT", BTC: "BTCUSDT", ... }
  bybit:   {},
  okx:     {},
};
let registryLoaded = false;

async function loadSymbolRegistry() {
  console.log('📡 Borsa sembol listeleri yükleniyor...');

  // ── Binance Futures sembolleri ──
  try {
    const r = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo');
    if (r.ok) {
      const d = await r.json();
      (d.symbols || []).forEach(s => {
        if (s.quoteAsset === 'USDT' && s.status === 'TRADING' && s.contractType === 'PERPETUAL') {
          // baseAsset normalize: "1000PEPE" → anahtar hem "1000PEPE" hem "PEPE"
          const base = s.baseAsset.toUpperCase();
          SYMBOL_REGISTRY.binance[base] = s.symbol;
          // 1000/1M ön ekini temizleyip de kaydet (PEPE → 1000PEPEUSDT)
          const clean = base.replace(/^1000+/, '').replace(/^1M/, '');
          if (clean !== base && !SYMBOL_REGISTRY.binance[clean]) {
            SYMBOL_REGISTRY.binance[clean] = s.symbol;
          }
        }
      });
      console.log(`  ✓ Binance: ${Object.keys(SYMBOL_REGISTRY.binance).length} coin`);
    }
  } catch (e) { console.log('  ✗ Binance sembol hatası:', e.message); }

  // ── Bybit sembolleri ──
  try {
    const r = await fetch('https://api.bybit.com/v5/market/instruments-info?category=linear');
    if (r.ok) {
      const d = await r.json();
      (d.result?.list || []).forEach(s => {
        if (s.quoteCoin === 'USDT' && s.status === 'Trading') {
          const base = s.baseCoin.toUpperCase();
          SYMBOL_REGISTRY.bybit[base] = s.symbol;
          const clean = base.replace(/^1000+/, '').replace(/^1M/, '');
          if (clean !== base && !SYMBOL_REGISTRY.bybit[clean]) {
            SYMBOL_REGISTRY.bybit[clean] = s.symbol;
          }
        }
      });
      console.log(`  ✓ Bybit: ${Object.keys(SYMBOL_REGISTRY.bybit).length} coin`);
    }
  } catch (e) { console.log('  ✗ Bybit sembol hatası:', e.message); }

  // ── OKX sembolleri ──
  try {
    const r = await fetch('https://www.okx.com/api/v5/public/instruments?instType=SWAP');
    if (r.ok) {
      const d = await r.json();
      (d.data || []).forEach(s => {
        if (s.settleCcy === 'USDT' && s.state === 'live') {
          const base = s.ctValCcy.toUpperCase();
          SYMBOL_REGISTRY.okx[base] = s.instId;
        }
      });
      console.log(`  ✓ OKX: ${Object.keys(SYMBOL_REGISTRY.okx).length} coin`);
    }
  } catch (e) { console.log('  ✗ OKX sembol hatası:', e.message); }

  registryLoaded = true;
  const total = new Set([
    ...Object.keys(SYMBOL_REGISTRY.binance),
    ...Object.keys(SYMBOL_REGISTRY.bybit),
    ...Object.keys(SYMBOL_REGISTRY.okx),
  ]).size;
  console.log(`✅ Toplam ${total} farklı coin yüklendi`);
}

// Bir coin hangi borsalarda var, listele
function findCoinExchanges(sym) {
  const s = sym.toUpperCase();
  const found = [];
  if (SYMBOL_REGISTRY.binance[s]) found.push('Binance');
  if (SYMBOL_REGISTRY.bybit[s])   found.push('Bybit');
  if (SYMBOL_REGISTRY.okx[s])     found.push('OKX');
  return found;
}

async function fetchOHLC(sym, tf) {
  const s = sym.toUpperCase();
  // Registry'den gerçek sembolü bul, yoksa varsayılan dene
  const bnSym = SYMBOL_REGISTRY.binance[s];
  const bySym = SYMBOL_REGISTRY.bybit[s];
  const okSym = SYMBOL_REGISTRY.okx[s];

  // Registry doluysa gerçek sembolü kullan, boşsa eski yöntemle dene
  const bars = (bnSym && await fetchBinanceRaw(bnSym, tf))
            || (bySym && await fetchBybitRaw(bySym, tf))
            || (okSym && await fetchOKXRaw(okSym, tf))
            || await fetchBinance(s, tf)   // fallback: direkt dene
            || await fetchBybit(s, tf)
            || await fetchOKX(s, tf);
  return bars;
}

// Gerçek sembol ile direkt çekim (registry'den gelen tam sembol adı)
async function fetchBinanceRaw(fullSym, tf) {
  const interval = { '1m':'1m','3m':'3m','5m':'5m','15m':'15m','30m':'30m','1h':'1h','2h':'2h','4h':'4h','1d':'1d','1w':'1w' }[tf] || '5m';
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${fullSym}&interval=${interval}&limit=200`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const d = await r.json();
    if (!Array.isArray(d) || d.length < 10) return null;
    return d.map(k => ({ t:k[0], o:parseFloat(k[1]), h:parseFloat(k[2]), l:parseFloat(k[3]), c:parseFloat(k[4]), vol:parseFloat(k[5]) }));
  } catch (e) { return null; }
}
async function fetchBybitRaw(fullSym, tf) {
  const interval = { '1m':'1','3m':'3','5m':'5','15m':'15','30m':'30','1h':'60','2h':'120','4h':'240','1d':'D','1w':'W' }[tf] || '5';
  const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${fullSym}&interval=${interval}&limit=200`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const d = await r.json();
    if (d.retCode !== 0 || !d.result?.list || d.result.list.length < 10) return null;
    return d.result.list.reverse().map(k => ({ t:parseInt(k[0]), o:parseFloat(k[1]), h:parseFloat(k[2]), l:parseFloat(k[3]), c:parseFloat(k[4]), vol:parseFloat(k[5]) }));
  } catch (e) { return null; }
}
async function fetchOKXRaw(fullSym, tf) {
  const bar = { '1m':'1m','3m':'3m','5m':'5m','15m':'15m','30m':'30m','1h':'1H','2h':'2H','4h':'4H','1d':'1D','1w':'1W' }[tf] || '5m';
  const url = `https://www.okx.com/api/v5/market/candles?instId=${fullSym}&bar=${bar}&limit=200`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const d = await r.json();
    if (d.code !== '0' || !d.data || d.data.length < 10) return null;
    return d.data.reverse().map(k => ({ t:parseInt(k[0]), o:parseFloat(k[1]), h:parseFloat(k[2]), l:parseFloat(k[3]), c:parseFloat(k[4]), vol:parseFloat(k[5]) }));
  } catch (e) { return null; }
}

// ── Binance Futures kline ──
async function fetchBinance(sym, tf) {
  const interval = { '1m':'1m','3m':'3m','5m':'5m','15m':'15m','30m':'30m','1h':'1h','2h':'2h','4h':'4h','1d':'1d','1w':'1w' }[tf] || '5m';
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}USDT&interval=${interval}&limit=200`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const d = await r.json();
    if (!Array.isArray(d) || d.length < 10) return null;
    return d.map(k => ({
      t: k[0], o: parseFloat(k[1]), h: parseFloat(k[2]),
      l: parseFloat(k[3]), c: parseFloat(k[4]), vol: parseFloat(k[5]),
    }));
  } catch (e) { return null; }
}

// ── Bybit kline ──
async function fetchBybit(sym, tf) {
  const interval = { '1m':'1','3m':'3','5m':'5','15m':'15','30m':'30','1h':'60','2h':'120','4h':'240','1d':'D','1w':'W' }[tf] || '5';
  const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${sym}USDT&interval=${interval}&limit=200`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const d = await r.json();
    if (d.retCode !== 0 || !d.result?.list || d.result.list.length < 10) return null;
    return d.result.list.reverse().map(k => ({
      t: parseInt(k[0]), o: parseFloat(k[1]), h: parseFloat(k[2]),
      l: parseFloat(k[3]), c: parseFloat(k[4]), vol: parseFloat(k[5]),
    }));
  } catch (e) { return null; }
}

// ── OKX kline ──
async function fetchOKX(sym, tf) {
  const bar = { '1m':'1m','3m':'3m','5m':'5m','15m':'15m','30m':'30m','1h':'1H','2h':'2H','4h':'4H','1d':'1D','1w':'1W' }[tf] || '5m';
  const url = `https://www.okx.com/api/v5/market/candles?instId=${sym}-USDT-SWAP&bar=${bar}&limit=200`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const d = await r.json();
    if (d.code !== '0' || !d.data || d.data.length < 10) return null;
    // OKX returns newest first - reverse
    return d.data.reverse().map(k => ({
      t: parseInt(k[0]), o: parseFloat(k[1]), h: parseFloat(k[2]),
      l: parseFloat(k[3]), c: parseFloat(k[4]), vol: parseFloat(k[5]),
    }));
  } catch (e) { return null; }
}

// Top coins by volume from CoinGecko
async function fetchHotCoins() {
  const url = 'https://api.coingecko.com/api/v3/coins/markets' +
    '?vs_currency=usd&order=volume_desc&per_page=50&page=1' +
    '&sparkline=false&price_change_percentage=1h,24h';
  try {
    const r = await fetch(url);
    const data = await r.json();
    return data
      .filter(c => c.total_volume > CONFIG.minVolume)
      .map(c => ({
        sym: c.symbol.toUpperCase(),
        price: c.current_price,
        chg24: c.price_change_percentage_24h || 0,
        vol: c.total_volume,
        scalpScore: Math.abs(c.price_change_percentage_1h_in_currency || 0) * 2 +
                    (c.total_volume / 1e9) * 0.5,
      }));
  } catch (e) {
    console.error('Hot coins fetch error:', e.message);
    return [];
  }
}

// ================================================================
// SIGNAL SCANNER
// ================================================================
async function scanForSignals() {
  const coins = await fetchHotCoins();
  if (!coins.length) {
    console.log(new Date().toLocaleTimeString('tr-TR'), '- Coin verisi alınamadı');
    return;
  }

  const candidates = coins
    .sort((a, b) => b.scalpScore - a.scalpScore)
    .slice(0, CONFIG.scanTopN);

  let found = 0;
  for (const coin of candidates) {
    try {
      const bars = await fetchOHLC(coin.sym, CONFIG.scalpTF);
      if (!bars || bars.length < 30) continue;

      const sig = calcScalpSignal(bars, coin.price);
      if (!sig || sig.confidence < CONFIG.minConfidence) continue;

      // Dedupe
      const key = coin.sym + sig.dir;
      const now = Date.now();
      if (alarmHistory[key] && now - alarmHistory[key] < CONFIG.dedupeMinutes * 60000) continue;

      // Backtest filter
      const bt = backtestScalp(bars, CONFIG.scalpTF);
      if (CONFIG.requireBacktest && bt) {
        if (!bt.profitable || parseFloat(bt.winRate) < CONFIG.minWinRate || bt.total < 3) {
          continue;
        }
      }

      alarmHistory[key] = now;
      found++;

      // Calculate entry/SL/TP
      const price = coin.price;
      const atr = sig.atr || price * 0.005;
      const slPctMax = { '1m': 0.005, '5m': 0.008, '15m': 0.012 }[CONFIG.scalpTF] || 0.008;
      const slDist = Math.min(atr * 0.8, price * slPctMax);
      const entry = price;
      const sl  = sig.dir === 'LONG' ? entry - slDist : entry + slDist;
      const tp1 = sig.dir === 'LONG' ? entry + slDist * 1 : entry - slDist * 1;
      const tp2 = sig.dir === 'LONG' ? entry + slDist * 2 : entry - slDist * 2;
      const tp3 = sig.dir === 'LONG' ? entry + slDist * 3.5 : entry - slDist * 3.5;

      const dec = price > 100 ? 2 : price > 1 ? 4 : 6;
      const f = v => v.toLocaleString('tr-TR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
      const emoji = sig.dir === 'LONG' ? '🟢⬆️' : '🔴⬇️';
      const btNote = bt && bt.total > 0 ? `\n📊 Backtest: %${bt.winRate} kazanma (${bt.total} işlem, P/L: ${bt.profitable ? '+' : ''}${bt.totalPnl}%)` : '';

      const msg =
`${emoji} <b>${sig.dir} SİNYALİ — ${coin.sym}</b>

💰 Fiyat: <b>$${f(price)}</b>
🎯 Güven: <b>%${sig.confidence}</b>
⏱️ Zaman dilimi: ${CONFIG.scalpTF}
📈 24s değişim: ${coin.chg24 >= 0 ? '+' : ''}${coin.chg24.toFixed(2)}%

<b>Giriş Seviyeleri:</b>
▫️ Giriş: $${f(entry)}
🛑 SL: $${f(sl)} (${(slDist / entry * 100).toFixed(2)}%)
✅ TP1: $${f(tp1)}
✅ TP2: $${f(tp2)}
✅ TP3: $${f(tp3)}

<b>Sinyaller:</b>
${sig.signals.slice(0, 4).map(s => '• ' + s).join('\n')}${btNote}

⚠️ <i>Yatırım tavsiyesi değildir. Kendi riskinle işlem yap.</i>`;

      await sendTelegram(msg);
      console.log(new Date().toLocaleTimeString('tr-TR'), `- ✅ Sinyal gönderildi: ${coin.sym} ${sig.dir} %${sig.confidence}`);

      // Small delay between messages
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error(`${coin.sym} hata:`, e.message);
    }
  }

  console.log(new Date().toLocaleTimeString('tr-TR'), `- Tarama bitti. ${candidates.length} coin tarandı, ${found} sinyal bulundu.`);
}

// ================================================================
// ================================================================
// KOMUT SİSTEMİ - kullanıcı coin yazınca analiz döner
// ================================================================

// Belirli bir chat'e mesaj gönder (komut cevapları için)
async function sendTelegramTo(chatId, text) {
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId, text, parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    return (await r.json()).ok;
  } catch (e) { return false; }
}

// Bir coin için tam analiz mesajı oluştur
async function analyzeCoinForCommand(symbol, tf) {
  tf = tf || CONFIG.scalpTF;
  const sym = symbol.toUpperCase().replace('USDT', '').replace('/', '').trim();

  const bars = await fetchOHLC(sym, tf);
  if (!bars || bars.length < 30) {
    return `❌ <b>${sym}</b> için veri bulunamadı.\n\n` +
      `Bu coin Binance/Bybit/OKX vadeli işlemlerinde bulunamadı.\n\n` +
      `• Coin ismini kontrol et (örn: BTC, ETH, SOL, DOGE, PEPE)\n` +
      `• USDT ekleme, sadece coin yaz\n` +
      `• Çok yeni/küçük coinler olmayabilir`;
  }

  const price = bars[bars.length - 1].c;
  const sig = calcScalpSignal(bars, price);
  const bt  = backtestScalp(bars, tf);

  if (!sig) return `❌ <b>${sym}</b> analiz edilemedi.`;

  const dec = price > 100 ? 2 : price > 1 ? 4 : 6;
  const f = v => v.toLocaleString('tr-TR', { minimumFractionDigits: dec, maximumFractionDigits: dec });

  // Entry/SL/TP hesapla
  const atr = sig.atr || price * 0.005;
  const slPctMax = { '1m':0.005,'3m':0.006,'5m':0.008,'15m':0.012,'30m':0.018,'1h':0.025,'2h':0.035,'4h':0.05,'1d':0.08,'1w':0.15 }[tf] || 0.01;
  const slDist = Math.min(atr * 0.8, price * slPctMax);
  const entry = price;
  const sl  = sig.dir === 'LONG' ? entry - slDist : entry + slDist;
  const tp1 = sig.dir === 'LONG' ? entry + slDist * 1 : entry - slDist * 1;
  const tp2 = sig.dir === 'LONG' ? entry + slDist * 2 : entry - slDist * 2;
  const tp3 = sig.dir === 'LONG' ? entry + slDist * 3.5 : entry - slDist * 3.5;

  const dirEmoji = sig.dir === 'LONG' ? '🟢⬆️' : '🔴⬇️';
  const confEmoji = sig.confidence >= 75 ? '🔥' : sig.confidence >= 60 ? '✅' : '⚠️';
  const flow = sig.orderFlow;
  const exchanges = findCoinExchanges(sym);
  const exNote = exchanges.length ? exchanges.join(', ') : 'Bilinmiyor';

  const btNote = bt && bt.total > 0
    ? `\n📊 <b>Backtest:</b> %${bt.winRate} kazanma (${bt.total} işlem, P/L: ${bt.profitable ? '+' : ''}${bt.totalPnl}%)`
    : '\n📊 Backtest: yeterli veri yok';

  let recommendation;
  if (sig.confidence >= 75) {
    recommendation = `${confEmoji} <b>GÜÇLÜ ${sig.dir} SİNYALİ</b> — Giriş için uygun`;
  } else if (sig.confidence >= 60) {
    recommendation = `${confEmoji} <b>ORTA ${sig.dir} EĞİLİMİ</b> — Dikkatli ol, teyit bekle`;
  } else {
    recommendation = `${confEmoji} <b>ZAYIF SİNYAL</b> — Şu an net giriş yok, bekle`;
  }

  return `${dirEmoji} <b>${sym} ANALİZ — ${tf}</b>

💰 Fiyat: <b>$${f(price)}</b>
🎯 Güven: <b>%${sig.confidence}</b>
${recommendation}

<b>Giriş Seviyeleri (${sig.dir}):</b>
▫️ Giriş: $${f(entry)}
🛑 SL: $${f(sl)} (${(slDist / entry * 100).toFixed(2)}%)
✅ TP1: $${f(tp1)}
✅ TP2: $${f(tp2)}
✅ TP3: $${f(tp3)}

<b>Sinyaller:</b>
${sig.signals.length ? sig.signals.slice(0, 5).map(s => '• ' + s).join('\n') : '• Net sinyal yok'}
${flow ? `\n<b>Order Flow:</b> Alım %${flow.buyPct.toFixed(0)} / Satım %${flow.sellPct.toFixed(0)}` : ''}
📈 RSI: ${sig.rsiNow ? sig.rsiNow.toFixed(1) : '--'}${btNote}
🏦 Borsalar: ${exNote}

⚠️ <i>Yatırım tavsiyesi değildir.</i>`;
}

// Gelen mesajları dinle (long polling)
let lastUpdateId = 0;
async function pollCommands() {
  try {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`;
    const r = await fetch(url);
    const d = await r.json();
    if (!d.ok || !d.result) return;

    for (const update of d.result) {
      lastUpdateId = update.update_id;
      const msg = update.message;
      if (!msg || !msg.text) continue;

      const chatId = msg.chat.id;
      const text = msg.text.trim();

      // /coins komutu - kaç coin var
      if (text === '/coins') {
        const total = new Set([
          ...Object.keys(SYMBOL_REGISTRY.binance),
          ...Object.keys(SYMBOL_REGISTRY.bybit),
          ...Object.keys(SYMBOL_REGISTRY.okx),
        ]).size;
        await sendTelegramTo(chatId,
          `🏦 <b>Mevcut Coin Sayısı</b>\n\n` +
          `• Binance: ${Object.keys(SYMBOL_REGISTRY.binance).length}\n` +
          `• Bybit: ${Object.keys(SYMBOL_REGISTRY.bybit).length}\n` +
          `• OKX: ${Object.keys(SYMBOL_REGISTRY.okx).length}\n\n` +
          `📊 Toplam <b>${total}</b> farklı coin analiz edilebilir.\n\n` +
          `Herhangi birinin ismini yaz, analiz edeyim!`
        );
        continue;
      }

      // /start veya /help komutu
      if (text === '/start' || text === '/help') {
        await sendTelegramTo(chatId,
          '🤖 <b>CryptoPro Bot Komutları</b>\n\n' +
          '📊 <b>Coin analizi için:</b>\n' +
          'Sadece coin ismini yaz, örn:\n' +
          '<code>BTC</code> veya <code>ETH</code> veya <code>SOL</code>\n\n' +
          '⏱️ <b>Zaman dilimi seçmek için:</b>\n' +
          '<code>BTC 5m</code> — tek zaman dilimi\n' +
          '<code>BTC 5m 1h 4h</code> — birden fazla (max 5)\n\n' +
          '<b>Kullanılabilir zaman dilimleri:</b>\n' +
          '1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 1d, 1w\n\n' +
          '📋 <code>/coins</code> — kaç coin var gör\n\n' +
          '🔔 Otomatik sinyaller %' + CONFIG.minConfidence + '+ güvende gelir.\n\n' +
          'Hadi bir coin yaz, analiz edeyim! 🚀'
        );
        continue;
      }

      // Komut mesajlarını atla (/ ile başlayan diğerleri)
      if (text.startsWith('/')) continue;

      // Coin + opsiyonel TF(ler) parse et
      // Örnekler: "BTC" / "BTC 5m" / "BTC 5m 1h 4h" / "ETH 1d"
      const VALID_TFS = ['1m','3m','5m','15m','30m','1h','2h','4h','1d','1w'];
      const parts = text.split(/\s+/);
      const coinSym = parts[0];

      // Geçerli coin ismi mi
      if (!/^[A-Za-z0-9]{2,15}$/.test(coinSym)) {
        await sendTelegramTo(chatId, '❓ Geçerli bir coin ismi yaz (örn: <code>BTC</code>, <code>ETH</code>, <code>SOL</code>).\n\nKomutlar için /help yaz.');
        continue;
      }

      // Yazılan TF'leri topla (birden fazla olabilir)
      let tfs = parts.slice(1).filter(p => VALID_TFS.includes(p.toLowerCase())).map(p => p.toLowerCase());
      if (tfs.length === 0) tfs = [CONFIG.scalpTF]; // hiç yazılmadıysa varsayılan
      if (tfs.length > 5) tfs = tfs.slice(0, 5); // max 5 TF

      // "Analiz ediliyor" mesajı
      await sendTelegramTo(chatId, `⏳ <b>${coinSym.toUpperCase()}</b> analiz ediliyor (${tfs.join(', ')})...`);

      // Her TF için analiz yap ve gönder
      for (const tf of tfs) {
        const analysis = await analyzeCoinForCommand(coinSym, tf);
        await sendTelegramTo(chatId, analysis);
        await new Promise(r => setTimeout(r, 400)); // mesajlar arası kısa bekleme
      }
      console.log(new Date().toLocaleTimeString('tr-TR'), `- Komut: ${coinSym} [${tfs.join(',')}] → ${chatId}`);
    }
  } catch (e) {
    console.error('Poll error:', e.message);
  }
}

// ================================================================
// START
// ================================================================
async function start() {
  console.log('🤖 CryptoPro Telegram Bot başlatılıyor...');
  console.log(`Ayarlar: Min güven %${CONFIG.minConfidence}, ${CONFIG.scalpTF} TF, ${CONFIG.scanInterval / 1000}s tarama`);

  // Test Telegram connection
  const ok = await sendTelegram(
    '🤖 <b>CryptoPro Bot Aktif!</b>\n\n' +
    `📡 Her ${CONFIG.scanInterval / 60000} dakikada bir top ${CONFIG.scanTopN} coin taranıyor.\n` +
    `🎯 Min güven: %${CONFIG.minConfidence}\n` +
    `⏱️ Scalp TF: ${CONFIG.scalpTF}\n` +
    `📊 Backtest filtresi: ${CONFIG.requireBacktest ? 'Açık (min %' + CONFIG.minWinRate + ')' : 'Kapalı'}\n\n` +
    '💬 <b>Coin analizi için ismini yaz!</b>\n' +
    'Örn: <code>BTC</code> veya <code>SOL 5m</code>\n\n' +
    'Komutlar için /help yaz.\n\n' +
    'Yüksek güvenli sinyaller buraya gelecek. İyi işlemler! 🚀'
  );

  if (!ok) {
    console.error('❌ Telegram bağlantısı başarısız! TG_TOKEN ve TG_CHAT_ID kontrol et.');
    process.exit(1);
  }
  console.log('✅ Telegram bağlantısı başarılı!');

  // Borsa sembollerini yükle (tüm coinler)
  await loadSymbolRegistry();

  // First scan immediately
  await scanForSignals();

  // Then scan periodically
  setInterval(scanForSignals, CONFIG.scanInterval);

  // Komut dinleme döngüsü (sürekli)
  console.log('💬 Komut dinleyici aktif - coin ismi yazarak analiz alabilirsin');
  while (true) {
    await pollCommands();
  }
}

start();
