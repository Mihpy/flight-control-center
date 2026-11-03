/* =============================================================================
   main.js — Electron main process
   Запускает окно приложения, настраивает меню, обрабатывает IPC-вызовы
   от renderer: сохранение файлов (dialog), нативное хранилище настроек.
   =========================================================================== */
'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeTheme } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

/* ── Хранилище настроек в JSON-файле (замена localStorage) ──────────────── */
const DATA_DIR  = path.join(app.getPath('userData'), 'introsat');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function storeRead() {
  try {
    ensureDataDir();
    if (!fs.existsSync(STORE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch { return {}; }
}

function storeWrite(data) {
  try {
    ensureDataDir();
    fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

/* ── IPC: хранилище ─────────────────────────────────────────────────────── */
ipcMain.handle('store:read', (_event, key) => {
  const all = storeRead();
  return key ? (all[key] !== undefined ? all[key] : null) : all;
});

ipcMain.handle('store:write', (_event, key, value) => {
  const all = storeRead();
  all[key] = value;
  return storeWrite(all);
});

ipcMain.handle('store:drop', (_event, key) => {
  const all = storeRead();
  delete all[key];
  storeWrite(all);
});

/* ── IPC: сохранение файлов через нативный диалог ───────────────────────── */
ipcMain.handle('file:save', async (_event, { defaultName, content, filters }) => {
  const { filePath, canceled } = await dialog.showSaveDialog({
    defaultPath: path.join(os.homedir(), 'Downloads', defaultName),
    filters: filters || [{ name: 'All Files', extensions: ['*'] }],
  });
  if (canceled || !filePath) return { ok: false };
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    return { ok: true, filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/* ── IPC: открытие файла через нативный диалог ──────────────────────────── */
ipcMain.handle('file:open', async (_event, { filters }) => {
  const { filePaths, canceled } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: filters || [{ name: 'All Files', extensions: ['*'] }],
  });
  if (canceled || !filePaths.length) return { ok: false };
  try {
    const content = fs.readFileSync(filePaths[0], 'utf8');
    return { ok: true, content, name: path.basename(filePaths[0]) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/* ── IPC: системная тема ────────────────────────────────────────────────── */
ipcMain.handle('theme:get', () => nativeTheme.shouldUseDarkColors ? 'dark' : 'light');

/* ── Главное окно ───────────────────────────────────────────────────────── */
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 520,
    minHeight: 600,
    title: 'ИнтроСат · Пульт оператора ЦУП',
    backgroundColor: '#15191d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      /* fetch() к эмулятору (127.0.0.1:8765) работает без CORS в Electron,
         но явно разрешим запросы к localhost */
      webSecurity: false,
    },
  });

  mainWindow.loadFile('index.html');

  /* В dev-режиме открываем DevTools (запуск через: npm start -- --devtools) */
  if (process.argv.includes('--devtools')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

/* ── Меню ───────────────────────────────────────────────────────────────── */
function buildMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    /* macOS application menu */
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: 'О программе' },
        { type: 'separator' },
        { role: 'services', label: 'Сервисы' },
        { type: 'separator' },
        { role: 'hide', label: 'Скрыть' },
        { role: 'hideOthers', label: 'Скрыть остальные' },
        { role: 'unhide', label: 'Показать все' },
        { type: 'separator' },
        { role: 'quit', label: 'Выйти' },
      ],
    }] : []),

    {
      label: 'Файл',
      submenu: [
        {
          label: 'Сохранить лог CSV…',
          accelerator: 'CmdOrCtrl+S',
          click() {
            mainWindow && mainWindow.webContents.send('menu:exportCsv');
          },
        },
        {
          label: 'Сохранить отчёт TXT…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click() {
            mainWindow && mainWindow.webContents.send('menu:exportReport');
          },
        },
        {
          label: 'Открыть лог из файла…',
          accelerator: 'CmdOrCtrl+O',
          click() {
            mainWindow && mainWindow.webContents.send('menu:openLog');
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close', label: 'Закрыть окно' } : { role: 'quit', label: 'Выйти' },
      ],
    },

    {
      label: 'Вид',
      submenu: [
        {
          label: 'Обзор',
          accelerator: '1',
          click() { mainWindow && mainWindow.webContents.send('menu:view', 'overview'); },
        },
        {
          label: 'Телеметрия',
          accelerator: '2',
          click() { mainWindow && mainWindow.webContents.send('menu:view', 'telemetry'); },
        },
        {
          label: 'Анализ',
          accelerator: '3',
          click() { mainWindow && mainWindow.webContents.send('menu:view', 'analysis'); },
        },
        {
          label: 'Ориентация',
          accelerator: '4',
          click() { mainWindow && mainWindow.webContents.send('menu:view', 'attitude'); },
        },
        {
          label: 'Команды',
          accelerator: '5',
          click() { mainWindow && mainWindow.webContents.send('menu:view', 'commands'); },
        },
        {
          label: 'Журнал',
          accelerator: '6',
          click() { mainWindow && mainWindow.webContents.send('menu:view', 'journal'); },
        },
        {
          label: 'Настройки',
          accelerator: '7',
          click() { mainWindow && mainWindow.webContents.send('menu:view', 'settings'); },
        },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Полный экран' },
        { role: 'resetZoom', label: 'Масштаб 100%' },
        { role: 'zoomIn', label: 'Увеличить' },
        { role: 'zoomOut', label: 'Уменьшить' },
        { type: 'separator' },
        { role: 'reload', label: 'Перезагрузить' },
        { role: 'forceReload', label: 'Принудительная перезагрузка' },
        {
          label: 'Инструменты разработчика',
          accelerator: isMac ? 'Cmd+Alt+I' : 'Ctrl+Shift+I',
          click() { mainWindow && mainWindow.webContents.toggleDevTools(); },
        },
      ],
    },

    {
      label: 'Справка',
      submenu: [
        {
          label: 'Справка пульта (F1)',
          accelerator: 'F1',
          click() { mainWindow && mainWindow.webContents.send('menu:help'); },
        },
        { type: 'separator' },
        {
          label: 'Эмулятор на GitHub',
          click() { shell.openExternal('https://github.com/mcc-hack/data-emulator'); },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ── Жизненный цикл ─────────────────────────────────────────────────────── */
app.whenReady().then(() => {
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
