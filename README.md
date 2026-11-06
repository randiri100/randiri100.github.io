# randiri100.github.io

- **3D Viewer kabinet interaktif**: [`kabinet_viewer_online.html`](https://randiri100.github.io/kabinet_viewer_online.html)
- **Progress Tracker (LiDAR + kamera iPhone)**: [`progress/`](https://randiri100.github.io/progress/)

## Progress Tracker

Dashboard statis (tanpa server) untuk memantau progress pemasangan/perakitan dengan
membandingkan scan LiDAR iPhone terhadap model rencana 3D (GLB). Model bawaan memakai
`model.glb` (kabinet, 6 elemen).

**Alur kerja**

1. Scan area kerja dengan iPhone/iPad Pro ber-LiDAR (mis. 3d Scanner App, Polycam,
   Scaniverse, atau app open-source seperti ARKit-Scanner), ekspor ke PLY/OBJ/GLB (meter).
2. Buka `progress/` → **+ Tambah scan**, pilih file, tambahkan foto dari kamera iPhone.
3. Scan diselaraskan otomatis ke model, lalu tiap elemen dinilai dari persentase
   permukaannya yang tertutup titik scan: ✓ terpasang / ◐ sebagian / ○ belum.
4. Lihat grafik progress per tanggal, tabel elemen × scan, foto lapangan; ekspor CSV/JSON
   atau cetak ke PDF.

**Cara kerja penyelarasan** (`progress/js/analysis.js`)

- ARKit menyelaraskan sumbu Y dengan gravitasi, jadi yang dicari hanya rotasi sumbu
  vertikal + geser 3D.
- Bidang besar lingkungan (lantai, dinding > 1,5 m) dibuang dulu, lalu kandidat pose dicari
  dengan voting translasi per sudut dan dihaluskan dengan ICP (model → scan).
- Scan berikutnya memakai scan sebelumnya sebagai acuan (lantai, dinding, dan benda tetap
  sama antar sesi), sehingga arahnya tidak bisa tertukar; hasilnya dihaluskan ke model.
- Pose dipilih dengan skor = permukaan model yang tertutup scan − titik scan yang melayang
  di ruang kosong di dalam volume model.

**Batasan**

- Akurasi LiDAR iPhone ±1–2 cm: cukup untuk status per elemen, bukan untuk survey presisi.
- Elemen yang menempel langsung (< 2 cm) ke dinding/lantai yang sudah ada bisa terbaca
  terpasang padahal belum, dan sebaliknya. Gunakan koreksi status manual.
- Scan pertama dengan sangat sedikit elemen terpasang bisa salah arah; cek dan atur manual
  (tombol putar 90°/180°, lalu **Sempurnakan**).
- Data tersimpan di browser (IndexedDB) perangkat tersebut. Pakai **Ekspor proyek** untuk
  backup/pindah perangkat.
