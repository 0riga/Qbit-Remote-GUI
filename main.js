const { app, BrowserWindow, Menu, Tray, shell, dialog, ipcMain, session, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Store = require('electron-store');
const bencode = require('./bencode');

const store = new Store();

let mainWindow = null;
let tray = null;
let connectionWindow = null;
let addTorrentWindow = null;

const DEFAULT_URL = 'http://127.0.0.1:8080';

const MAX_SAVE_PATHS = 30;

function getRecentSavePaths() {
  let paths = store.get('addTorrentSavePaths', null);
  if (paths === null) {
    const legacy = store.get('addTorrentSavePath', '');
    if (legacy && typeof legacy === 'string') {
      paths = [legacy];
      store.set('addTorrentSavePaths', paths);
      store.delete('addTorrentSavePath');
    } else {
      paths = [];
    }
  }
  return Array.isArray(paths) ? paths.filter(Boolean) : [];
}

function addSavePathToRecent(p) {
  if (!p || typeof p !== 'string') return;
  const trimmed = p.trim();
  if (!trimmed) return;
  let paths = getRecentSavePaths();
  paths = paths.filter(x => x !== trimmed);
  paths.unshift(trimmed);
  store.set('addTorrentSavePaths', paths.slice(0, MAX_SAVE_PATHS));
}

function getStoredSavePath() {
  const paths = getRecentSavePaths();
  return paths[0] || '';
}

const ADD_TORRENT_BOUNDS_KEY = 'addTorrentWindowBounds';

function getAddTorrentWindowBounds() {
  const b = store.get(ADD_TORRENT_BOUNDS_KEY, null);
  if (b && typeof b.width === 'number' && typeof b.height === 'number' && b.width >= 480 && b.height >= 480) {
    return { width: b.width, height: b.height };
  }
  return null;
}

function saveAddTorrentWindowBounds() {
  if (addTorrentWindow && !addTorrentWindow.isDestroyed()) {
    const { width, height } = addTorrentWindow.getBounds();
    store.set(ADD_TORRENT_BOUNDS_KEY, { width, height });
  }
}

function parseTorrentFile(filePath) {
  const buf = fs.readFileSync(filePath);
  const decoded = bencode.decode(buf);
  const get = (obj, key) => (obj && typeof obj === 'object' && !Buffer.isBuffer(obj) ? obj[key] : undefined);
  const info = get(decoded, 'info') || decoded;
  const toStr = (v) => (Buffer.isBuffer(v) ? v.toString('utf8') : Array.isArray(v) ? v.map(toStr).join('/') : String(v));
  let files = [];
  let totalSize = 0;
  const infoFiles = get(info, 'files');
  if (infoFiles && Array.isArray(infoFiles)) {
    files = infoFiles.map((f, i) => {
      const pathParts = get(f, 'path');
      const pathStr = Array.isArray(pathParts) ? pathParts.map(toStr).join('/') : toStr(get(f, 'path') || '');
      const len = Number(get(f, 'length') || 0);
      totalSize += len;
      return { index: i, path: pathStr, length: len };
    });
  } else {
    const len = Number(get(info, 'length') || 0);
    const name = toStr(get(info, 'name') || 'file');
    totalSize = len;
    files = [{ index: 0, path: name, length: len }];
  }
  const name = toStr(get(info, 'name') || 'torrent');
  return { name, files, totalSize };
}

function getInfoHash(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf[0] !== 0x64) return null;
    function skipValue(buffer, start) {
      const c = buffer[start];
      if (c === 0x69) return buffer.indexOf(0x65, start) + 1;
      if (c >= 0x30 && c <= 0x39) {
        const colon = buffer.indexOf(0x3a, start);
        const len = parseInt(buffer.toString('ascii', start, colon), 10);
        return colon + 1 + len;
      }
      if (c === 0x6c) {
        let p = start + 1;
        while (buffer[p] !== 0x65) p = skipValue(buffer, p);
        return p + 1;
      }
      if (c === 0x64) {
        let p = start + 1;
        while (buffer[p] !== 0x65) {
          p = skipValue(buffer, p);
          p = skipValue(buffer, p);
        }
        return p + 1;
      }
      throw new Error('Invalid bencode');
    }
    let pos = 1;
    while (pos < buf.length && buf[pos] !== 0x65) {
      const keyEnd = skipValue(buf, pos);
      const colon = buf.indexOf(0x3a, pos);
      const keyLen = parseInt(buf.toString('ascii', pos, colon), 10);
      const key = buf.toString('utf8', colon + 1, colon + 1 + keyLen);
      const valStart = keyEnd;
      const valEnd = skipValue(buf, valStart);
      if (key === 'info') {
        const infoDict = buf.slice(valStart, valEnd);
        return crypto.createHash('sha1').update(infoDict).digest('hex').toLowerCase();
      }
      pos = valEnd;
    }
    return null;
  } catch {
    return null;
  }
}

