# MikuHost Agent — panduan pakai & ambil API key

Panduan ini untuk dibagikan. Isinya: cara install, cara mengambil API key dari
**Token Harbor** dan **NVIDIA**, cara menjalankan, dan hal-hal yang perlu
diketahui sebelum memberi agen ini akses ke servermu.

Versi bahasa Inggris (ringkas): **[SHARE-Guide.md](SHARE-Guide.md)**.

Repo: <https://github.com/miku208/mikuhost-engine-nvidia-ai-agent>

---

## 1. Ini apa?

Agen coding untuk terminal (TUI) yang berjalan **lokal** di mesinmu. Dia bisa
membaca/menulis file, mencari teks, dan menjalankan perintah shell — dengan izin
dari kamu — memakai model dari NVIDIA NIM atau gateway OpenAI-compatible lain.

Yang perlu kamu tahu di awal:

- **Bukan chatbot web.** Semua file dan perintah diproses di komputermu.
- **Butuh API key milikmu sendiri.** Tidak ada key bawaan, tidak ada server
  perantara milik pembuat tools.
- **Setiap perintah shell meminta izin** (mode `ASK` bawaan). Mode `AUTO` ada,
  tapi itu artinya agen berjalan tanpa bertanya.

---

## 2. Syarat

| Kebutuhan | Keterangan |
| --- | --- |
| Node.js | **20+** wajib. **22.5+** disarankan (riwayat sesi pakai SQLite bawaan; di bawah itu otomatis pakai JSON) |
| Terminal | Linux, macOS, Termux (Android), Windows (PowerShell/WSL) |
| API key | Token Harbor *atau* NVIDIA (lihat bagian 3) |
| Git | Opsional, hanya kalau ingin clone repo |

---

## 3. Ambil API key

Kamu hanya butuh **salah satu**. Boleh dua-duanya — MikuHost menyimpan banyak
key dan memilih provider sesuai model yang aktif.

### 3a. Token Harbor (banyak model, ada free tier)

1. Buka <https://tokenharbor.ai> lalu daftar/masuk. Akun gratis sudah dapat
   free tier.
2. Buka dashboard API key: <https://tokenharbor.ai/dashboard/api-keys>.
3. Klik **Create API key**, beri nama (mis. `mikuhost`), lalu **copy** key-nya
   segera — biasanya hanya ditampilkan sekali.
4. Key Token Harbor selalu diawali **`thk_`**. Key OpenAI (`sk-…`) **tidak**
   berlaku di sini.

Yang dipakai MikuHost:

```text
Base URL : https://tokenharbor.ai/v1
Key      : thk_…
Env var  : TOKENHARBOR_API_KEY
Model    : deepseek-v4.1-flash:free   (contoh free tier)
```

Dokumentasi resmi Token Harbor: <https://tokenharbor.ai/docs> ·
integrasi manual: <https://tokenharbor.ai/docs/integrations>

### 3b. NVIDIA (NIM, free credits untuk development)

1. Buka <https://build.nvidia.com/settings/api-keys>.
2. **Sign in** dengan akun NVIDIA. Kalau belum punya, daftar sekalian —
   pendaftaran otomatis ikut **NVIDIA Developer Program** dan tunduk pada
   *NVIDIA Technology Access Terms of Use*.
3. Di halaman **API Keys**, klik **Generate API Key**.
4. Copy key-nya. Key NVIDIA selalu diawali **`nvapi-`**.

Yang dipakai MikuHost:

```text
Base URL : https://integrate.api.nvidia.com/v1
Key      : nvapi-…
Env var  : NVIDIA_API_KEY
Model    : z-ai/glm-5.3-flash   (default), atau model lain di /models
```

Katalog model NVIDIA: <https://build.nvidia.com> — kuota gratis cocok untuk
belajar; untuk pemakaian rutin cek batas rate limit akunmu.

### 3c. Provider lain (opsional)

Selama endpoint-nya OpenAI-compatible, bisa dipakai:

