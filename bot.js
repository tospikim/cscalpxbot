const crypto = require('crypto');
const fs = require('fs');

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

// ── OKX İŞLEM API (gerçek para) ──
const OKX_API_KEY    = clean(process.env.OKX_API_KEY)    || '';
const OKX_SECRET     = clean(process.env.OKX_SECRET)     || '';
const OKX_PASSPHRASE = clean(process.env.OKX_PASSPHRASE) || '';

// İŞLEM AYARLARI
const TRADE = {
  // GÜVENLİK: Gerçek işlem için bunu Railway'de LIVE_TRADING=true yap.
  // false ise bot sadece sinyal verir, GERÇEK İŞLEM AÇMAZ.
  live: clean(process.env.LIVE_TRADING) === 'true',
  riskPerTrade: 2,          // her işlemde bakiyenin %2'si risk
  dailyLossLimit: 10,       // günlük -%10 zararda bot durur
  maxOpenPositions: 0,      // 0 = limitsiz
  tdMode: 'isolated',       // izole marjin (cross değil - daha güvenli)
};

// İşlem durumu takibi
let tradingState = {
  enabled: true,            // /islemdur ile kapatılabilir
  dayStartBalance: null,    // günün başındaki bakiye
  dayStartTime: Date.now(),
  realizedPnlToday: 0,
  haltedReason: null,       // zarar limiti aşılırsa sebep
};

// DEBUG: Railway'in gerçekte ne aktardığını gör (token'ın sadece güvenli kısmı)
console.log('🔍 Token uzunluğu:', TG_TOKEN.length, '| İlk 12:', TG_TOKEN.slice(0, 12), '| Son 4:', TG_TOKEN.slice(-4));
console.log('🔍 Chat ID:', JSON.stringify(TG_CHAT_ID), '| uzunluk:', TG_CHAT_ID.length);

// Ayarlar
const CONFIG = {
  minConfidence:   70,        // Min sinyal güveni (%) - 75'ten 70'e düşürüldü
  minVolume:       50000000,  // (eski - kullanılmıyor)
  scanMaxDetailed: 80,        // Hacim filtresinden sonra kaç coin detaylı taranacak
  minScanVolume:   15000000,  // Tarama için min 24s hacim ($15M)
  scanInterval:    300000,    // Tarama sıklığı (ms) = 5 dakika
  dedupeMinutes:   30,        // Aynı coin için tekrar uyarı engeli (dk)
  scalpTF:         '5m',      // Scalp zaman dilimi
  requireBacktest: true,      // Backtest kârlı olmalı mı
  minWinRate:      45,        // Min backtest kazanma oranı (%) - 50'den 45'e
  minBacktestTrades: 2,       // Min backtest işlem sayısı - 3'ten 2'ye
};

const alarmHistory = {};
// Açık pozisyonlar: { "BTCLONG": { sym, dir, entry, sl, tp1, tp2, tp3, leverage, openTime, tpHit:[] } }
const openPositions = {};

// ================================================================
// ÖĞRENME MODU — geçmiş SL'lerden öğren, benzer hatayı tekrarlama (daha az SL)
// Her kapanan işlemin sonucu (kazanç/kayıp) bağlamıyla kaydedilir; taramada
// trend-karşıtı ve geçmişte kaybettiren kurulumlar ENGELLENİR. Kalıcı (JSON dosyası).
// ================================================================
const LEARN_FILE = clean(process.env.LEARN_FILE) || './learning.json';
let learnLog = [];
function loadLearning() {
  try {
    const d = JSON.parse(fs.readFileSync(LEARN_FILE, 'utf8'));
    if (d && Array.isArray(d.log)) learnLog = d.log;
    console.log('🧠 Öğrenme yüklendi:', learnLog.length, 'sonuç');
  } catch (e) { learnLog = []; console.log('🧠 Öğrenme dosyası yok, sıfırdan başlıyor.'); }
}
function saveLearning() {
  try { fs.writeFileSync(LEARN_FILE, JSON.stringify({ ver: 1, log: learnLog.slice(-2000) })); }
  catch (e) { console.error('öğrenme kaydedilemedi:', e.message); }
}
// Üst-TF trendini kovaya indir: güçlü hizalı ise LONG/SHORT, değilse NEUTRAL
function htfBucket(htf) {
  if (!htf) return 'NEUTRAL';
  if (htf.aligned >= 0.6) return htf.dominantBias;
  return 'NEUTRAL';
}
function isCounterTrend(dir, htf) {
  const b = htfBucket(htf);
  return (b === 'LONG' && dir === 'SHORT') || (b === 'SHORT' && dir === 'LONG');
}
// Sonuç kaydet (win/loss) — pozisyon kapanınca çağrılır
function recordOutcome(ctx, result) {
  if (!ctx) return;
  learnLog.push({ sym: ctx.sym, dir: ctx.dir, htf: ctx.htf, ct: ctx.ct ? 1 : 0, conf: ctx.conf, dist: ctx.dist, result, t: Date.now() });
  if (learnLog.length > 2000) learnLog = learnLog.slice(-2000);
  saveLearning();
  console.log(`🧠 Sonuç kaydedildi: ${ctx.sym} ${ctx.dir} → ${result} (toplam ${learnLog.length})`);
}
// Kategori (yön + üst-TF durumu) kazanma oranı
function bucketWR(dir, htfB) {
  const rel = learnLog.filter(e => e.dir === dir && e.htf === htfB);
  const w = rel.filter(e => e.result === 'win').length;
  const n = rel.length;
  return { n, w, l: n - w, wr: n ? w / n * 100 : null };
}
// Aynı coin+yön son 3 saatte kaybettirdi mi
function recentLoss(sym, dir) {
  const now = Date.now();
  return learnLog.some(e => e.sym === sym && e.dir === dir && e.result === 'loss' && now - e.t < 3 * 3600 * 1000);
}
// Tekrar eden hata: bir özellik ≥3 kez kaybettirdiyse o özelliği taşıyan sinyali engelle
function recurringBlock(ctx) {
  const losses = learnLog.filter(e => e.result === 'loss');
  if (losses.length < 4) return null;
  const ctLoss = losses.filter(e => e.ct).length;
  if (ctLoss >= 3 && ctx.ct) return 'trend karşıtı (' + ctLoss + ' kez kaybettirdi)';
  const lowLoss = losses.filter(e => e.conf < 75).length;
  if (lowLoss >= 3 && ctx.conf < 75) return 'düşük güven (' + lowLoss + ' kez kaybettirdi)';
  return null;
}
// ANA ÖĞRENME KAPISI — girişe izin (null) ya da engel sebebi (string)
function learnBlock(ctx) {
  // 1) TREND KARŞITI + üst TF güçlü ters yönde → engelle (en sık SL sebebi)
  //    Ama bu kategori kanıtlanmış kazançlıysa (≥%55, ≥5 örnek) izin ver.
  if (ctx.ct) {
    const b = bucketWR(ctx.dir, ctx.htf);
    if (!(b.n >= 5 && b.wr != null && b.wr >= 55)) return 'trend karşıtı (üst TF ters yönde)';
  }
  // 2) Aynı coin+yön yakın zamanda kaybettirdi → tekrar girme
  if (recentLoss(ctx.sym, ctx.dir)) return 'bu coin+yön yakında SL oldu';
  // 3) Tekrar eden hata özelliği
  const rb = recurringBlock(ctx); if (rb) return rb;
  // 4) Kategori geçmişi zayıf (yeterli örnekle)
  const b = bucketWR(ctx.dir, ctx.htf);
  if (b.n >= 5 && b.wr != null && b.wr < 35) return 'kategori zayıf (%' + Math.round(b.wr) + ', ' + b.n + ' işlem)';
  return null;
}
// Öğrenme özeti (/ogrenme komutu için)
function learnSummary() {
  const total = learnLog.length;
  const wins = learnLog.filter(e => e.result === 'win').length;
  const losses = total - wins;
  const wr = total ? Math.round(wins / total * 100) : 0;
  const ctLoss = learnLog.filter(e => e.result === 'loss' && e.ct).length;
  const lowLoss = learnLog.filter(e => e.result === 'loss' && e.conf < 75).length;
  // kategori kırılımı
  const cats = {};
  learnLog.forEach(e => { const k = e.dir + '|' + e.htf; cats[k] = cats[k] || { n: 0, w: 0 }; cats[k].n++; if (e.result === 'win') cats[k].w++; });
  let catTxt = '';
  Object.entries(cats).filter(([k, v]) => v.n >= 3).sort((a, b) => (a[1].w / a[1].n) - (b[1].w / b[1].n)).slice(0, 6)
    .forEach(([k, v]) => { const p = k.split('|'); const w = Math.round(v.w / v.n * 100); const mark = w < 40 ? '🚫' : w >= 60 ? '⭐' : '•'; catTxt += `${mark} ${p[0]} (üst TF ${p[1]}): %${w} · ${v.n} işlem\n`; });
  return '🧠 <b>Bot Ne Öğrendi</b>\n\n' +
    `Toplam sonuç: <b>${total}</b> · Kazanç ${wins} · Kayıp ${losses} · Başarı %${wr}\n\n` +
    (total < 5 ? '<i>Yeterli veri birikince kurallar netleşecek (her kapanan işlem buraya eklenir).</i>\n\n' : '') +
    '<b>Sık kayıp sebepleri:</b>\n' +
    `• Trend karşıtı: ${ctLoss} kez` + (ctLoss >= 3 ? ' → artık bloklanıyor ✓' : '') + '\n' +
    `• Düşük güven (<%75): ${lowLoss} kez` + (lowLoss >= 3 ? ' → artık bloklanıyor ✓' : '') + '\n\n' +
    (catTxt ? '<b>Kategori performansı:</b>\n' + catTxt : '');
}


// ================================================================
// SPOT (KALDIRAÇSIZ) MODÜLÜ — OKX'te vadeli olmayan coinler + DEX coinleri
// SPOT_COINS listesindeki coinler için ALIM fırsatı → aldıktan sonra SATIŞ sinyali.
// Veri: OKX spot → Bybit spot → Binance spot → (opsiyonel) GeckoTerminal DEX.
// ================================================================
const SPOT_COINS = (clean(process.env.SPOT_COINS) || '')
  .split(',').map(s => s.trim().toUpperCase().replace('/', '').replace('USDT', '')).filter(Boolean);
// DEX_POOLS formatı: "PONKE:solana:POOLADRESI,WIF:solana:POOL2"  (SEMBOL:ağ:havuz)
const DEX_POOLS = {};
(clean(process.env.DEX_POOLS) || '').split(',').forEach(x => {
  const p = x.split(':'); if (p.length >= 3) DEX_POOLS[p[0].trim().toUpperCase()] = { network: p[1].trim(), pool: p[2].trim() };
});
const spotPositions = {};
let _lastSpotSource = '';   // son başarılı spot veri kaynağı (mesajlarda gösterilir)
const _spotCache = {};      // kısa önbellek: {key: {t, v, src}} — DEX rate limitini korur (GT: ~30 istek/dk)

