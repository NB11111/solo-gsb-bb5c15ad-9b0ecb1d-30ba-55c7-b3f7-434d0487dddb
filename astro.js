'use strict';
/**
 * 天文计算与夜间序列调度核心模块。
 * 所有内部时间均使用毫秒时间戳 (UTC)，输出时转换为 ISO 字符串。
 */

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/* ---------------- 基础天文算法 ---------------- */

function jdOf(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

/** 格林尼治平恒星时（小时） */
function gmstHours(date) {
  const D = jdOf(date) - 2451545.0;
  return ((18.697374558 + 24.06570982441908 * D) % 24 + 24) % 24;
}

/** 地方恒星时（小时），经度东经为正 */
function lstHours(date, lonDeg) {
  return ((gmstHours(date) + lonDeg / 15) % 24 + 24) % 24;
}

/** 由赤经(时)、赤纬(度)、纬度(度)、恒星时(时) 计算高度角与方位角(度，北起东算) */
function altaz(raH, decD, latD, lstH) {
  const ha = (lstH - raH) * 15 * D2R;
  const dec = decD * D2R;
  const lat = latD * D2R;
  const sinAlt = Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(ha);
  const alt = Math.asin(Math.min(1, Math.max(-1, sinAlt)));
  const cosAz = (Math.sin(dec) - Math.sin(alt) * Math.sin(lat)) / (Math.cos(alt) * Math.cos(lat));
  let az = Math.acos(Math.min(1, Math.max(-1, cosAz)));
  if (Math.sin(ha) > 0) az = 2 * Math.PI - az;
  return { alt: alt * R2D, az: az * R2D };
}

/** 太阳视位置（低精度，足够暮光计算） */
function sunRaDec(date) {
  const n = jdOf(date) - 2451545.0;
  const L = (280.460 + 0.9856474 * n) * D2R;
  const g = ((357.528 + 0.9856003 * n) % 360) * D2R;
  const lambda = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
  const eps = (23.439 - 0.0000004 * n) * D2R;
  let ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) * R2D / 15;
  ra = ((ra % 24) + 24) % 24;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda)) * R2D;
  return { ra, dec };
}

function sunAltAt(t, lat, lon) {
  const s = sunRaDec(new Date(t));
  return altaz(s.ra, s.dec, lat, lstHours(new Date(t), lon)).alt;
}

/* ---------------- 地平线遮挡轮廓 ---------------- */

/** 按方位角线性插值地平线遮挡角。profile: [{az, alt}] 按 az 升序；空数组 = 0° 平直地平线 */
function horizonAlt(profile, az) {
  if (!profile || profile.length === 0) return 0;
  if (profile.length === 1) return profile[0].alt;
  az = ((az % 360) + 360) % 360;
  let i = 0;
  while (i < profile.length && profile[i].az <= az) i++;
  const p2 = profile[i % profile.length];
  const p1 = profile[(i - 1 + profile.length) % profile.length];
  let a1 = p1.az, a2 = p2.az, a = az;
  if (a2 <= a1) a2 += 360;
  if (a < a1) a += 360;
  if (a2 === a1) return p1.alt; // 重复方位角防御
  const f = (a - a1) / (a2 - a1);
  return p1.alt + f * (p2.alt - p1.alt);
}

/* ---------------- 黑夜边界 ---------------- */

function bisectSun(ta, tb, lat, lon, limit) {
  const da = sunAltAt(ta, lat, lon) < limit;
  let lo = ta, hi = tb;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const dm = sunAltAt(mid, lat, lon) < limit;
    if (dm === da) lo = mid; else hi = mid;
  }
  return hi;
}

/** 从 startT(毫秒) 起 24h 内最长的太阳高度低于 sunLimit 的区间；无则返回 null */
function findNight(startT, lat, lon, sunLimit) {
  const t1 = startT + 24 * HOUR;
  const step = 2 * MIN;
  const runs = [];
  let cur = null;
  let prevT = startT;
  if (sunAltAt(startT, lat, lon) < sunLimit) cur = { start: startT };
  for (let t = startT + step; t <= t1; t += step) {
    const dark = sunAltAt(t, lat, lon) < sunLimit;
    if (dark && !cur) {
      cur = { start: bisectSun(prevT, t, lat, lon, sunLimit) };
    } else if (!dark && cur) {
      cur.end = bisectSun(prevT, t, lat, lon, sunLimit);
      runs.push(cur);
      cur = null;
    }
    prevT = t;
  }
  if (cur) { cur.end = t1; runs.push(cur); }
  if (!runs.length) return null;
  runs.sort((a, b) => (b.end - b.start) - (a.end - a.start));
  return runs[0];
}

/* ---------------- 目标可见性 ---------------- */

function visibleAt(t, target, lat, lon, profile) {
  const { alt, az } = altaz(target.ra, target.dec, lat, lstHours(new Date(t), lon));
  const limit = Math.max(target.minAlt, horizonAlt(profile, az));
  return { alt, az, limit, ok: alt >= limit };
}

