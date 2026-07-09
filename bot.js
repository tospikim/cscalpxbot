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
  maxOpenPositions: 6,      // ayni anda en fazla 6 gercek pozisyon (0 = limitsiz)
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
  minConfidence:   80,        // Min sinyal güveni (%) — panel kalitesine çekildi (70 çok gevşekti → çok SL)
  minVolume:       50000000,  // (eski - kullanılmıyor)
  scanMaxDetailed: 80,        // Hacim filtresinden sonra kaç coin detaylı taranacak
  minScanVolume:   25000000,  // Tarama için min 24s hacim ($25M) — cansız/manipüle coin eleme
  scanInterval:    300000,    // Tarama sıklığı (ms) = 5 dakika
  dedupeMinutes:   45,        // Aynı coin için tekrar uyarı engeli (dk)
  scalpTF:         '5m',      // Scalp zaman dilimi
  requireBacktest: true,      // Backtest kârlı olmalı mı
  minWinRate:      55,        // Min backtest kazanma oranı (%) — 45 çok düşüktü
  minBacktestTrades: 3,       // Min backtest işlem sayısı
  maxOpenPositions: 6,        // Aynı anda en fazla açık vadeli pozisyon (0 = limitsiz)
  maxNewPerScan:   2,         // Her taramada en fazla yeni sinyal (kalite > miktar)
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
function recordOutcome(ctx, result, extra) {
  if (!ctx) return;
  learnLog.push({ sym: ctx.sym, dir: ctx.dir, htf: ctx.htf, ct: ctx.ct ? 1 : 0, conf: ctx.conf, dist: ctx.dist,
    spot: ctx.spot ? 1 : 0, tp: (extra && extra.tp) || 0, result, t: Date.now() });
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
  // 1) TREND KARŞITI → HER ZAMAN engelle (panelde en sık SL sebebiydi).
  //    Tek istisna: bu kategori KANITLANMIŞ kazançlıysa (≥%55, ≥5 örnek).
  if (ctx.ct) {
    const b = bucketWR(ctx.dir, ctx.htf);
    if (!(b.n >= 5 && b.wr != null && b.wr >= 55)) return 'trend karşıtı (üst TF ters yönde)';
  }
  // 2) Aynı coin+yön yakın zamanda kaybettirdi → tekrar girme
  if (recentLoss(ctx.sym, ctx.dir)) return 'bu coin+yön yakında SL oldu';
  // 3) COIN KARA LİSTESİ: bu coin (yön farketmez) son 12 sonuçta 2+ kez kaybettirdiyse girme
  const last12 = learnLog.slice(-12).filter(e => e.sym === ctx.sym);
  if (last12.filter(e => e.result === 'loss').length >= 2) return 'coin kara listede (son işlemlerde 2+ SL)';
  // 4) Tekrar eden hata özelliği
  const rb = recurringBlock(ctx); if (rb) return rb;
  // 5) Kategori geçmişi zayıf (yeterli örnekle)
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
// ── /istatistik — açılan/kapanan işlem sayıları, kazanç/kayıp dökümü ──
function tradeStats() {
  const total = learnLog.length;
  const wins = learnLog.filter(e => e.result === 'win');
  const losses = learnLog.filter(e => e.result === 'loss');
  const wr = total ? Math.round(wins.length / total * 100) : 0;
  const fut = learnLog.filter(e => !e.spot), spt = learnLog.filter(e => e.spot);
  const fw = fut.filter(e => e.result === 'win').length, sw = spt.filter(e => e.result === 'win').length;
  const tp3 = wins.filter(e => e.tp >= 3).length, tp2 = wins.filter(e => e.tp === 2).length, tp1 = wins.filter(e => e.tp === 1).length;
  // Son 24 saat
  const day = learnLog.filter(e => Date.now() - e.t < 24 * 3600 * 1000);
  const dw = day.filter(e => e.result === 'win').length;
  // Açık işlemler
  const openF = Object.keys(openPositions).length, openS = Object.keys(spotPositions).length;
  const pend = Object.keys(pendingSpotSetups).length;
  // Son 5 kapanan işlem
  let son = '';
  learnLog.slice(-5).reverse().forEach(e => {
    const dt = new Date(e.t).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    son += `${e.result === 'win' ? '✅' : '🛑'} ${e.sym} ${e.dir}${e.spot ? ' (spot)' : ''}${e.tp ? ' TP' + e.tp : ''} · ${dt}\n`;
  });
  return '📊 <b>İŞLEM İSTATİSTİKLERİ</b>\n\n' +
    `<b>Kapanan işlem:</b> ${total}\n` +
    `✅ Kazanan: <b>${wins.length}</b> · 🛑 Kaybeden (SL): <b>${losses.length}</b>\n` +
    `🎯 Başarı oranı: <b>%${wr}</b>\n` +
    (wins.length ? `TP dağılımı: TP1 ${tp1} · TP2 ${tp2} · TP3 ${tp3}\n` : '') +
    `\n<b>Vadeli:</b> ${fut.length} işlem (${fw}✅/${fut.length - fw}🛑${fut.length ? ' · %' + Math.round(fw / fut.length * 100) : ''})\n` +
    `<b>Spot:</b> ${spt.length} işlem (${sw}✅/${spt.length - sw}🛑${spt.length ? ' · %' + Math.round(sw / spt.length * 100) : ''})\n` +
    `\n<b>Son 24 saat:</b> ${day.length} işlem (${dw}✅/${day.length - dw}🛑)\n` +
    `\n<b>Şu an:</b> ${openF} vadeli + ${openS} spot pozisyon açık · ${pend} kurulum bekliyor\n` +
    (son ? `\n<b>Son kapananlar:</b>\n${son}` : '') +
    (total === 0 ? '\n<i>Henüz kapanmış işlem yok — pozisyonlar TP/SL ile kapandıkça burada birikecek.</i>' : '') +
    '\n<i>Not: sayaçlar bu sürümün kurulumundan itibaren tutulur; deploy sıfırlamalarına karşı Volume önerilir (README).</i>';
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

// ── MEXC SPOT PAZARINI OTOMATİK TARA (vadeli tarayıcı gibi) ──
// Tüm MEXC spot coinlerini hacim+hareket ile filtreler, en sıcakları döner.
// Vadelide (OKX/Binance/Bybit) zaten izlenen coinler ATLANIR (çift sinyal olmasın) —
// yani bu tarama, SADECE spotta listeli coinleri (memecoinler vb.) yakalar.
const SPOT_SCAN = { minVol: 3000000, top: 15 };   // min $3M 24s hacim, en iyi 15 (cansiz coin girme)
const _lvrToken = /(3L|3S|5L|5S|2L|2S|4L|4S)$/;
const _stables = new Set(['USDC','TUSD','DAI','FDUSD','USDE','PYUSD','USDD','EURT','USD1']);
async function fetchMexcHotSpot() {
  try {
    const r = await fetch('https://api.mexc.com/api/v3/ticker/24hr');
    const d = await r.json();
    if (!Array.isArray(d)) return [];
    const filtered = d
      .filter(t => t.symbol && t.symbol.endsWith('USDT'))
      .map(t => {
        const base = t.symbol.slice(0, -4);
        return { sym: base, price: +t.lastPrice || 0, chg24: +t.priceChangePercent * 100 || +t.priceChangePercent || 0, vol: +t.quoteVolume || 0 };
      })
      .filter(c => c.price > 0
        && !_lvrToken.test(c.sym) && !_stables.has(c.sym)
        && !SYMBOL_REGISTRY.okx[c.sym] && !SYMBOL_REGISTRY.binance[c.sym] && !SYMBOL_REGISTRY.bybit[c.sym]);  // vadelide varsa atla
    // TÜM evren (ölü çiftler hariç, min $300k hacim) — dönüşümlü tam tarama için sakla
    global._mexcAll = filtered.filter(c => c.vol > 1000000).map(c => c.sym);
    // Sıcak liste (hızlı tepki): min $2M hacim, en hareketli 25
    return filtered.filter(c => c.vol > SPOT_SCAN.minVol)
      .map(c => ({ ...c, score: Math.abs(c.chg24) * 1.5 + (c.vol / 1e9) * 0.5 }))
      .sort((a, b) => b.score - a.score).slice(0, SPOT_SCAN.top).map(c => c.sym);
  } catch (e) { console.error('MEXC spot tarama hatası:', e.message); return []; }
}
let _spotRotIdx = 0;   // dönüşümlü tam-liste imleci (her turda 40 coin, tüm liste sırayla biter ve başa döner)

// SPOT mum verisi: OKX spot → Bybit spot → Binance spot → DEX (GeckoTerminal)
const _spotTf = {
  okx:    { '1m':'1m','5m':'5m','15m':'15m','1h':'1H','4h':'4H','1d':'1D','1w':'1W' },
  bybit:  { '1m':'1','5m':'5','15m':'15','1h':'60','4h':'240','1d':'D','1w':'W' },
  binance:{ '1m':'1m','5m':'5m','15m':'15m','1h':'1h','4h':'4h','1d':'1d','1w':'1w' },
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
    const kuTf = { '1m':'1min','5m':'5min','15m':'15min','1h':'1hour','4h':'4hour','1d':'1day','1w':'1week' }[tf] || '5min';
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
    const gTf = { '1m':'1m','5m':'5m','15m':'15m','1h':'1h','4h':'4h','1d':'1d','1w':'7d' }[tf] || '5m';
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


// ================================================================
// GELİŞMİŞ ANALİZ MODÜLÜ — MA kesişimleri, formasyonlar, arz, haber, grafik
// ================================================================
// EMA SERİSİ (kesişim tespiti için tüm geçmiş değerler)
function emaSeries(vals, p) {
  const out = []; if (!vals.length) return out;
  const k = 2 / (p + 1); let e = vals[0];
  for (let i = 0; i < vals.length; i++) { e = i ? vals[i] * k + e * (1 - k) : vals[0]; out.push(e); }
  return out;
}
// GOLDEN / DEATH CROSS + kısa MA kesişimleri (son 12 mum içinde)
function detectMACross(bars, fast, slow) {
  if (!bars || bars.length < slow + 5) return null;
  const c = bars.map(b => b.c);
  const f = emaSeries(c, fast), s = emaSeries(c, slow);
  for (let i = c.length - 1; i >= Math.max(slow, c.length - 12); i--) {
    if (f[i - 1] <= s[i - 1] && f[i] > s[i]) return { type: 'golden', barsAgo: c.length - 1 - i };
    if (f[i - 1] >= s[i - 1] && f[i] < s[i]) return { type: 'death', barsAgo: c.length - 1 - i };
  }
  return null;
}
// ── KESİŞİM YAKLAŞIYOR tespiti — MA'lar birbirine yakınsıyor, kesişim henüz olmadı ──
// Kesişim fiyatlanmadan ÖNCE erken sinyal verir. golden_soon: hızlı MA alttan yaklaşıyor
// (yakında golden cross → LONG fırsatı), death_soon: üstten yaklaşıyor (SHORT fırsatı).
function detectMAConvergence(bars, fast, slow) {
  if (!bars || bars.length < slow + 8) return null;
  const c = bars.map(b => b.c);
  const f = emaSeries(c, fast), s = emaSeries(c, slow);
  const n = c.length - 1;
  const gap = (i) => (f[i] - s[i]) / s[i] * 100;           // % fark (işaretli)
  const gNow = gap(n), gPrev = gap(n - 3);                  // 3 mum önceki fark
  if (Math.abs(gNow) >= Math.abs(gPrev)) return null;       // yakınsama YOK (açılıyor)
  const esik = slow >= 100 ? 0.45 : 0.25;                   // 50/200 için %0.45, 9/21 için %0.25
  if (Math.abs(gNow) > esik) return null;                   // henüz yeterince yakın değil
  const hiz = (Math.abs(gPrev) - Math.abs(gNow)) / 3;       // mum başına kapanma hızı
  const etaBars = hiz > 0 ? Math.max(1, Math.round(Math.abs(gNow) / hiz)) : 99;
  if (etaBars > 15) return null;                            // çok uzak, sayma
  return { type: gNow < 0 ? 'golden_soon' : 'death_soon', gapPct: Math.abs(gNow), etaBars };
}
// Bir TF'nin tam MA durumu (kesişim + yaklaşma, 50/200 ve 9/21)
function maStatusForTF(bars, tfAd) {
  if (!bars || bars.length < 40) return null;
  const parts = [];
  const big = detectMACross(bars, 50, 200);
  if (big) parts.push(big.type === 'golden' ? `🌟 GOLDEN CROSS (${big.barsAgo} mum önce)` : `💀 DEATH CROSS (${big.barsAgo} mum önce)`);
  else {
    const conv = detectMAConvergence(bars, 50, 200);
    if (conv) parts.push(conv.type === 'golden_soon'
      ? `⏳🌟 Golden Cross YAKLAŞIYOR (fark %${conv.gapPct.toFixed(2)}, ~${conv.etaBars} mum) → erken LONG fırsatı`
      : `⏳💀 Death Cross YAKLAŞIYOR (fark %${conv.gapPct.toFixed(2)}, ~${conv.etaBars} mum) → erken SHORT fırsatı`);
  }
  const sm = detectMACross(bars, 9, 21);
  if (sm) parts.push(sm.type === 'golden' ? `🟢 9↑21 (${sm.barsAgo}m)` : `🔴 9↓21 (${sm.barsAgo}m)`);
  else {
    const sc = detectMAConvergence(bars, 9, 21);
    if (sc) parts.push(sc.type === 'golden_soon' ? `⏳ 9→21 yukarı yaklaşıyor (~${sc.etaBars} mum)` : `⏳ 9→21 aşağı yaklaşıyor (~${sc.etaBars} mum)`);
  }
  return parts.length ? `<code>${tfAd}</code> ${parts.join(' · ')}` : null;
}
// ── KESİŞİM GÖZCÜSÜ — izlenen coinlerde tüm TF'lerde kesişim/yaklaşma bildirir ──
const _maAlerted = {};   // dedupe: sym_tf_type → ts (12 saat)
async function maCrossWatcher() {
  try {
    // İzlenecek evren: açık pozisyonlar + spot listesi + en sıcak 10 coin
    const hot = (await fetchHotCoins()).sort((a, b) => b.scalpScore - a.scalpScore).slice(0, 10).map(c => c.sym);
    const universe = [...new Set([...Object.keys(openPositions), ...Object.keys(spotPositions), ...SPOT_COINS, ...hot])].slice(0, 20);
    const tfs = [['15m', '15dk'], ['1h', '1sa'], ['4h', '4sa'], ['1d', '1gün']];
    for (const sym of universe) {
      for (const [tf, ad] of tfs) {
        let bars = await fetchOHLC(sym, tf);
        if (!bars || bars.length < 60) bars = await fetchSpotOHLC(sym, tf);
        if (!bars || bars.length < 60) continue;
        const cross = detectMACross(bars, 50, 200);
        const conv = cross ? null : detectMAConvergence(bars, 50, 200);
        const ev = cross ? { k: cross.type, txt: cross.type === 'golden' ? `🌟 <b>GOLDEN CROSS — ${sym} (${ad})</b>\nEMA50, EMA200'ü YUKARI kesti (${cross.barsAgo} mum önce). Orta/uzun vade yükseliş dönüşü — LONG tarafı güçlendi.` : `💀 <b>DEATH CROSS — ${sym} (${ad})</b>\nEMA50, EMA200'ü AŞAĞI kesti (${cross.barsAgo} mum önce). Düşüş dönüşü — SHORT tarafı güçlendi.` }
          : conv ? { k: conv.type, txt: conv.type === 'golden_soon' ? `⏳🌟 <b>GOLDEN CROSS YAKLAŞIYOR — ${sym} (${ad})</b>\nEMA50 alttan EMA200'e yaklaşıyor (fark %${conv.gapPct.toFixed(2)}, ~${conv.etaBars} mum). Kesişim fiyatlanmadan ERKEN LONG fırsatı olabilir.` : `⏳💀 <b>DEATH CROSS YAKLAŞIYOR — ${sym} (${ad})</b>\nEMA50 üstten EMA200'e yaklaşıyor (fark %${conv.gapPct.toFixed(2)}, ~${conv.etaBars} mum). Erken SHORT fırsatı olabilir.` } : null;
        if (!ev) continue;
        const key = `${sym}_${tf}_${ev.k}`;
        if (_maAlerted[key] && Date.now() - _maAlerted[key] < 12 * 3600 * 1000) continue;
        _maAlerted[key] = Date.now();
        await sendTelegram(ev.txt + '\n\n<i>Yatırım tavsiyesi değildir.</i>');
        await new Promise(r => setTimeout(r, 600));
      }
    }
  } catch (e) { console.error('MA gözcüsü hatası:', e.message); }
}
// GRAFİK FORMASYONU TESPİTİ (pivotlardan: çift tepe/dip, (ters) omuz-baş-omuz)
function detectChartPattern(bars) {
  if (!bars || bars.length < 40) return null;
  const piv = [];
  for (let i = 3; i < bars.length - 3; i++) {
    const h = bars[i].h, l = bars[i].l;
    if (h > bars[i-1].h && h > bars[i-2].h && h > bars[i+1].h && h > bars[i+2].h) piv.push({ i, p: h, tip: 'H' });
    if (l < bars[i-1].l && l < bars[i-2].l && l < bars[i+1].l && l < bars[i+2].l) piv.push({ i, p: l, tip: 'L' });
  }
  const his = piv.filter(x => x.tip === 'H').slice(-4), los = piv.filter(x => x.tip === 'L').slice(-4);
  const near = (a, b, pct) => Math.abs(a - b) / ((a + b) / 2) * 100 < pct;
  // Omuz-Baş-Omuz (3 tepe, ortadaki en yüksek, omuzlar yakın)
  if (his.length >= 3) {
    const [s1, bas, s2] = his.slice(-3);
    if (bas.p > s1.p && bas.p > s2.p && near(s1.p, s2.p, 3)) return { name: 'Omuz-Baş-Omuz (OBO)', dir: 'SHORT' };
  }
  if (los.length >= 3) {
    const [s1, bas, s2] = los.slice(-3);
    if (bas.p < s1.p && bas.p < s2.p && near(s1.p, s2.p, 3)) return { name: 'Ters OBO', dir: 'LONG' };
  }
  // Çift tepe / çift dip
  if (his.length >= 2) { const [a, b] = his.slice(-2); if (near(a.p, b.p, 1.5)) return { name: 'Çift Tepe (M)', dir: 'SHORT' }; }
  if (los.length >= 2) { const [a, b] = los.slice(-2); if (near(a.p, b.p, 1.5)) return { name: 'Çift Dip (W)', dir: 'LONG' }; }
  return null;
}
// ── ARZ ANALİZİ (CoinGecko ücretsiz) — kilit açılımı riski / arz sabit / seyreltme ──
const _supplyCache = {};   // 6 saat TTL
async function getSupplyInfo(sym) {
  const ck = sym.toUpperCase();
  const hit = _supplyCache[ck];
  if (hit && Date.now() - hit.t < 6 * 3600 * 1000) return hit.v;
  try {
    const sr = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(ck)}`);
    const sd = await sr.json();
    const coin = (sd.coins || []).find(c => (c.symbol || '').toUpperCase() === ck) || (sd.coins || [])[0];
    if (!coin) { _supplyCache[ck] = { t: Date.now(), v: null }; return null; }
    const r = await fetch(`https://api.coingecko.com/api/v3/coins/${coin.id}?localization=false&tickers=false&community_data=false&developer_data=false`);
    const d = await r.json();
    const m = d.market_data || {};
    const circ = m.circulating_supply, tot = m.total_supply, max = m.max_supply;
    const mcap = m.market_cap && m.market_cap.usd, fdv = m.fully_diluted_valuation && m.fully_diluted_valuation.usd;
    let notes = [];
    const circPct = (circ && (max || tot)) ? circ / (max || tot) * 100 : null;
    if (circPct != null) {
      if (circPct < 55) notes.push(`⚠️ Dolaşımda sadece %${Math.round(circPct)} — kilit açılımlarıyla ARZ ARTIŞI riski yüksek (satış baskısı olabilir)`);
      else if (circPct < 80) notes.push(`🟡 Dolaşımda %${Math.round(circPct)} — orta düzey kilit açılımı/seyreltme riski`);
      else if (circPct >= 99) notes.push(`🟢 Arz neredeyse tamamen dolaşımda (%${Math.round(circPct)}) — kilit açılımı baskısı yok`);
      else notes.push(`🟢 Dolaşımda %${Math.round(circPct)} — düşük seyreltme riski`);
    }
    if (max && tot && tot < max * 0.995) notes.push(`🔥 Toplam arz maks. arzın altında — yakım (burn) yapılmış olabilir`);
    if (!max) notes.push(`⚠️ Maksimum arz TANIMSIZ — sınırsız basım/enflasyon riski`);
    if (mcap && fdv && fdv > mcap * 1.8) notes.push(`⚠️ FDV, piyasa değerinin ${(fdv / mcap).toFixed(1)} katı — gelecekte ciddi arz girişi bekleniyor`);
    const v = { circPct, notes, id: coin.id, mcap: mcap || null, vol24: (m.total_volume && m.total_volume.usd) || null };
    _supplyCache[ck] = { t: Date.now(), v };
    return v;
  } catch (e) { return hit ? hit.v : null; }
}
// ================================================================
// TD SEQUENTIAL (Tom DeMark 9) — dip/tepe sayacı, tüm TF'lerde kullanılır
// Alış kurulumu: 9 ardışık mum, kapanış 4 mum öncekinden DÜŞÜK → TD9 DİP (dönüş adayı)
// Satış kurulumu: 9 ardışık mum, kapanış 4 mum öncekinden YÜKSEK → TD9 TEPE
// ================================================================
function tdSeq(bars) {
  if (!bars || bars.length < 14) return null;
  let cnt = 0, dir = 0, last = null;
  for (let i = 4; i < bars.length; i++) {
    if (bars[i].c < bars[i - 4].c) { if (dir === 1) cnt++; else { dir = 1; cnt = 1; } }
    else if (bars[i].c > bars[i - 4].c) { if (dir === -1) cnt++; else { dir = -1; cnt = 1; } }
    else { cnt = 0; dir = 0; }
    if (cnt === 9) { last = { type: dir === 1 ? 'buy9' : 'sell9', i }; cnt = 0; dir = 0; }
  }
  return { count: cnt, dir, last: last ? { type: last.type, barsAgo: bars.length - 1 - last.i } : null };
}
function tdText(td, ad) {
  if (!td) return null;
  const parts = [];
  if (td.last && td.last.barsAgo <= 4) parts.push(td.last.type === 'buy9' ? `✅ TD9 DİP tamamlandı (${td.last.barsAgo} mum önce)` : `🔻 TD9 TEPE tamamlandı (${td.last.barsAgo} mum önce)`);
  if (td.count >= 6) parts.push(td.dir === 1 ? `TD ${td.count}/9 alış kurulumu (dip yaklaşıyor)` : `TD ${td.count}/9 satış kurulumu (tepe yaklaşıyor)`);
  return parts.length ? `<code>${ad}</code> ${parts.join(' · ')}` : null;
}
// ── PİVOT SEVİYELERİ: kapanış altındaki güçlü destekler / üstündeki dirençler ──
function pivotLevels(bars, price) {
  const lows = [], highs = [];
  for (let i = 3; i < bars.length - 3; i++) {
    if (bars[i].l < bars[i-1].l && bars[i].l < bars[i-2].l && bars[i].l < bars[i+1].l && bars[i].l < bars[i+2].l) lows.push(bars[i].l);
    if (bars[i].h > bars[i-1].h && bars[i].h > bars[i-2].h && bars[i].h > bars[i+1].h && bars[i].h > bars[i+2].h) highs.push(bars[i].h);
  }
  // Yakın seviyeleri kümele (%1.5 içindekileri birleştir — dokunma sayısı = güç)
  const cluster = (arr) => {
    const out = [];
    arr.sort((a, b) => a - b).forEach(v => {
      const c = out.find(o => Math.abs(o.p - v) / v < 0.015);
      if (c) { c.p = (c.p * c.n + v) / (c.n + 1); c.n++; } else out.push({ p: v, n: 1 });
    });
    return out;
  };
  const sup = cluster(lows).filter(x => x.p < price * 0.995).sort((a, b) => b.p - a.p);
  const res = cluster(highs).filter(x => x.p > price * 1.005).sort((a, b) => a.p - b.p);
  return { sup, res };
}
// ================================================================
// HODL / UZUN VADE SPOT ALIM PLANI — günlük+haftalık dip analizi + kademeli alım (%'li)
// ================================================================
async function dcaPlan(sym) {
  const d1 = await fetchSpotOHLC(sym, '1d');
  const w1 = await fetchSpotOHLC(sym, '1w');
  if (!d1 || d1.length < 60) return null;
  const price = d1[d1.length - 1].c;
  const cD = d1.map(b => b.c);
  const rsiD = (a => a[a.length - 1] || 50)(rsiArr(cD, 14));
  const rsiW = w1 && w1.length > 20 ? (a => a[a.length - 1] || 50)(rsiArr(w1.map(b => b.c), 14)) : null;
  const tdD = tdSeq(d1), tdW = w1 ? tdSeq(w1) : null;
  const e50 = ema(cD, 50), e200 = cD.length >= 200 ? ema(cD, 200) : null;
  // 52 hafta zirve/dip
  const yr = d1.slice(-365);
  const hi52 = Math.max(...yr.map(b => b.h)), lo52 = Math.min(...yr.map(b => b.l));
  // Hacim: son 20 gün ort. vs önceki 20 gün (düşüşte hacim azalıyorsa satıcı yorgunluğu)
  const v20 = d1.slice(-20).reduce((s, b) => s + b.vol, 0) / 20;
  const vPrev = d1.slice(-40, -20).reduce((s, b) => s + b.vol, 0) / 20;
  const satisYorgun = price < e50 && v20 < vPrev * 0.8;
  // Destekler: günlük pivotlar + haftalık ana destek
  const pd = pivotLevels(d1.slice(-200), price);
  const pw = w1 && w1.length > 30 ? pivotLevels(w1, price) : { sup: [], res: [] };
  let sups = pd.sup.slice(0, 4).map(x => x.p);
  const wMajor = pw.sup.length ? pw.sup[0].p : null;
  if (wMajor && !sups.some(s => Math.abs(s - wMajor) / wMajor < 0.03)) { sups.push(wMajor); sups.sort((a, b) => b - a); }
  sups = sups.slice(0, 4);
  if (sups.length < 2) return null;
  // Dip sinyalleri toplamı → hazırlık durumu
  let dipSkor = 0; const dipNot = [];
  if (rsiD <= 30) { dipSkor += 3; dipNot.push(`Günlük RSI ${Math.round(rsiD)} — AŞIRI SATIM`); }
  else if (rsiD <= 40) { dipSkor += 1.5; dipNot.push(`Günlük RSI ${Math.round(rsiD)} — dip bölgesine yakın`); }
  if (rsiW != null && rsiW <= 40) { dipSkor += 2; dipNot.push(`Haftalık RSI ${Math.round(rsiW)} — uzun vade dip bölgesi`); }
  if (tdD && tdD.last && tdD.last.type === 'buy9' && tdD.last.barsAgo <= 4) { dipSkor += 2.5; dipNot.push('Günlük TD9 DİP tamamlandı ✅'); }
  if (tdW && tdW.last && tdW.last.type === 'buy9' && tdW.last.barsAgo <= 3) { dipSkor += 2; dipNot.push('Haftalık TD9 DİP ✅'); }
  if (tdD && tdD.dir === 1 && tdD.count >= 7) { dipSkor += 1; dipNot.push(`Günlük TD ${tdD.count}/9 alış kurulumu`); }
  if (satisYorgun) { dipSkor += 1; dipNot.push('Hacim: satıcı yorgunluğu (düşüşte hacim azalıyor)'); }
  // Alt TF dönüş onayı (4sa)
  const h4 = await fetchSpotOHLC(sym, '4h');
  let altOnay = false;
  if (h4 && h4.length > 40) {
    const r4 = rsiArr(h4.map(b => b.c), 14); const rNow = r4[r4.length - 1], rPrev = r4[r4.length - 2];
    const td4 = tdSeq(h4);
    if ((rNow > rPrev && rNow < 50) || (td4 && td4.last && td4.last.type === 'buy9' && td4.last.barsAgo <= 3)) altOnay = true;
  }
  if (altOnay) { dipSkor += 1; dipNot.push('4sa dönüş onayı ✅'); }
  // KADEMELİ PLAN: dip skoru yüksekse erken kademeler ağır
  const near1 = Math.abs(price - sups[0]) / price * 100;
  const pcts = dipSkor >= 5 ? [25, 30, 25, 5] : dipSkor >= 3 ? [20, 25, 30, 10] : [15, 25, 30, 15];
  const rezerv = 100 - pcts.reduce((a, b) => a + b, 0);
  const ladder = sups.map((p, i) => ({ lvl: i + 1, price: p, pct: pcts[i] || 0 })).filter(x => x.pct > 0);
  let cum = 0, cost = 0;
  ladder.forEach(l => { cum += l.pct; cost += l.pct * l.price; l.avg = cost / cum; });
  // Hedefler: günlük dirençler + 52h zirve
  const hedefs = pd.res.slice(0, 2).map(x => x.p); if (hi52 > price * 1.05) hedefs.push(hi52);
  const durum = dipSkor >= 5 ? '🟢 ALIM BÖLGESİ — kademeli girişe uygun'
             : dipSkor >= 3 ? '🟡 YAKLAŞIYOR — ilk kademeye hazırlan, teyit bekle'
             : '⚪ BEKLE — dip sinyalleri henüz zayıf, seviyeler aşağıda';
  return { price, rsiD, rsiW, tdD, tdW, hi52, lo52, dipSkor, dipNot, durum, ladder, rezerv, hedefs, wMajor, altOnay, sups };
}
function hodlMessage(sym, plan, sup) {
  const dec = plan.price > 100 ? 2 : plan.price > 1 ? 4 : 6;
  const f = v => '$' + Number(v).toLocaleString('tr-TR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  // Kalite (HODL sepeti önceliği: sağlam + hacimli)
  let kalite = '⚪ Veri yok';
  if (sup && (sup.mcap || sup.vol24)) {
    const m = sup.mcap || 0, v = sup.vol24 || 0;
    kalite = (m >= 500e6 && v >= 20e6) ? `🟢 Sağlam & hacimli (MCap $${(m/1e9).toFixed(1)}B · 24s $${(v/1e6).toFixed(0)}M)` :
             (m >= 100e6 && v >= 5e6)  ? `🟡 Orta (MCap $${(m/1e6).toFixed(0)}M · 24s $${(v/1e6).toFixed(0)}M)` :
             `🔴 HODL için RİSKLİ (küçük/hacimsiz — MCap $${(m/1e6).toFixed(0)}M)`;
  }
  const zirvedenPct = ((plan.price - plan.hi52) / plan.hi52 * 100).toFixed(0);
  const diptenPct = ((plan.price - plan.lo52) / plan.lo52 * 100).toFixed(0);
  let msg = `🏦 <b>${sym} — UZUN VADE SPOT ALIM PLANI (HODL)</b>\n\n` +
    `🏗️ Proje kalitesi: ${kalite}\n` +
    `💰 Fiyat: <b>${f(plan.price)}</b> · 52h zirveden %${zirvedenPct} · dipten +%${diptenPct}\n\n` +
    `<b>📅 Dip Analizi (skor ${plan.dipSkor.toFixed(1)}/10):</b>\n` +
    (plan.dipNot.length ? plan.dipNot.map(n => '• ' + n).join('\n') : '• Belirgin dip sinyali yok') + '\n\n' +
    `🎯 <b>DURUM: ${plan.durum}</b>\n\n` +
    `🪜 <b>KADEMELİ ALIM PLANI</b> (sermayenin %${100 - plan.rezerv}'i · %${plan.rezerv} nakit rezerv):\n`;
  plan.ladder.forEach(l => {
    msg += `${l.lvl}️⃣ ${f(l.price)} → <b>%${l.pct}</b> gir` + (l.lvl > 1 ? ` · ort. maliyet ≈ ${f(l.avg)}` : '') + '\n';
  });
  msg += `\n📉 <b>Düştükçe ekleme mantığı:</b> her kademede belirtilen % kadar alım yap; ` +
    `tüm kademeler dolarsa ortalama maliyet ≈ <b>${f(plan.ladder[plan.ladder.length - 1].avg)}</b> olur.\n` +
    (plan.wMajor ? `🧱 Uzun vade ana destek (haftalık): <b>${f(plan.wMajor)}</b>\n` : '') +
    `⚠️ Plan gözden geçirme: haftalık kapanış en alt kademenin altına inerse yeni analiz iste (spot HODL'da SL yok, plan revizyonu var).\n\n` +
    (plan.hedefs.length ? `🎯 <b>Satış hedefleri:</b> ${plan.hedefs.map(h => f(h)).join(' · ')}\n\n` : '') +
    `<i>Yatırım tavsiyesi değildir — kademeli plan riski dağıtır ama düşen piyasada zarar edebilirsin.</i>`;
  return msg;
}

// ── HABER TAKİBİ (CryptoCompare — key gerekmez) + basit duygu analizi ──
const NEWS_POS = ['listing','listed','partnership','integration','upgrade','mainnet','burn','buyback','adoption','approval','etf','institutional','funding','launch','surge','all-time high','ath','staking','airdrop','acquisition','expands'];
const NEWS_NEG = ['hack','exploit','lawsuit','sec charges','delist','delisting','rug','scam','outage','halt','bankruptcy','liquidation','vulnerability','stolen','breach','fraud','investigation','sell-off','unlock','dump','fine','ban'];
function newsSentimentScore(txt) {
  const t = String(txt || '').toLowerCase();
  let s = 0;
  NEWS_POS.forEach(w => { if (t.includes(w)) s++; });
  NEWS_NEG.forEach(w => { if (t.includes(w)) s -= 1.5; });
  return s;
}
const newsSentiment = {};       // { SYM: { score, headline, ts } } — sinyallere katılır (6 saat geçerli)
const _seenNews = new Set();
let _newsFirstRun = true;
async function newsMonitor() {
  try {
    const r = await fetch('https://min-api.cryptocompare.com/data/v2/news/?lang=EN&sortOrder=latest');
    const d = await r.json();
    const items = (d && d.Data) || [];
    for (const it of items.slice(0, 40)) {
      if (_seenNews.has(it.id)) continue;
      _seenNews.add(it.id);
      if (_seenNews.size > 800) { const arr = [..._seenNews]; arr.slice(0, 300).forEach(x => _seenNews.delete(x)); }
      const cats = String(it.categories || '').split('|').map(s => s.trim().toUpperCase()).filter(Boolean);
      const score = newsSentimentScore(it.title + ' ' + (it.body || '').slice(0, 400));
      if (Math.abs(score) < 1) continue;   // nötr haberleri geç
      // Bizim evrendeki coin'lerle eşleştir (vadeli registry + spot listesi + açık pozisyonlar)
      const relevant = cats.filter(c => /^[A-Z0-9]{2,10}$/.test(c) && c !== 'ICO' && c !== 'ETF' &&
        (SYMBOL_REGISTRY.okx[c] || SYMBOL_REGISTRY.binance[c] || SYMBOL_REGISTRY.bybit[c] || SPOT_COINS.includes(c) || openPositions[c] || spotPositions[c]));
      if (!relevant.length) continue;
      for (const symC of relevant.slice(0, 3)) {
        newsSentiment[symC] = { score, headline: it.title, ts: Date.now() };
        if (_newsFirstRun) continue;   // ilk çalıştırmada birikmiş haberleri BİLDİRME (sadece kaydet)
        const lbl = score > 0 ? '🟢 OLUMLU HABER' : '🔴 OLUMSUZ HABER';
        await sendTelegram(
          `${lbl} — <b>${symC}</b>\n\n📰 ${it.title}\n` +
          `Kaynak: ${it.source_info ? it.source_info.name : (it.source || '-')}\n` +
          `Etki: ${score > 0 ? 'yükseliş yönlü olabilir 📈' : 'düşüş yönlü olabilir 📉'} (skor ${score > 0 ? '+' : ''}${score.toFixed(1)})\n\n` +
          `<i>Bot bu haberi ${symC} sinyallerinde ${Math.abs(score) >= 2 ? 'GÜÇLÜ' : 'hafif'} etken olarak kullanacak. Yatırım tavsiyesi değildir.</i>`
        );
        await new Promise(res => setTimeout(res, 600));
      }
    }
  } catch (e) { console.error('haber takip hatası:', e.message); }
  _newsFirstRun = false;
}
function getNewsBoost(sym) {
  const n = newsSentiment[sym];
  if (!n || Date.now() - n.ts > 6 * 3600 * 1000) return null;
  return n;
}
// ── GRAFİK GÖRÜNTÜSÜ (QuickChart — ücretsiz) + Telegram'a fotoğraf gönder ──
async function buildChartUrl(bars, sym, tf, levels) {
  try {
    const data = bars.slice(-70).map(b => ({ x: b.t, o: b.o, h: b.h, l: b.l, c: b.c }));
    const ann = {};
    const mk = (id, y, color, label) => { if (y != null && isFinite(y)) ann[id] = { type: 'line', yMin: y, yMax: y, borderColor: color, borderWidth: 1.5, borderDash: [5, 4], label: { display: true, content: label, position: 'end', backgroundColor: color, font: { size: 9 } } }; };
    if (levels) { mk('e', levels.entry, '#3b82f6', 'Giriş'); mk('s', levels.sl, '#ef4444', 'SL'); mk('t1', levels.tp1, '#22c55e', 'TP1'); mk('t2', levels.tp2, '#16a34a', 'TP2'); mk('t3', levels.tp3, '#15803d', 'TP3'); }
    const cfg = {
      type: 'candlestick',
      data: { datasets: [{ label: `${sym} ${tf}`, data }] },
      options: {
        plugins: { legend: { display: true, labels: { color: '#ddd' } }, annotation: { annotations: ann } },
        scales: { x: { type: 'timeseries', ticks: { color: '#999' }, grid: { color: 'rgba(255,255,255,.06)' } },
                  y: { ticks: { color: '#999' }, grid: { color: 'rgba(255,255,255,.08)' } } },
      },
    };
    const r = await fetch('https://quickchart.io/chart/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chart: cfg, width: 820, height: 440, backgroundColor: '#111418', version: '3' }),
    });
    const j = await r.json();
    return (j && j.success && j.url) ? j.url : null;
  } catch (e) { return null; }
}
async function sendTelegramPhoto(chatId, photoUrl, caption) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, photo: photoUrl, caption: caption || '', parse_mode: 'HTML' }),
    });
  } catch (e) {}
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
        recordOutcome(pos.learnCtx, pos.tpHit.length > 0 ? "win" : "loss", { tp: pos.tpHit.length ? Math.max(...pos.tpHit) : 0 });
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
  // ── LİSTE: manuel (SPOT_COINS) + MEXC spot pazarından OTOMATİK bulunan sıcak coinler ──
  const autoList = await fetchMexcHotSpot();
  // Dönüşümlü TAM tarama: her turda tüm listeden 40 coin — böylece MEXC'teki HER coin sırayla taranır
  const all = global._mexcAll || [];
  let rot = [];
  if (all.length) {
    rot = all.slice(_spotRotIdx, _spotRotIdx + 40);
    if (rot.length < 40) rot = rot.concat(all.slice(0, 40 - rot.length));
    _spotRotIdx = (_spotRotIdx + 40) % all.length;
  }
  const list = [...new Set([...SPOT_COINS, ...autoList, ...rot])];
  if (!list.length) return;
  console.log(new Date().toLocaleTimeString('tr-TR'), `- 🛒 Spot tarama: ${SPOT_COINS.length} manuel + ${autoList.length} sıcak + ${rot.length} dönüşümlü (toplam evren ${all.length}) = ${list.length} coin`);
  for (const sym of list) {
    try {
      if (spotPositions[sym]) continue;                 // zaten alımdayız
      if (pendingSpotSetups[sym]) continue;             // kurulum zaten bekleniyor
      const manual = SPOT_COINS.includes(sym);
      // Otomatik coinlerde HIZLI ÖN FİLTRE (15m) — ancak umut varsa tam çoklu-TF taraması yap
      if (!manual) {
        const qb = await fetchSpotOHLC(sym, '15m');
        if (!qb || qb.length < 30) continue;
        // ── CANSIZ COİN FİLTRESİ: yanıltıcı ölü grafiklerde işleme girme ──
        // (a) Son 30 mumun %25+'ı sıfır hacimliyse ölü. (b) Volatilite (ATR%) < 0.12 ise cansız/manipüle riski.
        const son30 = qb.slice(-30);
        const bosMum = son30.filter(b => !b.vol || b.vol <= 0).length;
        if (bosMum > 7) continue;
        const atrp = (atr14 => atr14 / son30[son30.length - 1].c * 100)(
          son30.slice(-15).reduce((s, b, i, a) => i ? s + Math.max(b.h - b.l, Math.abs(b.h - a[i-1].c), Math.abs(b.l - a[i-1].c)) : s, 0) / 14);
        if (!isFinite(atrp) || atrp < 0.12) continue;
        const qs = calcScalpSignal(qb, qb[qb.length - 1].c);
        if (!qs || qs.dir !== 'LONG' || qs.confidence < CONFIG.minConfidence - 8) continue;
      }
      // ── ÇOKLU-TF DEĞERLENDİRME: tüm TF'lerde ALIM sinyali ara, EN GÜVENLİSİNİ seç ──
      // Uzun vadeli TF sinyali daha güçlü/güvenli sayılır (1gün > 4sa > 1sa > 15dk > 5dk)
      const tfW = { '5m': 0, '15m': 2, '1h': 5, '4h': 9, '1d': 14 };
      let best = null;
      for (const tf of ['5m', '15m', '1h', '4h', '1d']) {
        const raw = await fetchSpotOHLC(sym, tf);
        if (!raw || raw.length < 31) continue;
        // GÜNLÜK KAPANIŞ TEYİDİ: 1gün (ve 4sa) sinyali KAPANMIŞ muma göre hesapla —
        // henüz kapanmamış mumla erken/yalancı sinyal verilmesin
        const bars = (tf === '1d' || tf === '4h') ? raw.slice(0, -1) : raw;
        const price = raw[raw.length - 1].c;   // anlık fiyat yine canlı
        const sig = calcScalpSignal(bars, price);
        if (!sig || sig.dir !== 'LONG') continue;        // SPOT: yalnızca ALIM
        if (sig.confidence < CONFIG.minConfidence - 5) continue;
        let score = sig.confidence + tfW[tf];
        const cross = detectMACross(bars, 50, 200);
        const conv = cross ? null : detectMAConvergence(bars, 50, 200);
        let maNote = null;
        if (cross && cross.type === 'golden') { score += 10; maNote = `🌟 Golden Cross (${tf})`; }
        if (conv && conv.type === 'golden_soon') { score += 6; maNote = `⏳🌟 Golden Cross yaklaşıyor (${tf}, ~${conv.etaBars} mum)`; }
        if (cross && cross.type === 'death') score -= 12;   // death cross'lu TF'de alma
        if (!best || score > best.score) best = { tf, bars, price, sig, score, maNote };
      }
      if (!best) continue;
      const { tf: bestTf, bars, price, sig } = best;
      if (sig.confidence < CONFIG.minConfidence && !best.maNote) continue;   // MA desteği yoksa tam eşik ara

      const key = 'SPOT' + sym; const now = Date.now();
      if (alarmHistory[key] && now - alarmHistory[key] < CONFIG.dedupeMinutes * 60000) continue;

      const lv = calcEntryLevels(sig, price, bestTf);
      if (!lv.reachable) continue;
      lv.leverage = 1;                                    // KALDIRAÇSIZ

      // Öğrenme kapısı (spot üst-TF trendiyle) — kötü alımı ele
      const htf = await spotHtfBias(sym).catch(() => null);
      const ctxL = { sym, dir: 'LONG', htf: htfBucket(htf), ct: isCounterTrend('LONG', htf), conf: sig.confidence, dist: lv.distToZone || 0, spot: true };
      const blocked = learnBlock(ctxL);
      if (blocked) { console.log(`   🧠 spot ${sym} ALIM atlandı: ${blocked}`); continue; }

      alarmHistory[key] = now;
      const dec = price > 100 ? 2 : price > 1 ? 4 : 6;
      const f = v => v.toLocaleString('tr-TR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
      const msgOf = async (pfx) => {
        // UZUN VADE HODL FORMATI: günlük/haftalık dip analizi + kademeli alım planı (%'li)
        const plan = await dcaPlan(sym + 'USDT').catch(() => null) || await dcaPlan(sym).catch(() => null);
        const supInfo = await getSupplyInfo(sym).catch(() => null);
        let head = `🟢🛒 <b>${pfx} — ${sym}</b> <i>(kaldıraçsız spot)</i>\n` +
          `⏱️ Tetikleyen kurulum: <b>${bestTf}</b> grafiği${best.maNote ? ' · ' + best.maNote : ''} · güven %${sig.confidence}\n\n`;
        if (plan) return head + hodlMessage(sym, plan, supInfo);
        // Plan kurulamazsa (kısa geçmişli coin) klasik format
        return head +
          `<b>📍 Alım bölgesi:</b> $${f(lv.entryZoneLow)} — $${f(lv.entryZoneHigh)}\n` +
          `▫️ İdeal alım: $${f(lv.entry)}\n🎯 Sat: TP1 $${f(lv.tp1)} · TP2 $${f(lv.tp2)} · TP3 $${f(lv.tp3)}\n` +
          `🛑 Zarar durdur: $${f(lv.sl)}\n\n⚠️ <i>Yatırım tavsiyesi değildir.</i>`;
      };
      if (lv.inZone) {
        // Fiyat ZATEN alım seviyesinde → sinyali ŞİMDİ ver
        spotPositions[sym] = {
          sym, entry: lv.entry, sl: lv.sl, tp1: lv.tp1, tp2: lv.tp2, tp3: lv.tp3,
          entryZoneLow: lv.entryZoneLow, entryZoneHigh: lv.entryZoneHigh,
          openTime: now, tpHit: [], filled: true, dec, learnCtx: ctxL,
        };
        await sendTelegram(await msgOf('SPOT ALIM FIRSATI'));
        console.log(new Date().toLocaleTimeString('tr-TR'), `- 🛒 SPOT ALIM: ${sym} %${sig.confidence}`);
      } else {
        // Fiyat alım seviyesinde DEĞİL → SİNYAL YOK; sessizce BEKLEYEN kuruluma al.
        // Fiyat bölgeye GELİNCE sinyal gidecek (erken/oynanmış sinyal verilmez).
        pendingSpotSetups[sym] = {
          sym, bestTf, dec, learnCtx: ctxL, created: now,
          entry: lv.entry, sl: lv.sl, tp1: lv.tp1, tp2: lv.tp2, tp3: lv.tp3,
          entryZoneLow: lv.entryZoneLow, entryZoneHigh: lv.entryZoneHigh,
          msg: await msgOf('SPOT ALIM SEVİYESİNE GELDİ'), key,
        };
        console.log(new Date().toLocaleTimeString('tr-TR'), `- ⏳ spot ${sym}: kurulum bekleniyor (bölgeye %${lv.distToZone.toFixed(2)} uzak)`);
      }
      await new Promise(r => setTimeout(r, 400));
    } catch (e) { console.error(`spot ${sym} hata:`, e.message); }
  }
}