// SPOT mum verisi: OKX spot → Bybit spot → Binance spot → DEX (GeckoTerminal)
const _spotTf = {
  okx:    { '1m':'1m','5m':'5m','15m':'15m','1h':'1H','4h':'4H','1d':'1D' },
  bybit:  { '1m':'1','5m':'5','15m':'15','1h':'60','4h':'240','1d':'D' },
  binance:{ '1m':'1m','5m':'5m','15m':'15m','1h':'1h','4h':'4h','1d':'1d' },
};
async function fetchSpotOHLC(sym, tf) {
  // Önbellek (20 sn): aynı sembol+TF tekrar istenirse API'ye gitme (DEX rate limitini korur)
  const ck = sym + '_' + tf;
  const hit = _spotCache[ck];
  if (hit && Date.now() - hit.t < 20000) { _lastSpotSource = hit.src; return hit.v; }
  const bars = await _fetchSpotOHLCRaw(sym, tf);
  if (bars) _spotCache[ck] = { t: Date.now(), v: bars, src: _lastSpotSource };
  return bars;
}
async function _fetchSpotOHLCRaw(sym, tf) {
  // 1) OKX spot
  try {
    const bar = _spotTf.okx[tf] || '5m';
    const r = await fetch(`https://www.okx.com/api/v5/market/candles?instId=${sym}-USDT&bar=${bar}&limit=200`);
    const d = await r.json();
    if (d.code === '0' && d.data && d.data.length >= 10) {
      _lastSpotSource = 'OKX Spot';
      return d.data.reverse().map(k => ({ t:+k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4], vol:+k[5] }));
    }
  } catch (e) {}
  // 2) Bybit spot (not: Railway US'ten engelli olabilir)
  try {
    const iv = _spotTf.bybit[tf] || '5';
    const r = await fetch(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym}USDT&interval=${iv}&limit=200`);
    const d = await r.json();
    if (d.retCode === 0 && d.result && d.result.list && d.result.list.length >= 10) {
      _lastSpotSource = 'Bybit Spot';
      return d.result.list.reverse().map(k => ({ t:+k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4], vol:+k[5] }));
    }
  } catch (e) {}
  // 3) Binance spot (not: Railway US'ten engelli olabilir)
  try {
    const iv = _spotTf.binance[tf] || '5m';
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}USDT&interval=${iv}&limit=200`);
    const d = await r.json();
    if (Array.isArray(d) && d.length >= 10) {
      _lastSpotSource = 'Binance Spot';
      return d.map(k => ({ t:k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4], vol:+k[5] }));
    }
  } catch (e) {}
  // 4) MEXC spot (Binance uyumlu API — memecoinlerin çoğu burada listeli, geo-engel yok)
  try {
    const iv = _spotTf.binance[tf] || '5m';
    const r = await fetch(`https://api.mexc.com/api/v3/klines?symbol=${sym}USDT&interval=${iv}&limit=200`);
    const d = await r.json();
    if (Array.isArray(d) && d.length >= 10) {
      _lastSpotSource = 'MEXC Spot';
      return d.map(k => ({ t:k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4], vol:+k[5] }));
    }
  } catch (e) {}
  // 5) KuCoin spot
  try {
    const kuTf = { '1m':'1min','5m':'5min','15m':'15min','1h':'1hour','4h':'4hour','1d':'1day' }[tf] || '5min';
    const r = await fetch(`https://api.kucoin.com/api/v1/market/candles?type=${kuTf}&symbol=${sym}-USDT`);
    const d = await r.json();
    if (d.code === '200000' && Array.isArray(d.data) && d.data.length >= 10) {
      _lastSpotSource = 'KuCoin Spot';
      // KuCoin: [time(s), open, close, high, low, volume, turnover] — en yeni önce
      return d.data.reverse().map(k => ({ t:+k[0]*1000, o:+k[1], h:+k[3], l:+k[4], c:+k[2], vol:+k[5] })).slice(-200);
    }
  } catch (e) {}
  // 6) Gate.io spot
  try {
    const gTf = { '1m':'1m','5m':'5m','15m':'15m','1h':'1h','4h':'4h','1d':'1d' }[tf] || '5m';
    const r = await fetch(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${sym}_USDT&interval=${gTf}&limit=200`);
    const d = await r.json();
    if (Array.isArray(d) && d.length >= 10) {
      _lastSpotSource = 'Gate.io Spot';
      // Gate: [t(s), quoteVol, close, high, low, open, baseVol, ...] — eski→yeni
      return d.map(k => ({ t:+k[0]*1000, o:+k[5], h:+k[3], l:+k[4], c:+k[2], vol:+k[6] }));
    }
  } catch (e) {}
  // 7) DEX (GeckoTerminal) — manuel tanımlı YA DA otomatik bulunmuş havuz
  let poolInfo = DEX_POOLS[sym];
  if (!poolInfo) poolInfo = await findDexPool(sym);   // OTOMATİK: en likit havuzu ara-bul
  if (poolInfo) {
    const b = await fetchDexOHLC(poolInfo.network, poolInfo.pool, tf);
    if (b && b.length >= 10) { _lastSpotSource = 'DEX (' + poolInfo.network + ')'; return b; }
  }
  return null;
}
// ── OTOMATİK DEX HAVUZ BULMA (GeckoTerminal arama, ücretsiz) ──
// Coin hiçbir CEX'te yoksa: sembolü arar, ismi eşleşen EN LİKİT havuzu bulur, önbelleğe alır.
const _dexSearchCache = {};   // { SYM: {network,pool} | null }
async function findDexPool(sym) {
  if (sym in _dexSearchCache) return _dexSearchCache[sym];
  try {
    const r = await fetch(`https://api.geckoterminal.com/api/v2/search/pools?query=${encodeURIComponent(sym)}&page=1`);
    const d = await r.json();
    const pools = (d && d.data) || [];
    let best = null, bestLiq = 0;
    for (const p of pools) {
      const at = p.attributes || {};
      const name = String(at.name || '').toUpperCase();
      // Havuz adı "SYM / ..." ile başlamalı (yanlış coin eşleşmesin)
      if (!name.startsWith(sym + ' /') && !name.startsWith(sym + '/')) continue;
      const liq = parseFloat(at.reserve_in_usd || '0') || 0;
      if (liq < 10000) continue;             // çok sığ havuzları alma (min $10k likidite)
      if (liq > bestLiq) {
        // id formatı: "network_pooladdress"
        const id = String(p.id || ''); const us = id.indexOf('_');
        if (us > 0) { best = { network: id.slice(0, us), pool: id.slice(us + 1) }; bestLiq = liq; }
      }
    }
    _dexSearchCache[sym] = best;
    if (best) console.log(`🔎 DEX havuzu otomatik bulundu: ${sym} → ${best.network}/${best.pool} ($${Math.round(bestLiq).toLocaleString()} likidite)`);
    return best;
  } catch (e) { _dexSearchCache[sym] = null; return null; }
}
// DEX mum verisi (GeckoTerminal, ücretsiz, key gerekmez)
async function fetchDexOHLC(network, pool, tf) {
  const gtTf  = { '1m':'minute','5m':'minute','15m':'minute','1h':'hour','4h':'hour','1d':'day' };
  const gtAgg = { '1m':1,'5m':5,'15m':15,'1h':1,'4h':4,'1d':1 };
  try {
    const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/${network}/pools/${pool}/ohlcv/${gtTf[tf]||'minute'}?aggregate=${gtAgg[tf]||5}&limit=200`);
    const d = await r.json();
    const list = d && d.data && d.data.attributes && d.data.attributes.ohlcv_list;
    if (!list || list.length < 10) return null;
    return list.reverse().map(k => ({ t:k[0]*1000, o:+k[1], h:+k[2], l:+k[3], c:+k[4], vol:+k[5] }));
  } catch (e) { return null; }
}
// SPOT için üst-TF trend (spot verisiyle) — öğrenme kapısı için
async function spotHtfBias(sym) {
  const tfs = ['15m','1h','4h','1d']; const w = { '15m':1,'1h':2,'4h':3,'1d':4 };
  let bull = 0, bear = 0, tot = 0;
  for (const tf of tfs) {
    const b = await fetchSpotOHLC(sym, tf);
    if (!b || b.length < 22) continue;
    const c = b.map(x => x.c); const e9 = ema(c, 9), e21 = ema(c, 21);
    const wt = w[tf]; tot += wt; if (e9 >= e21) bull += wt; else bear += wt;
  }
  if (tot === 0) return { dominantBias: 'NEUTRAL', aligned: 0 };
  return { dominantBias: bull >= bear ? 'LONG' : 'SHORT', aligned: Math.max(bull, bear) / tot };
}


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
// ── Destek/Direnç seviyeleri (swing high/low) ──
function calcSupportResistance(bars, lookback) {
  lookback = lookback || 50;
  const recent = bars.slice(-lookback);
  const swingHighs = [], swingLows = [];
  // 2 mum solu+sağı pivot kontrolü
  for (let i = 2; i < recent.length - 2; i++) {
    const h = recent[i].h, l = recent[i].l;
    if (h >= recent[i-1].h && h >= recent[i-2].h && h >= recent[i+1].h && h >= recent[i+2].h)
      swingHighs.push(h);
    if (l <= recent[i-1].l && l <= recent[i-2].l && l <= recent[i+1].l && l <= recent[i+2].l)
      swingLows.push(l);
  }
  const price = recent[recent.length - 1].c;
  // Fiyatın üstündeki en yakın direnç, altındaki en yakın destek
  const resAbove = swingHighs.filter(h => h > price).sort((a,b) => a-b);
  const supBelow = swingLows.filter(l => l < price).sort((a,b) => b-a);
  return {
    nearestRes: resAbove[0] || Math.max(...recent.map(b=>b.h)),
    nearestSup: supBelow[0] || Math.min(...recent.map(b=>b.l)),
    allHighs: swingHighs, allLows: swingLows,
  };
}

// ── Bollinger Bantları ──
function calcBollinger(bars, period, mult) {
  period = period || 20; mult = mult || 2;
  if (bars.length < period) return null;
  const closes = bars.slice(-period).map(b => b.c);
  const mean = closes.reduce((a,b) => a+b, 0) / period;
  const variance = closes.reduce((a,b) => a + (b-mean)**2, 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mean + mult*std, mid: mean, lower: mean - mult*std, std };
}

// ── Fibonacci geri çekilme (golden pocket 0.618) ──
function calcFib(bars) {
  const recent = bars.slice(-60);
  const high = Math.max(...recent.map(b => b.h));
  const low = Math.min(...recent.map(b => b.l));
  const diff = high - low;
  let hi = 0, lo = 0;
  recent.forEach((b,i) => { if(b.h===high) hi=i; if(b.l===low) lo=i; });
  const uptrend = lo < hi;
  return {
    high, low, uptrend,
    // Golden pocket: yükselişte geri çekilme alımı, düşüşte tepki satışı
    golden618: uptrend ? high - diff*0.618 : low + diff*0.618,
    fib500: uptrend ? high - diff*0.5 : low + diff*0.5,
    fib382: uptrend ? high - diff*0.382 : low + diff*0.382,
  };
}

// ── RSI uyumsuzluğu (dönüş sinyali) ──
function calcRSIDivergence(bars, rsiData) {
  const n = bars.length;
  if (n < 15) return { bull: false, bear: false };
  const lookback = 14;
  const pSlice = bars.slice(-lookback);
  const rSlice = rsiData.slice(-lookback);
  const lows = [], highs = [];
  for (let i = 1; i < pSlice.length - 1; i++) {
    if (pSlice[i].l < pSlice[i-1].l && pSlice[i].l < pSlice[i+1].l) lows.push({p: pSlice[i].l, r: rSlice[i]});
    if (pSlice[i].h > pSlice[i-1].h && pSlice[i].h > pSlice[i+1].h) highs.push({p: pSlice[i].h, r: rSlice[i]});
  }
  let bull = false, bear = false;
  if (lows.length >= 2) {
    const a = lows[lows.length-2], b = lows[lows.length-1];
    if (b.p < a.p && b.r > a.r) bull = true; // fiyat dip yapıyor ama RSI yükseliyor
  }
  if (highs.length >= 2) {
    const a = highs[highs.length-2], b = highs[highs.length-1];
    if (b.p > a.p && b.r < a.r) bear = true; // fiyat tepe yapıyor ama RSI düşüyor
  }
  return { bull, bear };
}

function calcScalpSignal(bars, price) {
  if (bars.length < 22) return null;
  const mom = calcMomentum(bars, 10);
  const flow = calcOrderFlow(bars);
  const ribbon = calcEMARibbon(bars);
  const rsiData = rsiArr(bars.map(b => b.c), 14);
  const rsiNow = rsiData[rsiData.length - 1];
  const atr = calcATR(bars, 14);
  const sr = calcSupportResistance(bars, 50);
  const bb = calcBollinger(bars, 20, 2);
  const fib = calcFib(bars);
  const div = calcRSIDivergence(bars, rsiData);

  // Fiyatın destek/dirence yakınlığı (% olarak)
  const distToRes = sr.nearestRes ? (sr.nearestRes - price) / price * 100 : 99;
  const distToSup = sr.nearestSup ? (price - sr.nearestSup) / price * 100 : 99;

  let longSig = 0, shortSig = 0;
  const signals = { long: [], short: [] };

  // ═══════════════════════════════════════════════════════
  // DÖNÜŞ MANTIGI: SHORT'u tepeden, LONG'u dipten yakala
  // ═══════════════════════════════════════════════════════

  // 1. DESTEK/DİRENÇ YAKINLIĞI (en önemli - dönüş buralarda olur)
  if (distToRes < 0.5) { shortSig += 30; signals.short.push(`Dirence çok yakın ($${sr.nearestRes.toFixed(4)})`); }
  else if (distToRes < 1.2) { shortSig += 18; signals.short.push('Dirence yaklaşıyor'); }
  if (distToSup < 0.5) { longSig += 30; signals.long.push(`Desteğe çok yakın ($${sr.nearestSup.toFixed(4)})`); }
  else if (distToSup < 1.2) { longSig += 18; signals.long.push('Desteğe yaklaşıyor'); }

  // 2. BOLLINGER BANT (üst banda değdi=short, alt banda değdi=long)
  if (bb) {
    if (price >= bb.upper) { shortSig += 25; signals.short.push('Üst Bollinger bandında (aşırı uzamış)'); }
    else if (price >= bb.upper - bb.std * 0.5) { shortSig += 12; signals.short.push('Üst banda yakın'); }
    if (price <= bb.lower) { longSig += 25; signals.long.push('Alt Bollinger bandında (aşırı düşmüş)'); }
    else if (price <= bb.lower + bb.std * 0.5) { longSig += 12; signals.long.push('Alt banda yakın'); }
  }

  // 3. RSI AŞIRI BÖLGELER (dönüş bölgeleri)
  if (rsiNow !== null) {
    if (rsiNow > 72) { shortSig += 22; signals.short.push(`RSI aşırı alım (${rsiNow.toFixed(0)})`); }
    else if (rsiNow > 65) { shortSig += 10; signals.short.push('RSI yüksek'); }
    if (rsiNow < 28) { longSig += 22; signals.long.push(`RSI aşırı satım (${rsiNow.toFixed(0)})`); }
    else if (rsiNow < 35) { longSig += 10; signals.long.push('RSI düşük'); }
  }

  // 4. RSI UYUMSUZLUĞU (güçlü dönüş sinyali)
  if (div.bear) { shortSig += 25; signals.short.push('Ayı uyumsuzluğu (fiyat↑ RSI↓)'); }
  if (div.bull) { longSig += 25; signals.long.push('Boğa uyumsuzluğu (fiyat↓ RSI↑)'); }

  // 5. FİBONACCİ GOLDEN POCKET (geri çekilme dönüş noktası)
  if (fib) {
    const gpDist = Math.abs(price - fib.golden618) / price * 100;
    if (gpDist < 0.6) {
      if (fib.uptrend) { longSig += 18; signals.long.push('Fib golden pocket (0.618) - alım bölgesi'); }
      else { shortSig += 18; signals.short.push('Fib golden pocket (0.618) - satım bölgesi'); }
    }
  }

  // 6. ORDER FLOW TEYİDİ (dönüşü onaylıyor mu)
  if (flow) {
    // Dirence yakınken satım baskısı başladıysa = short teyidi
    if (distToRes < 1.2 && flow.delta < -3) { shortSig += 12; signals.short.push('Satım baskısı başladı'); }
    // Desteğe yakınken alım baskısı başladıysa = long teyidi
    if (distToSup < 1.2 && flow.delta > 3) { longSig += 12; signals.long.push('Alım baskısı başladı'); }
  }

  // 7. MUM DÖNÜŞ FORMASYONU (son mum dönüş gösteriyor mu)
  const last = bars[bars.length-1], prev = bars[bars.length-2];
  if (last && prev) {
    const lastBody = last.c - last.o;
    const lastRange = last.h - last.l || 0.0001;
    const upperWick = last.h - Math.max(last.c, last.o);
    const lowerWick = Math.min(last.c, last.o) - last.l;
    // Üst fitil uzun = tepeden satış (short)
    if (upperWick > lastRange * 0.5 && distToRes < 1.5) { shortSig += 12; signals.short.push('Uzun üst fitil (satış baskısı)'); }
    // Alt fitil uzun = dipten alış (long)
    if (lowerWick > lastRange * 0.5 && distToSup < 1.5) { longSig += 12; signals.long.push('Uzun alt fitil (alış baskısı)'); }
  }

  const dir = longSig >= shortSig ? 'LONG' : 'SHORT';
  // Maksimum gerçekçi ~85 puan. Dönüş sinyalleri üst üste binince yüksek güven.
  const confidence = Math.min(100, Math.round(Math.max(longSig, shortSig) / 85 * 100));

  return {
    dir, confidence,
    signals: dir === 'LONG' ? signals.long : signals.short,
    atr, rsiNow, orderFlow: flow,
    sr, bb, fib,
    distToRes, distToSup,
  };
}

// ── AKILLI GİRİŞ/SL/TP HESAPLAMA (dönüş seviyelerine göre) ──
function calcEntryLevels(sig, price, tf) {
  const atr = sig.atr || price * 0.005;
  const sr = sig.sr || {};

  let entry, sl, entryZoneLow, entryZoneHigh;

  if (sig.dir === 'LONG') {
    // LONG: destekten gir. Giriş bölgesi = destek ile mevcut fiyat arası
    const support = sr.nearestSup || (price - atr * 2);
    // Giriş bölgesi: desteğin biraz üstü (fiyat oraya çekilince al)
    entryZoneLow = support;
    entryZoneHigh = Math.min(price, support + atr * 1.5);
    entry = (entryZoneLow + entryZoneHigh) / 2; // bölge ortası
    // SL: desteğin ALTINA (ATR kadar tampon) - kolay vurmasın
    sl = support - atr * 1.2;
  } else {
    // SHORT: dirençten gir. Giriş bölgesi = mevcut fiyat ile direnç arası
    const resistance = sr.nearestRes || (price + atr * 2);
    entryZoneHigh = resistance;
    entryZoneLow = Math.max(price, resistance - atr * 1.5);
    entry = (entryZoneLow + entryZoneHigh) / 2;
    // SL: direncin ÜSTÜNE (ATR tampon)
    sl = resistance + atr * 1.2;
  }

  // SL mesafesi (giriş ile SL arası)
  const slDist = Math.abs(entry - sl);
  // Aşırı geniş SL'yi sınırla (TF'ye göre max %)
  const slPctMax = { '1m':0.008,'5m':0.012,'15m':0.018,'30m':0.025,'1h':0.035,'2h':0.05,'4h':0.07,'1d':0.1,'1w':0.18 }[tf] || 0.015;
  const maxSlDist = entry * slPctMax;
  const finalSlDist = Math.min(slDist, maxSlDist);
  // SL'yi yeniden hesapla (sınırlandıysa)
  const finalSl = sig.dir === 'LONG' ? entry - finalSlDist : entry + finalSlDist;

  // TP: R/R oranına göre (1:1.5, 1:2.5, 1:4)
  const tp1 = sig.dir === 'LONG' ? entry + finalSlDist * 1.5 : entry - finalSlDist * 1.5;
  const tp2 = sig.dir === 'LONG' ? entry + finalSlDist * 2.5 : entry - finalSlDist * 2.5;
  const tp3 = sig.dir === 'LONG' ? entry + finalSlDist * 4   : entry - finalSlDist * 4;

  // ── ULAŞILABİLİRLİK KONTROLÜ ──
  // Giriş bölgesi şu anki fiyata ne kadar uzak? Çok uzaksa sinyal geçersiz.
  // (örn: fiyat $1, giriş $2 ise → fiyat oraya gelmeyebilir, sinyal verme)
  let distToZone;
  if (sig.dir === 'LONG') {
    // Fiyat giriş bölgesinin üstündeyse, düşmesi gerekir; bölge zaten altında
    distToZone = price > entryZoneHigh ? (price - entryZoneHigh) / price * 100 : 0;
  } else {
    // SHORT: fiyat bölgenin altındaysa yükselmesi gerekir
    distToZone = price < entryZoneLow ? (entryZoneLow - price) / price * 100 : 0;
  }
  // TF'ye göre max ulaşılabilir mesafe (kısa TF'de fiyat az hareket eder)
  const maxReach = { '1m':0.6,'3m':0.9,'5m':1.2,'15m':2,'30m':3,'1h':4,'2h':6,'4h':9,'1d':15,'1w':30 }[tf] || 2;
  // Fiyat zaten bölgenin içinde mi? (hemen girilebilir)
  const inZone = price >= entryZoneLow && price <= entryZoneHigh;
  // Ulaşılabilir mi: ya bölgede ya da makul mesafede
  const reachable = inZone || distToZone <= maxReach;

  // ── KALDIRAÇ ÖNERİSİ ──
  // Mantık: Pozisyon başına bakiyenin max %X'i riske edilir (varsayılan %2).
  // Kaldıraç = hedef risk / SL yüzdesi. Dar SL → yüksek kaldıraç olabilir ama güvenli sınır koyarız.
  const slPctVal = finalSlDist / entry * 100;
  const RISK_PER_TRADE = 2;        // bakiyenin %2'si riske edilir
  // Ham kaldıraç: SL %1 ise 2x risk için 2x kaldıraç; SL %0.5 ise 4x...
  let rawLev = slPctVal > 0 ? RISK_PER_TRADE / slPctVal : 1;
  // Scalp için güvenli kaldıraç aralığı (TF'ye göre tavan)
  const levCap = { '1m':20,'3m':18,'5m':15,'15m':12,'30m':10,'1h':8,'2h':6,'4h':5,'1d':3,'1w':2 }[tf] || 10;
  let leverage = Math.max(1, Math.min(levCap, Math.round(rawLev)));
  // Güven düşükse kaldıracı azalt
  if (sig.confidence < 75) leverage = Math.max(1, Math.round(leverage * 0.7));
  // Likidasyon mesafesi tahmini (kaldıraçlı, ~%100/lev)
  const liqDistPct = 100 / leverage;
  // SL likidasyondan önce mi? (güvenli olmalı)
  const slSafe = slPctVal < liqDistPct * 0.8;

  return {
    entry, sl: finalSl, tp1, tp2, tp3,
    entryZoneLow, entryZoneHigh,
    slDist: finalSlDist, slPct: slPctVal,
    distToZone, maxReach, inZone, reachable,
    leverage, riskPerTrade: RISK_PER_TRADE, liqDistPct, slSafe,
  };
}

// ── BACKTEST ──
function backtestScalp(bars, tfId) {
  if (bars.length < 60) return null;
  let wins = 0, losses = 0, totalPnl = 0;
  for (let i = 50; i < bars.length - 10; i++) {
    const window = bars.slice(0, i + 1);
    const sig = calcScalpSignal(window, bars[i].c);
    if (!sig || sig.confidence < 60) continue;
    const lv = calcEntryLevels(sig, bars[i].c, tfId);
    const entry = lv.entry;
    const sl = lv.sl;
    const tp = lv.tp2; // TP2 hedefle (2.5:1)
    let outcome = null;
    for (let j = i + 1; j < Math.min(i + 12, bars.length); j++) {
      const bar = bars[j];
      if (sig.dir === 'LONG') {
        if (bar.l <= sl) { outcome = 'loss'; break; }
        if (bar.h >= tp) { outcome = 'win'; break; }
      } else {
        if (bar.h >= sl) { outcome = 'loss'; break; }
        if (bar.l <= tp) { outcome = 'win'; break; }
      }
    }
    if (outcome === 'win') { wins++; totalPnl += Math.abs(tp - entry) / entry * 100; }
    if (outcome === 'loss') { losses++; totalPnl -= Math.abs(sl - entry) / entry * 100; }
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
// ================================================================
// OKX İŞLEM API (imzalı istekler - gerçek para)
// ================================================================
const OKX_BASE = 'https://www.okx.com';

// OKX V5 imzalı istek
async function okxRequest(method, path, body) {
  const timestamp = new Date().toISOString();
  const bodyStr = body ? JSON.stringify(body) : '';
  const prehash = timestamp + method + path + bodyStr;
  const sign = crypto.createHmac('sha256', OKX_SECRET).update(prehash).digest('base64');

  const headers = {
    'OK-ACCESS-KEY': OKX_API_KEY,
    'OK-ACCESS-SIGN': sign,
    'OK-ACCESS-TIMESTAMP': timestamp,
    'OK-ACCESS-PASSPHRASE': OKX_PASSPHRASE,
    'Content-Type': 'application/json',
  };

  try {
    const r = await fetch(OKX_BASE + path, {
      method,
      headers,
      body: bodyStr || undefined,
    });
    const d = await r.json();
    return d;
  } catch (e) {
    console.error('OKX API hatası:', e.message);
    return { code: 'error', msg: e.message };
  }
}

// Hesap bakiyesi (USDT)
async function getOKXBalance() {
  const d = await okxRequest('GET', '/api/v5/account/balance?ccy=USDT');
  if (d.code !== '0' || !d.data?.[0]?.details?.[0]) return null;
  return parseFloat(d.data[0].details[0].availBal || d.data[0].details[0].cashBal || 0);
}

// Kaldıraç ayarla
async function setOKXLeverage(instId, leverage, mgnMode) {
  const d = await okxRequest('POST', '/api/v5/account/set-leverage', {
    instId, lever: String(leverage), mgnMode: mgnMode || 'isolated',
  });
  return d.code === '0';
}

// Enstrüman bilgisi (lot size, min size) - cache'li
const instrumentCache = {};
async function getInstrumentInfo(instId) {
  if (instrumentCache[instId]) return instrumentCache[instId];
  const d = await okxRequest('GET', `/api/v5/public/instruments?instType=SWAP&instId=${instId}`);
  if (d.code !== '0' || !d.data?.[0]) return null;
  const info = {
    lotSz: parseFloat(d.data[0].lotSz),
    minSz: parseFloat(d.data[0].minSz),
    ctVal: parseFloat(d.data[0].ctVal),
    tickSz: parseFloat(d.data[0].tickSz),
  };
  instrumentCache[instId] = info;
  return info;
}

// Fiyatı tick size'a yuvarla
function roundToTick(price, tickSz) {
  const decimals = (tickSz.toString().split('.')[1] || '').length;
  return parseFloat((Math.round(price / tickSz) * tickSz).toFixed(decimals));
}

// LİMİT EMİR + TP/SL aç
async function openOKXPosition(sym, dir, entry, sl, tp, leverage, balance) {
  const instId = SYMBOL_REGISTRY.okx[sym.toUpperCase()] || (sym.toUpperCase() + '-USDT-SWAP');

  // Enstrüman bilgisi
  const info = await getInstrumentInfo(instId);
  if (!info) return { ok: false, msg: 'Enstrüman bilgisi alınamadı' };

  // Kaldıracı ayarla
  await setOKXLeverage(instId, leverage, TRADE.tdMode);

  // Pozisyon büyüklüğü: risk = bakiye * %2, SL mesafesine göre kontrat sayısı
  const slDistPct = Math.abs(entry - sl) / entry;
  const riskUsd = balance * (TRADE.riskPerTrade / 100);
  // Pozisyon değeri = risk / SL mesafesi (kaldıraçsız nominal)
  const posValueUsd = riskUsd / slDistPct;
  // Kontrat sayısı = pozisyon değeri / (giriş fiyatı * ctVal)
  let contracts = posValueUsd / (entry * info.ctVal);
  // Lot size'a yuvarla
  contracts = Math.floor(contracts / info.lotSz) * info.lotSz;
  if (contracts < info.minSz) contracts = info.minSz;

  const px = roundToTick(entry, info.tickSz);
  const slPx = roundToTick(sl, info.tickSz);
  const tpPx = roundToTick(tp, info.tickSz);
  const side = dir === 'LONG' ? 'buy' : 'sell';
  const posSide = dir === 'LONG' ? 'long' : 'short';

  // Limit emir + bağlı TP/SL (attachAlgoOrds)
  const order = {
    instId,
    tdMode: TRADE.tdMode,
    side,
    posSide,
    ordType: 'limit',
    px: String(px),
    sz: String(contracts),
    attachAlgoOrds: [{
      attachAlgoClOrdId: 'tp' + Date.now(),
      tpTriggerPx: String(tpPx),
      tpOrdPx: '-1',          // -1 = market (TP tetiklenince market sat)
      slTriggerPx: String(slPx),
      slOrdPx: '-1',          // -1 = market (SL tetiklenince market sat)
    }],
  };

  const d = await okxRequest('POST', '/api/v5/trade/order', order);
  if (d.code === '0' && d.data?.[0]?.sCode === '0') {
    return { ok: true, ordId: d.data[0].ordId, contracts, instId, px };
  }
  const errMsg = d.data?.[0]?.sMsg || d.msg || 'Bilinmeyen hata';
  return { ok: false, msg: errMsg };
}

// Günlük zarar limiti kontrolü
async function checkDailyLossLimit() {
  // Gün değiştiyse sıfırla
  if (Date.now() - tradingState.dayStartTime > 24*60*60*1000) {
    tradingState.dayStartBalance = await getOKXBalance();
    tradingState.dayStartTime = Date.now();
    tradingState.realizedPnlToday = 0;
    tradingState.haltedReason = null;
  }
  if (!tradingState.dayStartBalance) {
    tradingState.dayStartBalance = await getOKXBalance();
    return true; // ilk kez, devam
  }
  const cur = await getOKXBalance();
  if (cur === null) return true;
  const lossPct = (tradingState.dayStartBalance - cur) / tradingState.dayStartBalance * 100;
  if (lossPct >= TRADE.dailyLossLimit) {
    tradingState.haltedReason = `Günlük zarar limiti aşıldı (-%${lossPct.toFixed(1)})`;
    return false;
  }
  return true;
}

const SYMBOL_REGISTRY = {
  binance: {},  // { PEPE: "1000PEPEUSDT", BTC: "BTCUSDT", ... }
  bybit:   {},
  okx:     {},
};
let registryLoaded = false;

async function loadSymbolRegistry() {
  console.log('📡 Borsa sembol listeleri yükleniyor...');

  // ── Binance Futures sembolleri (birden fazla domain dener) ──
  const binanceDomains = [
    'https://fapi.binance.com/fapi/v1/exchangeInfo',
    'https://www.binance.com/fapi/v1/exchangeInfo',
    'https://fapi1.binance.com/fapi/v1/exchangeInfo',
  ];
  for (const url of binanceDomains) {
    try {
      const r = await fetch(url);
      if (!r.ok) { console.log(`  ⚠ Binance ${url.split('/')[2]}: HTTP ${r.status}`); continue; }
      const d = await r.json();
      (d.symbols || []).forEach(s => {
        if (s.quoteAsset === 'USDT' && s.status === 'TRADING' && s.contractType === 'PERPETUAL') {
          const base = s.baseAsset.toUpperCase();
          SYMBOL_REGISTRY.binance[base] = s.symbol;
          const clean = base.replace(/^1000+/, '').replace(/^1M/, '');
          if (clean !== base && !SYMBOL_REGISTRY.binance[clean]) {
            SYMBOL_REGISTRY.binance[clean] = s.symbol;
          }
        }
      });
      if (Object.keys(SYMBOL_REGISTRY.binance).length > 0) {
        console.log(`  ✓ Binance: ${Object.keys(SYMBOL_REGISTRY.binance).length} coin`);
        break; // başarılı, diğer domainleri deneme
      }
    } catch (e) { console.log(`  ✗ Binance ${url.split('/')[2]} hatası:`, e.message); }
  }
  if (Object.keys(SYMBOL_REGISTRY.binance).length === 0) {
    console.log('  ✗ Binance: hiç coin yüklenemedi (coğrafi engel olabilir)');
  }

  // ── Bybit sembolleri ──
  try {
    const r = await fetch('https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000');
    if (!r.ok) {
      console.log(`  ⚠ Bybit: HTTP ${r.status}`);
    } else {
      const d = await r.json();
      if (d.retCode !== 0) {
        console.log(`  ⚠ Bybit retCode: ${d.retCode} ${d.retMsg}`);
      } else {
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
  if (SYMBOL_REGISTRY.okx[s])     found.push('OKX');
  if (SYMBOL_REGISTRY.binance[s]) found.push('Binance');
  if (SYMBOL_REGISTRY.bybit[s])   found.push('Bybit');
  return found;
}

async function fetchOHLC(sym, tf) {
  const s = sym.toUpperCase();
  // OKX öncelikli (Railway US West'te Binance/Bybit engelli)
  const okSym = SYMBOL_REGISTRY.okx[s];
  const bnSym = SYMBOL_REGISTRY.binance[s];
  const bySym = SYMBOL_REGISTRY.bybit[s];

  const bars = (okSym && await fetchOKXRaw(okSym, tf))
            || await fetchOKX(s, tf)
            || (bnSym && await fetchBinanceRaw(bnSym, tf))
            || (bySym && await fetchBybitRaw(bySym, tf))
            || await fetchBinance(s, tf)
            || await fetchBybit(s, tf);
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
// OKX'teki TÜM coinlerin 24s hacim + değişim verisini tek istekte çek
async function fetchHotCoins() {
  try {
    const r = await fetch('https://www.okx.com/api/v5/market/tickers?instType=SWAP');
    if (!r.ok) { console.error('OKX tickers HTTP', r.status); return []; }
    const d = await r.json();
    if (d.code !== '0' || !d.data) return [];

    return d.data
      .filter(t => t.instId.endsWith('-USDT-SWAP'))
      .map(t => {
        const last = parseFloat(t.last) || 0;
        const open24 = parseFloat(t.open24h) || last;
        const vol24Usd = parseFloat(t.volCcy24h) * last || 0; // hacmi USD'ye çevir
        const chg24 = open24 > 0 ? ((last - open24) / open24 * 100) : 0;
        return {
          sym: t.instId.replace('-USDT-SWAP', ''),
          instId: t.instId,
          price: last,
          chg24,
          vol: vol24Usd,
          // Scalp skoru: hareket + hacim
          scalpScore: Math.abs(chg24) * 1.5 + (vol24Usd / 1e9) * 0.5,
        };
      })
      .filter(c => c.vol > CONFIG.minScanVolume && c.price > 0);
  } catch (e) {
    console.error('OKX hot coins error:', e.message);
    return [];
  }
}

// ================================================================
// SIGNAL SCANNER
// ================================================================
// ================================================================
// AÇIK POZİSYON TAKİBİ - SL/TP geldiğinde bildirim gönder
// ================================================================
async function monitorPositions() {
  const syms = Object.keys(openPositions);
  if (syms.length === 0) return;

  for (const sym of syms) {
    const pos = openPositions[sym];
    try {
      // Güncel fiyatı çek (1m mum, en güncel)
      const bars = await fetchOHLC(sym, '1m');
      if (!bars || !bars.length) continue;
      const cur = bars[bars.length - 1];
      const price = cur.c;
      const high = cur.h, low = cur.l;
      const f = v => v.toLocaleString('tr-TR', { minimumFractionDigits: pos.dec, maximumFractionDigits: pos.dec });

      let closePos = false;

      // ── GİRİŞ KONTROLÜ: limit emir doldu mu (fiyat giriş bölgesine geldi mi) ──
      if (!pos.filled) {
        let justFilled = false;
        if (pos.dir === 'LONG') {
          // LONG: fiyat giriş bölgesine indi mi (limit alım dolar)
          if (low <= pos.entryZoneHigh) justFilled = true;
        } else {
          // SHORT: fiyat giriş bölgesine çıktı mı (limit satım dolar)
          if (high >= pos.entryZoneLow) justFilled = true;
        }
        if (justFilled) {
          pos.filled = true;
          await sendTelegram(
            `✅ <b>GİRİŞ YAPILDI — ${sym} ${pos.dir}</b>\n\n` +
            `📍 Giriş: $${f(pos.entry)}\n` +
            `🛑 SL: $${f(pos.sl)}\n` +
            `🎯 TP1: $${f(pos.tp1)} · TP2: $${f(pos.tp2)} · TP3: $${f(pos.tp3)}\n` +
            `⚡ Kaldıraç: ${pos.leverage}x\n\n` +
            `Pozisyon açık, takip ediliyor.`
          );
        } else {
          // Henüz giriş yok → TP/SL kontrolü YAPMA, sadece zaman aşımı kontrol et
          if (Date.now() - pos.openTime > 24*60*60*1000) {
            delete openPositions[sym];
            console.log(`${sym} giriş bölgesine 24s gelmedi, sinyal iptal edildi`);
          }
          continue; // giriş olmadan TP/SL bildirimi verme
        }
      }

      if (pos.dir === 'LONG') {
        // SL kontrolü (fiyat SL'in altına indi mi)
        if (low <= pos.sl) {
          await sendTelegram(
            `🛑 <b>SL OLDU — ${sym} LONG</b>\n\n` +
            `Giriş: $${f(pos.entry)}\n` +
            `SL: $${f(pos.sl)} ✋\n` +
            `Kayıp: ~%${((pos.entry - pos.sl)/pos.entry*100*pos.leverage).toFixed(1)} (${pos.leverage}x)\n\n` +
            `İşlem kapandı. Bu coin için yeni sinyal aranabilir.`
          );
          closePos = true;
        }
        // TP kontrolleri (fiyat TP'lerin üstüne çıktı mı)
        else {
          if (high >= pos.tp3 && !pos.tpHit.includes(3)) {
            pos.tpHit.push(3);
            await sendTelegram(`🎯🎯🎯 <b>TP3 GELDİ — ${sym} LONG</b>\n\nFiyat: $${f(pos.tp3)}\nKâr: ~%${((pos.tp3-pos.entry)/pos.entry*100*pos.leverage).toFixed(1)} (${pos.leverage}x)\n\n✅ Tüm hedefler tamam! Pozisyonu kapatabilirsin.`);
            closePos = true;
          } else if (high >= pos.tp2 && !pos.tpHit.includes(2)) {
            pos.tpHit.push(2);
            await sendTelegram(`🎯🎯 <b>TP2 GELDİ — ${sym} LONG</b>\n\nFiyat: $${f(pos.tp2)}\nKâr: ~%${((pos.tp2-pos.entry)/pos.entry*100*pos.leverage).toFixed(1)} (${pos.leverage}x)\n\n💡 SL'i girişe çek (zarara geçme), TP3 bekle.`);
          } else if (high >= pos.tp1 && !pos.tpHit.includes(1)) {
            pos.tpHit.push(1);
            await sendTelegram(`🎯 <b>TP1 GELDİ — ${sym} LONG</b>\n\nFiyat: $${f(pos.tp1)}\nKâr: ~%${((pos.tp1-pos.entry)/pos.entry*100*pos.leverage).toFixed(1)} (${pos.leverage}x)\n\n💡 Kârın bir kısmını al, SL'i yukarı çek.`);
          }
        }
      } else { // SHORT
        if (high >= pos.sl) {
          await sendTelegram(
            `🛑 <b>SL OLDU — ${sym} SHORT</b>\n\n` +
            `Giriş: $${f(pos.entry)}\n` +
            `SL: $${f(pos.sl)} ✋\n` +
            `Kayıp: ~%${((pos.sl - pos.entry)/pos.entry*100*pos.leverage).toFixed(1)} (${pos.leverage}x)\n\n` +
            `İşlem kapandı. Bu coin için yeni sinyal aranabilir.`
          );
          closePos = true;
        } else {
          if (low <= pos.tp3 && !pos.tpHit.includes(3)) {
            pos.tpHit.push(3);
            await sendTelegram(`🎯🎯🎯 <b>TP3 GELDİ — ${sym} SHORT</b>\n\nFiyat: $${f(pos.tp3)}\nKâr: ~%${((pos.entry-pos.tp3)/pos.entry*100*pos.leverage).toFixed(1)} (${pos.leverage}x)\n\n✅ Tüm hedefler tamam! Pozisyonu kapatabilirsin.`);
            closePos = true;
          } else if (low <= pos.tp2 && !pos.tpHit.includes(2)) {
            pos.tpHit.push(2);
            await sendTelegram(`🎯🎯 <b>TP2 GELDİ — ${sym} SHORT</b>\n\nFiyat: $${f(pos.tp2)}\nKâr: ~%${((pos.entry-pos.tp2)/pos.entry*100*pos.leverage).toFixed(1)} (${pos.leverage}x)\n\n💡 SL'i girişe çek, TP3 bekle.`);
          } else if (low <= pos.tp1 && !pos.tpHit.includes(1)) {
            pos.tpHit.push(1);
            await sendTelegram(`🎯 <b>TP1 GELDİ — ${sym} SHORT</b>\n\nFiyat: $${f(pos.tp1)}\nKâr: ~%${((pos.entry-pos.tp1)/pos.entry*100*pos.leverage).toFixed(1)} (${pos.leverage}x)\n\n💡 Kârın bir kısmını al, SL'i aşağı çek.`);
          }
        }
      }

      if (closePos) {
        // ── ÖĞRENME: sonucu kaydet (TP'ye ulaştıysa kazanç, hiç TP yoksa SL=kayıp) ──
        recordOutcome(pos.learnCtx, pos.tpHit.length > 0 ? 'win' : 'loss');
        delete openPositions[sym];
      }
    } catch (e) {
      console.error(`${sym} pozisyon takip hatası:`, e.message);
    }
  }
}

