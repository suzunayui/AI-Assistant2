"use strict";

const statusEl = document.getElementById("status");
const dbPathEl = document.getElementById("dbPath");
const voicevoxSpeakerTtsEl = document.getElementById("voicevoxSpeakerTts");
const voicevoxSpeakerChatgptEl = document.getElementById("voicevoxSpeakerChatgpt");
const voicevoxStatusEl = document.getElementById("voicevoxStatus");
const refreshVoicevoxBtn = document.getElementById("refreshVoicevox");
const openaiApiKeyEl = document.getElementById("openaiApiKey");
const openaiApiKeyHelpEl = document.getElementById("openaiApiKeyHelp");
const chatgptPersonaEl = document.getElementById("chatgptPersona");
const chatgptPersonaHelpEl = document.getElementById("chatgptPersonaHelp");
const chatgptTriggerKeywordsEl = document.getElementById("chatgptTriggerKeywords");
const chatgptTriggerKeywordsHelpEl = document.getElementById("chatgptTriggerKeywordsHelp");
const ttsWordReplacementsEl = document.getElementById("ttsWordReplacements");
const ttsWordReplacementsHelpEl = document.getElementById("ttsWordReplacementsHelp");
const ttsNgWordsEl = document.getElementById("ttsNgWords");
const ttsNgWordsHelpEl = document.getElementById("ttsNgWordsHelp");
const emojiSettingsListEl = document.getElementById("emojiSettingsList");
const inputEl = document.getElementById("inputStr");
const saveInputBtn = document.getElementById("saveInputBtn");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const feedEl = document.getElementById("feed");
const limitEl = document.getElementById("limit");
const autoScrollEl = document.getElementById("autoScroll");

const tabBtnComments = document.getElementById("tabBtnComments");
const tabBtnVoicevoxSettings = document.getElementById("tabBtnVoicevoxSettings");
const tabBtnChatgptSettings = document.getElementById("tabBtnChatgptSettings");
const tabBtnCommentSettings = document.getElementById("tabBtnCommentSettings");
const tabBtnEmojiSettings = document.getElementById("tabBtnEmojiSettings");
const tabControls = document.getElementById("tab-controls");
const tabComments = document.getElementById("tab-comments");
const tabVoicevoxSettings = document.getElementById("tab-voicevox-settings");
const tabChatgptSettings = document.getElementById("tab-chatgpt-settings");
const tabCommentSettings = document.getElementById("tab-comment-settings");
const tabEmojiSettings = document.getElementById("tab-emoji-settings");

const state = {
  running: false,
  seenIds: new Set(),
  chatgptTriggerKeywords: [],
  blockedAuthors: new Set(),
  authorAliases: new Map(),
  ttsWordReplacements: [],
  ttsNgWords: [],
  emojiCatalog: new Map(), // shortcode => { url, lastSeenMs }
  emojiReadings: new Map(), // shortcode => reading
  appStartedAt: Date.now(),
  voicevoxAvailable: false,
  ttsChain: Promise.resolve(),
  ttsGeneration: 0,
  ttsAbortControllers: new Set(),
  currentAudio: null,
  currentAudioUrl: "",
  openaiApiKey: "",
  chatgptPersona: "",
  respondedIds: new Set(),
};

function normalizeAuthor(author) {
  return String(author || "").trim();
}

function loadAuthorAliases() {
  const raw = localStorage.getItem("authorAliases") || "";
  state.authorAliases = new Map();
  if (!raw) return;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      const key = normalizeAuthor(k);
      const val = String(v || "").trim();
      if (!key) continue;
      if (!val) continue;
      state.authorAliases.set(key, val);
    }
  } catch (_) {}
}

function saveAuthorAliases() {
  const obj = Object.fromEntries(state.authorAliases.entries());
  localStorage.setItem("authorAliases", JSON.stringify(obj));
}

function normalizeEmojiShortcode(s) {
  const v = String(s || "").trim();
  if (!v) return "";
  if (v.startsWith(":") && v.endsWith(":") && v.length >= 3) return v;
  return v;
}

function loadEmojiCatalog() {
  state.emojiCatalog = new Map();
  const raw = localStorage.getItem("emojiCatalog");
  if (!raw) return;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      const code = normalizeEmojiShortcode(k);
      if (!code) continue;
      const url = String(v?.url || "").trim();
      const lastSeenMs = Number.isFinite(v?.lastSeenMs) ? v.lastSeenMs : 0;
      state.emojiCatalog.set(code, { url, lastSeenMs });
    }
  } catch (_) {}
}

function saveEmojiCatalog() {
  const obj = {};
  for (const [code, v] of state.emojiCatalog.entries()) {
    obj[code] = { url: v?.url || "", lastSeenMs: v?.lastSeenMs || 0 };
  }
  localStorage.setItem("emojiCatalog", JSON.stringify(obj));
}

function loadEmojiReadings() {
  state.emojiReadings = new Map();
  const raw = localStorage.getItem("emojiReadings");
  if (!raw) return;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      const code = normalizeEmojiShortcode(k);
      const reading = String(v || "").trim();
      if (!code) continue;
      if (!reading) continue;
      state.emojiReadings.set(code, reading);
    }
  } catch (_) {}
}

