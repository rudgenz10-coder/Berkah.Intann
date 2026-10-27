// report.js - Perhitungan laporan bisnis + konfigurasi grafik (Chart.js)
// Bagian `Report` berisi fungsi murni (tanpa DOM) untuk periode, ringkasan angka,
// dan agregasi grafik. Bagian `Charts` membuat grafik Chart.js dari hasilnya.

const Report = {
    // ---------- Warna seri (urutan & nilai tetap) ----------
    // Divalidasi dengan validate_palette (permukaan putih, semua pasangan):
    // selisih warna untuk buta warna 9.2, penglihatan normal 24.0.
    // Kontras #1baf7a terhadap putih 2.82:1, jadi nilainya WAJIB juga tampil sebagai
    // label di grafik dan sebagai tabel data (sudah disediakan).
    COLORS: { omset: '#8b2b3d', laba: '#1baf7a', hpp: '#2a78d6', biaya: '#eb6834' },
    // Warna chrome grafik: teks, garis kisi tipis, garis dasar
    INK: { primary: '#1f1a1c', secondary: '#52514e', muted: '#8a7f82', grid: '#f1e7ea', baseline: '#dccfd3', surface: '#ffffff' },
    FONT: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',

    PERIODS: [
        { key: 'today',     label: 'Hari ini' },
        { key: '7d',        label: '7 hari' },
        { key: '30d',       label: '30 hari' },
        { key: 'month',     label: 'Bulan ini' },
        { key: 'lastmonth', label: 'Bulan lalu' },
        { key: 'all',       label: 'Semua' },
        { key: 'custom',    label: 'Kustom' }
    ],

    // ---------- Format angka ----------
    rupiah(n) {
        return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(n || 0);
    },
    // 1.250.000 -> "1,3 jt" (dipakai di sumbu & label grafik)
    compact(n) {
        return new Intl.NumberFormat('id-ID', { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
    },
    compactRupiah(n) {
        const v = n || 0;
        return (v < 0 ? '-' : '') + 'Rp ' + this.compact(Math.abs(v));
    },

    // ---------- Tanggal ----------
    startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); },
    addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); },
    // 'YYYY-MM-DD' (dari <input type="date">) -> tanggal lokal
    parseDay(str) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str || '');
        return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
    },
    dayKey(d) {
        const p = n => String(n).padStart(2, '0');
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    },
    monthKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); },
    // Kapan transaksi dianggap terjadi: saat selesai (uang masuk), kalau tidak ada pakai tanggal catat
    whenOf(s) { return new Date(s.completed_at || s.date); },

    // Rentang periode { start, end } dengan end EKSKLUSIF. null = terbuka.
    range(key, from, to, now = new Date()) {
        const today = this.startOfDay(now), tomorrow = this.addDays(today, 1);
        const y = now.getFullYear(), m = now.getMonth();
        switch (key) {
            case 'today':     return { start: today, end: tomorrow };
            case '7d':        return { start: this.addDays(today, -6), end: tomorrow };
            case '30d':       return { start: this.addDays(today, -29), end: tomorrow };
            case 'month':     return { start: new Date(y, m, 1), end: tomorrow };        // sampai hari ini
            case 'lastmonth': return { start: new Date(y, m - 1, 1), end: new Date(y, m, 1) };
            case 'custom': {
                const a = this.parseDay(from), b = this.parseDay(to);
                return { start: a, end: b ? this.addDays(b, 1) : null };
            }
            default:          return { start: null, end: null };                          // semua
        }
    },
    // Periode pembanding: panjangnya sama, tepat sebelum periode ini. null = tidak ada.
    prevRange(key, r) {
        if (!r || key === 'all') return null;
        if (key === 'lastmonth') {
            return { start: new Date(r.start.getFullYear(), r.start.getMonth() - 1, 1), end: new Date(r.start) };
        }
        if (key === 'month') {
            // bulan ini (sampai hari ini) dibandingkan dengan jumlah hari yang sama di bulan lalu
            const ps = new Date(r.start.getFullYear(), r.start.getMonth() - 1, 1);
            const pe = new Date(Math.min(r.start.getTime(), ps.getTime() + (r.end - r.start)));
            return { start: ps, end: pe };
        }
        if (!r.start || !r.end) return null;
        const len = r.end - r.start;
        return { start: new Date(r.start.getTime() - len), end: new Date(r.start) };
    },
    inRange(d, r) {
        if (!r) return true;
        if (r.start && d < r.start) return false;
        if (r.end && d >= r.end) return false;
        return true;
    },
    prevLabel(key) {
        return { today: 'vs kemarin', '7d': 'vs 7 hari sebelumnya', '30d': 'vs 30 hari sebelumnya',
                 month: 'vs bulan lalu', lastmonth: 'vs bulan sebelumnya', custom: 'vs periode sebelumnya' }[key] || '';
    },
    rangeLabel(r) {
        const f = d => d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
        if (!r || (!r.start && !r.end)) return 'Semua waktu';
        const last = r.end ? this.addDays(r.end, -1) : null;
        if (r.start && last) return this.dayKey(r.start) === this.dayKey(last) ? f(r.start) : f(r.start) + ' – ' + f(last);
        if (r.start) return 'Sejak ' + f(r.start);
        return 'Sampai ' + f(last);
    },

    // ---------- Angka bisnis ----------
    // Hanya transaksi Selesai yang dihitung sebagai omset & laba (uang sudah masuk).
    metrics(list) {
        const m = { count: 0, items: 0, revenue: 0, hpp: 0, packing: 0, admin: 0, shipping: 0, cancelled: 0 };
        for (const s of list) {
            if (s.status === 'Batal') { m.cancelled++; continue; }
            if (s.status !== 'Selesai') continue;
            const sum = s.summary || {}, ex = s.expenses || {};
            m.count++;
            m.revenue += sum.gross_revenue || 0;
            m.hpp += sum.total_hpp || 0;
            m.packing += ex.packing_fee || 0;
            m.admin += ex.platform_admin_fee || 0;
            m.shipping += ex.seller_shipping || 0;
            (s.items || []).forEach(i => { m.items += i.qty || 0; });
        }
        m.expenses = m.packing + m.admin + m.shipping;
        m.grossProfit = m.revenue - m.hpp;               // laba kotor = omset - modal barang
        m.netProfit = m.grossProfit - m.expenses;        // laba bersih = laba kotor - biaya operasional
        const pct = (a, b) => b > 0 ? a / b * 100 : 0;
        m.grossMargin = pct(m.grossProfit, m.revenue);
        m.netMargin = pct(m.netProfit, m.revenue);
        m.aov = m.count ? m.revenue / m.count : 0;       // rata-rata nilai per transaksi
        m.avgProfit = m.count ? m.netProfit / m.count : 0;
        m.cancelRate = pct(m.cancelled, m.count + m.cancelled);
        return m;
    },
    // Perubahan dibanding periode sebelumnya. null = tidak ada pembanding (periode lalu nol).
    delta(cur, prev) {
        if (!prev) return cur ? null : { pct: 0, dir: 'flat' };
        const pct = (cur - prev) / Math.abs(prev) * 100;
        return { pct, dir: Math.abs(pct) < 0.5 ? 'flat' : pct > 0 ? 'up' : 'down' };
    },
    // Komposisi omset: ke mana uangnya pergi (modal, biaya, laba)
    stack(m) {
        const total = Math.max(m.revenue, m.hpp + m.expenses);
        if (total <= 0) return { segments: [], loss: 0 };
        const mk = (key, label, value, color, text) => ({ key, label, value, pct: value / total * 100, color, text });
        const segments = [
            mk('hpp',   'Modal barang (HPP)', m.hpp,                   this.COLORS.hpp,   '#ffffff'),
            mk('biaya', 'Biaya operasional',  m.expenses,              this.COLORS.biaya, this.INK.primary),
            mk('laba',  'Laba bersih',        Math.max(m.netProfit, 0), this.COLORS.laba,  this.INK.primary)
        ].filter(s => s.value > 0);
        return { segments, loss: m.netProfit < 0 ? -m.netProfit : 0 };
    },

    // ---------- Agregasi untuk grafik (hanya transaksi Selesai) ----------
    // Tren: per jam (1 hari), per hari (<= 45 hari), atau per bulan. Hari kosong tetap tampil sebagai 0.
    trend(list, r, now = new Date()) {
        const sold = list.filter(s => s.status === 'Selesai');
        const out = { unit: 'day', unitLabel: '', labels: [], titles: [], omset: [], laba: [], count: [] };
        if (!sold.length) return out;

        const today = this.startOfDay(now), tomorrow = this.addDays(today, 1);
        const times = sold.map(s => this.whenOf(s).getTime());
        const first = this.startOfDay(new Date(Math.min(...times)));
        let start = r && r.start ? r.start : first;
        let end = r && r.end ? r.end : tomorrow;
        if (end > tomorrow) end = tomorrow;              // tanpa hari-hari di masa depan
        if (start >= end) start = first;

        const span = Math.max(1, Math.round((end - start) / 86400000));
        const unit = span <= 1 ? 'hour' : span <= 45 ? 'day' : 'month';
        const pad = n => String(n).padStart(2, '0');
        const keys = [];
        if (unit === 'hour') {
            const last = this.dayKey(start) === this.dayKey(today) ? now.getHours() : 23;
            const dayTitle = start.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
            for (let h = 0; h <= last; h++) { keys.push(h); out.labels.push(pad(h) + ':00'); out.titles.push(dayTitle + ', ' + pad(h) + ':00'); }
        } else if (unit === 'day') {
            for (let d = new Date(start); d < end; d = this.addDays(d, 1)) {
                keys.push(this.dayKey(d));
                out.labels.push(d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }));
                out.titles.push(d.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
            }
        } else {
            for (let d = new Date(start.getFullYear(), start.getMonth(), 1); d < end; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
                keys.push(this.monthKey(d));
                out.labels.push(d.toLocaleDateString('id-ID', { month: 'short', year: 'numeric' }));
                out.titles.push(d.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' }));
            }
        }
        out.unit = unit;
        out.unitLabel = { hour: 'Per jam', day: 'Per hari', month: 'Per bulan' }[unit];
        out.omset = keys.map(() => 0); out.laba = keys.map(() => 0); out.count = keys.map(() => 0);
        const index = new Map(keys.map((k, i) => [k, i]));
        for (const s of sold) {
            const d = this.whenOf(s);
            const k = unit === 'hour' ? d.getHours() : unit === 'day' ? this.dayKey(d) : this.monthKey(d);
            const i = index.get(k);
            if (i === undefined) continue;
            out.omset[i] += s.summary.gross_revenue || 0;
            out.laba[i] += s.summary.net_profit || 0;
            out.count[i]++;
        }
        return out;
    },
    byChannel(list) {
        const map = new Map();
        for (const s of list) {
            if (s.status !== 'Selesai') continue;
            const c = map.get(s.channel) || { channel: s.channel, revenue: 0, profit: 0, count: 0 };
            c.revenue += s.summary.gross_revenue || 0;
            c.profit += s.summary.net_profit || 0;
            c.count++;
            map.set(s.channel, c);
        }
        return [...map.values()].sort((a, b) => b.revenue - a.revenue);
    },
    // Produk terlaris menurut jumlah terjual
    topProducts(list, n = 5) {
        const map = new Map();
        for (const s of list) {
            if (s.status !== 'Selesai') continue;
            for (const i of (s.items || [])) {
                const p = map.get(i.product_name) || { name: i.product_name, qty: 0, revenue: 0, profit: 0 };
                p.qty += i.qty || 0;
                p.revenue += (i.qty || 0) * (i.sell_price || 0);
                p.profit += (i.qty || 0) * ((i.sell_price || 0) - (i.hpp_unit || 0));
                map.set(i.product_name, p);
            }
        }
        return [...map.values()].sort((a, b) => b.qty - a.qty || b.revenue - a.revenue).slice(0, n);
    },

    // Hasil kosong (nilai awal sebelum data dihitung)
    empty() {
        const k = this.metrics([]);
        return { kpi: k, prev: k, hasPrev: false, delta: { revenue: null, netProfit: null, count: null },
                 stack: { segments: [], loss: 0 }, trend: this.trend([], null), channels: [], products: [],
                 rangeLabel: '', prevLabel: '' };
    },
    // Hitung semua sekaligus untuk satu periode. `sales` = transaksi riwayat (bukan yang aktif).
    build(sales, key, from, to, now = new Date()) {
        const r = this.range(key, from, to, now);
        const pr = this.prevRange(key, r);
        const cur = sales.filter(s => this.inRange(this.whenOf(s), r));
        const prev = pr ? sales.filter(s => this.inRange(this.whenOf(s), pr)) : [];
        const k = this.metrics(cur), pk = this.metrics(prev);
        return {
            kpi: k, prev: pk, hasPrev: !!pr,
            delta: pr
                ? { revenue: this.delta(k.revenue, pk.revenue), netProfit: this.delta(k.netProfit, pk.netProfit), count: this.delta(k.count, pk.count) }
                : { revenue: null, netProfit: null, count: null },
            stack: this.stack(k),
            trend: this.trend(cur, r, now),
            channels: this.byChannel(cur),
            products: this.topProducts(cur, 5),
            rangeLabel: this.rangeLabel(r),
            prevLabel: this.prevLabel(key)
        };
    }
};

