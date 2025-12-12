#!/usr/bin/env node
"use strict";

const path = require("path");
const chatStore = require("./chatStore");
const youtubeChat = require("./youtubeChat");

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node ingest.js <videoId|@handle|channelId> [--dbDir <dir>]",
      "",
      "Examples:",
      "  node ingest.js dQw4w9WgXcQ --dbDir .",
      "  node ingest.js @somehandle --dbDir ./data",
      "  node ingest.js UCxxxxxxxxxxxxxxxxxxxxxx --dbDir ./data",
    ].join("\n")
  );
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
    printUsage();
    process.exitCode = 2;
    return;
  }

  const resolvedDbDir = dbDir ? path.resolve(dbDir) : process.cwd();
  const dbPath = chatStore.initChatStore(resolvedDbDir);
  console.log("🗄️ DB:", dbPath);

  let forced = false;
  const forceExitTimerMs = 10_000;

  const requestStop = (signalName) => {
    if (forced) return;
    console.log(`\n⏹ ${signalName}: 停止します（最大${forceExitTimerMs / 1000}s待機）`);
    youtubeChat.stopLiveChat();
    setTimeout(() => {
      forced = true;
      console.log("⚠ 強制終了します");
      process.exit(130);
    }, forceExitTimerMs).unref();
  };

  process.on("SIGINT", () => requestStop("SIGINT"));
  process.on("SIGTERM", () => requestStop("SIGTERM"));

  try {
    await youtubeChat.startLiveChat(inputStr);
  } finally {
    chatStore.closeChatStore();
  }
}

main().catch((err) => {
  console.error("Fatal:", err && err.stack ? err.stack : err);
  process.exit(1);
});