function saveEmojiReadings() {
  const obj = Object.fromEntries(state.emojiReadings.entries());
  localStorage.setItem("emojiReadings", JSON.stringify(obj));
}

function upsertSeenEmoji(shortcode, url) {
  const code = normalizeEmojiShortcode(shortcode);
  if (!code) return false;
  const now = Date.now();
  const current = state.emojiCatalog.get(code);
  const nextUrl = String(url || (current?.url || "")).trim();
  const changed = !current || current.url !== nextUrl;
  state.emojiCatalog.set(code, { url: nextUrl, lastSeenMs: now });
  return changed;
}

function setEmojiReading(shortcode, reading) {
  const code = normalizeEmojiShortcode(shortcode);
  if (!code) return;
  const v = String(reading || "").trim();
  if (!v) state.emojiReadings.delete(code);
  else state.emojiReadings.set(code, v);
  saveEmojiReadings();
}

function renderEmojiSettingsList() {
  if (!emojiSettingsListEl) return;
  const items = [...state.emojiCatalog.entries()];
  items.sort((a, b) => (b[1]?.lastSeenMs || 0) - (a[1]?.lastSeenMs || 0));
  const html = items
    .map(([code, info]) => {
      const url = String(info?.url || "").trim();
      const reading = state.emojiReadings.get(code) || "";
      const img = url
        ? `<img class="emojiThumb" src="${escapeHtml(url)}" alt="${escapeHtml(code)}" />`
        : `<div class="emojiThumb"></div>`;
      return `
        <div class="emojiRow" data-emoji="${escapeHtml(code)}">
          ${img}
          <div class="emojiCode">${escapeHtml(code)}</div>
          <input class="emojiReadingInput" type="text" placeholder="読み方（例: こもち）" value="${escapeHtml(
            reading
          )}" data-action="emoji-reading" data-emoji="${escapeHtml(code)}" />
        </div>
      `;
    })
    .join("");
  emojiSettingsListEl.innerHTML = html || `<div class="settingHelp">まだ絵文字が出現していません</div>`;
}

function applyEmojiReadings(text) {
  let out = String(text || "");
  for (const [code, reading] of state.emojiReadings.entries()) {
    if (!code) continue;
    if (!reading) continue;
    out = out.split(code).join(reading);
  }
  return out;
}

function getAuthorAlias(author) {
  const key = normalizeAuthor(author);
  if (!key) return "";
  return state.authorAliases.get(key) || "";
}

function setAuthorAlias(author, alias) {
  const key = normalizeAuthor(author);
  if (!key) return;
  const val = String(alias || "").trim();
  if (!val) state.authorAliases.delete(key);
  else state.authorAliases.set(key, val);
  saveAuthorAliases();
}

function loadBlockedAuthors() {
  const raw = localStorage.getItem("blockedAuthors") || "";
  if (!raw) {
    state.blockedAuthors = new Set();
    return;
  }
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      state.blockedAuthors = new Set(arr.map(normalizeAuthor).filter(Boolean));
      return;
    }
  } catch (_) {}
  state.blockedAuthors = new Set(parseTriggerKeywords(raw).map(normalizeAuthor).filter(Boolean));
}

function saveBlockedAuthors() {
  localStorage.setItem("blockedAuthors", JSON.stringify([...state.blockedAuthors]));
}

function isAuthorBlocked(author) {
  const a = normalizeAuthor(author);
  if (!a) return false;
  return state.blockedAuthors.has(a);
}

function getSpeakName(author) {
  const a = normalizeAuthor(author);
  if (!a) return "";
  const name = getAuthorAlias(a) || a;
  return name.startsWith("@") ? name.slice(1) : name;
}

function loadOpenAiApiKey() {
  const v = (localStorage.getItem("openaiApiKey") || "").trim();
  state.openaiApiKey = v;
  if (openaiApiKeyEl && openaiApiKeyEl.value !== v) openaiApiKeyEl.value = v;
  if (openaiApiKeyHelpEl) {
    openaiApiKeyHelpEl.textContent = v ? "設定済み（ローカルに保存）" : "未設定";
  }
}

