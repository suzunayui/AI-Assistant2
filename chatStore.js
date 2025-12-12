// chatStore.js
// Simple SQLite helper for storing live chat messages (better-sqlite3).
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

let db = null;
let insertStmt = null;
let dbPath = null;

const DEFAULT_LIMIT = 50;

function ensureColorsColumn() {
  try {
    const rows = db.prepare("PRAGMA table_info(comments)").all();
    const hasColors = rows.some((r) => r.name === "colors_json");
    if (!hasColors) {
      db.prepare("ALTER TABLE comments ADD COLUMN colors_json TEXT").run();
    }
  } catch (err) {
    console.warn("ensureColorsColumn error:", err.message || err);
  }
}

function initChatStore(baseDir) {
  // Use a writable dir (e.g. Electron's userData) to avoid ASAR issues.
  const dir = baseDir || process.cwd();
  fs.mkdirSync(dir, { recursive: true });
  dbPath = path.join(dir, "comments.db");

  db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
  } catch (_) {}

  db.exec(
    `CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      video_id TEXT,
      timestamp_ms INTEGER,
      timestamp TEXT,
      author TEXT,
      text TEXT,
      kind TEXT,
      amount INTEGER,
      amount_text TEXT,
      icon TEXT,
      parts_json TEXT,
      colors_json TEXT
    )`
  );

  ensureColorsColumn();
  insertStmt = db.prepare(
    `INSERT OR IGNORE INTO comments
     (id, video_id, timestamp_ms, timestamp, author, text, kind, amount, amount_text, icon, parts_json, colors_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  return dbPath;
}

function saveComment(msg) {
  if (!insertStmt || !msg || !msg.id) return;

  const partsJson = JSON.stringify(msg.parts || []);
  const colorsJson = JSON.stringify(msg.colors || null);
  try {
    insertStmt.run(
      msg.id,
      msg.video_id || null,
      msg.timestamp_ms ?? null,
      msg.timestamp || null,
      msg.author || null,
      msg.text || null,
      msg.kind || null,
      msg.amount ?? null,
      msg.amount_text || null,
      msg.icon || null,
      partsJson,
      colorsJson
    );
  } catch (err) {
    console.warn("saveComment sqlite error:", err.message || err);
  }
}

function getRecentComments(limit = DEFAULT_LIMIT) {
  return new Promise((resolve) => {
    if (!db) {
      resolve([]);
      return;
    }
    try {
      const lim = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 500)) : DEFAULT_LIMIT;
      const sql = `SELECT id, video_id, timestamp_ms, timestamp, author, text, kind, amount, amount_text, icon, parts_json, colors_json
                   FROM comments
                   ORDER BY timestamp_ms DESC, rowid DESC
                   LIMIT ?`;
      const rows = db.prepare(sql).all(lim);
      const result = rows.reverse().map((r) => {
        let parts = [];
        let colors = null;
        try {
          parts = r.parts_json ? JSON.parse(r.parts_json) : [];
        } catch (_) {
          parts = [];
        }
        try {
          colors = r.colors_json ? JSON.parse(r.colors_json) : null;
        } catch (_) {
          colors = null;
        }
        return {
          id: r.id,
          video_id: r.video_id,
          timestamp_ms: r.timestamp_ms,
          timestamp: r.timestamp,
          author: r.author,
          text: r.text,
          kind: r.kind,
          amount: r.amount,
          amount_text: r.amount_text,
          icon: r.icon,
          colors,
          parts,
        };
      });
      resolve(result);
    } catch (err) {
      console.warn("getRecentComments sqlite error:", err.message || err);
      resolve([]);
    }
  });
}

function closeChatStore() {
  if (db) {
    try {
      db.close();
    } catch (_) {}
    db = null;
  }
  insertStmt = null;
}

module.exports = {
  initChatStore,
  saveComment,
  getRecentComments,
  closeChatStore,
  getDbPath: () => dbPath,
};
