/* ============================================================
 * 事务隔离与死锁检测器 —— 纯逻辑仿真引擎（无第三方依赖）
 * 锁模型：S / X / IS / IX / SIX，多粒度（数据库 -> 表 -> 数据项）
 * 2PL：锁在 commit / rollback 时统一释放（严格两阶段锁协议）
 * ============================================================ */
(function (global) {
  'use strict';

  const ISO = { RU: 'RU', RC: 'RC', RR: 'RR', SER: 'SER' };
  const ISO_LABEL = {
    RU: 'Read Uncommitted',
    RC: 'Read Committed',
    RR: 'Repeatable Read',
    SER: 'Serializable'
  };

  // 多粒度锁兼容矩阵：granted[mode] 列出与之冲突的模式
  const CONFLICTS = {
    IS: [],
    IX: ['S', 'SIX', 'X'],
    S: ['IX', 'SIX', 'X'],
    SIX: ['IX', 'S', 'SIX', 'X'],
    X: ['IS', 'IX', 'S', 'SIX', 'X']
  };
  const RANK = { IS: 1, IX: 2, S: 3, SIX: 4, X: 5 };

  function unionMode(a, b) {
    if (!a) return b;
    if (a === b) return a;
    const pair = [a, b].sort((x, y) => RANK[x] - RANK[y]).join('+');
    const table = {
      'IS+IX': 'IX', 'IS+S': 'S', 'IS+SIX': 'SIX', 'IS+X': 'X',
      'IX+S': 'SIX', 'IX+SIX': 'X', 'IX+X': 'X',
      'S+SIX': 'SIX', 'S+X': 'X', 'SIX+X': 'X'
    };
    return table[pair] || b;
  }

  function pathsFor(itemName) {
    return {
      write: ['DB', 'T', 'I:' + itemName],
      read: ['DB', 'T', 'I:' + itemName],
      scan: ['DB', 'T']
    };
  }

  function resourceLabel(res) {
    if (res === 'DB') return { name: '数据库 DB', kind: 'db', level: 0 };
    if (res === 'T') return { name: '表 T（含全部数据项）', kind: 'table', level: 1 };
    return { name: '数据项 ' + res.slice(2), kind: 'item', level: 2 };
  }

  function createScheduler(setup) {
    setup = setup || {};
    const state = {
      items: {},
      txns: {},
      txnOrder: [],
      lockTable: {},
      log: [],
      anomalies: { lostUpdate: [], dirtyRead: [], unrepeatable: [], phantom: [], deadlock: [] },
      policy: setup.policy || 'none',
      autoResolve: setup.autoResolve !== false,
      timeoutSteps: setup.timeoutSteps || 3,
      stepNo: 0,
      seqCounter: 1,
      readyQueue: [],
      execCount: {},   // 每事务已执行操作数（统计用，不影响调度逻辑）
      aborts: []       // 中止事件流水 {tid, reason, step}（统计用）
    };

    (setup.items || []).forEach(function (it) {
      state.items[it.name] = {
        name: it.name, value: String(it.value), committedValue: String(it.value),
        draft: null, deleted: false, version: 1
      };
    });
    (setup.txns || []).forEach(function (t) { addTxn(t.id, t.iso); });

    function addTxn(id, iso) {
      state.txnOrder.push(id);
      state.txns[id] = {
        id: id, iso: ISO[iso] ? iso : 'RC', status: 'active',
        ts: state.seqCounter++, locks: {}, waitsOn: [], blockedSeq: null,
        waitStart: null,
        pending: null, reads: {}, readValue: {}, scans: []
      };
      return state.txns[id];
    }

    function log(type, text, tag, ids) {
      state.log.push({ step: state.stepNo, type: type, text: text, tag: tag || '', ids: ids || [] });
    }

    function markAnomaly(kind, text, ids) {
      if (!state.anomalies[kind].some(function (a) { return a.text === text; })) {
        state.anomalies[kind].push({ step: state.stepNo, kind: kind, text: text, ids: ids || [] });
      }
      log('anomaly', text, kind, ids);
    }
    // ---------- 锁表工具 ----------
    function entryOf(res, create) {
      let e = state.lockTable[res];
      if (!e && create) { e = { granted: [], queue: [] }; state.lockTable[res] = e; }
      return e;
    }

    function txnMode(res, tid) {
      const t = state.txns[tid];
      return t && t.locks[res] ? t.locks[res] : null;
    }

    function conflictingHolders(res, mode, tid) {
      const e = entryOf(res);
      if (!e) return [];
      return e.granted.filter(function (g) {
        return g.tid !== tid && CONFLICTS[mode].indexOf(g.mode) >= 0;
      });
    }

    function grant(res, tid, mode) {
      const t = state.txns[tid];
      const e = entryOf(res, true);
      const old = t.locks[res];
      t.locks[res] = old ? unionMode(old, mode) : mode;
      if (old) {
        const g = e.granted.find(function (x) { return x.tid === tid; });
        g.mode = t.locks[res];
      } else {
        e.granted.push({ tid: tid, mode: t.locks[res] });
      }
    }

    function enqueueWait(res, tid, mode) {
      const e = entryOf(res, true);
      if (!e.queue.some(function (w) { return w.tid === tid; })) e.queue.push({ tid: tid, mode: mode });
      const t = state.txns[tid];
      if (t.waitsOn.indexOf(res) < 0) t.waitsOn.push(res);
      if (t.blockedSeq == null) t.blockedSeq = state.seqCounter++;
      if (t.waitStart == null) t.waitStart = state.stepNo; // 记录开始等待的步号（timeout 策略用）
    }

    // 死锁预防：返回 true 表示请求者应当被中止
    function policyAbort(tid, holders) {
      if (state.policy === 'wait-die') {
        const older = holders.some(function (h) { return state.txns[h.tid].ts < state.txns[tid].ts; });
        if (older) return true; // 遇到更老 -> 自己 die（中止）；更年轻 -> 等待
        return false;
      }
      if (state.policy === 'wound-wait') {
        holders.forEach(function (h) {
          const holder = state.txns[h.tid];
          if (holder.ts > state.txns[tid].ts) { // 请求者更老 -> 伤害年轻持有者
            abortTxn(h.tid, 'wounded');
          }
        });
        return false; // 然后等待剩余更老的持有者
      }
      return false;
    }

    // 在一条锁层次路径上依次申请；任一资源阻塞则返回 'wait'
    function requestPath(tid, path, modes) {
      for (let i = 0; i < path.length; i++) {
        const res = path[i], mode = modes[i];
        if (txnMode(res, tid) === mode ||
            (txnMode(res, tid) && RANK[txnMode(res, tid)] >= RANK[mode])) continue;
        let holders = conflictingHolders(res, mode, tid);
        if (holders.length === 0) { grant(res, tid, mode); continue; }
        if (policyAbort(tid, holders)) {
          abortTxn(tid, state.policy === 'wait-die' ? 'died' : '');
          return 'dead';
        }
        holders = conflictingHolders(res, mode, tid);
        if (holders.length === 0) { grant(res, tid, mode); continue; }
        enqueueWait(res, tid, mode);
        return 'wait';
      }
      return 'ok';
    }

    function releaseAllLocks(tid) {
      Object.keys(state.txns[tid].locks).forEach(function (res) {
        const e = entryOf(res);
        if (!e) return;
        e.granted = e.granted.filter(function (g) { return g.tid !== tid; });
        e.queue = e.queue.filter(function (w) { return w.tid !== tid; });
        if (e.granted.length === 0 && e.queue.length === 0) delete state.lockTable[res];
      });
      state.txns[tid].locks = {};
      state.txns[tid].waitsOn = [];
      state.txns[tid].waitStart = null;
    }

    function abortTxn(tid, reason) {
      const t = state.txns[tid];
      if (!t || t.status !== 'active') return;
      state.aborts.push({ tid: tid, reason: reason || 'abort', step: state.stepNo });
      purgeQueue(tid);
      Object.keys(state.items).forEach(function (name) {
        if (t.locks['I:' + name]) state.items[name].draft = null;
      });
      t.status = 'aborted';
      t.pending = null;
      t.waitsOn = [];
      releaseAllLocks(tid);
      const why = reason === 'died' ? '（wait-die：遇到更老事务，自己中止）'
        : reason === 'timeout' ? '（timeout：等待超过 ' + state.timeoutSteps + ' 步，超时中止）'
        : reason === 'wounded' ? '' : '';
      log('abort', '事务 ' + tid + ' 中止回滚 ROLLBACK' + why, 'abort', [tid]);
      wake();
    }

    // ---------- 唤醒：各资源按 FIFO 尝试授予队首等待者 ----------
    function wake() {
      for (let guard = 0; guard < 64; guard++) {
        let progress = false;
        Object.keys(state.lockTable).forEach(function (res) {
          const e = state.lockTable[res];
          while (e.queue.length) {
            const w = e.queue[0];
            const t = state.txns[w.tid];
            if (!t || t.status !== 'active') { e.queue.shift(); progress = true; continue; }
            const holders = conflictingHolders(res, w.mode, w.tid);
            if (holders.length) {
              if (policyAbort(w.tid, holders)) { e.queue.shift(); progress = true; }
              break;
            }
            e.queue.shift();
            t.waitsOn = t.waitsOn.filter(function (r) { return r !== res; });
            if (t.waitsOn.length === 0) { t.blockedSeq = null; t.waitStart = null; }
            grant(res, w.tid, w.mode);
            progress = true;
            // 锁已授予；该事务的阻塞操作仍在全局 readyQueue 队首，下一轮 step 自动重试
          }
        });
        if (!progress) break;
      }
    }

    // ---------- 单步：先唤醒，再从全局就绪队列取队首操作执行 ----------
    // readyQueue 保留调度文本的跨事务交错顺序；
    // 某事务阻塞时其操作停留在队首，后续操作不被越过。
    function step() {
      state.stepNo++;
      wake();
      const before = state.log.length;

      // 超时中止策略：等待时长超过阈值的事务中止回滚（也借此解开死锁）
      if (state.policy === 'timeout') {
        let victim = null;
        state.txnOrder.forEach(function (id) {
          const t = state.txns[id];
          if (t.status !== 'active' || !t.waitsOn.length || t.waitStart == null) return;
          if (state.stepNo - t.waitStart < state.timeoutSteps) return;
          if (!victim || t.waitStart < state.txns[victim].waitStart) victim = id;
        });
        if (victim) { abortTxn(victim, 'timeout'); wake(); }
      }

      const d = detectDeadlock();
      if (d.cycle.length) {
        const ids = d.cycle;
        markAnomaly('deadlock',
          '检测到死锁循环：' + ids.join(' → ') + ' → ' + ids[0] + '（等待图中存在环）', ids);
        if (state.autoResolve && state.policy !== 'timeout') {
          const victim = d.victim;
          log('abort', '选择时间戳最新（最年轻）的事务 ' + victim + ' 作为牺牲者，解除死锁', 'abort', [victim]);
          if (state.readyQueue.length && state.readyQueue[0].tid === victim) state.readyQueue.shift();
          abortTxn(victim, 'deadlock');
          purgeQueue(victim);
          wake();
          return { status: 'deadlock', added: state.log.length - before, cycle: ids, victim: victim };
        }
        return { status: 'deadlock', added: state.log.length - before, cycle: ids, victim: null };
      }

      // 轮转调度：阻塞事务的操作挪到队尾，尝试队列中的其他事务；
      // 一整圈都无法执行 -> 全部在等待（可能死锁，由开头的环检测处理）。
      // 一轮轮询：每个事务至多跳过一次；新阻塞的事务也跳过，直到队列里
      // 只剩“已跳过且仍在等待”的事务 -> 本步无可执行操作。
      const seenWaiting = {};
      const guardMax = state.readyQueue.length + 2;
      let guard = 0;
      while (state.readyQueue.length && guard++ < guardMax) {
        const head = state.readyQueue[0];
        const t = state.txns[head.tid];
        if (!t || t.status !== 'active') { state.readyQueue.shift(); continue; }
        if (t.waitsOn.length) {
          if (seenWaiting[head.tid]) break;
          seenWaiting[head.tid] = true;
          state.readyQueue.push(state.readyQueue.shift());
          continue;
        }
        state.readyQueue.shift();
        const r = execute(head.tid, head.op);
        if (r === 'wait') { seenWaiting[head.tid] = true; state.readyQueue.push(head); continue; }
        if (r !== 'dead') state.execCount[head.tid] = (state.execCount[head.tid] || 0) + 1;
        return { status: 'ok', added: state.log.length - before };
      }
      return { status: state.readyQueue.length ? 'blocked' : 'finished', added: state.log.length - before };
    }

    function purgeQueue(tid) {
      state.readyQueue = state.readyQueue.filter(function (q) { return q.tid !== tid; });
      const t = state.txns[tid];
      if (t) { t.pending = null; t.waitsOn = []; t.waitStart = null; }
    }

    // ---------- 读值可见性 ----------
    function visibleValue(item, tid, iso) {
      const t = state.txns[tid];
      if (item.deleted) return { exists: false };
      if (iso === 'RU') return { exists: true, value: item.draft != null ? item.draft : item.value, dirty: item.draft != null };
      let draftHolder = null;
      Object.keys(state.txns).forEach(function (oid) {
        if (oid !== tid && state.txns[oid].status === 'active' && state.txns[oid].locks['I:' + item.name]) {
          if (state.items[item.name].draft != null) draftHolder = oid;
        }
      });
      if (draftHolder) return { exists: true, value: item.value, dirtyWriter: draftHolder };
      return { exists: true, value: item.value, dirty: false };
    }

    function execute(tid, op) {
      const t = state.txns[tid];
      if (!t || t.status !== 'active') return 'dead';
      const iso = t.iso;

      if (op.act === 'commit') {
        commitTxn(tid);
        return 'ok';
      }
      if (op.act === 'rollback') {
        abortTxn(tid, 'rollback');
        return 'ok';
      }

      if (op.act === 'read') {
        if (!state.items[op.item]) { log('error', '数据项 ' + op.item + ' 不存在', 'error', [tid]); return 'ok'; }
        if (iso !== 'RU') {
          const modes = iso === 'RC' ? ['IS', 'IS', 'S'] : ['IS', 'IS', 'S'];
          const r = requestPath(tid, pathsFor(op.item).read, modes);
          if (r !== 'ok') return r === 'dead' ? 'dead' : 'wait';
        }
        const item = state.items[op.item];
        const v = visibleValue(item, tid, iso);
        if (!v.exists) { log('read', tid + ' read(' + op.item + ')：数据项已删除', 'read', [tid]); return 'ok'; }
        t.reads[op.item] = (t.reads[op.item] || 0) + 1;
        t.readValue[op.item] = v.value;

        if (v.dirty || v.dirtyWriter) {
          markAnomaly('dirtyRead',
            '脏读：' + tid + ' 读到 ' + op.item + ' 的未提交值 "' + v.value + '"（来自 ' + (v.dirtyWriter || '其他事务') + '）',
            [tid, v.dirtyWriter]);
        } else if (t.reads[op.item] > 1) {
          const first = state.log.find(function (l) {
            return l.type === 'read' && l.ids.indexOf(tid) >= 0 && l.text.indexOf('read(' + op.item + ')') >= 0;
          });
          if (first && first.value !== v.value) {
            markAnomaly('unrepeatable',
              '不可重复读：' + tid + ' 两次读 ' + op.item + ' 结果不同："' + first.value + '" → "' + v.value + '"', [tid]);
          }
        }
        log('read', tid + ' read(' + op.item + ') = ' + v.value, 'read', [tid]);
        state.log[state.log.length - 1].value = v.value;
        if (iso === 'RC') releaseReadLock(tid, op.item);
        return 'ok';
      }

      if (op.act === 'write') {
        if (!state.items[op.item]) { log('error', '数据项 ' + op.item + ' 不存在', 'error', [tid]); return 'ok'; }
        const item = state.items[op.item];
        const r = requestPath(tid, pathsFor(op.item).write, ['IX', 'IX', 'X']);
        if (r !== 'ok') return r === 'dead' ? 'dead' : 'wait';
        if (t.reads[op.item] && item.version > 1 && t.readValue[op.item] != null &&
            t.readValue[op.item] !== item.committedValue && item.draft == null) {
          markAnomaly('lostUpdate',
            '丢失更新：' + tid + ' 基于读过的旧值 "' + t.readValue[op.item] +
              '" 覆盖写入，' + op.item + ' 已被其他事务提交为 "' + item.committedValue + '"', [tid]);
        }
        item.draft = op.value;
        log('write', tid + ' write(' + op.item + ', ' + op.value + ')（X 锁，未提交）', 'write', [tid]);
        return 'ok';
      }

      if (op.act === 'scan') {
        // 范围读：RU 无锁；RC 仅瞬时 IS；RR 锁 IS+IX 层次但表级不防插入 -> 幻读可见；
        // Serializable 在表 T 上取 S（或由 IS 升级为 SIX 效果），阻止任何插入/写入
        if (iso === 'SER') {
          let r = requestPath(tid, ['DB'], ['IS']);
          if (r !== 'ok') return r === 'dead' ? 'dead' : 'wait';
          const cur = txnMode('T', tid);
          const need = cur && RANK[cur] >= RANK['S'] ? cur : 'S';
          let holders = conflictingHolders('T', need, tid);
          if (holders.length === 0) { grant('T', tid, need); }
          else {
            if (policyAbort(tid, holders)) return 'dead';
            holders = conflictingHolders('T', need, tid);
            if (holders.length) { enqueueWait('T', tid, need); return 'wait'; }
            grant('T', tid, need);
          }
        } else if (iso !== 'RU') {
          const r = requestPath(tid, ['DB', 'T'], ['IS', 'IS']);
          if (r !== 'ok') return r === 'dead' ? 'dead' : 'wait';
        }
        const names = Object.keys(state.items).filter(function (n) {
          const it = state.items[n];
          if (it.deleted) return false;
          if (iso === 'RU') return true;
          const blockedByOther = Object.keys(state.txns).some(function (oid) {
            const ot = state.txns[oid];
            if (oid === tid || ot.status !== 'active' || !ot.locks['I:' + n]) return false;
            const it = state.items[n];
            return it.draft != null || it.insertedBy === oid;
          });
          return !blockedByOther;
        });
        const snap = names.map(function (n) { return n + '=' + state.items[n].value; }).join(', ');
        const prior = t.scans.length ? t.scans[t.scans.length - 1] : null;
        if (prior && prior !== snap) {
          markAnomaly('phantom',
            '幻读：' + tid + ' 两次范围扫描结果集变化：[' + prior + '] → [' + snap + ']（出现/消失了满足条件的行）', [tid]);
        }
        t.scans.push(snap);
        log('read', tid + ' scan(*) = {' + snap + '}' + (iso === 'SER' ? '（表级 S 锁，防幻读）' : ''), 'scan', [tid]);
        if (iso === 'RC') releaseScanLock(tid);
        return 'ok';
      }

      if (op.act === 'insert') {
        const r = requestPath(tid, ['DB', 'T'], ['IX', 'IX']);
        if (r !== 'ok') return r === 'dead' ? 'dead' : 'wait';
        if (state.items[op.item]) { log('error', op.item + ' 已存在，无法插入', 'error', [tid]); return 'ok'; }
        state.items[op.item] = {
          name: op.item, value: op.value || 'null', committedValue: op.value || 'null',
          draft: op.value || 'null', deleted: false, version: 1, insertedBy: tid
        };
        // 新插入行立即取 X 锁；draft 非空 => 提交前对其他事务不可见
        const rr = requestPath(tid, ['I:' + op.item], ['X']);
        if (rr !== 'ok') return rr === 'dead' ? 'dead' : 'wait';
        log('write', tid + ' insert(' + op.item + ', ' + (op.value || 'null') + ')', 'insert', [tid]);
        return 'ok';
      }

      if (op.act === 'delete') {
        if (!state.items[op.item]) { log('error', '数据项 ' + op.item + ' 不存在', 'error', [tid]); return 'ok'; }
        const r = requestPath(tid, pathsFor(op.item).write, ['IX', 'IX', 'X']);
        if (r !== 'ok') return r === 'dead' ? 'dead' : 'wait';
        state.items[op.item].deleted = true;
        log('write', tid + ' delete(' + op.item + ')', 'delete', [tid]);
        return 'ok';
      }

      log('error', '未知操作：' + JSON.stringify(op), 'error', [tid]);
      return 'ok';
    }

    function releaseReadLock(tid, itemName) {
      ['I:' + itemName, 'T', 'DB'].forEach(function (res) {
        const e = entryOf(res);
        if (!e) return;
        e.granted = e.granted.filter(function (g) { return g.tid !== tid; });
        e.queue = e.queue.filter(function (w) { return w.tid !== tid; });
        if (e.granted.length === 0 && e.queue.length === 0) delete state.lockTable[res];
        delete state.txns[tid].locks[res];
      });
      wake();
    }

    function releaseScanLock(tid) {
      ['T', 'DB'].forEach(function (res) {
        const e = entryOf(res);
        if (!e) return;
        e.granted = e.granted.filter(function (g) { return g.tid !== tid; });
        e.queue = e.queue.filter(function (w) { return w.tid !== tid; });
        if (e.granted.length === 0 && e.queue.length === 0) delete state.lockTable[res];
        delete state.txns[tid].locks[res];
      });
      wake();
    }

    function commitTxn(tid) {
      const t = state.txns[tid];
      if (t.status !== 'active') return;
      Object.keys(state.items).forEach(function (name) {
        const item = state.items[name];
        if (t.locks['I:' + name]) {
          if (item.deleted) { delete state.items[name]; }
          else if (item.draft != null) {
            item.value = item.draft;
            item.committedValue = item.draft;
            item.draft = null;
            item.version++;
          }
        }
      });
      t.status = 'committed';
      t.pending = null;
      releaseAllLocks(tid);
      log('commit', tid + ' COMMIT（2PL：统一释放全部锁）', 'commit', [tid]);
      wake();
    }

    // ---------- 锁等待图 ----------
    // 边：等待事务 -> 持锁事务；边上记录资源
    function waitForGraph() {
      const nodes = state.txnOrder.map(function (id) {
        const t = state.txns[id];
        return { id: id, status: t.status, waiting: t.waitsOn.length > 0 };
      });
      const edges = [];
      Object.keys(state.lockTable).forEach(function (res) {
        const e = state.lockTable[res];
        e.queue.forEach(function (w) {
          e.granted.forEach(function (g) {
            if (g.tid === w.tid) return;
            if (CONFLICTS[w.mode].indexOf(g.mode) < 0) return;
            const ex = edges.find(function (x) { return x.from === w.tid && x.to === g.tid; });
            if (ex) ex.res += ', ' + resLabel(res);
            else edges.push({ from: w.tid, to: g.tid, res: resLabel(res), mode: w.mode });
          });
        });
      });
      return { nodes: nodes, edges: edges };
    }

    function resLabel(res) {
      return res === 'DB' ? 'DB' : res === 'T' ? 'T' : res.slice(2);
    }

    function detectDeadlock() {
      const g = {};
      waitForGraph().edges.forEach(function (e) {
        (g[e.from] = g[e.from] || []).push(e.to);
      });
      const WHITE = 0, GRAY = 1, BLACK = 2;
      const color = {};
      let cycle = null;
      function dfs(u, stack) {
        color[u] = GRAY;
        stack.push(u);
        (g[u] || []).forEach(function (v) {
          if (cycle) return;
          if (color[v] === GRAY) {
            const idx = stack.indexOf(v);
            cycle = stack.slice(idx);
          } else if (color[v] !== BLACK) {
            dfs(v, stack);
          }
        });
        stack.pop();
        color[u] = BLACK;
      }
      state.txnOrder.forEach(function (id) {
        if (!cycle && color[id] !== BLACK) dfs(id, []);
      });
      if (!cycle) return { cycle: [], victim: null };
      // 牺牲者：环中时间戳最新（最年轻）的事务
      let victim = cycle[0];
      cycle.forEach(function (id) {
        if (state.txns[id].ts > state.txns[victim].ts) victim = id;
      });
      return { cycle: cycle, victim: victim };
    }

    function runAll(maxSteps) {
      let n = 0;
      const cap = maxSteps || 200;
      while (n++ < cap) {
        const r = step();
        if (r.status === 'finished') break;
        if (r.status === 'deadlock' && !state.autoResolve) break;
        if (r.status === 'blocked' && r.added === 0) {
          // 无预防策略且未自动解除：死锁会被上面的环检测捕获；这里兜底
          if (state.policy === 'timeout' && state.txnOrder.some(function (id) {
            const t = state.txns[id];
            return t.status === 'active' && t.waitsOn.length;
          })) continue; // timeout 策略下仍有等待者，继续推进步号以触发超时
          break;
        }
      }
      return state;
    }

    function snapshot() { return state; }

    const api = {
      state: state,
      addTxn: addTxn,
      step: step,
      runAll: runAll,
      waitForGraph: waitForGraph,
      detectDeadlock: detectDeadlock,
      resourceLabel: resourceLabel,
      snapshot: snapshot
    };
    return api;
  }

  // ---------- 调度文本解析 ----------
  // 形如  T1:R(A)  T1:W(A,10)  T1:C  T1:A  T1:S  T1:I(C,30)
  function parseSchedule(text, defaultIso) {
    const ops = [];
    const txns = {};
    text.split(/[\n;]+/).forEach(function (lineRaw) {
      const line = lineRaw.replace(/#.*$/, '').trim();
      if (!line) return;
      const tokens = line.match(/[A-Za-z]\w*\s*:\s*[A-Za-z]+\s*(?:\([^)]*\))?/g) || [];
      tokens.forEach(function (tok) {
        const m = tok.match(/^([A-Za-z]\w*)\s*:\s*([A-Za-z]+)\s*(?:\(([^)]*)\))?$/);
        if (!m) return;
        const tid = m[1], verb = m[2].toUpperCase(), args = (m[3] || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        const op = { tid: tid };
        if (verb === 'R' || verb === 'READ') op.act = 'read', op.item = args[0];
        else if (verb === 'W' || verb === 'WRITE') op.act = 'write', op.item = args[0], op.value = args[1];
        else if (verb === 'S' || verb === 'SCAN') op.act = 'scan';
        else if (verb === 'I' || verb === 'INSERT') op.act = 'insert', op.item = args[0], op.value = args[1];
        else if (verb === 'D' || verb === 'DELETE') op.act = 'delete', op.item = args[0];
        else if (verb === 'C' || verb === 'COMMIT') op.act = 'commit';
        else if (verb === 'A' || verb === 'ROLLBACK' || verb === 'ABORT') op.act = 'rollback';
        else return;
        if (!op.item && (op.act === 'read' || op.act === 'write' || op.act === 'delete' || op.act === 'insert')) return;
        ops.push(op);
        txns[tid] = true;
      });
    });
    return { ops: ops, txnIds: Object.keys(txns), defaultIso: defaultIso || 'RC' };
  }

  // 用 setup 构造调度器并装载操作序列（按事务分组，保持各自相对顺序）
  function buildScheduler(setup, ops) {
    const sch = createScheduler(setup);
    ops.forEach(function (op) {
      if (!sch.state.txns[op.tid]) sch.addTxn(op.tid, setup.defaultIso || 'RC');
    });
    ops.forEach(function (op) {
      const copy = {};
      Object.keys(op).forEach(function (k) { if (k !== 'tid') copy[k] = op[k]; });
      sch.state.readyQueue.push({ tid: op.tid, op: copy });
    });
    return sch;
  }

  // ---------- 死锁处理策略对比 ----------
  // 同一组操作在指定策略下完整运行一遍；被策略中止的事务自动重启
  // （保留原时间戳，剩余操作追加到就绪队列尾部），统计代价指标。
  const POLICY_LABEL = {
    'wait-die': 'wait-die（预防：年老等、年轻死）',
    'wound-wait': 'wound-wait（预防：年老伤害年轻）',
    'timeout': 'timeout（超时中止）'
  };

  function runPolicyScenario(setup, ops, policy, opts) {
    opts = opts || {};
    const maxRestarts = opts.maxRestarts != null ? opts.maxRestarts : 8;
    const starveAfter = opts.starveAfter || 3;
    const sch = buildScheduler({
      txns: setup.txns, items: setup.items, defaultIso: setup.defaultIso,
      policy: policy, autoResolve: true,
      timeoutSteps: opts.timeoutSteps || setup.timeoutSteps || 3
    }, ops);
    const st = sch.state;
    const opMap = {};
    ops.forEach(function (op) { (opMap[op.tid] = opMap[op.tid] || []).push(op); });

    const restarts = {};
    let totalWait = 0;          // 总等待时长（事务·步）：每步处于等待状态的事务数之和
    let consumedAborts = 0, steps = 0, stall = 0, lastLogLen = 0, finished = false;
    const cap = opts.maxSteps || 400;

    while (steps++ < cap) {
      if (!st.readyQueue.length) { finished = true; break; }
      sch.step();
      st.txnOrder.forEach(function (id) {
        const t = st.txns[id];
        if (t.status === 'active' && t.waitsOn.length) totalWait++;
      });
      // 处理新发生的中止：重启仍有剩余操作的事务
      for (; consumedAborts < st.aborts.length; consumedAborts++) {
        const ab = st.aborts[consumedAborts];
        if (ab.reason === 'rollback') continue; // 调度文本里的显式回滚不重启
        const remaining = (opMap[ab.tid] || []).slice(st.execCount[ab.tid] || 0);
        if (!remaining.length) continue;
        restarts[ab.tid] = (restarts[ab.tid] || 0) + 1;
        if (restarts[ab.tid] > maxRestarts) continue; // 放弃重启 -> 记为饥饿
        const t = st.txns[ab.tid];
        t.status = 'active'; t.pending = null; t.waitsOn = []; t.waitStart = null; // 保留原 ts
        remaining.forEach(function (op) {
          const copy = {};
          Object.keys(op).forEach(function (k) { if (k !== 'tid') copy[k] = op[k]; });
          st.readyQueue.push({ tid: ab.tid, op: copy });
        });
      }
      if (st.log.length === lastLogLen && st.aborts.length <= consumedAborts) {
        if (++stall >= 20) break; // 长时间无进展，防止死循环
      } else { stall = 0; lastLogLen = st.log.length; }
    }

    const victims = {};
    let rollbacks = 0;
    st.aborts.forEach(function (ab) {
      if (ab.reason === 'rollback') return;
      victims[ab.tid] = (victims[ab.tid] || 0) + 1;
      rollbacks++;
    });
    // 完成判定：已提交或显式回滚的事务视为完结（提交后被越过的剩余操作按引擎语义丢弃）；
    // 其余事务若有操作未执行（仍在运行或被放弃重启），视为未完成。
    const rolledBack = {};
    st.aborts.forEach(function (ab) { if (ab.reason === 'rollback') rolledBack[ab.tid] = true; });
    const incomplete = Object.keys(opMap).filter(function (id) {
      if (rolledBack[id]) return false;
      if ((st.execCount[id] || 0) >= opMap[id].length) return false;
      return st.txns[id].status !== 'committed';
    });
    finished = finished && incomplete.length === 0;
    const starved = Object.keys(restarts).filter(function (id) {
      return restarts[id] >= starveAfter;
    });
    return {
      policy: policy,
      label: POLICY_LABEL[policy] || policy,
      finished: finished,
      steps: st.stepNo,
      totalWait: totalWait,
      rollbacks: rollbacks,
      victims: victims,
      restarts: restarts,
      starvation: {
        detected: starved.length > 0 || !finished,
        txns: starved,
        reason: starved.length ? starved.join('、') + ' 被反复中止重启（≥' + starveAfter + ' 次）'
          : (!finished ? '调度未完成' + (incomplete.length ? '：' + incomplete.join('、') + ' 有操作未执行' : '') : '')
      }
    };
  }

  // 同一组操作在三种死锁处理策略下各跑一遍，返回对比结果数组
  function comparePolicies(setup, ops, opts) {
    return ['wait-die', 'wound-wait', 'timeout'].map(function (p) {
      return runPolicyScenario(setup, ops, p, opts);
    });
  }

  // ---------- 内置五类教学示例 ----------
  const EXAMPLES = {
    lostUpdate: {
      title: '丢失更新 Lost Update',
      desc: '两个事务都先读同一数据项再写回，后提交者覆盖前者的修改（Read Committed，2PL 下可观察到写覆盖）。',
      setup: {
        items: [{ name: 'A', value: '100' }],
        txns: [{ id: 'T1', iso: 'RC' }, { id: 'T2', iso: 'RC' }],
        policy: 'none', autoResolve: true, defaultIso: 'RC'
      },
      text: 'T1:R(A) T2:R(A) T1:W(A,80) T1:C T2:W(A,60) T2:C'
    },
    dirtyRead: {
      title: '脏读 Dirty Read',
      desc: 'T1 修改后未提交，T2 在 Read Uncommitted 下直接读到该脏值；随后 T1 回滚。',
      setup: {
        items: [{ name: 'A', value: '100' }],
        txns: [{ id: 'T1', iso: 'RC' }, { id: 'T2', iso: 'RU' }],
        policy: 'none', autoResolve: true, defaultIso: 'RU'
      },
      text: 'T1:W(A,200) T2:R(A) T1:A T2:R(A) T2:C'
    },
    unrepeatable: {
      title: '不可重复读 Non-Repeatable Read',
      desc: 'T2 用 Read Committed 两次读同一行；T1 在其间提交修改，两次结果不一致。',
      setup: {
        items: [{ name: 'A', value: '100' }],
        txns: [{ id: 'T1', iso: 'RC' }, { id: 'T2', iso: 'RC' }],
        policy: 'none', autoResolve: true, defaultIso: 'RC'
      },
      text: 'T2:R(A) T1:W(A,300) T1:C T2:R(A) T2:C'
    },
    phantom: {
      title: '幻读 Phantom Read',
      desc: 'T2 在 Repeatable Read 下两次范围扫描；T1 在其间插入新行并提交，结果集多出“幻影行”。',
      setup: {
        items: [{ name: 'A', value: '10' }, { name: 'B', value: '20' }],
        txns: [{ id: 'T1', iso: 'RR' }, { id: 'T2', iso: 'RR' }],
        policy: 'none', autoResolve: true, defaultIso: 'RR'
      },
      text: 'T2:S T1:I(C,30) T1:C T2:S T2:C'
    },
    deadlock: {
      title: '死锁 Deadlock',
      desc: 'T1 持 A 等 B、T2 持 B 等 A，等待图成环。可切换 wait-die / wound-wait 观察预防效果。',
      setup: {
        items: [{ name: 'A', value: '1' }, { name: 'B', value: '2' }],
        txns: [{ id: 'T1', iso: 'RR' }, { id: 'T2', iso: 'RR' }],
        policy: 'none', autoResolve: true, defaultIso: 'RR'
      },
      text: 'T1:W(A,10) T2:W(B,20) T1:W(B,11) T2:W(A,21) T1:C T2:C'
    }
  };

  const ANOMALY_LABEL = {
    lostUpdate: '丢失更新',
    dirtyRead: '脏读',
    unrepeatable: '不可重复读',
    phantom: '幻读',
    deadlock: '死锁'
  };

  const DB = {
    ISO: ISO, ISO_LABEL: ISO_LABEL,
    CONFLICTS: CONFLICTS,
    createScheduler: createScheduler,
    parseSchedule: parseSchedule,
    buildScheduler: buildScheduler,
    runPolicyScenario: runPolicyScenario,
    comparePolicies: comparePolicies,
    POLICY_LABEL: POLICY_LABEL,
    EXAMPLES: EXAMPLES,
    ANOMALY_LABEL: ANOMALY_LABEL,
    resourceLabel: resourceLabel
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = DB;
  else global.DB = DB;
})(typeof window !== 'undefined' ? window : globalThis);
