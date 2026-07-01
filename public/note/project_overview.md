# MR-CAPSULES Project Overview

## Deskripsi
MR-CAPSULES adalah platform edukasi nirlaba berbasis web yang dirancang untuk menyimpan dan membagikan materi akademik (lecture notes, question banks, PPT/PDF dosen, dll) untuk mahasiswa. Platform ini dibangun menggunakan teknologi web statis dasar yang ringan dan cepat.

## Teknologi (Tech Stack)
- **Frontend**: HTML5, CSS3, Vanilla JavaScript.
- **Backend / Build System**: Node.js (`build.js`).
- **Deployment**: Vercel.
- **Data Storage**: Tidak ada database backend (seperti SQL/NoSQL). Data di-generate secara statis menjadi file JS lokal (`data.js`).

## Struktur Folder Utama
- `index.html`: Halaman utama / UI dari web (Frontend).
- `admin.html`: Halaman dashboard untuk keperluan admin.
- `content/`: Folder tempat semua materi belajar disimpan dalam bentuk `.html`. Direktori ini sangat terstruktur berdasarkan `Semester -> Block -> Kategori_NamaFile.html`.
- `cover/`: Folder aset gambar atau gif untuk cover materi pembelajaran.
- `build.js`: Skrip Node.js untuk mengekstrak dan membaca seluruh file `.html` di `content/`. Skrip ini yang bertugas membuat/membangun file `data.js`.
- `data.js`: Hasil dari eksekusi `build.js`. Memuat variabel global `window.appData` berupa objek JSON dari struktur folder dan file, yang mana nantinya diload oleh frontend untuk menampilkan list navigasi / materi.

## Alur Kerja (Workflow)
1. **Penambahan Konten**: File HTML materi (atau hasil convert) ditambahkan ke sub-direktori yang tepat di dalam folder `content/`. Penamaan file menggunakan konvensi `Kategori_Nama.html` (contoh: `1.2 Ident PK_Flashcard PK.html`).
2. **Build Data**: Setelah materi baru ditambahkan, jalankan `npm run build` atau `node build.js`. Skrip ini akan melakukan "crawling" direktori dan me-regenerate `data.js`.
3. **Frontend Display**: `index.html` memuat `data.js` sehingga daftar file terbaru akan muncul otomatis secara dinamis ke user, tanpa perlu update manual di file HTML utama.

## Catatan Penting untuk Pengembangan
- **Pembuatan UI/Tampilan**: Semua kodingan terkait layout ada di `index.html` (dan mungkin styling terkait).
- **Proses Parsing Nama File**: `build.js` akan memisahkan nama file berdasarkan karakter underscore `_`. Bagian sebelum `_` akan jadi Kategori, bagian setelahnya jadi Judul File. Jika tidak ada `_`, maka kategori default adalah "Other".
- **Deployment**: Melalui Vercel secara otomatis dari GitHub (`vercel.json` sudah ada).