function loadChatgptPersona() {
  const defaultPersona = "フレンドリーで短めに返答する";
  let stored = localStorage.getItem("chatgptPersona");
  if (stored === null) {
    stored = defaultPersona;
    localStorage.setItem("chatgptPersona", stored);
  }
  const raw = String(stored || "");
  const v = raw.trim().slice(0, 2000);
  state.chatgptPersona = v;
  if (chatgptPersonaEl && chatgptPersonaEl.value !== raw) chatgptPersonaEl.value = raw;
  if (chatgptPersonaHelpEl) {
    chatgptPersonaHelpEl.textContent = v ? "設定済み" : "未設定（デフォルト）";
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 1500, externalSignal) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort();
    else externalSignal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function checkVoicevoxAvailableOnce() {
  try {
    const resp = await fetchWithTimeout("http://127.0.0.1:50021/version", {}, 800);
    return resp.ok;
  } catch (_) {
    return false;
  }
}

async function ensureVoicevoxAvailabilityLoop() {
  // Poll so launching VOICEVOX after the app still works.
  // Avoid stacking loops on re-init.
  if (ensureVoicevoxAvailabilityLoop._running) return;
  ensureVoicevoxAvailabilityLoop._running = true;

  while (true) {
    const ok = await checkVoicevoxAvailableOnce();
    if (ok !== state.voicevoxAvailable) {
      state.voicevoxAvailable = ok;
      if (ok) {
        if (voicevoxStatusEl) {
          voicevoxStatusEl.textContent =
            "VOICEVOX検出: 起動後に投稿されたコメントを読み上げます";
        }
      } else {
        if (voicevoxStatusEl) {
          voicevoxStatusEl.textContent =
            "VOICEVOX未起動: 起動したら自動で読み上げを開始します";
        }
      }
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
}

function getSelectedTtsSpeakerStyleId() {
  const v = String(voicevoxSpeakerTtsEl?.value || "").trim();
  if (!v) return null;
  const parts = v.split(":");
  const styleId = parts.length >= 2 ? parts[parts.length - 1] : "";
  const n = Number.parseInt(styleId, 10);
  return Number.isFinite(n) ? n : null;
}

function getSelectedChatgptSpeakerStyleId() {
  const v = String(voicevoxSpeakerChatgptEl?.value || "").trim();
  if (!v) return null;
  const parts = v.split(":");
  const styleId = parts.length >= 2 ? parts[parts.length - 1] : "";
  const n = Number.parseInt(styleId, 10);
  return Number.isFinite(n) ? n : null;
}

function buildTtsText(comment) {
  const author = getSpeakName(comment?.author);
  const rawText = getRawCommentText(comment).trim();
  // Priority: generic replacements first, then emoji readings (so replacements can override).
  const replaced = applyEmojiReadings(applyTtsReplacements(rawText));
  const cleaned = stripEmojis(stripUnreplacedEmojiShortcodes(replaced));
  const text = cleaned.trim();
  if (!text) return "";
  if (text === "[STICKER]") return "";
  if (author) return `${author}さん、${text}`;
  return text;
}

function buildChatgptPrompt(comment) {
  const author = getSpeakName(comment?.author);
  const text = String(comment?.text || "").trim();
  if (!text) return "";
  const said = author ? `${author}さんが「${text}」と言いました。` : `「${text}」と言いました。`;
  return `配信コメント: ${said}これに対して配信向けに自然に返答してください。`;
}

async function voicevoxSynthesizeWav(text, speakerStyleId, signal) {
  const qUrl = `http://127.0.0.1:50021/audio_query?text=${encodeURIComponent(
    text
  )}&speaker=${encodeURIComponent(String(speakerStyleId))}`;
  const qResp = await fetchWithTimeout(
    qUrl,
    { method: "POST", headers: { Accept: "application/json" } },
    2500,
    signal
  );
  if (!qResp.ok) throw new Error(`audio_query failed: ${qResp.status}`);
  const query = await qResp.json();

  const sUrl = `http://127.0.0.1:50021/synthesis?speaker=${encodeURIComponent(
    String(speakerStyleId)
  )}`;
  const sResp = await fetchWithTimeout(
    sUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "audio/wav" },
      body: JSON.stringify(query),
    },
    10000,
    signal
  );
  if (!sResp.ok) throw new Error(`synthesis failed: ${sResp.status}`);
  return await sResp.arrayBuffer();
}

async function playWavArrayBuffer(buf, signal) {
  const blob = new Blob([buf], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  try {
    const audio = new Audio(url);
    state.currentAudio = audio;
    state.currentAudioUrl = url;
    audio.preload = "auto";

    const onAbort = () => {
      try {
        audio.pause();
        audio.currentTime = 0;
      } catch (_) {}
      try {
        audio.src = "";
      } catch (_) {}
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    await audio.play();
    await new Promise((resolve) => {
      audio.addEventListener("ended", resolve, { once: true });
      audio.addEventListener("error", resolve, { once: true });
    });
  } finally {
    if (state.currentAudioUrl === url) state.currentAudioUrl = "";
    if (state.currentAudio && state.currentAudio.src && state.currentAudio.src.includes(url)) {
      state.currentAudio = null;
    } else if (state.currentAudioUrl === "") {
      state.currentAudio = null;
    }
    URL.revokeObjectURL(url);
  }
}

function clearTtsQueue() {
  state.ttsGeneration++;
  for (const c of state.ttsAbortControllers) {
    try {
      c.abort();
    } catch (_) {}
  }
  state.ttsAbortControllers.clear();
  if (state.currentAudio) {
    try {
      state.currentAudio.pause();
      state.currentAudio.currentTime = 0;
    } catch (_) {}
    try {
      state.currentAudio.src = "";
    } catch (_) {}
  }
  if (state.currentAudioUrl) {
    try {
      URL.revokeObjectURL(state.currentAudioUrl);
    } catch (_) {}
    state.currentAudioUrl = "";
  }
  state.currentAudio = null;
}

function shouldSpeakComment(comment, receivedAtMs) {
  if (!comment) return false;
  if (!state.voicevoxAvailable) return false;

  const commentTs =
    Number.isFinite(comment.timestamp_ms) && comment.timestamp_ms > 0
      ? comment.timestamp_ms
      : receivedAtMs;
  if (commentTs < state.appStartedAt) return false;

  const speakerStyleId = getSelectedTtsSpeakerStyleId();
  if (!speakerStyleId) return false;

  const author = normalizeAuthor(comment.author);
  if (author && isAuthorBlocked(author)) return false;

  if (containsNgWord(getRawCommentText(comment))) return false;

  const speechText = buildTtsText(comment);
  if (!speechText) return false;
  return true;
}

function enqueueSpeakComment(comment, receivedAtMs) {
  if (!shouldSpeakComment(comment, receivedAtMs)) return;

  const myGen = state.ttsGeneration;
  state.ttsChain = state.ttsChain
    .catch(() => {}) // keep the chain alive
    .then(async () => {
      // Re-check right before speaking (settings might have changed while queued).
      if (myGen !== state.ttsGeneration) return;
      if (!shouldSpeakComment(comment, receivedAtMs)) return;
      const speakerStyleId = getSelectedTtsSpeakerStyleId();
      const text = buildTtsText(comment);
      if (!speakerStyleId || !text) return;

      const abortCtrl = new AbortController();
      state.ttsAbortControllers.add(abortCtrl);
      try {
        const wav = await voicevoxSynthesizeWav(text, speakerStyleId, abortCtrl.signal);
        if (myGen !== state.ttsGeneration || abortCtrl.signal.aborted) return;
        await playWavArrayBuffer(wav, abortCtrl.signal);
        if (myGen !== state.ttsGeneration || abortCtrl.signal.aborted) return;

        const triggerKw = findChatgptTriggerKeyword(comment?.text);
        if (!triggerKw) return;
        if (!comment?.id) return;
        if (state.respondedIds.has(comment.id)) return;
        if (!state.openaiApiKey) return;

        const chatgptSpeakerStyleId = getSelectedChatgptSpeakerStyleId();
        if (!chatgptSpeakerStyleId) return;

        state.respondedIds.add(comment.id);
        const prompt = buildChatgptPrompt(comment);
        if (!prompt) return;

        const res = await window.chatApi.openaiRespond(
          state.openaiApiKey,
          prompt,
          state.chatgptPersona
        );
        if (myGen !== state.ttsGeneration || abortCtrl.signal.aborted) return;
        if (!res || !res.ok) {
          console.error("OpenAI error:", res?.error || res);
          return;
        }
        const replyText = stripEmojis(applyTtsReplacements(String(res.text || ""))).trim();
        if (!replyText) return;

        const replyWav = await voicevoxSynthesizeWav(replyText, chatgptSpeakerStyleId, abortCtrl.signal);
        if (myGen !== state.ttsGeneration || abortCtrl.signal.aborted) return;
        await playWavArrayBuffer(replyWav, abortCtrl.signal);
      } finally {
        state.ttsAbortControllers.delete(abortCtrl);
      }
    })
    .catch((e) => {
      console.error("VOICEVOX TTS error:", e);
    });
}

function setActiveTab(tabName) {
  const tab =
    tabName === "voicevox" ||
    tabName === "chatgpt" ||
    tabName === "commentSettings" ||
    tabName === "emojiSettings"
      ? tabName
      : "comments";
  const isComments = tab === "comments";
  const isVoicevox = tab === "voicevox";
  const isChatgpt = tab === "chatgpt";
  const isCommentSettings = tab === "commentSettings";
  const isEmojiSettings = tab === "emojiSettings";

  tabBtnComments?.classList.toggle("active", isComments);
  tabBtnVoicevoxSettings?.classList.toggle("active", isVoicevox);
  tabBtnChatgptSettings?.classList.toggle("active", isChatgpt);
  tabBtnCommentSettings?.classList.toggle("active", isCommentSettings);
  tabBtnEmojiSettings?.classList.toggle("active", isEmojiSettings);

  tabControls?.classList.toggle("hidden", !isComments);
  tabComments?.classList.toggle("hidden", !isComments);
  tabVoicevoxSettings?.classList.toggle("hidden", !isVoicevox);
  tabChatgptSettings?.classList.toggle("hidden", !isChatgpt);
  tabCommentSettings?.classList.toggle("hidden", !isCommentSettings);
  tabEmojiSettings?.classList.toggle("hidden", !isEmojiSettings);

  localStorage.setItem("activeTab", tab);
}

function setStatus(text, kind = "idle") {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderMessagePartsHtml(parts) {
  const out = [];
  const arr = Array.isArray(parts) ? parts : [];
  for (const p of arr) {
    if (!p) continue;
    if (p.type === "text") {
      out.push(escapeHtml(p.text || "").replaceAll("\n", "<br />"));
    } else if (p.type === "emoji") {
      const url = String(p.url || "").trim();
      const alt = String(p.alt || "").trim();
      if (!url) {
        out.push(escapeHtml(alt));
      } else {
        out.push(
          `<img class="emojiImg" src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" title="${escapeHtml(
            alt
          )}" />`
        );
      }
    } else if (p.type === "sticker") {
      const url = String(p.url || "").trim();
      const alt = String(p.alt || "").trim();
      if (url) {
        out.push(
          `<img class="stickerImg" src="${escapeHtml(url)}" alt="${escapeHtml(
            alt
          )}" title="${escapeHtml(alt)}" />`
        );
      } else if (alt) {
        out.push(escapeHtml(alt));
      }
    }
  }
  return out.join("");
}

function formatRow(r) {
  const ts = r.timestamp || "";
  const author = r.author || "???";
  const blocked = isAuthorBlocked(author);
  const alias = getAuthorAlias(author);
  const parts = Array.isArray(r.parts) ? r.parts : null;
  const text = r.text || "";
  const msgHtml = parts ? renderMessagePartsHtml(parts) : escapeHtml(text);
  const badge =
    r.kind && r.kind !== "text"
      ? `<span class="badge">${escapeHtml(r.kind)}</span>`
      : "";
  const gptBadge = r.chatgpt_trigger ? `<span class="badge">GPT</span>` : "";
  const amount =
    r.amount_text ? `<span class="amount">${escapeHtml(r.amount_text)}</span>` : "";
  const blockBtn = author
    ? `<button class="miniBtn ${blocked ? "danger" : ""}" type="button" data-action="toggle-block" data-author="${escapeHtml(
        author
      )}">${blocked ? "ブロック解除" : "ブロック"}</button>`
    : "";
  const aliasInput = author
    ? `<input class="aliasInput" type="text" data-action="alias" data-author="${escapeHtml(
        author
      )}" placeholder="別名" value="${escapeHtml(alias)}" />`
    : "";

  const icon = r.icon
    ? `<img class="icon" src="${escapeHtml(r.icon)}" alt="" />`
    : `<div class="icon placeholder"></div>`;

  return `
    <div class="msg ${blocked ? "blocked" : ""}" data-id="${escapeHtml(r.id)}" data-author="${escapeHtml(
    author
  )}">
      ${icon}
      <div class="msgBody">
        <div class="msgTop">
          <span class="ts">${escapeHtml(ts)}</span>
          <span class="author">${escapeHtml(author)}</span>
          ${badge}
          ${gptBadge}
          ${amount}
          ${blockBtn}
          ${aliasInput}
        </div>
        <div class="msgText">${msgHtml}</div>
      </div>
    </div>
  `;
}

function parseTriggerKeywords(raw) {
  const text = String(raw || "");
  const parts = text
    .split(/[\r\n,、]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const uniq = [];
  const seen = new Set();
  for (const p of parts) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(p);
    if (uniq.length >= 50) break;
  }
  return uniq;
}

function parseTtsWordReplacements(raw) {
  const text = String(raw || "");
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    const idxArrow = line.indexOf("=>");
    let from;
    let to;
    if (idxArrow !== -1) {
      from = line.slice(0, idxArrow).trim();
      to = line.slice(idxArrow + 2).trim();
    } else {
      const idxComma = line.indexOf(",");
      if (idxComma === -1) continue;
      from = line.slice(0, idxComma).trim();
      to = line.slice(idxComma + 1).trim();
    }
    if (!from) continue;
    out.push({ from, to: to || "" });
    if (out.length >= 100) break;
  }
  return out;
}

function loadTtsReplacements() {
  const raw = String(localStorage.getItem("ttsWordReplacements") || "");
  state.ttsWordReplacements = parseTtsWordReplacements(raw);
  if (ttsWordReplacementsEl && ttsWordReplacementsEl.value !== raw) {
    ttsWordReplacementsEl.value = raw;
  }
  if (ttsWordReplacementsHelpEl) {
    const n = state.ttsWordReplacements.length;
    ttsWordReplacementsHelpEl.textContent = n ? `${n}件登録済み` : "未設定";
  }
}

function loadTtsNgWords() {
  const raw = String(localStorage.getItem("ttsNgWords") || "");
  state.ttsNgWords = parseTriggerKeywords(raw);
  if (ttsNgWordsEl && ttsNgWordsEl.value !== raw) ttsNgWordsEl.value = raw;
  if (ttsNgWordsHelpEl) {
    const n = state.ttsNgWords.length;
    ttsNgWordsHelpEl.textContent = n ? `${n}件登録済み` : "未設定";
  }
}

function applyTtsReplacements(text) {
  let out = String(text || "");
  for (const rule of state.ttsWordReplacements) {
    if (!rule || !rule.from) continue;
    out = out.split(rule.from).join(rule.to || "");
  }
  return out;
}

function stripEmojis(text) {
  // Remove pictographic/emoji chars and common joiner/variation characters
  // so TTS won't try to read them out.
  return String(text || "")
    .replace(/[\u200D\uFE0E\uFE0F]/g, "") // ZWJ + variation selectors
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\p{Regional_Indicator}/gu, "") // flags
    .replace(/\s{2,}/g, " ");
}

function stripUnreplacedEmojiShortcodes(text) {
  // Custom emoji shortcodes like :komochi: (after replacements).
  return String(text || "")
    .replace(/:[^\s:]{1,64}:/g, "")
    .replace(/\s{2,}/g, " ");
}

function plainTextFromParts(parts) {
  const arr = Array.isArray(parts) ? parts : [];
  let out = "";
  for (const p of arr) {
    if (!p) continue;
    if (p.type === "text") out += String(p.text || "");
    else if (p.type === "emoji") out += String(p.alt || ""); // e.g. :komochi:
  }
  return out;
}

function getRawCommentText(comment) {
  if (!comment) return "";
  if (Array.isArray(comment.parts) && comment.parts.length) return plainTextFromParts(comment.parts);
  return String(comment.text || "");
}

function containsNgWord(text) {
  const t = String(text || "");
  if (!t) return false;
  for (const w of state.ttsNgWords) {
    if (!w) continue;
    if (t.includes(w)) return true;
  }
  return false;
}

function loadChatgptTriggerKeywords() {
  const defaultKeywords = "こもち\nkomochi";
  const legacy = localStorage.getItem("chatgptTriggerKeyword");
  const saved = localStorage.getItem("chatgptTriggerKeywords");

  let raw;
  if (saved === null && legacy === null) {
    raw = defaultKeywords;
    localStorage.setItem("chatgptTriggerKeywords", raw);
  } else {
    raw = saved;
    if ((!raw || !raw.trim()) && legacy) raw = legacy;
    if (!raw) raw = "";
  }

  // Accept either JSON array or plain text.
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) raw = arr.join("\n");
    } catch (_) {}
  }

  state.chatgptTriggerKeywords = parseTriggerKeywords(raw);
  if (chatgptTriggerKeywordsEl && chatgptTriggerKeywordsEl.value !== raw) {
    chatgptTriggerKeywordsEl.value = raw;
  }
  if (chatgptTriggerKeywordsHelpEl) {
    const n = state.chatgptTriggerKeywords.length;
    chatgptTriggerKeywordsHelpEl.textContent = n ? `${n}件登録済み` : "未設定（無効）";
  }
}

