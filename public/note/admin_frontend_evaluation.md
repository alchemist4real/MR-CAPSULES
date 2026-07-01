# Evaluasi Frontend Dashboard Admin MR-CAPSULES

Fokus evaluasi pada file `admin.html` ini menitikberatkan pada aspek antarmuka pengguna (UI), pengalaman pengguna (UX), responsivitas mobile (Android), dan rekomendasi penambahan fitur.

## 1. Intuitivitas (UI/UX secara Umum)
Secara desain, antarmuka `admin.html` sudah terlihat sangat modern dan bersih (menggunakan skema warna Dark Mode dengan aksen neon yellow `var(--accent)`).
**Kelebihan**:
- **Familiaritas UX**: Menggunakan struktur *file-explorer* standar (Grid/List view toggles, breadcrumb navigation, seleksi *checkbox*) yang mudah dipahami oleh siapa pun yang sering menggunakan Google Drive atau File Manager OS desktop.
- **Drag & Drop**: Fitur *drag overlay* (mendukung lempar file langsung ke area browser) meningkatkan efisiensi proses upload secara drastis.
- **Preview Cepat**: Adanya Lightbox (modal) untuk melihat preview gambar atau membaca isi teks tanpa harus mengunduh file terlebih dulu.

**Kekurangan (Isu Intuitivitas)**:
- **Tergantung pada Hover (Hover-dependent UI)**: Tombol aksi *Rename* dan *Delete* pada setiap baris file hanya muncul saat kursor *mouse-hover* (`.file-item:hover .file-actions { opacity: 1; }`). Pengguna baru mungkin akan bingung mencari tahu cara mengedit atau menghapus sebuah file pada pandangan pertama sebelum mereka menggerakkan kursor ke atas file tersebut.

## 2. Aksesibilitas Mobile (Untuk Pengguna Android / Smartphone)
Saat ini, **kode CSS tidak memiliki `@media` queries sama sekali**. Ini berarti tampilan admin sangat *Desktop-centric* dan akan "hancur" jika dibuka melalui *smartphone* Android/iOS.
**Bagaimana Seharusnya UI di Android:**
- **Toolbar Buttons**: Bagian `.toolbar` (Upload, New Folder, dsb) memakai `display: flex` tanpa `flex-wrap`. Di Android, deretan tombol ini akan meluap keluar layar (overflow). Seharusnya tambahkan `flex-wrap: wrap;` atau jadikan ikon saja pada layar sempit, serta ubah posisinya menjadi vertikal/menu lipat (hamburger menu) jika terlalu sempit.
- **Masalah Action Buttons (Hover tidak ada di Android)**: Karena perangkat sentuh (Android) tidak memiliki fungsi *hover*, tombol *Rename* dan *Delete* pada tiap file tidak akan terlihat, atau hanya terlihat sebentar saat file di-*tap*.
  **Solusi Android**: Pada layar mobile, ubah `.file-actions { opacity: 1; display: block; }` (selalu terlihat) atau sediakan tombol titik tiga (`⋮`) / menu hamburger mini (kebab menu) pada ujung kanan layar ponsel yang jika disentuh akan memunculkan popup menu *Rename/Delete/Preview*.
- **Grid Layout**: Pada grid view (`minmax(140px, 1fr)`), ukuran di handphone kecil bisa membuat layar penuh berdesakan. Mungkin turunkan `minmax` menjadi 100px di layar mobile.
- **Long File Names**: Jika nama materi sangat panjang, ini dapat mendorong elemen *breadcrumbs* (`.path-bar`) menembus ukuran layar handphone. Perlu diatur `text-overflow: ellipsis;` dan properti limitasi baris pada versi mobile.

## 3. Rekomendasi Penambahan Fitur (Feature Requests)
Untuk memperkuat fungsi *Content Manager*, berikut adalah fitur-fitur yang sangat disarankan untuk ditambahkan:
1. **Search / Filter Bar (Pencarian Lokal)**: Kolom input sederhana di atas untuk mem-filter nama file. Berguna ketika masuk ke folder "Semester X" yang isinya mencapai puluhan HTML.
2. **Move / Cut File**: Saat ini hanya ada fitur "Rename" dan "Upload". Jika admin tak sengaja menaruh materi di folder/block yang salah, mereka harus mengunduh ulang (atau copas isinya) lalu upload lagi ke tempat yang benar. Fitur pemindahan (Move to..) akan sangat menghemat waktu.
3. **Download File**: Menyediakan tombol untuk langsung men-download isi file `.html` (berguna untuk korektor material).
4. **HTML / Markdown Built-in Editor**: Platform ini berisi modul pelajaran yang berbasis HTML murni. Alangkah luar biasa jika di dashboard admin ditambahkan alat seperti **CodeMirror** atau **Monaco Editor** sehingga kontributor bisa mengklik tombol "Edit Code" pada file `.html` lalu mengubah isinya secara langsung (mengedit typo soal, mengganti format tulisan) dari browser, lalu klik `Save` yang mana akan langsung menimpa file di GitHub.
5. **Konfirmasi Prompt Visual**: Alert/Prompt yang saat ini digunakan adalah native JS `prompt()` dan `confirm()`. Untuk nuansa platform yang lebih elegan dan seragam, ini bisa diganti dengan Modal Pop-up kustom (seperti dialog konfirmasi).
