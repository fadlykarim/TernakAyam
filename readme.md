# Petok Predict 🐔

Kalkulator perhitungan ayam profesional dengan analisis keuntungan real-time. Aplikasi ini berjalan sebagai situs statis dengan Netlify Functions untuk scraping harga dan penyajian konfigurasi rahasia (Supabase, Google OAuth, hCaptcha) secara aman.

## Fitur Utama

- Harga pasar real-time: ambil harga ayam Kampung & Broiler dari sumber tepercaya (via Netlify Functions)
- Dua jenis ayam (segmented toggle): Kampung & Broiler, asumsi default (FCR/bobot/survival) menyesuaikan
- Ringkasan usaha: pendapatan, total biaya, keuntungan, dan bar progres dalam satu kartu atas
- Asumsi vs Simulasi (tabs):
   - Asumsi Produksi: slider Populasi, Survival, Bobot, Harga Pakan/sak, FCR, dan Harga DOC
   - Simulasi Skenario: Realtime dan diturunkan dari Asumsi saat ini (Realistis = Asumsi; plus Optimis & Konservatif)
- Offline-aware: saat harga tidak tersedia (offline/timeout), simulasi menampilkan “—” tanpa fallback angka palsu
- Google Sign-In (GIS): login tanpa redirect ke halaman Supabase
- Riwayat & Profil (opsional): simpan kalkulasi, kelola favorit, dan profil pengguna via Supabase
- Export PDF: unduh ringkasan kalkulasi langsung dari dashboard
- Ringkas & sederhana: 1 file JS utama, tanpa bundler

## Pembaruan (UI & Logika)

- Navbar penuh lebar (bukan kartu): brand kiri, menu tengah, profil kanan.
- Edit/Reset harga: harga pasar dapat disesuaikan dengan tombol Edit dan tombol Kembalikan, lengkap dengan indikator "Default/Disesuaikan". Slider Harga Pakan & DOC juga menampilkan badge dan tombol Reset saat nilai berubah dari default.
- Estimasi umur panen (FCR → hari): kartu ringkasan menampilkan "xx–yy hari, estimasi panen: dd MMM yyyy" berdasarkan FCR & bobot target dengan formula halus dan realistis.
- Responsif: tombol-tombol mode/AI tidak pecah di layar kecil (scroll horizontal pills atau stack).

### Estimasi Umur Panen (Ringkas)
- Broiler: days ≈ 25·W^0.85 + 6 lalu dikalikan faktor FCR: (1 + 0.12·(FCR − 1.7))
- Kampung: days ≈ 58·W^0.70 + 8 lalu dikalikan faktor FCR: (1 + 0.08·(FCR − 2.3))
- Rentang ditampilkan ±1–2 hari tanpa random.

### AI Advisor (Stabil)
- Prompt diperketat: JSON-only, variasi sempit, monotonic, dan menghormati input pengguna sebagai jangkar.
- Temperature diturunkan (0.2) dan nilai diklem di sisi klien.

Catatan: Fitur yang memerlukan login/riwayat/profil membutuhkan Supabase yang sudah dikonfigurasi. Tanpa itu, kalkulator tetap dapat digunakan sepenuhnya di sisi klien.

## Teknologi

- Frontend: Vanilla HTML, CSS, JavaScript
- Serverless: Netlify Functions (`/api/proxy`, `/api/config`)
- Scraping harga: `fetch()` + pola regex (tanpa dependensi tambahan)
- Export: jsPDF via CDN
- Auth & Data: Supabase JS SDK via CDN + Google Identity Services
- Deployment: Netlify

## Prasyarat

- Akun Netlify (untuk dev lokal dan deploy)
- Node.js LTS dan npm (untuk Netlify CLI)
- Optional: Akun Supabase + proyek dengan RLS

## Struktur Proyek

```
├── index.html                # Halaman utama (UI 2 kartu + tabs Asumsi/Simulasi)
├── script.js                 # Logika aplikasi (auth, kalkulator, simulasi realtime, PDF, Supabase)
├── styles.css                # Gaya tampilan (responsive, slider header & value align)
├── api/
│   ├── config.js            # Netlify Function untuk expose env (Supabase, Google, hCaptcha)
│   └── proxy.js             # Netlify Function untuk scraping harga (kampung/broiler)
├── 01_create_tables.sql     # Skema tabel dasar (profiles, calculation_history, dll.)
├── 02_security_policies.sql # Kebijakan RLS dan policy keamanan
├── 03_functions_triggers.sql# RPC dan trigger yang digunakan aplikasi
├── _redirects               # Routing untuk Netlify Functions & fallback SPA
├── ENV_SETUP.md             # Panduan set environment variables di Netlify
├── petokpredict.png         # Ikon/OG image
└── README.md
```

## Konfigurasi Lingkungan (Env)

Semua rahasia disajikan ke klien melalui endpoint serverless `/api/config`. Ikuti panduan lengkap di `ENV_SETUP.md`. Ringkasannya:

Environment variables yang dibutuhkan (di Netlify):

