"use strict";

const statusEl = document.getElementById("status");
const dbPathEl = document.getElementById("dbPath");
const voicevoxSpeakerTtsEl = document.getElementById("voicevoxSpeakerTts");
const voicevoxSpeakerChatgptEl = document.getElementById("voicevoxSpeakerChatgpt");
const voicevoxStatusEl = document.getElementById("voicevoxStatus");
const refreshVoicevoxBtn = document.getElementById("refreshVoicevox");
const inputEl = document.getElementById("inputStr");
const saveInputBtn = document.getElementById("saveInputBtn");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const feedEl = document.getElementById("feed");
const limitEl = document.getElementById("limit");
const autoScrollEl = document.getElementById("autoScroll");

const tabBtnComments = document.getElementById("tabBtnComments");
const tabBtnSettings = document.getElementById("tabBtnSettings");
const tabControls = document.getElementById("tab-controls");
const tabComments = document.getElementById("tab-comments");
const tabSettings = document.getElementById("tab-settings");

const state = {
  running: false,
  seenIds: new Set(),
};

function setActiveTab(tabName) {
  const isComments = tabName === "comments";
  tabBtnComments.classList.toggle("active", isComments);
  tabBtnSettings.classList.toggle("active", !isComments);
  tabControls?.classList.toggle("hidden", !isComments);
  tabComments.classList.toggle("hidden", !isComments);
  tabSettings.classList.toggle("hidden", isComments);
  localStorage.setItem("activeTab", tabName);
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

function formatRow(r) {
  const ts = r.timestamp || "";
  const author = r.author || "???";
  const text = r.text || "";
  const badge =
    r.kind && r.kind !== "text"
      ? `<span class="badge">${escapeHtml(r.kind)}</span>`
      : "";
  const amount =
    r.amount_text ? `<span class="amount">${escapeHtml(r.amount_text)}</span>` : "";

  const icon = r.icon
    ? `<img class="icon" src="${escapeHtml(r.icon)}" alt="" />`
    : `<div class="icon placeholder"></div>`;

  return `
    <div class="msg" data-id="${escapeHtml(r.id)}">
      ${icon}
      <div class="msgBody">
        <div class="msgTop">
          <span class="ts">${escapeHtml(ts)}</span>
          <span class="author">${escapeHtml(author)}</span>
          ${badge}
          ${amount}
        </div>
        <div class="msgText">${escapeHtml(text)}</div>
      </div>
    </div>
  `;
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
  feedEl.insertAdjacentHTML("beforeend", formatRow(row));
  if (autoScrollEl.checked) feedEl.scrollTop = feedEl.scrollHeight;
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
  appendRow(comment);
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
  tabBtnSettings.addEventListener("click", () => setActiveTab("settings"));
  const saved = localStorage.getItem("activeTab");
  setActiveTab(saved === "settings" ? "settings" : "comments");
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
  await refreshDbPath();
  const savedInputStr = localStorage.getItem("savedInputStr") || "";
  if (savedInputStr && inputEl && !inputEl.value) inputEl.value = savedInputStr;
  const { running } = await window.chatApi.isRunning();
  state.running = Boolean(running);
  setButtons();
  setStatus(state.running ? "Running" : "Idle", state.running ? "running" : "idle");
  await loadRecent();
})().catch((e) => setStatus(String(e), "error"));