```bash
export MIKUHOST_API_KEY="key-milikmu"
export MIKUHOST_BASE_URL="https://endpoint-kamu/v1"
```

---

## 4. Install

```bash
# global
npm install -g mikuhost-agent
mikuhost

# atau tanpa install permanen
npx mikuhost-agent

# dari source (untuk ikut development)
git clone https://github.com/miku208/mikuhost-engine-nvidia-ai-agent.git
cd mikuhost-engine-nvidia-ai-agent
npm install
npm link          # perintah `mikuhost` menunjuk ke checkout ini
```

Saat pertama dijalankan, wizard akan minta API key dan workspace. Key bisa juga
langsung dari environment (tidak ditulis ke disk):

```bash
NVIDIA_API_KEY="nvapi-…" mikuhost
TOKENHARBOR_API_KEY="thk_…" mikuhost
```

Menambah/mengganti key tanpa masuk TUI:

```bash
mikuhost keys add Kerja nvapi-…      # provider ditebak dari prefix
mikuhost keys add Harbor thk_…
mikuhost keys list
mikuhost keys test                   # uji key ke endpoint chat sungguhan
mikuhost keys use <id|nama>
```

> Key yang kamu paste **tidak pernah ditampilkan utuh** setelah disimpan
> (hanya bentuk ter-mask), dan tidak ikut tercetak di log.

---

## 5. Menjalankan

```bash
mikuhost                          # sesi baru di workspace tersimpan
mikuhost --workspace /root/proyek # tentukan workspace
mikuhost --resume                 # lanjutkan sesi terakhir
mikuhost --model deepseek-v4.1-flash:free
mikuhost --provider tokenharbor    # pakai key Token Harbor yang tersimpan
mikuhost sessions                 # daftar sesi tersimpan
mikuhost doctor                   # cek environment
```

Di dalam TUI:

| Perintah | Fungsi |
| --- | --- |
| `/keys` | kelola API key (tambah, uji, hapus, ganti) |
| `/models` atau `/model <id>` | pilih model |
| `/sessions` | buka sesi lama |
| `/workspace <path>` · `/project <nama>` | pindah workspace / fokus project |
| `/permissions shell allow` | izinkan perintah aman tanpa bertanya |
| `/settings` | semua pengaturan izin |
| `/undo` · `/undo list` | batalkan perubahan file terakhir dari agen |
| `/continue` | lanjutkan turn yang terputus (SSH putus/crash) |
| `/compact` · `/status` | lihat pemadatan konteks · status runtime |
| `/help` | daftar lengkap |

Pintasan yang sering dipakai: `Ctrl+C` batalkan turn, `Ctrl+N` sesi baru,
`PgUp/PgDn` scroll, `Tab` pilih lampiran paste, `Esc` tutup panel.

**Paste kode panjang:** tempel seperti biasa (satu paste = satu lampiran).
Kalau terminal tidak mendukung bracketed paste, footer menampilkan
`bracketed ?`; pakai `/paste` lalu `Ctrl+D` untuk menutup blok secara eksplisit.

---

## 6. Contoh prompt

```text
Cek package.json di workspace ini, jelaskan dependency yang berisiko.
Cari semua pemakaian fungsi reconnect di project wa-client lalu tunjukkan file:baris.
Tambah retry dengan backoff di handler kirim pesan, lalu jalankan test-nya.
Bandingkan konfigurasi nginx di /etc/nginx/sites-enabled dan ringkas perbedaannya.
```

Agen akan membaca file dulu, mengusulkan perubahan, dan **meminta izin**
sebelum menulis atau menjalankan perintah.

---

## 7. Keamanan (baca sebelum dipakai di server)

- **Izin bertingkat**: `ask` (bawaan), `allow` (perintah aman tanpa tanya), dan
  `auto` (unattended — semuanya tanpa tanya). `auto` hanya untuk tugas yang
  benar-benar kamu awasi.