async function checkTorrentExists(torrentPath) {
  const infoHash = getInfoHash(torrentPath);
  if (!infoHash) return false;
  const baseUrl = getStoredUrl();
  if (!baseUrl) return false;
  if (getUserDisconnected()) return false;
  ensureMainWindowForAddTorrent();
  const user = getStoredUsername();
  if (user && user.trim()) {
    try {
      const loggedIn = await doLogin(baseUrl, user, getStoredPassword());
      if (!loggedIn) return false;
    } catch {
      return false;
    }
  }
  const urlObj = new URL(baseUrl);
  const base = `${urlObj.origin}${urlObj.pathname.replace(/\/$/, '')}`;
  const apiUrl = `${base}/api/v2/torrents/properties?hash=${infoHash}`;

  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    try {
      const pageUrl = mainWindow.webContents.getURL();
      if (pageUrl && pageUrl.startsWith(urlObj.origin) && !pageUrl.includes('login')) {
        const ok = await mainWindow.webContents.executeJavaScript(`
          (async () => {
            try {
              const resp = await fetch(${JSON.stringify(apiUrl)}, { method: 'GET', credentials: 'include' });
              return resp.ok;
            } catch (e) { return false; }
          })()
        `);
        return Boolean(ok);
      }
    } catch {
    }
  }

  const ses = session.fromPartition('persist:qbittorrent');
  const cookies = await ses.cookies.get({ url: baseUrl });
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const http = urlObj.protocol === 'https:' ? require('https') : require('http');
  const opts = {
    method: 'GET',
    headers: { Cookie: cookieHeader, Referer: baseUrl, Origin: urlObj.origin },
  };
  return new Promise((resolve) => {
    const req = http.request(apiUrl, opts, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(8000, () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function openAddTorrentFlow(torrentPath) {
  if (!torrentPath || !fs.existsSync(torrentPath)) return;
  (async () => {
    const exists = await checkTorrentExists(torrentPath);
    if (exists) {
      dialog.showMessageBox(mainWindow || undefined, {
        type: 'error',
        title: 'Ошибка',
        message: 'Такой торрент уже есть в списке загрузок.',
      });
      return;
    }
    createAddTorrentWindow(torrentPath);
  })();
}

function getStoredUrl() {
  return store.get('webuiUrl', DEFAULT_URL);
}

function setStoredUrl(url) {
  store.set('webuiUrl', url || DEFAULT_URL);
}

function getStoredUsername() {
  return store.get('webuiUsername', '');
}

function setStoredUsername(v) {
  store.set('webuiUsername', v || '');
}

function getStoredPassword() {
  return store.get('webuiPassword', '');
}

function setStoredPassword(v) {
  store.set('webuiPassword', v || '');
}

function hasStoredConnection() {
  return store.get('webuiSavedOnce', false);
}

function setStoredConnectionSaved() {
  store.set('webuiSavedOnce', true);
}

function getUserDisconnected() {
  return store.get('userDisconnected', false);
}

function setUserDisconnected(value) {
  store.set('userDisconnected', Boolean(value));
}

function doLogin(baseUrl, username, password) {
  const urlObj = new URL(baseUrl);
  const loginUrl = `${urlObj.origin}${urlObj.pathname.replace(/\/$/, '')}/api/v2/auth/login`;
  const body = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
  const http = urlObj.protocol === 'https:' ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const opts = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body, 'utf8'),
        Referer: baseUrl,
        Origin: urlObj.origin,
      },
    };
    const req = http.request(loginUrl, opts, (res) => {
      const setCookie = res.headers['set-cookie'];
      if (res.statusCode === 200 && setCookie && setCookie.length) {
        const ses = session.fromPartition('persist:qbittorrent');
        const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
        Promise.all(cookies.map((raw) => {
          const part = raw.split(';')[0].trim();
          const eq = part.indexOf('=');
          if (eq === -1) return Promise.resolve();
          const name = part.slice(0, eq);
          const value = part.slice(eq + 1);
          return ses.cookies.set({ url: urlObj.origin, name, value });
        })).then(() => resolve(true)).catch(reject);
      } else {
        resolve(false);
      }
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Таймаут подключения')); });
    req.write(body, 'utf8');
    req.end();
  });
}

async function getCategoriesFromServer() {
  const baseUrl = getStoredUrl();
  if (!baseUrl) return { error: 'Не задан адрес qBittorrent' };
  ensureMainWindowForAddTorrent();
  const user = getStoredUsername();
  if (user && user.trim()) {
    try {
      const loggedIn = await doLogin(baseUrl, user, getStoredPassword());
      if (!loggedIn) return { error: 'Не удалось войти. Проверьте логин и пароль.' };
    } catch (e) {
      return { error: (e.message || 'Ошибка подключения') };
    }
  }
  const urlObj = new URL(baseUrl);
  const base = `${urlObj.origin}${urlObj.pathname.replace(/\/$/, '')}`;
  const apiUrl = `${base}/api/v2/torrents/categories`;
  const ses = session.fromPartition('persist:qbittorrent');
  const cookies = await ses.cookies.get({ url: urlObj.origin });
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const http = urlObj.protocol === 'https:' ? require('https') : require('http');
  return new Promise((resolve) => {
    const opts = {
      method: 'GET',
      headers: {
        Cookie: cookieHeader,
        Referer: baseUrl,
        Origin: urlObj.origin,
      },
    };
    const req = http.request(apiUrl, opts, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          if (res.statusCode === 403) return resolve({ error: 'Доступ запрещён' });
          return resolve({ error: body || `HTTP ${res.statusCode}` });
        }
        try {
          const parsed = JSON.parse(body);
          let categories = [];
          if (Array.isArray(parsed)) {
            categories = parsed.filter(s => typeof s === 'string').sort();
          } else if (typeof parsed === 'object' && parsed !== null) {
            categories = Object.keys(parsed).sort();
          }
          resolve({ categories });
        } catch {
          resolve({ error: 'Неверный ответ сервера' });
        }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ error: 'Таймаут' }); });
    req.end();
  });
}

