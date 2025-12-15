// youtubeChat.js
// Node.js 18+ を前提（global.fetch を使用）

// ==============================
// 内部状態
// ==============================
const chatStore = require("./chatStore");

let stopFlag = false;
let running = false;

// ==============================
// 共通ユーティリティ
// ==============================
function pushComment(msg) {
  // DB のみに保存する（メモリには保持しない）
  chatStore.saveComment(msg);
}

function getComments() {
  // メモリ保持は不要なので空配列を返す
  return [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==============================
// YouTube 関連
// ==============================

/**
 * 入力が:
 *  ・videoId → そのまま返す（11文字）
 *  ・@handle → /live の videoId を抽出
 *  ・チャンネルID → /live の videoId を抽出
 *
 * 配信中でない場合は null を返す。
 */
async function resolveVideoId(inputStr) {
  if (inputStr.length === 11 && !inputStr.startsWith("@")) {
    return inputStr; // videoId
  }

  let url;
  if (inputStr.startsWith("@")) {
    url = `https://www.youtube.com/${inputStr}/live`;
  } else {
    url = `https://www.youtube.com/channel/${inputStr}/live`;
  }

  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36",
    },
    redirect: "follow",
  });

  if (!resp.ok) {
    throw new Error(`failed to fetch /live page: ${resp.status}`);
  }

  const html = await resp.text();

  const m = html.match(
    /<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([^"]+)">/
  );
  if (m) {
    return m[1];
  }

  // 配信していない or 取得失敗
  return null;
}

/**
 * watch ページ HTML を取得
 */
async function getWatchHtml(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36",
    },
  });

  if (!resp.ok) {
    throw new Error(`failed to fetch watch page: ${resp.status}`);
  }

  return await resp.text();
}

/**
 * live_chat (popout) HTML を取得
 * watchページより continuation が取りやすいことがある
 */
async function getLiveChatHtml(videoId) {
  const url = `https://www.youtube.com/live_chat?v=${videoId}&is_popout=1`;
  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36",
    },
  });

  if (!resp.ok) {
    throw new Error(`failed to fetch live_chat page: ${resp.status}`);
  }

  return await resp.text();
}

function firstMatch(html, patterns) {
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return m[1];
  }
  return null;
}

function extractLiveChatContinuation(html) {
  const anchorKeys = ['"liveChatRenderer"', '"LiveChatRenderer"', '"liveChatContinuation"'];
  let idx = -1;
  for (const k of anchorKeys) {
    idx = html.indexOf(k);
    if (idx !== -1) break;
  }
  const slice = idx !== -1 ? html.slice(idx, idx + 250000) : html;
  return firstMatch(slice, [/"continuation"\s*:\s*"([^"]+)"/]);
}

/**
 * watch ページ HTML から:
 *  - INNERTUBE_API_KEY
 *  - clientVersion
 *  - continuation
 * を抜き出す
 */
function extractOptionsFromHtml(html) {
  const apiKey = firstMatch(html, [/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/]);
  const clientVersion = firstMatch(html, [
    /"clientVersion"\s*:\s*"([^"]+)"/,
    /"INNERTUBE_CONTEXT_CLIENT_VERSION"\s*:\s*"([^"]+)"/,
    /"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/,
  ]);
  const continuation =
    extractLiveChatContinuation(html) || firstMatch(html, [/"continuation"\s*:\s*"([^"]+)"/]);

  if (!apiKey) throw new Error("INNERTUBE_API_KEY が見つかりません");
  if (!clientVersion) throw new Error("clientVersion が見つかりません");
  if (!continuation) throw new Error("continuation が見つかりません");

  return { apiKey, clientVersion, continuation };
}

/**
 * continuation の block から
 *  - continuation
 *  - timeoutMs
 * を取り出す
 */
function extractContinuationData(cont0) {
  const keys = ["timedContinuationData", "invalidationContinuationData"];

  for (const k of keys) {
    if (cont0[k]) {
      const block = cont0[k];
      return {
        continuation: block.continuation,
        timeoutMs: block.timeoutMs ?? 2000,
      };
    }
  }

  throw new Error(
    "Unknown continuation block type: " + Object.keys(cont0).join(",")
  );
}

/**
 * live_chat/get_live_chat を叩く共通処理
 */
