// xlsx.js - Penulis file Excel (.xlsx) mini, tanpa library dan tanpa internet.
// .xlsx = arsip ZIP berisi XML. Di sini ZIP ditulis tanpa kompresi (method "store").
//
// sheets = [{ name, widths: [angka], cols: [{ h: 'Judul', t: 'text'|'money'|'int' }], rows: [[...]] }]
// Gaya sel: 0 biasa, 1 judul kolom (maroon), 2 uang (#,##0), 3 tebal, 4 judul besar, 5 uang tebal.
const XLSX = {
    _crcTable: null,
    crc32(bytes) {
        if (!this._crcTable) {
            this._crcTable = new Uint32Array(256);
            for (let n = 0; n < 256; n++) {
                let c = n;
                for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
                this._crcTable[n] = c >>> 0;
            }
        }
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i++) crc = this._crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
        return (crc ^ 0xFFFFFFFF) >>> 0;
    },

    // Rakit arsip ZIP dari [{ name, data: Uint8Array }]
    zip(files) {
        const enc = new TextEncoder();
        const now = new Date();
        const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
        const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
        const parts = [], central = [];
        let offset = 0;
        for (const f of files) {
            const name = enc.encode(f.name), crc = this.crc32(f.data), size = f.data.length;
            const lh = new DataView(new ArrayBuffer(30));
            lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
            lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
            lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
            lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
            parts.push(new Uint8Array(lh.buffer), name, f.data);

            const ch = new DataView(new ArrayBuffer(46));
            ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
            ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
            ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true);
            ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
            central.push(new Uint8Array(ch.buffer), name);
            offset += 30 + name.length + size;
        }
        const cdSize = central.reduce((s, a) => s + a.length, 0);
        const end = new DataView(new ArrayBuffer(22));
        end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
        end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
        const all = [...parts, ...central, new Uint8Array(end.buffer)];
        const out = new Uint8Array(all.reduce((s, a) => s + a.length, 0));
        let p = 0;
        for (const a of all) { out.set(a, p); p += a.length; }
        return out;
    },

    esc(s) {
        return String(s)
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    },
    colName(i) { // 0 -> A, 26 -> AA
        let s = '';
        for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s;
        return s;
    },
    sheetName(n, used) {
        let base = String(n).replace(/[\[\]:*?\/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
        let name = base, i = 2;
        while (used.has(name.toLowerCase())) name = base.slice(0, 28) + ' ' + i++;
        used.add(name.toLowerCase());
        return name;
    },

    cell(ref, v, style) {
        const s = style ? ` s="${style}"` : '';
        if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${s}><v>${v}</v></c>`;
        if (v === null || v === undefined || v === '') return style ? `<c r="${ref}"${s}/>` : '';
        return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${this.esc(v)}</t></is></c>`;
    },

    sheetXml(sh) {
        const cols = sh.cols || [];
        const styleOf = c => (c.t === 'money' ? 2 : 0);
        let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
        if (cols.length) xml += '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
        const widths = sh.widths || cols.map(c => Math.max(12, String(c.h).length + 4));
        if (widths.length) xml += '<cols>' + widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>';
        xml += '<sheetData>';
        let r = 1;
        if (cols.length) {
            xml += `<row r="1" ht="22" customHeight="1">` + cols.map((c, i) => this.cell(this.colName(i) + 1, c.h, 1)).join('') + '</row>';
            r = 2;
        }
        for (const row of sh.rows) {
            // baris boleh berupa array biasa atau { cells: [...], styles: [...] } untuk gaya per sel
            const cells = Array.isArray(row) ? row : row.cells;
            const styles = Array.isArray(row) ? null : row.styles;
            xml += `<row r="${r}">` + cells.map((v, i) =>
                this.cell(this.colName(i) + r, v, styles ? styles[i] : (cols[i] ? styleOf(cols[i]) : 0))).join('') + '</row>';
            r++;
        }
        xml += '</sheetData>';
        if (cols.length && sh.rows.length) xml += `<autoFilter ref="A1:${this.colName(cols.length - 1)}${sh.rows.length + 1}"/>`;
        return xml + '</worksheet>';
    },

    stylesXml() {
        return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
            '<fonts count="4">' +
            '<font><sz val="11"/><name val="Calibri"/></font>' +
            '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>' +
            '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
            '<font><b/><sz val="16"/><color rgb="FF8B2B3D"/><name val="Calibri"/></font>' +
            '</fonts>' +
            '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
            '<fill><patternFill patternType="solid"><fgColor rgb="FF8B2B3D"/><bgColor indexed="64"/></patternFill></fill></fills>' +
            '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
            '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
            '<cellXfs count="6">' +
            '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
            '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
            '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
            '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
            '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
            '<xf numFmtId="3" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>' +
            '</cellXfs>' +
            '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
            '</styleSheet>';
    },

    // Bangun file .xlsx (Uint8Array) dari daftar sheet
    build(sheets) {
        const enc = new TextEncoder(), used = new Set();
        const names = sheets.map(s => this.sheetName(s.name, used));
        const files = [
            { name: '[Content_Types].xml', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>' },
            { name: '_rels/.rels', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
            { name: 'xl/workbook.xml', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + names.map((n, i) => `<sheet name="${this.esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>' },
            { name: 'xl/_rels/workbook.xml.rels', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
            { name: 'xl/styles.xml', text: this.stylesXml() },
            ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, text: this.sheetXml(s) }))
        ].map(f => ({ name: f.name, data: enc.encode(f.text) }));
        return this.zip(files);
    },

    // Bangun lalu unduh
    download(sheets, filename) {
        const blob = new Blob([this.build(sheets)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        DB.downloadBlob(blob, filename);
    }
};