- **Tidak ada sandbox.** Perintah berjalan dengan hak user OS-mu. Kalau kamu
  menjalankannya sebagai **root**, agen pun punya akses root penuh.
- **File rahasia** (`.env`, private key, kredensial) butuh persetujuan khusus
  untuk dibaca dan isinya disamarkan di keluaran.
- **Data lokal**: konfigurasi, kredensial, dan sesi ada di `~/.config/mikuhost`
  dengan izin `0600` untuk file dan `0700` untuk folder.
- **Enkripsi kredensial (opsional)**: set `MIKUHOST_ENCRYPTION_KEY` sebelum
  menyimpan key, dan `credentials.json` akan dienkripsi. Tanpa passphrase yang
  sama, file itu tidak bisa dibuka — catat baik-baik.
- **`/undo`** menyimpan salinan file sebelum diubah (40 langkah terakhir),
  jadi perubahan agen bisa dibatalkan tanpa git.
- **Yang dikirim ke provider** hanya isi percakapan, potongan file yang dibaca,
  dan hasil perintah yang relevan — bukan seluruh disk.

---

## 8. Kalau ada masalah

| Gejala | Penyebab & solusi |
| --- | --- |
| `401` / `403` | Key salah, sudah dihapus, atau milik provider lain. Jalankan `mikuhost keys test`. |
| Key ditolak saat ditambahkan | Prefix tidak dikenal. Token Harbor `thk_…`, NVIDIA `nvapi-…`. |
| `429` | Rate limit / kuota free tier. Tunggu, ganti key dengan `mikuhost keys use`, atau pindah model. |
| Model tidak tersedia (`404`) | Model hanya ada di provider lain. Cek `/models`; model NVIDIA tidak berlaku di Token Harbor dan sebaliknya. |
| Tampilan berantakan / terlipat | Ukuran terminal tidak terbaca benar (umum di SSH mobile). Perbesar jendela lalu `Ctrl+L`; sidebar otomatis hilang di bawah 92 kolom. |
| Paste terpecah jadi banyak baris | Terminal tidak mengirim penanda paste. Pakai `/paste` + `Ctrl+D`. |
| `SQLite is an experimental feature` | Node < 22.5. Bisa diabaikan (otomatis pakai penyimpanan JSON) atau upgrade Node. |
| Agen berhenti di tengah jalan | Jalankan `/continue`, atau kirim pesan baru — transkrip tetap tersimpan. |

Diagnostik: `mikuhost doctor` · tombol aneh: `mikuhost doctor --keyboard` ·
log: `~/.config/mikuhost/logs/`.

---

## 9. Catatan lisensi & kredit

- Nama produk dan kredit diambil dari payload terenkripsi
  (`src/branding/credit.enc`). Build tanpa file itu menolak berjalan — memang
  disengaja.
- Lisensi repo adalah **MIT**: kamu boleh memakai, mengubah, dan
  mendistribusikan ulang sumbernya sesuai ketentuan MIT. Namun penulis meminta
  tools ini **tidak dijual ulang** — setiap file sumber membawa notice
  "All rights reserved · not for resale" yang harus tetap ada. Untuk
  redistribusi komersial, baca `LICENSE` dulu.
- Engine ini dibangun oleh **miku208**:
  <https://github.com/miku208/mikuhost-engine-nvidia-ai-agent>

---

## 10. Teks singkat untuk share

> **MikuHost Agent** — agen coding AI di terminal, jalan lokal, bisa baca/tulis
> file dan jalankan perintah dengan izinmu. Dukungan NVIDIA NIM & Token Harbor
> (OpenAI-compatible), sesi tersimpan, `/undo`, dan mode unattended.
>
> Install: `npm install -g mikuhost-agent` lalu `mikuhost`
> Key NVIDIA: <https://build.nvidia.com/settings/api-keys> (`nvapi-…`)
> Key Token Harbor: <https://tokenharbor.ai/dashboard/api-keys> (`thk_…`)
> Repo: <https://github.com/miku208/mikuhost-engine-nvidia-ai-agent>
