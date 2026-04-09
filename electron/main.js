const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path  = require('path');
const fs    = require('fs');
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

// Note: --no-sandbox is handled at launch level via:
// 1. electron-builder execArgs in package.json (baked into .desktop file)
// 2. bess-optimizer wrapper script (installed to /usr/bin)
// Do NOT use app.commandLine.appendSwitch here — sandbox init runs before JS.

function createWindow() {
  const win = new BrowserWindow({
    width:  1400,
    height: 900,
    minWidth:  900,
    minHeight: 600,
    title: 'BESS Optimizer — Battery Energy Storage System',
    icon: path.join(__dirname, '..', 'resources', 'icon.png'),
    webPreferences: {
      preload:         path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
    backgroundColor: '#080c10',
    show: false,
  });

  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  win.once('ready-to-show', () => win.show());
}

// ── IPC: Save CSV ────────────────────────────────────────────────────────────
ipcMain.handle('save-csv', async (event, { content, defaultName }) => {
  const { filePath, canceled } = await dialog.showSaveDialog({
    title:       'Save Energy Data',
    defaultPath: defaultName || 'BESS_Energy_Data.csv',
    filters:     [{ name: 'CSV Files', extensions: ['csv'] }],
  });
  if (canceled || !filePath) return { ok: false, reason: 'canceled' };
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    return { ok: true, filePath };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
});

// ── IPC: Save HTML Report ────────────────────────────────────────────────────
ipcMain.handle('save-report', async (event, { content, defaultName }) => {
  const { filePath, canceled } = await dialog.showSaveDialog({
    title:       'Save Report',
    defaultPath: defaultName || 'BESS_Report.html',
    filters:     [
      { name: 'HTML Files', extensions: ['html'] },
      { name: 'All Files',  extensions: ['*'] },
    ],
  });
  if (canceled || !filePath) return { ok: false, reason: 'canceled' };
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    // Open in default browser after saving
    const { shell } = require('electron');
    shell.openPath(filePath);
    return { ok: true, filePath };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
