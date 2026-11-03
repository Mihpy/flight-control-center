/* =============================================================================
   views.js — отрисовка на canvas.

   Три независимых рисунка:
     plot()   линейный график параметров во времени;
     matrix() карта достоверности полей по последним пакетам;
     scene()  трёхмерная модель спутника и связанная СК.

   Никаких библиотек: примитивы canvas и арифметика матриц.
   ========================================================================== */
'use strict';

window.CU = window.CU || {};

CU.Views = (function () {

  const FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

  /* Значения CSS-переменных нужно читать в момент отрисовки: тема
     переключается на лету, цвета должны меняться вместе с ней.         */
  function tokens() {
    const style = getComputedStyle(document.documentElement);
    const read = name => style.getPropertyValue(name).trim();
    return {
      ink: read('--ink'),
      ink3: read('--ink-3'),
      rule: read('--rule'),
      rule2: read('--rule-2'),
      paper: read('--paper'),
      surface: read('--surface'),
      ok: read('--ok'),
      warn: read('--warn'),
      bad: read('--bad'),
      series: [read('--c1'), read('--c2'), read('--c3'), read('--c4')],
      /* Заливка аппарата хранится тройкой чисел через запятую — так
         затенение грани просто умножает каналы. */
      model: {
        body: read('--body').split(',').map(Number),
        panel: read('--panel').split(',').map(Number),
      },
      edge: read('--edge'),
    };
  }

  /* Приводит размер полотна к пикселям устройства. Возвращает контекст
     и размер в CSS-пикселях; вызывать перед каждой отрисовкой.        */
  function prepare(canvas) {
    const box = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(box.width));
    const height = Math.max(1, Math.round(box.height));
    if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
      canvas.width = width * ratio;
      canvas.height = height * ratio;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.textBaseline = 'middle';
    return { ctx, width, height };
  }

  function withAlpha(color, alpha) {
    const hex = color.replace('#', '');
    const full = hex.length === 3 ? hex.split('').map(c => c + c).join('') : hex;
    const number = parseInt(full, 16);
    const r = (number >> 16) & 255, g = (number >> 8) & 255, b = number & 255;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  /* ── Линейный график ──────────────────────────────────────────────────
     model = {
       series: [{ label, points:[y|null], color, dash, hidden }],
       unit, digits, band:[lo,hi]|null, thresholds:[{value,level,label}],
       xLeft, xRight, empty
     }
     Точки с null не соединяются: разрыв показывает, что данных не было,
     иначе график врёт.                                                  */
  const PAD = { left: 54, right: 14, top: 12, bottom: 24 };

  function plot(canvas, model) {
    const { ctx, width, height } = prepare(canvas);
    const t = tokens();
    const plotWidth = width - PAD.left - PAD.right;
    const plotHeight = height - PAD.top - PAD.bottom;

    ctx.font = '10.5px ' + FONT;
    ctx.textAlign = 'right';

    const visible = model.series.filter(s => !s.hidden);
    const values = [];
    for (const item of visible) {
      for (const value of item.points) if (value !== null && isFinite(value)) values.push(value);
    }

    if (!values.length) {
      ctx.fillStyle = t.ink3;
      ctx.textAlign = 'center';
      ctx.fillText(model.empty || 'Нет данных', width / 2, height / 2);
      return;
    }

    let lo = Math.min.apply(null, values);
    let hi = Math.max.apply(null, values);
    if (model.band) { lo = Math.min(lo, model.band[0]); hi = Math.max(hi, model.band[1]); }
    if (model.thresholds) {
      for (const line of model.thresholds) { lo = Math.min(lo, line.value); hi = Math.max(hi, line.value); }
    }
    if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.1;
    lo -= pad; hi += pad;

    const count = Math.max.apply(null, model.series.map(s => s.points.length));
    const X = i => PAD.left + (count < 2 ? 0 : plotWidth * i / (count - 1));
    const Y = value => PAD.top + plotHeight * (1 - (value - lo) / (hi - lo));

    /* Полоса рабочего диапазона — подсказка «здесь норма» */
    if (model.band) {
      ctx.fillStyle = withAlpha(t.ok, 0.07);
      const top = Y(model.band[1]), bottom = Y(model.band[0]);
      ctx.fillRect(PAD.left, top, plotWidth, bottom - top);
    }

    /* Горизонтальная сетка: четыре линии и подписи значений */
    ctx.strokeStyle = t.rule;
    ctx.lineWidth = 1;
    ctx.fillStyle = t.ink3;
    ctx.textAlign = 'right';
    const digits = model.digits === undefined ? 2 : model.digits;
    for (let i = 0; i <= 3; i++) {
      const value = hi - (hi - lo) * i / 3;
      const y = Math.round(Y(value)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(PAD.left + plotWidth, y);
      ctx.stroke();
      ctx.fillText(value.toFixed(digits), PAD.left - 8, y);
    }

    /* Пороги: волосяная линия и подпись справа */
    for (const line of model.thresholds || []) {
      const color = line.level === 2 ? t.bad : line.level === 1 ? t.warn : t.ok;
      const y = Math.round(Y(line.value)) + 0.5;
      ctx.save();
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = withAlpha(color, 0.85);
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(PAD.left + plotWidth, y);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = color;
      ctx.textAlign = 'left';
      ctx.fillText(line.label, PAD.left + 4, y - 7);
      ctx.textAlign = 'right';
    }

    /* Линии рядов */
    for (const item of visible) {
      const color = t.series[item.color % t.series.length];
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.lineJoin = 'round';
      if (item.dash) ctx.setLineDash([5, 3]);
      ctx.beginPath();
      let started = false;
      item.points.forEach((value, i) => {
        if (value === null || !isFinite(value)) { started = false; return; }
        const x = X(i), y = Y(value);
        if (started) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        started = true;
      });
      ctx.stroke();
      ctx.restore();

      /* Отметка последнего значения: глазу проще снять показание */
      const last = item.points[item.points.length - 1];
      if (last !== null && last !== undefined && isFinite(last)) {
        ctx.fillStyle = color;
        ctx.fillRect(X(item.points.length - 1) - 2.5, Y(last) - 2.5, 5, 5);
      }
    }

    /* Ось времени */
    ctx.fillStyle = t.ink3;
    ctx.textAlign = 'left';
    ctx.fillText(model.xLeft || '', PAD.left, height - PAD.bottom / 2 + 1);
    ctx.textAlign = 'right';
    ctx.fillText(model.xRight || '', PAD.left + plotWidth, height - PAD.bottom / 2 + 1);
  }

  /* ── Карта достоверности полей ─────────────────────────────────────────
     Строки — поля пакета, столбцы — последние пакеты. Заливка клетки
     кодирует состояние поля, поэтому повреждение отдельного поля видно
     точечно, а не «пакет целиком плохой».                               */
  const FIELD_GUTTER = 46;

  function matrix(canvas, states, fieldLabels, caption) {
    const { ctx, width, height } = prepare(canvas);
    const t = tokens();
    const rows = fieldLabels.length;
    const cols = states.length;
    if (!rows || !cols) return;

    const cellWidth = (width - FIELD_GUTTER) / cols;
    const cellHeight = Math.min(13, (height - 14) / rows);
    const top = 2;

    ctx.font = '9.5px ' + FONT;
    ctx.textAlign = 'right';

    for (let row = 0; row < rows; row++) {
      const y = top + row * cellHeight;
      const issues = states.map(column => column[row]);

      for (let col = 0; col < cols; col++) {
        const state = issues[col];
        if (state === 'ok') { ctx.fillStyle = withAlpha(t.ok, 0.18); }
        else if (state === 'sat') { ctx.fillStyle = withAlpha(t.warn, 0.45); }
        else if (state === 'off') { ctx.fillStyle = withAlpha(t.warn, 0.7); }
        else { ctx.fillStyle = withAlpha(t.bad, 0.8); }
        ctx.fillRect(FIELD_GUTTER + col * cellWidth, y, Math.max(1, cellWidth - 0.6), Math.max(1, cellHeight - 1.6));
      }

      const broken = issues.filter(state => state === 'bad').length;
      const off = issues.filter(state => state === 'off').length;
      ctx.fillStyle = broken ? t.bad : off ? t.warn : t.ink3;
      ctx.fillText(fieldLabels[row], FIELD_GUTTER - 7, y + cellHeight / 2);
    }

    ctx.fillStyle = t.ink3;
    ctx.textAlign = 'left';
    ctx.fillText(caption || '', FIELD_GUTTER, top + rows * cellHeight + 6);
    ctx.textAlign = 'right';
    ctx.fillText('новые →', width, top + rows * cellHeight + 6);
  }

  /* ── Трёхмерная сцена ──────────────────────────────────────────────────
     Модель: корпус (параллелепипед) и две солнечные панели по бортам.
     Оси: прописные — опорная (инерциальная) СК, строчные — связанная СК.

     Опорная сфера с меридианами и параллелями — не украшение: без неё
     «нос вверх» и «нос в горизонт» на экране выглядят одинаково. Сетка
     даёт точку отсчёта, относительно которой читается положение.     */
  const view = { azimuth: -0.6, elevation: 0.45, distance: 7.4 };
  const HOME = Object.assign({}, view);

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = v => {
    const n = Math.hypot.apply(null, v) || 1;
    return [v[0] / n, v[1] / n, v[2] / n];
  };
  const apply = (m, p) => [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2],
    m[3] * p[0] + m[4] * p[1] + m[5] * p[2],
    m[6] * p[0] + m[7] * p[1] + m[8] * p[2],
  ];
  const multiply = (a, b) => [
    a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
    a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
    a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
  ];
  const rotateX = angle => [1, 0, 0, 0, Math.cos(angle), -Math.sin(angle), 0, Math.sin(angle), Math.cos(angle)];
  const rotateY = angle => [Math.cos(angle), 0, Math.sin(angle), 0, 1, 0, -Math.sin(angle), 0, Math.cos(angle)];
  const rotateZ = angle => [Math.cos(angle), -Math.sin(angle), 0, Math.sin(angle), Math.cos(angle), 0, 0, 0, 1];

  /* Базис связанной СК в опорной: Rz(курс) · Ry(тангаж) · Rx(крен) */
  function bodyBasis(roll, pitch, yaw) {
    return multiply(
      multiply(rotateZ(yaw), rotateY(pitch)),
      rotateX(roll)
    );
  }

  

  /* Геометрия аппарата. Корпус и две панели по бортам, как на настоящем
     аппарате: панели тонкие пластины, их нормаль — это и есть направление,
     за которым следит оператор. Грани строятся из шести прямоугольников
     ящика, чтобы затенение считалось по нормали каждой грани. */
  const BODY = { center: [0, 0, 0], half: [0.5, 0.5, 0.65] };
  const PANELS = [
    { center: [1.25, 0, 0], half: [0.75, 0.45, 0.02] },
    { center: [-1.25, 0, 0], half: [0.75, 0.45, 0.02] },
  ];

  /* Шесть граней ящика: 4 боковые и 2 торцевые. Порядок не важен —
     сортировка по удалённости происходит при отрисовке. */
  function boxFaces(center, half) {
    const [cx, cy, cz] = center, [hx, hy, hz] = half;
    const p = [
      [cx - hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz - hz],
      [cx + hx, cy + hy, cz - hz], [cx - hx, cy + hy, cz - hz],
      [cx - hx, cy - hy, cz + hz], [cx + hx, cy - hy, cz + hz],
      [cx + hx, cy + hy, cz + hz], [cx - hx, cy + hy, cz + hz],
    ];
    return [
      [p[0], p[1], p[2], p[3]],   // -Z
      [p[5], p[4], p[7], p[6]],   // +Z
      [p[1], p[5], p[6], p[2]],   // +X
      [p[4], p[0], p[3], p[7]],   // -X
      [p[3], p[2], p[6], p[7]],   // +Y
      [p[4], p[5], p[1], p[0]],   // -Y
    ];
  }

  const GEOMETRY = (function () {
    const faces = [];
    for (const face of boxFaces(BODY.center, BODY.half)) faces.push({ pts: face, panel: false });
    for (const panel of PANELS) {
      for (const face of boxFaces(panel.center, panel.half)) faces.push({ pts: face, panel: true });
    }

    /* Линии ячеек на панелях: делят плиту на прямоугольники. Рисуются
       на обеих сторонах — панель видна и с изнанки. */
    const cells = [];
    for (const panel of PANELS) {
      const [cx, cy, cz] = panel.center, [hx, hy, hz] = panel.half;
      for (let i = 1; i < 4; i++) {
        const x = cx - hx + 2 * hx * (i / 4);
        cells.push([[x, cy - hy, cz], [x, cy + hy, cz]]);
        cells.push([[x, cy - hy, -cz], [x, cy + hy, -cz]]);
      }
      for (let j = 1; j < 2; j++) {
        const y = cy - hy + 2 * hy * (j / 2);
        cells.push([[cx - hx, y, cz], [cx + hx, y, cz]]);
        cells.push([[cx - hx, y, -cz], [cx + hx, y, -cz]]);
      }
    }
    return { faces, cells };
  })();

  /* Внешняя нормаль грани: для выпуклых тел с центром в начале
     координат достаточно сравнить с вектором к центру грани.            */
  function outwardNormal(pts) {
    const normal = cross(sub(pts[1], pts[0]), sub(pts[2], pts[0]));
    const center = pts.reduce((sum, p) => [sum[0] + p[0], sum[1] + p[1], sum[2] + p[2]], [0, 0, 0])
      .map(value => value / pts.length);
    const length = Math.hypot(normal[0], normal[1], normal[2]) || 1;
    const unit = [normal[0] / length, normal[1] / length, normal[2] / length];
    return dot(unit, center) < 0 ? unit.map(value => -value) : unit;
  }

  const LIGHT = (function () {
    /* Свет для затенения граней. Фиксирован относительно наблюдателя, а
       не поворачивается вместе с аппаратом: иначе при повороте корпуса
       освещение скачет и объём невозможно удержать в голове.           */
    const l = [-0.34, 0.42, 0.84];
    return norm(l);
  })();

  /* Глубина, на которой перспектива заметно смягчается. Меньше — плоская
     картинка, больше — телесю. Плоская не годится: без неё дальняя панель
     читается как ближняя.                                              */
  const PERSPECTIVE = 15;

  /**
   * Рисует сцену.
   * @param canvas   полотно
   * @param model    { roll, pitch, yaw, valid, message }
   */
  function scene(canvas, model) {
    const { ctx, width, height } = prepare(canvas);
    const t = tokens();
    const cx = width / 2, cy = height / 2;
    const scale = Math.min(width, height) * 0.19;

    const camera = multiply(rotateX(-view.elevation), rotateZ(-view.azimuth));
    const basis = model.valid ? bodyBasis(model.roll, model.pitch, model.yaw) : null;

    /* Проекция с настоящей перспективой: k тем больше, чем ближе точка.
       Преобразованная базисом точка — связанная СК, иначе — опорная. */
    function project(point, inBody) {
      const inertial = inBody && basis ? apply(basis, point) : point;
      const p = apply(camera, inertial);
      const depth = p[2] + view.distance;
      const k = 1 / (1 + (p[2]) / PERSPECTIVE);
      return { x: cx + p[0] * k * scale, y: cy - p[1] * k * scale, depth: p[2], k };
    }
    const projectBody = point => project(point, true);

    ctx.font = '11px ' + FONT;
    ctx.lineJoin = 'round';

    /* Затенение грани: от 0.55 в тени до 1.0 на свету. Ниже 0.5 грань
       сливается с соседней и объём рассыпается. */
    function shadeOf(n) {
      return 0.55 + 0.45 * Math.max(0, dot(n, LIGHT));
    }

    /* ── Корпус и панели ────────────────────────────────────────────────
       Плотная заливка плюс чернильная обводка: объём даёт именно она,
       а не мягкая тень. Грани сортируются по удалённости, ближние
       закрывают дальние.

       Отсев задних граней — по знаку третьей координаты кадра, а не по
       скалярному произведению нормали на центр грани. У ящика с центром
       в начале координат эти два вектора параллельны, произведение всегда
       положительно, и невидимыми оказывались бы все грани сразу. Панели
       смещены от центра, так что прежний признак ещё и зависел от того,
       с какой стороны аппарата мы смотрим.                        */
    const drawn = [];
    for (const face of GEOMETRY.faces) {
      const normal = basis ? apply(basis, outwardNormal(face.pts)) : outwardNormal(face.pts);
      const viewNormal = apply(camera, normal);
      if (viewNormal[2] > 0) continue;                   /* грань отвёрнута */
      const center = face.pts.reduce((sum, p) => [sum[0] + p[0], sum[1] + p[1], sum[2] + p[2]], [0, 0, 0])
        .map(value => value / face.pts.length);
      const viewCenter = apply(camera, basis ? apply(basis, center) : center);
      drawn.push({ pts: face.pts, panel: face.panel, shade: shadeOf(normal), depth: viewCenter[2] });
    }
    drawn.sort((a, b) => b.depth - a.depth);

    for (const face of drawn) {
      const projected = face.pts.map(projectBody);
      ctx.beginPath();
      projected.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      const rgb = face.panel ? t.model.panel : t.model.body;
      ctx.fillStyle = 'rgb(' + rgb.map(v => Math.round(v * face.shade)).join(',') + ')';
      ctx.fill();
      ctx.strokeStyle = withAlpha(t.edge, 0.85);
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    /* Линии ячеек солнечных панелей */
    ctx.strokeStyle = withAlpha(t.edge, 0.28);
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    for (const cell of GEOMETRY.cells) {
      const a = projectBody(cell[0]), b = projectBody(cell[1]);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();

    /* ── Оси связанной СК ────────────────────────────────────────────────
       Три луча из начала координат, у каждого свой цвет из палитры
       графиков: так вектор можно сопоставить с рядами на графиках.
       Оси рисуются поверх аппарата — иначе корпус их закрывает.   */
    const origin = projectBody([0, 0, 0]);
    const axes = [
      { label: 'X', tip: [2, 0, 0], color: 0 },
      { label: 'Y', tip: [0, 2, 0], color: 1 },
      { label: 'Z', tip: [0, 0, 2], color: 2 },
    ];
    ctx.lineWidth = 2;
    for (const axis of axes) {
      const to = projectBody(axis.tip);
      ctx.beginPath();
      ctx.moveTo(origin.x, origin.y);
      ctx.lineTo(to.x, to.y);
      ctx.strokeStyle = t.series[axis.color];
      ctx.stroke();

      ctx.fillStyle = t.series[axis.color];
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(axis.label, to.x + (to.x - origin.x > 10 ? 7 : -7), to.y - 7);
    }

    /* ── Подпись ───────────────────────────────────────────────────────
       Слева внизу — состояние оценки. Справа — управление сценой.  */
    ctx.textAlign = 'left';
    ctx.fillStyle = t.ink3;
    ctx.fillText(model.message || '', 2, height - 9);
    ctx.textAlign = 'right';
    ctx.fillText('тянуть — поворот · колесо — масштаб', width - 2, height - 9);
  }

  return { plot, matrix, scene, view, home: () => Object.assign(view, HOME) };
})();
