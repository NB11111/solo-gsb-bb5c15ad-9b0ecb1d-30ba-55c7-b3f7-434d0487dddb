'use strict';
/* 望远镜夜间序列规划台 —— 前端逻辑 */

const $ = s => document.querySelector(s);
const MIN = 60 * 1000;

const state = {
  targets: [],          // {name, ra, dec, exposure, minAlt}
  horizon: [],          // [{az, alt}] 按 az 升序
  plan: null,           // 后端返回的计划
  selected: -1,         // 当前选中目标 id
  view: { t0: 0, t1: 0 }, // 时间轴可视范围（毫秒）
};

const SAMPLE_RIDGE = [
  { az: 0, alt: 4 }, { az: 30, alt: 7 }, { az: 60, alt: 12 }, { az: 90, alt: 16 },
  { az: 120, alt: 10 }, { az: 150, alt: 6 }, { az: 180, alt: 3 }, { az: 210, alt: 2 },
  { az: 240, alt: 5 }, { az: 270, alt: 9 }, { az: 300, alt: 13 }, { az: 330, alt: 8 },
];

/* ---------------- 工具 ---------------- */

function fmtT(ms) { return new Date(ms).toISOString().slice(11, 16); }
function fmtDT(ms) { return new Date(ms).toISOString().slice(5, 16).replace('T', ' '); }

/** 按设备像素比初始化画布，返回 {ctx, w, h}（CSS 像素坐标系） */
function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/** 选择合适的时间刻度间隔 */
function tickStep(rangeMs) {
  const steps = [5, 10, 15, 30, 60, 120, 180, 360, 720].map(m => m * MIN);
  for (const s of steps) if (rangeMs / s <= 14) return s;
  return 1440 * MIN;
}

function drawTimeAxis(ctx, x0, x1, y, view, color) {
  const step = tickStep(view.t1 - view.t0);
  const first = Math.ceil(view.t0 / step) * step;
  ctx.font = '11px sans-serif';
  ctx.fillStyle = color || '#8a96c0';
  ctx.strokeStyle = '#2a3560';
  ctx.textAlign = 'center';
  for (let t = first; t <= view.t1; t += step) {
    const x = x0 + (t - view.t0) / (view.t1 - view.t0) * (x1 - x0);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 5); ctx.stroke();
    ctx.fillText(fmtT(t), x, y + 16);
  }
}

/* ---------------- 目标表格 ---------------- */

