// backup.js - Backup & restore data (JSON) dan ekspor laporan Excel (.xlsx).
// Bergantung pada: DB (database.js), Report (report.js), XLSX (xlsx.js).
const Backup = {
    VERSION: 1,
    LAST_KEY: 'olshop_last_backup',

    // ---------- Backup JSON ----------
    snapshot() {
        return {
            app: 'OlshopManager',
            version: this.VERSION,
            exported_at: new Date().toISOString(),
            data: { products: DB.getProducts(), purchases: DB.getPurchases(), sales: DB.getSales() }
        };
    },
    stamp(d = new Date()) {
        const p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
    },
    // Unduh file backup & catat waktunya
    download() {
        const snap = this.snapshot();
        const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
        DB.downloadBlob(blob, `Berkah.Intann_Backup_${this.stamp()}.json`);
        try { localStorage.setItem(this.LAST_KEY, snap.exported_at); } catch (e) {}
        return snap;
    },
    lastBackup() {
        try { return localStorage.getItem(this.LAST_KEY); } catch (e) { return null; }
    },
    // Berapa hari sejak backup terakhir; null kalau belum pernah
    daysSince(now = new Date()) {
        const last = this.lastBackup();
        if (!last) return null;
        const t = new Date(last).getTime();
        return Number.isFinite(t) ? Math.floor((now.getTime() - t) / 86400000) : null;
    },

    // ---------- Restore ----------
    // Periksa isi file backup SEBELUM menyentuh data. Return { ok, error } atau { ok, data, counts, exported_at }.
    validate(text) {
        let obj;
        try { obj = JSON.parse(text); } catch (e) { return { ok: false, error: 'File bukan backup yang valid (isinya bukan JSON).' }; }
        if (!obj || obj.app !== 'OlshopManager' || !obj.data) return { ok: false, error: 'File ini bukan backup Berkah.Intann.' };
        if (!Number.isFinite(obj.version) || obj.version > this.VERSION) return { ok: false, error: 'Backup dibuat oleh versi aplikasi yang lebih baru. Perbarui aplikasi dulu.' };

        const { products, purchases, sales } = obj.data;
        if (![products, purchases, sales].every(Array.isArray)) return { ok: false, error: 'Isi backup tidak lengkap (produk, restok, atau penjualan hilang).' };

        const num = v => typeof v === 'number' && Number.isFinite(v);
        const dupe = (arr, label) => {
            const seen = new Set();
            for (const r of arr) { if (seen.has(r.id)) return `${label} dengan ID ganda: ${r.id}.`; seen.add(r.id); }
            return null;
        };
        for (const p of products) {
            if (!p || typeof p.id !== 'string' || typeof p.name !== 'string' || !num(p.base_price) || !num(p.sell_price) || !num(p.stock))
                return { ok: false, error: `Data produk rusak: ${p && p.id ? p.id : '(tanpa ID)'}.` };
        }
        for (const r of purchases) {
            if (!r || typeof r.id !== 'string' || !Array.isArray(r.items) || !num(r.shipping_cost) || !num(r.total_spend) ||
                !r.items.every(i => i && typeof i.product_id === 'string' && num(i.qty) && num(i.base_price) && num(i.effective_hpp)))
                return { ok: false, error: `Data restok rusak: ${r && r.id ? r.id : '(tanpa ID)'}.` };
        }
        for (const s of sales) {
            const ok = s && typeof s.id === 'string' && typeof s.channel === 'string' && VALID_STATUSES.includes(s.status) &&
                Array.isArray(s.items) && s.items.length > 0 &&
                s.items.every(i => i && typeof i.product_id === 'string' && num(i.qty) && num(i.sell_price) && num(i.hpp_unit)) &&
                s.summary && ['gross_revenue', 'total_hpp', 'total_expenses', 'net_profit'].every(k => num(s.summary[k])) &&
                s.expenses && ['packing_fee', 'platform_admin_fee', 'seller_shipping'].every(k => num(s.expenses[k])) &&
                !Number.isNaN(new Date(s.date).getTime());
            if (!ok) return { ok: false, error: `Data penjualan rusak: ${s && s.id ? s.id : '(tanpa ID)'}.` };
        }
        const d = dupe(products, 'Produk') || dupe(purchases, 'Restok') || dupe(sales, 'Penjualan');
        if (d) return { ok: false, error: d };

        return {
            ok: true, data: { products, purchases, sales }, exported_at: obj.exported_at || null,
            counts: { products: products.length, purchases: purchases.length, sales: sales.length }
        };
    },
    // Ganti seluruh data dengan isi backup (satu paket: gagal = data lama utuh)
    restore(data) {
        return DB.tx(() => {
            DB.write('olshop_products', data.products);
            DB.write('olshop_purchases', data.purchases);
            DB.write('olshop_sales', data.sales);
            return { ok: true };
        });
    },

    // ---------- Excel ----------
    salesSheets(list) {
        const when = iso => iso ? DB.fmtDate(iso) : '';
        const sales = {
            name: 'Penjualan',
            widths: [20, 17, 17, 14, 12, 44, 15, 15, 12, 14, 14, 15, 15],
            cols: [{ h: 'ID Transaksi' }, { h: 'Dicatat' }, { h: 'Selesai' }, { h: 'Channel' }, { h: 'Status' }, { h: 'Item' },
                { h: 'Omset', t: 'money' }, { h: 'HPP', t: 'money' }, { h: 'Packing', t: 'money' }, { h: 'Admin marketplace', t: 'money' },
                { h: 'Ongkir seller', t: 'money' }, { h: 'Total biaya', t: 'money' }, { h: 'Laba bersih', t: 'money' }],
            rows: list.map(s => [s.id, when(s.date), when(s.completed_at), s.channel, s.status,
                s.items.map(i => i.product_name + ' x' + i.qty).join(', '),
                s.summary.gross_revenue, s.summary.total_hpp, s.expenses.packing_fee, s.expenses.platform_admin_fee,
                s.expenses.seller_shipping, s.summary.total_expenses, s.summary.net_profit])
        };
        const items = {
            name: 'Item Penjualan',
            widths: [20, 17, 14, 12, 30, 8, 15, 15, 16, 16],
            cols: [{ h: 'ID Transaksi' }, { h: 'Dicatat' }, { h: 'Channel' }, { h: 'Status' }, { h: 'Produk' }, { h: 'Qty' },
                { h: 'Harga jual / pcs', t: 'money' }, { h: 'HPP / pcs', t: 'money' }, { h: 'Subtotal', t: 'money' }, { h: 'Laba kotor item', t: 'money' }],
            rows: list.flatMap(s => s.items.map(i => [s.id, when(s.date), s.channel, s.status, i.product_name, i.qty,
                i.sell_price, i.hpp_unit, i.qty * i.sell_price, i.qty * (i.sell_price - i.hpp_unit)]))
        };
        return [sales, items];
    },
    productSheet(products) {
        return {
            name: 'Produk',
            widths: [14, 30, 18, 15, 15, 15, 8, 16],
            cols: [{ h: 'ID' }, { h: 'Nama produk' }, { h: 'Kategori' }, { h: 'HPP', t: 'money' }, { h: 'Harga jual', t: 'money' },
                { h: 'Margin / pcs', t: 'money' }, { h: 'Stok' }, { h: 'Nilai stok', t: 'money' }],
            rows: products.map(p => [p.id, p.name, p.category, p.base_price, p.sell_price, p.sell_price - p.base_price, p.stock, p.base_price * p.stock])
        };
    },
    purchaseSheet(purchases) {
        return {
            name: 'Restok',
            widths: [20, 17, 22, 30, 8, 16, 18, 16, 16],
            cols: [{ h: 'ID Restok' }, { h: 'Tanggal' }, { h: 'Supplier' }, { h: 'Produk' }, { h: 'Qty' }, { h: 'Harga beli / pcs', t: 'money' },
                { h: 'Ongkir dialokasikan', t: 'money' }, { h: 'HPP efektif / pcs', t: 'money' }, { h: 'Total item', t: 'money' }],
            rows: purchases.flatMap(r => r.items.map(i => [r.id, DB.fmtDate(r.date), r.supplier, i.product_name, i.qty,
                i.base_price, i.allocated_shipping, i.effective_hpp, i.qty * i.base_price + i.allocated_shipping]))
        };
    },
    summarySheet(products, sales, purchases) {
        const m = Report.metrics(sales);
        const active = sales.filter(s => s.channel !== 'Offline' && ['Pending', 'Dibayar', 'Dikirim'].includes(s.status)).length;
        const L = 3, M = 5; // gaya: tebal, uang tebal
        const row = (label, value, money) => ({ cells: [label, value], styles: [0, money ? 2 : 0] });
        return {
            name: 'Ringkasan',
            widths: [34, 22],
            cols: [],
            rows: [
                { cells: ['Berkah.Intann: Laporan Data'], styles: [4] },
                { cells: ['Dibuat ' + DB.fmtDate(new Date().toISOString())], styles: [0] },
                { cells: [''], styles: [0] },
                { cells: ['Penjualan selesai (semua waktu)'], styles: [L] },
                row('Jumlah transaksi selesai', m.count),
                row('Omset', m.revenue, true),
                row('Modal barang (HPP)', m.hpp, true),
                row('Laba kotor', m.grossProfit, true),
                row('Biaya operasional', m.expenses, true),
                { cells: ['Laba bersih', m.netProfit], styles: [L, M] },
                row('Margin laba bersih (%)', Math.round(m.netMargin * 10) / 10),
                { cells: [''], styles: [0] },
                { cells: ['Lainnya'], styles: [L] },
                row('Pesanan online aktif', active),
                row('Pesanan dibatalkan', m.cancelled),
                row('Jumlah produk', products.length),
                row('Nilai stok (HPP x stok)', products.reduce((s, p) => s + p.base_price * p.stock, 0), true),
                row('Catatan restok', purchases.length),
                { cells: [''], styles: [0] },
                { cells: ['Catatan: omset dan laba hanya menghitung transaksi berstatus Selesai.'], styles: [0] }
            ]
        };
    },

    // Workbook lengkap: semua data
    exportAll() {
        const products = DB.getProducts(), purchases = DB.getPurchases(), sales = DB.getSales();
        const sheets = [this.summarySheet(products, sales, purchases), ...this.salesSheets(sales), this.productSheet(products), this.purchaseSheet(purchases)];
        XLSX.download(sheets, `Berkah.Intann_Laporan_${this.stamp().slice(0, 10)}.xlsx`);
        return sheets;
    },
    // Hanya daftar penjualan tertentu (mis. hasil filter Riwayat)
    exportSales(list, label = 'Riwayat') {
        const sheets = this.salesSheets(list);
        XLSX.download(sheets, `Berkah.Intann_${label}_${this.stamp().slice(0, 10)}.xlsx`);
        return sheets;
    }
};