function findChatgptTriggerKeyword(text) {
  const t = String(text || "");
  if (!t) return null;
  for (const kw of state.chatgptTriggerKeywords) {
    if (!kw) continue;
    if (t.includes(kw)) return kw;
  }
  return null;
}

function updateBlockUiForAuthor(author) {
  const a = normalizeAuthor(author);
  if (!a || !feedEl) return;
  const blocked = isAuthorBlocked(a);
  const msgEls = feedEl.querySelectorAll(`.msg[data-author="${CSS.escape(a)}"]`);
  for (const el of msgEls) {
    el.classList.toggle("blocked", blocked);
    const btn = el.querySelector('[data-action="toggle-block"]');
    if (btn) {
      btn.textContent = blocked ? "ブロック解除" : "ブロック";
      btn.classList.toggle("danger", blocked);
    }
  }
}

async function refreshDbPath() {
  const p = await window.chatApi.getDbPath();
  dbPathEl.textContent = p ? `DB: ${p}` : "";
}

function setButtons() {
  startBtn.disabled = state.running;
  stopBtn.disabled = !state.running;
}

function appendRow(row) {
  if (!row || !row.id) return;
  if (state.seenIds.has(row.id)) return;
  state.seenIds.add(row.id);
  const triggerKw = findChatgptTriggerKeyword(row.text);
  const decorated = triggerKw ? { ...row, chatgpt_trigger: true } : row;
  feedEl.insertAdjacentHTML("beforeend", formatRow(decorated));
  const active = document.activeElement;
  const aliasEditing = active && active.classList && active.classList.contains("aliasInput");
  if (autoScrollEl.checked && !aliasEditing) feedEl.scrollTop = feedEl.scrollHeight;
}

