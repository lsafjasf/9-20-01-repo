/* ============================================================
 * 事务隔离与死锁检测器 —— 界面控制（原生 JS，无第三方库）
 * ============================================================ */
(function () {
  'use strict';
  const $ = function (id) { return document.getElementById(id); };

  // 场景定义（唯一数据源）
  const setup = {
    txns: [],            // {id, iso}
    items: [],           // {name, value}
    policy: 'none',
    autoResolve: true,
    defaultIso: 'RC'
  };
  let scheduleText = '';
  let sch = null;        // 当前调度器
  let lastResult = null;
  let autoTimer = null;

  function currentSetup() {
    return {
      txns: setup.txns.map(function (t) { return { id: t.id, iso: t.iso }; }),
      items: setup.items.map(function (i) { return { name: i.name, value: i.value }; }),
      policy: $('policy').value,
      autoResolve: $('autoResolve').checked,
      defaultIso: setup.defaultIso
    };
  }

  function buildFromText(text, keepStep) {
    const parsed = DB.parseSchedule(text, setup.defaultIso);
    const cs = currentSetup();
    // 自动补充调度文本中出现、但场景定义里没有的事务
    parsed.txnIds.forEach(function (id) {
      if (!cs.txns.some(function (t) { return t.id === id; })) {
        cs.txns.push({ id: id, iso: setup.defaultIso });
        setup.txns.push({ id: id, iso: setup.defaultIso });
      }
    });
    sch = DB.buildScheduler(cs, parsed.ops);
    scheduleText = text;
    lastResult = null;
    render();
  }

  function loadExample(key) {
    const ex = DB.EXAMPLES[key];
    setup.txns = ex.setup.txns.map(function (t) { return { id: t.id, iso: t.iso }; });
    setup.items = ex.setup.items.map(function (i) { return { name: i.name, value: i.value }; });
    setup.policy = ex.setup.policy;
    setup.autoResolve = ex.setup.autoResolve;
    setup.defaultIso = ex.setup.defaultIso;
    $('policy').value = ex.setup.policy;
    $('autoResolve').checked = ex.setup.autoResolve;
    $('defIso').value = ex.setup.defaultIso;
    $('scheduleText').value = ex.text;
    $('exampleDesc').textContent = ex.desc;
    buildFromText(ex.text);
  }

  function resetCurrent() {
    if (scheduleText) buildFromText(scheduleText);
  }

  // ---------- 执行控制 ----------
  function doStep() {
    if (!sch) return;
    lastResult = sch.step();
    if (lastResult.status === 'finished') stopAuto();
    render();
  }

  function startAuto() {
    if (!sch || autoTimer) return;
    autoTimer = setInterval(function () {
      if (!sch) return stopAuto();
      lastResult = sch.step();
      if (lastResult.status === 'finished' ||
          (lastResult.status === 'deadlock' && !sch.state.autoResolve)) {
        stopAuto();
      }
      render();
    }, 700);
  }
  function stopAuto() { if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function renderSetupLists() {
    $('txnSetupList').innerHTML = setup.txns.map(function (t) {
      const opts = ['RU', 'RC', 'RR', 'SER'].map(function (lvl) {
        return '<option value="' + lvl + '"' + (t.iso === lvl ? ' selected' : '') + '>' + lvl + '</option>';
      }).join('');
      return '<div class="setup-item"><span class="name">' + esc(t.id) + '</span>' +
        '<select data-txn-iso="' + esc(t.id) + '">' + opts + '</select>' +
        '<button class="del" data-del-txn="' + esc(t.id) + '" title="删除">✕</button></div>';
    }).join('') || '<span class="empty-note">尚无事务</span>';

    $('itemSetupList').innerHTML = setup.items.map(function (i) {
      return '<div class="setup-item"><span class="name">' + esc(i.name) + '</span>' +
        '<span class="val">= ' + esc(i.value) + '</span>' +
        '<button class="del" data-del-item="' + esc(i.name) + '" title="删除" style="margin-left:auto">✕</button></div>';
    }).join('') || '<span class="empty-note">尚无数据项</span>';

    $('bTxn').innerHTML = setup.txns.map(function (t) {
      return '<option value="' + esc(t.id) + '">' + esc(t.id) + ' (' + t.iso + ')</option>';
    }).join('');
    $('bItem').innerHTML = setup.items.map(function (i) {
      return '<option value="' + esc(i.name) + '">' + esc(i.name) + '</option>';
    }).join('');
  }

  function renderTxns() {
    if (!sch) { $('txnList').innerHTML = '<span class="empty-note">点击“应用并重置”装载调度</span>'; return; }
    const s = sch.state;
    $('txnList').innerHTML = s.txnOrder.map(function (id) {
      const t = s.txns[id];
      const lockModes = Object.keys(t.locks).map(function (res) {
        const lab = DB.resourceLabel(res);
        return '<span class="holder-chip"><i class="lm ' + t.locks[res] + '">' + t.locks[res] +
          '</i><span style="font-size:10.5px;color:var(--muted)">' +
          (res === 'DB' ? 'DB' : res === 'T' ? 'T' : res.slice(2)) + '</span></span>';
      }).join(' ');
      let waits = '';
      if (t.waitsOn.length) {
        waits = '<span class="txn-wait">⛔ 等待: ' + t.waitsOn.map(function (r) {
          return r === 'DB' ? 'DB' : r === 'T' ? 'T' : r.slice(2);
        }).join(', ') + '</span>';
      }
      const stateText = { active: '活动', committed: '已提交', aborted: '已中止' }[t.status];
      return '<div class="txn-card">' +
        '<div class="txn-head"><span class="txn-id">' + esc(id) + '</span>' +
        '<span class="txn-iso">' + DB.ISO_LABEL[t.iso] + '</span>' +
        '<span class="txn-state ' + t.status + '">' + stateText +
        (t.status === 'active' ? ' · ts=' + t.ts : '') + '</span></div>' +
        '<div class="txn-detail"><span>持有锁: ' + (lockModes || '<span style="color:var(--muted)">无</span>') + '</span>' +
        (waits ? '<span>' + waits + '</span>' : '') + '</div></div>';
    }).join('');
  }

  function renderData() {
    if (!sch) { $('dataList').innerHTML = '<span class="empty-note">—</span>'; return; }
    const s = sch.state;
    $('dataList').innerHTML = Object.keys(s.items).map(function (name) {
      const item = s.items[name];
      const lockers = Object.keys(s.lockTable).filter(function (r) { return r === 'I:' + name; })
        .reduce(function (acc, r) {
          return acc.concat(s.lockTable[r].granted.map(function (g) {
            return '<span class="holder-chip"><i class="lm ' + g.mode + '">' + g.mode + '</i>' +
              '<span style="font-size:10.5px">' + esc(g.tid) + '</span></span>';
          }));
        }, []);
      const draft = item.draft != null
        ? ' <span class="ddraft">→ ' + esc(item.draft) + '（未提交）</span>' : '';
      return '<div class="data-row' + (item.deleted ? ' deleted' : '') + '">' +
        '<span class="dname">' + esc(name) + '</span>' +
        '<span class="dval">' + (item.deleted ? '已删除' : esc(item.value)) + '</span>' +
        draft +
        '<span class="dlocks">' + lockers.join('') + '</span></div>';
    }).join('');
  }

  function lockHolderChips(res) {
    const s = sch.state;
    const e = s.lockTable[res];
    if (!e) return '<span class="empty-note">空闲</span>';
    const granted = e.granted.map(function (g) {
      return '<span class="holder-chip"><i class="lm ' + g.mode + '">' + g.mode + '</i>' +
        '<span class="tid">' + esc(g.tid) + '</span></span>';
    }).join(' ');
    const waiting = e.queue.map(function (w) {
      return '<span class="wait-chip">' + esc(w.tid) + ' 申请 ' + w.mode + '</span>';
    }).join(' ');
    return '<span class="holders">' + granted + (granted && waiting ? ' ' : '') + waiting + '</span>' ||
      '<span class="empty-note">空闲</span>';
  }

  function renderLockTree() {
    if (!sch) { $('lockTree').innerHTML = '<span class="empty-note">—</span>'; return; }
    const s = sch.state;
    const itemRows = Object.keys(s.items).map(function (name) {
      return '<div class="ltree-node"><div class="ltree-row"><span class="res">数据项 ' + esc(name) +
        '</span>' + lockHolderChips('I:' + name) + '</div></div>';
    }).join('');
    $('lockTree').innerHTML =
      '<div class="ltree-node"><div class="ltree-row"><span class="res">数据库 DB</span>' +
      lockHolderChips('DB') + '</div>' +
      '<div class="ltree-children"><div class="ltree-node"><div class="ltree-row"><span class="res">表 T</span>' +
      lockHolderChips('T') + '</div>' +
      '<div class="ltree-children">' + itemRows + '</div></div></div></div></div>';
  }

  function renderGraph(cycleIds) {
    const svg = $('wfg');
    const W = 420, H = 280;
    if (!sch) { svg.innerHTML = ''; return; }
    const g = sch.waitForGraph();
    const ids = g.nodes.map(function (n) { return n.id; });
    const n = ids.length;

    let defs = '<defs><marker id="arrow" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto">' +
      '<path d="M0,0 L8,3 L0,6 Z" fill="#fbbf24"/></marker>' +
      '<marker id="arrowDead" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto">' +
      '<path d="M0,0 L8,3 L0,6 Z" fill="#ff6b6b"/></marker></defs>';

    if (n === 0) { svg.innerHTML = defs + '<text x="210" y="140" text-anchor="middle" fill="#93a1bd" font-size="13">无事务</text>'; return; }

    const cx = W / 2, cy = H / 2 + 6, R = Math.min(110, 30 + n * 26);
    const pos = {};
    ids.forEach(function (id, i) {
      const ang = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(n, 1);
      pos[id] = { x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang) };
    });

    const cycleSet = {};
    (cycleIds || []).forEach(function (id) { cycleSet[id] = true; });

    // 边（曲线，双向边向两侧弯曲）
    let edgesSvg = '';
    const edgeKey = {};
    g.edges.forEach(function (e, idx) {
      edgeKey[e.from + '>' + e.to] = idx;
    });
    g.edges.forEach(function (e) {
      const a = pos[e.from], b = pos[e.to];
      const inCycle = cycleSet[e.from] && cycleSet[e.to];
      let path, lx, ly;
      if (g.edges.some(function (o) { return o.from === e.to && o.to === e.from; })) {
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const dx = b.x - a.x, dy = b.y - a.y, L = Math.sqrt(dx * dx + dy * dy) || 1;
        const off = 26;
        const qx = mx + (-dy / L) * off, qy = my + (dx / L) * off;
        path = 'M' + a.x + ',' + a.y + ' Q' + qx + ',' + qy + ' ' + b.x + ',' + b.y;
        lx = mx + (-dy / L) * (off * 0.55); ly = my + (dx / L) * (off * 0.55);
      } else {
        const dx = b.x - a.x, dy = b.y - a.y, L = Math.sqrt(dx * dx + dy * dy) || 1;
        const ux = dx / L, uy = dy / L, gap = 30;
        const sx = a.x + ux * gap, sy = a.y + uy * gap, tx = b.x - ux * gap, ty = b.y - uy * gap;
        path = 'M' + sx + ',' + sy + ' L' + tx + ',' + ty;
        lx = (sx + tx) / 2; ly = (sy + ty) / 2 - 6;
      }
      const cls = inCycle ? 'wfg-edge dead' : 'wfg-edge';
      const marker = inCycle ? 'marker-end:url(#arrowDead)' : 'marker-end:url(#arrow)';
      edgesSvg += '<path d="' + path + '" class="' + cls + '" ' + (inCycle ? 'style="marker-end:url(#arrowDead)"' : '') + '/>' +
        '<text x="' + lx + '" y="' + ly + '" class="wfg-edge-label' + (inCycle ? ' edge-label-dead' : '') + '">' +
        esc(e.res) + '·' + e.mode + '</text>';
    });

    const nodesSvg = ids.map(function (id) {
      const t = sch.state.txns[id];
      const p = pos[id];
      const cls = 'wfg-node ' + t.status + (t.waitsOn.length ? ' waiting' : '');
      const sub = { active: (t.waitsOn.length ? 'WAITING' : 'active'), committed: 'committed', aborted: 'aborted' }[t.status];
      return '<g class="' + cls + '" transform="translate(' + p.x + ',' + p.y + ')">' +
        '<rect x="-26" y="-19" width="52" height="38" rx="8"/>' +
        '<text y="-4">' + esc(id) + '</text>' +
        '<text class="sub" y="11">' + sub + '</text></g>';
    }).join('');

    svg.innerHTML = defs + edgesSvg + nodesSvg;
  }

  function renderAnomalies() {
    if (!sch) { $('anomalyPanel').innerHTML = '<span class="empty-note">执行后此处展示检测到的异常</span>'; return; }
    const a = sch.state.anomalies;
    const order = ['dirtyRead', 'lostUpdate', 'unrepeatable', 'phantom', 'deadlock'];
    const items = [];
    order.forEach(function (kind) {
      a[kind].forEach(function (rec) {
        items.push('<div class="anom-item anom-' + kind + '"><b>[' + '步' + rec.step + '] ' +
          DB.ANOMALY_LABEL[kind] + '</b>' + esc(rec.text.replace(/^.*?：/, '')) + '</div>');
      });
    });
    $('anomalyPanel').innerHTML = items.join('') || '<span class="empty-note">尚未检测到异常 ✓</span>';
  }

  function renderLog() {
    if (!sch) { $('logList').innerHTML = ''; return; }
    $('logList').innerHTML = sch.state.log.map(function (l) {
      return '<div class="log-line t-' + l.type + '"><span class="log-step">' + l.step + '</span>' +
        '<span class="log-text">' + esc(l.text) + '</span>' +
        (l.tag && l.type === 'anomaly' ? '<span class="log-tag" style="color:var(--danger)">' + DB.ANOMALY_LABEL[l.tag] + '</span>' : '') +
        '</div>';
    }).join('');
    const box = $('logList');
    box.scrollTop = box.scrollHeight;
  }

  function renderStatus() {
    $('stepNo').textContent = sch ? sch.state.stepNo : 0;
    const pill = $('runStatus');
    if (!sch || !lastResult) { pill.textContent = ''; pill.className = 'status-pill'; return; }
    const map = {
      ok: ['已执行', 'ok'],
      blocked: ['有事务阻塞', 'blocked'],
      deadlock: ['检测到死锁!', 'deadlock'],
      finished: ['调度完成', 'finished']
    };
    const m = map[lastResult.status] || ['', ''];
    pill.textContent = m[0];
    pill.className = 'status-pill ' + m[1];
  }

  function render() {
    let cycleIds = null;
    if (sch) {
      // 若当前已构成死锁环，图中始终高亮（即便本步未新检测）
      const d = sch.detectDeadlock();
      cycleIds = d.cycle.length ? d.cycle : null;
    }
    renderSetupLists();
    renderTxns();
    renderData();
    renderLockTree();
    renderGraph(cycleIds);
    renderAnomalies();
    renderLog();
    renderStatus();
  }

  // ---------- 手动构造 ----------
  function opVerb(act) {
    return { read: 'R', write: 'W', scan: 'S', insert: 'I', delete: 'D', commit: 'C', rollback: 'A' }[act];
  }

  function refreshBuilderVisibility() {
    const act = $('bAct').value;
    const needsItem = ['read', 'write', 'insert', 'delete'].indexOf(act) >= 0;
    const needsValue = ['write', 'insert'].indexOf(act) >= 0;
    $('bItemWrap').style.display = needsItem ? '' : 'none';
    $('bValueWrap').style.display = needsValue ? '' : 'none';
  }

  // ---------- 事件 ----------
  document.querySelectorAll('[data-ex]').forEach(function (btn) {
    btn.addEventListener('click', function () { stopAuto(); loadExample(btn.getAttribute('data-ex')); });
  });
  $('applySchedule').addEventListener('click', function () { stopAuto(); buildFromText($('scheduleText').value); });
  $('stepBtn').addEventListener('click', function () { stopAuto(); doStep(); });
  $('runBtn').addEventListener('click', function () { autoTimer ? stopAuto() : startAuto(); });
  $('resetBtn').addEventListener('click', function () { stopAuto(); resetCurrent(); });
  $('policy').addEventListener('change', function () { stopAuto(); resetCurrent(); });
  $('autoResolve').addEventListener('change', function () { stopAuto(); resetCurrent(); });
  $('bAct').addEventListener('change', refreshBuilderVisibility);

  $('addTxnBtn').addEventListener('click', function () {
    let id = $('newTxnId').value.trim().toUpperCase();
    if (!id) id = 'T' + (setup.txns.length + 1);
    if (setup.txns.some(function (t) { return t.id === id; })) return;
    setup.txns.push({ id: id, iso: $('defIso').value });
    $('newTxnId').value = '';
    renderSetupLists();
  });
  $('addItemBtn').addEventListener('click', function () {
    const name = $('newItemName').value.trim().toUpperCase();
    if (!name || setup.items.some(function (i) { return i.name === name; })) return;
    setup.items.push({ name: name, value: $('newItemValue').value || '0' });
    $('newItemName').value = ''; $('newItemValue').value = '';
    renderSetupLists();
  });
  $('defIso').addEventListener('change', function () { setup.defaultIso = $('defIso').value; });

  document.addEventListener('click', function (ev) {
    const dt = ev.target.getAttribute('data-del-txn');
    const di = ev.target.getAttribute('data-del-item');
    if (dt) { setup.txns = setup.txns.filter(function (t) { return t.id !== dt; }); renderSetupLists(); }
    if (di) { setup.items = setup.items.filter(function (i) { return i.name !== di; }); renderSetupLists(); }
  });
  document.addEventListener('change', function (ev) {
    const id = ev.target.getAttribute('data-txn-iso');
    if (id) {
      const t = setup.txns.find(function (x) { return x.id === id; });
      if (t) t.iso = ev.target.value;
    }
  });

  $('bAdd').addEventListener('click', function () {
    const tid = $('bTxn').value;
    if (!tid) return;
    const act = $('bAct').value;
    let tok = tid + ':' + opVerb(act);
    if (['read', 'write', 'insert', 'delete'].indexOf(act) >= 0) {
      const item = ($('bItem').value || '').trim();
      if (!item) return;
      tok += '(' + item;
      if (act === 'write' || act === 'insert') tok += ',' + ($('bValue').value || '0');
      tok += ')';
    }
    const ta = $('scheduleText');
    ta.value = (ta.value.trim() ? ta.value.trim() + ' ' : '') + tok;
  });

  // 启动：默认载入“脏读”示例
  loadExample('dirtyRead');
  refreshBuilderVisibility();
})();
