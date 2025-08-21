// main.js
const { app, BrowserWindow } = require('electron');
const path = require('path');



process.on('uncaughtException', (err) => {
  console.error("Uncaught Exception:", err);
});
process.on('unhandledRejection', (reason, p) => {
  console.error("Unhandled Rejection:", reason);
});


function startAgent() {
  const serverPath = path.join(app.getAppPath(), "server", "server.js");
  require(serverPath);
}
function createWindow () {

  const win = new BrowserWindow({
    width: 900,
    height: 680,
    webPreferences: {
      // Renderer uses fetch to localhost:3000; no Node APIs needed
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js') // keep for future
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  startAgent();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

