// database.js - LocalStorage Database & Business Logic
// Semua fungsi tulis memvalidasi dulu, baru mengubah data, lalu mengembalikan
// { ok: true } atau { ok: false, error: '...' }. Operasi tulis dibungkus tx():
// kalau penyimpanan gagal, semua data dikembalikan ke kondisi semula.

// Alur pesanan online: Pending -> Dibayar -> Dikirim -> Selesai (atau Batal).
// Transaksi Offline tidak punya status pesanan: langsung dianggap Selesai.
const VALID_STATUSES = ['Pending', 'Dibayar', 'Dikirim', 'Selesai', 'Batal'];
// Stok berkurang begitu pesanan dibayar (barang sudah terjual / dipesan pembeli)
const STOCK_OUT_STATUSES = ['Dibayar', 'Dikirim', 'Selesai'];
const STORAGE_KEYS = ['olshop_products', 'olshop_purchases', 'olshop_sales'];

const DB = {
    // ---------- HELPER ----------

    // Ubah apa pun jadi angka aman (kosong / teks / NaN -> 0)
    num(v) {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
    },

    // ID unik
    uid(prefix) {
        const rand = (window.crypto && crypto.randomUUID)
            ? crypto.randomUUID().replace(/-/g, '').slice(0, 8)
            : Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        return prefix + '-' + rand.toUpperCase();
    },

    // Baca array dari localStorage. Kalau data korup, salin dulu ke *_corrupt_backup.
    read(key) {
        const raw = localStorage.getItem(key);
        if (raw === null) return [];
        try {
            const data = JSON.parse(raw);
            if (Array.isArray(data)) return data;
            throw new Error('bukan array');
        } catch (e) {
            try { localStorage.setItem(key + '_corrupt_backup', raw); } catch (err) {}
            return [];
        }
    },
    write(key, data) {
        localStorage.setItem(key, JSON.stringify(data));
    },
    fail(error) {
        return { ok: false, error };
    },

    // Jalankan operasi tulis sebagai satu paket (rollback kalau gagal menyimpan)
    tx(fn) {
        const snap = STORAGE_KEYS.map(k => localStorage.getItem(k));
        try {
            return fn();
        } catch (e) {
            STORAGE_KEYS.forEach((k, i) => {
                try {
                    if (snap[i] === null) localStorage.removeItem(k);
                    else localStorage.setItem(k, snap[i]);
                } catch (err) {}
            });
            return this.fail('Gagal menyimpan: penyimpanan browser penuh atau diblokir. Data tidak berubah.');
        }
    },

    // Jumlahkan qty per produk (kalau produk yang sama muncul di beberapa baris)
    sumByProduct(items) {
        const map = {};
        items.forEach(i => { map[i.product_id] = (map[i.product_id] || 0) + i.qty; });
        return map;
    },
    // Cek stok cukup. Return teks error, atau null kalau aman.
    checkStock(products, qtyMap) {
        for (const id in qtyMap) {
            const prod = products.find(p => p.id === id);
            if (prod && prod.stock < qtyMap[id]) {
                return `Stok "${prod.name}" tidak cukup (sisa ${prod.stock}, diminta ${qtyMap[id]}).`;
            }
        }
        return null;
    },
    // Kembalikan stok dari item-item sebuah transaksi (di memori, belum disimpan)
    restoreStock(products, items) {
        const qtyMap = this.sumByProduct(items);
        for (const id in qtyMap) {
            const prod = products.find(p => p.id === id);
            if (prod) prod.stock += qtyMap[id];
        }
    },

    init() {
        if (!localStorage.getItem('olshop_products')) {
            this.write('olshop_products', [
                { id: 'PRD-001', name: 'Kemeja Flanel Casual', category: 'Pakaian', base_price: 65000, sell_price: 115000, stock: 15 },
                { id: 'PRD-002', name: 'Celana Chino Panjang', category: 'Pakaian', base_price: 90000, sell_price: 155000, stock: 10 }
            ]);
        }
        if (!localStorage.getItem('olshop_purchases')) this.write('olshop_purchases', []);
        if (!localStorage.getItem('olshop_sales')) this.write('olshop_sales', []);
    },

    // ---------- PRODUK ----------
    getProducts() { return this.read('olshop_products'); },
    saveProducts(products) { this.write('olshop_products', products); },

    // Validasi & bersihkan input produk. Return { error } atau { value }.
    cleanProduct(p) {
        const name = String(p.name || '').trim();
        const sell = this.num(p.sell_price);
        const base = this.num(p.base_price);
        const stock = Math.floor(this.num(p.stock));
        if (!name) return { error: 'Nama produk wajib diisi!' };
        if (sell <= 0) return { error: 'Harga jual harus lebih dari 0.' };
        if (base < 0) return { error: 'Harga modal tidak boleh negatif.' };
        if (stock < 0) return { error: 'Stok tidak boleh negatif.' };
        return { value: { name, category: String(p.category || '').trim() || 'Umum', base_price: base, sell_price: sell, stock } };
    },

    addProduct(product) {
        return this.tx(() => {
            const c = this.cleanProduct(product);
            if (c.error) return this.fail(c.error);
            const products = this.getProducts();
            products.push({ id: this.uid('PRD'), ...c.value });
            this.saveProducts(products);
            return { ok: true };
        });
    },

    // Edit produk. Mengubah stok di sini = koreksi stok manual.
    // HPP baru hanya berlaku untuk penjualan berikutnya (riwayat memakai snapshot).
    updateProduct(id, product) {
        return this.tx(() => {
            const c = this.cleanProduct(product);
            if (c.error) return this.fail(c.error);
            const products = this.getProducts();
            const prod = products.find(p => p.id === id);
            if (!prod) return this.fail('Produk tidak ditemukan.');
            Object.assign(prod, c.value);
            this.saveProducts(products);
            return { ok: true };
        });
    },

    // Hapus produk. Riwayat tetap aman karena transaksi menyimpan nama produk sendiri.
    deleteProduct(id) {
        return this.tx(() => {
            const products = this.getProducts();
            if (!products.some(p => p.id === id)) return this.fail('Produk tidak ditemukan.');
            this.saveProducts(products.filter(p => p.id !== id));
            return { ok: true };
        });
    },

    // ---------- RESTOK ----------
    getPurchases() { return this.read('olshop_purchases'); },

    // Validasi data restok lalu TERAPKAN ke array `products` (di memori): stok bertambah dan
    // HPP dihitung ulang. Return { error } atau { items, shipping, supplier, total }.
    applyPurchase(products, data) {
        const rawItems = data.items || [];
        if (rawItems.length === 0) return { error: 'Pilih minimal 1 produk untuk restok!' };

        const shipping = this.num(data.shipping_cost);
        if (shipping < 0) return { error: 'Ongkir tidak boleh negatif.' };

        // 1) Validasi semua baris SEBELUM mengubah data
        const items = [];
        for (const raw of rawItems) {
            const prod = products.find(p => p.id === raw.product_id);
            const qty = Math.floor(this.num(raw.qty));
            const price = this.num(raw.base_price);
            if (!prod) return { error: 'Ada baris yang belum memilih produk.' };
            if (qty < 1) return { error: `Qty "${prod.name}" minimal 1.` };
            if (price < 0) return { error: `Harga beli "${prod.name}" tidak boleh negatif.` };
            items.push({ prod, qty, price });
        }

        // 2) Ongkir dibagi rata per pcs
        const totalQty = items.reduce((s, i) => s + i.qty, 0);
        const shippingPerUnit = shipping / totalQty;

        // 3) HPP rata-rata tertimbang
        const processed = items.map(({ prod, qty, price }) => {
            const effectiveHpp = price + shippingPerUnit;
            const newStock = prod.stock + qty;
            prod.base_price = Math.round((prod.stock * prod.base_price + qty * effectiveHpp) / newStock);
            prod.stock = newStock;
            return {
                product_id: prod.id,
                product_name: prod.name,
                qty,
                base_price: price,
                allocated_shipping: Math.round(shippingPerUnit * qty),
                effective_hpp: Math.round(effectiveHpp)
            };
        });
        return {
            items: processed,
            shipping,
            supplier: String(data.supplier || '').trim() || 'Supplier Umum',
            total: items.reduce((s, i) => s + i.price * i.qty, 0) + shipping
        };
    },

    // Batalkan efek satu restok pada `products` (di memori): stok dikurangi, HPP dikembalikan
    // dengan membalik rumus rata-rata tertimbang (perkiraan kalau sudah ada restok/penjualan
    // sesudahnya; snapshot HPP di transaksi lama tidak berubah). Return teks error atau null.
    reversePurchase(products, purchase) {
        for (const it of purchase.items) {
            const prod = products.find(p => p.id === it.product_id);
            if (!prod) continue; // produk sudah dihapus: tidak ada yang perlu dikembalikan
            if (prod.stock < it.qty) {
                return `Stok "${prod.name}" tinggal ${prod.stock}, kurang dari ${it.qty} pcs dari restok ini (sebagian sudah terjual). Restok tidak bisa diubah/dihapus.`;
            }
            const rest = prod.stock - it.qty;
            if (rest > 0) {
                const hpp = Math.round((prod.stock * prod.base_price - it.qty * it.effective_hpp) / rest);
                if (Number.isFinite(hpp) && hpp >= 0) prod.base_price = hpp;
            }
            prod.stock = rest;
        }
        return null;
    },

    addPurchase(data) {
        return this.tx(() => {
            const products = this.getProducts();
            const r = this.applyPurchase(products, data);
            if (r.error) return this.fail(r.error);

            this.saveProducts(products);
            const purchases = this.getPurchases();
            purchases.unshift({
                id: this.uid('RESTOK'),
                date: new Date().toISOString(),
                supplier: r.supplier,
                shipping_cost: r.shipping,
                items: r.items,
                total_spend: r.total
            });
            this.write('olshop_purchases', purchases);
            return { ok: true };
        });
    },

    // Ubah restok: efek lama dibatalkan, lalu data baru diterapkan (ID & tanggal tetap)
    updatePurchase(id, data) {
        return this.tx(() => {
            const purchases = this.getPurchases();
            const idx = purchases.findIndex(r => r.id === id);
            if (idx < 0) return this.fail('Catatan restok tidak ditemukan.');
            const old = purchases[idx];

            // Hanya nama supplier yang berubah: tidak menyentuh stok / HPP
            const same = this.num(data.shipping_cost) === old.shipping_cost
                && (data.items || []).length === old.items.length
                && (data.items || []).every((it, i) => it.product_id === old.items[i].product_id
                    && Math.floor(this.num(it.qty)) === old.items[i].qty
                    && this.num(it.base_price) === old.items[i].base_price);
            if (same) {
                old.supplier = String(data.supplier || '').trim() || 'Supplier Umum';
                this.write('olshop_purchases', purchases);
                return { ok: true };
            }

            const products = this.getProducts();
            const err = this.reversePurchase(products, old);
            if (err) return this.fail(err);
            const r = this.applyPurchase(products, data);
            if (r.error) return this.fail(r.error);

            this.saveProducts(products);
            purchases[idx] = { ...old, supplier: r.supplier, shipping_cost: r.shipping, items: r.items, total_spend: r.total };
            this.write('olshop_purchases', purchases);
            return { ok: true };
        });
    },

    // Hapus restok: stok dikurangi & HPP dikembalikan (ditolak kalau stok sudah terjual sebagian)
    deletePurchase(id) {
        return this.tx(() => {
            const purchases = this.getPurchases();
            const idx = purchases.findIndex(r => r.id === id);
            if (idx < 0) return this.fail('Catatan restok tidak ditemukan.');

            const products = this.getProducts();
            const err = this.reversePurchase(products, purchases[idx]);
            if (err) return this.fail(err);

            this.saveProducts(products);
            purchases.splice(idx, 1);
            this.write('olshop_purchases', purchases);
            return { ok: true };
        });
    },

    // ---------- PENJUALAN ----------
    getSales() { return this.read('olshop_sales'); },

    // Validasi data penjualan, hitung total, dan (kalau status memotong stok) kurangi stok
    // di array `products` (di memori). keepHpp = { product_id: hpp } untuk mempertahankan
    // snapshot HPP lama saat edit. Return { error } atau { items, expenses, summary }.
    prepareSale(products, data, keepHpp = {}) {
        const rawItems = data.items || [];
        if (rawItems.length === 0) return { error: 'Pilih minimal 1 produk yang dijual!' };
        // Offline selalu langsung Selesai (tanpa status pesanan)
        const status = data.channel === 'Offline' ? 'Selesai' : data.status;
        if (!VALID_STATUSES.includes(status)) return { error: 'Status pesanan tidak valid.' };

        const packingFee = this.num(data.packing_fee);
        const adminFee = this.num(data.platform_admin_fee);
        const sellerShipping = this.num(data.seller_shipping);
        if (packingFee < 0 || adminFee < 0 || sellerShipping < 0) return { error: 'Biaya tidak boleh negatif.' };

        const items = [];
        for (const raw of rawItems) {
            const prod = products.find(p => p.id === raw.product_id);
            const qty = Math.floor(this.num(raw.qty));
            const sellPrice = this.num(raw.sell_price);
            if (!prod) return { error: 'Ada baris yang belum memilih produk (atau produknya sudah dihapus).' };
            if (qty < 1) return { error: `Qty "${prod.name}" minimal 1.` };
            if (sellPrice < 0) return { error: `Harga jual "${prod.name}" tidak boleh negatif.` };
            items.push({ prod, product_id: prod.id, qty, sellPrice });
        }

        const stockOut = STOCK_OUT_STATUSES.includes(status);
        if (stockOut) {
            const err = this.checkStock(products, this.sumByProduct(items));
            if (err) return { error: err };
        }

        let totalGross = 0;
        let totalHpp = 0;
        const processed = items.map(({ prod, qty, sellPrice }) => {
            const hppUnit = keepHpp[prod.id] !== undefined ? keepHpp[prod.id] : prod.base_price;
            totalGross += sellPrice * qty;
            totalHpp += hppUnit * qty;
            if (stockOut) prod.stock -= qty;
            return { product_id: prod.id, product_name: prod.name, qty, sell_price: sellPrice, hpp_unit: hppUnit };
        });

        const totalExpenses = packingFee + adminFee + sellerShipping;
        return {
            status,
            items: processed,
            expenses: { packing_fee: packingFee, platform_admin_fee: adminFee, seller_shipping: sellerShipping },
            summary: {
                gross_revenue: totalGross,
                total_hpp: totalHpp,
                total_expenses: totalExpenses,
                net_profit: totalGross - totalHpp - totalExpenses
            }
        };
    },

    addSale(data) {
        return this.tx(() => {
            const products = this.getProducts();
            const r = this.prepareSale(products, data);
            if (r.error) return this.fail(r.error);

            this.saveProducts(products);
            const now = new Date().toISOString();
            const sales = this.getSales();
            sales.unshift({
                id: this.uid('TRX'),
                date: now,
                completed_at: r.status === 'Selesai' ? now : null, // dipakai untuk omset bulanan
                channel: data.channel,
                status: r.status,
                items: r.items,
                expenses: r.expenses,
                summary: r.summary
            });
            this.write('olshop_sales', sales);
            return { ok: true };
        });
    },

    // Edit transaksi: stok lama dikembalikan dulu, data baru divalidasi & diterapkan.
    // Kalau validasi gagal (mis. stok kurang), TIDAK ada yang disimpan.
    // ID, tanggal, dan snapshot HPP lama (untuk produk yang sama) dipertahankan.
    updateSale(saleId, data) {
        return this.tx(() => {
            const sales = this.getSales();
            const sale = sales.find(s => s.id === saleId);
            if (!sale) return this.fail('Transaksi tidak ditemukan.');

            const products = this.getProducts();
            if (STOCK_OUT_STATUSES.includes(sale.status)) this.restoreStock(products, sale.items);

            const keepHpp = {};
            sale.items.forEach(i => { keepHpp[i.product_id] = i.hpp_unit; });

            const r = this.prepareSale(products, data, keepHpp);
            if (r.error) return this.fail(r.error);

            this.saveProducts(products);
            sale.channel = data.channel;
            sale.items = r.items;
            sale.expenses = r.expenses;
            sale.summary = r.summary;
            if (r.status === 'Selesai') {
                if (sale.status !== 'Selesai' || !sale.completed_at) sale.completed_at = new Date().toISOString();
            } else {
                sale.completed_at = null;
            }
            sale.status = r.status;
            this.write('olshop_sales', sales);
            return { ok: true };
        });
    },

    // Hapus transaksi. Kalau stok sudah terpotong (Dikirim/Selesai), stok dikembalikan.
    deleteSale(saleId) {
        return this.tx(() => {
            const sales = this.getSales();
            const sale = sales.find(s => s.id === saleId);
            if (!sale) return this.fail('Transaksi tidak ditemukan.');

            if (STOCK_OUT_STATUSES.includes(sale.status)) {
                const products = this.getProducts();
                this.restoreStock(products, sale.items);
                this.saveProducts(products);
            }
            this.write('olshop_sales', sales.filter(s => s.id !== saleId));
            return { ok: true };
        });
    },

    // Aturan stok: berkurang saat status MASUK ke Dikirim/Selesai, kembali saat KELUAR.
    // Dikirim <-> Selesai tidak mengubah stok.
    updateSaleStatus(saleId, newStatus) {
        return this.tx(() => {
            if (!VALID_STATUSES.includes(newStatus)) return this.fail('Status tidak valid.');

            const sales = this.getSales();
            const sale = sales.find(s => s.id === saleId);
            if (!sale) return this.fail('Transaksi tidak ditemukan.');
            if (sale.channel === 'Offline') return this.fail('Transaksi offline tidak memiliki status pesanan.');
            if (sale.status === newStatus) return { ok: true };

            const wasOut = STOCK_OUT_STATUSES.includes(sale.status);
            const nowOut = STOCK_OUT_STATUSES.includes(newStatus);

            if (wasOut !== nowOut) {
                const products = this.getProducts();
                if (nowOut) {
                    const qtyMap = this.sumByProduct(sale.items);
                    const err = this.checkStock(products, qtyMap);
                    if (err) return this.fail(err);
                    for (const id in qtyMap) {
                        const prod = products.find(p => p.id === id);
                        if (prod) prod.stock -= qtyMap[id];
                    }
                } else {
                    this.restoreStock(products, sale.items);
                }
                this.saveProducts(products);
            }

            sale.status = newStatus;
            sale.completed_at = newStatus === 'Selesai' ? new Date().toISOString() : null;
            this.write('olshop_sales', sales);
            return { ok: true };
        });
    },

    // ---------- EKSPOR CSV ----------
    // Pemisah ';' agar terbuka rapi di Excel versi Indonesia & Google Sheets.
    csvCell(v) {
        if (v === null || v === undefined) return '';
        if (typeof v === 'number') return String(v);
        let s = String(v);
        if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;           // cegah formula injection
        if (/[;"\n\r,]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
        return s;
    },
    fmtDate(iso) {
        const d = new Date(iso);
        const p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    },

    // list opsional: ekspor daftar yang sedang ditampilkan (mis. hasil filter Riwayat)
    exportSalesCSV(list) {
        const rows = [['ID Transaksi', 'Tanggal', 'Selesai', 'Channel', 'Status', 'Item', 'Total Omset', 'Total HPP', 'Biaya Operasional', 'Laba Bersih']];
        (list || this.getSales()).forEach(s => rows.push([
            s.id, this.fmtDate(s.date), s.completed_at ? this.fmtDate(s.completed_at) : '', s.channel, s.status,
            (s.items || []).map(i => i.product_name + ' x' + i.qty).join(', '),
            s.summary.gross_revenue, s.summary.total_hpp, s.summary.total_expenses, s.summary.net_profit
        ]));
        this.downloadCSV(rows, 'Riwayat_Penjualan_Berkah.Intann.csv');
    },

    exportProductsCSV() {
        const rows = [['ID Produk', 'Nama Produk', 'Kategori', 'Harga Modal (HPP)', 'Harga Jual', 'Stok', 'Total Aset Nilai']];
        this.getProducts().forEach(p => rows.push([
            p.id, p.name, p.category, p.base_price, p.sell_price, p.stock, p.base_price * p.stock
        ]));
        this.downloadCSV(rows, 'Stok_Produk_Berkah.Intann.csv');
    },

    // Blob + BOM (bukan data URI) supaya '#', koma, dan huruf non-ASCII aman
    downloadCSV(rows, filename) {
        const content = '\uFEFF' + rows.map(r => r.map(c => this.csvCell(c)).join(';')).join('\r\n');
        this.downloadBlob(new Blob([content], { type: 'text/csv;charset=utf-8;' }), filename);
    },
    // Unduh Blob sebagai file (dipakai CSV, Excel, dan backup JSON)
    downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
};

DB.init();
