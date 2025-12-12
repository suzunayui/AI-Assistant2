/* eslint-disable no-console */
"use strict";

const path = require("path");
const { spawn } = require("child_process");
const { app, BrowserWindow, ipcMain } = require("electron");

let mainWindow = null;
let worker = null;
let running = false;
let shuttingDown = false;
let dbPath = null;
const recent = [];
const RECENT_MAX = 500;

app.setName("AIアシスタント");

async function fetchJsonWithTimeout(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs).unref();
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status} ${text}`.trim());
    }
    return await resp.json();
  } finally {
    clearTimeout(t);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 760,
    title: "AIアシスタント",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function pushRecent(comment) {
  recent.push(comment);
  if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
}

function killWorker() {
  if (!worker) return;
  try {
    worker.stdin.write("stop\n");
  } catch (_) {}
  // If it doesn't exit, terminate it.
  setTimeout(() => {
    if (!worker) return;
    try {
      worker.kill("SIGTERM");
    } catch (_) {}
  }, 5000).unref();
}

function safeShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  killWorker();
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", async () => {
  safeShutdown();
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  safeShutdown();
});

ipcMain.handle("chat:getDbPath", () => dbPath);

ipcMain.handle("voicevox:getSpeakers", async () => {
  try {
    const speakers = await fetchJsonWithTimeout(
      "http://127.0.0.1:50021/speakers",
      1500
    );
    return { ok: true, speakers };
  } catch (e) {
    return {
      ok: false,
      error: e && e.message ? e.message : String(e),
    };
  }
});

ipcMain.handle("chat:start", async (_evt, inputStr, options) => {
  if (!inputStr || typeof inputStr !== "string") {
    throw new Error("inputStr is required");
  }
  if (running) return { started: true };

  const userDataDbDir = path.join(app.getPath("userData"), "db");
  const workerPath = path.join(__dirname, "worker.js");
  const nodeBin =
    (options && typeof options.nodeBin === "string" && options.nodeBin.trim()) ||
    process.env.NODE_BINARY ||
    "node";

  recent.length = 0;
  dbPath = null;

  worker = spawn(nodeBin, [workerPath, inputStr.trim(), "--dbDir", userDataDbDir], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  running = true;
  if (mainWindow) mainWindow.webContents.send("chat:running", { running: true });

  let stdoutBuf = "";
  worker.stdout.setEncoding("utf8");
  worker.stdout.on("data", (chunk) => {
    stdoutBuf += chunk;
    while (true) {
      const idx = stdoutBuf.indexOf("\n");
      if (idx === -1) break;
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === "dbPath") {
          dbPath = msg.dbPath || null;
          if (mainWindow) mainWindow.webContents.send("chat:dbPath", { dbPath });
        } else if (msg.type === "comment" && msg.comment) {
          pushRecent(msg.comment);
          if (mainWindow) mainWindow.webContents.send("chat:comment", msg.comment);
        } else if (msg.type === "error") {
          if (mainWindow) mainWindow.webContents.send("chat:error", { message: msg.message || "error" });
        } else if (msg.type === "stopped") {
          // handled in exit too
        }
      } catch (e) {
        console.error("worker stdout parse error:", e);
      }
    }
  });

  worker.stderr.setEncoding("utf8");
  worker.stderr.on("data", (chunk) => {
    console.error("[worker]", chunk.trimEnd());
  });

  worker.on("exit", (code, signal) => {
    console.log("worker exit:", { code, signal });
    worker = null;
    running = false;
    if (mainWindow) {
      mainWindow.webContents.send("chat:running", { running: false });
      mainWindow.webContents.send("chat:stopped");
    }
  });

  return { started: true };
});

ipcMain.handle("chat:stop", async () => {
  killWorker();
  return { stopped: true };
});

ipcMain.handle("chat:isRunning", async () => ({ running }));

ipcMain.handle("chat:getRecent", async (_evt, limit) => {
  const n = Number.isFinite(limit) ? limit : 100;
  const lim = Math.max(1, Math.min(n, RECENT_MAX));
  return recent.slice(-lim);
});