async function loadRecent() {
  const limit = Number.parseInt(limitEl.value, 10) || 100;
  const rows = await window.chatApi.getRecent(limit);
  feedEl.innerHTML = "";
  state.seenIds.clear();
  for (const r of rows) appendRow(r);
}

async function start() {
  let inputStr = inputEl.value.trim();
  if (!inputStr) {
    const saved = localStorage.getItem("savedInputStr") || "";
    if (saved) {
      inputStr = saved;
      inputEl.value = saved;
    }
  }
  if (!inputStr) {
    setStatus("入力してください", "error");
    return;
  }

  setStatus("Starting…", "busy");
  await window.chatApi.start(inputStr, {});
  state.running = true;
  setButtons();
  setStatus("Running", "running");
  await loadRecent();
}

async function stop() {
  setStatus("Stopping…", "busy");
  clearTtsQueue();
  await window.chatApi.stop();
  state.running = false;
  setButtons();
  setStatus("Stopped", "idle");
  await loadRecent();
}

startBtn.addEventListener("click", () => start().catch((e) => setStatus(String(e), "error")));
stopBtn.addEventListener("click", () => stop().catch((e) => setStatus(String(e), "error")));
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") start().catch((err) => setStatus(String(err), "error"));
});
limitEl.addEventListener("change", () => loadRecent().catch((e) => console.error(e)));

