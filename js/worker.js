/* worker.js — 画面が固まらないよう、自動作成を別スレッドで実行する */
importScripts('model.js', 'solver.js');

self.onmessage = function (e) {
  const { problem, timeLimitMs, seed } = e.data;
  const result = self.ShiftSolver.solve(problem, {
    timeLimitMs,
    seed,
    onProgress: (info) => self.postMessage(Object.assign({ type: 'progress' }, info)),
  });
  self.postMessage(Object.assign({ type: 'done' }, result));
};