- S_URL: Supabase Project URL (mis. https://xxxxx.supabase.co)
- ANON_KEY: Supabase anon/public key
- GCID: Google OAuth Client ID (GIS)
- CAPTCHA_KEY: hCaptcha site key (opsional; untuk verifikasi saat menyimpan riwayat)
- GROQ_API_KEY: Groq API key untuk fitur AI advisor

Endpoint terkait:

- GET `/api/config` → mengembalikan JSON: `supabaseUrl`, `supabaseKey`, `googleClientId`, `captchaKey`

Sumber harga pasar (via `/api/proxy`):
- `ayam-kampung` → PasarSegar (source: `pasarsegar`)
- `ayam-broiler` → Japfa Best (source: `japfabest`)

## Menjalankan Secara Lokal (Windows/PowerShell)

1) Clone repo ini ke komputer Anda.
2) Instal Netlify CLI (sekali saja):

```powershell
npm install -g netlify-cli
```

3) Set environment variables lokal (opsional tapi disarankan untuk menguji auth/riwayat):

```powershell
netlify env:set S_URL "https://xxxxx.supabase.co" --context dev
netlify env:set ANON_KEY "<your-anon-key>" --context dev
netlify env:set GCID "<your-google-client-id>.apps.googleusercontent.com" --context dev
netlify env:set CAPTCHA_KEY "<your-hcaptcha-site-key>" --context dev
netlify env:set GROQ_API_KEY "gsk_live_..." --context dev
```

4) Jalankan server dev Netlify:

```powershell
netlify dev
```

5) Buka http://localhost:8888

## Deployment ke Netlify

1) Push repo ini ke GitHub (atau Git provider lainnya)
2) Connect repo ke Netlify
3) Build settings:
    - Build command: (kosongkan)
    - Publish directory: `/`
4) Tambahkan environment variables (lihat bagian Env di atas/`ENV_SETUP.md`)
5) Deploy

## Integrasi Supabase (opsional, untuk Login/Riwayat/Profil)

Aplikasi memanggil beberapa RPC/tabel di Supabase. Skema contoh disediakan di repo:

- Tabel: `profiles` (profil pengguna)
- Tabel: `calculation_history` (riwayat kalkulasi)
- RPC: `save_calculation`, `get_recent_calculations`, `toggle_favorite_calculation`, `delete_calculation`, `update_user_profile`

Cara cepat menerapkan skema:
1) Buka Supabase SQL Editor
2) Jalankan berurutan: `01_create_tables.sql`, `02_security_policies.sql`, `03_functions_triggers.sql`
3) Pastikan Row Level Security aktif dan policy sesuai kebutuhan Anda

## Cara Pakai Aplikasi

1) Pilih jenis ayam (Kampung/Broiler) di kartu rangkuman atas
2) Buka kartu kedua dan gunakan tabs:
    - Asumsi Produksi: geser slider Populasi, Survival, Bobot, Harga Pakan/sak, FCR, DOC
    - Simulasi Skenario: melihat 3 skenario yang diturunkan dari Asumsi saat ini
       - Realistis = persis Asumsi
       - Optimis/Konservatif = variasi kecil di survival, FCR, bobot, DOC, dan pakan
3) Hasil (pendapatan/biaya/keuntungan) di kartu atas akan update otomatis
4) Export PDF: klik “Export PDF” untuk mengunduh ringkasan
5) Login (opsional): gunakan Google Sign-In untuk menyimpan riwayat dan mengelola profil

Catatan offline: jika harga pasar belum tersedia (misal offline), simulasi akan menampilkan “—” sampai harga berhasil dimuat. Kartu rangkuman menampilkan “Loading…” untuk harga/pendapatan selama menunggu.

## API Endpoints

### GET /api/config

Mengembalikan konfigurasi aman untuk klien.

Contoh respons:

```json
{
   "supabaseUrl": "https://xxxxx.supabase.co",
   "supabaseKey": "eyJ...",
   "googleClientId": "123456-abc.apps.googleusercontent.com",
   "captchaKey": "10000000-ffff-ffff..."
}
```

### GET /api/proxy

Query parameters:

- `source`: `pasarsegar` atau `japfabest`
- `product`: `ayam-kampung` atau `ayam-broiler`

Contoh respons:

```json
{
   "price": 28000,
   "currency": "IDR",
   "unit": "per kg",
   "title": "Ayam Kampung Potong",
   "source": "PasarSegar.co.id (Live)",
   "timestamp": "2025-10-01T10:00:00.000Z"
}
```

Perilaku offline/timeout:
- Bila sumber harga gagal diambil, endpoint tetap mengembalikan error; aplikasi akan menampilkan “Error”/“—” dan tidak memakai fallback harga default.

## Catatan Penting

- Google+ API sudah deprecated. Proyek ini memakai Google Identity Services (GIS) dengan Client ID tipe Web. Anda tidak perlu mengedit `script.js` untuk Client ID; cukup set env `GCID` dan endpoint `/api/config` akan menyediakannya ke klien.
- Tanpa Supabase yang tersetup, kalkulator tetap berjalan; hanya fitur login/riwayat/profil yang nonaktif.
- Scraper menggunakan pola regex sederhana; jika struktur situs sumber berubah, harga bisa gagal terambil. Aplikasi tidak akan menampilkan angka palsu (no preload/fallback) saat ini.

## Performa & Kompatibilitas

- Ringan: tanpa bundler, dependensi minimal (CDN)
- Scraper: Node.js built-ins saja (di Netlify Functions)
- Browser: Chrome/Edge 90+, Firefox 88+, Safari 14+

## Lisensi

MIT License — bebas digunakan untuk keperluan komersial maupun non-komersial.

---

Dibuat dengan ❤️ untuk membantu peternak ayam menganalisis keuntungan usaha mereka.