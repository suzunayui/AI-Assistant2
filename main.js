/* eslint-disable no-console */
"use strict";

const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");

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

async function fetchWithTimeout(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs).unref();
  try {
    return await fetch(url, { ...(init || {}), signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function extractOpenAiOutputText(json) {
  if (!json) return "";
  if (typeof json.output_text === "string") return json.output_text.trim();
  const output = Array.isArray(json.output) ? json.output : [];
  const parts = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
      if (c?.type === "output_text" && typeof c?.text === "string") parts.push(c.text);
      if (c?.type === "text" && typeof c?.text === "string") parts.push(c.text);
    }
  }
  return parts.join("\n").trim();
}

function getSettingsFilePath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function safeReadJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const json = JSON.parse(raw);
  if (!json || typeof json !== "object") return {};
  return json;
}

function safeWriteJsonFile(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
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

ipcMain.handle("media:pickSound", async () => {
  try {
    if (!mainWindow) return { ok: false, error: "window not ready" };
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: "効果音ファイルを選択",
      properties: ["openFile"],
      filters: [{ name: "Audio", extensions: ["wav", "mp3", "ogg", "m4a"] }],
    });
    if (canceled || !filePaths || filePaths.length === 0) return { ok: false, canceled: true };
    return { ok: true, path: filePaths[0] };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle("media:readFileBase64", async (_evt, filePath) => {
  try {
    const p = typeof filePath === "string" ? filePath : "";
    if (!p) return { ok: false, error: "path is required" };
    if (!fs.existsSync(p)) return { ok: false, error: "file not found" };

    const ext = path.extname(p).toLowerCase();
    const allowed = new Set([".wav", ".mp3", ".ogg", ".m4a"]);
    if (!allowed.has(ext)) return { ok: false, error: "unsupported file type" };

    const stat = fs.statSync(p);
    const maxBytes = 10 * 1024 * 1024;
    if (!stat.isFile()) return { ok: false, error: "not a file" };
    if (stat.size > maxBytes) return { ok: false, error: "file too large" };

    const buf = fs.readFileSync(p);
    const base64 = buf.toString("base64");
    const mime =
      ext === ".wav"
        ? "audio/wav"
        : ext === ".mp3"
          ? "audio/mpeg"
          : ext === ".ogg"
            ? "audio/ogg"
            : "audio/mp4";
    return { ok: true, base64, mime };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle("settings:getPath", () => ({ ok: true, path: getSettingsFilePath() }));

ipcMain.handle("settings:ensureFile", () => {
  try {
    const p = getSettingsFilePath();
    if (!fs.existsSync(p)) safeWriteJsonFile(p, { version: 1, data: {} });
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle("settings:openFolder", () => {
  try {
    const p = getSettingsFilePath();
    shell.showItemInFolder(p);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle("settings:saveDefault", async (_evt, payload) => {
  try {
    const p = getSettingsFilePath();
    const data = payload && typeof payload === "object" ? payload : {};
    safeWriteJsonFile(p, { version: 1, savedAt: new Date().toISOString(), data });
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle("settings:export", async (_evt, payload) => {
  try {
    if (!mainWindow) return { ok: false, error: "window not ready" };
    const p = getSettingsFilePath();
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: "設定をエクスポート",
      defaultPath: p,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    const data = payload && typeof payload === "object" ? payload : {};
    safeWriteJsonFile(filePath, { version: 1, exportedAt: new Date().toISOString(), data });
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle("settings:import", async () => {
  try {
    if (!mainWindow) return { ok: false, error: "window not ready" };
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: "設定をインポート",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (canceled || !filePaths || filePaths.length === 0) return { ok: false, canceled: true };
    const filePath = filePaths[0];
    const json = safeReadJsonFile(filePath);
    const data = json && typeof json.data === "object" ? json.data : {};
    return { ok: true, path: filePath, data };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle("openai:respond", async (_evt, payload) => {
  try {
    const apiKey = payload && typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
    const prompt = payload && typeof payload.prompt === "string" ? payload.prompt.trim() : "";
    const persona =
      payload && typeof payload.persona === "string" ? payload.persona.trim().slice(0, 2000) : "";
    if (!apiKey) return { ok: false, error: "OpenAI API Key is required" };
    if (!prompt) return { ok: false, error: "prompt is required" };

    const systemText =
      "あなたは配信コメントに返答するアシスタントです。日本語で、短く自然に返答してください。危険な依頼や個人情報には答えず、必要ならやんわり断ってください。" +
      (persona ? `\n\n【性格/口調】\n${persona}` : "");

    const body = {
      model: "gpt-4.1-nano",
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: systemText,
            },
          ],
        },
        { role: "user", content: [{ type: "input_text", text: prompt }] },
      ],
    };

    const resp = await fetchWithTimeout(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      20000
    );

    const raw = await resp.text().catch(() => "");
    if (!resp.ok) return { ok: false, error: `OpenAI HTTP ${resp.status} ${raw}`.trim() };

    let json;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      return { ok: false, error: `OpenAI invalid JSON: ${String(e)}` };
    }

    const text = extractOpenAiOutputText(json);
    if (!text) return { ok: false, error: "OpenAI returned empty response" };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle("chat:start", async (_evt, inputStr, options) => {
  if (!inputStr || typeof inputStr !== "string") {
    throw new Error("inputStr is required");
  }
  if (running) return { started: true };

  const userDataDbDir = path.join(app.getPath("userData"), "db");
  const workerPath = path.join(__dirname, "worker.js");
  const nodeBinOpt =
    (options && typeof options.nodeBin === "string" && options.nodeBin.trim()) || "";
  const envNodeBin = (process.env.NODE_BINARY || "").trim();
  const useExternalNode = Boolean(nodeBinOpt || envNodeBin);
  const useElectronAsNode = !useExternalNode;
  const nodeBin = useElectronAsNode ? process.execPath : nodeBinOpt || envNodeBin || "node";

  recent.length = 0;
  dbPath = null;

  worker = spawn(nodeBin, [workerPath, inputStr.trim(), "--dbDir", userDataDbDir], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: useElectronAsNode
      ? {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
        }
      : process.env,
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
