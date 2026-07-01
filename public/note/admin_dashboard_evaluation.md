# Evaluasi Admin Dashboard MR-CAPSULES

Setelah melakukan peninjauan terhadap file `admin.html` (Frontend) dan `api/admin.js` (Backend API), berikut adalah evaluasi lengkap mengenai sistem dashboard admin.

## 1. Arsitektur & Cara Kerja
Dashboard admin ini mengadopsi pola **Headless CMS dengan GitHub sebagai Database**.
- **Frontend (`admin.html`)**: Dibangun dengan HTML/CSS/JS murni (Vanilla). Menggunakan library Supabase JS v2 dari CDN untuk menangani login dan session.
- **Backend (`api/admin.js`)**: Merupakan Serverless Function (Vercel API) yang bertindak sebagai jembatan yang aman antara aksi dari pengguna dan GitHub API serta Supabase Admin API.
- Saat admin meng-upload, menghapus, atau mengubah nama file materi, backend akan menggunakan **GitHub REST API** untuk melakukan commit secara langsung ke repository (`alchemist4real/MR-CAPSULES`).
- Setiap ada perubahan / commit di repo GitHub, Vercel akan secara otomatis men-trigger build ulang (`npm run build` yang menjalankan `node build.js`) sehingga frontend otomatis ter-update.

## 2. Sistem Autentikasi & Otorisasi
- **Autentikasi**: Mengandalkan **Supabase Auth**. Token (JWT) dari sesi yang sedang aktif dikirim via header `Authorization` ke API.
- **Otorisasi API**: Di dalam `api/admin.js`, backend memvalidasi token JWT ke server Supabase. Setelah valid, backend mengambil daftar admin dari file `admins.json` di GitHub repo.
- **Role System**:
  - *User Biasa*: Tidak punya akses (Forbidden).
  - *Admin*: Terdapat di `admins.json`. Bisa melakukan operasi CRUD file (Upload, Delete, Rename).
  - *SuperAdmin*: Hardcoded atas nama email `muqorroben@gmail.com` atau username `alchemist4real`. Memiliki akses ekstra ke tab "Users" untuk melihat daftar user, menambah/menghapus Admin, dan Ban/Delete user di Supabase.

## 3. Poin Kelebihan (Pros)
- **Ringan & Serverless**: Sepenuhnya bergantung pada layanan pihak ketiga gratis (GitHub, Supabase, Vercel). Tidak perlu menyewa VPS atau server database (selain Auth).
- **Keamanan (Security)**: Private token GitHub (`GITHUB_TOKEN`) dan Supabase Service Role Key (`SUPABASE_SERVICE_ROLE_KEY`) aman disimpan sebagai Environment Variables di Vercel, tidak pernah diekspos ke sisi *client* browser.
- **Realtime Trigger**: Karena mengedit langsung repo, CI/CD dari Vercel berjalan sangat mulus untuk mem-build dan menyebarkan (deploy) konten terbaru.
- **UI Modern**: Dashboard cukup intuitif, responsif, dilengkapi *Dark Mode*, *Breadcrumbs navigation*, dan *Drag & Drop upload*.

## 4. Kelemahan & Potensi Masalah (Cons/Risks)
1. **GitHub API Rate Limit**: Setiap kali `api/admin.js` memvalidasi admin, ia memanggil GitHub API untuk membaca `admins.json`. Jika trafik penggunaan admin sangat tinggi, bisa rentan terkena *rate-limit* GitHub (normalnya 5.000 requests / jam untuk authenticated user).
2. **Limitasi Ukuran File**: 
   - Karena upload melewati Vercel Serverless Function (batas size payload Vercel max ~4.5MB per request pada *hobby tier*, walau file di-split ke array, tetap beresiko timeout/413 Payload Too Large).
   - Batas maksimum pembuatan file via GitHub Contents API per file adalah ~50MB. Upload video atau PDF tebal kemungkinan bisa *gagal* / *timeout*.
3. **Hardcoded Credentials**: Kunci Supabase anon key di-_hardcode_ di `admin.html` dan juga `api/admin.js`. Meski anon key relatif aman terbuka, di `api/admin.js` lebih baik dibaca via `process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY` atau sejenisnya.
4. **Hardcoded SuperAdmin**: Email SuperAdmin statis di kode, kurang fleksibel bila struktur kepengurusan platform berubah di masa depan.
5. **Penghapusan Folder**: Tidak dapat menghapus folder langsung secara rekursif via UI karena GitHub Contents API mendesain repositori *git* sedemikian rupa bahwa folder hanya eksis jika ada file di dalamnya (sehingga ada fitur `.gitkeep` dummy file).

## Kesimpulan
Sistem ini dibuat dengan pendekatan **Git-Backed CMS** yang sangat *cost-effective*, aman, dan brilian untuk project pelajar nirlaba. Meskipun ada batasan pada API dan ukuran file besar, sistem ini sudah sangat matang untuk mengelola file `.html` dan gambar cover ringan. Saran pengembangan ke depannya adalah menambahkan *caching* untuk `admins.json` di dalam API agar tidak memanggil GitHub berulang kali setiap *request* dari dashboard admin.
