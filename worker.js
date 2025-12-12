#!/usr/bin/env node
"use strict";

// This runs under system Node (not Electron) to avoid native-module rebuilds.
// Stdout is reserved for JSONL messages to the parent process.

const path = require("path");

// Redirect youtubeChat's logs to stderr so stdout stays machine-readable.
console.log = (...args) => console.error(...args);

const chatStore = require("./chatStore");
const youtubeChat = require("./youtubeChat");

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
    await youtubeChat.startLiveChat(inputStr.trim());
  } finally {
    chatStore.closeChatStore();
    writeMsg({ type: "stopped" });
  }
}

main().catch((err) => {
  writeMsg({ type: "error", message: err && err.stack ? err.stack : String(err) });
  process.exit(1);
});