// =============================================================================
// GRAFIK (Chart.js). Instance disimpan DI LUAR state Alpine supaya tidak dibungkus proxy.
// =============================================================================
const Charts = {
    _inst: {},
    available() { return typeof Chart !== 'undefined'; },

    clear(id) {
        if (this._inst[id]) { this._inst[id].destroy(); delete this._inst[id]; }
    },
    clearAll() { Object.keys(this._inst).forEach(id => this.clear(id)); },

    mount(id, config) {
        const canvas = typeof document !== 'undefined' ? document.getElementById(id) : null;
        if (!canvas || !this.available()) return null;
        if (!this._init) {
            Chart.defaults.font.family = Report.FONT;
            Chart.defaults.color = Report.INK.muted;
            this._init = true;
        }
        this.clear(id);
        this._inst[id] = new Chart(canvas, config);
        return this._inst[id];
    },

    // Tooltip: satu kotak, nilai di depan, nama seri menyusul, kunci berupa garis pendek
    tooltip(callbacks) {
        const I = Report.INK;
        return {
            backgroundColor: I.surface, titleColor: I.secondary, bodyColor: I.primary, footerColor: I.muted,
            borderColor: I.baseline, borderWidth: 1, padding: 10, cornerRadius: 10, boxPadding: 4,
            usePointStyle: true, boxWidth: 14,
            titleFont: { size: 12, weight: '500' }, bodyFont: { size: 12, weight: '600' }, footerFont: { size: 11, weight: '400' },
            callbacks
        };
    },

    // ---------- Tren omset & laba bersih (garis, satu sumbu) ----------
    trend(id, t) {
        const C = Report.COLORS, I = Report.INK, n = t.labels.length;
        const peak = arr => arr.reduce((best, v, i, a) => (v > a[best] ? i : best), 0);
        const pk = [peak(t.omset), peak(t.laba)];
        const series = (label, data, color, k) => ({
            label, data, borderColor: color, backgroundColor: color, fill: false,
            borderWidth: 2, tension: 0, borderJoinStyle: 'round', borderCapStyle: 'round',
            // penanda >= 8px: semua titik kalau sedikit, kalau banyak hanya titik puncak
            pointRadius: c => (n <= 14 || c.dataIndex === pk[k]) ? 4 : 0,
            pointHoverRadius: 5, pointHitRadius: 12,
            pointBackgroundColor: color, pointBorderColor: I.surface, pointBorderWidth: 2, pointHoverBorderWidth: 2
        });

        // Garis tegak tipis yang mengikuti titik terdekat
        const crosshair = {
            id: 'crosshair',
            beforeDatasetsDraw(chart) {
                const act = chart.tooltip && chart.tooltip.getActiveElements ? chart.tooltip.getActiveElements() : [];
                if (!act.length) return;
                const x = act[0].element.x, a = chart.chartArea, ctx = chart.ctx;
                ctx.save(); ctx.beginPath(); ctx.moveTo(x, a.top); ctx.lineTo(x, a.bottom);
                ctx.lineWidth = 1; ctx.strokeStyle = I.baseline; ctx.stroke(); ctx.restore();
            }
        };
        // Label nilai hanya di titik puncak tiap seri (bukan di setiap titik)
        const peakLabels = {
            id: 'peakLabels',
            afterDatasetsDraw(chart) {
                const ctx = chart.ctx, a = chart.chartArea;
                chart.data.datasets.forEach((ds, k) => {
                    const meta = chart.getDatasetMeta(k);
                    const v = ds.data[pk[k]], pt = meta.data[pk[k]];
                    if (meta.hidden || !(v > 0) || !pt) return;
                    const text = Report.compact(v);
                    ctx.save();
                    ctx.font = '600 11px ' + Report.FONT; ctx.fillStyle = I.secondary; ctx.textAlign = 'center';
                    const w = ctx.measureText(text).width;
                    const x = Math.min(Math.max(pt.x, a.left + w / 2), a.right - w / 2);
                    const below = k === 1 && pt.y + 22 <= a.bottom;   // laba di bawah titiknya, omset di atas
                    ctx.textBaseline = below ? 'top' : 'bottom';
                    ctx.fillText(text, x, pt.y + (below ? 8 : -8));
                    ctx.restore();
                });
            }
        };

        return this.mount(id, {
            type: 'line',
            data: { labels: t.labels, datasets: [series('Omset', t.omset, C.omset, 0), series('Laba bersih', t.laba, C.laba, 1)] },
            options: {
                responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
                layout: { padding: { top: 18, right: 8 } },
                interaction: { mode: 'index', intersect: false },
                scales: {
                    x: { grid: { display: false }, border: { color: I.baseline },
                         ticks: { color: I.muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 7, font: { size: 11 } } },
                    y: { beginAtZero: true, grid: { color: I.grid, lineWidth: 1 }, border: { display: false },
                         ticks: { color: I.muted, maxTicksLimit: 5, font: { size: 11 }, callback: v => Report.compact(v) } }
                },
                plugins: {
                    legend: { display: false },     // legenda dibuat di HTML (kunci garis)
                    tooltip: this.tooltip({
                        title: items => t.titles[items[0].dataIndex],
                        label: c => Report.rupiah(c.parsed.y) + '  ' + c.dataset.label,
                        labelPointStyle: () => ({ pointStyle: 'line', rotation: 0 }),
                        footer: items => 'Transaksi selesai: ' + t.count[items[0].dataIndex]
                    })
                }
            },
            plugins: [crosshair, peakLabels]
        });
    },

    // ---------- Batang horizontal (satu seri, satu warna) ----------
    // rows: [{ label, value, tip: [baris tambahan tooltip] }]
    bars(id, rows, { fmt, tipFmt, color }) {
        const I = Report.INK;
        // Nilai di ujung batang
        const tipLabels = {
            id: 'tipLabels',
            afterDatasetsDraw(chart) {
                const ctx = chart.ctx, meta = chart.getDatasetMeta(0);
                ctx.save();
                ctx.font = '600 11px ' + Report.FONT; ctx.fillStyle = I.secondary;
                ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
                meta.data.forEach((bar, i) => ctx.fillText(fmt(rows[i].value), bar.x + 6, bar.y));
                ctx.restore();
            }
        };
        return this.mount(id, {
            type: 'bar',
            data: {
                labels: rows.map(r => r.label),
                datasets: [{
                    data: rows.map(r => r.value),
                    backgroundColor: color, hoverBackgroundColor: '#a53a50',
                    borderRadius: { topLeft: 0, bottomLeft: 0, topRight: 4, bottomRight: 4 }, borderSkipped: false,
                    maxBarThickness: 20, categoryPercentage: 0.8, barPercentage: 0.8
                }]
            },
            options: {
                indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
                layout: { padding: { right: 56, top: 2, bottom: 2 } },
                interaction: { mode: 'nearest', axis: 'y', intersect: false },   // seluruh baris jadi area sentuh
                scales: {
                    x: { display: false, beginAtZero: true },                   // nilai sudah tertulis di ujung batang
                    y: { grid: { display: false }, border: { color: I.baseline },
                         ticks: { color: I.secondary, font: { size: 12 },
                                  callback(v) { const l = String(this.getLabelForValue(v)); return l.length > 16 ? l.slice(0, 15) + '…' : l; } } }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: this.tooltip({
                        title: items => rows[items[0].dataIndex].label,
                        label: c => tipFmt(rows[c.dataIndex].value),
                        labelPointStyle: () => ({ pointStyle: 'rect', rotation: 0 }),
                        footer: items => rows[items[0].dataIndex].tip
                    })
                }
            },
            plugins: [tipLabels]
        });
    },

    channels(id, channels) {
        return this.bars(id, channels.map(c => ({
            label: c.channel, value: c.revenue,
            tip: ['Transaksi: ' + c.count, 'Laba bersih: ' + Report.rupiah(c.profit)]
        })), { fmt: v => Report.compact(v), tipFmt: v => Report.rupiah(v) + '  Omset', color: Report.COLORS.omset });
    },
    products(id, products) {
        return this.bars(id, products.map(p => ({
            label: p.name, value: p.qty,
            tip: ['Omset: ' + Report.rupiah(p.revenue), 'Laba kotor: ' + Report.rupiah(p.profit)]
        })), { fmt: v => v + ' pcs', tipFmt: v => v + ' pcs terjual', color: Report.COLORS.omset });
    }
};
