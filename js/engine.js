/* ============================================================
 * 事务隔离与死锁检测器 —— 模拟引擎
 * 锁模式: IS / S / IX / X / SIX
 * 协议: 严格两阶段锁(Strict 2PL) + 意向锁
 * ============================================================ */
(function (global) {
  'use strict';

  const ISO = { RU: 'RU', RC: 'RC', RR: 'RR', SER: 'SER' };
  const M = { IS: 'IS', S: 'S', IX: 'IX', SIX: 'SIX', X: 'X' };

  // 同一事务 已持有|新申请 => 合并锁模式
  const MERGE = {
    'IS|IS': 'IS', 'IS|S': 'S',  'IS|IX': 'IX', 'IS|SIX': 'SIX', 'IS|X': 'X',
    'S|IS': 'S',  'S|S': 'S',    'S|IX': 'SIX', 'S|SIX': 'SIX',  'S|X': 'X',
    'IX|IS': 'IX','IX|S': 'SIX', 'IX|IX': 'IX', 'IX|SIX': 'SIX', 'IX|X': 'X',
    'SIX|IS': 'SIX','SIX|S': 'SIX','SIX|IX': 'SIX','SIX|SIX': 'SIX','SIX|X': 'X',
    'X|IS': 'X',  'X|S': 'X',    'X|IX': 'X',   'X|SIX': 'X',    'X|X': 'X'
  };

  // 兼容性矩阵: 行=已持有, 列=新请求(不同事务)
  const COMPAT = {
    IS:  { IS: true,  S: true,  IX: true,  SIX: false, X: false },
    S:   { IS: true,  S: true,  IX: false, SIX: false, X: false },
    IX:  { IS: true,  S: false, IX: true,  SIX: false, X: false },
    SIX: { IS: false, S: false, IX: false, SIX: false, X: false },
    X:   { IS: false, S: false, IX: false, SIX: false, X: false }
  };

  const MODE_RANK = { IS: 1, S: 2, IX: 2, SIX: 3, X: 4 };
  const MODE_COLOR = { S: 'lm-S', X: 'lm-X', IS: 'lm-IS', IX: 'lm-IX', SIX: 'lm-SIX' };
  const TABLE = 'R';
  let engineSeq = 0;

  class Engine {
    constructor(opts) {
      opts = opts || {};
      this.id = ++engineSeq;
      this.prevention = opts.prevention || 'none';
      this.victimPolicy = opts.victimPolicy || 'youngest';
      this.items = {};
      this.txns = new Map();
      this.lockTable = {};
      this.lockTable[TABLE] = { holders: new Map(), queue: [] };
      this.steps = [];
      this.done = new Set();
      this.events = [];
      this.anomalies = [];
      this.anomalyKeys = new Set();
      this.seq = 0;
      this.finished = false;
    }

    nextSeq() { return ++this.seq; }
    log(type, message) { this.events.push({ seq: this.seq, type, message }); }

    flagAnomaly(kind, key, title, detail) {
      if (this.anomalyKeys.has(kind + ':' + key)) return;
      this.anomalyKeys.add(kind + ':' + key);
      this.anomalies.push({ kind, key, title, detail });
      this.log('anom', '⚠ [' + title + '] ' + detail);
    }

    setInitialItems(map) {
      this.items = {};
      Object.keys(map).forEach(k => {
        this.items[k] = { v: map[k], by: null, writeSeq: 0, commitSeq: 0, uncommitted: null };
      });
    }

    addTxn(id, iso) {
      if (!this.txns.has(id)) {
        this.txns.set(id, {
          id, iso: iso || ISO.RR, state: 'active',
          ts: 0,
          buffers: new Map(), inserted: new Set(),
          reads: new Map(), readSeq: new Map(), scans: [],
          locks: new Map(), waiting: null, abortReason: null
        });
      }
      return this.txns.get(id);
    }

    setIsolation(id, iso) {
      const t = this.txns.get(id);
      if (t && t.state === 'active' && !t.waiting) t.iso = iso;
    }

    setSteps(steps) { this.steps = steps; this.done = new Set(); }
    remainingSteps() { return this.steps.length - this.done.size; }

    // 第一个未执行且事务处于 active 的步骤下标; 没有可执行步骤时返回 -1
    nextRunnableIndex() {
      for (let i = 0; i < this.steps.length; i++) {
        if (this.done.has(i)) continue;
        const t = this.txns.get(this.steps[i].tid);
        if (t && t.state === 'active') return i;
      }
      return -1;
    }

    /* ---------- 锁管理 ---------- */
    resource(res) {
      if (!this.lockTable[res]) this.lockTable[res] = { holders: new Map(), queue: [] };
      return this.lockTable[res];
    }

    conflicts(res, mode, selfTid) {
      const r = this.lockTable[res];
      if (!r) return [];
      const list = [];
      r.holders.forEach((m, tid) => {
        if (tid !== selfTid && !COMPAT[m][mode]) list.push({ tid, mode: m });
      });
      return list;
    }

    aheadWaiters(res, selfTid) {
      const r = this.lockTable[res];
      if (!r) return [];
      const out = [];
      for (const w of r.queue) {
        if (w.tid === selfTid) break;
        out.push(w);
      }
      return out;
    }

    // 返回 granted | queued | aborted
    acquire(tid, res, mode, cont) {
      const t = this.txns.get(tid);
      if (t.state === 'aborted') return 'aborted';
      const r = this.resource(res);
      const blockedNow = () => this.conflicts(res, mode, tid).length > 0 ||
                              this.aheadWaiters(res, tid).length > 0;

      if (r.holders.has(tid)) {
        const held = r.holders.get(tid);
        if (held === mode || MODE_RANK[held] >= MODE_RANK[mode]) return 'granted';
        if (!blockedNow()) {
          const merged = MERGE[held + '|' + mode] || mode;
          r.holders.set(tid, merged);
          t.locks.set(res, merged);
          this.log('lock', tid + ' 升级 ' + res + ' 锁: ' + held + ' → ' + merged);
          return 'granted';
        }
      } else if (!blockedNow()) {
        r.holders.set(tid, mode);
        t.locks.set(res, mode);
        this.log('lock', tid + ' 获得 ' + res + ' 上的 ' + mode + ' 锁');
        return 'granted';
      }

      // 死锁预防
      if (this.prevention === 'wait-die' || this.prevention === 'wound-wait') {
        const blockers = this.conflicts(res, mode, tid).map(c => c.tid);
        let wounded = false;
        for (const btid of blockers) {
          const holder = this.txns.get(btid);
          if (!holder || holder.state === 'aborted' || holder.state === 'committed') continue;
          const iAmOlder = t.ts < holder.ts;
          if (this.prevention === 'wait-die') {
            if (!iAmOlder) {
              this.abort(tid, 'wait-die: 请求者年轻, 等待年老者 ' + btid + ' 会冒险, 主动 die');
              return 'aborted';
            }
          } else if (iAmOlder) {
            this.abort(btid, 'wound-wait: 被年长者 ' + tid + ' 抢占(wound)而中止');
            wounded = true;
          }
        }
        if (wounded && !blockedNow() && !r.holders.has(tid)) {
          r.holders.set(tid, mode);
          t.locks.set(res, mode);
          this.log('lock', tid + ' 抢占后获得 ' + res + ' 上的 ' + mode + ' 锁');
          return 'granted';
        }
      }

      if (!r.queue.some(w => w.tid === tid)) {
        r.queue.push({ tid, mode, cont });
        t.state = 'waiting';
        t.waiting = { resource: res, mode };
        this.log('lock', tid + ' 等待 ' + res + ' 的 ' + mode + ' 锁 (被 ' +
          this.conflicts(res, mode, tid).map(c => c.tid).join(',') + ' 阻塞)');
      }
      return 'queued';
    }

    pump(res) {
      const r = this.lockTable[res];
      if (!r) return;
      let guard = 0;
      while (r.queue.length && guard++ < 64) {
        const w = r.queue[0];
        const t = this.txns.get(w.tid);
        if (!t || t.state === 'aborted' || t.state === 'committed') { r.queue.shift(); continue; }
        if (this.conflicts(res, w.mode, w.tid).length > 0) break;

        r.queue.shift();
        let mode = w.mode;
        if (r.holders.has(w.tid)) mode = MERGE[r.holders.get(w.tid) + '|' + w.mode] || w.mode;
        r.holders.set(w.tid, mode);
        t.locks.set(res, mode);
        t.waiting = null;
        if (t.state === 'waiting') t.state = 'active';
        this.log('lock', w.tid + ' 获得等待中的 ' + res + ' 上的 ' + mode + ' 锁');
        w.cont('granted');
        if (t.state === 'aborted') break;
      }
    }

    releaseOne(tid, res) {
      const t = this.txns.get(tid);
      const r = this.lockTable[res];
      if (!r || !r.holders.has(tid)) return;
      const mode = r.holders.get(tid);
      r.holders.delete(tid);
      if (t) t.locks.delete(res);
      this.log('lock', tid + ' 释放 ' + res + ' 上的 ' + mode + ' 锁');
      this.pump(res);
    }

    releaseAll(tid, silent) {
      const t = this.txns.get(tid);
      if (!t) return;
      const resList = Array.from(t.locks.keys());
      t.locks.clear();
      resList.forEach(res => {
        const r = this.lockTable[res];
        if (r) r.holders.delete(tid);
      });
      // 清理该事务在所有资源(包括尚未获锁的资源)上的排队项
      const pumped = {};
      Object.keys(this.lockTable).forEach(res => {
        const r = this.lockTable[res];
        const before = r.queue.length;
        r.queue = r.queue.filter(w => w.tid !== tid);
        if (before !== r.queue.length || resList.indexOf(res) >= 0) pumped[res] = true;
      });
      if (!silent) this.log('lock', tid + ' 释放全部 ' + resList.length + ' 个锁');
      Object.keys(pumped).forEach(res => this.pump(res));
    }

    /* ---------- 读取效果与异常 ---------- */
    doReadEffect(t, key) {
      if (!this.items[key]) {
        this.log('info', t.id + ' 读取 ' + key + ': 不存在');
        return { missing: true };
      }
      // RU: 可见他人未提交缓冲区, 形成脏读
      let shown = this.items[key].v, dirty = false, dirtyBy = null;
      if (t.iso === ISO.RU) {
        for (const [oid, ot] of this.txns) {
          if (oid !== t.id && ot.state === 'active' && ot.buffers.has(key)) {
            shown = ot.buffers.get(key); dirty = true; dirtyBy = oid;
          }
        }
      } else if (t.buffers.has(key)) {
        shown = t.buffers.get(key);
      }
      if (t.reads.has(key) && t.reads.get(key) !== shown) {
        this.flagAnomaly('nrr', t.id + ':' + key, '不可重复读',
          t.id + '(' + t.iso + ') 两次读 ' + key + ': ' + t.reads.get(key) + ' → ' + shown);
      }
      t.reads.set(key, shown);
      t.readSeq.set(key, this.nextSeq());
      this.log('info', t.id + ' 读取 ' + key + ' = ' + shown +
        (dirty ? '  (脏读! 来自 ' + dirtyBy + ' 的未提交写)' : ''));
      if (dirty) {
        this.flagAnomaly('dirty', t.id + ':' + key + ':' + t.readSeq.get(key), '脏读',
          t.id + '(RU) 读到 ' + dirtyBy + ' 尚未提交的 ' + key + '=' + shown);
      }
      return { value: shown, dirty, dirtyBy };
    }

    doScanEffect(t) {
      const keys = Object.keys(this.items);
      t.scans.push({ seq: this.nextSeq(), keys: keys.slice() });
      if (t.scans.length > 1) {
        const prev = t.scans[t.scans.length - 2];
        const gained = keys.filter(k => prev.keys.indexOf(k) < 0);
        if (gained.length) {
          this.flagAnomaly('phantom', t.id + ':' + prev.seq, '幻读',
            t.id + '(' + t.iso + ') 两次 scan 结果集变化, 新增: ' + gained.join(', '));
        }
      }
      this.log('info', t.id + ' scan -> {' + keys.join(', ') + '}');
      return { keys };
    }

    /* ---------- 操作 ---------- */
    lockChain(tid, list, idx, effect) {
      const t = this.txns.get(tid);
      if (!t || t.state === 'aborted') return;
      if (idx >= list.length) { effect(); return; }
      const pair = list[idx];
      const self = this;
      const st = this.acquire(tid, pair[0], pair[1], function () {
        self.lockChain(tid, list, idx + 1, effect);
      });
      if (st === 'granted') this.lockChain(tid, list, idx + 1, effect);
    }

    opRead(tid, key) {
      const t = this.txns.get(tid);
      if (t.iso === ISO.RU) { this.doReadEffect(t, key); return 'ok'; }
      const self = this;
      this.lockChain(tid, [[key, M.S]], 0, function () {
        self.doReadEffect(t, key);
        if (t.iso === ISO.RC) self.releaseOne(tid, key);
      });
      return t.state === 'waiting' ? 'suspended' : 'ok';
    }

    opWrite(tid, key, val) {
      const t = this.txns.get(tid);
      if (!this.items[key] && !t.inserted.has(key)) return { error: '数据项 ' + key + ' 不存在, 请用 insert' };
      const self = this;
      this.lockChain(tid, [[TABLE, M.IX], [key, M.X]], 0, function () {
        const it = self.items[key];
        if (it && (t.iso === ISO.RU || t.iso === ISO.RC) &&
            t.reads.has(key) && it.commitSeq > t.readSeq.get(key) && it.by !== tid) {
          self.flagAnomaly('lost-update', tid + ':' + key + ':' + it.commitSeq, '丢失更新',
            tid + ' 曾读到 ' + key + '=' + t.reads.get(key) + ', 已被 ' + it.by +
            ' 提交改为 ' + it.v + '; ' + tid + ' 仍写入 ' + val + ', 覆盖了该更新');
        }
        t.buffers.set(key, val);
        self.log('info', tid + ' 写入 ' + key + ' = ' + val + ' (未提交, 持 X 锁)');
      });
      return t.state === 'waiting' ? 'suspended' : 'ok';
    }

    opInsert(tid, key, val) {
      const t = this.txns.get(tid);
      if (this.items[key] || t.inserted.has(key)) return { error: '数据项 ' + key + ' 已存在' };
      const self = this;
      this.lockChain(tid, [[TABLE, M.IX], [key, M.X]], 0, function () {
        t.inserted.add(key);
        t.buffers.set(key, val);
        self.items[key] = { v: val, by: null, writeSeq: self.nextSeq(), commitSeq: 0, uncommitted: tid };
        self.log('info', tid + ' 插入新项 ' + key + ' = ' + val + ' (未提交)');
      });
      return t.state === 'waiting' ? 'suspended' : 'ok';
    }

    opScan(tid) {
      const t = this.txns.get(tid);
      if (t.iso === ISO.RU) { this.doScanEffect(t); return 'ok'; }
      const self = this;
      const tableMode = t.iso === ISO.SER ? M.S : M.IS;
      this.lockChain(tid, [[TABLE, tableMode]], 0, function () {
        self.doScanEffect(t);
        if (t.iso === ISO.RC) self.releaseOne(tid, TABLE);
      });
      return t.state === 'waiting' ? 'suspended' : 'ok';
    }

    opCommit(tid) {
      const t = this.txns.get(tid);
      const commitSeq = this.nextSeq();
      t.buffers.forEach((val, key) => {
        if (t.inserted.has(key)) {
          this.items[key] = { v: val, by: tid, writeSeq: commitSeq, commitSeq, uncommitted: null };
        } else {
          const it = this.items[key];
          it.v = val; it.by = tid; it.commitSeq = commitSeq; it.uncommitted = null;
        }
      });
      const count = t.buffers.size;
      t.buffers.clear(); t.inserted.clear();
      t.state = 'committed'; t.waiting = null;
      this.log('ok', '✔ ' + tid + ' COMMIT' + (count ? ' (提交 ' + count + ' 个写入)' : ''));
      this.releaseAll(tid, true);
      return 'ok';
    }

    opRollback(tid) {
      const t = this.txns.get(tid);
      t.inserted.forEach(key => { delete this.items[key]; });
      const count = t.buffers.size;
      t.buffers.clear(); t.inserted.clear();
      t.state = 'aborted'; t.abortReason = '用户回滚'; t.waiting = null;
      this.log('ok', '↩ ' + tid + ' ROLLBACK' + (count ? ' (撤销 ' + count + ' 个未提交写入)' : ''));
      this.releaseAll(tid, true);
      return 'ok';
    }

    abort(tid, reason) {
      const t = this.txns.get(tid);
      if (!t || t.state === 'aborted' || t.state === 'committed') return;
      t.inserted.forEach(key => { delete this.items[key]; });
      const writes = t.buffers.size;
      t.buffers.clear(); t.inserted.clear();
      t.state = 'aborted'; t.abortReason = reason; t.waiting = null;
      const isCycle = /死锁牺牲者/.test(reason);
      this.flagAnomaly(isCycle ? 'deadlock' : 'prevent',
        'abort:' + tid + ':' + (this.seq + 1) + ':' + reason,
        isCycle ? '死锁恢复: 牺牲者中止' : '死锁预防: 事务中止',
        tid + ' 被中止: ' + reason + (writes ? ' (回滚 ' + writes + ' 个未提交写入)' : ''));
      this.log('dead', '✖ ' + tid + ' ABORT — ' + reason);
      this.releaseAll(tid, true);
    }

    /* ---------- 锁等待图与死锁 ---------- */
    buildWfg() {
      const edges = [];
      const seen = new Set();
      const addEdge = (from, to, res, mode) => {
        const k = from + '>' + to + '>' + res;
        if (seen.has(k)) return;
        seen.add(k);
        edges.push({ from, to, res, mode });
      };

      Object.keys(this.lockTable).forEach(res => {
        const r = this.lockTable[res];
        r.queue.forEach(w => {
          const blockers = this.conflicts(res, w.mode, w.tid).map(c => c.tid);
          if (blockers.length) blockers.forEach(b => addEdge(w.tid, b, res, w.mode));
          else {
            const ahead = this.aheadWaiters(res, w.tid);
            if (ahead.length) addEdge(w.tid, ahead[ahead.length - 1].tid, res, w.mode);
          }
        });
      });
      return { edges, cycle: this.findCycle(edges) };
    }

    findCycle(edges) {
      const adj = {};
      const nodes = new Set();
      edges.forEach(e => {
        (adj[e.from] = adj[e.from] || []).push(e.to);
        nodes.add(e.from); nodes.add(e.to);
      });
      const cycles = [];
      const color = {};
      const stack = [];
      nodes.forEach(n => color[n] = 0);
      const dfs = u => {
        color[u] = 1; stack.push(u);
        (adj[u] || []).forEach(v => {
          if (color[v] === 1) {
            const i = stack.indexOf(v);
            if (i >= 0) cycles.push(stack.slice(i).concat(v));
          } else if (color[v] === 0) dfs(v);
        });
        stack.pop(); color[u] = 2;
      };
      nodes.forEach(n => { if (color[n] === 0) dfs(n); });
      if (!cycles.length) return null;

      let newest = null;
      nodes.forEach(n => {
        const t = this.txns.get(n);
        if (t && t.waiting && (!newest || t.ts > newest.ts)) newest = t;
      });
      let chosen = cycles[0];
      if (newest) {
        const hit = cycles.find(c => c.indexOf(newest.id) >= 0);
        if (hit) chosen = hit;
      }
      if (chosen.length > 1 && chosen[0] === chosen[chosen.length - 1]) chosen = chosen.slice(0, -1);
      return chosen;
    }

    chooseVictim(cycle) {
      const ts = cycle.map(id => this.txns.get(id)).filter(Boolean);
      if (this.victimPolicy === 'oldest') return ts.reduce((a, b) => (b.ts < a.ts ? b : a)).id;
      if (this.victimPolicy === 'fewest') return ts.reduce((a, b) => (b.locks.size < a.locks.size ? b : a)).id;
      return ts.reduce((a, b) => (b.ts > a.ts ? b : a)).id;
    }

    detectDeadlock() {
      const wfg = this.buildWfg();
      if (!wfg.cycle) return wfg;
      const cycle = wfg.cycle;
      const sig = 'cycle:' + cycle.slice().sort().join('=');
      if (this._resolvedCycles && this._resolvedCycles.has(sig)) return wfg;
      (this._resolvedCycles = this._resolvedCycles || new Set()).add(sig);
      this.flagAnomaly('deadlock', 'cycle:' + cycle.slice().sort().join('='), '检测到死锁',
        '等待环: ' + cycle.join(' → ') + ' → ' + cycle[0]);
      this.log('dead', '☠ 死锁! 循环等待: ' + cycle.join(' → ') + ' → ' + cycle[0]);
      const victim = this.chooseVictim(cycle);
      this.abort(victim, '被选为死锁牺牲者(策略: ' + this.victimPolicy + ')');
      return this.buildWfg();
    }

    /* ---------- 调度执行 ---------- */
    runOp(tid, op) {
      const t = this.txns.get(tid);
      if (!t) return { error: '未知事务 ' + tid };
      if (t.state === 'committed') return { error: tid + ' 已提交' };
      if (t.state === 'aborted') return { skipped: true };
      switch (op.type) {
        case 'read': {
          const r = this.opRead(tid, op.key);
          return typeof r === 'object' && r.error ? r : { status: r };
        }
        case 'write': return { status: this.opWrite(tid, op.key, op.value) };
        case 'insert': return { status: this.opInsert(tid, op.key, op.value) };
        case 'scan': return { status: this.opScan(tid) };
        case 'commit': return { status: this.opCommit(tid) };
        case 'rollback': return { status: this.opRollback(tid) };
        default: return { error: '未知操作 ' + op.type };
      }
    }

    stepState(step, index) {
      const t = this.txns.get(step.tid);
      if (!t) return 'pending';
      if (this.done.has(index)) return 'done';
      if (t.state === 'aborted' || t.state === 'committed') return 'skipped';
      if (index === this.nextRunnableIndex()) return 'current';
      return 'pending';
    }

    runNextStep() {
      // 跳过等待中的事务, 在后续步骤里寻找仍可执行的事务(例如持锁方 commit);
      // commit/rollback 触发 releaseAll -> pump 后, 等待事务会重新回到 active,
      // 下一次调用自然能执行它之前被跳过的步骤。
      for (let i = 0; i < this.steps.length; i++) {
        if (this.done.has(i)) continue;
        const step = this.steps[i];
        const t = this.txns.get(step.tid);
        if (t && t.ts === 0) t.ts = this.nextSeq(); // 首次执行即“开始”, 决定年龄
        if (!t || t.state === 'aborted' || t.state === 'committed') { this.done.add(i); continue; }
        if (t.state === 'waiting') {
          continue; // 暂时阻塞: 保留该步骤, 先推进其他事务
        }
        this.done.add(i);
        const res = this.runOp(step.tid, step.op);
        if (res && res.error) this.log('info', '✗ 跳过: ' + step.text + ' (' + res.error + ')');
        const wfg = this.detectDeadlock();
        const waiting = Array.from(this.txns.values()).some(x => x.state === 'waiting');
        if (this.remainingSteps() === 0 && !waiting) this.finished = true;
        return { status: 'ran', step, wfg };
      }
      const waiters = Array.from(this.txns.values()).filter(x => x.state === 'waiting');
      this.finished = waiters.length === 0;
      return { status: this.finished ? 'done' : 'blocked', waiters };
    }
  }

  /* ---------- 调度脚本解析 ---------- */
  function coerce(s) {
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    return String(s).replace(/^["']|["']$/g, '');
  }

  function parseSchedule(text) {
    const errors = [];
    const steps = [];
    String(text || '').split(/\r?\n/).forEach((raw, i) => {
      const lineNo = i + 1;
      const line = raw.replace(/--.*$|#.*$|\/\/.*$/, '').trim();
      if (!line) return;
      const m = line.match(/^([A-Za-z]\w*)\s*[:：.\-]?\s*(.+)$/);
      if (!m || !/^(read|write|r|w|commit|rollback|abort|scan|insert)\b/i.test(m[2])) {
        errors.push({ line: lineNo, text: raw, msg: "无法解析, 格式如 T1 r(x)" });
        return;
      }
      const tid = m[1].toUpperCase();
      const body = m[2].trim();
      const cmdM = body.match(/^([A-Za-z]+)\s*(?:\((.*)\))?\s*$/);
      if (!cmdM) { errors.push({ line: lineNo, text: raw, msg: '操作格式错误' }); return; }
      const cmd = cmdM[1].toLowerCase();
      const args = (cmdM[2] || '').split(',').map(s => s.trim()).filter(Boolean);
      let op;
      if (cmd === 'r' || cmd === 'read') {
        if (!args[0]) { errors.push({ line: lineNo, text: raw, msg: 'read 需要数据项' }); return; }
        op = { type: 'read', key: args[0] };
      } else if (cmd === 'w' || cmd === 'write') {
        if (args.length < 2) { errors.push({ line: lineNo, text: raw, msg: 'write 需要 (项, 值)' }); return; }
        op = { type: 'write', key: args[0], value: coerce(args[1]) };
      } else if (cmd === 'insert') {
        if (args.length < 2) { errors.push({ line: lineNo, text: raw, msg: 'insert 需要 (项, 值)' }); return; }
        op = { type: 'insert', key: args[0], value: coerce(args[1]) };
      } else if (cmd === 'scan') op = { type: 'scan' };
      else if (cmd === 'commit') op = { type: 'commit' };
      else if (cmd === 'rollback' || cmd === 'abort') op = { type: 'rollback' };
      else { errors.push({ line: lineNo, text: raw, msg: '未知操作 ' + cmdM[1] }); return; }
      steps.push({ tid, op, text: tid + ' ' + body, line: lineNo });
    });
    return { steps, errors };
  }

  const api = { Engine, ISO, M, MODE_COLOR, MODE_RANK, COMPAT, TABLE, parseSchedule };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.DBDemo = api;
})(typeof window !== 'undefined' ? window : globalThis);
