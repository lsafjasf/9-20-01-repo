#!/usr/bin/env node
/* ============================================================
 * 死锁处理策略对比脚本（可复跑）
 * 用法：
 *   node compare.js                      运行内置两组场景 × 三种策略
 *   node compare.js --timeout 4          指定 timeout 策略的超时阈值（步）
 *   node compare.js --schedule "T1:W(A,1) ..."   对自定义调度文本跑对比
 * 输出指标：总等待时长 / 回滚次数 / 牺牲者分布 / 是否饥饿
 * 说明：被策略中止的事务自动重启（保留原时间戳），与页面“策略对比面板”
 *       使用同一套引擎代码（engine.js 的 DB.comparePolicies），结果可互相复核。
 * ============================================================ */
'use strict';
const DB = require('./engine.js');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const timeoutSteps = parseInt(argValue('--timeout') || '3', 10) || 3;
const customSchedule = argValue('--schedule');

// ---------- 内置场景 ----------
const SCENARIOS = [
  {
    name: '场景 1：两事务循环等待（内置死锁示例）',
    setup: DB.EXAMPLES.deadlock.setup,
    text: DB.EXAMPLES.deadlock.text
  },
  {
    name: '场景 2：三事务两数据项竞争',
    setup: {
      items: [{ name: 'A', value: '1' }, { name: 'B', value: '2' }],
      txns: [{ id: 'T1', iso: 'RR' }, { id: 'T2', iso: 'RR' }, { id: 'T3', iso: 'RR' }],
      defaultIso: 'RR'
    },
    text: 'T1:W(A,10) T2:W(B,20) T3:R(A) T1:W(B,11) T2:W(A,21) T3:W(B,30) T1:C T2:C T3:C'
  }
];

if (customSchedule) {
  SCENARIOS.length = 0;
  SCENARIOS.push({
    name: '自定义调度',
    setup: {
      items: [{ name: 'A', value: '1' }, { name: 'B', value: '2' }, { name: 'C', value: '3' }],
      txns: [],
      defaultIso: 'RR'
    },
    text: customSchedule
  });
}

function fmtDist(obj) {
  const keys = Object.keys(obj);
  if (!keys.length) return '无';
  return keys.map(function (k) { return k + '×' + obj[k]; }).join('，');
}

function pad(s, w) {
  s = String(s);
  let len = 0;
  for (const ch of s) len += ch.charCodeAt(0) > 255 ? 2 : 1;
  return s + ' '.repeat(Math.max(0, w - len));
}

function printTable(results) {
  const cols = results.map(function (r) { return r.policy; });
  const rows = [
    ['总等待时长(事务·步)', function (r) { return r.totalWait; }],
    ['回滚次数', function (r) { return r.rollbacks; }],
    ['牺牲者分布', function (r) { return fmtDist(r.victims); }],
    ['重启次数分布', function (r) { return fmtDist(r.restarts); }],
    ['是否出现饥饿', function (r) { return r.starvation.detected ? '是（' + r.starvation.reason + '）' : '否'; }],
    ['调度是否完成', function (r) { return r.finished ? '是' : '否'; }],
    ['总步数', function (r) { return r.steps; }]
  ];
  const W = 26;
  console.log('  ' + pad('指标 \\ 策略', W) + cols.map(function (c) { return pad(c, W); }).join(''));
  console.log('  ' + '-'.repeat(W * (cols.length + 1)));
  rows.forEach(function (row) {
    console.log('  ' + pad(row[0], W) + results.map(function (r) { return pad(row[1](r), W); }).join(''));
  });
}

SCENARIOS.forEach(function (sc) {
  const parsed = DB.parseSchedule(sc.text, sc.setup.defaultIso);
  const results = DB.comparePolicies(sc.setup, parsed.ops, { timeoutSteps: timeoutSteps });
  console.log('\n=== ' + sc.name + ' ===');
  console.log('调度: ' + sc.text);
  console.log('timeout 阈值: ' + timeoutSteps + ' 步\n');
  printTable(results);
});
console.log('');
