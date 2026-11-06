# randiri100.github.io

- **Progress fit-out (LiDAR + kamera iPhone)**: [`progress/`](https://randiri100.github.io/progress/)
- **3D Viewer kabinet interaktif**: [`kabinet_viewer_online.html`](https://randiri100.github.io/kabinet_viewer_online.html)

## Progress fit-out

Dashboard statis (tanpa server) untuk memantau progress fit-out, misalnya restoran di unit
mall, dengan membandingkan scan LiDAR iPhone mingguan terhadap model rencana 3D, plus foto
kamera iPhone untuk pekerjaan finishing. Buka **Menu → Muat data demo** untuk melihat contoh
restoran 16 × 12 m dengan 5 scan mingguan.

**Alur kerja mingguan**

1. **Model rencana**: ekspor desain dari SketchUp (Collada `.dae` / OBJ), Revit (FBX/OBJ), atau
   GLB. Susun per grup *Kategori → Pekerjaan*. Grup bernama *Eksisting / Shell / Struktur /
   Kolom* = bangunan mall (acuan penyelarasan, tidak dihitung progress). Nama berisi *cat,
   keramik, kaca, wallpaper, …* otomatis dinilai dari foto.
2. **Scan LiDAR** unit dengan iPhone/iPad Pro (3d Scanner App, Polycam, Scaniverse, dll.),
   ekspor PLY/OBJ/GLB, lalu **+ Tambah scan**.
3. Scan pertama diselaraskan ke model; scan berikutnya ke scan sebelumnya lalu dihaluskan ke
   model. Koridor mall di luar unit dibuang.
4. Tiap pekerjaan dinilai dari persentase permukaannya yang tertutup titik scan:
   ✓ selesai / ◐ dikerjakan / ○ belum. Pekerjaan yang kemudian tertutup (ducting di atas
   plafon) tetap selesai. Finishing diisi manual dengan bukti foto per pekerjaan.
5. **Bobot** pekerjaan (mis. dari RAB) dan **jadwal kurva S** → progress berbobot, deviasi vs
   rencana, tabel per kategori, CSV, cetak PDF untuk laporan mingguan.

**Cara kerja penyelarasan** (`progress/js/analysis.js`)

- Sumbu Y ARKit = gravitasi, jadi yang dicari hanya rotasi sumbu vertikal + geser 3D.
- Kandidat pose: korelasi 2D "denah" irisan setinggi dinding (arah dinding dominan + kelipatan
  90°), lalu ICP model→scan. Pose dipilih dengan skor = permukaan model yang tertutup scan −
  titik scan yang melayang di ruang kosong.
- Scan di-voxel 2 cm; grid hash typed array supaya jutaan titik tetap ringan.

**Batasan**

- Akurasi LiDAR iPhone ±1–2 cm (jangkauan ±5 m): cukup untuk status per pekerjaan, bukan
  survey presisi. Kaca tembus LiDAR; cat/keramik terlalu tipis → dinilai dari foto.
- Pekerjaan yang menempel < 3 cm ke permukaan lain bisa terbaca salah; koreksi manual tersedia.
- Unit yang sangat simetris bisa membuat scan pertama salah arah: cek, pakai tombol putar
  90°/180°, lalu **Sempurnakan**.
- Data tersimpan di browser (IndexedDB) perangkat itu. Pakai **Ekspor proyek** untuk backup.