function injectAddTorrentButtonHandler() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const script = `
    (function() {
      if (window.__addTorrentHooked) return;
      window.__addTorrentHooked = true;
      function openOurDialog() {
        window.open('qbt-add-torrent://open');
      }
      function hookElement(el) {
        if (!el || el.dataset.qbElectronHooked) return false;
        el.dataset.qbElectronHooked = '1';
        el.addEventListener('click', function(e) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          openOurDialog();
        }, true);
        return true;
      }
      function tryHook() {
        var ids = ['uploadButton', 'uploadLink', 'uploadLinkLabel'];
        ids.forEach(function(id) {
          var el = document.getElementById(id);
          if (el) hookElement(el);
        });
        document.querySelectorAll('label[for="fileselectButton"], label[for="fileselectLink"]').forEach(hookElement);
      }
      tryHook();
      var attempts = 0;
      var tid = setInterval(function() {
        tryHook();
        if (++attempts >= 50) clearInterval(tid);
      }, 200);
    })();
  `;
  mainWindow.webContents.executeJavaScript(script).catch(() => {});
}

function injectTorrentListHoverStyle() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const css = `
    .dynamicTable tbody tr:hover,
    .dynamicTable tbody tr.nonAlt:hover { background-color: rgba(33, 113, 189, 0.12) !important; }
  `;
  const script = `
    (function() {
      if (document.getElementById('qbt-hover-style')) return;
      var el = document.createElement('style');
      el.id = 'qbt-hover-style';
      el.textContent = ${JSON.stringify(css.trim())};
      document.head.appendChild(el);
    })();
  `;
  mainWindow.webContents.executeJavaScript(script).catch(() => {});
}

