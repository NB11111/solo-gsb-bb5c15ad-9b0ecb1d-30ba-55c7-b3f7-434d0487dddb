'use strict';
const express = require('express');
const path = require('path');
const { buildPlan } = require('./astro');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/** 启动即内置的示例站点、地平线轮廓与目标 */
const SAMPLES = {
  site: {
    lat: 40.4,          // 纬度（度，北正）
    lon: 116.6,         // 经度（度，东正）—— 近北京密云观测站
    slewMin: 3,         // 目标间转台耗时（分钟）
    flipMin: 5,         // 过子午线翻转耗时（分钟）
    mount: 'gem',       // gem = 赤道仪（需翻转）, altaz = 经纬仪
    twilight: 'nautical',
  },
  horizon: [
    { az: 0, alt: 4 }, { az: 30, alt: 7 }, { az: 60, alt: 12 }, { az: 90, alt: 16 },
    { az: 120, alt: 10 }, { az: 150, alt: 6 }, { az: 180, alt: 3 }, { az: 210, alt: 2 },
    { az: 240, alt: 5 }, { az: 270, alt: 9 }, { az: 300, alt: 13 }, { az: 330, alt: 8 },
  ],
  targets: [
    { name: 'M31 仙女座星系', ra: 0.712, dec: 41.27, exposure: 45, minAlt: 25 },
    { name: 'M33 三角座星系', ra: 1.564, dec: 30.66, exposure: 50, minAlt: 25 },
    { name: 'NGC 869 双重星团', ra: 2.319, dec: 57.13, exposure: 35, minAlt: 30 },
    { name: 'M45 昴星团', ra: 3.790, dec: 24.12, exposure: 40, minAlt: 25 },
    { name: 'M1 蟹状星云', ra: 5.576, dec: 22.01, exposure: 30, minAlt: 20 },
    { name: 'M42 猎户座大星云', ra: 5.588, dec: -5.39, exposure: 30, minAlt: 20 },
    { name: 'NGC 2244 玫瑰星云', ra: 6.532, dec: 4.94, exposure: 35, minAlt: 20 },
    { name: '南天低纬目标(演示不可排)', ra: 5.0, dec: -62.0, exposure: 20, minAlt: 15 },
    { name: '超长曝光目标(演示不可排)', ra: 2.5, dec: 60.0, exposure: 600, minAlt: 20 },
  ],
};

app.get('/api/samples', (req, res) => {
  res.json(SAMPLES);
});

app.post('/api/plan', (req, res) => {
  try {
    res.json(buildPlan(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`望远镜夜间序列规划台已启动: http://localhost:${PORT}`);
});
