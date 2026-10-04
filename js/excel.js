/* excel.js — 作成結果を .xlsx に書き出す（縦長：行＝日付、列＝職員） */
(function () {
  'use strict';
  const M = window.ShiftModel;

  const thin = { style: 'thin', color: { argb: 'FF9AA0A6' } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };
  const RED = 'FFC00000', BLUE = 'FF1F4E99';

  function colName(n) {
    let s = '';
    for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  }

  async function build(state, p, A, ev) {
    const ExcelJS = window.ExcelJS;
    const cal = M.buildCalendar(state);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'シフト自動作成';
    wb.created = new Date();
    // 前月のデータとして読み込むときに、どの月の勤務表かを確かめるための情報
    wb.title = `${state.year}年${state.month}月 勤務表`;
    wb.subject = `y-shift:${state.year}-${state.month}`;

    const S = p.S, D = p.D;
    const firstStaffCol = 3; // A:日 B:曜
    const lastStaffCol = firstStaffCol + S - 1;
    // 人数の列：その月に人数の指定がある勤務
    const countShifts = state.shifts.filter((x, k) => p.isDemand[k] && p.demand.some((row) => row[k] > 0));
    const firstCountCol = lastStaffCol + 1;
    const noteCol = firstCountCol + countShifts.length; // 備考（休日の3人勤務の日など）
    const lastCol = noteCol;
    const headerRow = 3;
    const firstDayRow = headerRow + 1;
    const lastDayRow = firstDayRow + D - 1;
    const sL = colName(firstStaffCol), sR = colName(lastStaffCol);

    const ws = wb.addWorksheet('勤務表', {
      views: [{ state: 'frozen', xSplit: 2, ySplit: headerRow }],
      pageSetup: {
        paperSize: 9,
        orientation: 'portrait',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 1,
        margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
      },
    });

    // タイトル
    ws.mergeCells(1, 1, 1, Math.max(lastCol, lastStaffCol));
    const title = ws.getCell(1, 1);
    title.value = `${state.year}年${state.month}月 勤務表`;
    title.font = { size: 14, bold: true };
    ws.mergeCells(2, 1, 2, Math.max(lastCol, lastStaffCol));
    const note = ws.getCell(2, 1);
    note.value = ev.hardCount > 0 ? `※未完成：必ず守る条件の違反が${ev.hardCount}件あります（「条件チェック」シート参照）` : '';
    note.font = { color: { argb: RED }, bold: true };

    // 見出し
    const head = ws.getRow(headerRow);
    head.getCell(1).value = '日';
    head.getCell(2).value = '曜';
    state.staff.forEach((st, s) => (head.getCell(firstStaffCol + s).value = st.name));
    countShifts.forEach((x, i) => (head.getCell(firstCountCol + i).value = x.code + '人数'));
    head.getCell(noteCol).value = '備考';
    for (let c = 1; c <= lastCol; c++) {
      const cell = head.getCell(c);
      cell.font = { bold: true };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
      cell.border = border;
    }
    head.height = 30;

    // 日ごとの行
    cal.forEach((c, d) => {
      const r = firstDayRow + d;
      const row = ws.getRow(r);
      const dayColor = c.dow === 0 || c.holidayName ? RED : c.dow === 6 ? BLUE : undefined;
      const dateFill = c.type === 'holiday' ? { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE9E7' } } : undefined;
      row.getCell(1).value = c.day;
      row.getCell(2).value = c.dowLabel;
      if (c.holidayName) row.getCell(2).note = c.holidayName;
      for (const ci of [1, 2]) {
        const cell = row.getCell(ci);
        if (dayColor) cell.font = { color: { argb: dayColor }, bold: true };
        if (dateFill) cell.fill = dateFill;
      }
      for (let s = 0; s < S; s++) {
        const code = p.codes[A[s][d]];
        const cell = row.getCell(firstStaffCol + s);
        cell.value = code;
      }
      const planIdx = M.dayPlanIndex(p, A, d); // 1以上なら休日の3人勤務
      const plan = p.plans[d][planIdx];
      countShifts.forEach((x, i) => {
        const k = p.codes.indexOf(x.code);
        let n = 0;
        for (let s = 0; s < S; s++) if (A[s][d] === k) n++;
        const cell = row.getCell(firstCountCol + i);
        cell.value = { formula: `COUNTIF(${sL}${r}:${sR}${r},"${x.code}")`, result: n };
        if (n !== plan[k]) cell.font = { color: { argb: RED }, bold: true };
      });
      const notes = [];
      if (planIdx > 0) notes.push('3人勤務');
      if (c.holidayName) notes.push(c.holidayName);
      row.getCell(noteCol).value = notes.join('・');
      for (let ci = 1; ci <= lastCol; ci++) {
        const cell = row.getCell(ci);
        cell.border = border;
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      }
    });

    // 職員ごとの集計（数式なので、Excel 上で勤務を直しても再計算される）
    const st = M.stats(p, A);
    const codesWhere = (pred) => state.shifts.filter(pred).map((x) => x.code);
    const countFormula = (col, codes) =>
      codes.length ? codes.map((c) => `COUNTIF(${col}${firstDayRow}:${col}${lastDayRow},"${c}")`).join('+') : '0';
    const usedShifts = state.shifts.filter((x, k) => k !== p.fillerIdx && st.some((t) => t.count[k] > 0));
    const footRows = [
      { label: '公休', codes: codesWhere((x) => x.off), value: (s) => st[s].off },
      { label: '有休', codes: codesWhere((x) => x.leave), value: (s) => st[s].leave },
      { label: '休み計', codes: codesWhere((x) => x.off || x.leave), value: (s) => st[s].rest },
      { label: '勤務日数', codes: codesWhere((x) => x.work), value: (s) => st[s].work },
      { label: '宿直回数', codes: codesWhere((x) => x.night === 'in'), value: (s) => st[s].nights },
      ...usedShifts.map((x) => ({ label: x.code + '回数', codes: [x.code], value: (s) => st[s].count[p.codes.indexOf(x.code)] })),
    ];
    footRows.forEach((f, i) => {
      const r = lastDayRow + 1 + i;
      ws.mergeCells(r, 1, r, 2);
      ws.getRow(r).height = 18;
      const lab = ws.getCell(r, 1);
      lab.value = f.label;
      lab.font = { bold: true };
      lab.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
      for (let s = 0; s < S; s++) {
        const col = colName(firstStaffCol + s);
        const formula = countFormula(col, f.codes);
        ws.getCell(r, firstStaffCol + s).value = { formula, result: f.value(s) };
      }
      for (let c = 1; c <= lastStaffCol; c++) {
        const cell = ws.getCell(r, c);
        cell.border = border;
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      }
    });

    ws.getColumn(1).width = 5;
    ws.getColumn(2).width = 4;
    for (let c = firstStaffCol; c <= lastStaffCol; c++) ws.getColumn(c).width = 9;
    for (let c = firstCountCol; c < noteCol; c++) ws.getColumn(c).width = 6;
    ws.getColumn(noteCol).width = 14;

    // 勤務区分の凡例
    const lg = wb.addWorksheet('勤務区分');
    lg.columns = [
      { header: '記号', key: 'code', width: 7 },
      { header: '名称', key: 'name', width: 14 },
      { header: 'ホームでの役割', key: 'role', width: 14 },
      { header: '宿直', key: 'night', width: 26 },
      { header: '勤務日', key: 'work', width: 8 },
      { header: '公休', key: 'off', width: 8 },
      { header: '有休', key: 'leave', width: 8 },
    ];
    state.shifts.forEach((x) => {
      const mark = (b) => (b ? '○' : '');
      const row = lg.addRow({ code: x.code, name: x.name, role: x.role === 'none' ? '' : M.ROLE_LABELS[x.role], night: x.night === 'none' ? '' : M.NIGHT_LABELS[x.night], work: mark(x.work), off: mark(x.off), leave: mark(x.leave) });
      row.getCell(1).alignment = { horizontal: 'center' };
    });
    lg.getRow(1).font = { bold: true };

    // 条件チェック
    const ck = wb.addWorksheet('条件チェック');
    ck.columns = [
      { header: '区分', key: 'level', width: 16 },
      { header: '日付', key: 'day', width: 10 },
      { header: '職員', key: 'staff', width: 10 },
      { header: '内容', key: 'msg', width: 50 },
    ];
    ck.getRow(1).font = { bold: true };
    if (!ev.violations.length) ck.addRow({ level: '', day: '', staff: '', msg: '必ず守る条件・希望をすべて満たしています。' });
    else if (!ev.hardCount) ck.addRow({ level: '', day: '', staff: '', msg: '必ず守る条件はすべて満たしています。' });
    for (const v of ev.violations) {
      const row = ck.addRow({
        level: v.level === 'hard' ? '必ず守る条件' : '希望',
        day: v.day >= 0 ? p.dayLabels[v.day] : '',
        staff: v.staff >= 0 ? p.names[v.staff] : '',
        msg: v.msg,
      });
      if (v.level === 'hard') row.font = { color: { argb: RED } };
    }

    const buf = await wb.xlsx.writeBuffer();
    return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  // セルの値を文字列にする（数式・書式付き文字列にも対応）
  function cellText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') {
      if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('').trim();
      if ('result' in v) return v.result === null || v.result === undefined ? '' : String(v.result).trim();
      if ('text' in v) return String(v.text).trim();
      if (v instanceof Date) return '';
    }
    return String(v).trim();
  }

  // このアプリで出力した勤務表の .xlsx を読む。
  // 戻り値：{ header: ['日','曜',職員名…], rows: [[日,曜,記号…]], subject: {y,m}|null, title: {y,m}|null }
  async function read(file) {
    const ExcelJS = window.ExcelJS;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await file.arrayBuffer());
    const ws = wb.getWorksheet('勤務表') || wb.worksheets[0];
    if (!ws) throw new Error('シートがありません');
    let headerRow = 0;
    ws.eachRow((row, i) => {
      if (!headerRow && cellText(row.getCell(1).value) === '日') headerRow = i;
    });
    if (!headerRow) return { header: [], rows: [], subject: null, title: null };
    const width = ws.columnCount;
    const rowText = (r) => Array.from({ length: width }, (_, i) => cellText(ws.getRow(r).getCell(i + 1).value));
    // 職員の列：見出しの3列目から、「○人数」「備考」の手前まで
    const header = [];
    for (const h of rowText(headerRow)) {
      if (header.length >= 2 && (!h || /人数$/.test(h) || h === '備考')) break;
      header.push(h);
    }
    const rows = [];
    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      const t = rowText(r).slice(0, header.length);
      if (/^\d{1,2}$/.test(t[0])) rows.push(t);
    }
    const ym = (text, re) => {
      const m = re.exec(text || '');
      return m ? { y: Number(m[1]), m: Number(m[2]) } : null;
    };
    return {
      header,
      rows,
      subject: ym(wb.subject, /y-shift:(\d{4})-(\d{1,2})/),
      title: ym(cellText(ws.getCell(1, 1).value), /(\d{4})年(\d{1,2})月/),
    };
  }

  window.ShiftExcel = { build, read };
})();
