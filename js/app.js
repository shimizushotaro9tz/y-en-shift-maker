/* app.js — 画面の表示と操作 */
(function () {
  'use strict';
  const M = window.ShiftModel;
  const STORAGE_KEY = 'y-shift-maker.v1'; // 設定（ブラウザに残す）
  const OLD_SESSION_KEY = 'y-shift-maker.month.v1'; // 以前の版で使っていた、その月の入力の保存先
  // その月の入力として扱う項目（前月末の勤務 staff[].prevTail もこちら）。保存せず、再読み込みで初期化する
  const MONTH_KEYS = ['year', 'month', 'requests', 'result', 'demandOverrides', 'dayTypeOverrides'];

  let state = load();
  let view = 'main'; // 'main'（シフト表）| 'settings'（設定）
  let currentTab = 'basic';
  let worker = null;
  let running = false;
  let mainStatus = null; // { kind: 'info'|'ok'|'warn'|'error', html }

  // ---------- 保存 ----------
  // 設定（職員の仮名・担当ホーム、勤務区分、基本の人数、3人勤務、ルール）は localStorage に残す。
  // その月の入力（年月、固定・希望休、前月末の勤務、日付ごとの人数、平日/休日の切り替え、生成結果）は
  // どこにも保存しない。ページを再読み込みすると初期状態に戻る（入力履歴をブラウザに残さない）
  function load() {
    let settings = null;
    try {
      settings = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      sessionStorage.removeItem(OLD_SESSION_KEY);
    } catch (e) {
      /* 読めない場合は初期値 */
    }
    if (!settings) return M.defaultState();
    // 以前の版で保存されていた月ごとの入力は使わない（このあとの save で取り除く）
    for (const k of MONTH_KEYS) delete settings[k];
    if (Array.isArray(settings.staff)) settings.staff = settings.staff.map((st) => Object.assign({}, st, { prevTail: undefined }));
    const st = M.normalizeState(settings);
    const d = M.defaultState(); // 作成する月は来月から
    st.year = d.year;
    st.month = d.month;
    return st;
  }

  function save() {
    const settings = {};
    for (const k in state) if (!MONTH_KEYS.includes(k)) settings[k] = state[k];
    settings.staff = state.staff.map((st) => {
      const c = Object.assign({}, st);
      delete c.prevTail;
      return c;
    });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
      /* 保存できない環境でも動作は続ける */
    }
  }
  function commit() {
    save();
    render();
  }

  // ---------- 小物 ----------
  const $ = (sel, el) => (el || document).querySelector(sel);
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const shiftByCode = (code) => state.shifts.find((x) => x.code === code);
  const newId = () => 's' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  const demandShifts = () => state.shifts.filter((x) => M.isDemandShift(state, x));
  const restShifts = () => state.shifts.filter((x) => !x.work && x.night === 'none');
  const ICON = { up: '↑&#xFE0E;', down: '↓&#xFE0E;', del: '✕&#xFE0E;' };

  // 勤務の記号は色分けしない
  const chip = (code) => `<span class="chip">${esc(code)}</span>`;

  // 勤務区分の記号を変えたとき、関連する設定もすべて書き換える
  function renameCode(oldC, newC) {
    const renameKey = (obj) => {
      if (obj && oldC in obj) {
        obj[newC] = obj[oldC];
        delete obj[oldC];
      }
    };
    renameKey(state.demand.weekday);
    renameKey(state.demand.holiday);
    for (const d in state.demandOverrides) renameKey(state.demandOverrides[d]);
    for (const sid in state.requests)
      for (const d in state.requests[sid]) {
        const v = state.requests[sid][d];
        const i = v.indexOf(':');
        if (v.slice(i + 1) === oldC) state.requests[sid][d] = v.slice(0, i + 1) + newC;
      }
    if (state.result) for (const sid in state.result.grid) state.result.grid[sid] = state.result.grid[sid].map((c) => (c === oldC ? newC : c));
    if (state.rules.fillerCode === oldC) state.rules.fillerCode = newC;
    state.extraDemandCols = state.extraDemandCols.map((c) => (c === oldC ? newC : c));
    for (const pl of state.threePerson.plans) renameKey(pl);
    for (const fp of state.rules.forbiddenPairs) {
      if (fp.from === oldC) fp.from = newC;
      if (fp.to === oldC) fp.to = newC;
    }
    for (const st of state.staff) st.prevTail = st.prevTail.map((c) => (c === oldC ? newC : c));
  }

  function removeCodeRefs(code) {
    delete state.demand.weekday[code];
    delete state.demand.holiday[code];
    for (const d in state.demandOverrides) delete state.demandOverrides[d][code];
    for (const sid in state.requests)
      for (const d in state.requests[sid]) {
        const v = state.requests[sid][d];
        if (v.slice(v.indexOf(':') + 1) === code) delete state.requests[sid][d];
      }
    state.rules.forbiddenPairs = state.rules.forbiddenPairs.filter((fp) => fp.from !== code && fp.to !== code);
    state.extraDemandCols = state.extraDemandCols.filter((c) => c !== code);
    for (const pl of state.threePerson.plans) delete pl[code];
    for (const st of state.staff) st.prevTail = st.prevTail.map((c) => (c === code ? '' : c));
  }

  // ---------- 表示 ----------
  function render() {
    document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === currentTab)));
    $('#tabs').hidden = view !== 'settings';
    $('#view-toggle').innerHTML = view === 'settings' ? '← シフト表に戻る' : '⚙&#xFE0E; 設定';
    $('#subtitle').textContent = view === 'settings' ? '設定' : '勤務を選んで固定 → シフト生成 → Excel でダウンロード';
    const errs = M.validateSettings(state);
    const banner = $('#settings-errors');
    banner.hidden = !errs.length;
    banner.innerHTML = errs.length ? '<strong>設定を確認してください</strong><ul>' + errs.map((e) => '<li>' + esc(e) + '</li>').join('') + '</ul>' : '';
    const fn = view === 'main' ? renderMain : { basic: renderBasic, staff: renderStaff, shifts: renderShifts, demand: renderDemand, rules: renderRules }[currentTab];
    const viewEl = $('#view');
    const scroller = viewEl.querySelector('.table-wrap.tall');
    const keep = scroller ? [scroller.scrollTop, scroller.scrollLeft] : null;
    viewEl.innerHTML = fn(errs);
    // ブラウザが入力候補として文字を覚えないようにする
    viewEl.querySelectorAll('input').forEach((el) => el.setAttribute('autocomplete', 'off'));
    const ns = viewEl.querySelector('.table-wrap.tall');
    if (keep && ns) [ns.scrollTop, ns.scrollLeft] = keep;
  }

  function renderBasic() {
    const cal = M.buildCalendar(state);
    const blanks = new Array(cal[0].dow).fill('<div class="cal-blank"></div>').join('');
    const days = cal
      .map((c) => {
        const cls = ['cal-day', c.type === 'holiday' ? 'is-holiday' : '', c.dow === 0 || c.holidayName ? 'sun' : c.dow === 6 ? 'sat' : '', c.type !== c.autoType ? 'overridden' : ''].join(' ');
        return `<button type="button" class="${cls}" data-action="toggle-day" data-day="${c.day}" title="${esc(c.holidayName || '')}">
          <span class="num">${c.day}</span><span class="lbl">${c.type === 'holiday' ? '休日' : '平日'}</span>
          ${c.holidayName ? `<span class="hname">${esc(c.holidayName)}</span>` : ''}</button>`;
      })
      .join('');
    const years = [];
    for (let y = state.year - 1; y <= state.year + 2; y++) years.push(y);
    return `
      <section class="card">
        <h2>作成する月</h2>
        <div class="form-row">
          <label>年 <select data-month-part="year">${years.map((y) => `<option ${y === state.year ? 'selected' : ''}>${y}</option>`).join('')}</select></label>
          <label>月 <select data-month-part="month">${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${i + 1 === state.month ? 'selected' : ''}>${i + 1}月</option>`).join('')}</select></label>
        </div>
      </section>
      <section class="card">
        <h2>平日と休日の区別</h2>
        <p class="hint">土日祝は自動で「休日」になり、「必要人数」で休日の基本人数が使われます。日付を押すと平日⇔休日を切り替えられます（学校の長期休みなどを休日扱いにする場合に使います）。</p>
        <div class="cal">${M.WEEK.map((w, i) => `<div class="cal-head ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</div>`).join('')}${blanks}${days}</div>
        <button type="button" class="btn small" data-action="reset-days">自動判定に戻す</button>
      </section>
      <section class="card">
        <h2>設定データ</h2>
        <p class="hint">設定（職員の仮名・担当ホーム、勤務区分、必要人数、ルール）はこのブラウザに保存され、外部には送信されません。その月の入力（固定・希望休、前月末の勤務、日付ごとの人数、生成結果）は保存されず、ページを再読み込みしたり閉じたりすると消えます。別のパソコンで使う場合や控えを残す場合は、ファイルに書き出してください。</p>
        <div class="btn-row">
          <button type="button" class="btn" data-action="export-json">設定をファイルに書き出す</button>
          <label class="btn">設定ファイルを読み込む<input type="file" accept=".json,application/json" data-action="import-json" hidden></label>
          <button type="button" class="btn danger" data-action="reset-all">すべて初期値に戻す</button>
        </div>
      </section>`;
  }

  function renderStaff() {
    const nr = nightRangeOfRules();
    const rows = state.staff
      .map(
        (st, i) => `<tr>
        <td><input type="text" data-staff="${i}" data-field="name" value="${esc(st.name)}" maxlength="12" class="w-name"></td>
        <td><select data-staff="${i}" data-field="home">${M.HOME_KEYS.map((h) => `<option value="${h}" ${h === st.home ? 'selected' : ''}>${M.HOME_LABELS[h]}</option>`).join('')}</select></td>
        <td class="c"><input type="checkbox" data-staff="${i}" data-field="canNight" ${st.canNight ? 'checked' : ''} aria-label="宿直できる"></td>
        <td class="nowrap"><input type="number" min="0" max="31" data-staff="${i}" data-field="minNights" value="${st.minNights === null ? '' : esc(st.minNights)}" placeholder="${nr.min}" class="w-num" ${st.canNight ? '' : 'disabled'} aria-label="宿直の下限">〜<input type="number" min="0" max="31" data-staff="${i}" data-field="maxNights" value="${st.maxNights === null ? '' : esc(st.maxNights)}" placeholder="${nr.max}" class="w-num" ${st.canNight ? '' : 'disabled'} aria-label="宿直の上限"></td>
        <td><input type="number" min="0" max="31" data-staff="${i}" data-field="holidays" value="${st.holidays === null ? '' : esc(st.holidays)}" placeholder="自動" class="w-num"></td>
        <td class="nowrap">
          <button type="button" class="icon-btn" data-action="staff-up" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="上へ">${ICON.up}</button>
          <button type="button" class="icon-btn" data-action="staff-down" data-i="${i}" ${i === state.staff.length - 1 ? 'disabled' : ''} aria-label="下へ">${ICON.down}</button>
          <button type="button" class="icon-btn danger" data-action="staff-del" data-i="${i}" aria-label="削除">${ICON.del}</button>
        </td></tr>`
      )
      .join('');
    return `
      <section class="card">
        <h2>職員（${state.staff.length}名）</h2>
        <p class="hint warn-text">公開されるWebアプリです。氏名などの個人情報は入力せず、仮名（職員1 など）を使ってください。並び順がシフト表の列の順になります。</p>
        <div class="table-wrap"><table class="grid-form">
          <thead><tr><th>仮名</th><th>担当ホーム</th><th>宿直</th><th>宿直の回数（月）<br>（空欄＝ルールの値）</th><th>公休数<br>（空欄＝自動）</th><th></th></tr></thead>
          <tbody>${rows}</tbody></table></div>
        <button type="button" class="btn" data-action="staff-add">＋ 職員を追加</button>
        <ul class="hint">
          <li><b>宿直の回数</b>：空欄のときは「ルール」の値を使います（今月は${nr.min === nr.max ? nr.min : nr.min + "〜" + nr.max}回）。</li>
          <li><b>公休数</b>：空欄のときは、必要人数から決まる月の休みの総数を、全員で均等に分けます。日数を指定した職員は、その日数ちょうどにします。</li>
        </ul>
      </section>
      ${renderPrevTail()}`;
  }

  // 前月末の勤務（月をまたぐ宿直明け・連勤・連休の判定に使う）
  function renderPrevTail() {
    const days = M.prevMonthDays(state);
    const opts = (sel) =>
      `<option value="">—</option>` + state.shifts.map((x) => `<option value="${esc(x.code)}" ${x.code === sel ? 'selected' : ''}>${esc(x.code)}</option>`).join('');
    const head = state.staff.map((st) => `<th>${esc(st.name)}</th>`).join('');
    const body = days
      .map((c, j) => {
        const cls = c.dow === 0 ? 'sun' : c.dow === 6 ? 'sat' : '';
        const cells = state.staff
          .map((st, i) => {
            const code = st.prevTail[j];
            return `<td class="cell"><select data-prev="${i}" data-j="${j}" aria-label="${esc(st.name)} ${c.month}月${c.day}日">${opts(code)}</select></td>`;
          })
          .join('');
        return `<tr><th scope="row" class="date ${cls}">${c.month}/${c.day}</th><td class="dow ${cls}">${c.dowLabel}</td>${cells}</tr>`;
      })
      .join('');
    const first = days[0], last = days[days.length - 1];
    return `
      <section class="card">
        <h2>前月末の勤務（${first.month}/${first.day}〜${last.month}/${last.day}）</h2>
        <p class="hint">月をまたぐ条件（宿直入りの翌日の宿直明け、連勤の上限、翌日に入れない組み合わせ、連休）の判定に使います。<b>まずは「前月のExcelを読み込む」で、前月にこのアプリでダウンロードした勤務表から取り込んでください。</b>前月のExcelがない場合は、下の表で勤務を選んで入力することもできます。月を切り替えると、前月の行は未入力に戻ります。前月末日に宿直入り（DE など）の職員は、1日が宿直明け（EA・EC など）になります。</p>
        <div class="table-wrap"><table class="sheet"><thead><tr><th>日</th><th>曜</th>${head}</tr></thead><tbody>${body}</tbody></table></div>
        <div class="btn-row">
          <label class="btn small">前月のExcelを読み込む<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" data-action="import-prev" hidden></label>
          <button type="button" class="btn danger small" data-action="clear-prev">前月末の勤務をすべて消す</button>
        </div>
      </section>`;
  }

  function renderShifts() {
    const rows = state.shifts
      .map(
        (x, i) => `<tr>
        <td><input type="text" data-shift="${i}" data-field="code" value="${esc(x.code)}" maxlength="4" class="w-code"></td>
        <td><input type="text" data-shift="${i}" data-field="name" value="${esc(x.name)}" maxlength="16" class="w-name"></td>
        <td><select data-shift="${i}" data-field="role">${M.ROLE_KEYS.map((k) => `<option value="${k}" ${k === x.role ? 'selected' : ''}>${M.ROLE_LABELS[k]}</option>`).join('')}</select></td>
        <td><select data-shift="${i}" data-field="night">${M.NIGHT_KEYS.map((k) => `<option value="${k}" ${k === x.night ? 'selected' : ''}>${M.NIGHT_LABELS[k]}</option>`).join('')}</select></td>
        <td class="c"><input type="checkbox" data-shift="${i}" data-field="work" ${x.work ? 'checked' : ''} aria-label="勤務日に数える"></td>
        <td class="c"><input type="checkbox" data-shift="${i}" data-field="off" ${x.off ? 'checked' : ''} aria-label="公休に数える"></td>
        <td class="c"><input type="checkbox" data-shift="${i}" data-field="leave" ${x.leave ? 'checked' : ''} aria-label="有休に数える"></td>
        <td class="nowrap">
          <button type="button" class="icon-btn" data-action="shift-up" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="上へ">${ICON.up}</button>
          <button type="button" class="icon-btn" data-action="shift-down" data-i="${i}" ${i === state.shifts.length - 1 ? 'disabled' : ''} aria-label="下へ">${ICON.down}</button>
          <button type="button" class="icon-btn danger" data-action="shift-del" data-i="${i}" aria-label="削除">${ICON.del}</button>
        </td></tr>`
      )
      .join('');
    return `
      <section class="card">
        <h2>勤務区分</h2>
        <div class="table-wrap"><table class="grid-form">
          <thead><tr><th>記号</th><th>名称</th><th>ホームでの<br>役割</th><th>宿直</th><th>勤務日に<br>数える</th><th>公休に<br>数える</th><th>有休に<br>数える</th><th></th></tr></thead>
          <tbody>${rows}</tbody></table></div>
        <button type="button" class="btn" data-action="shift-add">＋ 勤務区分を追加</button>
        <ul class="hint">
          <li><b>ホームでの役割</b>：毎日、各ホームに「早番か断続」が1人、「遅番」が1人必要です。断続は早番とも遅番とも時間帯が重なります。</li>
          <li><b>宿直</b>：「宿直入り」の翌日は、必ず「宿直明け」のどれか（EC・EA・E公・E有 など）になります。</li>
          <li><b>勤務日に数える</b>：連勤の日数に数えるかどうかです。チェックのない区分は休みの日として扱います。</li>
          <li><b>公休に数える／有休に数える</b>：月の公休数・有休数の集計に使います。</li>
          <li>有休だけの区分（有）は自動では入りません。シフト表のマスで選んで固定してください。</li>
        </ul>
      </section>`;
  }

  function renderDemand(errs) {
    const ds = demandShifts();
    const cal = M.buildCalendar(state);
    const S = state.staff.length;
    const tplRows = [['weekday', '平日'], ['holiday', '休日']]
      .map(([t, label]) => {
        const total = ds.reduce((a, x) => a + (Number(state.demand[t][x.code]) || 0), 0);
        return `<tr><th scope="row">${label}</th>${ds
          .map((x) => `<td><input type="number" min="0" max="20" data-demand="${t}" data-code="${esc(x.code)}" value="${Number(state.demand[t][x.code]) || 0}" class="w-cnt"></td>`)
          .join('')}<td class="sum">${total}</td><td class="sum">${S - total}</td></tr>`;
      })
      .join('');
    const head = ds.map((x) => `<th>${chip(x.code)}</th>`).join('');

    let issuesByDay = {}, issuesHtml = '';
    if (!errs.length) {
      const p = M.compile(state);
      const pre = M.precheck(p);
      for (const msg of pre) {
        const m = /^(\d+)日\(/.exec(msg);
        if (m) issuesByDay[m[1]] = true;
      }
      issuesHtml = pre.length
        ? `<div class="notice error"><strong>この条件ではシフトを作成できません</strong><ul>${pre.map((x) => '<li>' + esc(x) + '</li>').join('')}</ul></div>`
        : `<div class="notice ok">人数の指定に明らかな矛盾はありません。休みは月に延べ${p.totalOff}日（1人平均${(p.totalOff / (S || 1)).toFixed(1)}日）です。</div>`;
    }

    const dayRows = cal
      .map((c) => {
        const ov = state.demandOverrides[c.day] || {};
        let total = 0;
        const cells = ds
          .map((x) => {
            const v = M.demandOf(state, c.day, c.type, x.code);
            total += v;
            const changed = ov[x.code] !== undefined;
            return `<td class="${changed ? 'changed' : ''} ${v ? 'nz' : ''}"><input type="number" min="0" max="20" data-day-demand="${c.day}" data-code="${esc(x.code)}" value="${v}" class="w-cnt" aria-label="${c.day}日 ${esc(x.code)}"></td>`;
          })
          .join('');
        const hasOv = Object.keys(ov).length > 0;
        return `<tr class="${c.type === 'holiday' ? 'row-holiday' : ''} ${issuesByDay[c.day] ? 'row-bad' : ''}">${dateCells(c)}<td class="type">${c.type === 'holiday' ? '休日' : '平日'}</td>${cells}
          <td class="sum ${total > S ? 'short' : ''}">${total}</td><td class="sum">${S - total}</td>
          <td>${hasOv ? `<button type="button" class="btn tiny" data-action="reset-day-demand" data-day="${c.day}">基本に戻す</button>` : ''}</td></tr>`;
      })
      .join('');

    return `
      <section class="card">
        <h2>基本の人数</h2>
        <p class="hint">その日の各勤務の人数を、<b>ちょうどその人数</b>にします。指定した勤務に入らない職員は「${esc(state.rules.fillerCode)}」になります。</p>
        <div class="table-wrap"><table class="sheet demand">
          <thead><tr><th></th>${head}<th>出勤計</th><th>休み</th></tr></thead><tbody>${tplRows}</tbody></table></div>
      </section>
      <section class="card">
        <h2>休日の3人勤務</h2>
        ${renderThreePerson()}
      </section>
      <section class="card">
        <h2>日付ごとの人数</h2>
        <p class="hint">会議や外部機関との対応などで人数が変わる日は、ここで直してください。基本と違う人数のマスは色が付きます。宿直入り（BE・DE・公E など）の人数と、翌日の宿直明け（EA・EC・E公 など）の人数はそろえてください。</p>
        ${issuesHtml}
        <div class="table-wrap tall"><table class="sheet demand">
          <thead><tr><th>日</th><th>曜</th><th>区分</th>${head}<th>出勤計</th><th>休み</th><th></th></tr></thead>
          <tbody>${dayRows}</tbody></table></div>
        <button type="button" class="btn small" data-action="reset-all-demand" ${Object.keys(state.demandOverrides).length ? '' : 'disabled'}>すべての日を基本の人数に戻す</button>
      </section>`;
  }

  // 休日の3人勤務：やむを得ない場合に使える体制の一覧
  function renderThreePerson() {
    const tp = state.threePerson;
    const ds = demandShifts();
    const rows = tp.plans
      .map((pl, i) => {
        const total = ds.reduce((a, x) => a + (Number(pl[x.code]) || 0), 0);
        return `<tr><th scope="row">体制${i + 1}</th>${ds
          .map((x) => `<td class="${pl[x.code] ? 'nz' : ''}"><input type="number" min="0" max="20" data-three-plan="${i}" data-code="${esc(x.code)}" value="${Number(pl[x.code]) || 0}" class="w-cnt" ${tp.enabled ? '' : 'disabled'}></td>`)
          .join('')}<td class="sum">${total}</td><td><button type="button" class="icon-btn danger" data-action="three-del" data-i="${i}" aria-label="体制${i + 1}を削除">${ICON.del}</button></td></tr>`;
      })
      .join('');
    return `
        <label class="check"><input type="checkbox" data-three-enabled ${tp.enabled ? 'checked' : ''}> 4人体制では休みを確保できない場合や、3人勤務にすれば希望休をかなえられる場合に、休日（日付ごとの人数を変えていない日）を3人勤務にしてよい</label>
        <p class="hint">残業込みでホームを回す体制です。できるだけ避け、どうしても必要なときだけ使います。3人勤務の日は、断続の人を早番・遅番の人と別のホームに置けることも確かめます（担当外のホームには入れないため）。</p>
        <div class="table-wrap"><table class="sheet demand">
          <thead><tr><th></th>${ds.map((x) => `<th>${chip(x.code)}</th>`).join('')}<th>計</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
        <button type="button" class="btn small" data-action="three-add" ${tp.enabled ? '' : 'disabled'}>＋ 体制を追加</button>`;
  }

  function renderRules() {
    const r = state.rules;
    const auto = M.nightRange(state);
    const codeOpts = (sel, list) => (list || state.shifts).map((x) => `<option value="${esc(x.code)}" ${x.code === sel ? 'selected' : ''}>${esc(x.code)}（${esc(x.name)}）</option>`).join('');
    const pairs = r.forbiddenPairs
      .map(
        (fp, i) => `<li><select data-pair="${i}" data-field="from">${codeOpts(fp.from)}</select> の翌日に <select data-pair="${i}" data-field="to">${codeOpts(fp.to)}</select> を入れない
          <button type="button" class="icon-btn danger" data-action="pair-del" data-i="${i}" aria-label="削除">${ICON.del}</button></li>`
      )
      .join('');
    return `
      <section class="card">
        <h2>必ず守る条件</h2>
        <div class="rules">
          <label>休み（公休＋有休）の日数 月 <input type="number" min="0" max="31" data-rule="minRest" data-type="number" value="${esc(r.minRest)}" class="w-num"> 〜 <input type="number" min="0" max="31" data-rule="maxRest" data-type="number" value="${esc(r.maxRest)}" class="w-num"> 日</label>
          <label>連勤の上限 <input type="number" min="1" max="31" data-rule="maxConsecutive" data-type="number" value="${esc(r.maxConsecutive)}" class="w-num"> 連勤まで</label>
          <label>宿直の回数 1人あたり月 <input type="number" min="0" max="31" data-rule="minNights" data-type="nullable" value="${r.minNights === null ? '' : esc(r.minNights)}" placeholder="自動" class="w-num"> 〜 <input type="number" min="0" max="31" data-rule="maxNights" data-type="nullable" value="${r.maxNights === null ? '' : esc(r.maxNights)}" placeholder="自動" class="w-num"> 回
            <span class="hint">空欄＝自動：今月は宿直${auto.total}回 ÷ 宿直できる${auto.n}人 で <b>${auto.min === auto.max ? auto.min : auto.min + "〜" + auto.max}回</b></span></label>
          <label>宿直入りから次の宿直入りまで 最低 <input type="number" min="1" max="31" data-rule="minNightGap" data-type="number" value="${esc(r.minNightGap)}" class="w-num"> 日 <span class="hint">2＝2日連続の宿直なし</span></label>
          <label>職員間の宿直回数の差 <input type="number" min="0" max="31" data-rule="maxNightDiff" data-type="number" value="${esc(r.maxNightDiff)}" class="w-num"> 回まで</label>
          <label>人数の指定がない職員に入れる休み <select data-rule="fillerCode">${codeOpts(r.fillerCode, restShifts())}</select></label>
          <div><b>翌日に入れない組み合わせ</b>
            <ul class="pairs">${pairs || '<li class="hint">（なし）</li>'}</ul>
            <button type="button" class="btn small" data-action="pair-add">＋ 組み合わせを追加</button></div>
        </div>
        <p class="hint">このほか、ホームごとの体制（各ホームに早番か断続1人・遅番1人。担当外のホームには入らない）、日付ごとの人数、宿直入りの翌日は宿直明け、宿直できる職員の指定、職員ごとに指定した公休数、シフト表で固定した勤務は必ず守ります。</p>
      </section>
      <section class="card">
        <h2>できるだけ満たす希望</h2>
        <ul class="plain">
          <li>希望休をかなえる（優先度：高）</li>
          <li>休日の3人勤務は、4人体制では休みを確保できない場合と、3人勤務にすれば希望休をかなえられる場合だけ使う（希望休のほうを優先）</li>
          <li>DE→EA→DE のように、宿直明けの翌日にまた宿直に入る形を避ける（優先度：高）</li>
          <li>2連勤・3連勤を中心にする（4連勤は許容、1日だけの勤務と5連勤はできるだけ避ける）</li>
          <li>4連休までにする（5連休以上はできるだけ避ける）</li>
          <li>宿直と次の宿直の間隔をできるだけ空ける（目安：月の日数 ÷ 宿直回数。前月末の宿直も含めて数える）</li>
          <li>公休数（自動の職員）、各勤務の回数、休日の休みを職員間で均等にする</li>
        </ul>
      </section>
      <section class="card">
        <h2>計算時間</h2>
        <label>計算時間の上限 <input type="number" min="2" max="120" data-rule="timeLimitSec" data-type="number" value="${esc(r.timeLimitSec)}" class="w-num"> 秒</label>
        <p class="hint">条件をすべて満たす案が見つかり、それ以上改善しなくなった時点で、上限より早く終わります。</p>
      </section>`;
  }

  function dateCells(c) {
    const cls = c.dow === 0 || c.holidayName ? 'sun' : c.dow === 6 ? 'sat' : '';
    return `<th scope="row" class="date ${cls}" title="${esc(c.holidayName)}">${c.day}</th><td class="dow ${cls}">${c.dowLabel}</td>`;
  }

  // メイン画面：シフト表（行＝日付、列＝職員）。各マスで勤務を固定でき、生成結果も同じ表に表示する
  function renderMain(errs) {
    const cal = M.buildCalendar(state);
    const p = errs.length ? null : M.compile(state);
    const A = p ? M.gridToMatrix(state, p) : null;
    const ev = A ? M.evaluate(p, A) : null;
    const st = A ? M.stats(p, A) : null;
    const hard = ev ? ev.violations.filter((v) => v.level === 'hard') : [];
    const soft = ev ? ev.violations.filter((v) => v.level === 'soft') : [];
    const canDownload = !!A && !running && hard.length === 0;
    const missing = missingPrevCount();
    const prevDays = M.prevMonthDays(state).slice(M.PREV_DAYS - prevRequiredDays());
    const pd0 = prevDays[0], pd1 = prevDays[prevDays.length - 1];

    const toolbar = `
      <div class="main-bar">
        <div class="month-nav">
          <button type="button" class="icon-btn" data-action="month-prev" aria-label="前の月" ${running ? 'disabled' : ''}>‹</button>
          <span class="month-label">${state.year}年${state.month}月</span>
          <button type="button" class="icon-btn" data-action="month-next" aria-label="次の月" ${running ? 'disabled' : ''}>›</button>
        </div>
        <div class="staff-count" role="group" aria-label="職員の人数">
          職員 <b>${state.staff.length}</b> 名
          <button type="button" class="icon-btn" data-action="staff-del" data-i="${state.staff.length - 1}" aria-label="最後の職員を削除" ${running || state.staff.length <= 1 ? 'disabled' : ''}>－</button>
          <button type="button" class="icon-btn" data-action="staff-add" aria-label="職員を追加" ${running ? 'disabled' : ''}>＋</button>
        </div>
        <div class="btn-row">
          <button type="button" class="btn primary" data-action="generate" ${running || errs.length || missing ? 'disabled' : ''} title="${missing ? '前月末の勤務をすべて入力してください' : ''}">${running ? '生成中…' : 'シフト生成'}</button>
          ${running ? '<button type="button" class="btn" data-action="cancel">中止</button>' : ''}
          <button type="button" class="btn" data-action="download" ${canDownload ? '' : 'disabled'} title="${A && hard.length ? '必ず守る条件の違反があるため、ダウンロードできません' : ''}">Excelダウンロード</button>
          ${running ? '' : '<label class="btn small">前月のExcelを読み込む<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" data-action="import-prev" hidden></label>'}
          <button type="button" class="btn small" data-action="clear-requests" ${hasRequests() && !running ? '' : 'disabled'}>固定をすべて解除</button>
          <button type="button" class="btn small" data-action="clear-result" ${state.result && !running ? '' : 'disabled'}>生成結果を消す</button>
        </div>
      </div>`;
    const status = mainStatus ? `<div class="notice ${mainStatus.kind}">${mainStatus.html}</div>` : '';
    let summary = '';
    if (ev)
      summary = hard.length
        ? `<div class="notice error"><strong>必ず守る条件に${hard.length}件の違反があるため、Excelをダウンロードできません。</strong>赤枠のマスや下の一覧を確認し、固定を見直すか、もう一度「シフト生成」を押してください。</div>`
        : `<div class="notice ok"><strong>必ず守る条件をすべて満たしています。</strong>Excelをダウンロードできます。${soft.length ? `（できるだけ避けたい点が${soft.length}件あります）` : ''}</div>`;
    else if (state.result && !errs.length)
      summary = '<div class="notice info">月・職員・勤務区分の設定が変わったため、前回の生成結果は表示していません。もう一度「シフト生成」を押してください。</div>';

    // 違反のあるマス・日
    const cellMark = {}, dayMark = {};
    if (ev)
      for (const v of ev.violations) {
        if (v.staff >= 0 && v.day >= 0) {
          const key = v.staff + '|' + v.day;
          if (cellMark[key] !== 'hard') cellMark[key] = v.level;
        } else if (v.staff < 0 && v.day >= 0 && v.level === 'hard') dayMark[v.day] = true;
      }
    // 作成前の見込みチェック（人数の矛盾など）
    const pre = p ? M.precheck(p) : [];
    for (const msg of pre) for (const m of msg.matchAll(/(\d+)日\(/g)) dayMark[Number(m[1]) - 1] = true;
    const preNotice =
      pre.length && !running
        ? `<div class="notice error"><strong>この条件ではシフトを生成できません。</strong>右側の人数や固定を見直してください。<ul>${pre.map((x) => '<li>' + esc(x) + '</li>').join('')}</ul></div>`
        : '';
    // 人数の列：その月に人数の指定がある勤務（生成後のみ）
    const dcols = demandColumns();
    const hiddenCols = demandShifts().filter((x) => !dcols.includes(x.code));

    const codeOpts = state.shifts.map((x) => [`fix:${x.code}`, x.code]);
    const head =
      state.staff
        .map(
          (s, i) =>
            `<th class="staff-h">${esc(s.name)}${state.staff.length > 1 && !running ? `<button type="button" class="x-btn" data-action="staff-del" data-i="${i}" aria-label="${esc(s.name)}を削除" title="${esc(s.name)}を削除">${ICON.del}</button>` : ''}</th>`
        )
        .join('') +
      dcols
        .map((code, i) => {
          const removable = state.extraDemandCols.includes(code) && !cal.some((c) => M.demandOf(state, c.day, c.type, code) > 0);
          return `<th class="dem-h ${i === 0 ? 'dem-first' : ''}" title="${esc((shiftByCode(code) || {}).name)}の人数">${chip(code)}${removable ? `<button type="button" class="x-btn" data-action="dem-col-del" data-code="${esc(code)}" aria-label="${esc(code)}の列を消す">${ICON.del}</button>` : ''}</th>`;
        })
        .join('') +
      `<th class="dem-h dem-sum">計</th>` +
      `<th class="dem-h dem-add">${hiddenCols.length ? `<select data-add-dem-col aria-label="人数の列を追加"><option value="">＋</option>${hiddenCols.map((x) => `<option value="${esc(x.code)}">${esc(x.code)}（${esc(x.name)}）</option>`).join('')}</select>` : ''}</th>`;
    const body = cal
      .map((c, d) => {
        const cells = state.staff
          .map((s, si) => {
            const req = (state.requests[s.id] || {})[c.day] || '';
            const fixed = req.startsWith('fix:') ? req.slice(4) : '';
            const wish = req.startsWith('wish:');
            const auto = A ? p.codes[A[si][d]] : '';
            const shown = fixed || auto;
            const value = fixed ? req : wish ? 'wish' : '';
            const opts = [['', fixed ? '固定を外す' : auto || '—'], ['wish', auto && wish ? auto : '希望休'], ...codeOpts]
              .map(([v, l]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`)
              .join('');
            const mark = cellMark[si + '|' + d] || '';
            const cls = ['cell', fixed ? 'fixed' : '', wish ? 'wish' : '', mark ? 'v-' + mark : '', !shown && !wish ? 'empty' : ''].join(' ');
            return `<td class="${cls}"><select data-cell="${esc(s.id)}" data-day="${c.day}" aria-label="${esc(s.name)} ${c.day}日" ${running ? 'disabled' : ''}>${opts}</select>${fixed ? '<span class="lock" title="固定">🔒</span>' : ''}</td>`;
          })
          .join('');
        // その日に必要な体制（基本の人数が入っていて、書き換えられる）
        const ov = state.demandOverrides[c.day] || {};
        const planIdx = A ? M.dayPlanIndex(p, A, d) : 0; // 1以上なら休日の3人勤務
        const plan = A ? p.plans[d][planIdx] : null;
        let total = 0;
        const counts =
          dcols
            .map((code, i) => {
              const need = M.demandOf(state, c.day, c.type, code);
              total += need;
              let actual = null;
              const k = p ? p.codes.indexOf(code) : -1;
              if (A) {
                actual = 0;
                for (let s = 0; s < p.S; s++) if (A[s][d] === k) actual++;
              }
              const bad = actual !== null && actual !== plan[k];
              const cls = ['dem', i === 0 ? 'dem-first' : '', ov[code] !== undefined ? 'changed' : '', need ? 'nz' : '', bad ? 'short' : ''].join(' ');
              const tip = bad ? `生成結果は${actual}人（指定${need}人）` : ov[code] !== undefined ? `基本の人数から変更（基本：${Number(state.demand[c.type][code]) || 0}人）` : '';
              return `<td class="${cls}" title="${esc(tip)}"><input type="number" min="0" max="20" data-day-demand="${c.day}" data-code="${esc(code)}" value="${need}" aria-label="${c.day}日 ${esc(code)}の人数" ${running ? 'disabled' : ''}></td>`;
            })
            .join('') +
          (planIdx > 0
            ? `<td class="dem-sum three" title="休日の3人勤務（${esc(dcols.filter((code) => plan[p.codes.indexOf(code)] > 0).join('・'))}）">3人</td>`
            : `<td class="dem-sum ${total > state.staff.length ? 'short' : ''}">${total}</td>`) +
          `<td class="dem-add"></td>`;
        return `<tr class="${c.type === 'holiday' ? 'row-holiday' : ''} ${dayMark[d] ? 'row-bad' : ''} ${planIdx > 0 ? 'row-three' : ''}">${dateCells(c)}${cells}${counts}</tr>`;
      })
      .join('');
    // 前月末の勤務（月をまたぐ連勤・宿直明けなどの判定に使う。すべて入力しないと生成できない）
    const prevOpts = (sel) =>
      `<option value="">未入力</option>` + state.shifts.map((x) => `<option value="${esc(x.code)}" ${x.code === sel ? 'selected' : ''}>${esc(x.code)}</option>`).join('');
    const prevRows = prevDays
      .map((c, i) => {
        const j = M.PREV_DAYS - prevDays.length + i;
        const cls = c.dow === 0 ? 'sun' : c.dow === 6 ? 'sat' : '';
        const cells = state.staff
          .map((s, si) => {
            const code = s.prevTail[j];
            return `<td class="cell prev ${code ? '' : 'missing'}"><select data-prev="${si}" data-j="${j}" aria-label="${esc(s.name)} 前月${c.month}/${c.day}" ${running ? 'disabled' : ''}>${prevOpts(code)}</select></td>`;
          })
          .join('');
        return `<tr class="row-prev ${i === prevDays.length - 1 ? 'row-prev-last' : ''}"><th scope="row" class="date ${cls}">${c.month}/${c.day}</th><td class="dow ${cls}">${c.dowLabel}</td>${cells}<td colspan="${dcols.length + 2}" class="prev-note">前月</td></tr>`;
      })
      .join('');

    let foot = '';
    if (A) {
      const usedIdx = [];
      for (let k = 0; k < p.K; k++) if (k !== p.fillerIdx && st.some((x) => x.count[k] > 0)) usedIdx.push(k);
      foot = [
        ['公休', (s) => st[s].off + (p.offTarget[s] >= 0 ? ' / ' + p.offTarget[s] : '')],
        ['有休', (s) => st[s].leave],
        ['休み計', (s) => st[s].rest],
        ['勤務日数', (s) => st[s].work],
        ['宿直', (s) => st[s].nights],
        ...usedIdx.map((k) => [p.codes[k], (s) => st[s].count[k]]),
      ]
        .map(([label, f]) => `<tr><th colspan="2" class="foot-h">${esc(label)}</th>${state.staff.map((_, s) => `<td class="foot">${f(s)}</td>`).join('')}<td colspan="${dcols.length + 2}"></td></tr>`)
        .join('');
    }

    const vtext = (v) => (v.day >= 0 ? p.dayLabels[v.day] + ' ' : '') + (v.staff >= 0 ? p.names[v.staff] + '：' : '') + v.msg;
    const checks =
      ev && (hard.length || soft.length)
        ? `<div class="checks">
        ${hard.length ? `<h3 class="error-text">必ず守る条件の違反（${hard.length}件）</h3><ul class="violations">${hard.map((v) => '<li>' + esc(vtext(v)) + '</li>').join('')}</ul>` : ''}
        ${soft.length ? `<h3>できるだけ避けたい点（${soft.length}件）</h3><ul class="violations soft">${soft.map((v) => '<li>' + esc(vtext(v)) + '</li>').join('')}</ul>` : ''}
      </div>`
        : '';

    // 進み具合に合わせた説明：①前月の勤務 → ②体制・固定を入れて生成 → ③確認・Excelダウンロード
    const stage = missing ? 1 : A ? 3 : 2;
    const stepNames = ['前月の勤務', '体制・固定を入れて生成', '確認・Excelダウンロード'];
    const steps = `<ol class="steps">${stepNames
      .map((name, i) => `<li class="${i + 1 < stage ? 'done' : i + 1 === stage ? 'current' : ''}"><span class="no">${i + 1 < stage ? '✓' : i + 1}</span>${name}</li>`)
      .join('')}</ol>`;
    let guideBody;
    if (stage === 1)
      guideBody = `<strong>前月末（${pd0.month}/${pd0.day}〜${pd1.month}/${pd1.day}）の勤務が必要です。まずは前月にこのアプリでダウンロードしたExcelを読み込んでください。</strong>
          <div class="btn-row" style="margin:6px 0"><label class="btn primary small">前月のExcelを読み込む<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" data-action="import-prev" hidden></label></div>
          前月のExcelがない場合は、表のいちばん上の前月の行に、勤務を1マスずつ入力することもできます（未入力 ${missing} マス）。すべて埋まると「シフト生成」を押せます。`;
    else if (stage === 2)
      guideBody = [
        '平日・休日の基本の人数が入っているので、会議などで変わる日だけ書き換えてください（変更したマスは黄色）。',
        '決まっている勤務は、マスのプルダウンで選んで固定してください（🔒）。',
        '「希望休」は、できるだけ休みにします。',
        '「シフト生成」を押すと、残りのマスを条件に合わせて埋めます。',
      ].join('<br>');
    else guideBody = ['マスの勤務は変更可能です。', '変更すると条件を確認し直します。', '問題なければ右上のExcelダウンロードを押してください。'].join('<br>');
    const guide = `<div class="guide stage${stage}">${steps}<div class="guide-body">${guideBody}</div></div>`;

    return `
      <section class="card">
        ${toolbar}${status}${guide}${preNotice}${summary}${checks}
        <div class="legend" aria-label="表の見かた">
          <span class="lg"><span class="sw sw-hard"></span>必ず守る条件の違反</span>
          <span class="lg"><span class="sw sw-soft"></span>できるだけ避けたい点</span>
          <span class="lg"><span class="sw sw-fixed">🔒</span>固定した勤務</span>
          <span class="lg"><span class="sw sw-wish"></span>希望休</span>
          <span class="lg"><span class="sw sw-missing"></span>前月の未入力</span>
          <span class="lg"><span class="sw sw-short">1</span>人数が指定と違う</span>
          <span class="lg"><span class="sw sw-three">3人</span>休日の3人勤務</span>
        </div>
        <div class="table-wrap tall"><table class="sheet main">
          <thead><tr><th>日</th><th>曜</th>${head}</tr></thead>
          <tbody>${prevRows}${body}</tbody>${foot ? `<tfoot>${foot}</tfoot>` : ''}</table></div>
      </section>`;
  }

  // ルールで決まる宿直回数の範囲（職員ごとの指定がない場合）
  function nightRangeOfRules() {
    const a = M.nightRange(state), r = state.rules;
    const pick = (v, def) => (v === null || v === '' ? def : Number(v));
    return { min: pick(r.minNights, a.min), max: pick(r.maxNights, a.max) };
  }

  // シフト表の右側に出す人数の列：基本の人数か今月の人数に1以上がある勤務と、追加した勤務（勤務区分の並び順）
  function demandColumns() {
    const cal = M.buildCalendar(state);
    return demandShifts()
      .map((x) => x.code)
      .filter(
        (code) =>
          state.extraDemandCols.includes(code) ||
          Number(state.demand.weekday[code]) > 0 ||
          Number(state.demand.holiday[code]) > 0 ||
          cal.some((c) => M.demandOf(state, c.day, c.type, code) > 0)
      );
  }

  // メイン画面で入力が必要な前月末の日数：連勤の上限の日数（1日目が何連勤目かを確定させるのに必要）
  function prevRequiredDays() {
    return Math.min(M.PREV_DAYS, Math.max(Number(state.rules.maxConsecutive) || 1, 2));
  }

  // 前月末の勤務の未入力のマス数（入力が必要な日数の範囲）
  function missingPrevCount() {
    const need = prevRequiredDays();
    let n = 0;
    for (const st of state.staff) for (let j = M.PREV_DAYS - need; j < M.PREV_DAYS; j++) if (!st.prevTail[j]) n++;
    return n;
  }

  // 職員の人数が変わると前回の生成結果は使えないので消す（固定・希望休は残す）
  function staffChanged() {
    if (!state.result) return;
    state.result = null;
    mainStatus = { kind: 'info', html: `職員が${state.staff.length}名になりました。「シフト生成」を押して、もう一度生成してください。` };
  }

  function hasRequests() {
    return Object.values(state.requests).some((o) => Object.keys(o).length);
  }

  // 月を切り替える。日付に結びついた入力（固定・希望休・日付ごとの人数・平日/休日の切り替え・前月末の勤務）は消す
  function changeMonth(y, m) {
    if (running || (y === state.year && m === state.month)) {
      render();
      return;
    }
    const hasData =
      hasRequests() ||
      Object.keys(state.dayTypeOverrides).length ||
      Object.keys(state.demandOverrides).length ||
      state.staff.some((st) => st.prevTail.some(Boolean));
    if (hasData && !confirm('月を変更すると、この月の固定・希望休、前月末の勤務、日付ごとの人数、平日/休日の切り替えは消えます。よろしいですか。')) {
      render();
      return;
    }
    state.requests = {};
    state.dayTypeOverrides = {};
    state.demandOverrides = {};
    for (const st of state.staff) st.prevTail = M.emptyTail(); // 前月の行は未入力に戻す
    state.year = y;
    state.month = m;
    mainStatus = null;
    commit();
  }

  // ---------- 自動作成 ----------
  function generate() {
    const errs = M.validateSettings(state);
    if (errs.length || missingPrevCount()) return;
    const p = M.compile(state);
    const pre = M.precheck(p);
    if (pre.length) {
      mainStatus = {
        kind: 'error',
        html: '<strong>この条件では、必ず守る条件をすべて満たすシフトは作れません。</strong>次の点を見直してください。<ul>' + pre.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>',
      };
      render();
      return;
    }
    running = true;
    const limit = Math.max(2, Number(state.rules.timeLimitSec) || 15) * 1000;
    mainStatus = { kind: 'info', html: '作成しています…' };
    render();

    const finish = (res) => {
      running = false;
      worker = null;
      const grid = {};
      state.staff.forEach((st, s) => (grid[st.id] = res.grid[s].map((k) => p.codes[k])));
      state.result = { year: state.year, month: state.month, grid };
      const sec = (res.elapsedMs / 1000).toFixed(1);
      if (res.hardCount === 0) mainStatus = { kind: 'ok', html: `シフトを生成しました（${sec}秒）。` };
      else
        mainStatus = {
          kind: 'warn',
          html: `<strong>計算時間の上限（${sec}秒）までに、必ず守る条件をすべて満たす案は見つかりませんでした。</strong>
            条件上は作成できる可能性があります。計算時間を延ばして再度作成するか、条件をゆるめてください。下の表は、違反がいちばん少なかった参考案です。`,
        };
      commit();
    };

    const seed = (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;
    // ワーカーが使えない環境（ファイルを直接開いた場合など）では画面内で計算する
    const runInPage = () => setTimeout(() => finish(window.ShiftSolver.solve(p, { timeLimitMs: limit, seed })), 30);
    try {
      worker = new Worker('js/worker.js');
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') {
          const el = $('.notice.info');
          if (el) el.textContent = `作成しています…（${(m.elapsedMs / 1000).toFixed(0)}秒経過${m.hardCount > 0 ? '、条件を満たす案を探しています' : '、より良い案を探しています'}）`;
        } else if (m.type === 'done') finish(m);
      };
      worker.onerror = () => {
        worker = null;
        runInPage();
      };
      worker.postMessage({ problem: p, timeLimitMs: limit, seed });
    } catch (e) {
      runInPage();
    }
  }

  function cancel() {
    if (worker) worker.terminate();
    worker = null;
    running = false;
    mainStatus = { kind: 'info', html: '作成を中止しました。' };
    render();
  }

  // ---------- ファイル ----------
  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `シフト設定_${state.year}年${state.month}月.json`);
  }

  function importJson(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || (data.version !== M.VERSION && data.version !== 2)) throw new Error('version');
        state = M.normalizeState(data);
        mainStatus = null;
        commit();
        alert('設定を読み込みました。');
      } catch (e) {
        alert('設定ファイルを読み込めませんでした（形式が違うか、古い版の設定ファイルです）。');
      }
    };
    reader.readAsText(file);
  }

  async function download() {
    const p = M.compile(state);
    const A = M.gridToMatrix(state, p);
    if (!A) return;
    const ev = M.evaluate(p, A);
    if (ev.hardCount > 0) return;
    try {
      const blob = await window.ShiftExcel.build(state, p, A, ev);
      downloadBlob(blob, `勤務表_${state.year}年${state.month}月.xlsx`);
    } catch (e) {
      console.error(e);
      alert('Excelファイルを作成できませんでした。');
    }
  }

  // 前月にダウンロードした Excel から、前月末の勤務を読み込む。
  // 本当に前月の勤務表かを、埋め込んだ年月・タイトル・ファイル名・日付と曜日で確かめる
  async function importPrev(file) {
    const fail = (msg) => {
      mainStatus = { kind: 'error', html: '<strong>前月のExcelを読み込めませんでした。</strong>' + esc(msg) };
      render();
    };
    let data;
    try {
      data = await window.ShiftExcel.read(file);
    } catch (e) {
      return fail('Excelファイル（.xlsx）を開けませんでした。');
    }
    const { header, rows } = data;
    if (header[0] !== '日' || !rows.length) return fail('このアプリでダウンロードした勤務表のExcelを選んでください。');
    const byDay = {};
    for (const r of rows) byDay[Number(r[0])] = r;
    const fileDays = Object.keys(byDay).map(Number);

    const days = M.prevMonthDays(state); // 前月末の7日間
    const first = days[0], last = days[days.length - 1];
    const prevY = new Date(state.year, state.month - 2, 1).getFullYear(), prevM = last.month;
    const prevLabel = `${prevY}年${prevM}月`;
    const isPrev = (ym) => !ym || (ym.y === prevY && ym.m === prevM);
    const fm = /(\d{4})年(\d{1,2})月/.exec(file.name);
    const fromName = fm ? { y: Number(fm[1]), m: Number(fm[2]) } : null;
    for (const [ym, where] of [[data.subject, 'ファイルに記録された年月'], [data.title, '表のタイトル'], [fromName, 'ファイル名']])
      if (!isPrev(ym)) return fail(`${where}が ${ym.y}年${ym.m}月 です。前月（${prevLabel}）の勤務表を選んでください。`);
    const calendarMatches = (y, m) =>
      Math.max(...fileDays) === M.daysInMonth(y, m) && fileDays.every((dd) => byDay[dd][1] === M.WEEK[new Date(y, m - 1, dd).getDay()]);
    if (!calendarMatches(prevY, prevM)) {
      // どの月の勤務表か推定する（前後2年で、いちばん近い月）
      let guess = '';
      for (let i = 1; i <= 24 && !guess; i++)
        for (const k of [-i, i]) {
          const dt = new Date(prevY, prevM - 1 + k, 1);
          if (!guess && calendarMatches(dt.getFullYear(), dt.getMonth() + 1)) guess = `${dt.getFullYear()}年${dt.getMonth() + 1}月`;
        }
      return fail(`日付と曜日が、前月（${prevLabel}）のカレンダーと一致しません。${guess ? `${guess}の勤務表のようです。` : ''}前月の勤務表を選んでください。`);
    }
    const lacking = days.filter((c) => !byDay[c.day]);
    if (lacking.length) return fail(`前月末（${lacking.map((c) => c.day + '日').join('・')}）の行がありません。`);

    // 職員の列：仮名で対応させる。合わないときは、職員の列の数が同じなら並び順で対応させる
    const byOrder = header.length - 2 === state.staff.length;
    const codes = new Set(state.shifts.map((x) => x.code));
    const unknown = new Set(), notFound = [], usedOrder = [];
    state.staff.forEach((st, si) => {
      let col = header.indexOf(st.name);
      if (col < 2) {
        if (!byOrder) return notFound.push(st.name);
        col = 2 + si;
        usedOrder.push(`${st.name}←「${header[col]}」`);
      }
      days.forEach((c, j) => {
        const code = byDay[c.day][col] || '';
        if (code && !codes.has(code)) unknown.add(code);
        st.prevTail[j] = codes.has(code) ? code : '';
      });
    });
    const warnings = [];
    if (usedOrder.length) warnings.push('仮名が一致しない職員は、列の順番で読み込みました：' + usedOrder.join('、'));
    if (notFound.length) warnings.push('Excelに見つからなかった職員：' + notFound.join('、') + '（手で入力してください）');
    if (unknown.size) warnings.push('勤務区分にない記号は空欄にしました：' + [...unknown].join('、'));
    mainStatus = {
      kind: warnings.length ? 'warn' : 'ok',
      html:
        `前月の勤務表（${esc(file.name)}）から、${first.month}/${first.day}〜${last.month}/${last.day}の勤務を読み込みました（${prevLabel}の勤務表であることを確認済み）。` +
        (warnings.length ? '<ul>' + warnings.map((w) => '<li>' + esc(w) + '</li>').join('') + '</ul>' : ''),
    };
    commit();
  }

  // ---------- 操作 ----------
  function onClick(e) {
    const tab = e.target.closest('.tab');
    if (tab) {
      currentTab = tab.dataset.tab;
      render();
      return;
    }
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.tagName === 'INPUT') return;
    const i = Number(btn.dataset.i);
    const swap = (arr, a, b) => ([arr[a], arr[b]] = [arr[b], arr[a]]);
    switch (btn.dataset.action) {
      case 'toggle-day': {
        const day = Number(btn.dataset.day);
        const c = M.buildCalendar(state)[day - 1];
        const next = c.type === 'holiday' ? 'weekday' : 'holiday';
        if (next === c.autoType) delete state.dayTypeOverrides[day];
        else state.dayTypeOverrides[day] = next;
        break;
      }
      case 'reset-days':
        state.dayTypeOverrides = {};
        break;
      case 'export-json':
        exportJson();
        return;
      case 'reset-all':
        if (!confirm('すべての設定と作成結果を消して、初期値に戻します。よろしいですか。')) return;
        state = M.defaultState();
        mainStatus = null;
        break;
      case 'staff-add': {
        const used = new Set(state.staff.map((s) => s.name));
        let n = 1, name;
        while (used.has((name = '職員' + n))) n++;
        // 番号順の位置に入れる（職員3が空いていれば職員2の次）
        let at = state.staff.findIndex((s) => {
          const m = /^職員(\d+)$/.exec(s.name);
          return m && Number(m[1]) > n;
        });
        if (at < 0) at = state.staff.length;
        state.staff.splice(at, 0, M.normalizeStaff({ id: newId(), name }));
        staffChanged();
        break;
      }
      case 'staff-del': {
        const st = state.staff[i];
        if (!confirm(`${st.name} を削除します。この職員の固定・希望休も消えます。よろしいですか。`)) return;
        state.staff.splice(i, 1);
        delete state.requests[st.id];
        staffChanged();
        break;
      }
      case 'staff-up':
        swap(state.staff, i, i - 1);
        break;
      case 'staff-down':
        swap(state.staff, i, i + 1);
        break;
      case 'shift-add': {
        let n = 1;
        while (state.shifts.some((x) => x.code === 'X' + n)) n++;
        state.shifts.push({ code: 'X' + n, name: '新しい勤務', color: '#F8CBAD', night: 'none', work: true, off: false, leave: false });
        break;
      }
      case 'shift-del': {
        const x = state.shifts[i];
        if (!confirm(`勤務区分「${x.code}（${x.name}）」を削除します。この記号を使った人数の指定や固定も消えます。よろしいですか。`)) return;
        state.shifts.splice(i, 1);
        removeCodeRefs(x.code);
        break;
      }
      case 'shift-up':
        swap(state.shifts, i, i - 1);
        break;
      case 'shift-down':
        swap(state.shifts, i, i + 1);
        break;
      case 'dem-col-del':
        state.extraDemandCols = state.extraDemandCols.filter((c) => c !== btn.dataset.code);
        break;
      case 'three-add':
        state.threePerson.plans.push({});
        break;
      case 'three-del':
        state.threePerson.plans.splice(i, 1);
        break;
      case 'reset-day-demand':
        delete state.demandOverrides[btn.dataset.day];
        break;
      case 'reset-all-demand':
        if (!confirm('日付ごとに変更した人数を、すべて基本の人数に戻します。よろしいですか。')) return;
        state.demandOverrides = {};
        break;
      case 'pair-add': {
        const c0 = state.shifts[0] ? state.shifts[0].code : '';
        state.rules.forbiddenPairs.push({ from: c0, to: c0 });
        break;
      }
      case 'pair-del':
        state.rules.forbiddenPairs.splice(i, 1);
        break;
      case 'clear-prev':
        if (!confirm('前月末の勤務をすべて消します。よろしいですか。')) return;
        for (const st of state.staff) st.prevTail = M.emptyTail();
        break;
      case 'clear-requests':
        if (!confirm('この月の固定・希望休をすべて解除します。よろしいですか。')) return;
        state.requests = {};
        break;
      case 'clear-result':
        if (!confirm('生成したシフトを消します（固定・希望休は残ります）。よろしいですか。')) return;
        state.result = null;
        mainStatus = null;
        break;
      case 'toggle-view':
        view = view === 'main' ? 'settings' : 'main';
        render();
        window.scrollTo(0, 0);
        return;
      case 'month-prev':
      case 'month-next': {
        const dt = new Date(state.year, state.month - 1 + (btn.dataset.action === 'month-next' ? 1 : -1), 1);
        changeMonth(dt.getFullYear(), dt.getMonth() + 1);
        return;
      }
      case 'generate':
        generate();
        return;
      case 'cancel':
        cancel();
        return;
      case 'download':
        download();
        return;
      default:
        return;
    }
    commit();
  }

  function onChange(e) {
    const t = e.target;
    const d = t.dataset;
    const val = t.type === 'checkbox' ? t.checked : t.value;

    if (d.action === 'import-prev') {
      if (t.files[0]) importPrev(t.files[0]);
      t.value = '';
      return;
    }
    if (d.action === 'import-json') {
      if (t.files[0]) importJson(t.files[0]);
      t.value = '';
      return;
    }
    if (t.hasAttribute('data-add-dem-col')) {
      if (val && !state.extraDemandCols.includes(val)) state.extraDemandCols.push(val);
      commit();
      return;
    }
    if (t.hasAttribute('data-three-enabled')) {
      state.threePerson.enabled = t.checked;
      commit();
      return;
    }
    if (d.threePlan !== undefined) {
      const pl = state.threePerson.plans[Number(d.threePlan)];
      const v = Math.max(0, Number(val) || 0);
      if (v) pl[d.code] = v;
      else delete pl[d.code];
      commit();
      return;
    }
    if (d.monthPart) {
      const v = Number(val);
      changeMonth(d.monthPart === 'year' ? v : state.year, d.monthPart === 'month' ? v : state.month);
      return;
    }
    if (d.staff !== undefined) {
      const st = state.staff[Number(d.staff)];
      if (d.field === 'name') st.name = String(val).trim();
      else if (d.field === 'canNight') st.canNight = val;
      else if (d.field === 'home') st.home = val;
      else if (d.field === 'holidays' || d.field === 'minNights' || d.field === 'maxNights') st[d.field] = val === '' ? null : Math.max(0, Number(val));
      else st[d.field] = Math.max(0, Number(val) || 0);
    } else if (d.shift !== undefined) {
      const x = state.shifts[Number(d.shift)];
      if (d.field === 'code') {
        const nv = String(val).trim();
        if (nv !== x.code) {
          if (!nv || state.shifts.some((y) => y.code === nv)) {
            alert(nv ? `記号「${nv}」はすでに使われています。` : '記号を入力してください。');
            render();
            return;
          }
          renameCode(x.code, nv);
          x.code = nv;
        }
      } else x[d.field] = val;
    } else if (d.demand) {
      state.demand[d.demand][d.code] = Math.max(0, Number(val) || 0);
    } else if (d.dayDemand) {
      const day = Number(d.dayDemand);
      const c = M.buildCalendar(state)[day - 1];
      const v = Math.max(0, Number(val) || 0);
      const base = Number(state.demand[c.type][d.code]) || 0;
      const ov = (state.demandOverrides[day] = state.demandOverrides[day] || {});
      if (v === base) delete ov[d.code];
      else ov[d.code] = v;
      if (!Object.keys(ov).length) delete state.demandOverrides[day];
    } else if (d.rule) {
      state.rules[d.rule] = d.type === 'number' ? Number(val) : d.type === 'nullable' ? (val === '' ? null : Math.max(0, Number(val))) : val;
    } else if (d.pair !== undefined) {
      state.rules.forbiddenPairs[Number(d.pair)][d.field] = val;
    } else if (d.prev !== undefined) {
      state.staff[Number(d.prev)].prevTail[Number(d.j)] = val;
    } else if (d.cell) {
      // メイン画面のマス：'' = 自動、'wish' = 希望休、'fix:記号' = その勤務に固定
      const req = (state.requests[d.cell] = state.requests[d.cell] || {});
      if (!val) delete req[d.day];
      else if (val === 'wish') req[d.day] = 'wish:' + state.rules.fillerCode;
      else {
        req[d.day] = val;
        const code = val.slice(4);
        const p = M.compile(state);
        if (M.gridToMatrix(state, p)) state.result.grid[d.cell][Number(d.day) - 1] = code;
      }
    } else return;
    commit();
  }

  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  // その月の入力は保存しないので、入力があるときは再読み込みやタブを閉じる前にブラウザの確認を出す
  window.addEventListener('beforeunload', (e) => {
    const hasInput =
      state.result ||
      hasRequests() ||
      Object.keys(state.demandOverrides).length ||
      Object.keys(state.dayTypeOverrides).length ||
      state.staff.some((st) => st.prevTail.some(Boolean));
    if (!hasInput) return;
    e.preventDefault();
    e.returnValue = '';
  });
  save(); // 以前の版で localStorage に残っていた月ごとの入力を取り除く
  render();
})();
