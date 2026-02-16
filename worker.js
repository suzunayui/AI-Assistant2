#!/usr/bin/env node
"use strict";

// This runs under system Node (not Electron) to avoid native-module rebuilds.
// Stdout is reserved for JSONL messages to the parent process.

const path = require("path");

// Redirect source logs to stderr so stdout stays machine-readable.
console.log = (...args) => console.error(...args);

const chatStore = require("./chatStore");
const youtubeChat = require("./youtubeChat");
const twitchChat = require("./twitchChat");

function writeMsg(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const inputStr = args.find((a) => !a.startsWith("-")) || null;

  let dbDir = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dbDir") {
      dbDir = args[i + 1] || null;
      i++;
    } else if (a.startsWith("--dbDir=")) {
      dbDir = a.slice("--dbDir=".length) || null;
    }
  }

  return { inputStr, dbDir };
}

function normalizeYoutubeTarget(token) {
  const v = String(token || "").trim();
  if (!v) return "";
  if (v.length === 11 && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
  if (v.startsWith("@")) return v;
  if (/^UC[\w-]{20,}$/.test(v)) return v;
  if (/^https?:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      const host = u.hostname.toLowerCase();
      if (host.includes("youtu.be")) {
        const id = u.pathname.split("/").filter(Boolean)[0] || "";
        if (id) return id;
      }
      if (host.includes("youtube.com")) {
        const id = u.searchParams.get("v");
        if (id) return id;
        const seg = u.pathname.split("/").filter(Boolean);
        if (seg[0] && seg[0].startsWith("@")) return seg[0];
        if (seg[0] === "channel" && seg[1]) return seg[1];
      }
    } catch (_) {}
  }
  return "";
}

function normalizeTwitchTarget(token) {
  return twitchChat.parseTwitchChannel(token);
}

function parseInputTargets(inputStr) {
  const raw = String(inputStr || "").trim();
  if (!raw) return [];

  const chunks = raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const tokens = chunks.length ? chunks : [raw];
  const out = [];

  for (const token0 of tokens) {
    const token = token0.trim();
    const lower = token.toLowerCase();
    let source = "auto";
    let body = token;

    if (lower.startsWith("yt:") || lower.startsWith("youtube:")) {
      source = "youtube";
      body = token.slice(token.indexOf(":") + 1).trim();
    } else if (lower.startsWith("tw:") || lower.startsWith("twitch:")) {
      source = "twitch";
      body = token.slice(token.indexOf(":") + 1).trim();
    }

    const yt = normalizeYoutubeTarget(body);
    const tw = normalizeTwitchTarget(body);

    if (source === "youtube") {
      if (yt) out.push({ type: "youtube", target: yt });
      continue;
    }
    if (source === "twitch") {
      if (tw) out.push({ type: "twitch", target: tw });
      continue;
    }

    if (yt) {
      out.push({ type: "youtube", target: yt });
      continue;
    }
    if (tw) {
      out.push({ type: "twitch", target: tw });
      continue;
    }
  }

  const uniq = [];
  const seen = new Set();
  for (const t of out) {
    const key = `${t.type}:${t.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(t);
  }
  return uniq;
}

async function main() {
  const { inputStr, dbDir } = parseArgs(process.argv);
  if (!inputStr) {
    writeMsg({ type: "error", message: "inputStr is required" });
    process.exit(2);
    return;
  }

  const resolvedDbDir = dbDir ? path.resolve(dbDir) : process.cwd();
  const dbPath = chatStore.initChatStore(resolvedDbDir);
  writeMsg({ type: "dbPath", dbPath });
  const targets = parseInputTargets(inputStr);
  if (!targets.length) {
    writeMsg({
      type: "error",
      message:
        "no valid targets (use YouTube videoId/@handle/channelId or tw:<channel>, and comma/newline to combine)",
    });
    process.exit(2);
    return;
  }

  const originalSave = chatStore.saveComment;
  chatStore.saveComment = (msg) => {
    originalSave(msg);
    try {
      writeMsg({ type: "comment", comment: msg });
    } catch (_) {}
  };

  let stopping = false;
  const requestStop = () => {
    if (stopping) return;
    stopping = true;
    try {
      youtubeChat.stopLiveChat();
    } catch (_) {}
    try {
      twitchChat.stopLiveChat();
    } catch (_) {}
  };

  process.stdin.setEncoding("utf8");
  let buf = "";
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    while (true) {
      const idx = buf.indexOf("\n");
      if (idx === -1) break;
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line === "stop") requestStop();
    }
  });

  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);

  try {
    const tasks = targets.map((t) => {
      if (t.type === "youtube") {
        return youtubeChat.startLiveChat(t.target);
      }
      return twitchChat.startLiveChat(t.target);
    });
    const results = await Promise.allSettled(tasks);
    for (const r of results) {
      if (r.status !== "rejected") continue;
      writeMsg({
        type: "error",
        message: r.reason && r.reason.stack ? r.reason.stack : String(r.reason),
      });
    }
  } finally {
    chatStore.closeChatStore();
    writeMsg({ type: "stopped" });
  }
}

main().catch((err) => {
  writeMsg({ type: "error", message: err && err.stack ? err.stack : String(err) });
  process.exit(1);
});