function createConnectionWindow() {
  if (connectionWindow) {
    connectionWindow.focus();
    return;
  }
  connectionWindow = new BrowserWindow({
    width: 480,
    height: 400,
    title: 'Подключение к qBittorrent',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    resizable: false,
    show: false,
  });
  connectionWindow.loadFile(path.join(__dirname, 'renderer', 'connection.html'));
  connectionWindow.once('ready-to-show', () => connectionWindow.show());
  connectionWindow.on('closed', () => { connectionWindow = null; });
}

function createMainWindow(url) {
  if (mainWindow) {
    mainWindow.loadURL(url);
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Qbit Remote GUI',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      partition: 'persist:qbittorrent',
    },
    show: false,
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('qbt-add-torrent://')) {
      dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [{ name: 'Торренты', extensions: ['torrent'] }],
      }).then(({ filePaths }) => {
        if (filePaths && filePaths[0]) openAddTorrentFlow(filePaths[0]);
      });
      return { action: 'deny' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const APP_TITLE = 'Qbit Remote GUI';
  const setMainTitle = (pageTitle) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const m = (pageTitle || '').match(/qBittorrent\s+(v[\d.]+)/i);
    mainWindow.setTitle(m ? `${APP_TITLE} (${m[0]})` : APP_TITLE);
  };

  mainWindow.webContents.on('page-title-updated', (e, title) => {
    e.preventDefault();
    setMainTitle(title);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    setMainTitle(mainWindow.webContents.getTitle());
    setTimeout(() => {
      injectAddTorrentButtonHandler();
      injectTorrentListHoverStyle();
    }, 300);
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3 || errorCode === -2) {
      createConnectionWindow();
      dialog.showMessageBox(connectionWindow || mainWindow, {
        type: 'error',
        title: 'Ошибка подключения',
        message: 'Не удалось подключиться к серверу.',
        detail: `Проверьте адрес сервера и что qBittorrent запущен (Web UI включён).\n\n${errorDescription}`,
      });
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.loadURL(url);
  mainWindow.show();
}

function openWebUI(url, username, password) {
  const u = (url || getStoredUrl()).trim();
  if (!u) return;
  setStoredUrl(u);
  setStoredUsername(username != null ? username : '');
  setStoredPassword(password != null ? password : '');
  setStoredConnectionSaved();
  (async () => {
    const user = String(username != null ? username : '').trim();
    if (user) {
      try {
        const ok = await doLogin(u, user, String(password || ''));
        if (!ok) {
          createConnectionWindow();
          dialog.showMessageBox(connectionWindow || undefined, {
            type: 'warning',
            title: 'Ошибка входа',
            message: 'Неверный логин или пароль.',
            detail: 'Проверьте данные и попробуйте снова.',
          });
          return;
        }
      } catch (e) {
        createConnectionWindow();
        dialog.showMessageBox(connectionWindow || undefined, {
          type: 'error',
          title: 'Ошибка подключения',
          message: 'Сервер не отвечает или недоступен.',
          detail: e.message || 'Проверьте адрес и что qBittorrent запущен.',
        });
        return;
      }
    }
    createMainWindow(u);
    setUserDisconnected(false);
    if (connectionWindow) connectionWindow.close();
  })();
}

function disconnectFromServer() {
  setUserDisconnected(true);
  (async () => {
    const ses = session.fromPartition('persist:qbittorrent');
    await ses.clearStorageData({ storages: ['cookies'] });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
      mainWindow = null;
    }
    createConnectionWindow();
  })();
}

function ensureMainWindowForAddTorrent() {
  const url = getStoredUrl();
  if (!url || url === DEFAULT_URL) return false;
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow(url);
  return true;
}