async function postLiveChat(apiKey, clientVersion, continuation) {
  const url = `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${apiKey}`;

  const payload = {
    context: {
      client: {
        clientName: "WEB",
        clientVersion,
        hl: "ja",
        gl: "JP",
        utcOffsetMinutes: -new Date().getTimezoneOffset(),
      },
    },
    continuation,
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0",
      "X-YouTube-Client-Name": "1",
      "X-YouTube-Client-Version": clientVersion,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`live_chat error: ${resp.status} ${text}`);
  }

  return await resp.json();
}

/**
 * Top Chat continuation → すべてのチャット continuation に切り替える
 * （取れなければ元の continuation を返す）
 */
async function switchToAllChatContinuation(apiKey, clientVersion, continuation) {
  const data = await postLiveChat(apiKey, clientVersion, continuation);

  const liveCont =
    data?.continuationContents?.liveChatContinuation ?? {};
  const header =
    liveCont?.header?.liveChatHeaderRenderer ?? {};
  const viewSelector =
    header?.viewSelector?.sortFilterSubMenuRenderer ?? {};
  const subItems = viewSelector?.subMenuItems ?? [];

  for (const item of subItems) {
    if (!item.selected && item.continuation?.reloadContinuationData) {
      const cont = item.continuation.reloadContinuationData.continuation;
      if (cont) return cont;
    }
  }

  return continuation;
}

// ==============================
// パース系ヘルパー
// ==============================
function runsToPlain(runs) {
  if (!runs) return "";
  return runs.map((r) => r.text || "").join("");
}

