// appcontroller.js - Alpine.js App Controller
// Semua aksi tambah / ubah / hapus berjalan lewat modal:
//  - modal form  : produk, restok, penjualan (error validasi tampil di dalam modal)
//  - modal konfirmasi: pengganti confirm() bawaan browser untuk hapus / batalkan

document.addEventListener('alpine:init', () => {
    // Nilai awal form (fungsi, supaya selalu objek baru)
    const blankProduct = () => ({ name: '', category: 'Pakaian', base_price: '', sell_price: '', stock: '' });
    const blankPurchase = () => ({ supplier: '', shipping_cost: '', items: [{ product_id: '', qty: 1, base_price: '' }] });
    const blankSale = () => ({
        channel: 'Shopee',
        status: 'Pending', // dipakai hanya untuk online; offline otomatis Selesai
        packing_fee: 2000,
        platform_admin_fee: '',
        seller_shipping: '',
        items: [{ product_id: '', qty: 1, sell_price: '' }]
    });
    const blankConfirm = () => ({ show: false, title: '', message: '', confirmText: 'Ya', cancelText: 'Batal', danger: true, action: null });

    // Urutan alur pesanan online
    const STATUS_FLOW = ['Pending', 'Dibayar', 'Dikirim', 'Selesai'];
    // Pesanan "aktif" = online yang belum selesai / batal. Sisanya masuk Riwayat.
    const ACTIVE_STATUSES = ['Pending', 'Dibayar', 'Dikirim'];
    const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

    Alpine.data('olshopApp', () => ({
        activeTab: 'dashboard',

        products: [],
        purchases: [],
        sales: [],

        newProduct: blankProduct(),
        newPurchase: blankPurchase(),
        newSale: blankSale(),

        editingProductId: null, // null = mode tambah
        editingPurchaseId: null,
        editingSaleId: null,    // null = mode tambah

        // Status tampil/sembunyi tiap modal
        showProductModal: false,
        showPurchaseModal: false,
        showSaleModal: false,
        confirmDlg: blankConfirm(),
        modalError: '',         // pesan error di dalam modal form yang sedang terbuka

        saleFilter: 'all',      // filter pesanan aktif (tab Penjualan)

        // ---- Dashboard ----
        videoSrc: 'video.mp4',          // ganti dengan video milikmu (mp4/webm, tanpa suara)
        videoPoster: 'assets/dashboard-poster.jpg', // gambar saat video belum siap
        videoFailed: false,                         // true kalau file video tidak ditemukan
        soundOn: false,                             // suara video (mulai senyap: aturan autoplay browser)
        userPaused: false,                          // true kalau pengguna memilih "kurangi gerakan"
        dashMonth: Report.empty(),                  // laporan bulan ini (vs bulan lalu)
        dashWeek: Report.empty(),                   // laporan 7 hari terakhir (untuk grafik)

        // ---- Riwayat & laporan ----
        period: 'month',        // periode laporan (menyaring semua yang ada di tab Riwayat)
        customFrom: '',
        customTo: '',
        periods: Report.PERIODS,
        report: Report.empty(), // hasil hitungan periode ini (diisi recompute())
        chartTable: false,      // tampilan tabel sebagai pengganti grafik
        histStatus: 'all',      // all | Selesai | Batal
        histChannel: 'all',
        histSearch: '',
        histSort: 'new',        // new | old | high | low
        histLimit: 20,          // jumlah baris yang ditampilkan (tombol "Tampilkan lagi")
        histBase: [],           // riwayat dalam periode (belum disaring status/channel/cari)
        histList: [],           // riwayat setelah semua filter & urutan
        showDetailModal: false,
        showDataModal: false,   // modal Data & backup
        lastBackup: Backup.lastBackup(), // waktu backup terakhir (ISO) atau null
        detailId: null,

        // Daftar tab (dipakai navigasi atas di desktop & bottom bar di HP)
        tabs: [
            { key: 'dashboard', label: 'Dashboard', icon: 'chart' },
            { key: 'products',  label: 'Produk',    icon: 'box' },
            { key: 'purchases', label: 'Restok',    icon: 'cart' },
            { key: 'sales',     label: 'Penjualan', icon: 'cash' },
            { key: 'history',   label: 'Riwayat',   icon: 'receipt' }
        ],

        // Label, warna badge, dan teks tombol "lanjut" untuk tiap status.
        // `action` = teks tombol yang memindahkan pesanan DARI status ini ke langkah berikutnya.
        // `short` = label singkat untuk indikator progres di kartu.
        statusInfo: {
            Pending:  { icon: 'clock', label: 'Menunggu Bayar',   short: 'Menunggu', badge: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',       action: 'Tandai Sudah Dibayar' },
            Dibayar:  { icon: 'card', label: 'Sudah Dibayar',    short: 'Dibayar',  badge: 'bg-blush-100 text-brand-700 ring-1 ring-blush-300',      action: 'Tandai Dikirim' },
            Dikirim:  { icon: 'truck', label: 'Dalam Pengiriman', short: 'Dikirim',  badge: 'bg-brand-100 text-brand-800 ring-1 ring-brand-200',      action: 'Selesaikan Transaksi' },
            Selesai:  { icon: 'check-circle', label: 'Selesai',          short: 'Selesai',  badge: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200', action: '' },
            Batal:    { icon: 'x-circle', label: 'Batal',            short: 'Batal',    badge: 'bg-slate-100 text-slate-500 ring-1 ring-slate-200',      action: '' }
        },
        statusFlow: STATUS_FLOW,

        // Tab filter pesanan aktif: Semua + tiga tahap yang belum selesai
        get filterOptions() {
            return [
                { key: 'all', label: 'Semua' },
                ...ACTIVE_STATUSES.map(k => ({ key: k, label: this.statusInfo[k].label }))
            ];
        },
        // Tab filter di Riwayat
        get histStatusOptions() {
            return [
                { key: 'all', label: 'Semua' },
                { key: 'Selesai', label: 'Selesai' },
                { key: 'Batal', label: 'Batal' }
            ];
        },

        // Ikon SVG (lihat icons.js): dipakai di template lewat x-html="icon('nama', 'kelas')"
        icon(name, cls) { return Icons.svg(name, cls); },

        // Notifikasi non-blocking untuk aksi di luar modal (mis. ganti status, hapus)
        toast: { show: false, msg: '', type: 'ok' },
        notify(msg, type = 'ok') {
            this.toast = { show: true, msg, type };
            clearTimeout(this._toastTimer);
            this._toastTimer = setTimeout(() => { this.toast.show = false; }, type === 'error' ? 5000 : 2500);
        },

        init() {
            // Ingat tab terakhir agar refresh tidak kembali ke Dashboard
            try {
                const t = localStorage.getItem('olshop_tab');
                if (this.tabs.some(x => x.key === t)) this.activeTab = t;
            } catch (e) {}
            this.$watch('activeTab', t => {
                try { localStorage.setItem('olshop_tab', t); } catch (e) {}
                window.scrollTo(0, 0);
            });
            // Filter riwayat & periode: hitung ulang laporan dan daftar
            ['period', 'customFrom', 'customTo', 'histStatus', 'histChannel', 'histSearch', 'histSort'].forEach(k =>
                this.$watch(k, () => { this.histLimit = 20; this.recompute(); }));
            // Grafik digambar saat tab Riwayat dibuka / tampilan grafik-tabel diganti
            this.$watch('activeTab', t => { this.renderCharts(60); this.syncVideo(); });
            // Hormati pengaturan "kurangi gerakan": video tidak diputar otomatis
            try {
                if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                    this.userPaused = true;
                    this.$nextTick(() => this.syncVideo());
                }
            } catch (e) {}
            this.$watch('chartTable', () => this.renderCharts(0));
            this.refreshData();
        },

        refreshData() {
            this.products = DB.getProducts();
            this.purchases = DB.getPurchases();
            this.sales = DB.getSales();
            this.recompute();
        },

        // =====================================================================
        // INFRASTRUKTUR MODAL (fokus, keyboard, error)
        // =====================================================================
        get anyModalOpen() {
            return this.showProductModal || this.showPurchaseModal || this.showSaleModal || this.showDetailModal || this.showDataModal || this.confirmDlg.show;
        },
        // Simpan elemen yang sedang fokus, lalu kembalikan saat modal ditutup
        rememberFocus() { this._lastFocus = document.activeElement; },
        restoreFocus() {
            const el = this._lastFocus; this._lastFocus = null;
            if (el && typeof el.focus === 'function') setTimeout(() => el.focus(), 0);
        },
        // Fokus ke elemen [data-autofocus] pertama di dalam modal (menunggu animasi mulai)
        focusFirst(rootId) {
            setTimeout(() => {
                const root = document.getElementById(rootId);
                const target = root && root.querySelector('[data-autofocus]');
                if (target) target.focus();
            }, 80);
        },
        // Jaga agar Tab tidak keluar dari modal (focus trap)
        trapTab(e) {
            const root = e.currentTarget;
            const f = [...root.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
                .filter(el => el.offsetParent !== null);
            if (!f.length) return;
            const first = f[0], last = f[f.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        },
        // Esc menutup modal paling atas
        closeTopModal() {
            if (this.confirmDlg.show) this.confirmNo();
            else if (this.showSaleModal) this.closeSaleModal();
            else if (this.showPurchaseModal) this.closePurchaseModal();
            else if (this.showProductModal) this.closeProductModal();
            else if (this.showDetailModal) this.closeDetail();
            else if (this.showDataModal) this.closeDataModal();
        },
        // Tampilkan error di dalam modal dan gulir ke atas supaya terlihat
        setModalError(msg) {
            this.modalError = msg;
            this.$nextTick(() => {
                document.querySelectorAll('.modal-body').forEach(el => el.scrollTo({ top: 0, behavior: 'smooth' }));
            });
        },

        // ---------- Modal konfirmasi (pengganti confirm()) ----------
        ask(opts) {
            this.rememberFocus();
            this.confirmDlg = { ...blankConfirm(), ...opts, show: true };
            this.focusFirst('dlg-confirm');
        },
        confirmYes() {
            const act = this.confirmDlg.action;
            this.confirmDlg.show = false;
            this.restoreFocus();
            if (typeof act === 'function') act();
        },
        confirmNo() {
            this.confirmDlg.show = false;
            this.restoreFocus();
        },

        // =====================================================================
        // DASHBOARD
        // =====================================================================
        get totalAssetValue() {
            return this.products.reduce((sum, p) => sum + (p.base_price * p.stock), 0);
        },
        // Apakah tanggal ISO jatuh di bulan & tahun berjalan?
        isThisMonth(iso) {
            const d = new Date(iso), now = new Date();
            return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
        },
        // Pesanan Selesai yang uangnya masuk bulan ini (data lama tanpa completed_at memakai tanggal transaksi)
        get monthSales() {
            return this.sales.filter(s => s.status === 'Selesai' && this.isThisMonth(s.completed_at || s.date));
        },
        get totalMonthRevenue() {
            return this.monthSales.reduce((sum, s) => sum + s.summary.gross_revenue, 0);
        },
        get totalMonthProfit() {
            return this.monthSales.reduce((sum, s) => sum + s.summary.net_profit, 0);
        },
        // Omset pesanan online yang sudah dibayar tapi belum selesai (belum dihitung sebagai pendapatan)
        get inProgressRevenue() {
            return this.sales
                .filter(s => s.status === 'Dibayar' || s.status === 'Dikirim')
                .reduce((sum, s) => sum + s.summary.gross_revenue, 0);
        },
        // Jumlah pesanan online yang masih berjalan (belum selesai / batal)
        get activeOrderCount() {
            return this.activeSales.length;
        },
        get lowStockProducts() {
            return this.products.filter(p => p.stock <= 3);
        },

        // Sapaan & tanggal di kepala dashboard
        get greeting() {
            const h = new Date().getHours();
            return h < 11 ? 'Selamat pagi' : h < 15 ? 'Selamat siang' : h < 18 ? 'Selamat sore' : 'Selamat malam';
        },
        get todayLabel() {
            return new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        },
        // Hal yang perlu ditindaklanjuti (hanya yang jumlahnya > 0)
        get attention() {
            const c = this.saleCounts;
            return [
                { key: 'Pending', icon: 'clock', label: 'Menunggu pembayaran', count: c.Pending, tab: 'sales', filter: 'Pending', tone: 'amber' },
                { key: 'Dibayar', icon: 'card', label: 'Sudah dibayar, perlu dikirim', count: c.Dibayar, tab: 'sales', filter: 'Dibayar', tone: 'brand' },
                { key: 'Dikirim', icon: 'truck', label: 'Dalam pengiriman', count: c.Dikirim, tab: 'sales', filter: 'Dikirim', tone: 'brand' },
                { key: 'stok', icon: 'alert', label: 'Stok hampir habis', count: this.lowStockProducts.length, tab: 'products', filter: null, tone: 'red' }
            ].filter(a => a.count > 0);
        },
        goTo(tab, filter = null) {
            if (filter) this.saleFilter = filter;
            this.activeTab = tab;
        },
        // 5 transaksi terakhir (semua jenis), terbaru di atas
        get recentSales() {
            return [...this.sales].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5);
        },
        // Video latar: tombol suara; video otomatis berhenti saat tab lain dibuka
        toggleSound() {
            const v = this.$refs && this.$refs.heroVideo;
            this.soundOn = !this.soundOn;
            if (!v) return;
            v.muted = !this.soundOn;
            if (this.soundOn) { v.volume = 0.6; if (v.paused) { const r = v.play(); if (r && r.catch) r.catch(() => {}); } }
        },
        syncVideo() {
            const v = this.$refs && this.$refs.heroVideo;
            if (!v) return;
            if (this.activeTab === 'dashboard' && !this.userPaused) { const r = v.play(); if (r && r.catch) r.catch(() => {}); }
            else { v.pause(); }
        },

        // =====================================================================
        // PRODUK: tambah / edit / hapus
        // =====================================================================
        openProductModal(p = null) {
            this.rememberFocus();
            this.editingProductId = p ? p.id : null;
            this.newProduct = p
                ? { name: p.name, category: p.category, base_price: p.base_price, sell_price: p.sell_price, stock: p.stock }
                : blankProduct();
            this.modalError = '';
            this.showProductModal = true;
            this.focusFirst('dlg-product');
        },
        closeProductModal() {
            this.showProductModal = false;
            this.modalError = '';
            this.restoreFocus();
        },
        // Margin per pcs untuk pratinjau di form
        get productMargin() { return num(this.newProduct.sell_price) - num(this.newProduct.base_price); },
        get productMarginPct() {
            const sell = num(this.newProduct.sell_price);
            return sell > 0 ? Math.round((this.productMargin / sell) * 100) : 0;
        },
        submitProduct() {
            const wasEditing = !!this.editingProductId;
            const result = wasEditing
                ? DB.updateProduct(this.editingProductId, this.newProduct)
                : DB.addProduct(this.newProduct);
            if (!result.ok) { this.setModalError(result.error); return; }

            this.closeProductModal();
            this.refreshData();
            this.notify(wasEditing ? 'Produk berhasil diperbarui' : 'Produk berhasil ditambahkan');
        },
        deleteProduct(p) {
            this.ask({
                title: 'Hapus produk?',
                message: `“${p.name}” akan dihapus dari daftar produk. Riwayat transaksi lama tetap tersimpan.`,
                confirmText: 'Hapus produk',
                action: () => {
                    const result = DB.deleteProduct(p.id);
                    if (!result.ok) { this.notify(result.error, 'error'); return; }
                    this.refreshData();
                    this.notify('Produk dihapus');
                }
            });
        },

        // =====================================================================
        // RESTOK
        // =====================================================================
        // prefill = produk yang ingin langsung dipilih (mis. dari peringatan stok menipis)
        openPurchaseModal(prefill = null) {
            this.rememberFocus();
            this.editingPurchaseId = null;
            this.newPurchase = blankPurchase();
            if (prefill) {
                this.newPurchase.items[0].product_id = prefill.id;
                this.newPurchase.items[0].base_price = prefill.base_price;
            }
            this.modalError = '';
            this.showPurchaseModal = true;
            this.focusFirst('dlg-purchase');
        },
        // r = catatan restok yang diubah
        editPurchase(r) {
            this.rememberFocus();
            this.editingPurchaseId = r.id;
            this.newPurchase = {
                supplier: r.supplier,
                shipping_cost: r.shipping_cost,
                items: r.items.map(i => ({ product_id: i.product_id, qty: i.qty, base_price: i.base_price }))
            };
            this.modalError = '';
            this.showPurchaseModal = true;
            this.focusFirst('dlg-purchase');
        },
        deletePurchase(r) {
            this.ask({
                title: 'Hapus catatan restok?',
                message: `${r.id} (${r.items.reduce((n, i) => n + i.qty, 0)} pcs) akan dihapus. Stok produk dikurangi sesuai restok ini dan HPP dihitung mundur. Ditolak kalau sebagian barangnya sudah terjual.`,
                confirmText: 'Hapus restok',
                action: () => {
                    const result = DB.deletePurchase(r.id);
                    if (!result.ok) { this.notify(result.error, 'error'); return; }
                    this.refreshData();
                    this.notify('Restok dihapus. Stok dan HPP disesuaikan.');
                }
            });
        },
        closePurchaseModal() {
            this.showPurchaseModal = false;
            this.modalError = '';
            this.restoreFocus();
        },
        addPurchaseItemRow() {
            this.newPurchase.items.push({ product_id: '', qty: 1, base_price: '' });
        },
        removePurchaseItemRow(index) {
            this.newPurchase.items.splice(index, 1);
        },
        onProductSelectForPurchase(index) {
            const prod = this.products.find(p => p.id === this.newPurchase.items[index].product_id);
            if (prod) this.newPurchase.items[index].base_price = prod.base_price;
        },
        // Ringkasan biaya di form restok
        get previewPurchaseSubtotal() {
            return this.newPurchase.items.reduce((s, i) => s + num(i.qty) * num(i.base_price), 0);
        },
        get previewPurchaseQty() {
            return this.newPurchase.items.reduce((s, i) => s + num(i.qty), 0);
        },
        get previewPurchaseShippingPerPcs() {
            return this.previewPurchaseQty > 0 ? num(this.newPurchase.shipping_cost) / this.previewPurchaseQty : 0;
        },
        get previewPurchaseTotal() {
            return this.previewPurchaseSubtotal + num(this.newPurchase.shipping_cost);
        },
        submitPurchase() {
            const wasEditing = !!this.editingPurchaseId;
            const result = wasEditing
                ? DB.updatePurchase(this.editingPurchaseId, this.newPurchase)
                : DB.addPurchase(this.newPurchase);
            if (!result.ok) { this.setModalError(result.error); return; }
            this.closePurchaseModal();
            this.refreshData();
            this.notify(wasEditing ? 'Restok diperbarui. Stok dan HPP dihitung ulang.' : 'Restok dicatat. HPP produk dihitung ulang.');
            this.activeTab = 'purchases';
        },

        // =====================================================================
        // PENJUALAN: form (modal)
        // =====================================================================
        addSaleItemRow() {
            this.newSale.items.push({ product_id: '', qty: 1, sell_price: '' });
        },
        removeSaleItemRow(index) {
            this.newSale.items.splice(index, 1);
        },
        onProductSelectForSale(index) {
            const prod = this.products.find(p => p.id === this.newSale.items[index].product_id);
            if (prod) this.newSale.items[index].sell_price = prod.sell_price;
        },

        // Preview laba (aman dari NaN: field kosong dianggap 0)
        get previewSaleGross() {
            return this.newSale.items.reduce((sum, item) => sum + num(item.sell_price) * num(item.qty), 0);
        },
        get previewSaleHpp() {
            return this.newSale.items.reduce((sum, item) => {
                const prod = this.products.find(p => p.id === item.product_id);
                return sum + (prod ? prod.base_price : 0) * num(item.qty);
            }, 0);
        },
        get previewSaleExpenses() {
            return num(this.newSale.packing_fee) + num(this.newSale.platform_admin_fee) + num(this.newSale.seller_shipping);
        },
        get previewSaleNetProfit() {
            return this.previewSaleGross - this.previewSaleHpp - this.previewSaleExpenses;
        },

        // s = transaksi yang diedit; kosong = catat baru
        openSaleModal(s = null) {
            this.rememberFocus();
            this.editingSaleId = s ? s.id : null;
            this.newSale = s
                ? {
                    channel: s.channel,
                    status: s.status,
                    packing_fee: s.expenses.packing_fee,
                    platform_admin_fee: s.expenses.platform_admin_fee,
                    seller_shipping: s.expenses.seller_shipping,
                    items: s.items.map(i => ({ product_id: i.product_id, qty: i.qty, sell_price: i.sell_price }))
                }
                : blankSale();
            this.modalError = '';
            this.showSaleModal = true;
            this.focusFirst('dlg-sale');
        },
        closeSaleModal() {
            this.showSaleModal = false;
            this.modalError = '';
            this.restoreFocus();
        },
        submitSale() {
            const editId = this.editingSaleId;
            const wasEditing = !!editId;
            const result = wasEditing
                ? DB.updateSale(editId, this.newSale)
                : DB.addSale(this.newSale);
            if (!result.ok) { this.setModalError(result.error); return; } // mis. stok tidak cukup

            // Offline / Selesai / Batal tidak tampil di tab Penjualan: arahkan user ke Riwayat
            const toHistory = this.newSale.channel === 'Offline' || !ACTIVE_STATUSES.includes(this.newSale.status);
            this.closeSaleModal();
            this.refreshData();
            this.notify((wasEditing ? 'Transaksi diperbarui' : 'Penjualan dicatat') + (toHistory ? '. Lihat di tab Riwayat.' : ''));
        },

        // =====================================================================
        // PENJUALAN: daftar, filter, alur status
        // =====================================================================
        isOffline(s) { return s.channel === 'Offline'; },
        // Ikon kecil per channel untuk avatar kartu
        channelIcon(s) {
            return { 'Offline': 'store', 'WhatsApp': 'chat', 'TikTok Shop': 'music' }[s.channel] || 'bag';
        },

        isActive(s) { return !this.isOffline(s) && ACTIVE_STATUSES.includes(s.status); },
        // Hanya pesanan online yang masih berjalan
        get activeSales() { return this.sales.filter(s => this.isActive(s)); },
        // Nilai (omset) semua pesanan aktif
        get activeValue() { return this.activeSales.reduce((sum, s) => sum + s.summary.gross_revenue, 0); },
        // Jumlah pesanan aktif per tab filter
        get saleCounts() {
            const c = { all: 0, Pending: 0, Dibayar: 0, Dikirim: 0 };
            this.activeSales.forEach(s => { c.all++; c[s.status]++; });
            return c;
        },
        get filteredSales() {
            return this.saleFilter === 'all' ? this.activeSales : this.activeSales.filter(s => s.status === this.saleFilter);
        },

        // Status berikutnya dalam alur; null kalau offline / sudah selesai / batal
        nextStatus(s) {
            if (this.isOffline(s)) return null;
            const i = STATUS_FLOW.indexOf(s.status);
            return i >= 0 && i < STATUS_FLOW.length - 1 ? STATUS_FLOW[i + 1] : null;
        },
        canCancel(s) {
            return !this.isOffline(s) && s.status !== 'Selesai' && s.status !== 'Batal';
        },
        // Tombol "lanjut": pindahkan pesanan ke langkah berikutnya
        advanceSale(s) {
            const next = this.nextStatus(s);
            if (!next) return;
            const result = DB.updateSaleStatus(s.id, next);
            if (!result.ok) this.notify(result.error, 'error'); // mis. stok tidak cukup
            else this.notify(next === 'Selesai' ? 'Pesanan selesai dan dipindah ke Riwayat' : 'Status: ' + this.statusInfo[next].label);
            this.refreshData();
        },
        cancelSale(s) {
            const restock = ['Dibayar', 'Dikirim'].includes(s.status) ? ' Stok produk akan dikembalikan.' : '';
            this.ask({
                title: 'Batalkan pesanan?',
                message: `Pesanan ${s.id} akan ditandai batal.${restock}`,
                confirmText: 'Ya, batalkan',
                cancelText: 'Kembali',
                action: () => {
                    const result = DB.updateSaleStatus(s.id, 'Batal');
                    if (!result.ok) this.notify(result.error, 'error');
                    else this.notify('Pesanan dibatalkan dan dipindah ke Riwayat');
                    this.refreshData();
                }
            });
        },
        deleteSale(s) {
            const restock = ['Dibayar', 'Dikirim', 'Selesai'].includes(s.status) ? ' Stok produk akan dikembalikan.' : '';
            this.ask({
                title: 'Hapus transaksi?',
                message: `Transaksi ${s.id} akan dihapus permanen.${restock}`,
                confirmText: 'Hapus transaksi',
                action: () => {
                    const result = DB.deleteSale(s.id);
                    if (!result.ok) { this.notify(result.error, 'error'); return; }
                    if (this.detailId === s.id) { this.showDetailModal = false; this.detailId = null; }
                    this.refreshData();
                    this.notify('Transaksi dihapus');
                }
            });
        },

        // =====================================================================
        // RIWAYAT: laporan, grafik, daftar, detail
        // =====================================================================
        // Hitung ulang laporan periode + daftar riwayat (dipanggil saat data / filter berubah)
        recompute() {
            const r = Report.range(this.period, this.customFrom, this.customTo);
            this.report = Report.build(this.sales, this.period, this.customFrom, this.customTo);
            this.dashMonth = Report.build(this.sales, 'month');
            this.dashWeek = Report.build(this.sales, '7d');
            this.histBase = this.sales.filter(s => !this.isActive(s) && Report.inRange(Report.whenOf(s), r));

            let list = this.histBase;
            if (this.histStatus !== 'all') list = list.filter(s => s.status === this.histStatus);
            if (this.histChannel !== 'all') list = list.filter(s => s.channel === this.histChannel);
            const q = (this.histSearch || '').trim().toLowerCase();
            if (q) {
                list = list.filter(s =>
                    String(s.id).toLowerCase().includes(q) ||
                    String(s.channel).toLowerCase().includes(q) ||
                    (s.items || []).some(i => String(i.product_name).toLowerCase().includes(q)));
            }
            const t = s => Report.whenOf(s).getTime();
            const sorters = {
                new: (a, b) => t(b) - t(a),
                old: (a, b) => t(a) - t(b),
                high: (a, b) => b.summary.gross_revenue - a.summary.gross_revenue,
                low: (a, b) => a.summary.gross_revenue - b.summary.gross_revenue
            };
            this.histList = [...list].sort(sorters[this.histSort] || sorters.new);
            this.renderCharts(0);
        },
        get histVisible() { return this.histList.slice(0, this.histLimit); },
        get histCounts() {
            const c = { all: this.histBase.length, Selesai: 0, Batal: 0 };
            this.histBase.forEach(s => { if (c[s.status] !== undefined) c[s.status]++; });
            return c;
        },
        // Channel yang pernah dipakai di riwayat (untuk dropdown filter)
        get histChannels() {
            return [...new Set(this.sales.filter(s => !this.isActive(s)).map(s => s.channel))].sort();
        },
        get chartsAvailable() { return Charts.available(); },
        // Tampilkan tabel jika pengguna memilih, atau Chart.js tidak termuat (mis. offline)
        get showTables() { return this.chartTable || !Charts.available(); },
        get periodLabel() { return this.report.rangeLabel; },
        // Tanggal "mulai" tidak boleh melewati "sampai"
        setPeriod(key) { this.period = key; },
        resetHistFilters() {
            this.histStatus = 'all'; this.histChannel = 'all'; this.histSearch = ''; this.histSort = 'new';
        },
        get histFiltered() {
            return this.histStatus !== 'all' || this.histChannel !== 'all' || !!this.histSearch;
        },

        // Perubahan vs periode sebelumnya, siap tampil. null = tidak ada pembanding.
        deltaView(key, rep = this.report) {
            if (!rep.hasPrev) return null;
            const d = rep.delta[key];
            if (d === null) return { dir: 'up', text: 'Baru' };
            const pct = Math.abs(d.pct).toLocaleString('id-ID', { maximumFractionDigits: 1 });
            return { dir: d.dir, text: d.dir === 'flat' ? 'Tetap' : pct + '%' };
        },
        deltaArrow(dir) { return { up: 'trend-up', down: 'trend-down', flat: 'minus' }[dir]; },
        pct(n) { return (n || 0).toLocaleString('id-ID', { maximumFractionDigits: 1 }) + '%'; },

        // Gambar ulang grafik (ditunda sedikit supaya DOM sudah tampil)
        renderCharts(delay = 0) {
            clearTimeout(this._chartTimer);
            if (this.activeTab !== 'history' && this.activeTab !== 'dashboard') return;
            this._chartTimer = setTimeout(() => {
                const raw = x => (typeof Alpine !== 'undefined' && Alpine.raw) ? Alpine.raw(x) : x;
                if (this.activeTab === 'dashboard') {
                    if (Charts.available() && this.dashWeek.kpi.count) Charts.trend('chart-dash', raw(this.dashWeek).trend);
                    else Charts.clear('chart-dash');
                    return;
                }
                if (!Charts.available() || this.chartTable || !this.report.kpi.count) { Charts.clearAll(); return; }
                const rep = raw(this.report);
                Charts.trend('chart-trend', rep.trend);
                Charts.channels('chart-channel', rep.channels);
                Charts.products('chart-product', rep.products);
            }, delay);
        },

        // =====================================================================
        // DATA & BACKUP, EKSPOR EXCEL
        // =====================================================================
        openDataModal() {
            this.rememberFocus();
            this.modalError = '';
            this.showDataModal = true;
            this.focusFirst('dlg-data');
        },
        closeDataModal() {
            this.showDataModal = false;
            this.modalError = '';
            this.restoreFocus();
        },
        get hasData() { return this.products.length + this.purchases.length + this.sales.length > 0; },
        // Ingatkan backup kalau belum pernah atau sudah >= 7 hari (hanya jika ada data)
        get backupDays() { return this.lastBackup ? Math.floor((Date.now() - new Date(this.lastBackup).getTime()) / 86400000) : null; },
        get backupStale() { return this.hasData && (this.backupDays === null || this.backupDays >= 7); },
        get backupLabel() {
            if (!this.lastBackup) return 'Belum pernah backup.';
            const d = this.backupDays;
            return 'Backup terakhir: ' + this.formatDate(this.lastBackup) + (d >= 1 ? ' (' + d + ' hari lalu)' : ' (hari ini)');
        },
        downloadBackup() {
            try {
                Backup.download();
                this.lastBackup = Backup.lastBackup();
                this.notify('Backup diunduh. Simpan file di tempat aman.');
            } catch (e) { this.notify('Gagal membuat backup: ' + e.message, 'error'); }
        },
        exportExcelAll() {
            try { Backup.exportAll(); this.notify('Laporan Excel diunduh'); }
            catch (e) { this.notify('Gagal membuat file Excel: ' + e.message, 'error'); }
        },
        exportHistoryExcel() {
            if (!this.histList.length) { this.notify('Tidak ada data untuk diekspor', 'error'); return; }
            try { Backup.exportSales(this.histList, 'Riwayat'); this.notify('Excel diunduh (' + this.histList.length + ' transaksi)'); }
            catch (e) { this.notify('Gagal membuat file Excel: ' + e.message, 'error'); }
        },
        // File backup dipilih: periksa dulu, lalu minta konfirmasi sebelum mengganti data
        onRestoreFile(ev) {
            const input = ev.target, file = input.files && input.files[0];
            if (!file) return;
            const reset = () => { input.value = ''; };
            if (file.size > 20 * 1024 * 1024) { reset(); this.setModalError('File terlalu besar untuk backup Berkah.Intann.'); return; }
            file.text().then(text => {
                reset();
                const v = Backup.validate(text);
                if (!v.ok) { this.setModalError(v.error); return; }
                this.modalError = '';
                this.askRestore(v);
            }).catch(() => { reset(); this.setModalError('File tidak bisa dibaca.'); });
        },
        askRestore(v) {
            const c = v.counts;
            this.ask({
                title: 'Pulihkan data dari backup?',
                message: `Semua data saat ini diganti dengan ${c.products} produk, ${c.purchases} restok, dan ${c.sales} transaksi` +
                    (v.exported_at ? ` (backup ${this.formatDate(v.exported_at)})` : '') +
                    (this.hasData ? '. Backup data saat ini diunduh dulu sebagai pengaman.' : '.'),
                confirmText: 'Ya, pulihkan',
                cancelText: 'Batal',
                action: () => {
                    if (this.hasData) { try { Backup.download(); this.lastBackup = Backup.lastBackup(); } catch (e) {} }
                    const r = Backup.restore(v.data);
                    if (!r.ok) { this.setModalError(r.error); return; }
                    this.refreshData();
                    this.closeDataModal();
                    this.activeTab = 'dashboard';
                    this.notify('Data dipulihkan: ' + c.products + ' produk, ' + c.sales + ' transaksi');
                }
            });
        },

        // Detail transaksi (modal)
        get detailSale() { return this.sales.find(s => s.id === this.detailId) || null; },
        openDetail(s) {
            this.rememberFocus();
            this.detailId = s.id;
            this.showDetailModal = true;
            this.focusFirst('dlg-detail');
        },
        closeDetail() {
            this.showDetailModal = false;
            this.restoreFocus();
        },
        editFromDetail() {
            const s = this.detailSale;
            if (!s) return;
            this.showDetailModal = false;
            this._lastFocus = null;
            this.openSaleModal(s);
        },
        deleteFromDetail() {
            const s = this.detailSale;
            if (s) this.deleteSale(s);
        },
        exportHistory() {
            if (!this.histList.length) { this.notify('Tidak ada data untuk diekspor', 'error'); return; }
            DB.exportSalesCSV(this.histList);
        },

        // =====================================================================
        // TOMBOL TAMBAH MELAYANG (HP): aksi mengikuti tab yang aktif
        // =====================================================================
        get fab() {
            return { products: 'Produk', purchases: 'Restok', sales: 'Catat' }[this.activeTab] || null;
        },
        fabAction() {
            if (this.activeTab === 'products') this.openProductModal();
            else if (this.activeTab === 'purchases') this.openPurchaseModal();
            else if (this.activeTab === 'sales') this.openSaleModal();
        },

        exportProducts() { DB.exportProductsCSV(); },

        formatRupiah(n) {
            return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(n || 0);
        },
        formatDate(iso) {
            return new Date(iso).toLocaleString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        }
    }));
});
