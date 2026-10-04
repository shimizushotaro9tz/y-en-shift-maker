/*
 * model.js — 暦・設定の初期値・問題データへの変換・条件チェック
 * 画面（app.js）と計算用ワーカー（worker.js）の両方から読み込む。DOM には触れない。
 */
(function (root) {
  'use strict';

  const VERSION = 3;
  const PREV_DAYS = 7; // 入力できる前月末の日数

  // 宿直とのつながり
  const NIGHT = { NONE: 0, IN: 1, OUT: 2 };
  const NIGHT_KEYS = ['none', 'in', 'out'];
  const NIGHT_LABELS = {
    none: 'なし',
    in: '宿直入り（翌日は宿直明け）',
    out: '宿直明け（前日が宿直入り）',
  };

  // ホームでの役割（各ホームに早番か断続が1名、遅番が1名必要）
  // 断続は早番とも遅番とも時間帯が重なる
  const ROLE = { NONE: 0, EARLY: 1, LATE: 2, SPLIT: 3 };
  const ROLE_KEYS = ['none', 'early', 'split', 'late'];
  const ROLE_LABELS = { none: 'なし', early: '早番', split: '断続', late: '遅番' };
  const isMorning = (r) => r === ROLE.EARLY || r === ROLE.SPLIT;
  // 職員の担当ホーム
  const HOME_KEYS = ['A', 'B', 'both'];
  const HOME_LABELS = { A: 'ホームA', B: 'ホームB', both: 'どちらも' };
  const HOME_MASK = { A: 1, B: 2, both: 3 };

  // 違反の重み。必ず守る条件は HARD、それ以外は希望（ソフト制約）
  const W = {
    HARD: 1000,
    WISH: 400, // 希望休。休日の3人勤務（THREE）より優先する
    OFF_BALANCE: 60, // 公休数を自動で均等にするとき、平均からのずれ（2乗）
    RUN: [0, 30, 0, 0, 5, 30], // 連勤の長さごとの罰点（1日だけの勤務・5連勤を避け、2〜3連勤を中心に）
    RUN_OVER: 30,
    LONG_REST: 15, // 5連休以上の1日あたり
    FAIR_NIGHT: 10,
    NIGHT_GAP: 4, // 宿直の間隔が目安より短いとき、足りない日数の2乗あたり
    THREE: 300, // 休日の3人勤務（やむを得ない場合だけ）
    NIGHT_GAP2: 80, // 中1日の宿直（DE→EA→DE のように、明けの翌日にまた宿直入り）。優先度高め
    FAIR_CODE: 3,
    FAIR_WEEKEND: 3,
  };
  const LONG_REST_FROM = 5;

  const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

  function daysInMonth(y, m) {
    return new Date(y, m, 0).getDate();
  }

  // ---------- 祝日（2020年以降の祝日法に基づく。1980〜2099年で有効） ----------
  function nthMonday(y, m, n) {
    const first = new Date(y, m - 1, 1).getDay();
    return 1 + ((8 - first) % 7) + (n - 1) * 7;
  }

  function jpHolidaysOfYear(y) {
    const h = new Map(); // 'M-D' -> 名前
    const add = (m, d, name) => h.set(m + '-' + d, name);
    const shift = y - 1980;
    const spring = Math.floor(20.8431 + 0.242194 * shift - Math.floor(shift / 4));
    const autumn = Math.floor(23.2488 + 0.242194 * shift - Math.floor(shift / 4));
    add(1, 1, '元日');
    add(1, nthMonday(y, 1, 2), '成人の日');
    add(2, 11, '建国記念の日');
    add(2, 23, '天皇誕生日');
    add(3, spring, '春分の日');
    add(4, 29, '昭和の日');
    add(5, 3, '憲法記念日');
    add(5, 4, 'みどりの日');
    add(5, 5, 'こどもの日');
    add(7, nthMonday(y, 7, 3), '海の日');
    add(8, 11, '山の日');
    add(9, nthMonday(y, 9, 3), '敬老の日');
    add(9, autumn, '秋分の日');
    add(10, nthMonday(y, 10, 2), 'スポーツの日');
    add(11, 3, '文化の日');
    add(11, 23, '勤労感謝の日');

    // 国民の休日（祝日に挟まれた平日）
    for (let m = 1; m <= 12; m++) {
      const dim = daysInMonth(y, m);
      for (let d = 2; d < dim; d++) {
        if (h.has(m + '-' + d)) continue;
        if (new Date(y, m - 1, d).getDay() === 0) continue;
        if (h.has(m + '-' + (d - 1)) && h.has(m + '-' + (d + 1))) add(m, d, '国民の休日');
      }
    }
    // 振替休日（日曜の祝日の後の最初の平日）
    const base = Array.from(h.keys());
    for (const key of base) {
      const [m, d] = key.split('-').map(Number);
      if (new Date(y, m - 1, d).getDay() !== 0) continue;
      const dt = new Date(y, m - 1, d + 1);
      while (h.has(dt.getMonth() + 1 + '-' + dt.getDate())) dt.setDate(dt.getDate() + 1);
      add(dt.getMonth() + 1, dt.getDate(), '振替休日');
    }
    return h;
  }

  // 月の暦。type は 'weekday'（平日）か 'holiday'（休日＝土日祝）
  function buildCalendar(state) {
    const y = state.year, m = state.month;
    const hol = jpHolidaysOfYear(y);
    const overrides = state.dayTypeOverrides || {};
    const days = [];
    for (let d = 1; d <= daysInMonth(y, m); d++) {
      const dow = new Date(y, m - 1, d).getDay();
      const holidayName = hol.get(m + '-' + d) || '';
      const auto = dow === 0 || dow === 6 || !!holidayName ? 'holiday' : 'weekday';
      days.push({ day: d, dow, dowLabel: WEEK[dow], holidayName, autoType: auto, type: overrides[d] || auto });
    }
    return days;
  }

  // ---------- 初期値 ----------
  function sh(code, name, color, opt) {
    const x = Object.assign({ code, name, color, night: 'none', role: 'none', work: true, off: false, leave: false }, opt || {});
    return { code: x.code, name: x.name, color: x.color, night: x.night, role: x.role || 'none', work: !!x.work, off: !!x.off, leave: !!x.leave };
  }

  function defaultShifts() {
    return [
      sh('A', '断続勤務', '#FFF2CC', { role: 'split' }),
      sh('B', '日勤', '#E2EFDA'),
      sh('C', '早番', '#FCE4D6', { role: 'early' }),
      sh('D', '遅番', '#DDEBF7', { role: 'late' }),
      sh('BE', '日勤→宿直', '#D9D2E9', { night: 'in' }),
      sh('DE', '遅番→宿直', '#C9C2E0', { night: 'in', role: 'late' }),
      sh('EC', '宿直明け→早番', '#EADCF0', { night: 'out', role: 'early' }),
      sh('EA', '宿直明け→断続勤務', '#E6E0F0', { night: 'out', role: 'split' }),
      sh('公', '公休', '#FFFFFF', { work: false, off: true }),
      sh('有', '有休', '#F8E0E0', { work: false, leave: true }),
      sh('公E', '公休→宿直', '#E8E3F2', { night: 'in', work: false, off: true }),
      sh('有E', '有休→宿直', '#EFE3EC', { night: 'in', work: false, leave: true }),
      sh('E公', '宿直明け→公休', '#F0EDF5', { night: 'out', work: false, off: true }),
      sh('E有', '宿直明け→有休', '#F5EAF0', { night: 'out', work: false, leave: true }),
    ];
  }

  const DEFAULT_STAFF = [
    ['職員A1', 'A'],
    ['職員A2', 'A'],
    ['職員B1', 'B'],
    ['職員B2', 'B'],
    ['職員F1', 'both'],
    ['職員F2', 'both'],
  ];

  function defaultThreePlans() {
    return [
      { EA: 1, C: 1, DE: 1 },
      { EC: 1, A: 1, DE: 1 },
    ];
  }

  function defaultState() {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const staff = DEFAULT_STAFF.map(([name, home], i) => ({
      id: 's' + (i + 1),
      name,
      home,
      canNight: true,
      minNights: null, // null ならルールの値
      maxNights: null,
      holidays: null, // null なら自動（全員で均等）
      prevTail: emptyTail(), // 前月末の勤務（古い日→月末）。初期値はすべて未入力
    }));
    return {
      version: VERSION,
      year: next.getFullYear(),
      month: next.getMonth() + 1,
      staff,
      shifts: defaultShifts(),
      demand: {
        weekday: { EA: 1, A: 1, D: 1, DE: 1 },
        holiday: { EC: 1, C: 1, D: 1, DE: 1 },
      },
      demandOverrides: {}, // demandOverrides[day][code] = 人数（その日だけの変更）
      extraDemandCols: [], // シフト表の右側の人数欄に、基本の人数が0でも表示する勤務
      // 休日の3人勤務（休みを確保できない場合だけ使う体制）
      threePerson: { enabled: true, plans: defaultThreePlans() },
      rules: {
        maxConsecutive: 5,
        minRest: 8, // 休み（公休＋有休）の日数の範囲
        maxRest: 11,
        minNights: null, // null なら自動（宿直の総数 ÷ 宿直できる人数 の切り捨て〜切り上げ）
        maxNights: null,
        maxNightDiff: 1,
        minNightGap: 2, // 宿直入りから次の宿直入りまでの最低日数（2 = 2日連続の宿直なし）
        forbiddenPairs: [{ from: 'D', to: 'C' }],
        fillerCode: '公',
        timeLimitSec: 15,
      },
      dayTypeOverrides: {},
      requests: {}, // requests[staffId][day] = 'wish:公' | 'fix:A'
      locks: {}, // locks[staffId][day] = 'A'（作成結果で手修正して固定したセル）
      result: null, // { year, month, grid: { staffId: ['A', ...] } }
    };
  }

  // 保存データを読み込むとき、欠けている項目を初期値で補う（形式の古いデータは初期値に戻す）
  function normalizeState(s) {
    const d = defaultState();
    if (!s || typeof s !== 'object' || (s.version !== VERSION && s.version !== 2)) return d;
    const out = Object.assign({}, d, s);
    out.version = VERSION;
    out.rules = Object.assign({}, d.rules, s.rules || {});
    if (!Array.isArray(out.rules.forbiddenPairs)) out.rules.forbiddenPairs = [];
    out.demand = s.demand && s.demand.weekday && s.demand.holiday ? s.demand : d.demand;
    // 以前の版の仮名「職員A〜職員Z」は「職員1〜」に置き換える
    out.staff = (Array.isArray(s.staff) ? s.staff : d.staff).map((st) => {
      const m = /^職員([A-Z])$/.exec(st.name || '');
      return normalizeStaff(m ? Object.assign({}, st, { name: '職員' + (m[1].charCodeAt(0) - 64) }) : st);
    });
    // 版2 → 版3：初期の仮名（職員1〜6）は、担当ホーム付きの初期の職員に置き換える
    if (s.version === 2 && out.staff.length === 6 && out.staff.every((st, i) => st.name === '職員' + (i + 1)))
      out.staff.forEach((st, i) => Object.assign(st, { name: DEFAULT_STAFF[i][0], home: DEFAULT_STAFF[i][1] }));
    const defRole = {};
    for (const x of defaultShifts()) defRole[x.code] = x.role;
    out.shifts =
      Array.isArray(s.shifts) && s.shifts.length
        ? s.shifts.map((x) => sh(x.code, x.name, x.color, Object.assign({ role: defRole[x.code] || 'none' }, x)))
        : d.shifts;
    const tp = s.threePerson;
    out.threePerson = {
      enabled: tp ? !!tp.enabled : true,
      plans: tp && Array.isArray(tp.plans) ? tp.plans.map((pl) => Object.assign({}, pl)) : defaultThreePlans(),
    };
    for (const k of ['requests', 'locks', 'dayTypeOverrides', 'demandOverrides']) out[k] = s[k] || {};
    out.extraDemandCols = Array.isArray(s.extraDemandCols) ? s.extraDemandCols : [];
    return out;
  }

  function emptyTail() {
    return new Array(PREV_DAYS).fill('');
  }

  function normalizeStaff(st) {
    const out = Object.assign({ home: 'both', canNight: true, minNights: null, maxNights: null, holidays: null }, st);
    if (!HOME_MASK[out.home]) out.home = 'both';
    const tail = Array.isArray(st.prevTail) ? st.prevTail.slice(-PREV_DAYS) : emptyTail();
    while (tail.length < PREV_DAYS) tail.unshift('');
    // 以前の形式（前月末日の勤務のみ）からの移行
    if (!Array.isArray(st.prevTail) && st.prevLast) tail[PREV_DAYS - 1] = st.prevLast;
    out.prevTail = tail;
    delete out.prevLast;
    delete out.prevConsec;
    return out;
  }

  // 前月末の日付（古い日→月末）
  function prevMonthDays(state) {
    const last = new Date(state.year, state.month - 1, 0);
    const days = [];
    for (let i = PREV_DAYS - 1; i >= 0; i--) {
      const dt = new Date(last.getFullYear(), last.getMonth(), last.getDate() - i);
      days.push({ month: dt.getMonth() + 1, day: dt.getDate(), dow: dt.getDay(), dowLabel: WEEK[dt.getDay()] });
    }
    return days;
  }

  // 人数を指定する勤務（休みの穴埋め用と、有休だけの区分を除く）
  function isDemandShift(state, x) {
    if (x.code === state.rules.fillerCode) return false;
    return !(x.leave && !x.work && x.night === 'none');
  }

  // その日の必要人数（日付ごとの変更があればそれを優先）
  function demandOf(state, day, type, code) {
    const ov = state.demandOverrides[day];
    if (ov && ov[code] !== undefined) return Number(ov[code]) || 0;
    return Number((state.demand[type] || {})[code]) || 0;
  }

  // ---------- 設定そのものの不備 ----------
  function validateSettings(state) {
    const errs = [];
    const codes = state.shifts.map((x) => x.code);
    if (!state.staff.length) errs.push('職員が登録されていません。');
    if (codes.some((c) => !c)) errs.push('記号が空欄の勤務区分があります。');
    if (new Set(codes).size !== codes.length) errs.push('勤務区分の記号が重複しています。');
    const hasIn = state.shifts.some((x) => x.night === 'in');
    const hasOut = state.shifts.some((x) => x.night === 'out');
    if (hasIn && !hasOut) errs.push('「宿直入り」の勤務区分があるときは、「宿直明け」の勤務区分も必要です。');
    const filler = state.shifts.find((x) => x.code === state.rules.fillerCode);
    if (!filler) errs.push('「ルール」で、人数の指定がない職員に入れる休み（公休）を選んでください。');
    else if (filler.work || filler.night !== 'none')
      errs.push(`人数の指定がない職員に入れる勤務「${filler.code}」は、勤務日に数えず宿直もない区分（公休など）にしてください。`);
    const names = state.staff.map((s) => s.name.trim());
    if (names.some((n) => !n)) errs.push('仮名が空欄の職員がいます。');
    if (new Set(names).size !== names.length) errs.push('仮名が重複している職員がいます。');
    return errs;
  }

  // 宿直回数の自動の範囲：月の宿直入りの総数 ÷ 宿直できる人数 の切り捨て〜切り上げ
  function nightRange(state, demand, codes) {
    if (!demand) {
      const cal = buildCalendar(state);
      codes = state.shifts.map((x) => x.code);
      demand = cal.map((c) => state.shifts.map((x) => (isDemandShift(state, x) ? demandOf(state, c.day, c.type, x.code) : 0)));
    }
    let total = 0;
    state.shifts.forEach((x, k) => {
      if (x.night === 'in') for (const row of demand) total += row[k];
    });
    const n = state.staff.filter((s) => s.canNight).length;
    if (!n) return { total, n, min: 0, max: 0 };
    return { total, n, min: Math.floor(total / n), max: Math.ceil(total / n) };
  }

  // ---------- 画面の設定 → 計算用の数値データ ----------
  function compile(state) {
    const cal = buildCalendar(state);
    const D = cal.length;
    const S = state.staff.length;
    const K = state.shifts.length;
    const codes = state.shifts.map((x) => x.code);
    const idx = (c) => codes.indexOf(c);
    const r = state.rules;

    const night = state.shifts.map((x) => NIGHT[String(x.night).toUpperCase()] || 0);
    const work = state.shifts.map((x) => !!x.work);
    const off = state.shifts.map((x) => !!x.off);
    const leave = state.shifts.map((x) => !!x.leave);
    const isDemand = state.shifts.map((x) => isDemandShift(state, x));
    const role = state.shifts.map((x) => ROLE[String(x.role || 'none').toUpperCase()] || 0);
    const fillerIdx = idx(r.fillerCode);

    const demand = cal.map((c) => codes.map((code, k) => (isDemand[k] ? Math.max(0, demandOf(state, c.day, c.type, code)) : 0)));

    // その日に使える体制：通常の人数（必要人数）と、休日の3人勤務（日付ごとの人数を変えていない休日だけ）
    const tp = state.threePerson || { enabled: false, plans: [] };
    const altPlans = tp.enabled
      ? tp.plans.map((pl) => codes.map((code, k) => (isDemand[k] ? Math.max(0, Number(pl[code]) || 0) : 0))).filter((pl) => pl.some((n) => n > 0))
      : [];
    const plans = cal.map((c, d) => {
      const list = [demand[d]];
      if (c.type === 'holiday' && !state.demandOverrides[c.day]) for (const pl of altPlans) list.push(pl);
      return list;
    });
    const homeMask = state.staff.map((st) => HOME_MASK[st.home] || 3);
    const homes = homeMask.some((m) => m !== 3); // 担当ホームが決まっている職員がいれば、ホームごとの体制を確認する

    const locked = [], wish = [], lockSource = [];
    for (let s = 0; s < S; s++) {
      const st = state.staff[s];
      const req = state.requests[st.id] || {};
      const lk = state.locks[st.id] || {};
      const L = new Int16Array(D).fill(-1);
      const Wr = new Int16Array(D).fill(-1);
      const src = new Array(D).fill('');
      for (let d = 0; d < D; d++) {
        const rq = req[d + 1];
        if (rq) {
          const i = rq.indexOf(':');
          const type = rq.slice(0, i), k = idx(rq.slice(i + 1));
          if (k >= 0 && type === 'fix') {
            L[d] = k;
            src[d] = 'request';
          } else if (k >= 0 && type === 'wish') Wr[d] = k;
        }
        if (lk[d + 1] !== undefined && idx(lk[d + 1]) >= 0) {
          L[d] = idx(lk[d + 1]);
          src[d] = 'lock';
        }
      }
      locked.push(L);
      wish.push(Wr);
      lockSource.push(src);
    }

    // 隣り合う日の組み合わせの禁止（例：遅番の翌日に早番）
    const forbid = new Uint8Array(K * K);
    for (const fp of r.forbiddenPairs || []) {
      const a = idx(fp.from), b = idx(fp.to);
      if (a >= 0 && b >= 0) forbid[a * K + b] = 1;
    }

    // 公休数：指定がなければ全員で均等（月の休みの総数 ÷ 人数）
    let totalOff = 0;
    for (let d = 0; d < D; d++) {
      let assigned = 0, fixedLeave = 0;
      for (let k = 0; k < K; k++) {
        assigned += demand[d][k];
        if (off[k]) totalOff += demand[d][k];
      }
      for (let s = 0; s < S; s++) {
        const L = locked[s][d];
        if (L >= 0 && !isDemand[L] && L !== fillerIdx) fixedLeave++;
      }
      totalOff += Math.max(0, S - assigned - fixedLeave);
    }
    const offTarget = state.staff.map((st) =>
      st.holidays === null || st.holidays === '' || st.holidays === undefined ? -1 : Math.max(0, Number(st.holidays) || 0)
    );
    const fixedSum = offTarget.reduce((a, t) => a + (t >= 0 ? t : 0), 0);
    const autoCount = offTarget.filter((t) => t < 0).length;
    const offAuto = autoCount ? (totalOff - fixedSum) / autoCount : 0;

    // 前月末の勤務（記号 → 番号。未入力は -1）
    const tails = state.staff.map((st) => (st.prevTail || emptyTail()).map((c) => idx(c)));
    // 月末から数えた連続日数（未入力の日で止める）
    const tailRun = (t, pred) => {
      let n = 0;
      for (let i = t.length - 1; i >= 0 && t[i] >= 0 && pred(t[i]); i--) n++;
      return n;
    };

    const canNight = state.staff.map((st) => !!st.canNight);
    const blank = (v) => v === null || v === '' || v === undefined;
    const nightAuto = nightRange(state, demand, codes);
    const ruleMin = blank(r.minNights) ? nightAuto.min : Math.max(0, Number(r.minNights) || 0);
    const ruleMax = blank(r.maxNights) ? nightAuto.max : Math.max(0, Number(r.maxNights) || 0);
    const minNights = state.staff.map((st) => (st.canNight ? (blank(st.minNights) ? ruleMin : Math.max(0, Number(st.minNights) || 0)) : 0));
    const maxNights = state.staff.map((st) => (st.canNight ? (blank(st.maxNights) ? ruleMax : Math.max(0, Number(st.maxNights) || 0)) : 0));

    // 公平性の目標値
    const totalOf = (k) => demand.reduce((a, row) => a + row[k], 0);
    const nightCap = maxNights.reduce((a, b) => a + b, 0) || 1;
    let totalNights = 0;
    for (let k = 0; k < K; k++) if (night[k] === NIGHT.IN) totalNights += totalOf(k);
    const nightTarget = maxNights.map((m) => (totalNights * m) / nightCap);
    const nightStaff = canNight.filter(Boolean).length || 1;
    const codeTarget = codes.map((_, k) => {
      if (!isDemand[k]) return -1;
      return totalOf(k) / (night[k] !== NIGHT.NONE ? nightStaff : S || 1);
    });
    const weekendDays = cal.filter((c) => c.type === 'holiday').length;
    const weekendOffTarget = D ? (totalOff * weekendDays) / D / (S || 1) : 0;

    return {
      S, D, K, codes,
      names: state.staff.map((s) => s.name),
      night, work, off, leave, isDemand, role, plans, homeMask, homes,
      minRest: Math.max(0, Number(r.minRest) || 0),
      maxRest: Math.max(0, Number(r.maxRest) || 31),
      dayType: cal.map((c) => (c.type === 'holiday' ? 1 : 0)),
      dayLabels: cal.map((c) => c.day + '日(' + c.dowLabel + ')'),
      fillerIdx, demand, locked, lockSource, wish, forbid,
      offTarget, offAuto, totalOff,
      canNight, minNights, maxNights,
      maxNightDiff: Math.max(0, Number(r.maxNightDiff) || 0),
      minNightGap: Math.max(1, Number(r.minNightGap) || 1),
      // 宿直の間隔の目安：月の日数 ÷ その職員の宿直回数（目標値）
      nightGapIdeal: nightTarget.map((t) => (t > 0 ? D / t : 0)),
      // 前月末の最後の宿直入りが、1日の何日前か（なければ -1）
      prevNightAgo: tails.map((t) => {
        for (let j = t.length - 1; j >= 0; j--) if (t[j] >= 0 && night[t[j]] === NIGHT.IN) return t.length - j;
        return -1;
      }),
      prevLast: tails.map((t) => t[t.length - 1]),
      prevConsec: tails.map((t) => tailRun(t, (k) => work[k])),
      prevRest: tails.map((t) => tailRun(t, (k) => !work[k])),
      maxConsecutive: Math.max(1, Number(r.maxConsecutive) || 1),
      targets: { nightTarget, codeTarget, weekendOffTarget },
    };
  }

  // ---------- 作成前の見込みチェック（明らかに作成不可能な条件） ----------
  function precheck(p) {
    const issues = [];
    const { S, D, K } = p;
    const sumNight = (d, kind) => {
      let n = 0;
      for (let k = 0; k < K; k++) if (p.night[k] === kind) n += p.demand[d][k];
      return n;
    };

    const planSum = (pl) => pl.reduce((a, n) => a + n, 0);
    const roleSum = (pl, r) => pl.reduce((a, n, k) => a + ((r === ROLE.EARLY ? isMorning(p.role[k]) : p.role[k] === r) ? n : 0), 0);
    for (let d = 0; d < D; d++) {
      const need = Math.min(...p.plans[d].map(planSum));
      let fixedOther = 0;
      const fixedCount = new Array(K).fill(0);
      for (let s = 0; s < S; s++) {
        const L = p.locked[s][d];
        if (L < 0) continue;
        fixedCount[L]++;
        if (!p.isDemand[L] && L !== p.fillerIdx) fixedOther++;
      }
      if (need + fixedOther > S)
        issues.push(`${p.dayLabels[d]}：人数を指定した勤務の合計（${need}人）${fixedOther ? `と固定した有休など（${fixedOther}人）` : ''}が職員数（${S}人）を超えています。`);
      for (let k = 0; k < K; k++)
        if (p.isDemand[k] && fixedCount[k] > Math.max(...p.plans[d].map((pl) => pl[k])))
          issues.push(`${p.dayLabels[d]}：${p.codes[k]}に固定した職員が${fixedCount[k]}人いますが、必要人数は${p.demand[d][k]}人です。必要人数を変更してください。`);
      // ホームごとの体制（各ホームに早番か断続1名と遅番1名。3人勤務の日は遅番1名）
      if (p.homes) {
        for (const [label, test] of [['早番か断続', isMorning], ['遅番', (r) => r === ROLE.LATE]])
          for (const [h, m] of [['A', 1], ['B', 2]]) {
            const names = [];
            for (let s = 0; s < S; s++) {
              const L = p.locked[s][d];
              if (L >= 0 && test(p.role[L]) && p.homeMask[s] === m) names.push(p.names[s]);
            }
            if (names.length > 1)
              issues.push(`${p.dayLabels[d]}：ホーム${h}担当の${names.join('・')}を、どちらも${label}に固定しています。どちらかが担当外のホームに入ることになるので、固定を見直してください。`);
          }
        if (p.plans[d].every((pl) => roleSum(pl, ROLE.EARLY) < 2))
          issues.push(`${p.dayLabels[d]}：早番か断続（A・C・EA・EC など）が各ホームに1人ずつ、計2人必要です。必要人数を見直してください。`);
        if (p.plans[d].every((pl) => roleSum(pl, ROLE.LATE) < 2) && !p.plans[d].some((pl, i) => i > 0 && roleSum(pl, ROLE.LATE) >= 1))
          issues.push(`${p.dayLabels[d]}：遅番（D・DE など）が各ホームに1人ずつ、計2人必要です。必要人数を見直してください。`);
      }

      // 宿直入りの人数と、翌日の宿直明けの人数
      const outs = sumNight(d, NIGHT.OUT);
      if (d === 0) {
        // 前月末日が未入力の職員がいるうちは確かめない（入力を促す案内を別に出す）
        if (p.prevLast.some((x) => x < 0)) continue;
        let prevIn = 0;
        for (let s = 0; s < S; s++) if (p.prevLast[s] >= 0 && p.night[p.prevLast[s]] === NIGHT.IN) prevIn++;
        if (prevIn !== outs)
          issues.push(`1日の宿直明けは${outs}人の指定ですが、前月末日に宿直入りの職員は${prevIn}人です。表の前月の行（前月末日）を確認してください。`);
      } else {
        const ins = sumNight(d - 1, NIGHT.IN);
        if (ins !== outs)
          issues.push(`${p.dayLabels[d - 1]}の宿直入り（${ins}人）と、${p.dayLabels[d]}の宿直明け（${outs}人）の人数が合っていません。`);
      }
    }

    // 宿直の回数
    let totalIn = 0;
    for (let d = 0; d < D; d++) totalIn += sumNight(d, NIGHT.IN);
    const cap = p.maxNights.reduce((a, b) => a + b, 0);
    const floorSum = p.minNights.reduce((a, b) => a + b, 0);
    const nCan = p.canNight.filter(Boolean).length;
    if (totalIn > 0 && !nCan) issues.push('宿直が必要ですが、宿直できる職員がいません。');
    else if (totalIn > cap) issues.push(`宿直が月${totalIn}回必要ですが、宿直できる職員の上限回数の合計は${cap}回です。`);
    else if (totalIn < floorSum) issues.push(`宿直は月${totalIn}回ですが、宿直できる職員の下限回数の合計は${floorSum}回です。下限回数を見直してください。`);
    else if (nCan) {
      const avg = totalIn / nCan;
      const lo = Math.max(...p.minNights.filter((_, s) => p.canNight[s]));
      const hi = Math.min(...p.maxNights.filter((_, s) => p.canNight[s]));
      if (Math.floor(avg) < lo - p.maxNightDiff || Math.ceil(avg) > hi + p.maxNightDiff)
        issues.push(`宿直${totalIn}回を${nCan}人で分けると1人あたり約${avg.toFixed(1)}回になり、回数の差を${p.maxNightDiff}回以内にしたまま下限・上限に収められません。`);
    }

    // 休み（公休＋有休）の日数の範囲
    let restStd = 0, restMax = 0;
    for (let d = 0; d < D; d++) {
      const restOf = (pl) => S - planSum(pl) + pl.reduce((a, n, k) => a + (p.off[k] || p.leave[k] ? n : 0), 0);
      restStd += restOf(p.plans[d][0]);
      restMax += Math.max(...p.plans[d].map(restOf));
    }
    if (restStd > S * p.maxRest)
      issues.push(`必要人数から計算すると、休みは1人平均${(restStd / S).toFixed(1)}日になり、上限（${p.maxRest}日）を超えます。「必要人数」で早番（平日は断続 A）や遅番 D の人数を増やすか、休みの上限を見直してください。`);
    if (restMax < S * p.minRest)
      issues.push(`休日の3人勤務を使っても、休みは1人平均${(restMax / S).toFixed(1)}日にしかならず、下限（${p.minRest}日）に足りません。必要人数か休みの下限を見直してください。`);

    // 公休数
    const autoCount = p.offTarget.filter((t) => t < 0).length;
    const fixedSum = p.offTarget.reduce((a, t) => a + (t >= 0 ? t : 0), 0);
    if (!autoCount && fixedSum !== p.totalOff)
      issues.push(`必要人数から計算すると、月の公休は全員で延べ${p.totalOff}日になりますが、職員ごとに指定した公休数の合計は${fixedSum}日です。`);
    else if (autoCount && fixedSum > p.totalOff)
      issues.push(`職員ごとに指定した公休数の合計（${fixedSum}日）が、月の公休の総数（延べ${p.totalOff}日）を超えています。`);
    for (let s = 0; s < S; s++) {
      if (p.offTarget[s] < 0) continue;
      let fixedOff = 0;
      for (let d = 0; d < D; d++) if (p.locked[s][d] >= 0 && p.off[p.locked[s][d]]) fixedOff++;
      if (fixedOff > p.offTarget[s]) issues.push(`${p.names[s]}：固定した公休（${fixedOff}日）が公休数（${p.offTarget[s]}日）を超えています。`);
    }
    return issues;
  }

  // ---------- 評価（ソルバーと画面の両方で使う） ----------
  const runPenalty = (len) => (len < W.RUN.length ? W.RUN[len] : W.RUN_OVER);
  const isRestDay = (p, x) => !p.work[x];

  // 職員1人分の違反点。out を渡すと違反内容を書き出す
  function staffCost(p, A, s, out) {
    const row = A[s];
    const D = p.D, K = p.K;
    let c = 0;
    let prev = p.prevLast[s];
    let run = p.prevConsec[s]; // 連勤の長さ
    let rest = p.prevRest[s]; // 連休の長さ
    let lastNight = p.prevNightAgo[s] >= 0 ? -p.prevNightAgo[s] : null; // 直前の宿直入りの日
    let offs = 0, nights = 0, weekendOff = 0, restDays = 0;
    const cnt = new Int16Array(K);
    const report = (level, d, msg) => out && out.push({ level, staff: s, day: d, msg });

    for (let d = 0; d < D; d++) {
      const x = row[d];
      cnt[x]++;
      if (prev >= 0) {
        if (p.night[prev] === NIGHT.IN && p.night[x] !== NIGHT.OUT) {
          c += W.HARD;
          report('hard', d, `前日が宿直入り（${p.codes[prev]}）なのに、宿直明けの勤務になっていません`);
        }
        if (p.forbid[prev * K + x]) {
          c += W.HARD;
          report('hard', d, `${p.codes[prev]}の翌日に${p.codes[x]}が入っています`);
        }
      }
      if (p.night[x] === NIGHT.OUT && !(prev >= 0 && p.night[prev] === NIGHT.IN)) {
        c += W.HARD;
        report('hard', d, `前日が宿直入りではないのに、宿直明け（${p.codes[x]}）になっています`);
      }

      if (p.work[x]) {
        if (rest >= LONG_REST_FROM) {
          c += W.LONG_REST * (rest - LONG_REST_FROM + 1);
          report('soft', d - 1, `${rest}連休になっています`);
        }
        rest = 0;
        run++;
        if (run > p.maxConsecutive) {
          c += W.HARD;
          report('hard', d, `連勤が${p.maxConsecutive}日を超えています（${run}日目）`);
        }
      } else {
        if (run > 0) {
          const pen = runPenalty(run);
          if (pen) {
            c += pen;
            // 4連勤は許容範囲なので一覧には出さない（2〜3連勤を優先するための小さな罰点のみ）
            if (run !== 4) report('soft', d - 1, run === 1 ? '1日だけの勤務になっています' : `${run}連勤になっています`);
          }
        }
        run = 0;
        rest++;
      }

      if (p.off[x]) {
        offs++;
        if (p.dayType[d] === 1) weekendOff++;
      }
      if (p.off[x] || p.leave[x]) restDays++;
      if (p.night[x] === NIGHT.IN) {
        nights++;
        if (lastNight !== null) {
          const gap = d - lastNight;
          if (gap < p.minNightGap) {
            c += W.HARD;
            report('hard', d, gap === 1 ? '2日連続の宿直になっています' : `前の宿直から${gap}日しか空いていません（最低${p.minNightGap}日）`);
          }
          if (gap === 2 && p.minNightGap <= 2) {
            c += W.NIGHT_GAP2;
            report('soft', d, '宿直明けの翌日に、また宿直に入っています');
          }
          const short = p.nightGapIdeal[s] - gap;
          if (short > 0) {
            c += W.NIGHT_GAP * short * short;
            if (gap === 3 && gap >= p.minNightGap) report('soft', d, `前の宿直から${gap}日目の宿直です`);
          }
        }
        lastNight = d;
      }

      const w = p.wish[s][d];
      if (w >= 0 && w !== x) {
        const wantRest = !p.work[w] && p.night[w] === NIGHT.NONE;
        if (!(wantRest && isRestDay(p, x) && p.night[x] === NIGHT.NONE)) {
          c += W.WISH;
          report('soft', d, `希望（${wantRest ? '休み' : p.codes[w]}）がかなっていません`);
        }
      }
      prev = x;
    }
    // 月末で終わる連勤は翌月に続く可能性があるため、長すぎる場合だけ数える
    if (run >= 4 && runPenalty(run)) {
      c += runPenalty(run);
      if (run !== 4) report('soft', D - 1, `${run}連勤になっています`);
    }
    if (rest >= LONG_REST_FROM) {
      c += W.LONG_REST * (rest - LONG_REST_FROM + 1);
      report('soft', D - 1, `${rest}連休になっています`);
    }

    // 休み（公休＋有休）の日数
    if (restDays < p.minRest) {
      c += W.HARD * (p.minRest - restDays);
      report('hard', -1, `休み（公休＋有休）が${restDays}日で、下限（${p.minRest}日）に足りません`);
    } else if (restDays > p.maxRest) {
      c += W.HARD * (restDays - p.maxRest);
      report('hard', -1, `休み（公休＋有休）が${restDays}日で、上限（${p.maxRest}日）を超えています`);
    }

    // 公休数
    const t = p.offTarget[s];
    if (t >= 0) {
      if (offs !== t) {
        c += W.HARD * Math.abs(offs - t);
        report('hard', -1, `公休が${offs}日です（指定：${t}日）`);
      }
    }

    // 宿直
    if (!p.canNight[s] && nights > 0) {
      c += W.HARD * nights;
      report('hard', -1, `宿直できない設定ですが、宿直が${nights}回入っています`);
    } else if (nights > p.maxNights[s]) {
      c += W.HARD * (nights - p.maxNights[s]);
      report('hard', -1, `宿直が${nights}回で、上限（${p.maxNights[s]}回）を超えています`);
    } else if (p.canNight[s] && nights < p.minNights[s]) {
      c += W.HARD * (p.minNights[s] - nights);
      report('hard', -1, `宿直が${nights}回で、下限（${p.minNights[s]}回）に足りません`);
    }
    const dn = nights - p.targets.nightTarget[s];
    c += W.FAIR_NIGHT * dn * dn;

    // 勤務ごとの回数の均等化
    for (let k = 0; k < K; k++) {
      const tg = p.targets.codeTarget[k];
      if (tg < 0) continue;
      if (p.night[k] !== NIGHT.NONE && !p.canNight[s]) continue;
      const dk = cnt[k] - tg;
      c += W.FAIR_CODE * dk * dk;
    }
    const dw = weekendOff - p.targets.weekendOffTarget;
    c += W.FAIR_WEEKEND * dw * dw;
    return c;
  }

  // その日の勤務が、使える体制（通常／休日の3人勤務）のどれにいちばん近いか
  function bestPlan(p, A, d) {
    const cnt = new Int16Array(p.K);
    for (let s = 0; s < p.S; s++) cnt[A[s][d]]++;
    const plans = p.plans[d];
    let best = Infinity, idx = 0;
    for (let i = 0; i < plans.length; i++) {
      const pl = plans[i];
      let c = i > 0 ? W.THREE : 0;
      for (let k = 0; k < p.K; k++) if (p.isDemand[k]) c += W.HARD * Math.abs(cnt[k] - pl[k]);
      if (c < best) {
        best = c;
        idx = i;
      }
    }
    return { cost: best, idx, cnt };
  }

  function dayPlanIndex(p, A, d) {
    return bestPlan(p, A, d).idx;
  }

  // 1日分の違反点（指定した人数ちょうどか、ホームごとの体制がそろっているか）
  function dayCost(p, A, d, out) {
    const bp = bestPlan(p, A, d);
    let c = bp.cost;
    if (out) {
      const pl = p.plans[d][bp.idx];
      for (let k = 0; k < p.K; k++) {
        if (!p.isDemand[k] || bp.cnt[k] === pl[k]) continue;
        const need = pl[k], n = bp.cnt[k];
        out.push({ level: 'hard', staff: -1, day: d, msg: n < need ? `${p.codes[k]}が${need - n}人足りません` : `${p.codes[k]}が指定の人数より${n - need}人多くなっています` });
      }
      if (bp.idx > 0) out.push({ level: 'soft', staff: -1, day: d, msg: '休日の3人勤務の日です' });
    }
    if (p.homes) c += homeCost(p, A, d, out);
    return c;
  }

  // ホームごとの体制。担当ホームの範囲で、その日の職員を各ホームに割り当てられるかを確かめる
  //  ・各ホームに早番か断続が1人、遅番が1人
  //  ・遅番が1人だけの日（休日の3人勤務）は、もう一方のホームを残業で対応する。
  //    このとき断続は早番とも遅番とも時間帯が重なるので、断続の人は早番・遅番の人と別のホームでなければならない
  function homeCost(p, A, d, out) {
    const role = [], mask = [], flex = [];
    let lateN = 0;
    for (let s = 0; s < p.S; s++) {
      const r = p.role[A[s][d]];
      if (!r) continue;
      if (p.homeMask[s] === 3) flex.push(role.length);
      role.push(r);
      mask.push(p.homeMask[s]);
      if (r === ROLE.LATE) lateN++;
    }
    const three = lateN === 1;
    const n = role.length;
    const home = new Int8Array(n);
    let okMorning = false, okLate = false;
    for (let combo = 0; combo < 1 << flex.length; combo++) {
      for (let i = 0; i < n; i++) home[i] = mask[i] === 1 ? 0 : 1;
      flex.forEach((i, b) => (home[i] = (combo >> b) & 1));
      const morning = [0, 0], late = [0, 0];
      for (let i = 0; i < n; i++) {
        if (isMorning(role[i])) morning[home[i]]++;
        else if (role[i] === ROLE.LATE) late[home[i]]++;
      }
      if (!(morning[0] && morning[1])) continue;
      okMorning = true;
      if (!three && !(late[0] && late[1])) continue;
      okLate = true;
      if (three) {
        // 3人勤務：断続の人は、遅番の人と別のホーム（早番の人とは上の条件で別のホームになる）
        let clash = false;
        for (let i = 0; i < n && !clash; i++)
          for (let j = 0; j < n; j++)
            if (role[i] === ROLE.SPLIT && role[j] === ROLE.LATE && home[i] === home[j]) {
              clash = true;
              break;
            }
        if (clash) continue;
      }
      return 0;
    }
    if (out) {
      let msg;
      if (!okMorning) msg = '担当ホームの組み合わせでは、ホームA・Bの両方に早番か断続の人を置けません';
      else if (!okLate) msg = '担当ホームの組み合わせでは、ホームA・Bの両方に遅番の人を置けません';
      else msg = '3人勤務で、断続の人と遅番の人が同じホームの担当になり、担当外のホームに入る必要があります';
      out.push({ level: 'hard', staff: -1, day: d, msg });
    }
    return W.HARD;
  }

  function nightCount(p, A, s) {
    let n = 0;
    const row = A[s];
    for (let d = 0; d < p.D; d++) if (p.night[row[d]] === NIGHT.IN) n++;
    return n;
  }

  function offCount(p, A, s) {
    let n = 0;
    const row = A[s];
    for (let d = 0; d < p.D; d++) if (p.off[row[d]]) n++;
    return n;
  }

  // 職員どうしの比較：宿直回数の差（必ず守る）と、公休数のばらつき（公休数を指定していない職員どうし）
  function globalCost(p, nights, offs, out) {
    let c = 0;
    let sum = 0, n = 0;
    for (let s = 0; s < p.S; s++)
      if (p.offTarget[s] < 0) {
        sum += offs[s];
        n++;
      }
    if (n > 1) {
      const mean = sum / n;
      for (let s = 0; s < p.S; s++) {
        if (p.offTarget[s] >= 0) continue;
        const dv = offs[s] - mean;
        c += W.OFF_BALANCE * dv * dv;
        if (out && Math.abs(dv) >= 1)
          out.push({ level: 'soft', staff: s, day: -1, msg: `公休が${offs[s]}日で、ほかの職員の平均（${mean.toFixed(1)}日）との差が大きくなっています` });
      }
    }
    return c + nightDiffCost(p, nights, out);
  }

  // 職員間の宿直回数の差（宿直できる職員どうし）
  function nightDiffCost(p, nights, out) {
    let lo = Infinity, hi = -Infinity;
    for (let s = 0; s < p.S; s++) {
      if (!p.canNight[s]) continue;
      if (nights[s] < lo) lo = nights[s];
      if (nights[s] > hi) hi = nights[s];
    }
    const over = hi - lo - p.maxNightDiff;
    if (!(over > 0)) return 0;
    out && out.push({ level: 'hard', staff: -1, day: -1, msg: `職員間の宿直回数の差が${hi - lo}回あります（${p.maxNightDiff}回まで）` });
    return W.HARD * over;
  }

  // 全体の評価。violations: 違反の一覧（必ず守る条件 → 希望の順）
  function evaluate(p, A) {
    const v = [];
    let total = 0;
    for (let s = 0; s < p.S; s++) total += staffCost(p, A, s, v);
    for (let d = 0; d < p.D; d++) total += dayCost(p, A, d, v);
    total += globalCost(p, Array.from({ length: p.S }, (_, s) => nightCount(p, A, s)), Array.from({ length: p.S }, (_, s) => offCount(p, A, s)), v);
    for (let s = 0; s < p.S; s++)
      for (let d = 0; d < p.D; d++) {
        const L = p.locked[s][d];
        if (L >= 0 && A[s][d] !== L) {
          total += W.HARD;
          v.push({ level: 'hard', staff: s, day: d, msg: `固定した勤務（${p.codes[L]}）と違います` });
        }
      }
    const hard = v.filter((x) => x.level === 'hard').length;
    v.sort((a, b) => (a.level === b.level ? a.day - b.day : a.level === 'hard' ? -1 : 1));
    return { total, hardCount: hard, violations: v };
  }

  // 職員ごとの集計
  function stats(p, A) {
    return Array.from({ length: p.S }, (_, s) => {
      const count = new Array(p.K).fill(0);
      let work = 0, off = 0, leave = 0, nights = 0, rest = 0;
      for (let d = 0; d < p.D; d++) {
        const x = A[s][d];
        count[x]++;
        if (p.work[x]) work++;
        if (p.off[x]) off++;
        if (p.leave[x]) leave++;
        if (p.off[x] || p.leave[x]) rest++;
        if (p.night[x] === NIGHT.IN) nights++;
      }
      return { count, work, off, leave, nights, rest };
    });
  }

  // 画面の作成結果（記号の文字列） → 数値の配列。読めない場合は null
  function gridToMatrix(state, p) {
    const res = state.result;
    if (!res || res.year !== state.year || res.month !== state.month) return null;
    const A = [];
    for (const st of state.staff) {
      const row = res.grid[st.id];
      if (!row || row.length !== p.D) return null;
      const r = new Int16Array(p.D);
      for (let d = 0; d < p.D; d++) {
        const k = p.codes.indexOf(row[d]);
        if (k < 0) return null;
        r[d] = k;
      }
      A.push(r);
    }
    return A;
  }

  root.ShiftModel = {
    VERSION, PREV_DAYS, NIGHT, NIGHT_KEYS, NIGHT_LABELS, ROLE, ROLE_KEYS, ROLE_LABELS, HOME_KEYS, HOME_LABELS, W, WEEK,
    daysInMonth, jpHolidaysOfYear, buildCalendar,
    defaultState, defaultShifts, normalizeState, normalizeStaff, emptyTail, prevMonthDays,
    isDemandShift, demandOf, nightRange, validateSettings, compile, precheck,
    staffCost, dayCost, dayPlanIndex, nightCount, offCount, globalCost, evaluate, stats, gridToMatrix,
  };
})(typeof self !== 'undefined' ? self : this);
