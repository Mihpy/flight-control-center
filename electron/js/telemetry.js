/* =============================================================================
   telemetry.js — протокол телеметрии.

   Единственный модуль, который знает про формат пакета. Остальные работают
   только с уже разобранными значениями.

   Формат пакета (18 полей, разделитель «;») — по документации эмулятора
   mcc-hack/data-emulator:

     ПРЕАМБУЛА;ВРЕМЯ ОТ ЗАПУСКА МК;АКБ;СД1;СД2;СД3;СД4;
     AX;AY;AZ;GX;GY;GZ;MX;MY;MZ;МАХОВИК;ПОСТАМБУЛА

   Преамбула и постамбула — маркеры кадра (AA55 / 0D0A), они же служат
   простейшей проверкой целостности: в файле с радиопомехами они повреждаются
   первыми.

   Порядок объявления полей (индекс = позиция в пакете минус один):
     0  ВРЕМЯ  1  АКБ  2…5  СД1…СД4  6…8  AX…AZ
     9…11 GX…GZ  12…14 MX…MZ  15  МАХОВИК
   ========================================================================== */
'use strict';

window.CU = window.CU || {};

CU.Telemetry = (function () {

  /* ── Описание полей ──────────────────────────────────────────────────────
     kind:    'time' | 'raw' | 'scaled'
     div:     делитель для перевода в физические единицы
     range:   допустимый диапазон «сырого» значения (нарушение = повреждение)
     sat:     с какого значения считать насыщением измерителя
     sensor:  true, если поле относится к датчику (для группировки в модули)
  -------------------------------------------------------------------------*/
  const FIELDS = [
    { key: 'mk',     label: 'ВРЕМЯ ОТ ЗАПУСКА МК', short: 'Время',  unit: 'с',        kind: 'time',   div: 1,      range: [0, 2147483647], sensor: false },
    { key: 'akb',    label: 'АКБ',                  short: 'АКБ',    unit: 'В',        kind: 'scaled', div: 1000,   range: [0, 65535], sensor: false, plausible: [2000, 20000] },
    { key: 'sd1',    label: 'СД1',                  short: 'СД1',    unit: 'ед.',      kind: 'raw',    div: 1,      range: [0, 65536], sat: 65530, sensor: true },
    { key: 'sd2',    label: 'СД2',                  short: 'СД2',    unit: 'ед.',      kind: 'raw',    div: 1,      range: [0, 65536], sat: 65530, sensor: true },
    { key: 'sd3',    label: 'СД3',                  short: 'СД3',    unit: 'ед.',      kind: 'raw',    div: 1,      range: [0, 65536], sat: 65530, sensor: true },
    { key: 'sd4',    label: 'СД4',                  short: 'СД4',    unit: 'ед.',      kind: 'raw',    div: 1,      range: [0, 65536], sat: 65530, sensor: true },
    { key: 'ax',     label: 'AX',                   short: 'AX',     unit: 'g',        kind: 'scaled', div: 16384,  range: [-32768, 32767], sat: 32700, sensor: true },
    { key: 'ay',     label: 'AY',                   short: 'AY',     unit: 'g',        kind: 'scaled', div: 16384,  range: [-32768, 32767], sat: 32700, sensor: true },
    { key: 'az',     label: 'AZ',                   short: 'AZ',     unit: 'g',        kind: 'scaled', div: 16384,  range: [-32768, 32767], sat: 32700, sensor: true },
    { key: 'gx',     label: 'GX',                   short: 'GX',     unit: '°/с',      kind: 'scaled', div: 131.072, range: [-32768, 32767], sat: 32700, sensor: true },
    { key: 'gy',     label: 'GY',                   short: 'GY',     unit: '°/с',      kind: 'scaled', div: 131.072, range: [-32768, 32767], sat: 32700, sensor: true },
    { key: 'gz',     label: 'GZ',                   short: 'GZ',     unit: '°/с',      kind: 'scaled', div: 131.072, range: [-32768, 32767], sat: 32700, sensor: true },
    { key: 'mx',     label: 'MX',                   short: 'MX',     unit: 'Гс',       kind: 'scaled', div: 1711.6, range: [-32768, 32767], sat: 32700, sensor: true },
    { key: 'my',     label: 'MY',                   short: 'MY',     unit: 'Гс',       kind: 'scaled', div: 1711.6, range: [-32768, 32767], sat: 32700, sensor: true },
    { key: 'mz',     label: 'MZ',                   short: 'MZ',     unit: 'Гс',       kind: 'scaled', div: 1711.6, range: [-32768, 32767], sat: 32700, sensor: true },
    { key: 'wheel',  label: 'МАХОВИК',              short: 'Маховик', unit: 'ед.',     kind: 'raw',    div: 1,      range: [-32768, 32767], sat: 32700, sensor: true },
  ];

  /* Размер пакета по протоколу: 16 полей данных плюс преамбула и постамбула */
  const PACKET_SIZE = FIELDS.length + 2;
  const PRE = 0;

  /* Индексы для удобства доступа */
  const IDX = FIELDS.reduce((map, field, i) => (map[field.key] = i, map), {});

  const LUM = ['sd1', 'sd2', 'sd3', 'sd4'];

  /* Группы для переключателя графика. Цвет и штриховка заданы здесь же,
     чтобы легенда и линия на графике всегда совпадали.                     */
  const CHART_GROUPS = [
    { key: 'pwr',   name: 'Батарея', unit: 'В',   digits: 2, series: [{ key: 'akb', label: 'АКБ', color: 0 }] },
    { key: 'wheel', name: 'Маховик', unit: 'ед.', digits: 0, series: [{ key: 'wheel', label: 'Скорость', color: 0 }] },
    { key: 'lum',   name: 'Освещённость', unit: 'ед.', digits: 0,
      series: LUM.map((key, i) => ({ key, label: FIELDS[IDX[key]].short, color: i })) },
    { key: 'acc',   name: 'Акселерометр', unit: 'g',  digits: 3,
      series: ['ax', 'ay', 'az'].map((key, i) => ({ key, label: key.toUpperCase(), color: i })) },
    { key: 'gyr',   name: 'Гироскоп', unit: '°/с', digits: 2,
      series: ['gx', 'gy', 'gz'].map((key, i) => ({ key, label: key.toUpperCase(), color: i, dash: i === 2 })) },
    { key: 'mag',   name: 'Магнитометр', unit: 'Гс', digits: 2,
      series: ['mx', 'my', 'mz'].map((key, i) => ({ key, label: key.toUpperCase(), color: i })) },
  ];

  /* Признак состояния поля */
  const OK = 'ok', OFF = 'off', BAD = 'bad', SAT = 'sat';

  const STATE_TEXT = {
    ok:  ['Достоверно', 0],
    off: ['Датчик отключён (OFF)', 1],
    sat: ['Насыщение измерителя', 1],
    bad: ['Значение повреждено', 2],
  };

  /**
   * Разбирает одну строку телеметрии.
   *
   * @param {string} raw   строка пакета как есть
   * @param {object} cfg   настройки: pre, post, chaosLimit
   * @returns {object} результат разбора (см. описание в app.js → ingest)
   */
  function parse(raw, cfg) {
    const parts = raw.trim().split(';').map(part => part.trim());
    const result = blank(raw);
    const reject = (key, text) => { result.level = 2; result.reasonKey = key; result.reason = text; return result; };

    /* Техническое задание (п.4) допускает на борту сторонние датчики,
       подключённые по I2C: такой конструктор добавляет свои поля в конец
       пакета. Отбрасывать из-за них весь пакет нельзя — стандартные
       поля при этом достоверны, терять их не за что. Недостающих полей,
       наоборот, быть не должно: это уже повреждение пакета.          */
    const extra = parts.length - PACKET_SIZE;
    if (extra < 0) {
      return reject('fields', 'Неверное число полей: ' + parts.length + ' вместо ' + PACKET_SIZE);
    }
    result.extraFields = extra > 0 ? extra : 0;

    if (parts[PRE] !== cfg.pre) {
      return reject('preamble', 'Преамбула «' + parts[PRE] + '» вместо «' + cfg.pre + '»');
    }
    /* Постамбула — последнее поле пакета: при добавленных датчиках
       она стоит не на позиции POST, а в конце.                       */
    const tail = parts[parts.length - 1];
    if (tail !== cfg.post) {
      return reject('postamble', 'Постамбула «' + tail + '» вместо «' + cfg.post + '»');
    }

    let invalid = 0;

    for (let i = 0; i < FIELDS.length; i++) {
      const def = FIELDS[i];
      const token = parts[i + 1];
      const slot = result.fields[i];

      /* Метка OFF в эмуляторе означает физически отключённый датчик.
         Это не повреждение пакета, поэтому пакет остаётся пригодным,
         а состояние датчика переходит в «нет связи».                     */
      if (token === 'OFF') {
        slot.state = OFF;
        invalid++;
        continue;
      }

      if (!/^-?\d+$/.test(token)) {
        slot.state = BAD;
        slot.token = token;
        invalid++;
        continue;
      }

      const value = parseInt(token, 10);
      slot.token = token;

      if (value < def.range[0] || value > def.range[1]) {
        slot.state = BAD;
        slot.token = token;
        invalid++;
        continue;
      }

      /* АКБ — единственное поле с проверкой правдоподобия: протокол
         допускает 0…65535 мВ, но такой диапазон питания невозможен.      */
      if (def.plausible && (value < def.plausible[0] || value > def.plausible[1])) {
        slot.state = BAD;
        invalid++;
        continue;
      }

      slot.state = (def.sat !== undefined && Math.abs(value) >= def.sat) ? SAT : OK;
      slot.value = value / def.div;
    }

    /* Время пакета — служебное поле: без него пакет нельзя положить
       на временную шкалу, поэтому он не подлежит «мягкой» обработке.     */
    if (result.fields[IDX.mk].state !== OK) {
      return reject('time', 'Повреждено время пакета: «' + (result.fields[IDX.mk].token || '—') + '»');
    }
    result.mk = result.fields[IDX.mk].value;

    /* Больше трёх повреждённых полей — пакет не имеет физического смысла. */
    if (invalid > cfg.chaosLimit) {
      return reject('chaos', 'Хаотичный пакет: недостоверных полей ' + invalid);
    }

    if (invalid > 0) {
      result.level = 1;
      const off = result.fields.filter(slot => slot.state === OFF).length;
      result.reasonKey = off === invalid ? 'off' : off ? 'off-fields' : 'fields';
      result.reason = describe(result);
    }

    return result;
  }

  /* Пустой результат разбора: структура зафиксирована, чтобы потребителям
     не приходилось проверять наличие полей.                               */
  function blank(raw) {
    return {
      raw,
      level: 0,
      reason: null,
      reasonKey: null,
      extraFields: 0,   // поля сверх протокола: сторонние датчики по I2C
      mk: null,
      fields: FIELDS.map(def => ({
        def, token: '', value: null, state: BAD, physical: null,
      })),
      groups: { a: null, g: null, m: null, lum: null, akb: null, wheel: null },
    };
  }

  /* Собирает производные величины (модули акселерометра и т. п.).
     Группа целиком помечается недоступной, если хотя бы одно поле
     её не достоверно: частичные векторы вводили бы в заблуждение.      */
  function derive(frame) {
    const read = key => {
      const slot = frame.fields[IDX[key]];
      return slot.state === OK || slot.state === SAT ? slot.value : null;
    };
    const readAll = keys => {
      const out = keys.map(read);
      return out.some(value => value === null) ? null : out;
    };

    frame.groups.akb   = read('akb');
    frame.groups.wheel = read('wheel');
    frame.groups.lum   = LUM.map(read);
    frame.groups.a     = readAll(['ax', 'ay', 'az']);
    frame.groups.g     = readAll(['gx', 'gy', 'gz']);
    frame.groups.m     = readAll(['mx', 'my', 'mz']);

    for (const field of frame.fields) {
      field.physical = field.value;
    }
    return frame;
  }

  /* Текст перечня проблемных полей — попадает в журнал и в тревогу.
     Метка OFF и повреждённое значение — разные вещи, поэтому в тексте
     они не смешиваются: отключение датчика и сбой канала оцениваются
     оператором по-разному.                                              */
  function describe(frame) {
    const names = state => frame.fields
      .map((slot, i) => ({ slot, i }))
      .filter(item => item.slot.state === state)
      .map(item => FIELDS[item.i].short);
    const off = names(OFF);
    const bad = names(BAD);
    const parts = [];
    if (off.length) parts.push('отключены датчики: ' + off.join(', '));
    if (bad.length) parts.push('повреждены значения: ' + bad.join(', '));
    return parts.join('; ');
  }

  /* Список отклонённых пакетов с причиной — для CSV-выгрузки. */
  function defectsOf(frame) {
    return frame.fields
      .map((slot, i) => ({ slot, i }))
      .filter(item => item.slot.state === BAD)
      .map(item => FIELDS[item.i].short + '="' + (item.slot.token || '') + '"');
  }

  /* Значение поля по ключу: физическая величина или null. */
  function value(frame, key) {
    if (!frame) return null;
    const slot = frame.fields[IDX[key]];
    return slot && (slot.state === OK || slot.state === SAT) ? slot.value : null;
  }

  /* Состояния полей одним массивом — рисуется карта целостности. */
  function states(frame) {
    return frame ? frame.fields.map(slot => slot.state) : null;
  }

  /* Строка заголовка для выгрузки лога в формате эмулятора. */
  function headerLine() {
    return ['ПРЕАМБУЛА', 'ВРЕМЯ ОТ ЗАПУСКА МК'].concat(FIELDS.slice(1).map(f => f.label), 'ПОСТАМБУЛА').join(';');
  }

  return {
    FIELDS, IDX, PACKET_SIZE, CHART_GROUPS, LUM,
    OK, OFF, BAD, SAT, STATE_TEXT,
    parse, derive, describe, defectsOf, value, states, headerLine,
  };
})();