function renderTargets() {
  const tbody = $('#targetTable tbody');
  tbody.innerHTML = '';
  state.targets.forEach((t, i) => {
    const tr = document.createElement('tr');
    if (i === state.selected) tr.className = 'sel';
    tr.innerHTML =
      `<td><input name="name" value="${escapeHtml(t.name)}"></td>` +
      `<td><input type="number" step="0.001" min="0" max="24" value="${t.ra}"></td>` +
      `<td><input type="number" step="0.01" min="-90" max="90" value="${t.dec}"></td>` +
      `<td><input type="number" step="1" min="1" value="${t.exposure}"></td>` +
      `<td><input type="number" step="1" min="0" max="90" value="${t.minAlt}"></td>` +
      `<td><button class="del" title="删除">✕</button></td>`;
    const inputs = tr.querySelectorAll('input');
    inputs[0].addEventListener('input', e => { t.name = e.target.value; });
    inputs[1].addEventListener('input', e => { t.ra = +e.target.value; });
    inputs[2].addEventListener('input', e => { t.dec = +e.target.value; });
    inputs[3].addEventListener('input', e => { t.exposure = +e.target.value; });
    inputs[4].addEventListener('input', e => { t.minAlt = +e.target.value; });
    tr.querySelector('.del').addEventListener('click', e => {
      e.stopPropagation();
      state.targets.splice(i, 1);
      if (state.selected === i) state.selected = -1;
      renderTargets();
    });
    tr.addEventListener('click', () => { selectTarget(i); });
    tbody.appendChild(tr);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- 地平线编辑器 ---------------- */

const horizonCv = () => $('#horizonCanvas');

function drawHorizon() {
  const { ctx, w, h } = setupCanvas(horizonCv());
  const padL = 34, padR = 8, padT = 8, padB = 20;
  const x0 = padL, x1 = w - padR, y0 = padT, y1 = h - padB;
  const X = az => x0 + az / 360 * (x1 - x0);
  const Y = alt => y1 - alt / 90 * (y1 - y0);

  ctx.strokeStyle = '#2a3560';
  ctx.fillStyle = '#8a96c0';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  for (let az = 0; az <= 360; az += 60) {
    ctx.beginPath(); ctx.moveTo(X(az), y0); ctx.lineTo(X(az), y1); ctx.stroke();
    ctx.fillText(az + '°', X(az), y1 + 13);
  }
  ctx.textAlign = 'right';
  for (let a = 0; a <= 90; a += 30) {
    ctx.beginPath(); ctx.moveTo(x0, Y(a)); ctx.lineTo(x1, Y(a)); ctx.stroke();
    ctx.fillText(a + '°', x0 - 4, Y(a) + 3);
  }

  // 遮挡区域填充（闭合到 0° 底线，含 360° 环绕）
  const pts = state.horizon;
  ctx.beginPath();
  ctx.moveTo(X(0), Y(0));
  if (pts.length === 0) {
    ctx.lineTo(X(360), Y(0));
  } else {
    for (const p of pts) ctx.lineTo(X(p.az), Y(p.alt));
    ctx.lineTo(X(360), Y(pts[pts.length - 1].alt));
    ctx.lineTo(X(360), Y(0));
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(255, 179, 71, 0.18)';
  ctx.fill();
  ctx.strokeStyle = '#ffb347';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (pts.length > 0) {
    ctx.moveTo(X(0), Y(pts[0].alt));
    for (const p of pts) ctx.lineTo(X(p.az), Y(p.alt));
    ctx.lineTo(X(360), Y(pts[pts.length - 1].alt));
  } else {
    ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(360), Y(0));
  }
  ctx.stroke();
  ctx.lineWidth = 1;

  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(X(p.az), Y(p.alt), 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffb347';
    ctx.fill();
  }
}

function horizonPos(e) {
  const cv = horizonCv();
  const r = cv.getBoundingClientRect();
  const padL = 34, padR = 8, padT = 8, padB = 20;
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const az = Math.min(360, Math.max(0, (x - padL) / (r.width - padL - padR) * 360));
  const alt = Math.min(90, Math.max(0, (1 - (y - padT) / (r.height - padT - padB)) * 90));
  return { az, alt, x, y };
}

function nearestHorizonPt(pos) {
  const cv = horizonCv();
  const r = cv.getBoundingClientRect();
  const padL = 34, padR = 8, padT = 8, padB = 20;
  let best = -1, bestD = 12;
  state.horizon.forEach((p, i) => {
    const px = padL + p.az / 360 * (r.width - padL - padR);
    const py = padT + (1 - p.alt / 90) * (r.height - padT - padB);
    const d = Math.hypot(px - pos.x, py - pos.y);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

function initHorizonEditor() {
  const cv = horizonCv();
  let dragPt = null; // 拖动中的点对象引用（排序后依然有效）
  cv.addEventListener('mousedown', e => {
    const pos = horizonPos(e);
    const idx = nearestHorizonPt(pos);
    if (idx >= 0) {
      dragPt = state.horizon[idx];
    } else {
      dragPt = { az: Math.round(pos.az * 10) / 10, alt: Math.round(pos.alt * 10) / 10 };
      state.horizon.push(dragPt);
      state.horizon.sort((a, b) => a.az - b.az);
      drawHorizon();
    }
  });
  cv.addEventListener('mousemove', e => {
    if (!dragPt) return;
    const pos = horizonPos(e);
    dragPt.az = Math.round(pos.az * 10) / 10;
    dragPt.alt = Math.round(pos.alt * 10) / 10;
    state.horizon.sort((a, b) => a.az - b.az);
    drawHorizon();
  });
  window.addEventListener('mouseup', () => { dragPt = null; });
  cv.addEventListener('contextmenu', e => {
    e.preventDefault();
    const idx = nearestHorizonPt(horizonPos(e));
    if (idx >= 0) { state.horizon.splice(idx, 1); drawHorizon(); }
  });
  $('#btnFlat').addEventListener('click', () => { state.horizon = []; drawHorizon(); });
  $('#btnRidge').addEventListener('click', () => { state.horizon = SAMPLE_RIDGE.map(p => ({ ...p })); drawHorizon(); });
}

/* ---------------- 计划生成 ---------------- */

function collectSite() {
  return {
    lat: +$('#lat').value,
    lon: +$('#lon').value,
    date: $('#date').value,
    twilight: $('#twilight').value,
    slewMin: +$('#slewMin').value,
    flipMin: +$('#flipMin').value,
    mount: $('#mount').value,
  };
}

async function generate() {
  $('#err').textContent = '';
  const body = { ...collectSite(), horizon: state.horizon, targets: state.targets };
  let plan;
  try {
    const r = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    plan = await r.json();
    if (plan.error) { $('#err').textContent = plan.error; return; }
  } catch (e) {
    $('#err').textContent = '请求失败：' + e.message;
    return;
  }
  state.plan = plan;
  if (plan.night) {
    state.view = { t0: Date.parse(plan.night.start), t1: Date.parse(plan.night.end) };
  }
  const firstSched = plan.targets.findIndex(t => t.scheduled);
  state.selected = firstSched >= 0 ? firstSched : (plan.targets.length ? 0 : -1);
  renderAll();
}

function renderAll() {
  renderNightInfo();
  drawTimeline();
  drawCurve();
  renderSequence();
  renderUnscheduled();
  renderTargets();
}

function renderNightInfo() {
  const p = state.plan;
  if (!p) { $('#nightInfo').textContent = ''; return; }
  if (!p.night) {
    $('#nightInfo').textContent = '该日期无黑夜，无法规划';
    return;
  }
  const n = p.night;
  const twName = { civil: '民用', nautical: '航海', astro: '天文' }[p.site.twilight];
  $('#nightInfo').textContent =
    `黑夜(${twName}暮光) ${fmtT(Date.parse(n.start))} – ${fmtT(Date.parse(n.end))} UTC · ` +
    `恒星时 ${n.lstStart}h → ${n.lstEnd}h · 排入 ${p.sequence.length}/${p.targets.length} 个目标`;
}

/* ---------------- 时间轴 ---------------- */

const GUTTER = 150, AXIS_H = 26, ROW_H = 30;

function drawTimeline() {
  const cv = $('#timeline');
  const p = state.plan;
  if (p && p.night) {
    cv.style.height = Math.max(320, AXIS_H + p.targets.length * ROW_H + 12) + 'px';
  }
  const { ctx, w, h } = setupCanvas(cv);
  ctx.fillStyle = '#8a96c0';
  ctx.font = '12px sans-serif';
  if (!p || !p.night) {
    ctx.textAlign = 'center';
    ctx.fillText(p && !p.night ? '该日期无黑夜' : '请设置站点与目标后点击「生成观测计划」', w / 2, h / 2);
    return;
  }
  const view = state.view;
  const x0 = GUTTER, x1 = w - 10;
  const X = t => x0 + (t - view.t0) / (view.t1 - view.t0) * (x1 - x0);

  drawTimeAxis(ctx, x0, x1, AXIS_H - 8, view);

  p.targets.forEach((t, i) => {
    const y = AXIS_H + i * ROW_H;
    // 行分隔与名称
    ctx.strokeStyle = '#1e2848';
    ctx.beginPath(); ctx.moveTo(0, y + ROW_H); ctx.lineTo(w, y + ROW_H); ctx.stroke();
    ctx.fillStyle = i === state.selected ? '#4da3ff' : (t.scheduled ? '#dbe4ff' : '#6a7494');
    ctx.textAlign = 'left';
    ctx.fillText(t.name.slice(0, 14), 8, y + ROW_H / 2 + 4);
    if (i === state.selected) {
      ctx.fillStyle = 'rgba(77,163,255,0.08)';
      ctx.fillRect(0, y, w, ROW_H);
    }
    const cy = y + ROW_H / 2;
    const barH = 12;
    // 可见窗口
    ctx.fillStyle = 'rgba(53,196,111,0.28)';
    for (const win of t.windows) {
      const a = Date.parse(win.start), b = Date.parse(win.end);
      if (b < view.t0 || a > view.t1) continue;
      ctx.fillRect(Math.max(X(a), x0), cy - barH / 2, Math.min(X(b), x1) - Math.max(X(a), x0), barH);
    }
    // 已排观测块
    if (t.scheduled) {
      const a = Date.parse(t.scheduled.start), b = Date.parse(t.scheduled.end);
      ctx.fillStyle = '#35c46f';
      ctx.fillRect(X(a), cy - barH / 2, Math.max(X(b) - X(a), 2), barH);
      if (t.scheduled.flipAt) {
        const f = Date.parse(t.scheduled.flipAt);
        ctx.fillStyle = '#ff5a6a';
        ctx.beginPath();
        ctx.moveTo(X(f), cy - barH / 2 - 7);
        ctx.lineTo(X(f) - 5, cy - barH / 2);
        ctx.lineTo(X(f) + 5, cy - barH / 2);
        ctx.closePath(); ctx.fill();
      }
    } else {
      // 未排入标记
      ctx.fillStyle = '#3a4468';
      ctx.fillRect(x0 + 2, cy - 2, 8, 4);
    }
    // 翻转点（窗口内）
    ctx.fillStyle = 'rgba(255,90,106,0.55)';
    for (const f of t.flips) {
      const fm = Date.parse(f);
      if (fm < view.t0 || fm > view.t1) continue;
      ctx.fillRect(X(fm) - 1, cy - barH / 2 - 4, 2, barH + 8);
    }
  });
}

function initTimeline() {
  const cv = $('#timeline');
  let dragging = false, moved = 0, lastX = 0;

  cv.addEventListener('mousedown', e => {
    dragging = true; moved = 0; lastX = e.clientX;
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    lastX = e.clientX;
    moved += Math.abs(dx);
    const range = state.view.t1 - state.view.t0;
    const px = cv.clientWidth - GUTTER - 10;
    const dt = -dx / px * range;
    state.view.t0 += dt; state.view.t1 += dt;
    drawTimeline(); drawCurve();
  });
  window.addEventListener('mouseup', e => {
    if (dragging && moved < 4 && state.plan && state.plan.night) {
      // 视为点击：命中目标行则选中
      const r = cv.getBoundingClientRect();
      const y = e.clientY - r.top;
      const idx = Math.floor((y - AXIS_H) / ROW_H);
      if (idx >= 0 && idx < state.plan.targets.length) selectTarget(idx);
    }
    dragging = false;
  });
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    if (!state.plan || !state.plan.night) return;
    const r = cv.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left - GUTTER) / (r.width - GUTTER - 10)));
    const v = state.view;
    const center = v.t0 + frac * (v.t1 - v.t0);
    const f = e.deltaY > 0 ? 1.2 : 1 / 1.2;
    v.t0 = center - (center - v.t0) * f;
    v.t1 = center + (v.t1 - center) * f;
    if (v.t1 - v.t0 > 36 * 3600 * 1000) { const m = (v.t0 + v.t1) / 2; v.t0 = m - 18 * 3600e3; v.t1 = m + 18 * 3600e3; }
    if (v.t1 - v.t0 < 10 * MIN) { const m = (v.t0 + v.t1) / 2; v.t0 = m - 5 * MIN; v.t1 = m + 5 * MIN; }
    drawTimeline(); drawCurve();
  }, { passive: false });

  $('#btnFit').addEventListener('click', () => {
    if (!state.plan || !state.plan.night) return;
    state.view = { t0: Date.parse(state.plan.night.start), t1: Date.parse(state.plan.night.end) };
    drawTimeline(); drawCurve();
  });
}

function selectTarget(i) {
  state.selected = i;
  drawTimeline();
  drawCurve();
  renderTargets();
}

/* ---------------- 高度曲线 ---------------- */

function drawCurve() {
  const cv = $('#curve');
  const { ctx, w, h } = setupCanvas(cv);
  const p = state.plan;
  ctx.fillStyle = '#8a96c0';
  ctx.font = '12px sans-serif';
  if (!p || !p.night || state.selected < 0 || !p.targets[state.selected]) {
    ctx.textAlign = 'center';
    ctx.fillText('点击时间轴或表格中的目标查看高度曲线', w / 2, h / 2);
    $('#curveInfo').textContent = '';
    return;
  }
  const t = p.targets[state.selected];
  $('#curveInfo').textContent =
    `${t.name} · 赤经 ${t.ra}h 赤纬 ${t.dec}° · 最高高度 ${t.maxAlt}°` +
    (t.flips.length ? ` · 翻转点 ${t.flips.map(f => fmtT(Date.parse(f))).join(', ')} UTC` : '');

  const padL = 40, padR = 12, padT = 10, padB = 24;
  const x0 = padL, x1 = w - padR, y0 = padT, y1 = h - padB;
  const view = state.view;
  const X = ms => x0 + (ms - view.t0) / (view.t1 - view.t0) * (x1 - x0);
  const ALT_MIN = -10, ALT_MAX = 90;
  const Y = alt => y1 - (alt - ALT_MIN) / (ALT_MAX - ALT_MIN) * (y1 - y0);

  // 网格
  ctx.strokeStyle = '#2a3560';
  ctx.fillStyle = '#8a96c0';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  for (let a = 0; a <= 90; a += 15) {
    ctx.beginPath(); ctx.moveTo(x0, Y(a)); ctx.lineTo(x1, Y(a)); ctx.stroke();
    ctx.fillText(a + '°', x0 - 4, Y(a) + 3);
  }
  drawTimeAxis(ctx, x0, x1, y1 + 4, view);

  // 可见窗口底色
  ctx.fillStyle = 'rgba(53,196,111,0.12)';
  for (const win of t.windows) {
    const a = Date.parse(win.start), b = Date.parse(win.end);
    ctx.fillRect(Math.max(X(a), x0), y0, Math.min(X(b), x1) - Math.max(X(a), x0), y1 - y0);
  }
  // 已排观测块
  if (t.scheduled) {
    const a = Date.parse(t.scheduled.start), b = Date.parse(t.scheduled.end);
    ctx.fillStyle = 'rgba(53,196,111,0.35)';
    ctx.fillRect(X(a), y0, Math.max(X(b) - X(a), 2), y1 - y0);
  }

  const curve = t.curve.map(c => ({ t: Date.parse(c.t), alt: c.alt, limit: c.limit }));

  // 遮挡/最低高度限制线
  ctx.strokeStyle = '#ffb347';
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  curve.forEach((c, i) => { const x = X(c.t), y = Y(c.limit); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
  ctx.setLineDash([]);

  // 高度曲线
  ctx.strokeStyle = '#4da3ff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  curve.forEach((c, i) => { const x = X(c.t), y = Y(c.alt); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
  ctx.lineWidth = 1;

  // 翻转点
  ctx.strokeStyle = '#ff5a6a';
  ctx.fillStyle = '#ff5a6a';
  for (const f of t.flips) {
    const fm = Date.parse(f);
    if (fm < view.t0 || fm > view.t1) continue;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(X(fm), y0); ctx.lineTo(X(fm), y1); ctx.stroke();
    ctx.setLineDash([]);
    ctx.textAlign = 'left';
    ctx.fillText('翻转 ' + fmtT(fm), X(fm) + 4, y0 + 12);
  }

  // 图例
  ctx.textAlign = 'left';
  ctx.fillStyle = '#4da3ff'; ctx.fillText('— 高度', x0 + 8, y0 + 14);
  ctx.fillStyle = '#ffb347'; ctx.fillText('–– 限制(最低高度/遮挡)', x0 + 60, y0 + 14);
}

/* ---------------- 结果列表 ---------------- */

function renderSequence() {
  const p = state.plan;
  const tbody = $('#seqTable tbody');
  tbody.innerHTML = '';
  if (!p) { $('#seqInfo').textContent = ''; return; }
  const totalExp = p.sequence.reduce((s, b) => {
    const t = p.targets.find(x => x.id === b.id);
    return s + (t ? t.exposure : 0);
  }, 0);
  $('#seqInfo').textContent = p.sequence.length
    ? `共 ${p.sequence.length} 个目标 · 总曝光 ${totalExp} 分钟`
    : '无';
  p.sequence.forEach((b, i) => {
    const tr = document.createElement('tr');
    const a = Date.parse(b.start), e = Date.parse(b.end);
    tr.innerHTML =
      `<td>${i + 1}</td><td>${escapeHtml(b.name)}</td>` +
      `<td>${fmtDT(a)}</td><td>${fmtDT(e)}</td>` +
      `<td>${Math.round((e - a) / MIN)} min</td>` +
      `<td>${b.flipAt ? fmtT(Date.parse(b.flipAt)) + ' UTC' : '—'}</td>`;
    tr.addEventListener('click', () => selectTarget(b.id));
    tbody.appendChild(tr);
  });
}

function renderUnscheduled() {
  const p = state.plan;
  const ul = $('#unschedList');
  ul.innerHTML = '';
  if (!p) return;
  if (!p.unscheduled.length) {
    const li = document.createElement('li');
    li.className = 'ok';
    li.textContent = '✓ 全部目标均已排入';
    ul.appendChild(li);
    return;
  }
  for (const u of p.unscheduled) {
    const li = document.createElement('li');
    li.innerHTML = `<b>${escapeHtml(u.name)}</b>：<span class="reason">${escapeHtml(u.reason)}</span>`;
    ul.appendChild(li);
  }
}

/* ---------------- 初始化 ---------------- */

async function loadSamples() {
  const r = await fetch('/api/samples');
  const d = await r.json();
  $('#lat').value = d.site.lat;
  $('#lon').value = d.site.lon;
  $('#slewMin').value = d.site.slewMin;
  $('#flipMin').value = d.site.flipMin;
  $('#mount').value = d.site.mount;
  $('#twilight').value = d.site.twilight;
  state.targets = d.targets.map(t => ({ ...t }));
  state.horizon = d.horizon.map(p => ({ ...p }));
  renderTargets();
  drawHorizon();
}

function init() {
  $('#date').value = new Date().toISOString().slice(0, 10);
  $('#btnAdd').addEventListener('click', () => {
    state.targets.push({ name: `目标 ${state.targets.length + 1}`, ra: 0, dec: 0, exposure: 30, minAlt: 20 });
    renderTargets();
  });
  $('#btnPlan').addEventListener('click', generate);
  $('#btnSamples').addEventListener('click', loadSamples);
  initHorizonEditor();
  initTimeline();
  window.addEventListener('resize', () => {
    drawHorizon();
    if (state.plan) { drawTimeline(); drawCurve(); }
  });
  loadSamples().then(() => {
    drawTimeline();
    drawCurve();
  });
}

init();