feedEl?.addEventListener("click", (e) => {
  const btn = e.target?.closest?.('[data-action="toggle-block"]');
  if (!btn) return;
  const author = normalizeAuthor(btn.dataset.author);
  if (!author) return;
  if (state.blockedAuthors.has(author)) state.blockedAuthors.delete(author);
  else state.blockedAuthors.add(author);
  saveBlockedAuthors();
  updateBlockUiForAuthor(author);
});

feedEl?.addEventListener("input", (e) => {
  const el = e.target;
  if (!el || !el.classList || !el.classList.contains("aliasInput")) return;
  const author = normalizeAuthor(el.dataset.author);
  if (!author) return;
  setAuthorAlias(author, el.value);
});

emojiSettingsListEl?.addEventListener("input", (e) => {
  const el = e.target;
  if (!el || !el.classList || !el.classList.contains("emojiReadingInput")) return;
  const code = String(el.dataset.emoji || "").trim();
  setEmojiReading(code, el.value);
});

saveInputBtn?.addEventListener("click", () => {
  const v = inputEl.value.trim();
  if (!v) {
    setStatus("保存する値が空です", "error");
    return;
  }
  localStorage.setItem("savedInputStr", v);
  setStatus("入力を保存しました", "idle");
});

window.chatApi.onDbPath(({ dbPath }) => {
  dbPathEl.textContent = dbPath ? `DB: ${dbPath}` : "";
});