function bisectVisible(ta, tb, target, lat, lon, profile) {
  const oa = visibleAt(ta, target, lat, lon, profile).ok;
  let lo = ta, hi = tb;
  for (let i = 0; i < 25; i++) {
    const mid = (lo + hi) / 2;
    const om = visibleAt(mid, target, lat, lon, profile).ok;
    if (om === oa) lo = mid; else hi = mid;
  }
  return hi;
}

/** 目标在夜晚内的连续可见窗口（毫秒区间数组） */
function targetWindows(target, night, lat, lon, profile) {
  const step = MIN;
  const windows = [];
  let cur = null;
  let prevT = night.start;
  if (visibleAt(prevT, target, lat, lon, profile).ok) cur = { start: night.start };
  for (let t = night.start + step; t <= night.end; t += step) {
    const ok = visibleAt(t, target, lat, lon, profile).ok;
    if (ok && !cur) {
      cur = { start: bisectVisible(prevT, t, target, lat, lon, profile) };
    } else if (!ok && cur) {
      cur.end = bisectVisible(prevT, t, target, lat, lon, profile);
      windows.push(cur);
      cur = null;
    }
    prevT = t;
  }
  if (cur) { cur.end = night.end; windows.push(cur); }
  return windows;
}

/** 上中天（过子午线）时刻，赤道仪翻转点。恒星时近似线性推进 */
function meridianCrossings(target, night, lon) {
  const RATE = 1.00273790935; // 恒星时小时 / 平太阳时小时
  const res = [];
  const lst0 = lstHours(new Date(night.start), lon);
  const delta = ((target.ra - lst0) % 24 + 24) % 24;
  for (let k = 0; k < 2; k++) {
    const t = night.start + ((delta + 24 * k) / RATE) * HOUR;
    if (t > night.end) break;
    res.push(t);
  }
  return res;
}

/** 高度曲线采样（每 5 分钟），供前端绘图 */
function targetCurve(target, night, lat, lon, profile) {
  const pts = [];
  for (let t = night.start; t <= night.end; t += 5 * MIN) {
    const v = visibleAt(t, target, lat, lon, profile);
    pts.push({ t, alt: Math.round(v.alt * 10) / 10, limit: Math.round(v.limit * 10) / 10 });
  }
  return pts;
}

/* ---------------- 调度器 ---------------- */

/**
 * 贪心调度：按“最后窗口结束时间”升序（最早截止优先）依次把目标插入
 * 已排块之间的空档；相邻块之间必须留出转台 slew 时间；
 * 观测块跨过子午线翻转点时，块长增加 flip 耗时。
 */
function schedule(targets, night, opts) {
  const slewMs = opts.slewMin * MIN;
  const flipMs = opts.flipMin * MIN;
  const gem = opts.mount !== 'altaz';
  const placed = [];

  const order = targets
    .filter(t => t._windows.length > 0)
    .slice()
    .sort((a, b) => {
      const ea = a._windows[a._windows.length - 1].end;
      const eb = b._windows[b._windows.length - 1].end;
      return ea - eb || a.exposure - b.exposure;
    });

  for (const t of order) {
    const spot = findSpot(t, placed, night, slewMs, gem, flipMs);
    if (spot) {
      placed.push(spot);
      placed.sort((a, b) => a.start - b.start);
      t._block = spot;
    } else {
      t._block = null;
    }
  }
  return placed;
}

function findSpot(t, placed, night, slewMs, gem, flipMs) {
  const needMs = t.exposure * MIN;
  // 已排块膨胀 slew 后的空闲区间
  const free = [];
  let cursor = night.start;
  for (const b of placed) {
    free.push([cursor, b.start - slewMs]);
    cursor = b.end + slewMs;
  }
  free.push([cursor, night.end]);

  let best = null;
  for (const w of t._windows) {
    for (const [fa, fb] of free) {
      const a = Math.max(w.start, fa);
      const b = Math.min(w.end, fb);
      if (a >= b) continue;
      // 候选起点：区间起点，以及每个翻转点之后（落在另一侧可避开翻转耗时）
      const starts = [a];
      if (gem) for (const f of t._flips) if (f > a && f < b) starts.push(f);
      for (const s of starts) {
        let len = needMs;
        let flipAt = null;
        if (gem) {
          const f = t._flips.find(x => x > s && x < s + needMs);
          if (f) { len = needMs + flipMs; flipAt = f; }
        }
        if (s + len <= b) {
          const cand = { id: t.id, start: s, end: s + len, flipAt };
          if (!best || cand.end < best.end || (cand.end === best.end && cand.start < best.start)) {
            best = cand;
          }
        }
      }
    }
  }
  return best;
}

/* ---------------- 输入校验与计划构建 ---------------- */

