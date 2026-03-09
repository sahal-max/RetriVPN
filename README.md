# BotVPN 1FORCR
Bot Telegram untuk manajemen layanan VPN yang terintegrasi dengan API AutoScript Potato.
Referensi awal dari [arivpnstores](https://github.com/arivpnstores), based BOT: Fightertunnel.

---

## Instalasi Otomatis Bot
Rekomendasi OS: Ubuntu 24 / Debian 12

```bash
sysctl -w net.ipv6.conf.all.disable_ipv6=1 && sysctl -w net.ipv6.conf.default.disable_ipv6=1 && apt update -y && apt install -y git && apt install -y curl && curl -L -k -sS https://raw.githubusercontent.com/harismy/BotVPN/main/start -o start && bash start sellvpn && [ $? -eq 0 ] && rm -f start
```

---

## Bot Telegram
[Menuju Bot Cihuyyyyy](https://t.me/BOT1FORCR_STORE_bot)

---

## Fitur Bot (Aktual)

### User
- Buat akun: SSH/Ovpn, VMESS, VLESS, TROJAN, ZIVPN, UDP HTTP.
- Trial akun harian (1x per user per hari).
- Perpanjang akun semua layanan (termasuk UDP HTTP dan ZIVPN).
- Lihat akun saya: akun aktif, semua akun, dan akun expired.
- Hapus akun saya:
  - pilih server sesuai role (user biasa hanya server user, reseller hanya server reseller),
  - hapus akun dari daftar akun aktif milik sendiri,
  - sisa masa aktif dikonversi ke saldo.
- Cek masa aktif akun saya:
  - pilih server lalu input username,
  - bot cek ke API tunnel dan menampilkan layanan, tanggal expired, dan sisa hari aktif,
  - daftar server dedup per hostname (hostname yang sama tidak dobel).
- Tools user: Perpanjang akun, Cek Server, V2Ray Setting HC.
- Top up saldo:
  - otomatis (QRIS API),
  - manual QRIS (opsional, bisa diaktif/nonaktifkan admin),
  - bonus top up per range nominal (opsional, bisa diaktif/nonaktifkan admin).
- Menu jadi reseller dengan kontak admin dinamis (WA/Telegram dari pengaturan admin).

### Reseller
- Akses server reseller.
- Menu lock/unlock akun.
- Statistik reseller pribadi.
- Evaluasi syarat reseller bulanan + notifikasi pengingat otomatis.

### Admin
- Dashboard admin: User, Server, Saldo, Reseller, Tools, Topup.
- Tools admin:
  - Backup Database Sekarang,
  - Restore Database (upload backup untuk `sellvpn.db` / `ressel.db`).
- Manajemen user/saldo: tambah saldo, hapus saldo, cek user, hapus log.
- Broadcast ke semua user.
- Manajemen reseller: tambah/hapus/restore reseller, atur syarat, trigger cek syarat.
- Manajemen server:
  - tambah server user/reseller,
  - atur support layanan (normal / ZIVPN / UDP HTTP),
  - edit domain/auth/harga/quota/ip limit/batas create/total create,
  - set server penuh,
  - aktifkan kembali server penuh dengan input total + batas,
  - detail/list/hapus server.
- Kontrol top up: auto/manual/bonus (aktif/nonaktif + atur persentase bonus).
- Upload QRIS dari menu admin.
- Command penting: `/admin`, `/syncservernow`, `/checkpaymentconfig`, `/helpadmin`, `/resellerstats`, `/allresellerstats`.

### Sistem dan Keandalan
- Auto migrasi kolom/tabel SQLite saat bot start.
- Menu `/start` tidak menumpuk (menu lama dibersihkan).
- Pending deposit + cleanup deposit expired.
- Logging error terstruktur untuk PM2.

---

## Update Terbaru
- Notifikasi ke grup saat akun dihapus (self delete dan menu delete reseller/admin).
- Fitur hapus akun manual by username pada menu `Hapus Akun Saya` dihapus demi keamanan.
- Menu user baru: `Cek Masa Aktif Akun Saya`.
- Pemilihan server cek masa aktif sudah dedup per hostname agar tidak dobel.
- Tools admin ditambah restore database via upload file backup.
- Trigger backup di Tools admin diarahkan ke `Backup Database Sekarang` untuk kirim backup langsung ke admin yang menekan tombol.
---

## Sinkronisasi Server Tunnel (AutoScript Potato)

API tunnel dipakai bot untuk:
- sinkron total akun aktif ke `Server.total_create_akun`,
- lookup `date_exp` akun berdasarkan username.

Trigger sinkron:
- Manual: `/syncservernow` atau tombol admin `Sync Server Sekarang`.
- Otomatis: setiap 30 menit.

Endpoint yang dipakai bot:
- `GET /internal/account-summary`
- `GET /internal/account-expiry?username=<USERNAME>`

Auth endpoint:
- Header `x-sync-token: <TOKEN>`

---

## Auto Install API Tunnel (SC Potato)
Repo installer API:
- https://github.com/harismy/apiCekTotalUserPotato

Jalankan di VPS tunnel yang sudah terpasang SC Potato:

```bash
curl -fL --retry 5 --retry-delay 2 https://raw.githubusercontent.com/harismy/apiCekTotalUserPotato/main/setup-summary-api.sh -o /tmp/setup-summary-api.sh
sed -i 's/\r$//' /tmp/setup-summary-api.sh
chmod +x /tmp/setup-summary-api.sh
bash /tmp/setup-summary-api.sh
```

### Cara pakai di bot setelah API terpasang
1. Pastikan setiap server bot punya `domain` atau `sync_host` yang menuju VPS tunnel.
2. Pastikan token bot (`Server.auth`) cocok dengan token valid di VPS tunnel (`servers.key`).
3. Jalankan sinkron manual (`/syncservernow`) untuk uji awal.
4. Cek hasil di menu `Cek Server` (terpakai/sisa/status).

Troubleshooting:
- `unauthorized`: token tidak cocok.
- `ECONNREFUSED`: service API tunnel belum jalan atau port belum terbuka.

---

## Sistem Pembayaran (Top Up Otomatis)

### Data QRIS
Gunakan tools berikut untuk extract data QRIS:
- https://qreader.online/

### Setup API Cek Payment
Input saat instalasi melalui `start` (disimpan ke `.vars.json`):
- `ORKUT_USERNAME`
- `ORKUT_TOKEN`
- API key (hubungi admin penyedia API)

Jika `ORKUT_USERNAME/ORKUT_TOKEN` belum diisi:
- Menu top up otomatis nonaktif.
- Bot memberi notifikasi ke user untuk top up manual.

---

## Database
Database utama: `sellvpn.db`

Auto migrasi saat bot start mencakup:
- tabel pending deposit,
- kolom support layanan server,
- kolom sinkronisasi server tunnel.

---

## Catatan
Simpan file dengan encoding UTF-8 agar teks dan simbol tampil normal.