function createAddTorrentWindow(torrentPath) {
  if (!torrentPath || !fs.existsSync(torrentPath)) return;
  const normalized = path.normalize(torrentPath);
  if (addTorrentWindow) {
    addTorrentWindow.close();
    addTorrentWindow = null;
  }
  const savedBounds = getAddTorrentWindowBounds();
  addTorrentWindow = new BrowserWindow({
    width: savedBounds ? savedBounds.width : 560,
    height: savedBounds ? savedBounds.height : 520,
    minWidth: 480,
    minHeight: 480,
    title: 'Добавление нового торрента',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'addtorrent-preload.js'),
    },
    show: false,
  });
  const fileUrl = path.join(__dirname, 'renderer', 'addtorrent.html').replace(/\\/g, '/');
  const darkMode = nativeTheme.shouldUseDarkColors;
  addTorrentWindow.setMenu(null);
  addTorrentWindow.loadURL(`file:///${fileUrl}?path=${encodeURIComponent(normalized)}&theme=${darkMode ? 'dark' : 'light'}`);
  addTorrentWindow.once('ready-to-show', () => addTorrentWindow.show());
  addTorrentWindow.on('resize', saveAddTorrentWindowBounds);
  addTorrentWindow.on('close', saveAddTorrentWindowBounds);
  addTorrentWindow.on('closed', () => { addTorrentWindow = null; });
}

function buildMenu() {
  const template = [
    {
      label: 'Файл',
      submenu: [
        {
          label: 'Добавить торрент...',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            dialog.showOpenDialog(mainWindow || undefined, {
              properties: ['openFile'],
              filters: [{ name: 'Торренты', extensions: ['torrent'] }],
            }).then(({ filePaths }) => {
              if (filePaths && filePaths[0]) openAddTorrentFlow(filePaths[0]);
            });
          },
        },
        {
          label: 'Подключение...',
          accelerator: 'CmdOrCtrl+Shift+C',
          click: () => createConnectionWindow(),
        },
        {
          label: 'Отключиться от сервера',
          click: () => disconnectFromServer(),
        },
        { type: 'separator' },
        { label: 'Выход', role: 'quit' },
      ],
    },
    {
      label: 'Вид',
      submenu: [
        { label: 'Обновить', role: 'reload', accelerator: 'F5' },
        { label: 'Полный экран', role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Окно',
      submenu: [
        { label: 'Свернуть', role: 'minimize' },
        { label: 'Закрыть', role: 'close' },
      ],
    },
    {
      label: 'Справка',
      submenu: [
        {
          label: 'О Qbit Remote GUI',
          click: () => shell.openExternal('https://github.com/qbittorrent/qBittorrent'),
        },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

function createTray() {
  const iconPath = path.join(__dirname, 'build', 'tray.png');
  const fs = require('fs');
  try {
    if (!fs.existsSync(iconPath)) return;
    tray = new Tray(iconPath);
  } catch {
    tray = null;
    return;
  }
  tray.setToolTip('Qbit Remote GUI');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Открыть', click: () => mainWindow && mainWindow.show() },
      { label: 'Подключение...', click: () => createConnectionWindow() },
      { label: 'Отключиться от сервера', click: () => disconnectFromServer() },
      { type: 'separator' },
      { label: 'Выход', role: 'quit' },
    ])
  );
  tray.on('double-click', () => mainWindow && mainWindow.show());
}

function getTorrentPathFromArgv(argv) {
  if (!argv || !Array.isArray(argv)) return null;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a === 'string' && a.toLowerCase().endsWith('.torrent') && fs.existsSync(a)) return a;
  }
  return null;
}

function getTorrentPathFromCommandLine(commandLine) {
  if (typeof commandLine !== 'string') return null;
  const match = commandLine.match(/"([^"]+\.torrent)"/i) || commandLine.match(/([a-zA-Z]:[^"\s]+\.torrent)/i);
  if (match && match[1] && fs.existsSync(match[1])) return match[1];
  const parts = commandLine.split(/\s+/);
  for (const p of parts) {
    const trimmed = p.replace(/^"+|"+$/g, '');
    if (trimmed.toLowerCase().endsWith('.torrent') && fs.existsSync(trimmed)) return trimmed;
  }
  return null;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(buildMenu());
  createTray();

  const torrentPath = getTorrentPathFromArgv(process.argv);
  const url = getStoredUrl();
  const hasStored = hasStoredConnection() && url && url.trim().length > 0;
  const userDisconnected = getUserDisconnected();

  if (hasStored && !userDisconnected) {
    (async () => {
      const user = getStoredUsername();
      if (user && user.trim()) {
        try {
          const ok = await doLogin(url, user, getStoredPassword());
          if (!ok) {
            createConnectionWindow();
            return;
          }
        } catch (_) {
          createConnectionWindow();
          return;
        }
      }
      createMainWindow(url);
    })();
  } else {
    createConnectionWindow();
  }
  if (torrentPath) {
    setTimeout(() => openAddTorrentFlow(torrentPath), 500);
  }
});

