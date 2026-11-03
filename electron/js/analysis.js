/* =============================================================================
   analysis.js — оценка состояния аппарата и статистика потока.

   Здесь нет ни DOM, ни сети: на вход разобранный пакет (CU.Telemetry),
   на выходе — состояния модулей, числа для приборной группы, карта
   достоверности полей и текст отчёта.
   ========================================================================== */
'use strict';

window.CU = window.CU || {};

CU.Analysis = (function () {

  const T = CU.Telemetry;

  /* ── Состояния модулей ─────────────────────────────────────────────────
     Уровень: 0 — норма, 1 — внимание, 2 — авария.
     Правило: потеря связи с датчиком (OFF) — авария, повреждение
     отдельного значения — внимание, выход параметра за допуск — по
     настроенным порогам.                                                */
  const MODULES = [
    { id: 'mcu',   name: 'Микроконтроллер STM32', role: 'Основной вычислительный модуль' },
    { id: 'imu',   name: 'Датчик положения',       role: 'Гироскоп, акселерометр, магнитометр' },
    { id: 'lum',   name: 'Датчики освещённости',   role: 'Четыре канала СД1—СД4' },
    { id: 'power', name: 'Модуль питания',         role: 'Аккумуляторная батарея' },
    { id: 'wheel', name: 'Плата маховика',         role: 'Система ориентации' },
  ];

  /* Раскладывает поля группы по признакам: отключён / повреждён /
     насыщен / нулевой.                                                 */
  function inspect(frame, keys, options) {
    const out = { off: [], bad: [], sat: [], zero: [] };
    for (const key of keys) {
      const slot = frame.fields[T.IDX[key]];
      const label = slot.def.short;
      if (slot.state === T.OFF) out.off.push(label);
      else if (slot.state === T.BAD) out.bad.push(label);
      else if (slot.state === T.SAT) out.sat.push(label);
      else if (options && options.checkZero && slot.value === 0) out.zero.push(label);
    }
    return out;
  }

  /* Общая оценка группы: OFF важнее повреждения, повреждение важнее нулей. */
  function grade(info) {
    if (info.off.length) return { level: 2, why: 'Нет связи: ' + info.off.join(', ') };
    if (info.bad.length) return { level: 1, why: 'Повреждены значения: ' + info.bad.join(', ') };
    if (info.sat.length) return { level: 1, why: 'Насыщение измерителя: ' + info.sat.join(', ') };
    if (info.zero.length) return { level: 1, why: 'Нулевые показания: ' + info.zero.join(', ') };
    return { level: 0, why: 'Данные поступают' };
  }

  const fmt = (value, digits) => value === null || value === undefined
    ? '—' : value.toFixed(digits);

  const magnitude = (vector, digits, unit) =>
    vector === null ? '—' : Math.hypot.apply(null, vector).toFixed(digits) + ' ' + unit;

  /* ── Оценка всех модулей ────────────────────────────────────────────────
     @param frame  разобранный пакет
     @param ctx    { cfg, stale, rebooted }
  -------------------------------------------------------------------------*/
  function modules(frame, ctx) {
    const cfg = ctx.cfg;

    if (!frame) {
      return MODULES.map(module => Object.assign({}, module, {
        level: 2,
        reading: '—',
        why: ctx.stale ? 'Передача данных прекращена' : 'Ожидание первого пакета',
      }));
    }

    const out = [];

    /* Микроконтроллер: время отсчитывается с включения, обнуление
       счётчика означает перезапуск — это не поломка, но оператор
       должен знать, что отсчёт начат заново.                            */
    const rebooted = ctx.rebooted;
    out.push(Object.assign({}, MODULES[0], {
      level: rebooted ? 1 : 0,
      reading: 'Время МК ' + frame.mk + ' с',
      why: rebooted ? 'Счётчик времени перезапущен' : 'Работает штатно',
    }));

    /* Датчик положения: три датчика оцениваются раздельно, общий статус —
     худший из них. Нулевой акселерометр и магнитометр трактуются как
     отказ: на орбите вектор «свободного падения» не бывает нулевым.  */
    const triples = [
      { keys: ['ax', 'ay', 'az'], title: 'акселерометр', digits: 3, unit: 'g',   checkZero: true },
      { keys: ['gx', 'gy', 'gz'], title: 'гироскоп',     digits: 2, unit: '°/с', checkZero: false },
      { keys: ['mx', 'my', 'mz'], title: 'магнитометр',  digits: 2, unit: 'Гс',  checkZero: true },
    ];
    const imuInfos = triples.map(triple => ({
      title: triple.title,
      info: inspect(frame, triple.keys, { checkZero: triple.checkZero }),
    }));
    const imuWorst = imuInfos.reduce((worst, item) => Math.max(worst, grade(item.info).level), 0);
    const imuReasons = imuInfos
      .map(item => Object.assign({ title: item.title }, grade(item.info)))
      .filter(item => item.level > 0)
      .map(item => item.title + ' — ' + item.why);
    out.push(Object.assign({}, MODULES[1], {
      level: imuWorst,
      reading: [
        '|a| ' + magnitude(frame.groups.a, 2, 'g'),
        '|ω| ' + magnitude(frame.groups.g, 1, '°/с'),
        '|B| ' + magnitude(frame.groups.m, 2, 'Гс'),
      ].join(' · '),
      why: imuReasons.length ? imuReasons.join('; ') : 'Все три датчика в работе',
    }));

    /* Освещённость: четыре независимых канала */
    const lumInfo = inspect(frame, T.LUM, { checkZero: true });
    out.push(Object.assign({}, MODULES[2], {
      level: grade(lumInfo).level,
      reading: T.LUM
        .map((key, i) => T.FIELDS[T.IDX[key]].short + ' ' + (frame.groups.lum[i] === null ? '—' : frame.groups.lum[i]))
        .join(' · '),
      why: grade(lumInfo).why,
    }));

    /* Питание: единственный параметр, для которого пороги настраивает оператор */
    const akbSlot = frame.fields[T.IDX.akb];
    let powerLevel = 0, powerWhy = 'Напряжение в допуске', powerReading = '—';
    if (akbSlot.state === T.OFF) {
      powerLevel = 2; powerWhy = 'Модуль отключён (OFF)';
    } else if (akbSlot.value === null) {
      powerLevel = 2; powerWhy = 'Данные модуля отсутствуют';
    } else {
      const volts = frame.groups.akb;
      powerReading = fmt(volts, 2) + ' В';
      if (volts < cfg.vcLo) { powerLevel = 2; powerWhy = 'Критически низкое напряжение'; }
      else if (volts > cfg.vcHi) { powerLevel = 2; powerWhy = 'Напряжение выше допустимого'; }
      else if (volts < cfg.vwLo) { powerLevel = 1; powerWhy = 'Напряжение снижено'; }
      else if (volts > cfg.vwHi) { powerLevel = 1; powerWhy = 'Напряжение повышено'; }
    }
    out.push(Object.assign({}, MODULES[3], { level: powerLevel, reading: powerReading, why: powerWhy }));

    /* Маховик: знак скорости задаёт направление вращения */
    const wheelSlot = frame.fields[T.IDX.wheel];
    let wheelLevel = 0, wheelWhy = 'Готов к работе';
    if (wheelSlot.state === T.OFF) { wheelLevel = 2; wheelWhy = 'Плата отключена (OFF)'; }
    else if (wheelSlot.value === null) { wheelLevel = 1; wheelWhy = 'Значение повреждено'; }
    else if (wheelSlot.state === T.SAT) { wheelLevel = 1; wheelWhy = 'Предел скорости'; }
    else if (wheelSlot.value === 0) { wheelWhy = 'Маховик остановлен'; }
    else { wheelWhy = wheelSlot.value > 0 ? 'Вращение в положительном направлении' : 'Вращение в отрицательном направлении'; }
    out.push(Object.assign({}, MODULES[4], {
      level: wheelLevel,
      reading: wheelSlot.value === null ? '—' : 'Скорость ' + wheelSlot.value,
      why: wheelWhy,
    }));

    /* Просроченные показания: данные есть, но они старше допустимого
       интервала. Показывать их как актуальные нельзя.                    */
    if (ctx.stale) {
      return out.map(module => Object.assign({}, module, {
        level: 2,
        why: 'Показания устарели: нет новых пакетов',
      }));
    }
    return out;
  }

  /* ── Ориентация ─────────────────────────────────────────────────────────
     Крен и тангаж берутся из акселерометра (он «видит» направление вниз),
     курс — из магнитометра (видит магнитный север). Это классическая
     триадизация без гироскопа: точность зависит от модуля длины
     ускорений, поэтому оценка помечена как приближённая.              */
  function attitude(frame) {
    const a = frame && frame.groups.a;
    const m = frame && frame.groups.m;
    const accValid = Array.isArray(a) && Math.hypot.apply(null, a) > 0.05;
    const magValid = Array.isArray(m) && Math.hypot.apply(null, m) > 0.2;

    return {
      roll:  accValid ? Math.atan2(a[1], a[2]) : null,
      pitch: accValid ? Math.atan2(-a[0], Math.hypot(a[1], a[2])) : null,
      yaw:   magValid ? wrap2pi(Math.atan2(m[1], m[0])) : null,
      accValid, magValid,
    };
  }

  const RAD = 180 / Math.PI;
  const wrap2pi = angle => ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

  const degrees = radians => radians === null ? '—' : (radians * RAD).toFixed(1) + '°';

  /* ── Поток: счётчики сеанса и карта достоверности ─────────────────────
     Эмулятор отдаёт только последний кадр, поэтому между двумя
     полученными пакетами счётчик МК может увеличиться на несколько.
     Разница — это честная оценка потерянных пакетов.

     История ограничена сверху: при 10 кадрах в секунду 20 000 кадров —
     это около 33 минут, с запасом перекрывающие самое длинное окно
     графика (15 минут). Без ограничения сеанс длиной в несколько часов
     съедал бы сотни мегабайт: измеренная цена одного кадра — 1111 байт,
     то есть 38 МБ в час. Счётчики при этом остаются накопительными.   */
  const MATRIX_WIDTH = 64;
  const MAX_FRAMES = 20000;
  const MAX_LOG = 5000;

  class Stream {
    constructor() { this.reset(); }

    reset() {
      this.startedAt = Date.now();
      this.frames = [];          // принятые пакеты (для журнала и графиков)
      this.log = [];             // все пакеты: принятые и отклонённые
      this.accepted = 0;
      this.rejected = 0;
      this.defective = 0;   // принято, но с недостоверными полями
      this.lost = 0;
      this.duplicates = 0;
      this.lastMk = null;
      this.steps = [];          // последние шаги счётчика МК
      this.matrix = [];          // кольцевой буфер состояний полей
      this.defects = new Map();  // reasonKey → { count, sample }
      this.fieldIssues = new Map();
      this.lastFrameAt = 0;
      this.arrivals = [];
      this.reasonOrder = ['preamble', 'postamble', 'fields', 'time', 'chaos', 'fields-bad', 'gap', 'rollback', 'off', 'sat'];
    }

    /* Регистрирует один пакет. Возвращает объект с признаком пригодности
       и предупреждениями о последовательности (пропуск, откат счётчика). */
    record(frame, stamp) {
      const notes = [];
      const time = stamp || Date.now();

      if (frame.level === 2) {
        this.rejected++;
        this.log.push({ at: time, mk: frame.mk, raw: frame.raw, level: 2, reason: frame.reason, key: frame.reasonKey });
        if (this.log.length > MAX_LOG) this.log.shift();
        this.bump(frame.reasonKey, frame.reason);
        this.countFields(frame);
        return { accepted: false, notes };
      }

      /* Последовательность счётчика МК */
      if (this.lastMk !== null) {
        const step = frame.mk - this.lastMk;
        if (step > 1) {
          this.lost += step - 1;
          notes.push({ level: 1, key: 'gap', text: 'Пропущено пакетов по счётчику МК: ' + (step - 1) });
          this.bump('gap', 'Пропуск по счётчику МК');
        } else if (step <= 0) {
          notes.push({ level: 1, key: 'rollback', text: 'Счётчик МК ушёл назад на ' + Math.abs(step) + ' с' });
          this.bump('rollback', 'Откат времени МК');
        }
        /* Шаг хранится по кругу: по нему считается скользящая полнота,
           на которую реагирует регулятор частоты опроса.            */
        this.steps.push(Math.max(1, step));
        if (this.steps.length > 200) this.steps.shift();
        if (step === 0) this.duplicates++;
      }
      this.lastMk = frame.mk;

      if (frame.level === 1) {
        this.defective++;
        this.bump(frame.reasonKey === 'fields' ? 'fields-bad' : frame.reasonKey, frame.reason);
        notes.push({ level: 1, key: frame.reasonKey, text: frame.reason });
      }

      this.countFields(frame);
      this.accepted++;
      frame.at = time;                       // метка времени для окон графиков
      this.frames.push(frame);
      if (this.frames.length > MAX_FRAMES) this.frames.shift();
      this.matrix.push(frame.fields.map(slot => slot.state));
      if (this.matrix.length > MATRIX_WIDTH) this.matrix.shift();
      this.arrivals.push(time);
      if (this.arrivals.length > 600) this.arrivals.shift();
      this.lastFrameAt = time;
      this.log.push({ at: time, mk: frame.mk, raw: frame.raw, level: frame.level, reason: frame.reason, key: frame.reasonKey });
      if (this.log.length > MAX_LOG) this.log.shift();
      return { accepted: true, notes };
    }

    bump(key, sample) {
      const item = this.defects.get(key) || { count: 0, sample: sample || '' };
      item.count++;
      this.defects.set(key, item);
    }

    /* Счётчики по каждому полю: сколько раз оно было повреждено,
       отключено или насыщено. Показываются в карте целостности. */
    countFields(frame) {
      frame.fields.forEach((slot, i) => {
        if (slot.state === T.OK) return;
        const item = this.fieldIssues.get(i) || { off: 0, bad: 0, sat: 0, total: 0 };
        item[slot.state]++;
        item.total++;
        this.fieldIssues.set(i, item);
      });
    }

    /* Кадры не старше указанного момента. История упорядочена по времени
       прихода, поэтому граница ищется делением пополам: перебор всех
       кадров на каждой перерисовке стоил бы сотни тысяч операций в
       секунду к концу длинного сеанса.                                   */
    framesSince(moment) {
      const frames = this.frames;
      let low = 0, high = frames.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (frames[middle].at < moment) low = middle + 1;
        else high = middle;
      }
      return low === frames.length ? [] : frames.slice(low);
    }

    /* Сколько секунд прошло с последнего принятого пакета. */
    idleSeconds(now) {
      return this.lastFrameAt ? (now - this.lastFrameAt) / 1000 : Infinity;
    }

    /* Частота обновления по фактическим интервалам между пакетами. */
    rateHz() {
      if (this.arrivals.length < 2) return 0;
      const from = this.arrivals[this.arrivals.length - 1] - 5000;
      const inWindow = this.arrivals.filter(at => at >= from).length;
      const span = Math.min(5, (Date.now() - this.arrivals[0]) / 1000) || 1;
      return inWindow / Math.max(1, Math.min(span, 5));
    }

    expected() { return this.accepted + this.lost; }

    /* Полнота за сеанс — для отчёта: там важна и одна грубая потеря. */
    /* Полнота за последние шаги — для регулятора опроса: одна вспышка
       потерь не должна навсегда ухудшать работу приёмника.          */
    completeness(window) {
      if (!window) {
        const expected = this.expected();
        return expected ? (this.accepted / expected) * 100 : null;
      }
      const steps = this.steps.slice(-window);
      if (steps.length < 10) return null;
      const expected = steps.reduce((sum, step) => sum + step, 0);
      const lost = steps.reduce((sum, step) => sum + (step - 1), 0);
      return expected ? ((expected - lost) / expected) * 100 : null;
    }

    /* Сводка для приборной группы и отчёта. */
    summary() {
      const expected = this.expected();
      const uptime = (Date.now() - this.startedAt) / 1000;
      return {
        uptime,
        accepted: this.accepted,
        rejected: this.rejected,
        defective: this.defective,
        lost: this.lost,
        duplicates: this.duplicates,
        rate: this.rateHz(),
        completeness: this.completeness(),
        recentCompleteness: this.completeness(120),
        errorRate: this.accepted + this.rejected ? (this.rejected / (this.accepted + this.rejected)) * 100 : 0,
      };
    }

    /* Причины отклонений, отсортированные по частоте. */
    defectList() {
      return Array.from(this.defects.entries())
        .map(([key, item]) => ({ key, count: item.count, sample: item.sample }))
        .sort((a, b) => b.count - a.count);
    }

    fieldIssue(i) {
      return this.fieldIssues.get(i) || { off: 0, bad: 0, sat: 0, total: 0 };
    }
  }

  /* ── Отчёт о сеансе ─────────────────────────────────────────────────────
     Текстовый файл, который удобно приложить к заявке: достаточно
     показать его при защите.                                              */
  function report(stream, context) {
    const s = stream.summary();
    const pad = (text, width) => String(text).padEnd(width, ' ');
    const lines = [];
    lines.push('ОТЧЁТ О СЕАНСЕ СВЯЗИ С УЧЕБНЫМ СПУТНИКОМ «ИНТРОСАТ»');
    lines.push('Пульт оператора ЦУП · Хакатон-ЦУП 2026');
    lines.push('Сформирован: ' + new Date(context.now).toLocaleString('ru-RU'));
    lines.push('Источник:    ' + context.source);
    lines.push('');
    lines.push('СЕАНС');
    lines.push('  длительность, с .................. ' + s.uptime.toFixed(1));
    lines.push('  принято пакетов .................. ' + s.accepted);
    lines.push('  отклонено пакетов ................ ' + s.rejected);
    lines.push('  пропущено по счётчику МК ......... ' + s.lost);
    lines.push('  повторов пакетов ................. ' + s.duplicates);
    lines.push('  частота обновления, Гц ........... ' + s.rate.toFixed(2));
    lines.push('  полнота потока, % ................ ' + (s.completeness === null ? '—' : s.completeness.toFixed(2)));
    lines.push('  доля отклонённых, % .............. ' + s.errorRate.toFixed(2));
    lines.push('  задержка опроса, мс ............. ' + context.latency.toFixed(0));
    lines.push('  ошибок опроса .................... ' + context.pollErrors);
    lines.push('');
    lines.push('СОСТОЯНИЕ МОДУЛЕЙ НА КОНЕЦ СЕАНСА');
    for (const module of context.modules) {
      lines.push('  ' + pad(module.name, 26) + pad(['норма', 'внимание', 'авария'][module.level], 10) + module.why);
    }
    if (context.frame) {
      lines.push('');
      lines.push('ПОСЛЕДНИЙ ПРИНЯТЫЙ ПАКЕТ');
      lines.push('  время МК, с ...................... ' + context.frame.mk);
      lines.push('  напряжение батареи, В ............ ' + fmt(context.frame.groups.akb, 2));
      lines.push('  скорость маховика ................ ' + (context.frame.groups.wheel === null ? '—' : context.frame.groups.wheel));
      lines.push('  СД1…СД4 ......................... ' + context.frame.groups.lum.map(v => v === null ? '—' : v).join(' · '));
    }
    const defects = stream.defectList();
    if (defects.length) {
      lines.push('');
      lines.push('ПРИЧИНЫ ОТКЛОНЕНИЙ');
      for (const item of defects) lines.push('  ' + pad(item.count, 8) + item.sample);
    }
    lines.push('');
    lines.push('СОБЫТИЯ');
    for (const event of context.events.slice(0, 60)) {
      lines.push('  ' + pad(event.t, 10) + pad(['норма  ', 'внимание', 'авария '][event.l], 10) + event.msg);
    }
    lines.push('');
    lines.push('Настройки разбора пакета: преамбула ' + context.cfg.pre +
               ', постамбула ' + context.cfg.post +
               ', пороги напряжения ' + context.cfg.vcLo + '…' + context.cfg.vwLo +
               ' / ' + context.cfg.vwHi + '…' + context.cfg.vcHi + ' В');
    return lines.join('\r\n');
  }

  return { MODULES, modules, attitude, degrees, Stream, report, fmt };
})();