window.chatApi.onComment((comment) => {
  const receivedAtMs = Date.now();

  // Collect custom emojis that appeared at least once.
  if (Array.isArray(comment?.parts)) {
    let changed = false;
    for (const p of comment.parts) {
      if (p?.type === "emoji") {
        const code = String(p.alt || "").trim();
        const url = String(p.url || "").trim();
        if (upsertSeenEmoji(code, url)) changed = true;
      }
    }
    if (changed) {
      saveEmojiCatalog();
      renderEmojiSettingsList();
    }
  }

  appendRow(comment);
  enqueueSpeakComment(comment, receivedAtMs);
});

window.chatApi.onRunning(({ running }) => {
  state.running = Boolean(running);
  setButtons();
  setStatus(state.running ? "Running" : "Idle", state.running ? "running" : "idle");
});

window.chatApi.onError(({ message }) => {
  setStatus(message || "error", "error");
});

window.chatApi.onStopped(() => {
  state.running = false;
  setButtons();
  setStatus("Stopped", "idle");
});

(function initTabs() {
  tabBtnComments.addEventListener("click", () => setActiveTab("comments"));
  tabBtnVoicevoxSettings?.addEventListener("click", () => setActiveTab("voicevox"));
  tabBtnChatgptSettings?.addEventListener("click", () => setActiveTab("chatgpt"));
  tabBtnCommentSettings?.addEventListener("click", () => setActiveTab("commentSettings"));
  tabBtnEmojiSettings?.addEventListener("click", () => setActiveTab("emojiSettings"));
  const saved = localStorage.getItem("activeTab");
  setActiveTab(
    saved === "voicevox" ||
      saved === "chatgpt" ||
      saved === "commentSettings" ||
      saved === "emojiSettings"
      ? saved
      : "comments"
  );
})();