function num(v, name, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${name} 无效（需在 ${min} ~ ${max} 之间）`);
  }
  return n;
}

const TWILIGHT = { civil: -6, nautical: -12, astro: -18 };

function buildPlan(body) {
  if (!body || typeof body !== 'object') throw new Error('请求体为空');
  const lat = num(body.lat, '纬度', -90, 90);
  const lon = num(body.lon, '经度', -180, 180);
  const slewMin = num(body.slewMin, '转台耗时', 0, 120);
  const flipMin = num(body.flipMin, '翻转耗时', 0, 120);
  const mount = body.mount === 'altaz' ? 'altaz' : 'gem';
  const twilight = TWILIGHT[body.twilight] !== undefined ? body.twilight : 'nautical';

  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date || '')) throw new Error('日期格式应为 YYYY-MM-DD');
  const noonUtc = Date.parse(body.date + 'T12:00:00Z');
  if (!Number.isFinite(noonUtc)) throw new Error('日期无效');

  const horizon = (Array.isArray(body.horizon) ? body.horizon : [])
    .slice(0, 200)
    .map(p => ({ az: num(p.az, '遮挡方位角', 0, 360), alt: num(p.alt, '遮挡高度角', 0, 90) }))
    .sort((a, b) => a.az - b.az);

  const rawTargets = Array.isArray(body.targets) ? body.targets : [];
  if (rawTargets.length === 0) throw new Error('至少需要一个目标');
  if (rawTargets.length > 100) throw new Error('目标数量过多（上限 100）');

  const targets = rawTargets.map((r, i) => ({
    id: i,
    name: String(r.name || `目标 ${i + 1}`).slice(0, 60),
    ra: num(r.ra, `目标 ${i + 1} 赤经`, 0, 24),
    dec: num(r.dec, `目标 ${i + 1} 赤纬`, -90, 90),
    exposure: num(r.exposure, `目标 ${i + 1} 曝光时长`, 1, 24 * 60),
    minAlt: num(r.minAlt, `目标 ${i + 1} 最低高度`, 0, 90),
  }));

  const night = findNight(noonUtc, lat, lon, TWILIGHT[twilight]);

  const result = {
    site: { lat, lon, date: body.date, slewMin, flipMin, mount, twilight },
    night: null,
    targets: [],
    sequence: [],
    unscheduled: [],
  };

  if (!night) {
    result.targets = targets.map(t => ({
      ...publicTarget(t),
      maxAlt: null, windows: [], flips: [], curve: [],
      scheduled: null,
      reason: '该日期当地无黑夜：太阳高度始终未低于所选暮光阈值',
    }));
    result.unscheduled = result.targets.map(t => ({ id: t.id, name: t.name, reason: t.reason }));
    return result;
  }

  result.night = {
    start: new Date(night.start).toISOString(),
    end: new Date(night.end).toISOString(),
    lstStart: Math.round(lstHours(new Date(night.start), lon) * 100) / 100,
    lstEnd: Math.round(lstHours(new Date(night.end), lon) * 100) / 100,
  };

  for (const t of targets) {
    t._windows = targetWindows(t, night, lat, lon, horizon);
    t._flips = meridianCrossings(t, night, lon);
    t._curve = targetCurve(t, night, lat, lon, horizon);
    t._maxAlt = t._curve.reduce((m, p) => Math.max(m, p.alt), -90);
  }

  schedule(targets, night, { slewMin, flipMin, mount });

  result.targets = targets.map(t => {
    let reason = null;
    if (!t._block) {
      const longest = t._windows.reduce((m, w) => Math.max(m, w.end - w.start), 0);
      if (t._windows.length === 0) {
        reason = t._maxAlt < t.minAlt
          ? `最高高度仅 ${t._maxAlt.toFixed(1)}°，低于最低高度要求 ${t.minAlt}°`
          : `受地平线遮挡角限制，目标始终未越过遮挡轮廓（最高高度 ${t._maxAlt.toFixed(1)}°）`;
      } else if (longest < t.exposure * MIN) {
        reason = `最长连续可见窗口 ${Math.round(longest / MIN)} 分钟，短于曝光需求 ${t.exposure} 分钟`;
      } else {
        reason = `可见窗口与已排目标冲突：计入转台 ${slewMin} 分钟耗时后无足够空档`;
      }
    }
    return {
      ...publicTarget(t),
      maxAlt: Math.round(t._maxAlt * 10) / 10,
      windows: t._windows.map(w => ({ start: iso(w.start), end: iso(w.end) })),
      flips: t._flips.map(iso),
      curve: t._curve.map(p => ({ t: iso(p.t), alt: p.alt, limit: p.limit })),
      scheduled: t._block
        ? { start: iso(t._block.start), end: iso(t._block.end), flipAt: t._block.flipAt ? iso(t._block.flipAt) : null }
        : null,
      reason,
    };
  });

  result.sequence = result.targets
    .filter(t => t.scheduled)
    .map(t => ({ id: t.id, name: t.name, ...t.scheduled }))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  result.unscheduled = result.targets
    .filter(t => !t.scheduled)
    .map(t => ({ id: t.id, name: t.name, reason: t.reason }));

  return result;
}

function iso(t) { return new Date(t).toISOString(); }

function publicTarget(t) {
  return { id: t.id, name: t.name, ra: t.ra, dec: t.dec, exposure: t.exposure, minAlt: t.minAlt };
}

module.exports = { buildPlan };