// ================================================================
// SPOT TARAMA — SPOT_COINS listesindeki coinlerde ALIM fırsatı ara
// (Sadece ALIM/LONG; spotta short yok. Kaldıraçsız.)
// ================================================================
async function scanSpotWatchlist() {
  if (!SPOT_COINS.length) return;
  for (const sym of SPOT_COINS) {
    try {
      if (spotPositions[sym]) continue;                 // zaten alımdayız
      const bars = await fetchSpotOHLC(sym, CONFIG.scalpTF);
      if (!bars || bars.length < 30) { console.log(`   spot ${sym}: veri bulunamadı`); continue; }
      const price = bars[bars.length - 1].c;
      const sig = calcScalpSignal(bars, price);
      if (!sig || sig.dir !== 'LONG') continue;          // SPOT: yalnızca ALIM
      if (sig.confidence < CONFIG.minConfidence) continue;

      const key = 'SPOT' + sym; const now = Date.now();
      if (alarmHistory[key] && now - alarmHistory[key] < CONFIG.dedupeMinutes * 60000) continue;

      const lv = calcEntryLevels(sig, price, CONFIG.scalpTF);
      if (!lv.reachable) continue;
      lv.leverage = 1;                                    // KALDIRAÇSIZ

      // Öğrenme kapısı (spot üst-TF trendiyle) — kötü alımı ele
      const htf = await spotHtfBias(sym).catch(() => null);
      const ctxL = { sym, dir: 'LONG', htf: htfBucket(htf), ct: isCounterTrend('LONG', htf), conf: sig.confidence, dist: lv.distToZone || 0, spot: true };
      const blocked = learnBlock(ctxL);
      if (blocked) { console.log(`   🧠 spot ${sym} ALIM atlandı: ${blocked}`); continue; }

      alarmHistory[key] = now;
      const dec = price > 100 ? 2 : price > 1 ? 4 : 6;
      spotPositions[sym] = {
        sym, entry: lv.entry, sl: lv.sl, tp1: lv.tp1, tp2: lv.tp2, tp3: lv.tp3,
        entryZoneLow: lv.entryZoneLow, entryZoneHigh: lv.entryZoneHigh,
        openTime: now, tpHit: [], filled: lv.inZone, dec, learnCtx: ctxL,
      };
      const f = v => v.toLocaleString('tr-TR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
      await sendTelegram(
        `🟢🛒 <b>SPOT ALIM FIRSATI — ${sym}</b> <i>(kaldıraçsız)</i>\n\n` +
        `💰 Anlık fiyat: <b>$${f(price)}</b>\n` +
        `🎯 Güven: <b>%${sig.confidence}</b>\n\n` +
        `<b>📍 Alım bölgesi:</b>\n$${f(lv.entryZoneLow)} — $${f(lv.entryZoneHigh)}\n` +
        `▫️ İdeal alım: $${f(lv.entry)}\n` +
        `🎯 Sat hedefleri: TP1 $${f(lv.tp1)} · TP2 $${f(lv.tp2)} · TP3 $${f(lv.tp3)}\n` +
        `🛑 Zarar durdur (sat): $${f(lv.sl)} (${lv.slPct.toFixed(2)}%)\n\n` +
        `<b>Sinyaller:</b>\n${sig.signals.slice(0, 4).map(s => '• ' + s).join('\n')}\n\n` +
        `${lv.inZone ? '🟢 <i>Fiyat şu an alım bölgesinde.</i>' : `🟡 <i>Alım bölgesine ${lv.distToZone.toFixed(2)}% uzakta. Limit alım koy.</i>`}\n` +
        `⚠️ <i>Spot alım — kaldıraç yok. Yatırım tavsiyesi değildir.</i>`
      );
      console.log(new Date().toLocaleTimeString('tr-TR'), `- 🛒 SPOT ALIM: ${sym} %${sig.confidence}`);
      await new Promise(r => setTimeout(r, 800));
    } catch (e) { console.error(`spot ${sym} hata:`, e.message); }
  }
}

// SPOT pozisyon takibi — alım dolunca + satış (TP/zarar durdur/aşırı alım) sinyalleri
async function monitorSpotPositions() {
  const syms = Object.keys(spotPositions);
  for (const sym of syms) {
    const pos = spotPositions[sym];
    try {
      const bars = await fetchSpotOHLC(sym, '5m');
      if (!bars || !bars.length) continue;
      const cur = bars[bars.length - 1]; const price = cur.c, high = cur.h, low = cur.l;
      const f = v => v.toLocaleString('tr-TR', { minimumFractionDigits: pos.dec, maximumFractionDigits: pos.dec });

      // ALIM (limit) doldu mu
      if (!pos.filled) {
        if (low <= pos.entryZoneHigh) {
          pos.filled = true;
          await sendTelegram(`✅ <b>ALIM YAPILDI — ${sym}</b>\n\nGiriş: $${f(pos.entry)}\n🎯 Sat: TP1 $${f(pos.tp1)} · TP2 $${f(pos.tp2)} · TP3 $${f(pos.tp3)}\n🛑 Zarar durdur: $${f(pos.sl)}\n\nTakip ediliyor.`);
        } else {
          if (Date.now() - pos.openTime > 24 * 3600 * 1000) { delete spotPositions[sym]; console.log(`spot ${sym}: 24s alım bölgesine gelmedi, iptal`); }
          continue;
        }
      }

      let close = false, result = null;
      if (low <= pos.sl) {
        // Zarar durdur → SAT
        await sendTelegram(`🔴 <b>SATIŞ SİNYALİ (zarar durdur) — ${sym}</b>\n\nAlım: $${f(pos.entry)}\nSatış: $${f(pos.sl)}\nZarar: ~%${((pos.entry - pos.sl) / pos.entry * 100).toFixed(1)}\n\nPozisyon kapandı.`);
        close = true; result = pos.tpHit.length > 0 ? 'win' : 'loss';
      } else {
        if (high >= pos.tp3 && !pos.tpHit.includes(3)) {
          pos.tpHit.push(3);
          await sendTelegram(`🎯🎯🎯 <b>SATIŞ SİNYALİ — ${sym} TP3</b>\n\nFiyat: $${f(pos.tp3)}\nKâr: ~%${((pos.tp3 - pos.entry) / pos.entry * 100).toFixed(1)}\n\n✅ Tüm hedefler tamam — kalanı sat.`);
          close = true; result = 'win';
        } else if (high >= pos.tp2 && !pos.tpHit.includes(2)) {
          pos.tpHit.push(2);
          await sendTelegram(`🎯🎯 <b>SATIŞ SİNYALİ — ${sym} TP2</b>\n\nFiyat: $${f(pos.tp2)}\nKâr: ~%${((pos.tp2 - pos.entry) / pos.entry * 100).toFixed(1)}\n\n💡 Bir kısmını sat, zarar durdur girişe.`);
        } else if (high >= pos.tp1 && !pos.tpHit.includes(1)) {
          pos.tpHit.push(1);
          await sendTelegram(`🎯 <b>SATIŞ SİNYALİ — ${sym} TP1</b>\n\nFiyat: $${f(pos.tp1)}\nKâr: ~%${((pos.tp1 - pos.entry) / pos.entry * 100).toFixed(1)}\n\n💡 Kârın bir kısmını sat.`);
        }
        // Aşırı alım uyarısı (RSI çok yüksek) — kâr aldıysan sat
        if (!close && pos.filled && !pos.warnedRsi) {
          const c = bars.map(x => x.c); const rs = rsiArr(c, 14); const rsi = rs[rs.length - 1] || 50;
          if (rsi > 78) { pos.warnedRsi = true; await sendTelegram(`⚠️ <b>${sym}</b> RSI aşırı alımda (${Math.round(rsi)}). Kârda satmayı düşün — dönüş yakın olabilir.`); }
        }
      }
      if (close) { recordOutcome(pos.learnCtx, result || 'loss'); delete spotPositions[sym]; }
    } catch (e) { console.error(`spot takip ${sym} hata:`, e.message); }
  }
}

async function scanForSignals() {
  const coins = await fetchHotCoins();
  if (!coins.length) {
    console.log(new Date().toLocaleTimeString('tr-TR'), '- Coin verisi alınamadı');
    return;
  }

  // Hacim + hareket olan coinleri scalp skoruna göre sırala, en iyi N tanesini detaylı tara
  const candidates = coins
    .sort((a, b) => b.scalpScore - a.scalpScore)
    .slice(0, CONFIG.scanMaxDetailed);

  console.log(new Date().toLocaleTimeString('tr-TR'), `- ${coins.length} coin hacim filtresinden geçti, ${candidates.length} tanesi detaylı taranıyor...`);
  let found = 0;
  // Teşhis sayaçları - neden sinyal verilmediğini görmek için
  let noData = 0, lowConf = 0, deduped = 0, btFail = 0, scanned = 0, unreachable = 0, hasOpen = 0, learnSkip = 0;
  let bestSeen = { sym: null, conf: 0 };

  for (const coin of candidates) {
    try {
      const bars = await fetchOHLC(coin.sym, CONFIG.scalpTF);
      if (!bars || bars.length < 30) { noData++; continue; }
      scanned++;

      const sig = calcScalpSignal(bars, coin.price);
      if (!sig) { noData++; continue; }

      // En yüksek güveni takip et (teşhis için)
      if (sig.confidence > bestSeen.conf) bestSeen = { sym: coin.sym, conf: sig.confidence, dir: sig.dir };

      if (sig.confidence < CONFIG.minConfidence) { lowConf++; continue; }

      // Dedupe
      const key = coin.sym + sig.dir;
      const now = Date.now();
      if (alarmHistory[key] && now - alarmHistory[key] < CONFIG.dedupeMinutes * 60000) { deduped++; continue; }

      // Backtest filter
      const bt = backtestScalp(bars, CONFIG.scalpTF);
      if (CONFIG.requireBacktest && bt) {
        if (!bt.profitable || parseFloat(bt.winRate) < CONFIG.minWinRate || bt.total < CONFIG.minBacktestTrades) {
          btFail++; continue;
        }
      }

      // Akıllı giriş/SL/TP (dönüş seviyelerine göre)
      const price = coin.price;
      const lv = calcEntryLevels(sig, price, CONFIG.scalpTF);

      // ULAŞILABİLİRLİK: giriş bölgesi fiyata çok uzaksa sinyal verme
      if (!lv.reachable) { unreachable++; continue; }

      // AÇIK POZİSYON KONTROLÜ: bu coinde zaten açık pozisyon varsa yeni sinyal verme
      if (openPositions[coin.sym]) { hasOpen++; continue; }

      // ── ÖĞRENME KAPISI: daha az SL için trend/geçmiş filtreleri ──
      const htf = await getMultiTFBias(coin.sym).catch(() => null);
      const ctxL = {
        sym: coin.sym, dir: sig.dir, htf: htfBucket(htf),
        ct: isCounterTrend(sig.dir, htf), conf: sig.confidence, dist: lv.distToZone || 0,
      };
      const blocked = learnBlock(ctxL);
      if (blocked) { learnSkip++; console.log(`   🧠 ${coin.sym} ${sig.dir} atlandı: ${blocked}`); continue; }

      alarmHistory[key] = now;
      found++;

      // Pozisyonu kaydet (takip için)
      openPositions[coin.sym] = {
        sym: coin.sym, dir: sig.dir,
        entry: lv.entry, sl: lv.sl, tp1: lv.tp1, tp2: lv.tp2, tp3: lv.tp3,
        entryZoneLow: lv.entryZoneLow, entryZoneHigh: lv.entryZoneHigh,
        leverage: lv.leverage, openTime: Date.now(), tpHit: [],
        filled: lv.inZone,   // fiyat zaten bölgedeyse giriş yapıldı say, değilse bekle
        dec: price > 100 ? 2 : price > 1 ? 4 : 6,
        learnCtx: ctxL,      // öğrenme bağlamı (sonuç kaydında kullanılır)
      };

      const dec = price > 100 ? 2 : price > 1 ? 4 : 6;
      const f = v => v.toLocaleString('tr-TR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
      const emoji = sig.dir === 'LONG' ? '🟢⬆️' : '🔴⬇️';
      const zoneLabel = sig.dir === 'LONG' ? 'Destek bölgesinden LONG' : 'Direnç bölgesinden SHORT';
      const btNote = bt && bt.total > 0 ? `\n📊 Backtest: %${bt.winRate} kazanma (${bt.total} işlem, P/L: ${bt.profitable ? '+' : ''}${bt.totalPnl}%)` : '';

      const msg =
`${emoji} <b>${sig.dir} SİNYALİ — ${coin.sym}</b>
🎯 ${zoneLabel}

💰 Anlık fiyat: <b>$${f(price)}</b>
🎯 Güven: <b>%${sig.confidence}</b>
⏱️ Zaman dilimi: ${CONFIG.scalpTF}
📈 24s değişim: ${coin.chg24 >= 0 ? '+' : ''}${coin.chg24.toFixed(2)}%

<b>📍 Giriş Bölgesi (limit emir koy):</b>
$${f(lv.entryZoneLow)} — $${f(lv.entryZoneHigh)}
▫️ İdeal giriş: $${f(lv.entry)}
🛑 SL: $${f(lv.sl)} (${lv.slPct.toFixed(2)}%)
✅ TP1: $${f(lv.tp1)}
✅ TP2: $${f(lv.tp2)}
✅ TP3: $${f(lv.tp3)}

<b>⚡ Önerilen Kaldıraç: ${lv.leverage}x</b>
<i>(Bakiyenin %${lv.riskPerTrade}'si risk · SL'de ~%${(lv.slPct*lv.leverage).toFixed(1)} kayıp)</i>

<b>Sinyaller:</b>
${sig.signals.slice(0, 5).map(s => '• ' + s).join('\n')}${btNote}

${lv.inZone ? '🟢 <i>Fiyat şu an giriş bölgesinde - hemen girilebilir.</i>' : `🟡 <i>Fiyat giriş bölgesine ${lv.distToZone.toFixed(2)}% uzakta. Limit emir koy, fiyat gelince otomatik girer.</i>`}
💡 <i>SL ${sig.dir === 'LONG' ? 'desteğin altında' : 'direncin üstünde'} - kolay vurmaz.</i>
⚠️ <i>Yatırım tavsiyesi değildir.</i>`;

      await sendTelegram(msg);
      console.log(new Date().toLocaleTimeString('tr-TR'), `- ✅ Sinyal gönderildi: ${coin.sym} ${sig.dir} %${sig.confidence}`);

      // ── GERÇEK İŞLEM AÇ (LIVE_TRADING=true ise) ──
      if (TRADE.live && tradingState.enabled && !tradingState.haltedReason) {
        // Günlük zarar limiti kontrolü
        const canTrade = await checkDailyLossLimit();
        if (!canTrade) {
          await sendTelegram(`🛑 <b>İŞLEM DURDURULDU</b>\n${tradingState.haltedReason}\nBot bugün yeni işlem açmayacak. Yarın sıfırlanır veya /islembaslat ile aç.`);
        } else {
          const balance = await getOKXBalance();
          if (!balance || balance < 5) {
            await sendTelegram(`⚠️ <b>${coin.sym}</b> işlem açılamadı: yetersiz bakiye ($${balance || 0}).`);
          } else {
            const result = await openOKXPosition(coin.sym, sig.dir, lv.entry, lv.sl, lv.tp2, lv.leverage, balance);
            if (result.ok) {
              openPositions[coin.sym].okxOrdId = result.ordId;
              openPositions[coin.sym].contracts = result.contracts;
              openPositions[coin.sym].live = true;
              await sendTelegram(
                `✅ <b>GERÇEK İŞLEM AÇILDI — ${coin.sym} ${sig.dir}</b>\n\n` +
                `📍 Limit emir: $${f(result.px)}\n` +
                `📦 Kontrat: ${result.contracts}\n` +
                `⚡ Kaldıraç: ${lv.leverage}x\n` +
                `🛑 SL ve 🎯 TP otomatik kuruldu.\n` +
                `💰 Risk: bakiyenin %${TRADE.riskPerTrade}'si\n\n` +
                `Fiyat giriş seviyesine gelince emir dolacak.`
              );
              console.log(`💰 GERÇEK İŞLEM: ${coin.sym} ${sig.dir} ${result.contracts} kontrat @ ${result.px}`);
            } else {
              await sendTelegram(`⚠️ <b>${coin.sym}</b> işlem açılamadı: ${result.msg}`);
              console.error(`İşlem hatası ${coin.sym}:`, result.msg);
            }
          }
        }
      }

      // Small delay between messages
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error(`${coin.sym} hata:`, e.message);
    }
  }

  // Detaylı teşhis logu
  console.log(new Date().toLocaleTimeString('tr-TR'),
    `- ✅ Tarama bitti | Tarandı: ${scanned} | Sinyal: ${found} | ` +
    `Düşük güven: ${lowConf} | Backtest: ${btFail} | Uzak: ${unreachable} | Açık poz: ${hasOpen} | Tekrar: ${deduped} | 🧠 Öğrenme: ${learnSkip} | Veri yok: ${noData}`);
  if (found === 0 && bestSeen.sym) {
    console.log(`   ℹ️ En yüksek güven: ${bestSeen.sym} ${bestSeen.dir||''} %${bestSeen.conf} (eşik %${CONFIG.minConfidence}). Uygun fırsat bulunamadı, bu normal.`);
  }
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
// ── Üst zaman dilimi trend analizi (HTF bias) ──
async function getMultiTFBias(sym) {
  const tfsToCheck = ['15m', '1h', '4h', '1d'];
  const trends = {};
  let bullScore = 0, bearScore = 0;
  // Üst TF'ler daha ağırlıklı
  const weights = { '15m': 1, '1h': 2, '4h': 3, '1d': 4 };

  for (const tf of tfsToCheck) {
    const bars = await fetchOHLC(sym, tf);
    if (!bars || bars.length < 22) { trends[tf] = null; continue; }
    const ribbon = calcEMARibbon(bars);
    const sig = calcScalpSignal(bars, bars[bars.length-1].c);
    const dir = sig ? sig.dir : (ribbon && ribbon.trend.includes('YUKSELIS') ? 'LONG' : 'SHORT');
    trends[tf] = { dir, trend: ribbon ? ribbon.trend : '--', conf: sig ? sig.confidence : 0 };
    const w = weights[tf] || 1;
    if (dir === 'LONG') bullScore += w; else bearScore += w;
  }

  const totalW = Object.values(weights).reduce((a,b)=>a+b,0);
  const bullPct = Math.round(bullScore / totalW * 100);
  const dominantBias = bullScore >= bearScore ? 'LONG' : 'SHORT';
  // Uyum: kaç TF aynı yönde
  const aligned = Math.max(bullScore, bearScore) / totalW;

  return { trends, dominantBias, bullPct, bearPct: 100-bullPct, aligned };
}

// ── En uygun scalp TF'sini seç (volatiliteye göre) ──
async function pickBestScalpTF(sym) {
  // Scalp için 1m, 5m, 15m arasından en uygununu seç
  const candidates = ['1m', '5m', '15m'];
  let best = '5m', bestScore = -1;
  const atrInfo = {};

  for (const tf of candidates) {
    const bars = await fetchOHLC(sym, tf);
    if (!bars || bars.length < 15) { atrInfo[tf] = 0; continue; }
    const price = bars[bars.length-1].c;
    const atr = calcATR(bars, 14);
    const atrPct = atr ? (atr / price * 100) : 0;
    atrInfo[tf] = atrPct;

    // İdeal scalp ATR aralıkları (skor ver)
    let score = 0;
    if (tf === '1m')  score = (atrPct >= 0.1 && atrPct <= 0.4) ? 3 : atrPct > 0.4 ? 2 : 1;
    if (tf === '5m')  score = (atrPct >= 0.3 && atrPct <= 0.9) ? 3 : atrPct > 0.9 ? 2 : 1;
    if (tf === '15m') score = (atrPct >= 0.6 && atrPct <= 1.6) ? 3 : atrPct > 1.6 ? 2 : 1;
    if (score > bestScore) { bestScore = score; best = tf; }
  }
  return { best, atrInfo };
}

// ── AKILLI ANALİZ: en uygun scalp TF + tüm TF trend uyumu ──
async function smartAnalyze(symbol) {
  const sym = symbol.toUpperCase().replace('USDT', '').replace('/', '').trim();

  // 1. Üst TF trend analizi
  const bias = await getMultiTFBias(sym);
  // 2. En uygun scalp TF
  const { best: scalpTF, atrInfo } = await pickBestScalpTF(sym);

  // 3. Seçilen scalp TF'de analiz
  let bars = await fetchOHLC(sym, scalpTF);
  let isSpot = false;
  if (!bars || bars.length < 30) {
    // Vadelide yok → SPOT'tan dene (OKX/Bybit/Binance spot + DEX)
    bars = await fetchSpotOHLC(sym, scalpTF);
    isSpot = true;
    if (!bars || bars.length < 30) {
      return `❌ <b>${sym}</b> için veri bulunamadı.\n\n` +
        `Vadeli VE spot piyasalarda (OKX/Bybit/Binance/MEXC/KuCoin/Gate + DEX otomatik arama) bulunamadı.\n` +
        `• Coin ismini kontrol et\n• /list ile mevcut coinleri gör\n` +
        `• DEX coini ise Railway'de DEX_POOLS değişkenine havuz ekle`;
    }
    // Üst-TF trendini SPOT verisiyle yeniden hesapla (vadeli verisi yok)
    for (const tf of ['15m','1h','4h','1d']) {
      const sb = await fetchSpotOHLC(sym, tf);
      if (!sb || sb.length < 22) { bias.trends[tf] = null; continue; }
      const c = sb.map(x => x.c); const e9s = ema(c, 9), e21s = ema(c, 21);
      bias.trends[tf] = { dir: e9s >= e21s ? 'LONG' : 'SHORT', trend: '--', conf: 0 };
    }
    const sw = { '15m':1,'1h':2,'4h':3,'1d':4 }; let bs = 0, tot2 = 0;
    for (const tf in sw) { const t = bias.trends[tf]; if (!t) continue; tot2 += sw[tf]; if (t.dir === 'LONG') bs += sw[tf]; }
    bias.bullPct = tot2 ? Math.round(bs / tot2 * 100) : 50;
    bias.bearPct = 100 - bias.bullPct;
    bias.dominantBias = bias.bullPct >= 50 ? 'LONG' : 'SHORT';
    bias.aligned = tot2 ? Math.max(bs, tot2 - bs) / tot2 : 0;
  }

  const price = bars[bars.length-1].c;
  const sig = calcScalpSignal(bars, price);
  const bt  = backtestScalp(bars, scalpTF);
  if (!sig) return `❌ <b>${sym}</b> analiz edilemedi.`;

  const dec = price > 100 ? 2 : price > 1 ? 4 : 6;
  const f = v => v.toLocaleString('tr-TR', { minimumFractionDigits: dec, maximumFractionDigits: dec });

  // Scalp yönü ile üst TF trendi uyumlu mu?
  const aligned = sig.dir === bias.dominantBias;
  const alignWarn = aligned
    ? '✅ Scalp yönü üst zaman dilimleriyle UYUMLU'
    : '⚠️ DİKKAT: Scalp yönü üst trende TERS — riskli';

  // Üst TF güvenini scalp güvenine kat
  let finalConf = sig.confidence;
  if (aligned) finalConf = Math.min(100, Math.round(finalConf * 0.6 + bias.aligned * 100 * 0.4));
  else finalConf = Math.round(finalConf * 0.5); // ters trendde güveni düşür

  // Akıllı giriş/SL/TP (dönüş seviyelerine göre)
  const lv = calcEntryLevels(sig, price, scalpTF);
  const entry = lv.entry, sl = lv.sl, tp1 = lv.tp1, tp2 = lv.tp2, tp3 = lv.tp3;
  const slDist = lv.slDist;

  const dirEmoji = sig.dir === 'LONG' ? '🟢⬆️' : '🔴⬇️';
  const confEmoji = finalConf >= 75 ? '🔥' : finalConf >= 60 ? '✅' : '⚠️';
  const flow = sig.orderFlow;

  // Üst TF trend özeti
  const tfLabel = { '15m':'15dk','1h':'1sa','4h':'4sa','1d':'1gün' };
  const trendSummary = ['15m','1h','4h','1d'].map(tf => {
    const t = bias.trends[tf];
    if (!t) return `${tfLabel[tf]}: --`;
    const arrow = t.dir === 'LONG' ? '🟢' : '🔴';
    return `${tfLabel[tf]}: ${arrow}`;
  }).join('  ');

  const btNote = bt && bt.total > 0
    ? `\n📊 <b>Backtest (${scalpTF}):</b> %${bt.winRate} (${bt.total} işlem, ${bt.profitable?'+':''}${bt.totalPnl}%)`
    : '';

  let recommendation;
  if (finalConf >= 75 && aligned) recommendation = `${confEmoji} <b>GÜÇLÜ ${sig.dir}</b> — Giriş için uygun`;
  else if (finalConf >= 60 && aligned) recommendation = `${confEmoji} <b>ORTA ${sig.dir}</b> — Teyit bekle`;
  else if (!aligned) recommendation = `${confEmoji} <b>ZAYIF</b> — Üst trende ters, bekle`;
  else recommendation = `${confEmoji} <b>NÖTR</b> — Net giriş yok`;

  return `${dirEmoji} <b>${sym} AKILLI ANALİZ</b>${isSpot ? ' 🛒 <i>(SPOT — vadelide yok, kaldıraçsız)</i>' : ''}
🎯 Önerilen scalp: <b>${scalpTF}</b> (volatiliteye göre seçildi)

💰 Fiyat: <b>$${f(price)}</b>
🎯 Güven: <b>%${finalConf}</b> ${aligned ? '' : '(ters trend, düşürüldü)'}
${recommendation}

<b>📊 Tüm Zaman Dilimleri Yönü:</b>
${trendSummary}
Genel eğilim: <b>${bias.dominantBias}</b> (%${bias.bullPct} boğa)
${alignWarn}

<b>📍 Giriş Bölgesi (${sig.dir === 'LONG' ? 'destekten' : 'dirençten'} · ${scalpTF}):</b>
$${f(lv.entryZoneLow)} — $${f(lv.entryZoneHigh)}
▫️ İdeal giriş: $${f(entry)}
${lv.inZone ? '🟢 <b>Fiyat şu an giriş bölgesinde - işleme girilebilir</b>' : lv.reachable ? `🟡 Fiyat giriş bölgesine ${lv.distToZone.toFixed(2)}% uzakta - bekle, gelince gir` : `🔴 <b>Fiyat giriş bölgesine ${lv.distToZone.toFixed(2)}% uzak - bu seviyeye gelmeyebilir, riskli</b>`}
🛑 SL: $${f(sl)} (${lv.slPct.toFixed(2)}%)
✅ TP1: $${f(tp1)}
✅ TP2: $${f(tp2)}
✅ TP3: $${f(tp3)}

${isSpot ? '<b>🛒 SPOT — kaldıraç yok.</b> Yalnızca ALIM yönlü değerlendir; SHORT yapılamaz.' : `<b>⚡ Önerilen Kaldıraç: ${lv.leverage}x</b>\n<i>(Bakiyenin %${lv.riskPerTrade}'si risk · SL'de ~%${(lv.slPct*lv.leverage).toFixed(1)} kayıp)</i>`}

<b>Sinyaller:</b>
${sig.signals.length ? sig.signals.slice(0,4).map(s=>'• '+s).join('\n') : '• Net sinyal yok'}
${flow ? `\n<b>Order Flow:</b> Alım %${flow.buyPct.toFixed(0)} / Satım %${flow.sellPct.toFixed(0)}` : ''}
📈 RSI: ${sig.rsiNow ? sig.rsiNow.toFixed(1) : '--'}${btNote}

⚠️ <i>Yatırım tavsiyesi değildir.</i>`;
}

async function analyzeCoinForCommand(symbol, tf) {
  tf = tf || CONFIG.scalpTF;
  const sym = symbol.toUpperCase().replace('USDT', '').replace('/', '').trim();

  let bars = await fetchOHLC(sym, tf);
  let isSpotData = false;
  if (!bars || bars.length < 30) {
    // Vadelide yok → SPOT'tan dene (OKX/Bybit/Binance spot + tanımlıysa DEX)
    bars = await fetchSpotOHLC(sym, tf);
    isSpotData = true;
  }
  if (!bars || bars.length < 30) {
    return `❌ <b>${sym}</b> için veri bulunamadı.\n\n` +
      `Vadeli VE spot piyasalarda (Binance/Bybit/OKX/MEXC/KuCoin/Gate + DEX otomatik arama) bulunamadı.\n\n` +
      `• Coin ismini kontrol et (örn: BTC, ETH, SOL, DOGE, PEPE)\n` +
      `• USDT ekleme, sadece coin yaz\n` +
      `• Sadece DEX'te işlem gören coin ise Railway'de <code>DEX_POOLS</code> değişkenine havuz ekle (README'de anlatıldı)`;
  }

  const price = bars[bars.length - 1].c;
  const sig = calcScalpSignal(bars, price);
  const bt  = backtestScalp(bars, tf);

  if (!sig) return `❌ <b>${sym}</b> analiz edilemedi.`;

  const dec = price > 100 ? 2 : price > 1 ? 4 : 6;
  const f = v => v.toLocaleString('tr-TR', { minimumFractionDigits: dec, maximumFractionDigits: dec });

  // Akıllı giriş/SL/TP (dönüş seviyelerine göre)
  const lv = calcEntryLevels(sig, price, tf);
  const entry = lv.entry, sl = lv.sl, tp1 = lv.tp1, tp2 = lv.tp2, tp3 = lv.tp3;
  const slDist = lv.slDist;

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

  return `${dirEmoji} <b>${sym} ANALİZ — ${tf}</b>${isSpotData ? ' 🛒 <i>(SPOT — kaldıraçsız)</i>' : ''}

💰 Fiyat: <b>$${f(price)}</b>
🎯 Güven: <b>%${sig.confidence}</b>
${recommendation}

<b>📍 Giriş Bölgesi (${sig.dir === 'LONG' ? 'destekten' : 'dirençten'}):</b>
$${f(lv.entryZoneLow)} — $${f(lv.entryZoneHigh)}
▫️ İdeal giriş: $${f(entry)}
${lv.inZone ? '🟢 <b>Fiyat şu an giriş bölgesinde - işleme girilebilir</b>' : lv.reachable ? `🟡 Fiyat giriş bölgesine ${lv.distToZone.toFixed(2)}% uzakta - bekle, gelince gir` : `🔴 <b>Fiyat giriş bölgesine ${lv.distToZone.toFixed(2)}% uzak - bu seviyeye gelmeyebilir, riskli</b>`}
🛑 SL: $${f(sl)} (${lv.slPct.toFixed(2)}%)
✅ TP1: $${f(tp1)}
✅ TP2: $${f(tp2)}
✅ TP3: $${f(tp3)}

${isSpotData ? '<b>🛒 SPOT — kaldıraç yok.</b> Yalnızca ALIM yönlü değerlendir; SHORT yapılamaz.' : `<b>⚡ Önerilen Kaldıraç: ${lv.leverage}x</b>\n<i>(Bakiyenin %${lv.riskPerTrade}'si risk · SL'de ~%${(lv.slPct*lv.leverage).toFixed(1)} kayıp)</i>`}

<b>Sinyaller:</b>
${sig.signals.length ? sig.signals.slice(0, 5).map(s => '• ' + s).join('\n') : '• Net sinyal yok'}
${flow ? `\n<b>Order Flow:</b> Alım %${flow.buyPct.toFixed(0)} / Satım %${flow.sellPct.toFixed(0)}` : ''}
📈 RSI: ${sig.rsiNow ? sig.rsiNow.toFixed(1) : '--'}${btNote}
🏦 Borsalar: ${isSpotData ? (_lastSpotSource || 'Spot') : exNote}

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
      // /islemdur - otomatik gerçek işlemi durdur
      if (text === '/islemdur' || text === '/dur') {
        tradingState.enabled = false;
        await sendTelegramTo(chatId, '🛑 <b>Otomatik işlem DURDURULDU.</b>\n\nSinyaller gelmeye devam eder ama gerçek işlem açılmaz. Tekrar başlatmak için /islembaslat yaz.');
        continue;
      }
      // /islembaslat - otomatik gerçek işlemi başlat
      if (text === '/islembaslat' || text === '/basla') {
        tradingState.enabled = true;
        tradingState.haltedReason = null;
        const mode = TRADE.live ? 'GERÇEK PARA' : 'sadece sinyal (LIVE_TRADING kapalı)';
        await sendTelegramTo(chatId, `✅ <b>Otomatik işlem BAŞLATILDI.</b>\n\nMod: ${mode}\nRisk: %${TRADE.riskPerTrade}/işlem · Günlük fren: -%${TRADE.dailyLossLimit}`);
        continue;
      }
      // /bakiye - OKX bakiyesini göster
      if (text === '/bakiye' || text === '/balance') {
        if (!OKX_API_KEY) {
          await sendTelegramTo(chatId, '⚠️ OKX API bağlı değil. Bakiye görüntülenemez.');
        } else {
          const bal = await getOKXBalance();
          if (bal === null) await sendTelegramTo(chatId, '⚠️ Bakiye alınamadı. API anahtarlarını kontrol et.');
          else {
            const halt = tradingState.haltedReason ? `\n🛑 ${tradingState.haltedReason}` : '';
            await sendTelegramTo(chatId, `💰 <b>OKX Bakiye:</b> $${bal.toFixed(2)} USDT\n\nİşlem modu: ${TRADE.live ? '🟢 GERÇEK' : '🟡 sinyal'}\nDurum: ${tradingState.enabled ? 'aktif' : 'durduruldu'}${halt}`);
          }
        }
        continue;
      }

      // /positions veya /pozisyonlar - açık pozisyonları göster
      if (text === '/positions' || text === '/pozisyonlar' || text === '/poz') {
        const syms = Object.keys(openPositions);
        if (syms.length === 0) {
          await sendTelegramTo(chatId, '📭 Şu an açık pozisyon yok.\n\nBot yeni fırsat buldukça sinyal gönderecek.');
        } else {
          let msg = `📊 <b>Açık Pozisyonlar (${syms.length})</b>\n\n`;
          for (const sym of syms) {
            const p = openPositions[sym];
            const f = v => v.toLocaleString('tr-TR', { minimumFractionDigits: p.dec, maximumFractionDigits: p.dec });
            const emoji = p.dir === 'LONG' ? '🟢' : '🔴';
            const tpStatus = [1,2,3].map(n => p.tpHit.includes(n) ? `TP${n}✅` : `TP${n}`).join(' ');
            const mins = Math.round((Date.now() - p.openTime) / 60000);
            const durum = p.filled ? '🟢 AÇIK' : '⏳ giriş bekliyor';
            msg += `${emoji} <b>${sym} ${p.dir}</b> (${p.leverage}x) — ${durum}\n`;
            if (p.filled) {
              msg += `   Giriş: $${f(p.entry)} · SL: $${f(p.sl)}\n`;
              msg += `   ${tpStatus} · ${mins}dk önce\n\n`;
            } else {
              msg += `   Giriş bölgesi: $${f(p.entryZoneLow)} - $${f(p.entryZoneHigh)}\n`;
              msg += `   Fiyat gelince açılacak · ${mins}dk önce\n\n`;
            }
          }
          msg += `Kapatmak için: <code>/kapat ${syms[0]}</code>`;
          await sendTelegramTo(chatId, msg);
        }
        continue;
      }

      // /kapat COIN - pozisyonu manuel kapat (takipten çıkar)
      if (text.toLowerCase().startsWith('/kapat ')) {
        const sym = text.split(/\s+/)[1]?.toUpperCase();
        if (sym && openPositions[sym]) {
          delete openPositions[sym];
          await sendTelegramTo(chatId, `✅ <b>${sym}</b> pozisyonu takipten çıkarıldı. Artık yeni sinyal verilebilir.`);
        } else {
          await sendTelegramTo(chatId, `❓ <b>${sym || '?'}</b> için açık pozisyon yok. Açık olanları görmek için /positions yaz.`);
        }
        continue;
      }

      if (text === '/coins') {
        const okxCount = Object.keys(SYMBOL_REGISTRY.okx).length;
        const bnCount  = Object.keys(SYMBOL_REGISTRY.binance).length;
        const byCount  = Object.keys(SYMBOL_REGISTRY.bybit).length;
        const total = new Set([
          ...Object.keys(SYMBOL_REGISTRY.binance),
          ...Object.keys(SYMBOL_REGISTRY.bybit),
          ...Object.keys(SYMBOL_REGISTRY.okx),
        ]).size;
        let msg = `🏦 <b>Analiz Edilebilen Coinler</b>\n\n`;
        msg += `✅ OKX: <b>${okxCount}</b> coin (aktif)\n`;
        if (bnCount > 0) msg += `✅ Binance: ${bnCount} coin\n`;
        if (byCount > 0) msg += `✅ Bybit: ${byCount} coin\n`;
        msg += `\n📊 Toplam <b>${total}</b> farklı coin analiz edilebilir.\n\n`;
        msg += `Herhangi birinin ismini yaz, örn:\n<code>BTC</code> · <code>ETH 1h</code> · <code>SOL 5m 15m 1h</code>`;
        await sendTelegramTo(chatId, msg);
        continue;
      }

      // /ogrenme komutu - botun öğrendikleri (SL azaltma)
      if (text === '/ogrenme' || text === '/ogren' || text === '/learn') {
        await sendTelegramTo(chatId, learnSummary());
        continue;
      }

      // /spot komutu - spot izleme listesi + açık spot pozisyonları
      if (text === '/spot') {
        let m = '🛒 <b>SPOT (kaldıraçsız) izleme</b>\n\n';
        m += SPOT_COINS.length ? ('İzlenen: ' + SPOT_COINS.join(', ') + '\n\n') : 'Liste boş. Railway → Variables → <code>SPOT_COINS</code>=PONKE,WIF,BONK ekle.\n\n';
        const open = Object.values(spotPositions);
        if (open.length) {
          m += '<b>Açık spot pozisyonlar:</b>\n';
          open.forEach(p => { m += `• ${p.sym} — giriş $${p.entry} ${p.filled ? '(alındı)' : '(bekliyor)'} · TP alınan: ${p.tpHit.join(',') || '-'}\n`; });
        } else m += 'Açık spot pozisyon yok.';
        await sendTelegramTo(chatId, m);
        continue;
      }

      // /list komutu - mevcut coinlerden örnekler göster
      if (text === '/list') {
        const coins = Object.keys(SYMBOL_REGISTRY.okx).sort();
        const sample = coins.slice(0, 60).join(', ');
        await sendTelegramTo(chatId,
          `📋 <b>Mevcut Coinler (ilk 60)</b>\n\n` +
          `<code>${sample}</code>\n\n` +
          `...ve ${coins.length - 60} tane daha. Toplam ${coins.length} coin.\n\n` +
          `Listede olmayan bir coin de deneyebilirsin, belki vardır!`
        );
        continue;
      }

      // /start veya /help komutu
      if (text === '/start' || text === '/help') {
        await sendTelegramTo(chatId,
          '🤖 <b>CryptoPro Bot Komutları</b>\n\n' +
          '📊 <b>Akıllı analiz (önerilen):</b>\n' +
          'Sadece coin ismini yaz: <code>BTC</code>\n' +
          '→ En uygun scalp zaman dilimini otomatik seçer\n' +
          '→ Tüm zaman dilimlerinin trendine bakar\n' +
          '→ Üst trende ters sinyal verirse uyarır\n\n' +
          '⏱️ <b>Zaman dilimi seçmek için:</b>\n' +
          '<code>BTC 5m</code> — tek zaman dilimi\n' +
          '<code>BTC 5m 1h 4h</code> — birden fazla (max 5)\n\n' +
          '<b>Kullanılabilir zaman dilimleri:</b>\n' +
          '1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 1d, 1w\n\n' +
          '📋 <code>/coins</code> — kaç coin var gör\n' +
          '📜 <code>/list</code> — mevcut coinleri listele\n' +
          '🧠 <code>/ogrenme</code> — bot ne öğrendi (SL azaltma)\n' +
          '🛒 <code>/spot</code> — spot (kaldıraçsız) izleme listesi\n' +
          '📊 <code>/positions</code> — açık pozisyonları gör\n' +
          '✖️ <code>/kapat BTC</code> — pozisyonu takipten çıkar\n' +
          '💰 <code>/bakiye</code> — OKX bakiyeni gör\n' +
          '🛑 <code>/islemdur</code> — otomatik işlemi durdur\n' +
          '✅ <code>/islembaslat</code> — otomatik işlemi başlat\n\n' +
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

      // Yazılan TF'leri topla
      let tfs = parts.slice(1).filter(p => VALID_TFS.includes(p.toLowerCase())).map(p => p.toLowerCase());

      if (tfs.length === 0) {
        // TF YAZILMADI → akıllı analiz (en uygun scalp TF + tüm TF trend uyumu)
        await sendTelegramTo(chatId, `⏳ <b>${coinSym.toUpperCase()}</b> akıllı analiz ediliyor (tüm zaman dilimleri taranıyor)...`);
        const analysis = await smartAnalyze(coinSym);
        await sendTelegramTo(chatId, analysis);
        console.log(new Date().toLocaleTimeString('tr-TR'), `- Akıllı analiz: ${coinSym} → ${chatId}`);
      } else {
        // TF YAZILDI → o spesifik TF(ler)de analiz
        if (tfs.length > 5) tfs = tfs.slice(0, 5);
        await sendTelegramTo(chatId, `⏳ <b>${coinSym.toUpperCase()}</b> analiz ediliyor (${tfs.join(', ')})...`);
        for (const tf of tfs) {
          const analysis = await analyzeCoinForCommand(coinSym, tf);
          await sendTelegramTo(chatId, analysis);
          await new Promise(r => setTimeout(r, 400));
        }
        console.log(new Date().toLocaleTimeString('tr-TR'), `- Komut: ${coinSym} [${tfs.join(',')}] → ${chatId}`);
      }
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
  console.log(`Ayarlar: Min güven %${CONFIG.minConfidence}, ${CONFIG.scalpTF} TF, ${CONFIG.scanInterval / 60000}dk tarama, max ${CONFIG.scanMaxDetailed} coin`);

  // Test Telegram connection
  const ok = await sendTelegram(
    '🤖 <b>CryptoPro Bot Aktif!</b>\n\n' +
    `📡 Her ${CONFIG.scanInterval / 60000} dakikada (5dk mum kapanışı) tüm coinler taranıyor.\n` +
    `🔍 Hacim >$${(CONFIG.minScanVolume/1e6).toFixed(0)}M olan coinlerden en hareketli ${CONFIG.scanMaxDetailed} tanesi analiz ediliyor.\n` +
    `🎯 Min güven: %${CONFIG.minConfidence}\n` +
    `⏱️ Scalp TF: ${CONFIG.scalpTF}\n` +
    `📊 Backtest filtresi: ${CONFIG.requireBacktest ? 'Açık (min %' + CONFIG.minWinRate + ')' : 'Kapalı'}\n\n` +
    '💬 <b>Coin analizi için ismini yaz!</b>\n' +
    'Örn: <code>BTC</code> veya <code>SOL 5m</code>\n\n' +
    'Komutlar için /help yaz.\n\n' +
    `\n${TRADE.live ? '🟢 <b>GERÇEK İŞLEM MODU AKTİF</b>\nSinyallerde otomatik OKX işlemi açılacak.\nRisk: %' + TRADE.riskPerTrade + '/işlem · Günlük fren: -%' + TRADE.dailyLossLimit + '\n/islemdur ile durdurabilirsin.' : '🟡 <b>Sinyal modu</b> (gerçek işlem kapalı)\nGerçek işlem için Railway'+String.fromCharCode(39)+'de LIVE_TRADING=true yap.'}\n\n` +
    'İyi işlemler! 🚀'
  );

  if (!ok) {
    console.error('❌ Telegram bağlantısı başarısız! TG_TOKEN ve TG_CHAT_ID kontrol et.');
    process.exit(1);
  }
  console.log('✅ Telegram bağlantısı başarılı!');

  // Borsa sembollerini yükle (tüm coinler)
  await loadSymbolRegistry();

  // Öğrenme verisini yükle (geçmiş SL/TP sonuçları — daha az SL için)
  loadLearning();

  // First scan immediately
  await scanForSignals();
  if (SPOT_COINS.length) { console.log('🛒 Spot izleme listesi:', SPOT_COINS.join(', ')); await scanSpotWatchlist(); }

  // Then scan periodically
  setInterval(scanForSignals, CONFIG.scanInterval);
  if (SPOT_COINS.length) setInterval(scanSpotWatchlist, CONFIG.scanInterval);

  // Açık pozisyonları her 30 saniyede kontrol et (SL/TP bildirimleri için)
  setInterval(monitorPositions, 30000);
  if (SPOT_COINS.length) setInterval(monitorSpotPositions, 30000);
  console.log('📍 Pozisyon takibi aktif - SL/TP geldiğinde bildirim gelecek');

  // Komut dinleme döngüsü (sürekli)
  console.log('💬 Komut dinleyici aktif - coin ismi yazarak analiz alabilirsin');
  while (true) {
    await pollCommands();
  }
}

start();
