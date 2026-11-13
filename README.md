# Multi-Seller AI Marketplace

Adaptasi [proyek BensonRaro](https://github.com/BensonRaro/mernstack-ecommerce-multi-seller-marketplace/tree/403626bf350c32cf2b7033a486e76dd263ef21a2). Frontend memakai React Router. Backend memakai Express, TypeScript, Better Auth, dan MySQL melalui `mysql2`.

## Menjalankan di lokal

Butuh Bun 1.4.4, Node.js 24, dan MySQL 8.0/8.4. Buat database kosong bernama `marketplace` dengan kolasi `utf8mb4_unicode_ci`. Salin `backend/.env.example` ke `backend/.env`, isi kredensial MySQL, dan buat `BETTER_AUTH_SECRET` dengan `openssl rand -hex 32`.

```bash
cd backend
bun install --frozen-lockfile
bun run db:migrate
bun run dev
```

Di terminal kedua, dari root repo:

```bash
cd frontend
bun install --frozen-lockfile
bun run dev
```

Buka [localhost:5173](http://localhost:5173). Vite meneruskan `/api/*` ke backend pada port 5000. Cek database melalui [localhost:5173/health](http://localhost:5173/health).

## Deploy di Linode

Instruksi ini menjalankan frontend, API, dan MySQL pada VPS yang sama. Caddy menyediakan HTTPS dan meneruskan `/api/*` ke Express. Pakai domain marketplace dan arahkan DNS ke VPS. Jika sudah ada reverse proxy, tambahkan rute yang sama pada proxy tersebut.

### Siapkan MySQL

Jalankan sebagai admin MySQL di Linode. Ganti kedua password contoh. Simpan kredensial migrator untuk proses deploy dan gunakan kredensial aplikasi untuk layanan API.

```sql
CREATE DATABASE IF NOT EXISTS marketplace
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER 'marketplace_migrator'@'127.0.0.1' IDENTIFIED BY 'GANTI_PASSWORD_MIGRATOR';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES
  ON marketplace.* TO 'marketplace_migrator'@'127.0.0.1';

CREATE USER 'marketplace_app'@'127.0.0.1' IDENTIFIED BY 'GANTI_PASSWORD_APLIKASI';
GRANT SELECT, INSERT, UPDATE, DELETE
  ON marketplace.* TO 'marketplace_app'@'127.0.0.1';
```

Untuk API pada VPS yang sama, isi `DB_HOST=127.0.0.1` dan `DB_PORT=3306`. Untuk API pada host terpisah, isi `DB_HOST=mysql.teguhharits.com` jika DNS dan akses MySQL telah dikonfigurasi, batasi port 3306 ke IP API, dan isi `DB_TLS_CA_FILE` dengan path sertifikat CA MySQL yang dipercaya. Sesuaikan host pada akun MySQL dengan asal koneksi.

### Pasang aplikasi dan jalankan migrasi

Pasang Bun 1.4.4 di `/usr/local/bin/bun`, Node.js 24 yang tersedia pada PATH systemd, dan Caddy. Buat user layanan `marketplace` serta checkout di `/opt/marketplace`.

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin marketplace
sudo install -d -o marketplace -g marketplace /opt/marketplace
sudo -u marketplace git clone https://github.com/teguhdev97/mern-multi-seller-ai-marketplace.git /opt/marketplace
cd /opt/marketplace
sudo install -m 600 -o marketplace -g marketplace backend/.env.example backend/.env
sudoedit backend/.env
```

Isi `NODE_ENV=production`, `BETTER_AUTH_URL` dan `FRONTEND_URL` dengan URL HTTPS marketplace tanpa slash di akhir, serta `BETTER_AUTH_SECRET`. Isi `DB_DATABASE=marketplace`, `DB_USERNAME=marketplace_app`, dan password aplikasi. Buat `backend/.env.migrate` dengan mode `600` dan owner `marketplace` yang berisi `DB_USERNAME=marketplace_migrator` dan password migrator.

```bash
cd /opt/marketplace/backend
sudo -u marketplace /usr/local/bin/bun install --frozen-lockfile
sudo -u marketplace /usr/local/bin/bun --env-file=.env --env-file=.env.migrate run src/db/migrate.ts

cd /opt/marketplace/frontend
sudo -u marketplace /usr/local/bin/bun install --frozen-lockfile
sudo -u marketplace /usr/local/bin/bun run build

cd /opt/marketplace
sudo install -m 644 deploy/linode/marketplace-{api,web}.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now marketplace-api marketplace-web
```

Masukkan blok di [Caddyfile](deploy/linode/Caddyfile) ke konfigurasi Caddy yang aktif dan ganti `marketplace.example.com` dengan domainmu. Validasi dan reload.

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl --fail https://marketplace.example.com/health
```

Daftar melalui UI, lalu promosikan akun pertama secara manual dengan MySQL. Ganti email dengan alamat akun yang baru dibuat.

```sql
UPDATE marketplace.`user` SET role = 'admin' WHERE email = 'admin@example.com';
```

Login ulang untuk memuat peran admin. Gunakan dashboard admin untuk menyetujui seller dan mengelola katalog.

### Layanan opsional

| Fitur | Konfigurasi |
| --- | --- |
| Login Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, dan callback `https://<domain>/api/auth/callback/google` |
| Pembayaran kartu | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, dan webhook `https://<domain>/api/auth/stripe/webhook`. Gunakan test mode untuk verifikasi awal. Checkout proyek menggunakan USD dan satu pembayaran untuk satu pesanan. |
| Upload gambar | `UPLOADTHING_TOKEN`. Atur callback UploadThing ke domain marketplace jika diperlukan. |
| Email transaksi | `RESEND_API_KEY`, `RESEND_FROM` dari domain terverifikasi, serta kunci Inngest |
| AI seller | `GEMINI_API_KEY`, `INNGEST_EVENT_KEY`, dan `INNGEST_SIGNING_KEY`. Sinkronkan aplikasi dengan `https://<domain>/api/inngest`. |

Email/password, katalog, profil seller, dan checkout COD bisa berjalan dengan MySQL dan konfigurasi autentikasi dasar. Stripe Checkout memungut pembayaran pesanan. Payout otomatis untuk seller memerlukan implementasi terpisah. Migrasi membuat skema kosong dan tidak mengimpor data MongoDB.

## Membaca SQL backend

Tabel marketplace ada di [backend/sql/001-marketplace.sql](backend/sql/001-marketplace.sql). Better Auth memakai dialek Kysely bawaan untuk autentikasi dan migrasi tabelnya melalui pool `mysql2`. Query bisnis ditulis langsung dalam SQL. Untuk belajar SQL, mulai dari [controller produk](backend/src/controllers/product.ts), [transaksi pesanan](backend/src/controllers/order.ts), dan [pool](backend/src/db/pool.ts). Setiap nilai dalam ekspresi `sql` dikirim ke MySQL sebagai parameter `?`.

Untuk pemeriksaan kode, jalankan `bun run typecheck` pada kedua direktori dan `bun run build` pada frontend.
