/* =============================================================================
   app.js — состояние приложения, приём данных и интерфейс пульта.

   Архитектура
   -----------
   telemetry.js  формат пакета: разбор, допуски, единицы измерения
   analysis.js   состояние модулей, статистика потока, отчёт о сеансе
   views.js      отрисовка на canvas: графики, карта полей, 3D-сцена
   app.js        (этот файл) связывает их с DOM: опрос эмулятора,
                 воспроизведение записей, команды, журнал, настройки

   Поток данных
   ------------
     эмулятор ──GET /telemetry──▶ poll() ──▶ ingest() ──▶ Stream ──▶ отрисовка
                                    │
                                    └── последний пакет кадра, поэтому
                                        пропуски считаются по счётчику МК

   Модули не знают друг о друге и ничего не знают о DOM; интерфейс только
   читает их результаты. Благодаря этому разбор пакета можно проверить
   без браузера, а отрисовку — без эмулятора.
   ========================================================================== */
'use strict';

(function () {

  const T = CU.Telemetry;
  const A = CU.Analysis;
  const V = CU.Views;

  /* ── 1. Константы и утилиты ────────────────────────────────────────────*/

  const STORE = 'cup.introsat.v1';
  const MAX_EVENTS = 400;
  const MAX_LOG_ROWS = 20000;
  const MATRIX_FIELDS = 16;   // карта целостности: только поля данных

  /* Значения по умолчанию. Пороги питания соответствуют комплекту
     учебного пульта «ИнтроСат»: 7,2–8,5 В рабочий диапазон.            */
  const DEFAULT_CFG = {
    url: 'http://127.0.0.1:8765/telemetry',
    poll: 60,        // интервал опроса, мс
    stale: 3,        // потеря связи, с
    pre: 'AA55',
    post: '0D0A',
    chaosLimit: 3,   // больше повреждённых полей — хаотичный пакет
    vwLo: 7.2, vwHi: 8.5, vcLo: 6.6, vcHi: 8.7,
    windowSec: 300,  // окно графика, с
    theme: 'auto',
    instruments: 'right', // 'right' — колонка в «Обзоре», 'left' — постоянная панель
    thresholds: 1,
    animate: 1,
    autoPoll: 1,     // подбирать интервал опроса по полноте потока
  };

  const $ = selector => document.querySelector(selector);
  const $$ = selector => Array.prototype.slice.call(document.querySelectorAll(selector));

  function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, character => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]
    ));
  }

  const clock = () => new Date().toLocaleTimeString('ru-RU', { hour12: false });

  function duration(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor(total % 3600 / 60);
    const s = total % 60;
    const pad = value => String(value).padStart(2, '0');
    return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }

  const plural = (count, one, few, many) => {
    const mod100 = count % 100, mod10 = count % 10;
    if (mod100 >= 11 && mod100 <= 14) return many;
    if (mod10 === 1) return one;
    if (mod10 >= 2 && mod10 <= 4) return few;
    return many;
  };

  const LEVEL_TEXT = ['Норма', 'Внимание', 'Авария'];

  /* Локальное хранилище: настройки и журнал. Ошибки доступа (приватный
     режим браузера) не должны останавливать работу пульта.               */
  const storage = {
    read(key) {
      try { return JSON.parse(localStorage.getItem(STORE + '.' + key)); }
      catch (error) { return null; }
    },
    write(key, value) {
      try { localStorage.setItem(STORE + '.' + key, JSON.stringify(value)); return true; }
      catch (error) { return false; }
    },
    drop(key) {
      try { localStorage.removeItem(STORE + '.' + key); } catch (error) { /* пусто */ }
    },
  };

  /* ── 2. Состояние ───────────────────────────────────────────────────────*/

  const state = {
    cfg: Object.assign({}, DEFAULT_CFG, storage.read('cfg') || {}),
    mode: 'live',            // 'live' — эмулятор, 'replay' — запись
    frozen: false,
    net: 'wait',             // 'wait' | 'ok' | 'down'
    stream: new A.Stream(),
    frame: null,
    modules: [],              // заполняется renderModules() при первом проходе
    lastRaw: '',
    latency: 0,
    latencyMax: 0,
    pollErrors: 0,
    failStreak: 0,         // подряд неудачных опросов: основание для паузы
    rollbackRun: 0,
    rebootAt: 0,
    sessionStart: Date.now(),
    alarmSeconds: 0,       // суммарное время в аварии (уровень 2)
    events: [],
    view: 'overview',
    chartGroup: 'pwr',
    hiddenSeries: {},
    dirty: true,             // требуется перерисовать графики и сцену
    replay: { lines: [], i: 0, speed: 1, playing: true, credit: 0, name: '' },
    savedSession: storage.read('log'),
    commandChannel: 'unknown',  // 'unknown' | 'open' | 'local'
    queue: [],
    commandLog: [],
    previousLevels: {},
  };

  const isStale = () => state.mode === 'live' && !state.frozen &&
    state.stream.idleSeconds(Date.now()) > state.cfg.stale;

  const rebooted = () => Date.now() - state.rebootAt < 15000;

  /* ── 3. Журнал событий ──────────────────────────────────────────────────*/

  function log(level, message) {
    state.events.unshift({ t: clock(), l: level, msg: message });
    if (state.events.length > MAX_EVENTS) state.events.pop();
  }

  /* ── 4. Приём пакета ────────────────────────────────────────────────────*/

  /**
   * Разбирает строку, обновляет счётчики и состояние.
   * Возвращает true, если состояние изменилось и пора перерисовывать.
   */
  function ingest(raw, stamp) {
    const frame = T.parse(raw, state.cfg);
    T.derive(frame);
    const result = state.stream.record(frame, stamp);

    /* Серия одинаковых событий (например, 200 кадров подряд с меткой OFF)
       схлопывается в одну запись: счётчик ведётся в «Потоке» и в списке
       причин, а журнал остаётся читаемым.                                */
    for (const note of result.notes) {
      const last = state.events[0];
      if (!last || last.msg !== note.text || last.l !== note.level) log(note.level, note.text);
    }

    /* Три отката счётчика подряд — не помеха, а перезапуск МК */
    const rolled = result.notes.some(note => note.key === 'rollback');
    state.rollbackRun = rolled ? state.rollbackRun + 1 : 0;
    if (state.rollbackRun === 3 && result.accepted) {
      state.rebootAt = Date.now();
      log(1, 'Счётчик времени МК сброшен: вероятен перезапуск контроллера');
    }

    if (!result.accepted && frame.level === 2) {
      /* одинаковые отказы не должны забивать журнал */
      const last = state.events[0];
      if (!last || !last.msg.startsWith(frame.reason || '')) log(2, 'Отклонён пакет: ' + frame.reason);
      return true;
    }

    state.frame = frame;
    return true;
  }

  /* ── 5. Состояние канала ────────────────────────────────────────────────*/

  function linkState() {
    if (state.frozen) return { level: 1, text: 'Приём заморожен оператором' };
    if (state.mode === 'replay') {
      const replay = state.replay;
      const done = replay.i >= replay.lines.length;
      return {
        level: 1,
        text: done ? 'Запись воспроизведена полностью' : 'Воспроизведение записи · ' + replay.name,
      };
    }
    if (state.net === 'down') return { level: 2, text: 'Эмулятор недоступен' };
    if (state.net === 'wait') return { level: 1, text: 'Ожидание данных' };
    if (isStale()) return { level: 2, text: 'Передача данных прекращена' };
    return { level: 0, text: 'Приём телеметрии' };
  }

  /* Тревога собирается из состояния канала и состояния модулей —
     это единственное место, где решается, что показывать оператору.   */
  function alarmState() {
    const items = [];
    const link = linkState();

    /* Если канал не работает, состояние модулей производно: перечислять
       каждую строку «передача прекращена» не informative — достаточно
       одной причины верхнего уровня.                                    */
    if (link.level === 2) {
      items.push({ level: 2, text: link.text });
      if (state.mode === 'live') items.push({ level: 2, text: 'Проверьте, запущен ли эмулятор: python emulator.py' });
      return { level: 2, items };
    }

    for (const module of state.modules) {
      if (module.level > 0) {
        items.push({ level: module.level, text: module.name + ' — ' + module.why });
        if (module.level === 2) break;
      }
    }
    const level = items.reduce((worst, item) => Math.max(worst, item.level), 0);
    return { level, items };
  }

  /* ── 6. Источник данных ─────────────────────────────────────────────────*/

  let inFlight = false;

  /** Один опрос эмулятора. Ответ содержит только последний кадр. */
  async function poll() {
    if (state.frozen || state.mode !== 'live' || inFlight) return;
    inFlight = true;
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);

    try {
      const response = await fetch(state.cfg.url, {
        cache: 'no-store', signal: controller.signal, mode: 'cors',
      });
      if (response.status === 204) {
        state.net = 'wait';
        state.failStreak = 0;
      } else if (response.ok) {
        state.net = 'ok';
        state.failStreak = 0;
        state.latency = performance.now() - started;
        state.latencyMax = Math.max(state.latencyMax, state.latency);
        const text = (await response.text()).trim();
        if (text && text !== state.lastRaw) {
          state.lastRaw = text;
          if (ingest(text)) state.dirty = true;
        }
      } else {
        state.net = 'down';
        state.failStreak++;
      }
    } catch (error) {
      state.net = 'down';
      state.failStreak++;
      state.pollErrors++;
    } finally {
      clearTimeout(timer);
      inFlight = false;
    }
  }

  function pollLoop() {
    poll();
    /* Пока источник недоступен, опрос замедляется: иначе пульт пустым
       запросом грузит порт и засоряет консоль браузера ошибками.     */
    const backoff = state.net === 'down' ? Math.min(8, state.failStreak) : 1;
    setTimeout(pollLoop, Math.min(1000, state.cfg.poll * backoff));
  }

  /**
   * Подбор частоты опроса.
   *
   * Эмулятор отвечает только последним кадром, поэтому при слишком редком
   * опросе часть потока физически не доходит до пульта. Счётчик МК
   * позволяет это измерить: полнота потока падает вместе с частотой.
   * Контроллер уменьшает интервал, пока поток теряется, и возвращает его
   * обратно, когда запас появился.
   */
  const POLL_MIN = 40, POLL_MAX = 400;
  let lastTune = 0;

  function tunePolling(now) {
    if (!state.cfg.autoPoll || now - lastTune < 5000) return;
    if (state.stream.accepted < 40) return;
    lastTune = now;

    const completeness = state.stream.completeness(120);
    if (completeness === null) return;

    let next = state.cfg.poll;
    if (completeness < 90) next = Math.max(POLL_MIN, Math.round(next * 0.8));
    else if (completeness > 99.5 && next < 100) next = Math.min(100, Math.round(next * 1.08));
    if (next === state.cfg.poll) return;

    state.cfg.poll = next;
    storage.write('cfg', state.cfg);
    $('#setPoll').value = String(next);
    log(1, 'Интервал опроса подобран автоматически: ' + next + ' мс, полнота потока ' +
      completeness.toFixed(0) + ' %');
  }

  /* Воспроизведение записи: те же строки и тот же разбор, что и поток. */
  function replayTick() {
    const replay = state.replay;
    if (state.mode !== 'replay' || !replay.playing || state.frozen) return;
    if (replay.i >= replay.lines.length) {
      replay.playing = false;
      log(1, 'Запись воспроизведена полностью: ' + replay.lines.length + ' строк');
      render();
      return;
    }
    const batch = replay.speed === 0 ? 25 : Math.max(1, replay.speed);
    for (let i = 0; i < batch && replay.i < replay.lines.length; i++) {
      if (ingest(replay.lines[replay.i++])) state.dirty = true;
    }
  }

  function startReplay(text, label) {
    const lines = text.split(/\r?\n/).filter(line => line.trim());
    if (lines.length && /ПРЕАМБУЛА/i.test(lines[0])) lines.shift();
    if (!lines.length) { log(2, 'Файл пуст: ' + label); return; }

    state.stream.reset();
    state.frame = null;
    state.events = [];
    state.previousLevels = {};
    state.lastRaw = '';
    state.rebootAt = 0;
    state.rollbackRun = 0;
    state.mode = 'replay';
    state.net = 'wait';
    state.replay = { lines, i: 0, speed: Number($('#jrReplaySpeed').value), playing: true, credit: 0, name: label };
    state.dirty = true;
    log(0, 'Открыта запись «' + label + '»: строк ' + lines.length);
    render();
  }

  function backToLive() {
    state.mode = 'live';
    state.stream.reset();
    state.frame = null;
    state.lastRaw = '';
    state.net = 'wait';
    state.rebootAt = 0;
    state.rollbackRun = 0;
    state.dirty = true;
    log(0, 'Возврат к эмулятору');
    render();
  }

  /* ── 7. Команды ─────────────────────────────────────────────────────────
     Эмулятор телеметрии — приёмник: он реализует только GET /telemetry
     и на любой другой запрос отвечает ошибкой. Поэтому пульт один раз
     проверяет канал настоящим запросом и честно сообщает результат,
     а не изображает передачу.                                            */

  const COMMANDS = [
    { code: 'PING', name: 'Проверка канала', note: 'Борт отвечает кадром с обновлённым временем МК.' },
    { code: 'STATUS', name: 'Запрос телеметрии', note: 'Принудительная выдача всех показаний.' },
    { code: 'WHEEL_SET', name: 'Скорость маховика', arg: { min: -32768, max: 32767, hint: 'знаковое целое число; знак задаёт направление вращения' } },
    { code: 'RESET_IMU', name: 'Сброс оценки ориентации', note: 'Повторная триадизация по акселерометру и магнитометру.' },
    { code: 'DUMP_LOG', name: 'Выгрузка журнала', note: 'Передать накопленный журнал на борт.' },
  ];

  function commandEndpoint() {
    /* Адрес канала команд выводится из адреса источника: тот же хост и
       порт, последний сегмент пути заменяется на «command». Сборка через
       URL, а не склейкой строк: адрес без пути («http://host:8765») при
       склейке теряет хост, а строка с запросом — «?».                */
    try {
      const url = new URL(state.cfg.url);
      url.pathname = url.pathname.replace(/[^/]*$/, '') + 'command';
      url.search = '';
      url.hash = '';
      return url.href;
    } catch (error) {
      return state.cfg.url.replace(/\/+$/, '') + '/command';
    }
  }

  /**
   * Проверяет, объявлен ли на борту канал передачи команд.
   *
   * Запрос сделан методом GET: он не требует предзапроса CORS, поэтому
   * ответ читается целиком. Эмулятор телеметрии отвечает на любой путь,
   * кроме /telemetry, кодом 404 — это и есть однозначный признак того,
   * что борт только слушает. Один запрос вместо перебора.
   */
  async function probeCommandChannel(quiet) {
    const endpoint = commandEndpoint();
    let verdict = 'local';
    try {
      const response = await fetch(endpoint, { cache: 'no-store', mode: 'cors' });
      verdict = (response.ok || response.status === 405) ? 'open' : 'local';
    } catch (error) {
      verdict = 'local';
    }
    state.commandChannel = verdict;
    renderChannel();
    if (!quiet) {
      log(verdict === 'open' ? 0 : 1,
        verdict === 'open'
          ? 'Борт принимает команды: ' + endpoint
          : 'Борт объявил только приём телеметрии (' + endpoint + ' → ' +
            (verdict === 'local' ? 'нет ответа или отказ' : 'отказ') + '); команды выполняются в локальной модели');
    }
    return verdict;
  }

  function renderChannel() {
    const map = {
      unknown: [1, 'Канал не проверен'],
      open: [0, 'Канал передачи доступен'],
      local: [1, 'Борт принимает только телеметрию'],
    };
    const entry = map[state.commandChannel];
    const node = $('#cmChannel');
    node.dataset.level = entry[0];
    node.querySelector('.chan__text').textContent = entry[1];
    $('#cmChannelMeta').textContent = state.commandChannel === 'local' ? 'только приём' : state.commandChannel;
    $('#cmSubmit').disabled = state.frozen;
  }

  function submitCommand(event) {
    event.preventDefault();
    const code = $('#cmCmd').value;
    const spec = COMMANDS.find(item => item.code === code);
    const paramInput = $('#cmParam');
    const error = $('#cmError');
    let param = '';

    if (spec.arg) {
      const value = paramInput.value.trim();
      if (!/^-?\d+$/.test(value) || Number(value) < spec.arg.min || Number(value) > spec.arg.max) {
        error.hidden = false;
        error.textContent = 'Аргумент — целое число от −' + (-spec.arg.min) + ' до ' + spec.arg.max;
        paramInput.focus();
        return;
      }
      param = value;
    }
    error.hidden = true;

    const item = {
      at: clock(),
      code, param,
      level: 1,
      state: 'В очереди',
      detail: '',
      started: Date.now(),
    };
    state.queue.unshift(item);
    if (state.queue.length > 60) state.queue.pop();
    logCommand(1, 'Команда ' + code + (param ? ' (' + param + ')' : '') + ' поставлена в очередь');
    renderQueue();
    transmit(item);
  }

  /* Одна попытка настоящей передачи; при отказе канала команда
     доставляется в локальной модели — с честной пометкой в журнале.   */
  function transmit(item) {
    if (state.commandChannel === 'unknown') probeCommandChannel(true);

    const finish = (level, stateText, detail) => {
      item.level = level;
      item.state = stateText;
      item.detail = detail;
      const suffix = item.param ? ' (' + item.param + ')' : '';
      logCommand(level, 'Команда ' + item.code + suffix + ': ' + stateText);
      renderQueue();
    };

    setTimeout(async () => {
      if (state.commandChannel === 'open') {
        try {
          const response = await fetch(commandEndpoint(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: item.code, argument: item.param }),
            cache: 'no-store',
            mode: 'cors',
          });
          if (response.ok) { finish(0, 'Передана', 'ответ ' + response.status); return; }
          state.commandChannel = 'local';
          renderChannel();
        } catch (error) { /* переходим в локальный режим ниже */ }
      }

      if (state.frozen || linkState().level === 2) {
        finish(2, 'Не передана: нет подтверждённой связи с бортом',
          'устраните аварию канала и повторите');
        return;
      }
      const predicted = predictEffect(item);
      finish(state.commandChannel === 'open' ? 0 : 1,
        state.commandChannel === 'open' ? 'Передана' : 'Выполнена локально',
        'эмулятор не принимает команды' + (predicted ? '; ' + predicted : ''));
    }, 450 + Math.random() * 400);
  }

  /* Что команда должна изменить по телеметрии — показываем оператору
     ожидаемый результат, а не просто «ок».                              */
  function predictEffect(item) {
    if (item.code !== 'WHEEL_SET' || !state.frame) return '';
    const current = T.value(state.frame, 'wheel');
    return 'ожидаемая скорость маховика ' + item.param +
      (current === null ? '' : ' (сейчас ' + current + ')');
  }

  /* ── 8. Отрисовка: шапка, тревога, модули ───────────────────────────────*/

  /* Полоса тревоги объявлена скринридеру (role=status + aria-live).
     Переписывать её на каждом проходе отрисовки нельзя: озвучка повторит
     один и тот же текст. Поэтому DOM трогается только при смене текста.  */
  let alarmSignature = '';

  /* Вердикт в шапке — ответ на вопрос «что с аппаратом» одним словом.
     Уровень 3 означает «данных нет»: это не авария, но и не норма,
     и путать его с зелёным нельзя.                                     */
  const VERDICT_WORD = ['НОРМА', 'ВНИМАНИЕ', 'АВАРИЯ', 'НЕТ ДАННЫХ'];

  function renderVerdict() {
    const node = $('#verdict');
    const level = alarmState().level;
    node.dataset.level = level;
    $('#verdictWord').textContent = VERDICT_WORD[level];

    /* Под словом — самая важная причина: её достаточно для первого
       действия оператора, остальное он увидит в приборной панели.  */
    const alarm = alarmState();
    const first = alarm.items[0];
    const why = first ? first.text
      : state.frame ? 'все модули в допуске'
        : 'ожидание первого пакета';
    $('#verdictWhy').textContent = why;
  }

  function renderChrome() {
    renderVerdict();

    const summary = state.stream.summary();
    $('#ro-mk').textContent = state.frame ? state.frame.mk : '—';
    $('#ro-ok').textContent = summary.accepted;
    $('#ro-bad').textContent = summary.rejected;
    $('#ro-rate').innerHTML = (summary.rate ? summary.rate.toFixed(1) : '—') + '<span class="unit">Гц</span>';
    $('#ro-bad').style.color = summary.rejected ? 'var(--bad)' : '';
    $('#ro-ok').style.color = summary.defective ? 'var(--warn)' : '';

    $('#btnFreeze').setAttribute('aria-pressed', String(state.frozen));
    $('#btnFreeze').textContent = state.frozen ? 'Возобновить' : 'Заморозить';

    const conn = { ok: 'эмулятор отвечает', down: 'нет ответа', wait: 'ожидание данных' };
    $('#setConnMeta').textContent = conn[state.net] || '—';

    const alarm = alarmState();
    const bar = $('#alarmBar');
    bar.hidden = alarm.level === 0;

    const shown = alarm.items.slice(0, 3).map(item => item.text).join('; ');
    const rest = alarm.items.length - 3;
    const signature = alarm.level + '|' + shown + '|' + rest;

    if (signature !== alarmSignature) {
      alarmSignature = signature;
      bar.dataset.level = alarm.level || '';
      bar.innerHTML = alarm.level
        ? '<span class="alarm__label">' + (alarm.level === 2 ? 'Авария' : 'Внимание') + '</span>' +
          '<span class="alarm__text">' + escapeHtml(shown) + (rest > 0 ? '; и ещё ' + rest : '') + '</span>'
        : '';
    }
  }

  /* ── Приборная панель ──────────────────────────────────────────────────
     Постоянная левая колонка: канал, приборы, живая лента событий.
     Обновляется каждый проход — здесь оператор всегда видит актуальное
     состояние, независимо от открытого экрана.                        */

  function renderRail() {
    /* Канал: тот же индикатор, что был в шапке, переехал в панель */
    const link = linkState();
    const chan = $('#linkState');
    chan.dataset.level = link.level;
    $('#linkLabel').textContent = link.text;

    /* Четыре числа, которые оператор проверяет чаще всего: насколько свежи
       кадр, насколько полон поток и что накопилось за сеанс. Частоты здесь
       нет — она уже стоит в шапке, показывает то же самое число и в рельсе
       стояла вторым дублем одного и того же значения. Полная сводка — на
       экране 01. */
    const summary = state.stream.summary();
    const age = state.stream.idleSeconds(Date.now());
    $('#railStats').innerHTML = [
      ['Возраст кадра', !isFinite(age) ? '—'
        : (age < 10 ? age.toFixed(1) : Math.round(age)) + ' <span class="unit">с</span>'],
      ['Полнота', summary.completeness === null ? '—' : summary.completeness.toFixed(0) + ' <span class="unit">%</span>'],
      ['Пропущено', String(summary.lost)],
      ['Ошибок опроса', String(state.pollErrors)],
    ].map(row => '<dt>' + row[0] + '</dt><dd>' + row[1] + '</dd>').join('');

    /* Лента событий. Обрезается по высоте панели, поэтому здесь
       достаточно верхних записей: важна свежесть, а не полнота.
       Счётчик ведёт в полный журнал: из ленты иначе некуда пойти. */
    $('#railEventsAll').textContent =
      state.events.length + ' ' + plural(state.events.length, 'запись', 'записи', 'записей');
    $('#railEvents').innerHTML = state.events.slice(0, 14).map(event =>
      '<li data-level="' + event.l + '"><time>' + event.t + '</time>' +
      '<span class="msg">' + escapeHtml(event.msg) + '</span></li>'
    ).join('');
  }

  function renderModules() {
    state.modules = A.modules(state.frame, {
      cfg: state.cfg,
      stale: isStale(),
      rebooted: rebooted(),
    });

    const problems = state.modules.filter(module => module.level > 0);
    $('#ovModulesMeta').textContent = state.frame
      ? problems.length
        ? problems.length + ' ' + plural(problems.length, 'замечание', 'замечания', 'замечаний')
        : 'все в норме'
      : 'нет данных';

    /* Приборная панель узкая: показание идёт строкой под именем,
       уровень — отдельной колонкой справа. */
    $('#ovModules').innerHTML = state.modules.map(module => (
      '<tr>' +
        '<td><span class="dev-name">' + escapeHtml(module.name) + '</span>' +
        '<span class="dev-role">' + escapeHtml(module.role) + '</span>' +
        '<span class="dev-read">' + escapeHtml(module.reading) + '</span></td>' +
        '<td><span class="state' + (module.level === 2 ? ' is-alarm' : '') + '" data-level="' + module.level + '">' +
        LEVEL_TEXT[module.level] + '</span>' +
        '<span class="state__why">' + escapeHtml(module.why) + '</span></td>' +
      '</tr>'
    )).join('');

    /* Изменение состояния модуля само по себе является событием */
    for (const module of state.modules) {
      const previous = state.previousLevels[module.id];
      if (previous !== undefined && previous !== module.level && state.frame) {
        log(module.level, module.name + ': ' + module.why);
      }
      state.previousLevels[module.id] = module.level;
    }
  }

  function renderStream() {
    const summary = state.stream.summary();
    $('#ovFlowMeta').textContent = 'сеанс ' + duration(summary.uptime);

    const rows = [
      ['Длительность сеанса', duration(summary.uptime)],
      ['Частота обновления', summary.rate.toFixed(2) + ' <span class="unit">Гц</span>'],
      ['Задержка опроса', Math.round(state.latency) + ' <span class="unit">мс</span>'],
      ['Задержка, максимум', Math.round(state.latencyMax) + ' <span class="unit">мс</span>'],
      ['Пропущено по счётчику МК', String(summary.lost)],
      ['Полнота потока, сеанс', summary.completeness === null ? '—' : summary.completeness.toFixed(1) + ' <span class="unit">%</span>'],
      ['Полнота потока, 2 мин', summary.recentCompleteness === null ? '—' : summary.recentCompleteness.toFixed(1) + ' <span class="unit">%</span>'],
      ['Принято с замечаниями', String(summary.defective)],
      ['Ошибок опроса', String(state.pollErrors)],
      ['Время в аварии', duration(state.alarmSeconds)],
      ['Модулей с замечаниями', String(state.modules.filter(module => module.level > 0).length)],
    ];
    $('#ovStats').innerHTML = rows.map(row =>
      '<dt>' + row[0] + '</dt><dd>' + row[1] + '</dd>').join('');

    const frame = state.frame;
    $('#ovRawMeta').textContent = frame ? 'МК ' + frame.mk + ' с' : '—';
    const raw = $('#ovRaw');
    raw.textContent = state.lastRaw || '—';
    raw.dataset.level = frame ? (frame.level === 2 ? 2 : 0) : 0;

    /* Сторонние датчики по I2C добавляют поля сверх протокола. Молча
       игнорировать их нельзя: оператор должен знать, что конструктор
       сообщает больше, чем описано в протоколе.                        */
    let note = frame && frame.level === 1
      ? frame.reason
      : 'Эмулятор отдаёт только последний кадр: между двумя полученными пакетами счётчик МК может вырасти на несколько.';
    if (frame && frame.extraFields > 0) {
      note += ' Пакет содержит дополнительных полей: ' + frame.extraFields +
        ' — сторонние датчики по I2C, показания стандартных полей достоверны.';
    }
    $('#ovRawNote').textContent = note;
  }

  /* ── 9. Отрисовка: графики и поля ───────────────────────────────────────*/

  /* Кадры, попавшие в окно графика. Граница ищется делением пополам
     внутри Stream — здесь только отбрасывается всё старше окна. */
  function windowFrames() {
    return state.stream.framesSince(Date.now() - state.cfg.windowSec * 1000);
  }

  function renderVoltage() {
    const frames = windowFrames();
    const cfg = state.cfg;
    const points = frames.map(frame => frame.groups.akb);
    $('#ovVoltMeta').textContent = 'В · ' + (state.cfg.windowSec / 60) + ' мин';

    V.plot($('#ovVoltChart'), {
      series: [{ label: 'АКБ', points, color: 0 }],
      digits: 2,
      band: [cfg.vwLo, cfg.vwHi],
      thresholds: cfg.thresholds ? [
        { value: cfg.vcLo, level: 2, label: 'авария ' + cfg.vcLo.toFixed(2) },
        { value: cfg.vwLo, level: 1, label: 'внимание ' + cfg.vwLo.toFixed(2) },
        { value: cfg.vwHi, level: 1, label: 'внимание ' + cfg.vwHi.toFixed(2) },
        { value: cfg.vcHi, level: 2, label: 'авария ' + cfg.vcHi.toFixed(2) },
      ] : [],
      xLeft: '−' + duration(state.cfg.windowSec) + ' назад',
      xRight: 'сейчас',
      empty: 'Ожидание данных от эмулятора',
    });

    $('#ovVoltLegend').innerHTML = cfg.thresholds
      ? '<li><span class="key" style="border-color:var(--ok);opacity:.35"></span>рабочий диапазон ' +
        cfg.vwLo.toFixed(2) + '…' + cfg.vwHi.toFixed(2) + ' В</li>' +
        '<li><span class="key" style="border-top-style:dashed;border-color:var(--bad)"></span>границы аварии</li>'
      : '';
  }

  /* Переключатель групп параметров строится из протокола: новый ряд
     датчиков в пакете появится в интерфейсе автоматически.             */
  function buildGroupTabs() {
    $('#tlGroups').innerHTML = T.CHART_GROUPS.map(group =>
      '<button type="button" role="tab" data-group="' + group.key + '" aria-selected="' +
      (group.key === state.chartGroup) + '">' + group.name + '</button>').join('');
  }

  function renderTelemetryChart() {
    const group = T.CHART_GROUPS.find(item => item.key === state.chartGroup) || T.CHART_GROUPS[0];
    const frames = windowFrames();

    const series = group.series.map(item => ({
      label: item.label,
      color: item.color,
      dash: item.dash,
      hidden: state.hiddenSeries[group.key + item.label],
      points: frames.map(frame => T.value(frame, item.key)),
    }));

    V.plot($('#tlChart'), {
      series, digits: group.digits,
      xLeft: '−' + duration(state.cfg.windowSec) + ' назад',
      xRight: 'сейчас',
      empty: state.frame ? 'Нет данных по этой группе: датчик недоступен' : 'Ожидание данных',
    });

    /* Легенда одновременно показывает текущие значения и позволяет
       убрать шумный ряд: сравнение «все оси сразу» мешает читать график. */
    $('#tlLegend').innerHTML = series.map(item => {
      const last = item.points.length ? item.points[item.points.length - 1] : null;
      const value = last === null || last === undefined ? 'нет данных' : last.toFixed(group.digits) + ' ' + group.unit;
      const key = group.key + item.label;
      return '<li><button type="button" data-series="' + escapeHtml(key) + '" aria-pressed="' +
        (!item.hidden) + '"><i class="key" style="border-color:var(--c' + ((item.color % 4) + 1) + ');' +
        (item.dash ? 'border-top-style:dashed' : '') + '"></i>' + escapeHtml(item.label) +
        '<span class="val">' + escapeHtml(value) + '</span></button></li>';
    }).join('');
  }

  function renderFields() {
    const frame = state.frame;
    if (!frame) {
      $('#tlFieldsMeta').textContent = 'нет данных';
      $('#tlFields').innerHTML = '';
      return;
    }
    const issues = T.FIELDS.map((def, i) => state.stream.fieldIssue(i)).filter(item => item.total > 0).length;
    $('#tlFieldsMeta').textContent = T.FIELDS.length + ' ' +
      plural(T.FIELDS.length, 'поле', 'поля', 'полей') +
      (issues ? ' · с замечаниями ' + issues : ' · все достоверны');

    $('#tlFields').innerHTML = T.FIELDS.map((def, i) => {
      const slot = frame.fields[i];
      const info = T.STATE_TEXT[slot.state];
      const digits = def.kind === 'raw' || def.kind === 'time' ? 0 : 3;
      const physical = slot.value === null ? '—' : slot.value.toFixed(digits) + ' ' + def.unit;
      return '<tr>' +
        '<th scope="row">' + escapeHtml(def.label) +
        '<span class="mod-role">' + (def.kind === 'scaled' ? '÷ ' + def.div + ' → ' + def.unit : 'как есть') + '</span></th>' +
        '<td class="num">' + escapeHtml(slot.token || '—') + '</td>' +
        '<td class="num">' + escapeHtml(physical) + '</td>' +
        '<td><span class="state" data-level="' + info[1] + '">' + escapeHtml(info[0]) + '</span></td>' +
        '</tr>';
    }).join('');
  }

  function renderMatrix() {
    const labels = T.FIELDS.slice(1).map(def => def.short);
    const columns = state.stream.matrix;
    V.matrix($('#tlMatrix'), columns, labels, 'последние ' + columns.length + ' ' +
      plural(columns.length, 'пакет', 'пакета', 'пакетов'));
    $('#tlMatrixMeta').textContent = columns.length + ' ' +
      plural(columns.length, 'пакет', 'пакета', 'пакетов') + ' · ' + T.FIELDS.length + ' полей';
    $('#tlMatrixLegend').innerHTML =
      '<li><i class="swatch swatch--ok"></i>достоверно</li>' +
      '<li><i class="swatch swatch--warn"></i>OFF</li>' +
      '<li><i class="swatch swatch--warn" style="opacity:.5"></li>насыщение</li>' +
      '<li><i class="swatch swatch--bad"></i>повреждено</li>';
  }

  /* Сводка по кадру для экрана 02: производные векторы и их модули.
     Таблица полей показывает каждое значение отдельно, здесь оператор
     получает ответ на вопрос «а что из этого следует».               */
  function renderFrameStats() {
    const frame = state.frame;
    const node = $('#tlRawStats');
    if (!frame) { node.innerHTML = ''; return; }
    const angles = A.attitude(frame);
    const mag = (vector, digits, unit) => vector === null
      ? '—' : Math.hypot.apply(null, vector).toFixed(digits) + ' ' + unit;
    const rows = [
      ['|a| акселерометр', mag(frame.groups.a, 3, 'g')],
      ['|ω| гироскоп', mag(frame.groups.g, 2, '°/с')],
      ['|B| магнитометр', mag(frame.groups.m, 2, 'Гс')],
      ['Крен φ', A.degrees(angles.roll)],
      ['Тангаж θ', A.degrees(angles.pitch)],
      ['Курс ψ', A.degrees(angles.yaw)],
      ['Маховик', frame.groups.wheel === null ? '—' : frame.groups.wheel],
      ['СД1…СД4', frame.groups.lum.map(v => v === null ? '—' : v).join(' ')],
    ];
    node.innerHTML = rows.map(row => '<dt>' + row[0] + '</dt><dd>' + row[1] + '</dd>').join('');
  }

  function renderDefects() {
    const list = state.stream.defectList();
    const total = list.reduce((sum, item) => sum + item.count, 0);
    $('#tlDefectsMeta').textContent = total ? 'всего ' + total : 'отклонений нет';
    if (!list.length) {
      $('#tlDefects').innerHTML = '<li class="note">Отклонений нет: поток соответствует протоколу.</li>';
      return;
    }
    $('#tlDefects').innerHTML = list.slice(0, 8).map(item => {
      const share = Math.round(item.count / list[0].count * 100);
      return '<li><div class="row"><span>' + escapeHtml(item.sample || item.key) + '</span><span>' + item.count + '</span></div>' +
        '<div class="bar"><i style="width:' + share + '%"></i></div></li>';
    }).join('');
  }

  /* ── 10. Ориентация ─────────────────────────────────────────────────────*/

  function renderAttitude() {
    const frame = state.frame;
    const angles = frame ? A.attitude(frame) : { roll: null, pitch: null, yaw: null, accValid: false, magValid: false };
    const degrees = A.degrees;

    $('#atAngles').innerHTML =
      '<dt>Крен, φ</dt><dd>' + degrees(angles.roll) + '</dd>' +
      '<dt>Тангаж, θ</dt><dd>' + degrees(angles.pitch) + '</dd>' +
      '<dt>Курс, ψ</dt><dd>' + degrees(angles.yaw) + '</dd>';

    const spin = frame && frame.groups.g;
    const spinAbs = spin ? Math.hypot.apply(null, spin) : null;
    $('#atRates').innerHTML =
      '<dt>ω по X</dt><dd>' + (spin ? spin[0].toFixed(2) : '—') + '</dd>' +
      '<dt>ω по Y</dt><dd>' + (spin ? spin[1].toFixed(2) : '—') + '</dd>' +
      '<dt>ω по Z</dt><dd>' + (spin ? spin[2].toFixed(2) : '—') + '</dd>' +
      '<dt>Модуль |ω|</dt><dd>' + (spinAbs === null ? '—' : spinAbs.toFixed(2)) + '</dd>';

    const field = frame && frame.groups.m;
    const fieldAbs = field ? Math.hypot.apply(null, field) : null;
    $('#atMag').innerHTML =
      '<dt>Модуль |B|</dt><dd>' + (fieldAbs === null ? '—' : fieldAbs.toFixed(3)) + '</dd>' +
      '<dt>B по X</dt><dd>' + (field ? field[0].toFixed(3) : '—') + '</dd>' +
      '<dt>B по Y</dt><dd>' + (field ? field[1].toFixed(3) : '—') + '</dd>' +
      '<dt>B по Z</dt><dd>' + (field ? field[2].toFixed(3) : '—') + '</dd>';

    $('#atNote').textContent = !frame
      ? 'Ожидание данных: ориентация выводится из акселерометра и магнитометра.'
      : 'Крен и тангаж — из акселерометра (он задаёт направление «вниз»), курс — из магнитометра. ' +
        'Это мгновенная оценка без гироскопической интеграции, поэтому она шумная на орбите.';

    V.scene($('#atScene'), {
      roll: angles.roll || 0,
      pitch: angles.pitch || 0,
      yaw: angles.yaw || 0,
      valid: angles.accValid && angles.magValid,
      message: angles.accValid && angles.magValid
        ? 'оценка по данным датчиков'
        : 'часть датчиков недоступна — ориентация показана условно',
    });
  }

  function buildAttitudeLegend() {
    $('#atLegend').innerHTML =
      '<li><i class="swatch swatch--body"></i>корпус</li>' +
      '<li><i class="swatch swatch--panel"></i>солнечные панели</li>' +
      '<li><i class="key" style="border-color:var(--c1)"></i>X</li>' +
      '<li><i class="key" style="border-color:var(--c2)"></i>Y</li>' +
      '<li><i class="key" style="border-color:var(--c3)"></i>Z</li>';
  }

  /* ── 11. Команды, журнал, настройки ──────────────────────────────────────*/

  function renderQueue() {
    $('#cmQueueMeta').textContent = state.queue.length
      ? state.queue.length + ' ' + plural(state.queue.length, 'запись', 'записи', 'записей')
      : 'пусто';
    $('#cmQueue').innerHTML = state.queue.slice(0, 30).map(item =>
      '<tr><td>' + item.at + '</td><td>' + escapeHtml(item.code) + '</td>' +
      '<td class="num">' + escapeHtml(item.param || '—') + '</td>' +
      '<td><span class="state" data-level="' + item.level + '">' + escapeHtml(item.state) + '</span>' +
      (item.detail ? '<span class="state__why">' + escapeHtml(item.detail) + '</span>' : '') +
      '</td></tr>').join('');

    $('#cmLogMeta').textContent = state.commandLog.length + ' ' +
      plural(state.commandLog.length, 'запись', 'записи', 'записей');
    $('#cmLog').innerHTML = state.commandLog.slice(0, 30).map(entry =>
      '<li><time>' + entry.t + '</time><i class="mark" data-level="' + entry.l + '"></i>' +
      '<span class="msg">' + escapeHtml(entry.msg) + '</span></li>').join('') ||
      '<li><span class="note">Команды ещё не отправлялись.</span></li>';
  }

  /* Записи о командах попадают и в общий журнал сеанса, и в свой список —
     оператор видит команду в контексте остальных событий. */
  function logCommand(level, message) {
    log(level, message);
    state.commandLog.unshift({ t: clock(), l: level, msg: message });
    if (state.commandLog.length > 80) state.commandLog.pop();
  }

  /* Один журнал команд на все экраны: он уже ведётся в logCommand(). */

  function renderJournal() {
    const level = $('#jrLevel').value;
    const eventQuery = $('#jrEventSearch').value.trim().toLocaleLowerCase('ru-RU');
    const items = state.events.filter(event => {
      if (level !== 'all' && event.l < Number(level)) return false;
      if (!eventQuery) return true;
      return (event.t + ' ' + event.msg).toLocaleLowerCase('ru-RU').includes(eventQuery);
    });
    $('#jrEventMeta').firstChild.textContent = items.length + ' ' +
      plural(items.length, 'событие', 'события', 'событий') + ' · ' + state.events.length + ' всего ';
    $('#jrEvents').innerHTML = items.slice(0, 80).map(event =>
      '<li><time>' + escapeHtml(event.t) + '</time><i class="mark" data-level="' + event.l + '"></i>' +
      '<span class="msg">' + escapeHtml(event.msg) + '</span></li>').join('') ||
      '<li><span class="note">По заданным условиям событий нет.</span></li>';

    const onlyBad = $('#jrOnlyBad').checked;
    const query = $('#jrSearch').value.trim().toLowerCase();
    const rows = state.stream.log.filter(entry => {
      if (onlyBad && entry.level === 0) return false;
      if (!query) return true;
      return (entry.raw + ' ' + (entry.reason || '') + ' ' + (entry.mk === null ? '' : entry.mk))
        .toLowerCase().includes(query);
    }).slice(-120).reverse();

    $('#jrPacketsMeta').textContent = state.stream.log.length + ' ' +
      plural(state.stream.log.length, 'запись', 'записи', 'записей') +
      (rows.length !== state.stream.log.length ? ' · показано ' + rows.length : '');
    $('#jrPackets').innerHTML = rows.map(entry =>
      '<tr><td>' + new Date(entry.at).toLocaleTimeString('ru-RU', { hour12: false }) + '</td>' +
      '<td class="num">' + (entry.mk === null ? '—' : entry.mk) + '</td>' +
      '<td class="mono" style="font-size:12px">' + escapeHtml(entry.raw.length > 58 ? entry.raw.slice(0, 58) + '…' : entry.raw) +
      '<span class="sr-only">' + escapeHtml(entry.raw) + '</span></td>' +
      '<td><span class="state" data-level="' + (entry.level === 0 ? 0 : entry.level === 1 ? 1 : 2) + '">' +
      (entry.level === 0 ? 'Принят' : escapeHtml(entry.reason || 'С замечаниями')) + '</span></td></tr>').join('') ||
      '<tr><td colspan="4" class="note">Нет записей по фильтру.</td></tr>';

    const summary = state.stream.summary();
    $('#jrReportMeta').textContent = 'на ' + clock();
    $('#jrReport').innerHTML = [
      ['Длительность сеанса', duration(summary.uptime)],
      ['Принято пакетов', String(summary.accepted)],
      ['С замечаниями', String(summary.defective)],
      ['Отклонено', String(summary.rejected)],
      ['Пропущено по счётчику МК', String(summary.lost)],
      ['Полнота потока', summary.completeness === null ? '—' : summary.completeness.toFixed(1) + ' <span class="unit">%</span>'],
      ['Частота', summary.rate.toFixed(2) + ' <span class="unit">Гц</span>'],
      ['Событий в журнале', String(state.events.length)],
    ].map(row => '<dt>' + row[0] + '</dt><dd>' + row[1] + '</dd>').join('');

    $('#jrReplayMeta').innerHTML = state.mode === 'replay'
      ? '<dt>Источник</dt><dd>' + escapeHtml(state.replay.name) + '</dd>' +
        '<dt>Позиция</dt><dd>' + state.replay.i + ' / ' + state.replay.lines.length + '</dd>' +
        '<dt>Темп</dt><dd>' + (state.replay.speed ? '×' + state.replay.speed : 'без пауз') + '</dd>'
      : '';

    $('#jrToLive').hidden = state.mode !== 'replay';
    $('#jrReplayTools').hidden = state.mode !== 'replay';
    $('#jrReplayToggle').textContent = state.replay.playing ? 'Пауза' : 'Продолжить';
    $('#jrResumeSession').hidden = state.mode === 'replay' || !state.savedSession;
    $('#jrResumeSession').textContent = state.savedSession
      ? 'Продолжить прошлый сеанс · ' + state.savedSession.length + ' пакетов'
      : 'Продолжить прошлый сеанс';
  }

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function stamp() {
    return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  }

  /* Выгрузка в формате эмулятора: 18 полей, без лишних колонок,
     поэтому такой файл можно и открыть в пульте, и скормить эмулятору. */
  function exportLog() {
    const frames = state.stream.frames;
    if (!frames.length) { log(1, 'Выгружать нечего: пакетов нет'); return; }
    const text = T.headerLine() + '\r\n' + frames.map(frame => frame.raw).join('\r\n');
    /* BOM нужен, чтобы Excel открыл кириллицу в заголовке без плясок */
    download('introsat-log-' + stamp() + '.csv', '﻿' + text, 'text/csv');
    /* В файл попадает глубина истории, а не весь сеанс: честнее сказать
       об этом, чем сохранить 20 000 последних пакетов под именем
       «журнал сеанса».                                                   */
    log(0, 'Журнал сохранён: ' + frames.length + ' ' +
      plural(frames.length, 'последний пакет', 'последних пакета', 'последних пакетов') +
      (frames.length >= 20000 ? ' — глубина истории сеанса' : ''));
  }

  function exportReport() {
    const text = A.report(state.stream, {
      now: Date.now(),
      source: state.mode === 'replay' ? 'запись «' + state.replay.name + '»' : state.cfg.url,
      latency: state.latency,
      pollErrors: state.pollErrors,
      modules: state.modules,
      frame: state.frame,
      events: state.events,
      cfg: state.cfg,
    });
    download('introsat-report-' + stamp() + '.txt', text, 'text/plain');
    log(0, 'Отчёт о сеансе сохранён');
  }

  /* Экспорт сессии: снимок всего, что пульт знает о текущем сеансе —
     статистика потока, пакеты, события, модули, конфигурация. Файл
     можно открыть позже и перепроверить, откуда взялся тот или иной
     вердикт.                                                          */
  function exportSession() {
    const summary = state.stream.summary();
    const frames = state.stream.frames;
    const session = {
      meta: {
        started: new Date(state.sessionStart).toISOString(),
        ended: new Date().toISOString(),
        version: '1.0',
        source: state.mode === 'replay' ? 'запись «' + state.replay.name + '»' : state.cfg.url,
        mode: state.mode,
      },
      stream: {
        accepted: summary.accepted,
        rejected: summary.rejected,
        defective: summary.defective,
        lost: summary.lost,
        completeness: summary.completeness,
        recentCompleteness: summary.recentCompleteness,
        rate: summary.rate,
        errorRate: summary.errorRate,
        uptime: summary.uptime,
        latency: state.latency,
        latencyMax: state.latencyMax,
        pollErrors: state.pollErrors,
        alarmSeconds: state.alarmSeconds,
      },
      modules: state.modules.map(module => ({
        id: module.id,
        name: module.name,
        role: module.role,
        reading: module.reading,
        level: module.level,
        why: module.why,
      })),
      verdict: {
        level: alarmState().level,
        word: ['НОРМА', 'ВНИМАНИЕ', 'АВАРИЯ', 'НЕТ ДАННЫХ'][alarmState().level],
      },
      events: state.events.slice(),
      frames: frames.map(frame => ({
        mk: frame.mk,
        level: frame.level,
        reason: frame.reason,
        raw: frame.raw,
        at: frame.at,
        extraFields: frame.extraFields,
      })),
      cfg: state.cfg,
    };
    download('introsat-session-' + stamp() + '.json', JSON.stringify(session, null, 2), 'application/json');
    log(0, 'Сессия выгружена: пакетов ' + frames.length + ', событий ' + state.events.length);
  }

  function fillSettings() {
    const map = {
      setUrl: 'url', setPoll: 'poll', setStale: 'stale', setPre: 'pre', setPost: 'post',
      setVwLo: 'vwLo', setVwHi: 'vwHi', setVcLo: 'vcLo', setVcHi: 'vcHi',
      setTheme: 'theme', setThresholds: 'thresholds', setAnimate: 'animate',
      setInstruments: 'instruments',
    };
    for (const [id, key] of Object.entries(map)) $('#' + id).value = state.cfg[key];
    applyInstruments();   // положение приборов — часть настроек, а не только поля формы
    $('#tlWindow').value = String(state.cfg.windowSec);
    $('#setInfo').innerHTML = [
      ['Версия пульта', '1.0'],
      ['Протокол пакета', T.PACKET_SIZE + ' ' + plural(T.PACKET_SIZE, 'поле', 'поля', 'полей') + ', разделитель «;»'],
      ['Поля данных', String(MATRIX_FIELDS)],
      ['Источник по умолчанию', '127.0.0.1:8765'],
      ['Хранение', 'localStorage, без передачи данных'],
    ].map(row => '<dt>' + row[0] + '</dt><dd>' + row[1] + '</dd>').join('');
  }

  function saveSettings() {
    const map = {
      setUrl: 'url', setPoll: 'poll', setStale: 'stale', setPre: 'pre', setPost: 'post',
      setVwLo: 'vwLo', setVwHi: 'vwHi', setVcLo: 'vcLo', setVcHi: 'vcHi',
      setTheme: 'theme', setThresholds: 'thresholds', setAnimate: 'animate',
      setInstruments: 'instruments',
    };
    const NUMERIC = ['poll', 'stale', 'vwLo', 'vwHi', 'vcLo', 'vcHi', 'thresholds', 'animate'];
    const previousPoll = state.cfg.poll;

    for (const [id, key] of Object.entries(map)) {
      const raw = $('#' + id).value;
      if (NUMERIC.indexOf(key) < 0) { state.cfg[key] = raw.trim(); continue; }
      /* Ноль — законное значение («скрыть пороги», «выключить мигание»),
         поэтому отбрасывать поле можно только когда оно пустое или
         нечитаемое: Number(x) || default сбивал 0 на значение по умолчанию. */
      const parsed = Number(raw);
      state.cfg[key] = raw.trim() !== '' && isFinite(parsed) ? parsed : DEFAULT_CFG[key];
    }
    /* Ручная правка интервала отключает автоподборку: решение оператора
       важнее оптимизации. Сравниваем с тем, что было до сохранения, —
       иначе первое же сохранение выключало бы автоподборку целиком.  */
    if (Number($('#setPoll').value) !== Number(previousPoll)) state.cfg.autoPoll = 0;
    state.cfg.windowSec = Number($('#tlWindow').value) || DEFAULT_CFG.windowSec;
    if (!state.cfg.url) state.cfg.url = DEFAULT_CFG.url;
    storage.write('cfg', state.cfg);
    applyTheme();
    applyInstruments();
    state.stream.reset();
    state.frame = null;
    state.lastRaw = '';
    log(0, 'Настройки сохранены, счётчики сеанса сброшены');
    render();
  }

  function applyTheme() {
    document.documentElement.dataset.theme = state.cfg.theme;
    document.body.classList.toggle('no-motion', !Number(state.cfg.animate));
    $('#setThresholds').value = String(state.cfg.thresholds);
    $('#setAnimate').value = String(state.cfg.animate);
    state.dirty = true;
  }

  /* ── Положение приборов ────────────────────────────────────────────────
     Блок «Приборы» переносится между двумя родителями: правой колонкой
     обзора и постоянной панелью. Переносится узел, а не дублируется
     разметка — иначе таблица модулей оказалась бы в двух экземплярах,
     обновлялся бы только один, а вёрстка на узких экранах разошлась бы
     с числом элементов.

     Позиция дублируется атрибутом на корне: по нему CSS прячет пустую
     колонку и перестраивает сетку, не трогая разметку.               */
  function placeInstruments(where) {
    const block = $('#instrBlock');
    const home = where === 'left' ? $('#instrHomeLeft') : $('#instrHomeRight');
    document.documentElement.dataset.instruments = where;
    if (block && home && block.parentNode !== home) home.appendChild(block);
    /* Полотно графика в обзоре могло уехать из-за смены ширины колонки */
    state.dirty = true;
  }

  function applyInstruments() {
    const value = state.cfg.instruments === 'left' ? 'left' : 'right';
    state.cfg.instruments = value;
    if ($('#setInstruments')) $('#setInstruments').value = value;
    placeInstruments(value);
  }

  /* ── 12. Экраны, события интерфейса, клавиатура ─────────────────────────*/

  /* ── Инструменты анализа: статистика, робастные выбросы, CSV ───────── */
  const ANALYSIS_FIELDS = [
    { key: 'akb', label: 'Напряжение АКБ', unit: 'В', digits: 3 },
    { key: 'sd1', label: 'Освещённость СД1', unit: 'ед.', digits: 0 },
    { key: 'sd2', label: 'Освещённость СД2', unit: 'ед.', digits: 0 },
    { key: 'sd3', label: 'Освещённость СД3', unit: 'ед.', digits: 0 },
    { key: 'sd4', label: 'Освещённость СД4', unit: 'ед.', digits: 0 },
    ...['ax','ay','az'].map(key => ({ key, label: key.toUpperCase(), unit: 'g', digits: 4 })),
    ...['gx','gy','gz'].map(key => ({ key, label: key.toUpperCase(), unit: '°/с', digits: 3 })),
    ...['mx','my','mz'].map(key => ({ key, label: key.toUpperCase(), unit: 'Гс', digits: 4 })),
    { key: 'wheel', label: 'Маховик', unit: 'ед.', digits: 0 },
  ];
  let analysisReady = false;
  const analysisFmt = (v, d=2) => Number.isFinite(v) ? v.toFixed(d) : '—';
  function analysisRows() {
    const frames = state.stream.frames;
    const win = $('#anWindow') ? $('#anWindow').value : '300';
    const cutoff = win === 'all' || !frames.length ? -Infinity : Date.now() - Number(win) * 1000;
    return frames.filter(frame => (frame.at || 0) >= cutoff || cutoff === -Infinity);
  }
  function analysisValues(frames, field) {
    const idx = T.IDX[field.key];
    return frames.map(frame => ({ frame, value: idx === undefined || !frame.fields[idx] ? null : frame.fields[idx].value }))
      .filter(row => Number.isFinite(row.value));
  }
  function statsFor(rows) {
    const values = rows.map(row => row.value).filter(Number.isFinite).sort((a,b)=>a-b);
    if (!values.length) return { n: 0, min: null, max: null, mean: null, std: null, missing: rows.length, outliers: [] };
    const mean = values.reduce((sum,v)=>sum+v,0)/values.length;
    const std = Math.sqrt(values.reduce((sum,v)=>sum+(v-mean)**2,0)/values.length);
    const median = values[Math.floor(values.length/2)];
    const deviations = values.map(v=>Math.abs(v-median)).sort((a,b)=>a-b);
    const mad = deviations[Math.floor(deviations.length/2)];
    const threshold = mad > 0 ? 3 * 1.4826 * mad : Math.max(std * 3, 1e-12);
    const outliers = rows.filter(row=>Math.abs(row.value-median)>threshold);
    return { n: values.length, min: values[0], max: values[values.length-1], mean, std, missing: rows.length-values.length, median, threshold, outliers };
  }
  function renderAnalysis() {
    if (!$('#anField')) return;
    if (!analysisReady) {
      const fieldSelect = $('#anField');
      ANALYSIS_FIELDS.forEach(f => { const option = document.createElement('option'); option.value = f.key; option.textContent = f.label; fieldSelect.appendChild(option); });
      analysisReady = true;
    }
    const frames = analysisRows();
    const field = ANALYSIS_FIELDS.find(f=>f.key===$('#anField').value) || ANALYSIS_FIELDS[0];
    const rows = analysisValues(frames, field), stats = statsFor(rows);
    $('#anMeta').textContent = frames.length ? `${frames.length} кадров · ${rows.length} числовых значений` : 'нет данных в выбранном окне';
    $('#anCount').textContent = `${stats.n} / ${frames.length}`;
    $('#anMean').textContent = analysisFmt(stats.mean, field.digits) + (stats.n ? ' '+field.unit : '');
    $('#anMin').textContent = analysisFmt(stats.min, field.digits);
    $('#anMax').textContent = analysisFmt(stats.max, field.digits);
    $('#anStd').textContent = analysisFmt(stats.std, field.digits);
    $('#anOutliers').textContent = stats.outliers.length;
    $('#anChartTitle').textContent = field.label;
    $('#anChartMeta').textContent = stats.n ? `диапазон ${analysisFmt(stats.min,field.digits)}–${analysisFmt(stats.max,field.digits)} ${field.unit}` : 'ожидание пакетов';
    const canvas = $('#anChart'), rect = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const width = Math.max(260, rect.width), height = 250;
    canvas.width = Math.round(width*dpr); canvas.height = Math.round(height*dpr);
    const ctx = canvas.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,width,height);
    const styles = getComputedStyle(document.documentElement), ink=styles.getPropertyValue('--ink').trim(), muted=styles.getPropertyValue('--ink-3').trim(), rule=styles.getPropertyValue('--rule').trim(), accent=styles.getPropertyValue('--accent').trim(), bad=styles.getPropertyValue('--bad').trim();
    const pad={l:52,r:14,t:12,b:28};
    if (rows.length < 2) { ctx.fillStyle=muted;ctx.font='13px system-ui';ctx.fillText('Недостаточно данных для графика',pad.l, height/2); }
    else {
      let lo=stats.min, hi=stats.max; if (hi-lo<1e-12) {lo-=1;hi+=1;} const margin=(hi-lo)*.08;lo-=margin;hi+=margin;
      const x=i=>pad.l+(width-pad.l-pad.r)*i/(rows.length-1), y=v=>pad.t+(height-pad.t-pad.b)*(1-(v-lo)/(hi-lo));
      ctx.font='11px system-ui';ctx.strokeStyle=rule;ctx.fillStyle=muted;ctx.lineWidth=1;
      for(let i=0;i<4;i++){const yy=pad.t+(height-pad.t-pad.b)*i/3;ctx.beginPath();ctx.moveTo(pad.l,yy);ctx.lineTo(width-pad.r,yy);ctx.stroke();ctx.fillText((hi-(hi-lo)*i/3).toFixed(field.digits),2,yy+4);}
      ctx.beginPath(); rows.forEach((r,i)=>i?ctx.lineTo(x(i),y(r.value)):ctx.moveTo(x(i),y(r.value)));ctx.strokeStyle=accent;ctx.lineWidth=1.8;ctx.stroke();
      const outlierSet=new Set(stats.outliers);
      rows.forEach((r,i)=>{if(outlierSet.has(r)){ctx.beginPath();ctx.arc(x(i),y(r.value),3.8,0,Math.PI*2);ctx.fillStyle=bad;ctx.fill();}});
      ctx.fillStyle=muted;ctx.fillText('ранние пакеты',pad.l,height-7);ctx.textAlign='right';ctx.fillText('последний пакет',width-pad.r,height-7);ctx.textAlign='left';
    }
    const allStats = ANALYSIS_FIELDS.map(f=>({field:f,stats:statsFor(analysisValues(frames,f))}));
    const summaryBody = $('#anSummary'); summaryBody.replaceChildren();
    allStats.forEach(({field:f,stats:s}) => { const tr=document.createElement('tr'); const name=document.createElement('th'); name.scope='row'; name.textContent=f.label; tr.appendChild(name);
      [analysisFmt(s.min,f.digits),analysisFmt(s.mean,f.digits),analysisFmt(s.max,f.digits),String(s.missing)].forEach((value,i)=>{const td=document.createElement('td');td.className='num'+(i===3&&s.missing?' analysis-cell-warn':'');td.textContent=value;tr.appendChild(td);}); summaryBody.appendChild(tr); });
    const latest = stats.outliers.slice(-8).reverse();
    $('#anOutlierMeta').textContent = `${stats.outliers.length} точек по MAD`;
    const outBody=$('#anOutlierRows');outBody.replaceChildren();
    if (latest.length) latest.forEach(r=>{const tr=document.createElement('tr');const time=document.createElement('td');time.textContent=(r.frame.mk === null || r.frame.mk === undefined)?'—':analysisFmt(r.frame.mk,1)+' с';tr.appendChild(time);const value=document.createElement('td');value.className='num';value.textContent=analysisFmt(r.value,field.digits)+' '+field.unit;tr.appendChild(value);const verdict=document.createElement('td');verdict.className='analysis-cell-warn';verdict.textContent='проверить';tr.appendChild(verdict);outBody.appendChild(tr);});
    else {const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=3;td.textContent='Подозрительных отклонений не найдено';tr.appendChild(td);outBody.appendChild(tr);}
  }
  function exportAnalysis() {
    const frames=analysisRows();
    const rows=[['Параметр','Единица','Количество','Мин','Среднее','Макс','Станд. отклонение','Пропуски','Выбросы']];
    ANALYSIS_FIELDS.forEach(field=>{const values=analysisValues(frames,field),s=statsFor(values);rows.push([field.label,field.unit,s.n,s.min,s.mean,s.max,s.std,s.missing,s.outliers.length]);});
    const csv='\ufeff'+rows.map(row=>row.map(value=>{const text=(value === null || value === undefined)?'':String(value);return /[;"\n\r]/.test(text)?'"'+text.replace(/"/g,'""')+'"':text;}).join(';')).join('\r\n');
    download('introsat-analysis-'+stamp()+'.csv',csv,'text/csv');
    log(0,'Экспортирована статистика телеметрии');
  }

  function showView(name) {
    state.view = name;
    $$('#tabList [role="tab"]').forEach(tab => {
      tab.setAttribute('aria-selected', String(tab.dataset.view === name));
    });
    $$('.view').forEach(view => { view.hidden = view.id !== 'view-' + name; });
    state.dirty = true;
    render();
    if (name === 'journal') renderJournal();
    if (name === 'analysis') renderAnalysis();
    if (name === 'settings') fillSettings();
  }

  function render() {
    renderModules();
    renderChrome();
    renderRail();
    tunePolling(Date.now());
    /* Суммарное время в аварии (уровень 2) — для сводки за сеанс. */
    if (alarmState().level === 2) state.alarmSeconds += 0.25;
    if (!state.dirty) {
      if (state.view === 'overview') renderStream();
      if (state.view === 'analysis') renderAnalysis();
      return;
    }
    state.dirty = false;
    if (state.view === 'overview') { renderStream(); renderVoltage(); renderTelemetryChart(); renderMatrix(); }
    if (state.view === 'telemetry') { renderFields(); renderDefects(); renderFrameStats(); }
    if (state.view === 'attitude') renderAttitude();
    if (state.view === 'commands') renderQueue();
    if (state.view === 'journal') renderJournal();
    if (state.view === 'analysis') renderAnalysis();
  }

  function bindEvents() {
    /* Навигация */
    $('#tabList').addEventListener('click', event => {
      const tab = event.target.closest('[role="tab"]');
      if (tab) showView(tab.dataset.view);
    });
    $('#tabList').addEventListener('keydown', event => {
      const tabs = $$('#tabList [role="tab"]');
      const index = tabs.indexOf(document.activeElement);
      if (index < 0) return;
      let next = index;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault();
      tabs[next].focus();
      showView(tabs[next].dataset.view);
    });

    /* Инструменты анализа */
    $('#anField').addEventListener('change', renderAnalysis);
    $('#anWindow').addEventListener('change', renderAnalysis);
    $('#anExport').addEventListener('click', exportAnalysis);

    /* Шапка */
    $('#btnFreeze').addEventListener('click', () => {
      state.frozen = !state.frozen;
      log(1, state.frozen ? 'Приём заморожен оператором' : 'Приём возобновлён');
      render();
    });
    $('#btnTheme').addEventListener('click', () => {
      const order = ['auto', 'light', 'dark'];
      state.cfg.theme = order[(order.indexOf(state.cfg.theme) + 1) % order.length];
      applyTheme();
      storage.write('cfg', state.cfg);
      log(0, 'Тема оформления: ' + ({ auto: 'как в системе', light: 'светлая', dark: 'тёмная' })[state.cfg.theme]);
      render();
    });
    $('#btnHelp').addEventListener('click', () => $('#helpSheet').showModal());

    /* Телеметрия */
    $('#tlGroups').addEventListener('click', event => {
      const tab = event.target.closest('[data-group]');
      if (!tab) return;
      state.chartGroup = tab.dataset.group;
      buildGroupTabs();
      state.dirty = true;
      render();
    });
    $('#tlLegend').addEventListener('click', event => {
      const button = event.target.closest('[data-series]');
      if (!button) return;
      const key = button.dataset.series;
      state.hiddenSeries[key] = !state.hiddenSeries[key];
      state.dirty = true;
      render();
    });
    $('#tlWindow').addEventListener('change', () => {
      state.cfg.windowSec = Number($('#tlWindow').value);
      storage.write('cfg', state.cfg);
      state.dirty = true;
      render();
    });

    /* Ориентация: вращение сцены мышью */
    const scene = $('#atScene');
    let dragging = false, lastX = 0, lastY = 0;
    scene.addEventListener('pointerdown', event => {
      dragging = true; lastX = event.clientX; lastY = event.clientY;
      scene.setPointerCapture(event.pointerId);
    });
    scene.addEventListener('pointermove', event => {
      if (!dragging) return;
      V.view.azimuth += (event.clientX - lastX) * 0.008;
      V.view.elevation = Math.max(-1.35, Math.min(1.35, V.view.elevation + (event.clientY - lastY) * 0.008));
      lastX = event.clientX; lastY = event.clientY;
      state.dirty = true;
      render();
    });
    scene.addEventListener('pointerup', event => {
      dragging = false;
      /* Захват мог не достаться до этого события: отпускать нечего,
         а releasePointerCapture бросил бы NotFoundError. */
      if (scene.hasPointerCapture(event.pointerId)) scene.releasePointerCapture(event.pointerId);
    });
    scene.addEventListener('pointercancel', () => { dragging = false; });
    scene.addEventListener('dblclick', () => { V.home(); state.dirty = true; render(); });
    scene.addEventListener('wheel', event => {
      event.preventDefault();
      V.view.distance = Math.max(3.6, Math.min(16, V.view.distance + event.deltaY * 0.006));
      state.dirty = true;
      render();
    }, { passive: false });
    $('#atViewReset').addEventListener('click', () => { V.home(); state.dirty = true; render(); });

    /* Команды */
    $('#cmForm').addEventListener('submit', submitCommand);
    $('#cmCmd').addEventListener('change', () => {
      const spec = COMMANDS.find(item => item.code === $('#cmCmd').value);
      $('#cmParam').disabled = !spec.arg;
      $('#cmParamHint').textContent = spec.arg ? spec.arg.hint : 'Аргумент не требуется.';
      /* Пояснение к команде берётся из её описания: без него поле
         подсказки оставалось пустым, а данные лежали в COMMANDS вхолостую. */
      $('#cmCmdHint').textContent = spec.note || '';
      $('#cmError').hidden = true;
      if (!spec.arg) $('#cmParam').value = '';
    });
    $('#cmClear').addEventListener('click', () => {
      state.queue = [];
      renderQueue();
    });
    $('#cmProbe').addEventListener('click', () => probeCommandChannel(false));

    /* Журнал */
    $('#jrLevel').addEventListener('change', renderJournal);
    $('#jrEventSearch').addEventListener('input', renderJournal);
    $('#jrOnlyBad').addEventListener('change', renderJournal);
    $('#jrSearch').addEventListener('input', renderJournal);
    $('#jrExportCsv').addEventListener('click', exportLog);
    $('#jrExportReport').addEventListener('click', exportReport);
    $('#jrImport').addEventListener('click', () => $('#jrFile').click());
    $('#jrFile').addEventListener('change', async event => {
      const file = event.target.files[0];
      if (file) startReplay(await file.text(), file.name);
      event.target.value = '';
    });
    $('#jrResumeSession').addEventListener('click', () => {
      if (state.savedSession) startReplay(state.savedSession.join('\n'), 'прошлый сеанс');
    });
    $('#jrToLive').addEventListener('click', backToLive);
    $('#jrReplayToggle').addEventListener('click', () => {
      state.replay.playing = !state.replay.playing;
      renderJournal();
    });
    $('#jrReplaySpeed').addEventListener('change', () => {
      state.replay.speed = Number($('#jrReplaySpeed').value);
      renderJournal();
    });

    /* Настройки */
    $('#setSave').addEventListener('click', saveSettings);
    $('#setThresholds').addEventListener('change', () => {
      state.cfg.thresholds = Number($('#setThresholds').value); state.dirty = true; render();
    });
    $('#setAnimate').addEventListener('change', () => {
      state.cfg.animate = Number($('#setAnimate').value); applyTheme(); render();
    });
    $('#setTheme').addEventListener('change', () => {
      state.cfg.theme = $('#setTheme').value; applyTheme(); storage.write('cfg', state.cfg); render();
    });
    /* Положение приборов применяется сразу, без кнопки сохранения:
       переменная одна, её тут же видно на экране, и лишний шаг только
       путает — правило сохранения нужно там, где полей много. */
    /* Счётчик — обычная кнопка в разметке, а не строка, собираемая заново
       каждое обновление: пересоздание узла четыре раза в секунду рвало
       фокус клавиатуры на ровно этом элементе. */
    $('#railEventsAll').addEventListener('click', () => showView('journal'));
    $('#setInstruments').addEventListener('change', event => {
      state.cfg.instruments = event.target.value;
      applyInstruments();
      storage.write('cfg', state.cfg);
      render();
      log(0, 'Приборы: ' + (state.cfg.instruments === 'left'
        ? 'постоянная панель слева' : 'колонка справа в обзоре'));
    });
    $('#setCheck').addEventListener('click', checkConnection);
    $('#setReset').addEventListener('click', () => {
      state.cfg = Object.assign({}, DEFAULT_CFG);
      storage.write('cfg', state.cfg);
      applyTheme();
      fillSettings();
      log(0, 'Настройки сброшены к значениям по умолчанию');
      render();
    });
    $('#setExport').addEventListener('click', () => {
      download('cup-settings-' + stamp() + '.json', JSON.stringify(state.cfg, null, 2), 'application/json');
      log(0, 'Настройки выгружены');
    });
    $('#setExportSession').addEventListener('click', () => {
      exportSession();
    });
    $('#setImport').addEventListener('click', () => $('#setFile').click());
    $('#setFile').addEventListener('change', async event => {
      const input = event.target;
      const file = input.files && input.files[0];
      /* Сбрасываем всегда, иначе повторный выбор того же файла
         не вызовет change и настройки не перезагрузятся. */
      input.value = '';
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        state.cfg = Object.assign({}, DEFAULT_CFG, data);
        storage.write('cfg', state.cfg);
        applyTheme();
        fillSettings();
        log(0, 'Настройки загружены из файла ' + file.name);
      } catch (error) {
        log(2, 'Не удалось прочитать настройки: ' + file.name);
      }
      render();
    });
    $('#setPurge').addEventListener('click', () => {
      storage.drop('log');
      storage.drop('cfg');
      state.savedSession = null;
      state.stream.reset();
      state.frame = null;
      state.lastRaw = '';
      state.events = [];
      log(1, 'Журнал, сеанс и настройки удалены из браузера');
      fillSettings();
      render();
    });

    /* Перерисовка при изменении размера окна и темы */
    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { state.dirty = true; render(); }, 120);
    });
    if (window.matchMedia) {
      const scheme = window.matchMedia('(prefers-color-scheme: dark)');
      scheme.addEventListener('change', () => { state.dirty = true; render(); });
    }

    /* Горячие клавиши оператора */
    document.addEventListener('keydown', event => {
      const target = event.target;
      if (target instanceof Element && target.closest('input, select, textarea, [contenteditable]')) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const views = ['overview', 'telemetry', 'attitude', 'commands', 'journal', 'settings'];
      if (event.key >= '1' && event.key <= '7') { showView(views[Number(event.key) - 1]); return; }
      const key = event.key.toLowerCase();
      if (key === 'p' || key === 'з') { $('#btnFreeze').click(); return; }
      if (key === '?' || event.key === 'F1') { $('#helpSheet').showModal(); return; }
      if (key === 'g' || key === 'п') {
        const index = T.CHART_GROUPS.findIndex(group => group.key === state.chartGroup);
        state.chartGroup = T.CHART_GROUPS[(index + 1) % T.CHART_GROUPS.length].key;
        buildGroupTabs();
        state.dirty = true;
        showView('telemetry');
        return;
      }
      if (key === 'l' || key === 'д') {
        const group = T.CHART_GROUPS.find(item => item.key === state.chartGroup);
        const allHidden = group.series.every(item => state.hiddenSeries[group.key + item.label]);
        for (const item of group.series) {
          state.hiddenSeries[group.key + item.label] = !allHidden;
        }
        state.dirty = true;
        render();
      }
    });
  }

  /* ── 13. Проверка соединения и автосохранение ───────────────────────────*/

  async function checkConnection() {
    const target = $('#setCheckResult');
    target.textContent = 'проверка…';
    target.dataset.level = '1';
    const started = performance.now();
    try {
      const response = await fetch(state.cfg.url, { cache: 'no-store', mode: 'cors' });
      const elapsed = Math.round(performance.now() - started);
      if (response.status === 204) {
        target.dataset.level = '1';
        target.textContent = 'HTTP 204 · эмулятор запущен, данных пока нет · ' + elapsed + ' мс';
      } else if (response.ok) {
        const text = (await response.text()).trim();
        target.dataset.level = '0';
        target.textContent = 'HTTP 200 · ' + elapsed + ' мс · ' + (text.length > 40 ? text.slice(0, 40) + '…' : text);
      } else {
        target.dataset.level = '2';
        target.textContent = 'HTTP ' + response.status + ' · проверьте адрес и постамбулу';
      }
    } catch (error) {
      target.dataset.level = '2';
      target.textContent = 'Нет ответа · запустите python emulator.py';
    }
  }

  /* Журнал переживает перезагрузку страницы: без этого требование
     «сохранять лог и просматривать его позже» не выполняется.        */
  function autosave() {
    if (state.mode !== 'live' || !state.stream.frames.length) return;
    const lines = state.stream.frames.slice(-2500).map(frame => frame.raw);
    if (storage.write('log', lines)) state.savedSession = lines;
  }

  /* ── 14. Запуск ─────────────────────────────────────────────────────────*/

  function init() {
    applyTheme();
    applyInstruments();
    buildGroupTabs();
    buildAttitudeLegend();
    $('#cmCmd').innerHTML = COMMANDS.map(item =>
      '<option value="' + item.code + '">' + item.code + ' — ' + item.name + '</option>').join('');
    $('#cmCmd').dispatchEvent(new Event('change'));
    $('#tlWindow').value = String(state.cfg.windowSec);
    fillSettings();
    bindEvents();
    renderChannel();

    $('#footProto').textContent = T.PACKET_SIZE + ' полей, разделитель «;»';

    log(0, 'Пульт запущен. Источник данных: ' + state.cfg.url);
    if (state.savedSession) log(0, 'Найден прошлый сеанс: ' + state.savedSession.length + ' пакетов');

    setInterval(replayTick, 100);
    setInterval(render, 250);
    setInterval(autosave, 5000);
    pollLoop();
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();