app.on('window-all-closed', () => {
  if (tray) tray.destroy();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
  else createConnectionWindow();
});

app.on('second-instance', (event, argv) => {
  const torrentPath = getTorrentPathFromArgv(argv);
  if (torrentPath) {
    ensureMainWindowForAddTorrent();
    openAddTorrentFlow(torrentPath);
  }
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else if (!torrentPath) {
    createConnectionWindow();
  }
});

if (process.platform === 'win32') {
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) app.quit();
}

// IPC for connection window
ipcMain.on('connection-open', (event, url, username, password) => openWebUI(url, username, password));
ipcMain.on('connection-get-url', (event) => {
  event.returnValue = getStoredUrl();
});
ipcMain.on('connection-get-credentials', (event) => {
  event.returnValue = { username: getStoredUsername(), password: getStoredPassword() };
});

// IPC for add-torrent window
ipcMain.handle('addtorrent-get-info', async (event, filePath) => {
  try {
    return parseTorrentFile(filePath);
  } catch (e) {
    return { error: e.message };
  }
});
ipcMain.handle('addtorrent-open-folder', async (event, currentPath) => {
  const { filePaths } = await dialog.showOpenDialog(addTorrentWindow || undefined, {
    properties: ['openDirectory'],
    defaultPath: currentPath || getStoredSavePath(),
  });
  return filePaths && filePaths[0] ? filePaths[0] : null;
});
ipcMain.handle('addtorrent-get-savepath', () => ({
  default: getStoredSavePath(),
  recent: getRecentSavePaths(),
}));
ipcMain.handle('addtorrent-get-url', () => getStoredUrl());
ipcMain.handle('addtorrent-get-categories', () => getCategoriesFromServer());

async function addTorrentViaWebUI(apiUrl, torrentBuffer, filename, savepath, rename, startPaused, peerLimit, filePriorities, category) {
  const base64 = torrentBuffer.toString('base64');
  const script = `
    (async () => {
      const binStr = atob(${JSON.stringify(base64)});
      const bytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'application/x-bittorrent' });
      const formData = new FormData();
      formData.append('torrents', blob, ${JSON.stringify(filename)});
      if (${JSON.stringify(savepath || '')}) formData.append('savepath', ${JSON.stringify(savepath)});
      if (${JSON.stringify(rename || '')}) formData.append('rename', ${JSON.stringify(rename)});
      formData.append('paused', ${JSON.stringify(startPaused ? 'true' : 'false')});
      formData.append('root_folder', 'false');
      if (${JSON.stringify(category || '')}) formData.append('category', ${JSON.stringify(category)});
      if (${peerLimit != null && peerLimit > 0 ? 'true' : 'false'}) {
        formData.append('connection', 'manual');
        formData.append('max-connections', ${JSON.stringify(String(peerLimit || 0))});
      }
      const fpStr = ${JSON.stringify(filePriorities && filePriorities.length ? filePriorities.join('|') : '')};
      if (fpStr) formData.append('filePriorities', fpStr);
      const resp = await fetch(${JSON.stringify(apiUrl)}, { method: 'POST', body: formData, credentials: 'include' });
      const text = await resp.text();
      return { status: resp.status, body: text };
    })()
  `;
  return mainWindow.webContents.executeJavaScript(script);
}

