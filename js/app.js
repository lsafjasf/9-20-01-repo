/* ============================================================
 * 界面层: 状态管理 + SVG 可视化
 * ============================================================ */
(function () {
  'use strict';
  const { Engine, ISO, M, MODE_COLOR, COMPAT, TABLE, parseSchedule } = window.DBDemo;

  const ISO_LABEL = { RU: 'Read Uncommitted', RC: 'Read Committed', RR: 'Repeatable Read', SER: 'Serializable' };
  const ISO_NAME = { RU: 'RU 读未提交', RC: 'RC 读已提交', RR: 'RR 可重复读', SER: 'SER 串行化' };

  /* ---------- 内置五类示例 ---------- */
  const EXAMPLES = {
    lost: {
      name: '丢失更新 (Read Committed)',
      items: { x: 10 },
      iso: { T1: 'RC', T2: 'RC' },
      text:
`-- 两个事务都读到 x=10, 各自加 10 后写回
-- RC 下写锁虽互斥, 但 T1 基于过期读值覆盖了 T2 的提交更新
T1 r(x)
T2 r(x)
T2 w(x, 20)
T2 commit
T1 w(x, 11)
T1 commit`
    },
    dirty: {
      name: '脏读 (Read Uncommitted)',
      items: { x: 10 },
      iso: { T1: 'RU', T2: 'RU' },
      text:
`-- T1 未提交写入 x=99, T2 在 RU 下直接读到脏数据
-- 若 T1 随后回滚, T2 读到的就是从不存在的值
T1 w(x, 99)
T2 r(x)
T1 rollback`
    },
    nrr: {
      name: '不可重复读 (Read Committed)',
      items: { x: 10 },
      iso: { T1: 'RC', T2: 'RC' },
      text:
`-- T1 两次读取 x, 中间 T2 修改并提交
-- RC 的 S 锁读完即放, 同一事务两次读结果不同
T1 r(x)
T2 w(x, 20)
T2 commit
T1 r(x)
T1 commit`
    },
    phantom: {
      name: '幻读 (Repeatable Read)',
      items: { x: 1 },
      iso: { T1: 'RR', T2: 'RR' },
      text:
`-- T1 两次范围扫描 scan, 中间 T2 插入并提交新记录 y
-- RR 的 IS 锁与 T2 的 IX 锁兼容, 第二次扫描多出"幻影行"
-- 把 T1 切到 SER 再试: scan 加表级 S 锁, T2 将被阻塞, 幻读消失
T1 scan
T2 insert(y, 2)
T2 commit
T1 scan
T1 commit`
    },
    deadlock: {
      name: '死锁 (循环等待)',
      items: { x: 0, y: 0 },
      iso: { T1: 'RR', T2: 'RR' },
      text:
`-- 经典交叉持有: T1 持 x 等 y, T2 持 y 等 x
-- 第 4 步后等待图出现环, 检测器自动选出牺牲者中止
-- 可切换 wait-die / wound-wait 观察预防策略如何避免成环
T1 w(x, 1)
T2 w(y, 2)
T1 w(y, 3)
T2 w(x, 4)
T1 commit
T2 commit`
    }
  };

  /* ---------- 应用状态 ---------- */
  const $ = id => document.getElementById(id);
  let engine = null;
  let currentExample = 'lost';
  let isoOverrides = {};
  let autoTimer = null;

  const el = {
    example: $('exampleSelect'), prevention: $('preventionSelect'), victim: $('victimSelect'),
    txnList: $('txnList'), schedule: $('scheduleInput'), itemsEditor: $('itemsEditor'),
    itemsView: $('itemsView'), readHistory: $('readHistory'),
    lockBody: $('lockTable').querySelector('tbody'),
    log: $('eventLog'), svg: $('wfgSvg'), banner: $('anomalyBanner'),
    wfgStatus: $('wfgStatus'), stepBtn: $('stepBtn'), autoBtn: $('autoBtn')
  };
  /* ---------- 构建 / 重置 ---------- */
  function parseItemsEditor() {
    const map = {};
    el.itemsEditor.querySelectorAll('.item-row').forEach(row => {
      const k = row.querySelector('.ik').value.trim();
      const v = row.querySelector('.iv').value.trim();
      if (k) map[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    });
    return map;
  }

  function buildEngine(preserveIso) {
    stopAuto();
    const parsed = parseSchedule(el.schedule.value);
    const items = parseItemsEditor();
    engine = new Engine({
      prevention: el.prevention.value,
      victimPolicy: el.victim.value
    });
    engine.setInitialItems(items);

    const tids = [];
    parsed.steps.forEach(s => { if (tids.indexOf(s.tid) < 0) tids.push(s.tid); });
    const ex = EXAMPLES[currentExample];
    tids.forEach(id => {
      let iso = isoOverrides[id];
      if (!iso && ex && ex.iso[id]) iso = ex.iso[id];
      engine.addTxn(id, iso || ISO.RR);
    });
    engine.setSteps(parsed.steps);
    engine.log('info', '— 新调度已载入 (' + tids.length + ' 个事务, ' +
      parsed.steps.length + ' 个操作; 隔离: ' + tids.map(id => id + '=' + engine.txns.get(id).iso).join(', ') + ') —');
    if (parsed.errors.length) {
      parsed.errors.forEach(e => engine.log('info', '✗ 脚本第' + e.line + '行: ' + e.msg));
    }
    renderAll();
  }

  function loadExample(key) {
    currentExample = key;
    const ex = EXAMPLES[key];
    el.schedule.value = ex.text;
    renderItemsEditor(ex.items);
    isoOverrides = Object.assign({}, ex.iso);
    buildEngine();
  }

  function renderItemsEditor(items) {
    el.itemsEditor.innerHTML = '';
    Object.keys(items).forEach(k => addItemRow(k, items[k]));
  }

  function addItemRow(k, v) {
    const row = document.createElement('div');
    row.className = 'item-row';
    row.innerHTML =
      '<input class="ik" type="text" value="' + esc(k) + '" placeholder="项名" />' +
      '<input class="iv" type="text" value="' + esc(String(v)) + '" placeholder="初值" />' +
      '<button class="btn btn-mini del btn-danger">删除</button>';
    row.querySelector('.del').onclick = () => row.remove();
    el.itemsEditor.appendChild(row);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /* ---------- 执行 ---------- */
  function doStep() {
    if (!engine) buildEngine();
    const r = engine.runNextStep();
    renderAll();
    if (r.status === 'blocked') {
      const waits = (r.waiters || []).map(t => {
        const w = t.waiting || {};
        const blockers = engine.conflicts(w.resource, w.mode, t.id).map(c => c.tid);
        return t.id + ' 等待 ' + w.resource + ' 的 ' + w.mode + ' 锁' +
          (blockers.length ? ' (被 ' + blockers.join(', ') + ' 阻塞)' : '');
      });
      engine.log('info', '⏸ 调度停滞: 剩余步骤都属于等待中的事务' +
        (waits.length ? ' — ' + waits.join('; ') : '') +
        '; 持锁方已没有可执行的后续操作来释放锁, 请检查调度(是否缺少 commit/rollback)或重置');
      renderLog();
      stopAuto();
    }
    if (r.status === 'done') {
      engine.log('ok', '—— 调度执行完毕 ——');
      renderLog();
      stopAuto();
    }
  }

  function startAuto() {
    if (autoTimer) { stopAuto(); return; }
    el.autoBtn.textContent = '暂停 ⏸';
    const tick = () => {
      if (!engine) buildEngine();
      const r = engine.runNextStep();
      renderAll();
      if (r.status === 'blocked' || r.status === 'done') { stopAuto(); return; }
      autoTimer = setTimeout(tick, Number($('speedRange').value));
    };
    tick();
  }

  function stopAuto() {
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = null;
    el.autoBtn.textContent = '自动 ⏩';
  }
  /* ---------- 渲染: 事务 ---------- */
  function renderTxns() {
    el.txnList.innerHTML = '';
    const perTxn = {};
    engine.steps.forEach((s, i) => {
      (perTxn[s.tid] = perTxn[s.tid] || []).push({ step: s, index: i });
    });
    engine.txns.forEach(t => {
      const card = document.createElement('div');
      card.className = 'txn';
      card.style.borderLeftColor = txnColor(t.id);
      const stateCls = 'state-' + t.state;
      const stateText = { active: '活跃', waiting: '等待中', committed: '已提交', aborted: '已中止' }[t.state];
      let reason = t.abortReason ? '<div class="txn-meta">原因: ' + esc(t.abortReason) + '</div>' : '';
      const wait = t.waiting ? '<div class="txn-meta op-wait">⛓ 等待 ' + esc(t.waiting.resource) + ' 的 ' + t.waiting.mode + ' 锁</div>' : '';
      card.innerHTML =
        '<div class="txn-head">' +
          '<span class="txn-name">' + esc(t.id) + '</span>' +
          '<select class="iso-sel" data-tid="' + esc(t.id) + '">' +
            ['RU', 'RC', 'RR', 'SER'].map(lv =>
              '<option value="' + lv + '"' + (t.iso === lv ? ' selected' : '') + '>' + ISO_NAME[lv] + '</option>').join('') +
          '</select>' +
          '<span class="txn-state ' + stateCls + '">' + stateText + '</span>' +
          '<button class="txn-del" data-del="' + esc(t.id) + '" title="删除事务">✕</button>' +
        '</div>' +
        '<div class="txn-meta">启动序号 ' + (t.ts || '-') + ' · 持锁 ' + t.locks.size + ' 个</div>' +
        wait + reason +
        '<div class="txn-ops"></div>';

      const opsBox = card.querySelector('.txn-ops');
      (perTxn[t.id] || []).forEach(({ step, index }) => {
        const st = engine.stepState(step, index);
        const span = document.createElement('span');
        span.className = 'op ' + (st === 'done' ? 'done' : st === 'current' ? 'cur' : st === 'skipped' ? 'skipped' : '');
        if (st === 'current' && t.state === 'waiting') span.classList.add('op-wait');
        span.textContent = opShort(step.op);
        span.title = '第 ' + (index + 1) + ' 步 (脚本第 ' + step.line + ' 行)';
        opsBox.appendChild(span);
      });

      card.querySelector('.iso-sel').onchange = e => {
        isoOverrides[t.id] = e.target.value;
        engine.setIsolation(t.id, e.target.value);
        renderAll();
      };
      card.querySelector('[data-del]').onclick = () => {
        el.schedule.value = el.schedule.value.split(/\r?\n/)
          .filter(line => !new RegExp('^' + t.id + '\\s*[:：.\\-]?\\s*(read|write|r|w|commit|rollback|abort|scan|insert)\\b', 'i').test(line.trim()))
          .join('\n');
        buildEngine();
      };
      el.txnList.appendChild(card);
    });
  }

  function opShort(op) {
    switch (op.type) {
      case 'read': return 'r(' + op.key + ')';
      case 'write': return 'w(' + op.key + ',' + op.value + ')';
      case 'insert': return 'ins(' + op.key + ',' + op.value + ')';
      case 'scan': return 'scan';
      case 'commit': return 'commit';
      case 'rollback': return 'rollback';
    }
  }

  function txnColor(tid) {
    let h = 0;
    for (let i = 0; i < tid.length; i++) h = (h * 31 + tid.charCodeAt(i)) % 360;
    return 'hsl(' + h + ',70%,60%)';
  }
  /* ---------- 渲染: 锁表 ---------- */
  function renderLocks() {
    const rows = [];
    Object.keys(engine.lockTable).sort().forEach(res => {
      const r = engine.lockTable[res];
      if (!r.holders.size && !r.queue.length) return;
      const holderHtml = r.holders.size
        ? Array.from(r.holders.entries()).map(([tid, mode]) =>
            '<span class="lockmode ' + (MODE_COLOR[mode] || '') + '">' + mode + '</span> ' + esc(tid)).join('，')
        : '<span class="hint">—</span>';
      const waitHtml = r.queue.length
        ? r.queue.map(w => '<span class="waiter">⛓ ' + esc(w.tid) + ' 请求 ' + w.mode + '</span>').join('，')
        : '<span class="hint">—</span>';
      rows.push('<tr><td><span class="res">' + (res === TABLE ? '表 R' : esc(res)) + '</span></td>' +
        '<td>' + (res === TABLE ? '<span class="hint">意向/谓词锁</span>' : '<span class="hint">行级锁</span>') + '</td>' +
        '<td>' + holderHtml + '</td><td>' + waitHtml + '</td></tr>');
    });
    el.lockBody.innerHTML = rows.length ? rows.join('') :
      '<tr class="empty-row"><td colspan="4">当前没有任何锁</td></tr>';
  }

  /* ---------- 渲染: 数据快照 ---------- */
  function renderItems() {
    const keys = Object.keys(engine.items);
    el.itemsView.innerHTML = keys.length ? '' : '<p class="hint">(无数据)</p>';
    keys.forEach(k => {
      const it = engine.items[k];
      const div = document.createElement('div');
      div.className = 'data-item';
      let tag = '';
      if (it.uncommitted) tag = '<span class="tag tag-dirty">未提交 by ' + esc(it.uncommitted) + '</span>';
      else if (it.by) tag = '<span class="tag tag-committed">提交 by ' + esc(it.by) + '</span>';
      else tag = '<span class="hint">初始值</span>';
      div.innerHTML = '<span class="k">' + esc(k) + '</span><span class="v">= ' + esc(String(it.v)) + '</span>' +
        '<span class="who"></span>';
      div.querySelector('.who').appendChild(document.createRange().createContextualFragment(tag));
      el.itemsView.appendChild(div);
    });

    el.readHistory.innerHTML = '';
    engine.txns.forEach(t => {
      const ks = Array.from(t.reads.keys());
      if (!ks.length && !t.scans.length) return;
      const box = document.createElement('div');
      box.className = 'rh-txn';
      let html = '<b style="color:' + txnColor(t.id) + '">' + esc(t.id) + ' (' + t.iso + ')</b><br>';
      ks.forEach(k => {
        const v = t.reads.get(k);
        html += '<span class="rh-entry">r(' + esc(k) + ')=' + esc(String(v)) + '</span> ';
      });
      t.scans.forEach((s, i) => {
        html += '<span class="rh-entry">scan#' + (i + 1) + '={' + s.keys.map(esc).join(',') + '}</span> ';
      });
      box.innerHTML = html;
      el.readHistory.appendChild(box);
    });
  }

  /* ---------- 渲染: 日志与异常 ---------- */
  function renderLog() {
    el.log.innerHTML = engine.events.map(e =>
      '<div class="ev ev-' + e.type + '"><span class="step">[' + String(e.seq).padStart(2, '0') + ']</span>' +
      esc(e.message) + '</div>').join('');
    el.log.scrollTop = el.log.scrollHeight;
  }

  const ANOMALY_ICON = {
    'lost-update': ['an-lost', '💥', '丢失更新'],
    'dirty': ['an-dirty', '🩹', '脏读'],
    'nrr': ['an-nrr', '🔁', '不可重复读'],
    'phantom': ['an-phantom', '👻', '幻读'],
    'deadlock': ['an-deadlock', '☠', '死锁'],
    'prevent': ['an-deadlock', '🛡', '预防中止']
  };

  function renderBanner() {
    el.banner.innerHTML = engine.anomalies.map(a => {
      const meta = ANOMALY_ICON[a.kind] || ['an-dirty', '⚠', a.title];
      return '<div class="anomaly ' + meta[0] + '"><span class="ic">' + meta[1] + '</span>' +
        '<div><div class="t">' + esc(a.title) + '</div><div class="d">' + esc(a.detail) + '</div></div></div>';
    }).join('');
  }
  /* ---------- SVG 锁等待图 ---------- */
  function renderWfg() {
    const wfg = engine.buildWfg();
    const svg = el.svg;
    const W = 600, H = 300;
    const ids = Array.from(engine.txns.keys());
    const n = ids.length;
    const cx = W / 2, cy = H / 2 + 6, R = Math.min(W, H) * 0.33;

    let html = '<defs>' +
      '<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
      '<path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>' +
      '<marker id="arrowRed" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
      '<path d="M0,0 L10,5 L0,10 z" fill="#f87171"/></marker></defs>';

    if (!n) {
      html += '<text class="wfg-empty" x="' + cx + '" y="' + cy + '">暂无事务</text>';
    } else {
      const pos = {};
      ids.forEach((id, i) => {
        const ang = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(n, 1);
        pos[id] = { x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang) };
      });

      const cycleSet = new Set();
      if (wfg.cycle) {
        wfg.cycle.forEach(id => cycleSet.add(id));
        for (let i = 0; i < wfg.cycle.length; i++) {
          cycleSet.add(wfg.cycle[i] + '>' + wfg.cycle[(i + 1) % wfg.cycle.length]);
        }
      }

      // 边(同一对节点的多条边做弯曲分离)
      const pairCount = {};
      wfg.edges.forEach(e => {
        const key = [e.from, e.to].sort().join('|');
        pairCount[key] = (pairCount[key] || 0) + 1;
      });
      const pairSeen = {};
      wfg.edges.forEach(e => {
        const a = pos[e.from], b = pos[e.to];
        const inCycle = cycleSet.has(e.from + '>' + e.to);
        const key = [e.from, e.to].sort().join('|');
        const k2 = e.from + '>' + e.to;
        pairSeen[k2] = (pairSeen[k2] || 0) + 1;
        let path;
        if (pairCount[key] > 1 || e.from === e.to) {
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          const dx = b.x - a.x, dy = b.y - a.y;
          const len = Math.hypot(dx, dy) || 1;
          const bend = pairSeen[k2] % 2 === 0 ? 26 : -26;
          const qx = mx + (-dy / len) * bend, qy = my + (dx / len) * bend;
          path = 'M' + a.x + ',' + a.y + ' Q' + qx + ',' + qy + ' ' + b.x + ',' + b.y;
        } else {
          path = 'M' + a.x + ',' + a.y + ' L' + b.x + ',' + b.y;
        }
        // 缩短到节点半径外
        html += '<path class="edge' + (inCycle ? ' edge-cycle' : '') + '" d="' + path + '" />';
        const lx = (a.x + b.x) / 2, ly = (a.y + b.y) / 2 - 4;
        const label = (e.res === TABLE ? 'R' : e.res) + ':' + e.mode;
        const w = label.length * 5.4 + 6;
        html += '<rect class="edge-label-bg" x="' + (lx - w / 2) + '" y="' + (ly - 8) + '" width="' + w + '" height="13" rx="2"/>' +
          '<text class="edge-label" x="' + lx + '" y="' + (ly + 2) + '">' + label + '</text>';
      });

      // 节点
      ids.forEach(id => {
        const t = engine.txns.get(id);
        const p = pos[id];
        const fill = { active: '#083025', waiting: '#3a2a05', committed: '#0b2a3a', aborted: '#3b0d12' }[t.state];
        const stroke = t.state === 'waiting' ? '#fbbf24' : t.state === 'aborted' ? '#f87171'
          : t.state === 'committed' ? '#38bdf8' : txnColor(id);
        const r = 26;
        html += '<circle class="node-circle" cx="' + p.x + '" cy="' + p.y + '" r="' + r +
          '" fill="' + fill + '" stroke="' + (cycleSet.has(id) ? '#f87171' : stroke) + '"' +
          (cycleSet.has(id) ? ' stroke-width="3.5"' : '') + ' />';
        html += '<text class="node-label" x="' + p.x + '" y="' + (p.y - 3) + '">' + esc(id) + '</text>';
        const sub = { active: '活跃', waiting: '等待', committed: '提交', aborted: '中止' }[t.state];
        html += '<text class="node-sub" x="' + p.x + '" y="' + (p.y + 11) + '">' + sub + '·' + t.iso + '</text>';
      });
    }
    svg.innerHTML = html;

    if (wfg.cycle) {
      el.wfgStatus.textContent = '☠ 死锁环: ' + wfg.cycle.join(' → ');
      el.wfgStatus.className = 'status-pill pill-dead';
    } else if (wfg.edges.length) {
      el.wfgStatus.textContent = '存在锁等待 (' + wfg.edges.length + ' 条边), 无死锁';
      el.wfgStatus.className = 'status-pill pill-wait';
    } else {
      el.wfgStatus.textContent = '✓ 无等待';
      el.wfgStatus.className = 'status-pill pill-ok';
    }
  };

  function renderAll() {
    renderTxns(); renderLocks(); renderItems(); renderWfg(); renderBanner(); renderLog();
    // 存在未执行且事务处于 active 的步骤即可继续:
    // 引擎会自动跳过阻塞事务, 推进其他事务, 直至它们全部阻塞
    el.stepBtn.disabled = !engine || engine.finished || engine.nextRunnableIndex() < 0;
  }

  /* ---------- 兼容矩阵 ---------- */
  function renderCompat() {
    const modes = ['IS', 'S', 'IX', 'SIX', 'X'];
    let html = '<thead><tr><th>持有＼请求</th>' + modes.map(m => '<th>' + m + '</th>').join('') + '</tr></thead><tbody>';
    modes.forEach(h => {
      html += '<tr><td><span class="lockmode ' + MODE_COLOR[h] + '">' + h + '</span></td>';
      modes.forEach(q => {
        const ok = COMPAT[h][q];
        html += '<td class="' + (ok ? 'compat-y">✓' : 'compat-n">✗') + '</td>';
      });
      html += '</tr>';
    });
    $('compatTable').innerHTML = html + '</tbody>';
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    Object.keys(EXAMPLES).forEach(key => {
      const o = document.createElement('option');
      o.value = key; o.textContent = EXAMPLES[key].name;
      el.example.appendChild(o);
    });
    el.example.value = currentExample;
    el.example.onchange = () => loadExample(el.example.value);

    $('addTxnBtn').onclick = () => {
      let i = 1;
      while (engine && engine.txns.has('T' + i)) i++;
      const id = 'T' + i;
      el.schedule.value = el.schedule.value.replace(/\s*$/, '') + '\n' + id + ' r(x)\n' + id + ' commit';
      isoOverrides[id] = 'RR';
      buildEngine();
    };
    $('addItemBtn').onclick = () => {
      let k = 'z', i = 0;
      const all = () => Array.from(el.itemsEditor.querySelectorAll('.ik')).map(x => x.value.trim());
      while (all().indexOf(k) >= 0) { k = 'z' + (++i); }
      addItemRow(k, 0);
    };
    $('rebuildBtn').onclick = () => buildEngine();
    $('stepBtn').onclick = doStep;
    $('autoBtn').onclick = startAuto;
    $('resetBtn').onclick = () => { stopAuto(); buildEngine(); };
    $('clearLogBtn').onclick = () => { if (engine) { engine.events = []; renderLog(); } };
    el.prevention.onchange = () => buildEngine();
    el.victim.onchange = () => { if (engine) engine.victimPolicy = el.victim.value; };
    $('toggleMatrix').onclick = () => $('compatWrap').classList.toggle('hidden');

    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doStep(); }
    });
  }

  /* ---------- 启动 ---------- */
  renderCompat();
  bind();
  loadExample('lost');
})();
