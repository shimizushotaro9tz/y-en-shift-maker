/*
 * solver.js — シフトの自動作成（焼きなまし法）
 * 必ず守る条件は大きな罰点、希望は小さな罰点として、罰点の合計が最小になる勤務の組み合わせを探す。
 * 日ごとの人数は最初の案で合わせ、その後は主に「同じ日の職員どうしの入れ替え」で人数を崩さずに改善する。
 * 固定したセル（希望・固定の「必ず」や手修正で固定したセル）は動かさない。
 */
(function (root) {
  'use strict';
  const M = root.ShiftModel;
  const NIGHT = M.NIGHT;

  function makeRandom(seed) {
    let a = seed >>> 0 || 1;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 最初の案：日ごとに、宿直明け → 宿直入り → その他の勤務 の順で人数どおりに割り当て、残りは公休
  function construct(p, rand) {
    const { S, D, K } = p;
    const A = Array.from({ length: S }, (_, s) => Int16Array.from(p.locked[s]));
    const nights = new Array(S).fill(0);
    const works = new Array(S).fill(0);
    const shuffleBy = (list, key) =>
      list
        .map((s) => ({ s, k: key(s) + rand() * 0.5 }))
        .sort((x, y) => x.k - y.k)
        .map((x) => x.s);
    const all = Array.from({ length: S }, (_, s) => s);

    for (let d = 0; d < D; d++) {
      const prev = (s) => (d > 0 ? A[s][d - 1] : p.prevLast[s]);
      const need = p.demand[d].slice();
      for (let s = 0; s < S; s++) if (A[s][d] >= 0) need[A[s][d]]--;
      const free = () => all.filter((s) => A[s][d] < 0);
      const take = (s, k) => {
        A[s][d] = k;
        need[k]--;
        if (p.work[k]) works[s]++;
        if (p.night[k] === NIGHT.IN) nights[s]++;
      };

      // 前日が宿直入りの職員には宿直明けの勤務を
      const outs = [];
      for (let k = 0; k < K; k++) if (p.night[k] === NIGHT.OUT) for (let i = 0; i < need[k]; i++) outs.push(k);
      for (const s of free()) {
        const pv = prev(s);
        if (pv >= 0 && p.night[pv] === NIGHT.IN && outs.length) take(s, outs.splice(Math.floor(rand() * outs.length), 1)[0]);
      }
      // 宿直入り（翌日が空いていて、回数の少ない職員から）
      for (let k = 0; k < K; k++) {
        if (p.night[k] !== NIGHT.IN) continue;
        const cand = shuffleBy(
          free().filter((s) => p.canNight[s] && nights[s] < p.maxNights[s] && (d + 1 >= D || A[s][d + 1] < 0)),
          (s) => nights[s] * 3 + works[s] * 0.1
        );
        for (const s of cand) {
          if (need[k] <= 0) break;
          take(s, k);
        }
      }
      // その他の勤務（勤務日数の少ない職員から）
      for (let k = 0; k < K; k++) {
        if (!p.isDemand[k] || p.night[k] !== NIGHT.NONE) continue;
        const cand = shuffleBy(
          free().filter((s) => !(prev(s) >= 0 && p.forbid[prev(s) * K + k])),
          (s) => works[s]
        );
        for (const s of cand) {
          if (need[k] <= 0) break;
          take(s, k);
        }
      }
      // まだ人数が足りない勤務があれば、空いている職員に入れる（違反は後で直す）
      for (let k = 0; k < K; k++) {
        if (!p.isDemand[k]) continue;
        for (const s of free()) {
          if (need[k] <= 0) break;
          take(s, k);
        }
      }
      for (const s of free()) A[s][d] = p.fillerIdx;
    }
    return A;
  }

  function solve(p, opts) {
    opts = opts || {};
    const timeLimit = Math.max(500, opts.timeLimitMs || 15000);
    const onProgress = opts.onProgress || function () {};
    const rand = makeRandom(opts.seed || Date.now());
    const { S, D } = p;
    const start = Date.now();

    let A = construct(p, rand);
    const free = p.locked.map((row) => Array.from(row, (x) => x < 0));
    // 1マスを書き換えるときの候補（有休だけの区分は自動では入れない）
    const changeable = [];
    for (let k = 0; k < p.K; k++) if (p.isDemand[k] || k === p.fillerIdx) changeable.push(k);

    const sc = new Float64Array(S);
    const dc = new Float64Array(D);
    const nights = new Int16Array(S);
    const offs = new Int16Array(S);
    let gc = 0; // 職員間の宿直回数の差の罰点
    let cur = 0;
    const recomputeAll = () => {
      cur = 0;
      for (let s = 0; s < S; s++) {
        cur += sc[s] = M.staffCost(p, A, s);
        nights[s] = M.nightCount(p, A, s);
        offs[s] = M.offCount(p, A, s);
      }
      for (let d = 0; d < D; d++) cur += dc[d] = M.dayCost(p, A, d);
      cur += gc = M.globalCost(p, nights, offs);
    };
    recomputeAll();

    let best = A.map((r) => Int16Array.from(r));
    let bestCost = cur;
    const ri = (n) => Math.floor(rand() * n);

    const cs = [], cd = [], cv = [], old = [];
    function attempt(n, T) {
      const ss = [], dd = [];
      for (let i = 0; i < n; i++) {
        if (ss.indexOf(cs[i]) < 0) ss.push(cs[i]);
        if (dd.indexOf(cd[i]) < 0) dd.push(cd[i]);
      }
      let before = gc;
      for (const s of ss) before += sc[s];
      for (const d of dd) before += dc[d];
      for (let i = 0; i < n; i++) {
        old[i] = A[cs[i]][cd[i]];
        A[cs[i]][cd[i]] = cv[i];
      }
      const nsc = ss.map((s) => M.staffCost(p, A, s));
      const ndc = dd.map((d) => M.dayCost(p, A, d));
      const oldN = ss.map((s) => nights[s]);
      const oldO = ss.map((s) => offs[s]);
      ss.forEach((s) => {
        nights[s] = M.nightCount(p, A, s);
        offs[s] = M.offCount(p, A, s);
      });
      const ngc = M.globalCost(p, nights, offs);
      let after = ngc;
      for (const x of nsc) after += x;
      for (const x of ndc) after += x;
      const delta = after - before;
      if (delta <= 0 || rand() < Math.exp(-delta / T)) {
        gc = ngc;
        ss.forEach((s, i) => (sc[s] = nsc[i]));
        dd.forEach((d, i) => (dc[d] = ndc[i]));
        cur += delta;
        return true;
      }
      ss.forEach((s, i) => {
        nights[s] = oldN[i];
        offs[s] = oldO[i];
      });
      for (let i = n - 1; i >= 0; i--) A[cs[i]][cd[i]] = old[i];
      return false;
    }

    function proposeAndTry(T) {
      let n = 0;
      const put = (s, d, v) => {
        cs[n] = s;
        cd[n] = d;
        cv[n] = v;
        n++;
      };
      // 2人の職員の、指定した日の勤務を入れ替える（その日の人数は変わらない）
      const swapDays = (a, b, days) => {
        for (const d of days) {
          if (d < 0 || d >= D) continue;
          if (!free[a][d] || !free[b][d]) return false;
          if (A[a][d] === A[b][d]) continue;
          put(a, d, A[b][d]);
          put(b, d, A[a][d]);
        }
        return true;
      };
      const r = rand();
      const a = ri(S);
      let b = ri(S - 1);
      if (b >= a) b++;
      if (S < 2) return;
      if (r < 0.5) {
        // 連続した1〜4日を入れ替える
        const L = 1 + ri(4);
        const d0 = ri(D);
        const days = [];
        for (let i = 0; i < L; i++) days.push(d0 + i);
        if (!swapDays(a, b, days)) return;
      } else if (r < 0.7) {
        // 離れた2日を同時に入れ替える（回数の偏りを保ったまま並びを変える）
        const d1 = ri(D), d2 = ri(D);
        if (d1 === d2 || !swapDays(a, b, [d1, d2])) return;
      } else if (r < 0.9) {
        // 宿直入り〜宿直明けのまとまりを、別の職員と入れ替える
        const d = ri(D);
        if (p.night[A[a][d]] !== NIGHT.IN) return;
        if (!swapDays(a, b, [d, d + 1])) return;
      } else if (r < 0.95) {
        // 1マスを書き換える（人数が崩れるので、主に最初の案の手直し用）
        const d = ri(D);
        if (!free[a][d]) return;
        const v = changeable[ri(changeable.length)];
        if (v === A[a][d]) return;
        put(a, d, v);
      } else {
        // その日の勤務を、使える体制（通常／休日の3人勤務）のどれかに合わせて組み替える
        const d = ri(D);
        const plans = p.plans[d];
        const pl = plans[ri(plans.length)];
        const cnt = new Int16Array(p.K);
        for (let s = 0; s < S; s++) cnt[A[s][d]]++;
        const order = Array.from({ length: S }, (_, s) => s).sort(() => rand() - 0.5);
        const surplus = [];
        for (const s of order) {
          const k = A[s][d];
          if (free[s][d] && p.isDemand[k] && cnt[k] > pl[k]) {
            surplus.push(s);
            cnt[k]--;
          }
        }
        const deficits = [];
        for (let k = 0; k < p.K; k++) if (p.isDemand[k]) for (let i = cnt[k]; i < pl[k]; i++) deficits.push(k);
        if (!surplus.length && !deficits.length) return;
        for (const k of deficits) {
          // 同じ宿直の種類（明け・入り・なし）の職員を優先し、いなければ休みの職員から
          let i = surplus.findIndex((s) => p.night[A[s][d]] === p.night[k]);
          let s;
          if (i >= 0) s = surplus.splice(i, 1)[0];
          else {
            const rest = order.filter((t) => free[t][d] && A[t][d] === p.fillerIdx && cs.slice(0, n).indexOf(t) < 0);
            if (rest.length) s = rest[0];
            else if (surplus.length) s = surplus.shift();
            else continue;
          }
          put(s, d, k);
        }
        for (const s of surplus) put(s, d, p.fillerIdx);
      }
      if (n > 0) attempt(n, T);
    }

    const CYCLE = 200000;
    const T0 = 200, T1 = 0.3;
    let iter = 0;
    let lastReport = start;
    let stale = 0;
    let timedOut = false;

    outer: while (bestCost > 0) {
      const cycleBest = bestCost;
      for (let i = 0; i < CYCLE; i++) {
        const T = T0 * Math.pow(T1 / T0, i / CYCLE);
        proposeAndTry(T);
        iter++;
        if (cur < bestCost - 1e-9) {
          bestCost = cur;
          best = A.map((r) => Int16Array.from(r));
          if (bestCost <= 0) break outer;
        }
        if ((iter & 2047) === 0) {
          const now = Date.now();
          if (now - start > timeLimit) {
            timedOut = true;
            break outer;
          }
          if (now - lastReport > 250) {
            lastReport = now;
            onProgress({ elapsedMs: now - start, bestCost, hardCount: Math.floor(bestCost / M.W.HARD) });
          }
        }
      }
      // 周回ごとに最良案から再開する
      A = best.map((r) => Int16Array.from(r));
      recomputeAll();
      stale = bestCost < cycleBest - 1e-9 ? 0 : stale + 1;
      // 必ず守る条件をすべて満たし、しばらく改善がなければ終了
      if (bestCost < M.W.HARD && stale >= 4) break;
    }

    const ev = M.evaluate(p, best);
    return {
      grid: best.map((r) => Array.from(r)),
      cost: ev.total,
      hardCount: ev.hardCount,
      iterations: iter,
      elapsedMs: Date.now() - start,
      timedOut: timedOut && ev.hardCount > 0,
    };
  }

  root.ShiftSolver = { solve, construct, makeRandom };
})(typeof self !== 'undefined' ? self : this);