ipcMain.handle('addtorrent-add', async (event, options) => {
  const { torrentPath, savepath, rename, startPaused, peerLimit, filePriorities, category } = options;
  if (!torrentPath || !fs.existsSync(torrentPath)) return { ok: false, error: 'Файл не найден' };
  const baseUrl = getStoredUrl();
  if (!baseUrl) return { ok: false, error: 'Не задан адрес qBittorrent' };
  if (getUserDisconnected()) return { ok: false, error: 'Сначала подключитесь к qBittorrent (Файл → Подключение...)' };
  ensureMainWindowForAddTorrent();
  const user = getStoredUsername();
  if (user && user.trim()) {
    try {
      const loggedIn = await doLogin(baseUrl, user, getStoredPassword());
      if (!loggedIn) return { ok: false, error: 'Не удалось войти. Проверьте логин и пароль в Файл → Подключение...' };
    } catch (e) {
      return { ok: false, error: 'Не удалось подключиться к qBittorrent: ' + (e.message || 'проверьте, что программа запущена') };
    }
  }
  const urlObj = new URL(baseUrl);
  const base = `${urlObj.origin}${urlObj.pathname.replace(/\/$/, '')}`;
  const apiUrl = `${base}/api/v2/torrents/add`;
  const torrentBuffer = fs.readFileSync(torrentPath);
  const filename = path.basename(torrentPath);

  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    try {
      const url = mainWindow.webContents.getURL();
      if (url && url.startsWith(urlObj.origin) && !url.includes('login')) {
        const result = await addTorrentViaWebUI(apiUrl, torrentBuffer, filename, savepath, rename, startPaused, peerLimit, filePriorities, category);
        if (result.status === 200 && (result.body === 'Ok.' || (result.body && result.body.trim() === 'Ok.'))) {
          if (savepath && savepath.trim()) addSavePathToRecent(savepath.trim());
          return { ok: true };
        }
        let errMsg = result.body || `HTTP ${result.status}`;
        if (result.status === 403) errMsg = 'Доступ запрещён. Проверьте логин и пароль в Файл → Подключение...';
        else if (result.status === 415) errMsg = 'Неверный формат торрент-файла';
        else if (result.body && result.body.trim() === 'Fails.') errMsg = 'Сервер отклонил торрент.';
        return { ok: false, error: errMsg };
      }
    } catch (e) {
    }
  }

  const ses = session.fromPartition('persist:qbittorrent');
  const cookies = await ses.cookies.get({ url: baseUrl });
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const FormData = require('form-data');
  const form = new FormData();
  form.append('torrents', torrentBuffer, { filename, contentType: 'application/x-bittorrent' });
  if (savepath) form.append('savepath', savepath);
  if (rename) form.append('rename', rename);
  if (category && category.trim()) form.append('category', category.trim());
  form.append('paused', startPaused ? 'true' : 'false');
  form.append('root_folder', 'false');
  if (peerLimit != null && peerLimit > 0) {
    form.append('connection', 'manual');
    form.append('max-connections', String(peerLimit));
  }
  if (filePriorities && filePriorities.length) form.append('filePriorities', filePriorities.join('|'));
  const refererUrl = `${base}/upload.html`;
  const opts = {
    method: 'POST',
    headers: {
      ...form.getHeaders(),
      Cookie: cookieHeader,
      Referer: refererUrl,
      Origin: urlObj.origin,
    },
  };
  const http = urlObj.protocol === 'https:' ? require('https') : require('http');
  return new Promise((resolve) => {
    const req = http.request(apiUrl, opts, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200 && (body === 'Ok.' || body.trim() === 'Ok.')) {
          if (savepath && savepath.trim()) addSavePathToRecent(savepath.trim());
          resolve({ ok: true });
        } else {
          let errMsg = body || res.statusMessage;
          if (res.statusCode === 403) errMsg = 'Доступ запрещён. Проверьте логин и пароль в Файл → Подключение...';
          else if (res.statusCode === 415) errMsg = 'Неверный формат торрент-файла';
          else if (body && body.trim() === 'Fails.') errMsg = 'Сервер отклонил торрент. Попробуйте переподключиться (Файл → Подключение...) и добавить снова.';
          resolve({ ok: false, error: errMsg });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(60000, () => {
      req.destroy();
      resolve({ ok: false, error: 'Таймаут загрузки торрента (60 сек)' });
    });
    form.pipe(req);
  });
});