(function initSettings() {
  // Back-compat: migrate old single selection if present.
  const legacy = localStorage.getItem("voicevoxSpeaker") || "";
  if (legacy && !localStorage.getItem("voicevoxSpeakerTts")) {
    localStorage.setItem("voicevoxSpeakerTts", legacy);
  }
  if (legacy && !localStorage.getItem("voicevoxSpeakerChatgpt")) {
    localStorage.setItem("voicevoxSpeakerChatgpt", legacy);
  }

  const savedTts = localStorage.getItem("voicevoxSpeakerTts") || "";
  const savedChatgpt = localStorage.getItem("voicevoxSpeakerChatgpt") || "";

  loadOpenAiApiKey();
  openaiApiKeyEl?.addEventListener("input", () => {
    const raw = String(openaiApiKeyEl?.value || "").trim();
    localStorage.setItem("openaiApiKey", raw);
    loadOpenAiApiKey();
  });

  loadChatgptPersona();
  chatgptPersonaEl?.addEventListener("input", () => {
    const raw = String(chatgptPersonaEl?.value || "");
    localStorage.setItem("chatgptPersona", raw);
    loadChatgptPersona();
  });

  loadChatgptTriggerKeywords();
  chatgptTriggerKeywordsEl?.addEventListener("input", () => {
    const raw = String(chatgptTriggerKeywordsEl?.value || "");
    localStorage.setItem("chatgptTriggerKeywords", raw);
    loadChatgptTriggerKeywords();
  });

  loadTtsReplacements();
  ttsWordReplacementsEl?.addEventListener("input", () => {
    const raw = String(ttsWordReplacementsEl?.value || "");
    localStorage.setItem("ttsWordReplacements", raw);
    loadTtsReplacements();
  });

  loadTtsNgWords();
  ttsNgWordsEl?.addEventListener("input", () => {
    const raw = String(ttsNgWordsEl?.value || "");
    localStorage.setItem("ttsNgWords", raw);
    loadTtsNgWords();
  });

  function setLoading() {
    const loadingOpt = `<option value="">取得中…</option>`;
    if (voicevoxSpeakerTtsEl) voicevoxSpeakerTtsEl.innerHTML = loadingOpt;
    if (voicevoxSpeakerChatgptEl) voicevoxSpeakerChatgptEl.innerHTML = loadingOpt;
  }

  async function refreshVoicevoxSpeakers() {
    if (!voicevoxSpeakerTtsEl && !voicevoxSpeakerChatgptEl) return;
    setLoading();
    if (voicevoxStatusEl) voicevoxStatusEl.textContent = "";

    const res = await window.chatApi.getVoicevoxSpeakers();
    if (!res || !res.ok) {
      const notAvail = `<option value="">（未取得）</option>`;
      if (voicevoxSpeakerTtsEl) voicevoxSpeakerTtsEl.innerHTML = notAvail;
      if (voicevoxSpeakerChatgptEl) voicevoxSpeakerChatgptEl.innerHTML = notAvail;
      if (voicevoxStatusEl) {
        voicevoxStatusEl.textContent =
          "VOICEVOXを起動してください（エンジン: http://127.0.0.1:50021）";
      }
      return;
    }

    const speakers = Array.isArray(res.speakers) ? res.speakers : [];
    const opts = [];
    for (const sp of speakers) {
      const speakerName = sp?.name || "Unknown";
      const speakerUuid = sp?.speaker_uuid || "";
      const styles = Array.isArray(sp?.styles) ? sp.styles : [];
      for (const st of styles) {
        const styleName = st?.name || "style";
        const styleId = Number.isFinite(st?.id) ? st.id : st?.id;
        const value = `${speakerUuid}:${styleId}`;
        opts.push({
          value,
          label: `${speakerName} - ${styleName}`,
        });
      }
    }

    if (opts.length === 0) {
      const none = `<option value="">（話者なし）</option>`;
      if (voicevoxSpeakerTtsEl) voicevoxSpeakerTtsEl.innerHTML = none;
      if (voicevoxSpeakerChatgptEl) voicevoxSpeakerChatgptEl.innerHTML = none;
      if (voicevoxStatusEl) voicevoxStatusEl.textContent = "VOICEVOX話者が取得できませんでした";
      return;
    }

    const html =
      `<option value="">選択してください</option>` +
      opts
        .map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`)
        .join("");

    if (voicevoxSpeakerTtsEl) {
      voicevoxSpeakerTtsEl.innerHTML = html;
      if (savedTts) voicevoxSpeakerTtsEl.value = savedTts;
    }
    if (voicevoxSpeakerChatgptEl) {
      voicevoxSpeakerChatgptEl.innerHTML = html;
      if (savedChatgpt) voicevoxSpeakerChatgptEl.value = savedChatgpt;
    }
    if (voicevoxStatusEl) voicevoxStatusEl.textContent = "VOICEVOX話者を取得しました";
  }

  refreshVoicevoxBtn?.addEventListener("click", () => {
    refreshVoicevoxSpeakers().catch((e) => console.error("voicevox refresh error:", e));
  });

  voicevoxSpeakerTtsEl?.addEventListener("change", () => {
    localStorage.setItem("voicevoxSpeakerTts", (voicevoxSpeakerTtsEl?.value || "").trim());
  });
  voicevoxSpeakerChatgptEl?.addEventListener("change", () => {
    localStorage.setItem(
      "voicevoxSpeakerChatgpt",
      (voicevoxSpeakerChatgptEl?.value || "").trim()
    );
  });

  refreshVoicevoxSpeakers().catch((e) => console.error("voicevox init error:", e));
})();

(async function init() {
  loadBlockedAuthors();
  loadAuthorAliases();
  loadEmojiCatalog();
  loadEmojiReadings();
  renderEmojiSettingsList();
  ensureVoicevoxAvailabilityLoop().catch((e) => console.error("voicevox availability loop:", e));
  await refreshDbPath();
  const savedInputStr = localStorage.getItem("savedInputStr") || "";
  if (savedInputStr && inputEl && !inputEl.value) inputEl.value = savedInputStr;
  const { running } = await window.chatApi.isRunning();
  state.running = Boolean(running);
  setButtons();
  setStatus(state.running ? "Running" : "Idle", state.running ? "running" : "idle");
  await loadRecent();
})().catch((e) => setStatus(String(e), "error"));
