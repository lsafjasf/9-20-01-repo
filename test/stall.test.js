/* 复现用例: T2 等待 T1 已持有的锁 -> T1 提交释放 -> T2 应重新进入可执行集合并继续 */
'use strict';
const assert = require('assert');
const { Engine, parseSchedule } = require('../js/engine.js');

function build(text, iso) {
  const engine = new Engine({});
  engine.setInitialItems({ x: 10, y: 0 });
  const parsed = parseSchedule(text);
  assert.strictEqual(parsed.errors.length, 0, '调度脚本应无解析错误: ' + JSON.stringify(parsed.errors));
  [...new Set(parsed.steps.map(s => s.tid))].forEach(id => engine.addTxn(id, iso || 'RR'));
  engine.setSteps(parsed.steps);
  return engine;
}

function runAll(engine, limit) {
  const seen = [];
  let r;
  while ((r = engine.runNextStep()).status === 'ran') {
    seen.push(r.step.text);
    assert.ok(seen.length < (limit || 50), '调度空转: 步骤数异常');
  }
  return { last: r, seen };
}

// 关键复现: T2 阻塞后, 光标停在 T2 的下一步, 但 T1 的 commit 仍在后面可执行
const SCHEDULE = [
  'T1 w(x, 1)',
  'T2 r(x)',   // T2 等待 T1 持有的 X 锁
  'T2 commit', // 阻塞中的 T2 不应挡住后面可执行的 T1
  'T1 commit', // T1 提交 -> 释放锁 -> T2 获锁并继续
].join('\n');

// 用例 1: 单步执行 —— 等待 -> 提交 -> 应继续
(function testStepByStep() {
  const engine = build(SCHEDULE);
  const { last, seen } = runAll(engine);
  assert.strictEqual(last.status, 'done', '应执行完毕, 实际: ' + last.status);
  assert.deepStrictEqual(seen, ['T1 w(x, 1)', 'T2 r(x)', 'T1 commit', 'T2 commit']);
  assert.strictEqual(engine.txns.get('T2').state, 'committed', 'T2 应已提交');
  assert.ok(engine.events.some(e => e.message.includes('T2 获得等待中的 x 上的 S 锁')),
    '日志应包含 T2 解锁后获锁');
  assert.ok(engine.events.some(e => e.message.includes('T2 读取 x = 1')),
    '日志应包含 T2 解锁后的读取');
  console.log('PASS 用例1 单步: 等待 -> 提交 -> 继续推进');
})();

// 用例 2: 连续执行(自动模式同款循环) —— 不应中途 blocked
(function testContinuous() {
  const engine = build(SCHEDULE);
  const { last } = runAll(engine);
  assert.strictEqual(last.status, 'done', '连续执行应跑到 done, 实际: ' + last.status);
  assert.ok(engine.finished, 'engine.finished 应为 true');
  assert.strictEqual(engine.items.x.v, 1, 'x 应为 T1 提交的值');
  console.log('PASS 用例2 连续: 一路推进到 done, 无空转');
})();

// 用例 3: 顺序无需跳过时不应改变原有行为
(function testInOrder() {
  const engine = build(['T1 w(x, 1)', 'T2 r(x)', 'T1 commit', 'T2 commit'].join('\n'));
  const { last, seen } = runAll(engine);
  assert.strictEqual(last.status, 'done');
  assert.deepStrictEqual(seen, ['T1 w(x, 1)', 'T2 r(x)', 'T1 commit', 'T2 commit']);
  console.log('PASS 用例3 顺序执行: 行为不变');
})();

// 用例 4: 真正停滞(持锁方没有任何后续操作)时, 仍应如实返回 blocked
(function testGenuineStall() {
  const engine = build(['T1 w(x, 1)', 'T2 r(x)'].join('\n'));
  const { last } = runAll(engine);
  assert.strictEqual(last.status, 'blocked', '持锁方无后续操作时应停滞');
  assert.ok(!engine.finished);
  assert.ok(last.waiters && last.waiters.some(t => t.id === 'T2'), 'blocked 应携带等待者信息');
  console.log('PASS 用例4 真实停滞: blocked 与真实状态一致');
})();

console.log('\n全部用例通过');