// SPOT pozisyon takibi — alım dolunca + satış (TP/zarar durdur/aşırı alım) sinyalleri
const pendingSpotSetups = {};   // fiyatın alım bölgesine gelmesi BEKLENEN kurulumlar
async function monitorSpotPositions() {
  // ── BEKLEYEN KURULUMLAR: fiyat alım bölgesine GELDİ Mİ? ──
  for (const sym of Object.keys(pendingSpotSetups)) {
    const p = pendingSpotSetups[sym];
    try {
      const bars = await fetchSpotOHLC(sym, '5m');
      if (!bars || !bars.length) continue;
      const cur = bars[bars.length - 1]; const price = cur.c, low = cur.l, high = cur.h;
      if (low <= p.entryZoneHigh && high >= p.entryZoneLow) {
        // 🎯 Fiyat alım bölgesine GELDİ → sinyali ŞİMDİ ver + pozisyon takibine al
        spotPositions[sym] = { sym, entry: p.entry, sl: p.sl, tp1: p.tp1, tp2: p.tp2, tp3: p.tp3,
          entryZoneLow: p.entryZoneLow, entryZoneHigh: p.entryZoneHigh,
          openTime: Date.now(), tpHit: [], filled: true, dec: p.dec, learnCtx: p.learnCtx };
        await sendTelegram(p.msg);
        delete pendingSpotSetups[sym];
      } else if (high >= p.tp1) {
        // Kurulum KAÇTI (bölgeye uğramadan hedefe gitti) → sinyal yok, ama dedupe'u TEMİZLE
        // ki benzer yeni oluşum bir daha kaçırılmasın (hemen tekrar yakalanabilsin)
        delete alarmHistory[p.key]; delete pendingSpotSetups[sym];
        console.log(`⏳→✈️ spot ${sym}: kurulum kaçtı, benzer oluşum için tekrar izlemede`);
      } else if (low <= p.sl || Date.now() - p.created > 24 * 3600 * 1000) {
        // Kurulum bozuldu (SL altına indi) veya 24 saatte gelmedi → iptal + dedupe temizle
        delete alarmHistory[p.key]; delete pendingSpotSetups[sym];
      }
    } catch (e) {}
  }
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
      if (close) { recordOutcome(pos.learnCtx, result || "loss", { tp: pos.tpHit.length ? Math.max(...pos.tpHit) : 0 }); delete spotPositions[sym]; }
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

      // ── HABER ETKİSİ: olumlu haber sinyali güçlendirir, olumsuz haber ters yönü keser ──
      const nb = getNewsBoost(coin.sym);
      if (nb) {
        if (nb.score > 0 && sig.dir === 'LONG')  { sig.confidence = Math.min(97, sig.confidence + 6); sig.signals.unshift('📰 Olumlu haber desteği: ' + nb.headline.slice(0, 60)); }
        if (nb.score < 0 && sig.dir === 'SHORT') { sig.confidence = Math.min(97, sig.confidence + 6); sig.signals.unshift('📰 Olumsuz haber desteği (short): ' + nb.headline.slice(0, 60)); }
        if (nb.score < -1.5 && sig.dir === 'LONG') { lowConf++; continue; }   // kötü haberde LONG açma
      }

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

      // ── POZİSYON TAVANI + TARAMA BAŞINA LİMİT (kalite > miktar; aşırı işlem = aşırı SL) ──
      if (CONFIG.maxOpenPositions > 0 && Object.keys(openPositions).length >= CONFIG.maxOpenPositions) { hasOpen++; continue; }
      if (found >= CONFIG.maxNewPerScan) { deduped++; continue; }

      // ── MOMENTUM FİLTRESİ (panelden): son 3 mum sinyale TERS akıyorsa girme ──
      // LONG'da fiyat hâlâ düşüyorsa "düşen bıçak", SHORT'ta hâlâ yükseliyorsa tepe kovalamak olur.
      const son4 = bars.slice(-4);
      if (son4.length >= 4) {
        const mom = (son4[3].c - son4[0].c) / son4[0].c * 100;
        if (sig.dir === 'LONG' && mom < -0.3) { lowConf++; continue; }
        if (sig.dir === 'SHORT' && mom > 0.3) { lowConf++; continue; }
      }

      // ── GİRİŞ MESAFESİ: giriş bölgesi çok uzaksa güvenilmez (panel: >%1 ele) ──
      if (!lv.inZone && lv.distToZone > 0.8) { unreachable++; continue; }

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
async function smartAnalyze(symbol, forceFutures) {
  global._lastChartUrl = null;   // eski grafiğin yanlış mesajla gitmesini önle
  const sym = symbol.toUpperCase().replace('USDT', '').replace('/', '').trim();

  // ── ÖNCELİK SPOT: uzun vadeli genel analiz (4sa) — spotta yoksa vadeliye düş ──
  // ("vadeli" yazıldıysa spot atlanır, doğrudan vadeli analiz)
  let bars = forceFutures ? null : await fetchSpotOHLC(sym, '4h');
  let isSpot = false, scalpTF, atrInfo = {};
  if (bars && bars.length >= 30) {
    isSpot = true; scalpTF = '4h';   // spot alım-satım için uzun vadeli genel bakış
  } else {
    const picked = await pickBestScalpTF(sym);
    scalpTF = picked.best; atrInfo = picked.atrInfo;
    bars = await fetchOHLC(sym, scalpTF);
    if (!bars || bars.length < 30) {
      return `❌ <b>${sym}</b> için veri bulunamadı.\n\n` +
        `Spot VE vadeli piyasalarda (MEXC/OKX/Bybit/Binance/KuCoin/Gate + DEX otomatik arama) bulunamadı.\n` +
        `• Coin ismini kontrol et\n• /list ile mevcut coinleri gör`;
    }
  }
  const bias = await getMultiTFBias(sym);
  if (isSpot) {
    // Üst-TF trendini SPOT verisiyle hesapla (vadeli verisi yok/önceliksiz)
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

  // ── GELİŞMİŞ BÖLÜMLER: MA kesişimleri (TÜM TF'ler, yaklaşanlar dahil), formasyon, arz, haber ──
  const bars1h = isSpot ? await fetchSpotOHLC(sym, '1h') : await fetchOHLC(sym, '1h');
  const bars4h = isSpot ? await fetchSpotOHLC(sym, '4h') : await fetchOHLC(sym, '4h');
  const bars1d = isSpot ? await fetchSpotOHLC(sym, '1d') : await fetchOHLC(sym, '1d');
  const bars15 = isSpot ? await fetchSpotOHLC(sym, '15m') : await fetchOHLC(sym, '15m');
  let maTxt = '';
  const maSet = [[bars15, '15dk'], [bars1h, '1sa '], [bars4h, '4sa '], [bars1d, '1gün'], [bars, scalpTF]];
  for (const [b, ad] of maSet) { const st = maStatusForTF(b, ad); if (st) maTxt += st + '\n'; }
  if (!maTxt) maTxt = 'Hiçbir TF\'de yakın kesişim/yaklaşma yok\n';
  // TD SEQUENTIAL (Tom DeMark 9) — tüm TF'lerde dip/tepe sayacı
  let tdTxt = '';
  for (const [b, ad] of maSet) { const t = tdText(tdSeq(b), ad); if (t) tdTxt += t + '\n'; }
  if (tdTxt) maTxt += '<b>🔢 TD Sequential (DeMark 9):</b>\n' + tdTxt;
  const pat1h = detectChartPattern(bars1h) || detectChartPattern(bars);
  const patTxt = pat1h ? `${pat1h.dir === 'LONG' ? '🟢' : '🔴'} <b>${pat1h.name}</b> tespit edildi (${pat1h.dir} yönlü)` : 'Belirgin formasyon yok';
  const sup = await getSupplyInfo(sym);
  const supTxt = sup && sup.notes && sup.notes.length ? sup.notes.join('\n') : 'Arz verisi bulunamadı';
  const nws = getNewsBoost(sym);
  let newsTxt = 'Son 6 saatte önemli haber yok';
  if (nws) {
    newsTxt = `${nws.score > 0 ? '🟢 OLUMLU' : '🔴 OLUMSUZ'} (skor ${nws.score > 0 ? '+' : ''}${nws.score.toFixed(1)}): ${nws.headline}`;
    // Haber etkisini güvene kat
    if (nws.score > 0 && sig.dir === 'LONG') finalConf = Math.min(97, finalConf + 5);
    if (nws.score < 0 && sig.dir === 'LONG') finalConf = Math.max(10, finalConf - 8);
    if (nws.score < 0 && sig.dir === 'SHORT') finalConf = Math.min(97, finalConf + 5);
  }

  // Grafik görüntüsü hazırla (mesajdan sonra fotoğraf olarak gönderilir)
  global._lastChartUrl = await buildChartUrl(bars, sym, scalpTF, { entry, sl, tp1, tp2, tp3 });

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

<b>📐 MA Kesişimleri:</b>
${maTxt}<b>📊 Formasyon:</b> ${patTxt}

<b>🪙 Arz Analizi:</b>
${supTxt}

<b>📰 Haber Etkisi:</b>
${newsTxt}

<b>Sinyaller:</b>
${sig.signals.length ? sig.signals.slice(0,4).map(s=>'• '+s).join('\n') : '• Net sinyal yok'}
${flow ? `\n<b>Order Flow:</b> Alım %${flow.buyPct.toFixed(0)} / Satım %${flow.sellPct.toFixed(0)}` : ''}
📈 RSI: ${sig.rsiNow ? sig.rsiNow.toFixed(1) : '--'}${btNote}

⚠️ <i>Yatırım tavsiyesi değildir.</i>`;
}

async function analyzeCoinForCommand(symbol, tf, forceFutures) {
  global._lastChartUrl = null;   // eski grafiğin yanlış mesajla gitmesini önle
  tf = tf || CONFIG.scalpTF;
  const sym = symbol.toUpperCase().replace('USDT', '').replace('/', '').trim();

  // ── ÖNCELİK SPOT: önce spot verisi dene, yoksa vadeliye düş ("vadeli" yazıldıysa atla) ──
  let bars = forceFutures ? null : await fetchSpotOHLC(sym, tf);
  let isSpotData = !forceFutures;
  if (!bars || bars.length < 30) {
    bars = await fetchOHLC(sym, tf);
    isSpotData = false;
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

  // Grafik görüntüsü hazırla (bu TF için — mesajdan sonra fotoğraf olarak gönderilir)
  global._lastChartUrl = await buildChartUrl(bars, sym, tf, { entry, sl, tp1, tp2, tp3 });

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
🔢 TD: ${(t => t ? (t.last && t.last.barsAgo <= 4 ? (t.last.type === 'buy9' ? 'TD9 DİP ✅ (' + t.last.barsAgo + ' mum önce)' : 'TD9 TEPE 🔻 (' + t.last.barsAgo + ' mum önce)') : t.count >= 4 ? ('TD ' + t.count + '/9 ' + (t.dir === 1 ? 'alış' : 'satış') + ' kurulumu') : 'nötr') : 'nötr')(tdSeq(bars))}
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

      // /istatistik — açılan/kapanan işlemler, kazanç/kayıp sayıları
      if (text === '/istatistik' || text === '/stats' || text === '/stat') {
        await sendTelegramTo(chatId, tradeStats());
        continue;
      }

      // /spot komutu - spot izleme listesi + açık spot pozisyonları
      if (text === '/spot') {
        let m = '🛒 <b>SPOT (kaldıraçsız) izleme</b>\n\n';
        m += '🤖 <b>Otomatik tarama AÇIK</b> — MEXC spot pazarındaki en hareketli coinler (vadelide olmayanlar) sürekli taranıyor.\n';
        m += SPOT_COINS.length ? ('➕ Manuel liste: ' + SPOT_COINS.join(', ') + '\n\n') : '➕ Manuel liste boş (istersen Railway → Variables → <code>SPOT_COINS</code>=PONKE,WIF ekle — bunlar her taramada öncelikli bakılır).\n\n';
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
          '📊 <code>/istatistik</code> — kazanç/kayıp işlem sayıları\n' +
          '🛒 <code>/spot</code> — spot (kaldıraçsız) izleme listesi\n' +
          '🏦 <code>COIN spot</code> — uzun vade HODL analizi + kademeli alım planı\n' +
          '⚡ <code>COIN vadeli</code> — vadeli (kaldıraçlı) analiz\n' +
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

      // Yazılan TF'leri topla + spot/vadeli anahtar kelimeleri
      const lowParts = parts.slice(1).map(p => p.toLowerCase());
      const wantSpot = lowParts.includes('spot');
      const wantVadeli = lowParts.includes('vadeli') || lowParts.includes('futures');
      let tfs = lowParts.filter(p => VALID_TFS.includes(p));

      if (wantSpot) {
        // ── "COIN spot" → UZUN VADE HODL/DCA ANALİZİ (günlük+haftalık dip + kademeli alım planı) ──
        const symU = coinSym.toUpperCase().replace('USDT', '');
        await sendTelegramTo(chatId, `⏳ <b>${symU}</b> uzun vade SPOT analizi yapılıyor (günlük/haftalık dip + kademeli alım planı)...`);
        const plan = await dcaPlan(symU + 'USDT');
        if (!plan) { await sendTelegramTo(chatId, `❌ <b>${symU}</b> için yeterli günlük spot verisi bulunamadı.`); continue; }
        const supInfo = await getSupplyInfo(symU).catch(() => null);
        await sendTelegramTo(chatId, hodlMessage(symU, plan, supInfo));
        console.log(new Date().toLocaleTimeString('tr-TR'), `- HODL analiz: ${symU} → ${chatId}`);
        continue;
      }

      if (tfs.length === 0) {
        // TF YAZILMADI → akıllı analiz (en uygun scalp TF + tüm TF trend uyumu)
        // "vadeli" yazıldıysa spot önceliği ATLANIR, doğrudan vadeli analiz yapılır
        await sendTelegramTo(chatId, `⏳ <b>${coinSym.toUpperCase()}</b> ${wantVadeli ? 'VADELİ' : 'akıllı'} analiz ediliyor (tüm zaman dilimleri taranıyor)...`);
        const analysis = await smartAnalyze(coinSym, wantVadeli);
        await sendTelegramTo(chatId, analysis);
        // Mum grafiği (giriş/SL/TP seviyeleri işaretli) — analiz sonrası fotoğraf
        if (global._lastChartUrl) { await sendTelegramPhoto(chatId, global._lastChartUrl, `📉 ${coinSym.toUpperCase()} grafik — giriş/SL/TP seviyeleri işaretli`); global._lastChartUrl = null; }
        console.log(new Date().toLocaleTimeString('tr-TR'), `- Akıllı analiz: ${coinSym} → ${chatId}`);
      } else {
        // TF YAZILDI → o spesifik TF(ler)de analiz
        if (tfs.length > 5) tfs = tfs.slice(0, 5);
        await sendTelegramTo(chatId, `⏳ <b>${coinSym.toUpperCase()}</b> analiz ediliyor (${tfs.join(', ')})...`);
        for (const tf of tfs) {
          const analysis = await analyzeCoinForCommand(coinSym, tf, wantVadeli);
          await sendTelegramTo(chatId, analysis);
          // Bu TF'nin mum grafiği (giriş/SL/TP işaretli)
          if (global._lastChartUrl) { await sendTelegramPhoto(chatId, global._lastChartUrl, `📉 ${coinSym.toUpperCase()} ${tf} grafik`); global._lastChartUrl = null; }
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
  console.log('🛒 Spot tarama aktif: MEXC spot pazarı otomatik taranıyor' + (SPOT_COINS.length ? ' + manuel liste: ' + SPOT_COINS.join(', ') : ' (manuel liste boş — sorun değil)'));
  await scanSpotWatchlist();

  // Then scan periodically
  setInterval(scanForSignals, CONFIG.scanInterval);
  setInterval(scanSpotWatchlist, CONFIG.scanInterval);

  // Açık pozisyonları her 30 saniyede kontrol et (SL/TP bildirimleri için)
  setInterval(monitorPositions, 30000);
  setInterval(monitorSpotPositions, 30000);

  // 📰 Canlı haber takibi — 5 dakikada bir; olumlu/olumsuz haberleri coin ile bildirir
  newsMonitor();
  setInterval(newsMonitor, 5 * 60 * 1000);
  console.log('📰 Haber takibi aktif - olumlu/olumsuz haberler bildirilecek ve sinyallere katılacak');

  // 📐 MA kesişim gözcüsü — 10 dakikada bir; kesişim VE yaklaşma bildirimleri (tüm TF'ler)
  setInterval(maCrossWatcher, 10 * 60 * 1000);
  setTimeout(maCrossWatcher, 60 * 1000);   // ilk tur 1 dk sonra (açılış yoğunluğunu bekle)
  console.log('📐 MA kesişim gözcüsü aktif - golden/death cross ve YAKLAŞMA bildirimleri gelecek');
  console.log('📍 Pozisyon takibi aktif - SL/TP geldiğinde bildirim gelecek');

  // Komut dinleme döngüsü (sürekli)
  console.log('💬 Komut dinleyici aktif - coin ismi yazarak analiz alabilirsin');
  while (true) {
    await pollCommands();
  }
}

start();
