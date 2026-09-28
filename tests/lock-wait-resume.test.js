/* 复现: T2 请求 T1 已持有的锁进入等待, T1 提交解锁后,
 * 调度必须推进 T2 继续执行, 而不是空转并误报“所有可执行事务都在等待锁”。
 * 运行: node tests/lock-wait-resume.test.js
 */
const assert = require('assert');
const path = require('path');
const { Engine, ISO, parseSchedule } = require(path.join(__dirname, '..', 'js', 'engine.js'));

function build(text, items, iso) {
  const parsed = parseSchedule(text);
  assert.deepStrictEqual(parsed.errors, []);
  const e = new Engine();
  e.setInitialItems(items);
  const tids = [];
  parsed.steps.forEach(s => { if (!tids.includes(s.tid)) tids.push(s.tid); });
  tids.forEach(id => e.addTxn(id, iso[id] || ISO.RR));
  e.setSteps(parsed.steps);
  return e;
}

function runAll(e) {
  const trace = [];
  for (let i = 0; i < 100; i++) {
    const r = e.runNextStep();
    trace.push(r.status);
    if (r.status === 'blocked' || r.status === 'done') return trace;
  }
  throw new Error('超过 100 步仍未结束, 疑似空转: ' + trace.join(','));
}

// ── 用例 1: 等待 → 持有者提交 → 等待者必须继续并自己提交 ──
// 关键: T1 的 commit 排在 T2 等待步骤“之后”, 单游标会卡死。
const schedule1 = `
T1 w(x, 1)
T2 r(x)
T1 commit
T2 commit
`;

const e1 = build(schedule1, { x: 10 }, { T1: 'RR', T2: 'RR' });
const trace1 = runAll(e1);
assert.strictEqual(e1.txns.get('T1').state, 'committed', 'T1 应已提交');
assert.strictEqual(e1.txns.get('T2').state, 'committed', 'T2 解锁后必须继续并提交');
assert.strictEqual(trace1[trace1.length - 1], 'done', '调度应正常结束, 而不是 blocked');
assert.strictEqual(e1.remainingSteps(), 0);
assert.ok(!e1.events.some(ev => /所有可执行事务都在等待锁/.test(ev.message)),
  '不应误报“所有可执行事务都在等待锁”');

// ── 用例 2: 单步推进同样必须恢复 ──
const e2 = build(schedule1, { x: 10 }, { T1: 'RR', T2: 'RR' });
let r;
r = e2.runNextStep(); assert.strictEqual(r.status, 'ran'); // T1 w(x)
r = e2.runNextStep(); assert.strictEqual(r.status, 'ran'); // T2 r(x) 排队
assert.strictEqual(e2.txns.get('T2').state, 'waiting');
r = e2.runNextStep(); assert.strictEqual(r.status, 'ran'); // T1 commit → 解锁并唤醒 T2
assert.strictEqual(e2.txns.get('T2').state, 'active', '解锁后 T2 应立即恢复 active');
assert.strictEqual(e2.txns.get('T2').waiting, null);
assert.ok(e2.lockTable.x.holders.has('T2'), 'T2 应已拿到 x 的 S 锁');
assert.strictEqual(e2.txns.get('T2').reads.get('x'), 1, 'T2 应读到 T1 提交后的新值 1');
r = e2.runNextStep(); assert.strictEqual(r.status, 'done'); // T2 commit 随后结束
assert.strictEqual(e2.txns.get('T2').state, 'committed');

// ── 用例 3: 等待者排在持有者提交之前 (交叉更密), 也必须推进 ──
const schedule3 = `
T1 w(x, 1)
T2 r(x)
T2 commit
T1 commit
`;
const e3 = build(schedule3, { x: 10 }, { T1: 'RR', T2: 'RR' });
runAll(e3);
assert.strictEqual(e3.txns.get('T1').state, 'committed');
assert.strictEqual(e3.txns.get('T2').state, 'committed');

// ── 用例 4: 真死锁时仍应报告 blocked (不能把死锁也推进没了) ──
const schedule4 = `
T1 w(x, 1)
T2 w(y, 2)
T1 w(y, 3)
T2 w(x, 4)
T1 commit
T2 commit
`;
const e4 = build(schedule4, { x: 0, y: 0 }, { T1: 'RR', T2: 'RR' });
const trace4 = runAll(e4);
assert.ok(e4.anomalies.some(a => a.kind === 'deadlock'), '死锁必须被检出');
assert.ok(trace4.includes('blocked'), '死锁牺牲者之外的事务仍卡死时应返回 blocked');

console.log('全部通过 ✓ (4 个用例)');
console.log('用例1 推进轨迹:', trace1.join(' → '));
