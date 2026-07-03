# cscalpxbot — Öğrenme Modu Eklendi (daha az SL)

Bu, senin `tospikim/cscalpxbot` botunun **öğrenme modu** eklenmiş halidir. Analiz/işlem motoru
aynen korundu; sadece **geçmiş SL'lerden öğrenip benzer hatayı tekrarlamayan** bir katman eklendi.

## Ne değişti?

1. **Sonuç hafızası (kalıcı).** Her kapanan işlem (SL veya TP) bağlamıyla `learning.json`
   dosyasına yazılır: yön, üst-TF trendi, trend-karşıtı mıydı, güven, sonuç (kazanç/kayıp).
   Bot yeniden başlayınca bu dosyadan yüklenir.

2. **Öğrenme kapısı (tarama sırasında — daha az SL).** Bir sinyal gönderilmeden önce şu filtrelerden geçer:
   - **Trend karşıtı engeli:** Sinyal, üst zaman dilimleri (15m/1h/4h/1d) güçlü şekilde ters yöndeyse
     GİRME. (Panelde en sık SL sebebi buydu.) Ama bu kategori geçmişte kanıtlanmış kazançlıysa izin verir.
   - **Aynı coin+yön yakında SL olduysa** tekrar girme (3 saat).
   - **Tekrar eden hata:** bir özellik (ör. trend karşıtı, düşük güven) ≥3 kez kaybettirdiyse
     o özelliği taşıyan sinyalleri otomatik bloklar.
   - **Zayıf kategori:** yeterli örnekle (≥5) kazanma oranı %35 altındaki yön+trend kategorilerini bloklar.

3. **`/ogrenme` komutu.** Telegram'dan yaz → bot ne öğrendiğini gösterir: toplam sonuç, başarı oranı,
   sık kayıp sebepleri, hangi kategorilerin bloklandığı.

Taramada bir sinyal öğrenme yüzünden atlanınca loglarda `🧠 Öğrenme: N` sayacında görünür.

## Kurulum (mevcut repoyu güncelle)

- `bot.js` dosyasını bu yenisiyle değiştir. `package.json` aynı kalabilir.
- Ek ortam değişkeni gerekmez. İstersen `LEARN_FILE` ile dosya yolunu değiştirebilirsin.
- Railway/host'ta yeniden deploy et. İlk açılışta "🧠 Öğrenme dosyası yok, sıfırdan başlıyor" görürsün — normaldir.

## ÖNEMLİ: Kalıcılık uyarısı

Railway/Render/Fly gibi platformlarda dosya sistemi genelde **geçicidir** — yeni deploy'da
`learning.json` sıfırlanabilir (çalışırken biriken veri o oturumda geçerlidir).
Kalıcı olması için:
- **Railway/Fly Volume** ekle ve `LEARN_FILE=/data/learning.json` gibi volume yoluna ayarla.
- Ya da kabul et: her deploy'da öğrenme sıfırlanır, çalışırken yeniden birikir.

## Nasıl çalışır (özet)

- Öğrenme **veri biriktikçe** güçlenir. İlk birkaç işlemde çoğu kural pasiftir (yeterli örnek yok);
  sonuçlar biriktikçe trend-karşıtı ve kaybettiren kurulumlar elenmeye başlar.
- Bu katman botu **daha seçici** yapar → daha az ama daha temiz sinyal → daha az SL.
  Sinyal sayısı düşerse bu normaldir (kaçınılabilir SL'ler eleniyor).

## Dürüst notlar

- Bu bot **gerçek para** ile işlem açabiliyor (LIVE_TRADING). Öğrenme katmanı yalnızca sinyalleri
  **filtreler** (daha temkinli yapar), yeni risk eklemez — ama hiçbir sistem SL'yi sıfıra indiremez.
- Kod bu ortamda canlı test edilemedi (Bybit/OKX/Telegram ağına çıkış yok); sözdizimi temiz ve
  değişiklikler mevcut yapıya uygun. Deploy edince logları izle, takılırsan paylaş.