function parseAmountToInt(text) {
  if (!text) return null;
  const m = text.match(/([\d,]+)/);
  if (!m) return null;
  const digits = m[1].replace(/,/g, "");
  const n = parseInt(digits, 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * liveChatTextMessageRenderer / liveChatPaidMessageRenderer の
 * message.runs から「テキスト + 絵文字」を分解
 */
function parseMessageParts(renderer) {
  const parts = [];
  const runs = renderer?.message?.runs ?? [];
  for (const r of runs) {
    if ("text" in r) {
      parts.push({
        type: "text",
        text: r.text || "",
      });
    } else if (r.emoji) {
      const emoji = r.emoji;
      const img = emoji.image || {};
      const thumbs = img.thumbnails || [];
      const url = thumbs.length ? thumbs[thumbs.length - 1].url : "";
      const shortcuts = emoji.shortcuts || [];
      const alt = shortcuts[0] || emoji.emojiId || "";
      parts.push({
        type: "emoji",
        url,
        alt,
        emojiId: emoji.emojiId || "",
        shortcuts: Array.isArray(shortcuts) ? shortcuts : [],
      });
    }
  }
  return parts;
}

/**
 * liveChatPaidStickerRenderer からスタンプ parts を作る
 */
function parseStickerParts(renderer) {
  const sticker = renderer.sticker || {};
  const thumbs = sticker.thumbnails || [];
  const url = thumbs.length ? thumbs[thumbs.length - 1].url : "";
  const alt =
    sticker.accessibility?.accessibilityData?.label || "";
  return [
    {
      type: "sticker",
      url,
      alt,
    },
  ];
}

function toHex(v) {
  if (v == null) return null;
  return (
    "#" +
    ((v & 0xffffff) | 0)
      .toString(16)
      .padStart(6, "0")
      .toUpperCase()
  );
}

/**
 * 各 renderer からアイコン画像の URL を取得
 */
function extractAuthorPhoto(renderer, msgType) {
  // 通常・スパチャ・ステッカー・メンバーなど共通
  if (renderer.authorPhoto?.thumbnails) {
    const thumbs = renderer.authorPhoto.thumbnails;
    return thumbs[thumbs.length - 1].url; // 一番大きそうなの
  }

  // ギフト購入は header.liveChatSponsorshipsHeaderRenderer の中にある
  if (msgType === "gift_purchase") {
    const h = renderer.header?.liveChatSponsorshipsHeaderRenderer;
    if (h?.authorPhoto?.thumbnails) {
      const thumbs = h.authorPhoto.thumbnails;
      return thumbs[thumbs.length - 1].url;
    }
  }

  return null;
}

/**
 * 日付フォーマット: YYYY-MM-DD HH:MM:SS
 */
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

/**
 * 1回分のチャットを取得して:
 *  - 抽出したメッセージ一覧
 *  - 次の continuation
 *  - 次回までの timeoutMs
 * を返す
 */
async function fetchChatOnce(apiKey, clientVersion, continuation) {
  const data = await postLiveChat(apiKey, clientVersion, continuation);

  const liveCont = data.continuationContents.liveChatContinuation;
  const actions = liveCont.actions || [];
  const chatItems = [];

  for (let idx = 0; idx < actions.length; idx++) {
    const action = actions[idx];
    if (!action.addChatItemAction) continue;
    const item = action.addChatItemAction.item;

    let renderer = null;
    let msgType = null; // "text"/"paid"/"sticker"/"membership"/"gift_purchase"/"gift_redeem"
    let superColors = null;
    let amountValue = null;
    let amountText = "";

    if (item.liveChatTextMessageRenderer) {
      renderer = item.liveChatTextMessageRenderer;
      msgType = "text";
    } else if (item.liveChatPaidMessageRenderer) {
      renderer = item.liveChatPaidMessageRenderer;
      msgType = "paid";
    } else if (item.liveChatPaidStickerRenderer) {
      renderer = item.liveChatPaidStickerRenderer;
      msgType = "sticker";
    } else if (item.liveChatMembershipItemRenderer) {
      renderer = item.liveChatMembershipItemRenderer;
      msgType = "membership";
    } else if (item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer) {
      renderer = item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer;
      msgType = "gift_purchase";
    } else if (item.liveChatGiftRedemptionAnnouncementRenderer) {
      renderer = item.liveChatGiftRedemptionAnnouncementRenderer;
      msgType = "gift_redeem";
    }

    if (!renderer) continue;

    // authorName simpleText / runs 両対応
    const authorBlock = renderer.authorName || {};
    let author =
      authorBlock.simpleText ||
      runsToPlain(authorBlock.runs || []) ||
      "";

    const timestampUsec = parseInt(renderer.timestampUsec || "0", 10);
    const timestampMs = Math.floor(timestampUsec / 1000);

    const dt = new Date(timestampMs);
    const timestr = formatDateTime(dt);

    let parts = [];
    let textPlain = "";

    if (msgType === "text") {
      parts = parseMessageParts(renderer);
      textPlain = parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");
    } else if (msgType === "paid") {
      parts = parseMessageParts(renderer);
      textPlain = parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");

      amountText = renderer.purchaseAmountText?.simpleText || "";
      amountValue = parseAmountToInt(amountText);

      superColors = {
        header_bg: toHex(renderer.headerBackgroundColor),
        header_text: toHex(renderer.headerTextColor),
        body_bg: toHex(renderer.bodyBackgroundColor),
        body_text: toHex(renderer.bodyTextColor),
      };
    } else if (msgType === "sticker") {
      parts = parseStickerParts(renderer);
      textPlain = "[STICKER]";

      amountText = renderer.purchaseAmountText?.simpleText || "";
      amountValue = parseAmountToInt(amountText);

      const bgRaw = renderer.backgroundColor;
      const textRaw =
        renderer.moneyChipTextColor || renderer.authorNameTextColor;

      superColors = {
        body_bg: toHex(bgRaw),
        body_text: toHex(textRaw),
      };
    } else if (msgType === "membership") {
      parts = parseMessageParts(renderer);

      const headerPrimary = runsToPlain(
        renderer.headerPrimaryText?.runs || []
      );
      const headerSub = runsToPlain(
        renderer.headerSubtext?.runs || []
      );
      const bodyText = parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");

      textPlain =
        [headerPrimary, headerSub, bodyText].filter(Boolean).join(" ") ||
        "[MEMBERSHIP]";
    } else if (msgType === "gift_purchase") {
      const header =
        renderer.header?.liveChatSponsorshipsHeaderRenderer || {};

      // authorName simpleText / runs 対応
      const headerAuthorBlock = header.authorName || {};
      let rawAuthor =
        headerAuthorBlock.simpleText ||
        runsToPlain(headerAuthorBlock.runs || []) ||
        "";

      let displayName = rawAuthor.replace(/^@/, "");

      if (!displayName) {
        const primaryText = runsToPlain(
          header.primaryText?.runs || []
        );
        if (primaryText) {
          displayName = primaryText.split(/\s+/)[0];
        }
      }

      if (displayName) {
        author = displayName;
      } else {
        author = author || "ギフト";
      }

      let message;
      if (displayName) {
        message = `${displayName} さんがギフトをくれました！`;
      } else {
        message = "誰かがギフトをくれました！";
      }

      parts = [{ type: "text", text: message }];
      textPlain = message;
    } else if (msgType === "gift_redeem") {
      const headerText = runsToPlain(renderer.header?.runs || []);
      const subtext = runsToPlain(renderer.subtext?.runs || []);
      textPlain =
        [headerText, subtext].filter(Boolean).join(" ") ||
        "[GIFT REDEEM]";

      const messageRuns = renderer.message?.runs || [];
      if (messageRuns.length > 0) {
        parts = parseMessageParts({ message: { runs: messageRuns } });
      } else {
        parts = [{ type: "text", text: textPlain }];
      }

      if (!author) {
        let guessed = null;
        if (headerText.includes("さん")) {
          guessed = headerText.split("さん", 1)[0];
        }
        author = guessed || "ギフト";
      }
    }

    if (!author) {
      if (["gift_purchase", "gift_redeem"].includes(msgType)) {
        author = "ギフト";
      } else if (msgType === "membership") {
        author = "メンバー";
      } else {
        author = "？？？";
      }
    }

    // アイコンURL
    const iconUrl = extractAuthorPhoto(renderer, msgType);

    // YouTube が返す一意な ID があればそれを使う。なければ従来の生成ルール。
    const rawId =
      renderer.id ||
      renderer.messageId ||
      renderer.trackingParams ||
      null;
    const msgId = String(rawId || `${timestampMs}_${author}_${textPlain}_${idx}`);

    chatItems.push({
      id: msgId,
      colors: superColors,
      author,
      icon: iconUrl,        // ★ アイコンURLを追加
      text: textPlain,
      parts,
      timestamp_ms: timestampMs,
      timestamp: timestr,
      kind: msgType,        // "text", "paid", "sticker", "membership", "gift_purchase", "gift_redeem"
      amount: amountValue,  // int or null
      amount_text: amountText,
    });
  }

  const cont0 = liveCont.continuations[0];
  const { continuation: nextCont, timeoutMs } =
    extractContinuationData(cont0);

  return { chatItems, nextCont, timeoutMs };
}

// ==============================
// start / stop 公開API
// ==============================

/**
 * 外部から呼べる "ライブチャット取得 API"
 *
 * inputStr : videoId / チャンネルID / @handle のどれでもOK
 */
async function startLiveChat(inputStr) {
  if (running) {
    console.log("startLiveChat: すでに実行中なのでスキップ");
    return;
  }

  running = true;
  stopFlag = false;

  try {
    const videoId = await resolveVideoId(inputStr);
    if (!videoId) {
      console.log("❌ 配信中の動画が見つかりません");
      return;
    }

    console.log("🎥 配信中 videoId =", videoId);

    let apiKey;
    let clientVersion;
    let cont0;
    try {
      const html = await getWatchHtml(videoId);
      const opts = extractOptionsFromHtml(html);
      apiKey = opts.apiKey;
      clientVersion = opts.clientVersion;
      cont0 = opts.continuation;
    } catch (e) {
      try {
        const liveHtml = await getLiveChatHtml(videoId);
        const opts2 = extractOptionsFromHtml(liveHtml);
        apiKey = opts2.apiKey;
        clientVersion = opts2.clientVersion;
        cont0 = opts2.continuation;
      } catch (e2) {
        console.log(
          "❌ ライブチャット初期化に失敗しました（配信中でない可能性）:",
          (e2 && e2.message) || (e && e.message) || e2 || e
        );
        return;
      }
    }

    let continuation = cont0;
    try {
      continuation = await switchToAllChatContinuation(
        apiKey,
        clientVersion,
        cont0
      );
    } catch (e) {
      console.warn(
        "⚠ Top Chat→All Chat切替に失敗（Top Chatで継続）:",
        e?.message || e
      );
      continuation = cont0;
    }

    console.log("💬 ライブチャット取得開始");

    while (!stopFlag) {
      try {
        const { chatItems, nextCont, timeoutMs } = await fetchChatOnce(
          apiKey,
          clientVersion,
          continuation
        );
        continuation = nextCont;

        for (const msg of chatItems) {
          msg.video_id = videoId;
          pushComment(msg);
        }

        await sleep(timeoutMs);
      } catch (e) {
        if (stopFlag) break;
        console.error("⚠ 取得中にエラー:", e);
        await sleep(5000);
      }
    }

    console.log("⏹ チャット取得ループ終了");
  } finally {
    running = false;
  }
}

/**
 * 停止フラグを立てるだけ（ループは自前で終わる）
 */
function stopLiveChat() {
  if (!running) return;
  console.log("⏹ stopFlag を立てます");
  stopFlag = true;
}

// ==============================
// exports
// ==============================
module.exports = {
  startLiveChat,
  stopLiveChat,
  getComments,
  resolveVideoId,
};
