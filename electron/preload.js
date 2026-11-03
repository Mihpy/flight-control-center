/* =============================================================================
   preload.js — мост renderer ↔ main process через contextBridge.

   Renderer видит только объект window.electronAPI — никакого прямого
   доступа к Node.js. Все вызовы — через ipcRenderer.invoke (Promise).
   =========================================================================== */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {

  /* ── Хранилище (замена localStorage) ──────────────────────────────────── */
  store: {
    read:  (key)        => ipcRenderer.invoke('store:read',  key),
    write: (key, value) => ipcRenderer.invoke('store:write', key, value),
    drop:  (key)        => ipcRenderer.invoke('store:drop',  key),
  },

  /* ── Нативные файловые диалоги ─────────────────────────────────────────── */
  file: {
    /**
     * Сохранить файл через нативный Save Dialog.
     * @param {object} opts
     * @param {string} opts.defaultName   — имя по умолчанию
     * @param {string} opts.content       — содержимое файла (строка)
     * @param {Array}  opts.filters       — [{name, extensions}]
     * @returns {Promise<{ok:boolean, filePath?:string, error?:string}>}
     */
    save: (opts) => ipcRenderer.invoke('file:save', opts),

    /**
     * Открыть файл через нативный Open Dialog.
     * @param {object} opts
     * @param {Array}  opts.filters
     * @returns {Promise<{ok:boolean, content?:string, name?:string, error?:string}>}
     */
    open: (opts) => ipcRenderer.invoke('file:open', opts),
  },

  /* ── Системная тема ────────────────────────────────────────────────────── */
  theme: {
    get: () => ipcRenderer.invoke('theme:get'),
  },

  /* ── Меню → renderer (события из нативного меню) ─────────────────────── */
  onMenuEvent: (callback) => {
    // принимает любое событие menu:*
    const events = [
      'menu:exportCsv',
      'menu:exportReport',
      'menu:openLog',
      'menu:view',
      'menu:help',
    ];
    events.forEach(ch => {
      ipcRenderer.on(ch, (_event, ...args) => callback(ch, ...args));
    });
  },
});
