"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("chatApi", {
  getDbPath: () => ipcRenderer.invoke("chat:getDbPath"),
  start: (inputStr, options) => ipcRenderer.invoke("chat:start", inputStr, options),
  stop: () => ipcRenderer.invoke("chat:stop"),
  isRunning: () => ipcRenderer.invoke("chat:isRunning"),
  getRecent: (limit) => ipcRenderer.invoke("chat:getRecent", limit),
  getVoicevoxSpeakers: () => ipcRenderer.invoke("voicevox:getSpeakers"),
  openaiRespond: (apiKey, prompt, persona) =>
    ipcRenderer.invoke("openai:respond", { apiKey, prompt, persona }),
  settingsEnsureFile: () => ipcRenderer.invoke("settings:ensureFile"),
  settingsGetPath: () => ipcRenderer.invoke("settings:getPath"),
  settingsOpenFolder: () => ipcRenderer.invoke("settings:openFolder"),
  settingsSaveDefault: (data) => ipcRenderer.invoke("settings:saveDefault", data),
  settingsExport: (data) => ipcRenderer.invoke("settings:export", data),
  settingsImport: () => ipcRenderer.invoke("settings:import"),
  onDbPath: (cb) => {
    const handler = (_evt, payload) => cb(payload);
    ipcRenderer.on("chat:dbPath", handler);
    return () => ipcRenderer.removeListener("chat:dbPath", handler);
  },
  onComment: (cb) => {
    const handler = (_evt, comment) => cb(comment);
    ipcRenderer.on("chat:comment", handler);
    return () => ipcRenderer.removeListener("chat:comment", handler);
  },
  onRunning: (cb) => {
    const handler = (_evt, payload) => cb(payload);
    ipcRenderer.on("chat:running", handler);
    return () => ipcRenderer.removeListener("chat:running", handler);
  },
  onError: (cb) => {
    const handler = (_evt, payload) => cb(payload);
    ipcRenderer.on("chat:error", handler);
    return () => ipcRenderer.removeListener("chat:error", handler);
  },
  onStopped: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("chat:stopped", handler);
    return () => ipcRenderer.removeListener("chat:stopped", handler);
  },
});
