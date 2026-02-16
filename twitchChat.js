"use strict";

const tls = require("tls");
const chatStore = require("./chatStore");

let stopFlag = false;
let running = false;
let activeSocket = null;

function pushComment(msg) {
  chatStore.saveComment(msg);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDateTime(dt) {
  const pad = (n) => String(n).padStart(2, "0");
  const y = dt.getFullYear();
  const m = pad(dt.getMonth() + 1);
  const d = pad(dt.getDate());
  const h = pad(dt.getHours());
  const mi = pad(dt.getMinutes());
  const s = pad(dt.getSeconds());
  return `${y}-${m}-${d} ${h}:${mi}:${s}`;
}

function unescapeTagValue(v) {
  return String(v || "")
    .replace(/\\s/g, " ")
    .replace(/\\:/g, ";")
    .replace(/\\\\/g, "\\")
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n");
}

function parseIrcTags(tagRaw) {
  const out = Object.create(null);
  if (!tagRaw) return out;
  for (const item of String(tagRaw).split(";")) {
    const eq = item.indexOf("=");
    if (eq === -1) {
      out[item] = "";
      continue;
    }
    const k = item.slice(0, eq);
    const v = item.slice(eq + 1);
    out[k] = unescapeTagValue(v);
  }
  return out;
}

function parseTwitchChannel(inputStr) {
  let v = String(inputStr || "").trim();
  if (!v) return "";
  v = v.replace(/^(?:tw|twitch)\s*:/i, "").trim();
  if (!v) return "";

  if (/^https?:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      const host = u.hostname.toLowerCase();
      if (host === "twitch.tv" || host.endsWith(".twitch.tv") || host === "www.twitch.tv") {
        const seg = u.pathname.split("/").filter(Boolean);
        if (seg.length) v = seg[0];
      }
    } catch (_) {}
  }

  if (v.startsWith("@")) v = v.slice(1);
  v = v.trim().toLowerCase();
  if (!/^[a-z0-9_]{3,25}$/.test(v)) return "";
  return v;
}

function parsePrivmsgLine(line) {
  const m = String(line || "").match(/^(?:@([^ ]+) )?:([^ ]+) PRIVMSG #([^ ]+) :([\s\S]*)$/);
  if (!m) return null;

  const tags = parseIrcTags(m[1] || "");
  const prefix = m[2] || "";
  const channel = String(m[3] || "").toLowerCase();
  const text = String(m[4] || "");
  if (!text) return null;

  const nick = prefix.split("!", 1)[0] || "";
  const author = String(tags["display-name"] || nick || "unknown");
  const ts = Number.parseInt(String(tags["tmi-sent-ts"] || ""), 10);
  const timestampMs = Number.isFinite(ts) && ts > 0 ? ts : Date.now();
  const msgId = String(tags.id || `${channel}_${timestampMs}_${author}_${text}`);

  return {
    id: `tw:${msgId}`,
    video_id: `twitch:${channel}`,
    timestamp_ms: timestampMs,
    timestamp: formatDateTime(new Date(timestampMs)),
    author,
    text,
    kind: "text",
    amount: null,
    amount_text: "",
    icon: null,
    parts: [{ type: "text", text }],
    source: "twitch",
  };
}

function connectAndReadLoop(channel) {
  return new Promise((resolve) => {
    const nick = `justinfan${Math.floor(Math.random() * 90000 + 10000)}`;
    const socket = tls.connect(6697, "irc.chat.twitch.tv", { servername: "irc.chat.twitch.tv" });
    activeSocket = socket;
    socket.setEncoding("utf8");

    let buf = "";
    socket.on("secureConnect", () => {
      socket.write("PASS SCHMOOPIIE\r\n");
      socket.write(`NICK ${nick}\r\n`);
      socket.write("CAP REQ :twitch.tv/tags twitch.tv/commands\r\n");
      socket.write(`JOIN #${channel}\r\n`);
    });

    socket.on("data", (chunk) => {
      buf += chunk;
      while (true) {
        const idx = buf.indexOf("\r\n");
        if (idx < 0) break;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!line) continue;

        if (line.startsWith("PING ")) {
          socket.write(`PONG ${line.slice(5)}\r\n`);
          continue;
        }

        const msg = parsePrivmsgLine(line);
        if (msg) pushComment(msg);
      }
    });

    const done = () => {
      if (activeSocket === socket) activeSocket = null;
      resolve();
    };

    socket.on("error", () => done());
    socket.on("close", () => done());
    socket.on("end", () => done());
  });
}

async function startLiveChat(inputStr) {
  if (running) return;

  const channel = parseTwitchChannel(inputStr);
  if (!channel) throw new Error("invalid twitch channel");

  running = true;
  stopFlag = false;

  try {
    while (!stopFlag) {
      await connectAndReadLoop(channel);
      if (!stopFlag) await sleep(1500);
    }
  } finally {
    running = false;
    activeSocket = null;
  }
}

function stopLiveChat() {
  stopFlag = true;
  if (!activeSocket) return;
  try {
    activeSocket.destroy();
  } catch (_) {}
}

module.exports = {
  startLiveChat,
  stopLiveChat,
  parseTwitchChannel,
};

