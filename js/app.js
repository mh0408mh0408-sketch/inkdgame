import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js";
import {
  getDatabase, ref, set, get, update, remove, onValue, onDisconnect, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";
import { DEFAULT_WORD_POOL } from "./words.js";
import { renderSheetToCanvas, rotatePoint, rotateStamps, SHEET_SIZE, OVERHANG } from "./draw.js";

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// ============================================================
// 定数・ユーティリティ
// ============================================================
const MAX_ROUNDS = 5;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;
const DRUM_MS = 3000;
const MAX_CUSTOM_WORDS = 200;
const stampLimit = (round) => MAX_ROUNDS + 1 - round; // R1:5 … R5:1

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// Firebase は空配列を消し、配列をオブジェクトで返すことがあるため正規化する
function toArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v.filter(x => x !== undefined && x !== null) : Object.values(v);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 非同期ハンドラ用：通信エラーをユーザーに見せる
function guard(fn) {
  return async (...args) => {
    try { await fn(...args); }
    catch (e) {
      console.error(e);
      alert("通信エラーが発生しました: " + (e && e.message ? e.message : e));
    }
  };
}

// Firebase のキーに使えない文字（. $ # [ ] /）を避けるため合言葉をエンコード
function toRoomKey(pass) {
  const n = pass.normalize("NFKC").trim().toLowerCase();
  return encodeURIComponent(n).replace(/\./g, "%2E");
}

// ============================================================
// 状態
// ============================================================
// タブ単位でIDを保持（リロードで同じ席に戻れる／同一ブラウザの複数タブでテストも可能）
let myId = sessionStorage.getItem("inkd_uid");
if (!myId) {
  myId = "p_" + Math.random().toString(36).substring(2, 10);
  sessionStorage.setItem("inkd_uid", myId);
}
let myName = "";
let roomPass = "";
let roomKey = "";
let roomData = null;
let inRoom = false;
let unsubRoom = null;
let serverOffset = 0;
let revealTimer = null;

// お絵かき用ローカル状態
let activeSheetIndex = 0;
let selectedStampType = "circle";
let currentAngle = 0;
let previewPos = { x: 160, y: 110 };
let isDraggingPreview = false;
const localSheets = {}; // `${roundId}/${sheetId}` => { stamps, orientation }
let lastRoundId = null;
let advancingRoundId = null;

// 予想用ローカル状態
let pickedWord = null;
let revealAnimatedRound = null;
let recordingGameNo = null;

const serverNow = () => Date.now() + serverOffset;
const roomRef = () => ref(db, `rooms/${roomKey}`);

onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });

// 接続が復帰したらオンライン表示を復活させる
onValue(ref(db, ".info/connected"), (snap) => {
  if (snap.val() === true && inRoom && roomData?.players?.[myId]) registerPresence();
});

function presenceRef() {
  return ref(db, `rooms/${roomKey}/players/${myId}/online`);
}
function registerPresence() {
  const pr = presenceRef();
  onDisconnect(pr).set(false);
  set(pr, true);
}

const screens = {
  login: $("screen-login"),
  lobby: $("screen-lobby"),
  draw: $("screen-draw"),
  guess: $("screen-guess"),
  reveal: $("screen-reveal")
};

function showScreen(name) {
  Object.values(screens).forEach(e => e.classList.add("hidden"));
  screens[name].classList.remove("hidden");
  $("status-bar").classList.toggle("hidden", name === "login" || name === "lobby");
  // 「部屋を出る」ボタンはロビー画面のみ表示（ゲーム中の誤タップ・誤退出を防止）
  $("btn-leave").classList.toggle("hidden", name !== "lobby");
  $("room-actions").classList.toggle("hidden", name === "login");
}

// ============================================================
// プレイヤー関連
// ============================================================
function lobbyIds() {
  const players = roomData?.players || {};
  return Object.keys(players).sort((a, b) => (players[a].joinedAt || 0) - (players[b].joinedAt || 0));
}

// ゲーム中は開始時に固定した order を使う（途中の増減に影響されない）
function gameIds() {
  const players = roomData?.players || {};
  const order = toArray(roomData?.order).filter(id => players[id]);
  return order.length ? order : lobbyIds();
}

function hasOnlinePlayers(data) {
  return Object.values(data?.players || {}).some(p => p.online);
}

function nameOf(id) {
  return roomData?.players?.[id]?.name || "（退出済み）";
}

// ============================================================
// 部屋の作成・参加・退出
// ============================================================
async function enterRoom(isCreate, auto = false) {
  const errEl = $("login-error");
  errEl.textContent = "";
  const nameInput = $("input-name").value.trim();
  const passInput = $("input-pass").value.trim();

  if (!nameInput || !passInput) {
    errEl.textContent = "名前と合言葉の両方を入力してください。";
    return;
  }
  const key = toRoomKey(passInput);
  if (!key) {
    errEl.textContent = "合言葉が正しくありません。";
    return;
  }

  setLoginBusy(true);
  try {
    myName = nameInput;
    roomPass = passInput;
    roomKey = key;
    const snap = await get(roomRef());
    const existing = snap.exists() ? snap.val() : null;

    if (isCreate) {
      if (existing && hasOnlinePlayers(existing) && !existing.players?.[myId]) {
        errEl.textContent = "その合言葉は使用中です。入るには「合言葉で部屋に入る」を押してください。";
        return;
      }
      await set(roomRef(), {
        hostId: myId,
        status: "lobby",
        round: 1,
        mistakes: 0,
        roundMistakes: 0,
        captainIndex: 0,
        gameNo: 0,
        useDummy: true,
        wordMode: "mix",
        customWords: [],
        usedWords: [],
        series: { games: 0, wins: 0, losses: 0, log: "" },
        players: {
          [myId]: { name: myName, joinedAt: serverTimestamp(), online: true }
        }
      });
    } else {
      if (!existing) {
        errEl.textContent = auto
          ? "前回の部屋が見つかりませんでした。もう一度入力してください。"
          : "その合言葉の部屋は見つかりません。";
        return;
      }
      const players = existing.players || {};
      const sameNameId = Object.keys(players).find(id => id !== myId && players[id].name === myName);

      if (players[myId]) {
        // 同じ席に再入室（リロード等）
      } else if (sameNameId) {
        if (players[sameNameId].online) {
          errEl.textContent = "その名前は既に使われています。別の名前にしてください。";
          return;
        }
        // 切断中の同名プレイヤーの席を引き継ぐ（リロード・端末変更からの復帰）
        myId = sameNameId;
        sessionStorage.setItem("inkd_uid", myId);
      } else {
        if (existing.status !== "lobby") {
          errEl.textContent = "現在ゲーム進行中のため参加できません。（途中退席した人は同じ名前なら戻れます）";
          return;
        }
        if (Object.keys(players).length >= MAX_PLAYERS) {
          errEl.textContent = `この部屋は満員です（最大${MAX_PLAYERS}人）。`;
          return;
        }
      }

      const already = existing.players?.[myId];
      const patch = { online: true };
      if (!already) {
        patch.name = myName;
        patch.joinedAt = serverTimestamp();
      }
      await update(ref(db, `rooms/${roomKey}/players/${myId}`), patch);
      myName = already ? already.name : myName;
    }

    onDisconnect(presenceRef()).set(false);
    localStorage.setItem("inkd_name", myName);
    sessionStorage.setItem("inkd_session", JSON.stringify({ name: myName, pass: roomPass }));
    subscribeRoom();
  } catch (e) {
    console.error(e);
    errEl.textContent = "接続に失敗しました: " + (e && e.message ? e.message : e);
  } finally {
    setLoginBusy(false);
  }
}

function setLoginBusy(b) {
  $("btn-create").disabled = b;
  $("btn-join").disabled = b;
}

function subscribeRoom() {
  if (unsubRoom) unsubRoom();
  inRoom = true;
  roomData = null;
  unsubRoom = onValue(roomRef(), (snap) => {
    if (!snap.exists()) {
      if (inRoom && roomData) leaveRoom("部屋が閉じられました。", false);
      return;
    }
    roomData = snap.val();
    updateUI();
  });
}

async function leaveRoom(message = "", touchDb = true) {
  const data = roomData;
  const wasInRoom = inRoom;
  inRoom = false;
  if (unsubRoom) { unsubRoom(); unsubRoom = null; }
  clearTimeout(revealTimer);

  if (touchDb && wasInRoom && data?.players?.[myId]) {
    try {
      onDisconnect(presenceRef()).cancel();
      if (data.status === "lobby") {
        const players = data.players;
        const others = Object.keys(players).filter(id => id !== myId);
        const onlineOthers = others.filter(id => players[id].online);
        if (onlineOthers.length === 0) {
          await remove(ref(db, `rooms/${roomKey}`)); // 最後の1人が抜けたら部屋を片付ける
        } else {
          const upd = { [`players/${myId}`]: null };
          if (data.hostId === myId) {
            const sorted = onlineOthers.sort((a, b) => (players[a].joinedAt || 0) - (players[b].joinedAt || 0));
            upd.hostId = sorted[0];
          }
          await update(roomRef(), upd);
        }
      } else {
        // ゲーム中は席を残したまま離席（同じ名前で戻れる）
        await set(presenceRef(), false);
      }
    } catch (e) { console.error(e); }
  }

  roomData = null;
  roomKey = "";
  sessionStorage.removeItem("inkd_session");
  showScreen("login");
  $("login-error").textContent = message;
}

// ホストが切断中なら、オンラインの最古参プレイヤーが自動でホストを引き継ぐ
function maybeMigrateHost() {
  const players = roomData.players || {};
  const host = players[roomData.hostId];
  if (host && host.online) return;
  const candidate = lobbyIds().find(id => players[id].online);
  if (candidate === myId) {
    update(roomRef(), { hostId: myId }).catch(console.error);
  }
}

// ============================================================
// ロビー：カスタムお題・設定
// ============================================================
async function addCustomWords() {
  const inputEl = $("input-custom-word");
  const raw = inputEl.value.trim();
  if (!raw || !roomData) return;
  const newWords = raw.split(/[、,，\s]+/).map(w => w.trim()).filter(w => w.length > 0 && w.length <= 20);
  if (newWords.length === 0) return;
  const existing = toArray(roomData.customWords);
  const merged = Array.from(new Set([...existing, ...newWords])).slice(0, MAX_CUSTOM_WORDS);
  inputEl.value = "";
  await update(roomRef(), { customWords: merged });
}

async function removeCustomWord(word) {
  if (!roomData) return;
  const filtered = toArray(roomData.customWords).filter(w => w !== word);
  await update(roomRef(), { customWords: filtered });
}

$("btn-add-word").addEventListener("click", guard(addCustomWords));
$("input-custom-word").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    $("btn-add-word").click();
  }
});

$("sel-word-mode").addEventListener("change", guard(async (e) => {
  await update(roomRef(), { wordMode: e.target.value });
}));
$("chk-dummy").addEventListener("change", guard(async (e) => {
  await update(roomRef(), { useDummy: e.target.checked });
}));

$("btn-copy-link").addEventListener("click", async () => {
  const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(roomPass)}`;
  try {
    await navigator.clipboard.writeText(url);
    alert("招待リンクをコピーしました！\n" + url);
  } catch {
    prompt("招待リンク（コピーしてください）", url);
  }
});

$("btn-reset-series").addEventListener("click", guard(async () => {
  if (!confirm("連戦成績をリセットします。よろしいですか？")) return;
  await update(roomRef(), {
    series: { games: 0, wins: 0, losses: 0, log: "" },
    usedWords: []
  });
}));

$("btn-leave").addEventListener("click", guard(async () => {
  const inGame = roomData && roomData.status !== "lobby";
  const msg = inGame
    ? "部屋から離れます。（ゲーム中の席は残るので、同じ名前で入り直せば戻れます）"
    : "部屋から退出します。よろしいですか？";
  if (!confirm(msg)) return;
  await leaveRoom("");
}));

$("btn-abort").addEventListener("click", guard(async () => {
  if (!confirm("ゲームを中断してロビーに戻ります。（連戦成績には記録されません）")) return;
  await backToLobby();
}));

async function backToLobby() {
  await update(roomRef(), {
    status: "lobby", round: 1, mistakes: 0, roundMistakes: 0, captainIndex: 0,
    gameResult: null, sheets: null, sheetOrder: null, choices: null,
    order: null, revealAt: null, roundId: null
  });
}

// ============================================================
// ゲーム開始・ラウンド進行
// ============================================================
function pickWords(count, mode, used) {
  const custom = toArray(roomData.customWords);
  let usedSet = new Set(used);
  let cAvail, dAvail;
  const build = () => {
    cAvail = shuffle(custom.filter(w => !usedSet.has(w)));
    dAvail = shuffle(DEFAULT_WORD_POOL.filter(w => !usedSet.has(w) && !custom.includes(w)));
  };
  build();
  // お題が枯渇したら出題履歴をリセット（連戦で長く遊んでも重複しない）
  if (cAvail.length + dAvail.length < count) {
    usedSet = new Set();
    build();
  }

  let pool;
  if (mode === "default") {
    pool = [...dAvail, ...cAvail];
  } else if (mode === "custom") {
    pool = [...cAvail, ...dAvail];
  } else { // mix：カスタムと標準を半々で
    const halfC = cAvail.slice(0, Math.ceil(count / 2));
    pool = [...halfC, ...dAvail, ...cAvail.slice(halfC.length)];
  }
  const words = shuffle(pool.slice(0, count));
  return { words, used: [...usedSet, ...words] };
}

async function startRound({ round, captainIndex, mistakes, order, usedWords, extra = {} }) {
  const n = order.length;
  const capIdx = captainIndex % n;
  const captainId = order[capIdx];
  const painters = order.filter(id => id !== captainId);

  let assignments;
  if (n === 2) assignments = [painters[0], painters[0]];                 // 画家1人がキャンバス2枚
  else if (n === 3) assignments = [painters[0], painters[1], painters[0]]; // 画家2人で計3枚
  else assignments = [...painters];

  const dummyCount = roomData.useDummy === false ? 0 : 2;
  const { words, used } = pickWords(assignments.length + dummyCount, roomData.wordMode || "mix", usedWords);

  const sheets = {};
  assignments.forEach((pid, idx) => {
    sheets[`sheet_${idx}`] = {
      ownerId: pid,
      ownerName: roomData.players[pid].name,
      word: words[idx],
      orientation: "landscape",
      stamps: [],
      submitted: false,
      guess: ""
    };
  });
  const sheetKeys = Object.keys(sheets);

  await update(roomRef(), {
    ...extra,
    status: "drawing",
    round,
    captainIndex: capIdx,
    mistakes,
    roundMistakes: 0,
    gameResult: null,
    revealAt: null,
    roundId: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    sheets,
    sheetOrder: shuffle(sheetKeys), // 表示順をシャッフル（誰の絵かを推測されないように）
    choices: shuffle(words),
    usedWords: used
  });
}

// ロビーからの開始・「もう1戦」共通
async function startGame() {
  if (!roomData || roomData.hostId !== myId) return;
  await recordSeriesIfNeeded();

  const players = roomData.players || {};
  const ids = lobbyIds();
  const online = ids.filter(id => players[id].online);
  if (online.length < MIN_PLAYERS) {
    alert("2人以上（オンライン）揃ってから開始してください！");
    return;
  }
  if (online.length > MAX_PLAYERS) {
    alert(`最大${MAX_PLAYERS}人までです。`);
    return;
  }
  const extra = { gameNo: (roomData.gameNo || 0) + 1, order: online };
  ids.filter(id => !players[id].online).forEach(id => { extra[`players/${id}`] = null; }); // 切断中の人は外す
  await startRound({
    round: 1,
    captainIndex: (extra.gameNo - 1) % online.length, // 連戦ごとに最初のキャプテンをずらす
    mistakes: 0,
    order: online,
    usedWords: toArray(roomData.usedWords),
    extra
  });
}

$("btn-start").addEventListener("click", guard(startGame));

// 連戦成績の記録（結果発表の演出が終わってから、ホストが1回だけ行う）
async function recordSeriesIfNeeded() {
  const d = roomData;
  if (!d || !d.gameResult) return;
  if (d.recordedGameNo === d.gameNo || recordingGameNo === d.gameNo) return;
  recordingGameNo = d.gameNo;
  const s = d.series || { games: 0, wins: 0, losses: 0, log: "" };
  const win = d.gameResult === "win";
  try {
    await update(roomRef(), {
      series: {
        games: (s.games || 0) + 1,
        wins: (s.wins || 0) + (win ? 1 : 0),
        losses: (s.losses || 0) + (win ? 0 : 1),
        log: (s.log || "") + (win ? "○" : "×")
      },
      recordedGameNo: d.gameNo
    });
  } catch (e) {
    recordingGameNo = null;
    throw e;
  }
}

function seriesSummary(s) {
  const x = s || {};
  return `${x.games || 0}戦 ${x.wins || 0}勝 ${x.losses || 0}敗`;
}

function currentStreak(log) {
  let k = 0;
  for (let i = (log || "").length - 1; i >= 0 && log[i] === "○"; i--) k++;
  return k;
}

// ============================================================
// UI 更新（メイン）
// ============================================================
function updateUI() {
  if (!roomData || !inRoom) return;

  if (!roomData.players?.[myId]) {
    leaveRoom("部屋から外されました。", false);
    return;
  }
  maybeMigrateHost();

  const isHost = roomData.hostId === myId;
  const status = roomData.status;
  const ids = status === "lobby" ? lobbyIds() : gameIds();
  const n = ids.length;

  // ステータスバー（結果発表の演出前は、今ラウンドのミスを伏せる）
  const revealPending = status === "reveal" && serverNow() < (roomData.revealAt || 0);
  const shownMistakes = (roomData.mistakes || 0) - (revealPending ? (roomData.roundMistakes || 0) : 0);
  $("st-room").textContent = roomPass;
  $("st-round").textContent = roomData.round;
  $("st-limit").textContent = stampLimit(roomData.round);
  $("st-mistakes").textContent = shownMistakes;
  $("st-max-mistakes").textContent = n;
  $("st-series").textContent = seriesSummary(roomData.series);

  // ゲーム中の切断警告とホストの中断ボタン
  $("btn-abort").classList.toggle("hidden", !(isHost && status !== "lobby"));
  const offlineNames = status === "lobby" ? [] :
    ids.filter(id => !roomData.players[id].online).map(nameOf);
  const warnEl = $("offline-warning");
  if (offlineNames.length) {
    warnEl.textContent = `⚠ 切断中: ${offlineNames.join("、")}（戻るのを待つか、ホストが中断できます）`;
  }
  warnEl.classList.toggle("hidden", offlineNames.length === 0);

  if (status === "lobby") { renderLobby(ids, isHost); return; }

  const captainId = ids[roomData.captainIndex % n];
  const isCaptain = captainId === myId;

  if (status === "drawing") renderDraw(ids, isCaptain, isHost);
  else if (status === "guessing") renderGuess(captainId, isCaptain);
  else if (status === "reveal") renderReveal(ids, isHost);
}

// ---------------- ロビー ----------------
function renderLobby(ids, isHost) {
  showScreen("lobby");
  $("lobby-pass").textContent = roomPass;

  const box = $("lobby-players");
  box.innerHTML = "";
  box.appendChild(el("div", "", `参加中 (${ids.length}/${MAX_PLAYERS}人):`)).style.marginBottom = "6px";
  ids.forEach(id => {
    const p = roomData.players[id];
    const chip = el("span", "player-chip" + (p.online ? "" : " offline"));
    chip.appendChild(el("span", "", p.name + (id === roomData.hostId ? " 👑ホスト" : "") + (id === myId ? "（あなた）" : "") + (p.online ? "" : " 💤")));
    if (isHost && id !== myId) {
      const kick = el("button", "", "✕");
      kick.title = "この人を外す";
      kick.addEventListener("click", guard(async () => {
        if (confirm(`${p.name} さんを部屋から外しますか？`)) {
          await update(roomRef(), { [`players/${id}`]: null });
        }
      }));
      chip.appendChild(kick);
    }
    box.appendChild(chip);
  });

  // 連戦成績
  const s = roomData.series || {};
  const hasSeries = (s.games || 0) > 0;
  $("series-box").classList.toggle("hidden", !hasSeries);
  if (hasSeries) {
    const streak = currentStreak(s.log);
    $("series-text").textContent = `通算 ${seriesSummary(s)}` + (streak >= 2 ? `（現在 ${streak} 連勝中🔥）` : "");
    $("series-log").textContent = s.log || "";
  }
  $("btn-reset-series").classList.toggle("hidden", !(isHost && hasSeries));

  // カスタムお題
  const cWords = toArray(roomData.customWords);
  $("custom-word-count").textContent = cWords.length;
  const cwListEl = $("custom-word-list");
  cwListEl.innerHTML = "";
  if (cWords.length === 0) {
    const none = el("span", "", "まだ追加されていません（標準のお題100語が使われます）");
    none.style.cssText = "color:#94a3b8; font-size:0.85rem;";
    cwListEl.appendChild(none);
  } else {
    cWords.forEach(w => {
      const chip = el("span", "custom-chip");
      chip.appendChild(el("span", "", w));
      const del = el("button", "", "✕");
      del.title = "削除";
      del.addEventListener("click", guard(() => removeCustomWord(w)));
      chip.appendChild(del);
      cwListEl.appendChild(chip);
    });
  }

  // 設定（ホストのみ操作可。ゲストには現在の設定を表示）
  const modeLabels = {
    mix: "カスタムと標準を半々でミックス",
    custom: "カスタム優先",
    default: "標準お題のみ"
  };
  const mode = roomData.wordMode || "mix";
  const useDummy = roomData.useDummy !== false;
  $("host-controls").classList.toggle("hidden", !isHost);
  $("sel-word-mode").value = mode;
  $("chk-dummy").checked = useDummy;
  $("btn-start").textContent = hasSeries ? "次の1戦を始める！" : "ゲーム開始！";
  const onlineCount = ids.filter(id => roomData.players[id].online).length;
  $("btn-start").disabled = onlineCount < MIN_PLAYERS;
  const guestEl = $("guest-settings");
  guestEl.classList.toggle("hidden", isHost);
  guestEl.textContent = `設定：${modeLabels[mode]} ／ はみ出し者ルール ${useDummy ? "ON" : "OFF"}（ホストが開始するのを待っています）`;
}

// ---------------- お絵かき ----------------
const drawCanvas = $("draw-canvas");

function draftKey(roundSheetKey) { return `inkd_draft:${roomKey}:${roundSheetKey}`; }

function saveDraft(rsKey) {
  try { sessionStorage.setItem(draftKey(rsKey), JSON.stringify(localSheets[rsKey])); } catch { /* 容量超過などは無視 */ }
}

// 現在操作中のシートと、その作業用状態を返す
function currentSheetCtx() {
  if (!roomData || roomData.status !== "drawing") return null;
  const sheets = roomData.sheets || {};
  const mine = Object.keys(sheets).filter(k => sheets[k].ownerId === myId);
  const sheetId = mine[activeSheetIndex];
  if (!sheetId) return null;
  const sheet = sheets[sheetId];
  const rsKey = `${roomData.roundId}/${sheetId}`;

  if (sheet.submitted) {
    return { sheetId, sheet, rsKey, submitted: true, mine,
      state: { stamps: toArray(sheet.stamps), orientation: sheet.orientation || "landscape" } };
  }
  if (!localSheets[rsKey]) {
    let restored = null;
    try { restored = JSON.parse(sessionStorage.getItem(draftKey(rsKey))); } catch { /* ignore */ }
    localSheets[rsKey] = restored && Array.isArray(restored.stamps)
      ? restored
      : { stamps: toArray(sheet.stamps), orientation: sheet.orientation || "landscape" };
  }
  return { sheetId, sheet, rsKey, submitted: false, mine, state: localSheets[rsKey] };
}

function clampPreview(p, orient) {
  const { w, h } = SHEET_SIZE[orient];
  return {
    x: Math.max(-OVERHANG, Math.min(w + OVERHANG, p.x)),
    y: Math.max(-OVERHANG, Math.min(h + OVERHANG, p.y))
  };
}

function centerOf(orient) {
  const { w, h } = SHEET_SIZE[orient];
  return { x: w / 2, y: h / 2 };
}

function renderDraw(ids, isCaptain, isHost) {
  showScreen("draw");
  const sheets = roomData.sheets || {};
  const sheetKeys = Object.keys(sheets);

  if (roomData.roundId !== lastRoundId) {
    lastRoundId = roomData.roundId;
    activeSheetIndex = 0;
    pickedWord = null;
    previewPos = { x: 160, y: 110 };
  }

  // 全員提出済みで予想フェーズへ（ホストが進行）
  const allSubmitted = sheetKeys.length > 0 && sheetKeys.every(k => sheets[k].submitted);
  if (allSubmitted && isHost && advancingRoundId !== roomData.roundId) {
    advancingRoundId = roomData.roundId;
    update(roomRef(), { status: "guessing" }).catch(e => { advancingRoundId = null; console.error(e); });
  }

  $("captain-wait-view").classList.toggle("hidden", !isCaptain);
  $("painter-draw-view").classList.toggle("hidden", isCaptain);

  // 画家ごとの提出状況（シート番号とは紐付けない）
  const owners = ids.filter(id => sheetKeys.some(k => sheets[k].ownerId === id));
  const progressRows = owners.map(id => {
    const mineKeys = sheetKeys.filter(k => sheets[k].ownerId === id);
    const done = mineKeys.filter(k => sheets[k].submitted).length;
    return { name: nameOf(id), total: mineKeys.length, done };
  });

  if (isCaptain) {
    const list = $("draw-progress-list");
    list.innerHTML = "";
    progressRows.forEach(r => {
      const row = el("div", "", `${r.name}${r.total > 1 ? `（${r.done}/${r.total}枚）` : ""}`);
      row.style.cssText = "margin: 8px 0; font-size: 1.1rem;";
      const finished = r.done === r.total;
      row.appendChild(el("span", "badge " + (finished ? "badge-done" : "badge-wait"), finished ? "提出完了！" : "描画中..."));
      list.appendChild(row);
    });
    return;
  }

  // ---- 画家画面 ----
  const ctxInfo = currentSheetCtx();
  if (!ctxInfo) return;
  const { sheet, state, submitted, mine } = ctxInfo;

  const tabsEl = $("sheet-tabs");
  tabsEl.innerHTML = "";
  if (mine.length > 1) {
    mine.forEach((sid, idx) => {
      const done = roomData.sheets[sid].submitted ? " ✓" : "";
      const b = el("button", "", `担当シート ${idx + 1}${done}`);
      b.style.background = idx === activeSheetIndex ? "var(--accent)" : "#64748b";
      b.addEventListener("click", () => { activeSheetIndex = idx; previewPos = centerOf(state.orientation); updateUI(); });
      tabsEl.appendChild(b);
    });
  }

  const prog = $("painter-progress");
  prog.innerHTML = "";
  progressRows.forEach(r => {
    const finished = r.done === r.total;
    const s = el("span", "", r.name);
    s.appendChild(el("span", "badge " + (finished ? "badge-done" : "badge-wait"), finished ? "提出済" : "作成中"));
    s.style.marginRight = "8px";
    prog.appendChild(s);
  });

  $("my-word").textContent = sheet.word;
  const limit = stampLimit(roomData.round);
  const remaining = Math.max(0, limit - state.stamps.length);
  $("remaining-stamps").textContent = remaining;

  const commitBtn = $("btn-stamp-commit");
  commitBtn.disabled = submitted || remaining <= 0;
  commitBtn.textContent = submitted
    ? "提出済みです"
    : remaining <= 0
      ? "上限回数に達しました（「1つ戻す」でやり直せます）"
      : `📌 ここにスタンプを押す！（残り ${remaining} 回）`;

  ["btn-rotate-sheet", "btn-undo", "btn-clear"].forEach(id => { $(id).disabled = submitted; });
  const submitBtn = $("btn-submit-sheet");
  submitBtn.disabled = submitted;
  submitBtn.textContent = submitted ? "提出済み（他の人を待っています）" : "✅ 完成！このシートを提出する";

  redrawActiveCanvas();
}

function redrawActiveCanvas() {
  const c = currentSheetCtx();
  if (!c) return;
  const { state, submitted } = c;
  const canStamp = !submitted && state.stamps.length < stampLimit(roomData.round);
  const ghost = canStamp
    ? { type: selectedStampType, x: previewPos.x, y: previewPos.y, angle: currentAngle }
    : null;
  renderSheetToCanvas(drawCanvas, state, ghost);
}

// スタンプ種類
document.querySelectorAll(".stamp-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".stamp-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    selectedStampType = btn.dataset.type;
    redrawActiveCanvas();
  });
});

// 回転
const angleSlider = $("angle-slider");
const angleVal = $("angle-val");

function setAngle(a) {
  currentAngle = ((Math.round(a) % 360) + 360) % 360;
  angleSlider.value = currentAngle;
  angleVal.textContent = currentAngle;
  redrawActiveCanvas();
}
angleSlider.addEventListener("input", (e) => setAngle(parseInt(e.target.value, 10)));
document.querySelectorAll(".btn-angle-step").forEach(btn => {
  btn.addEventListener("click", () => setAngle(currentAngle + parseInt(btn.dataset.da, 10)));
});
drawCanvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  setAngle(currentAngle + (e.deltaY > 0 ? 5 : -5));
}, { passive: false });

// 十字キー
document.querySelectorAll(".dpad-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const c = currentSheetCtx();
    if (!c) return;
    const stepRadio = document.querySelector('input[name="step-size"]:checked');
    const step = stepRadio ? parseInt(stepRadio.value, 10) : 8;
    previewPos = clampPreview({
      x: previewPos.x + parseInt(btn.dataset.dx, 10) * step,
      y: previewPos.y + parseInt(btn.dataset.dy, 10) * step
    }, c.state.orientation);
    redrawActiveCanvas();
  });
});

// キャンバス上のタップ・ドラッグで仮置き位置を移動
function getCanvasCoords(e) {
  const rect = drawCanvas.getBoundingClientRect();
  return {
    x: Math.round((e.clientX - rect.left) * (drawCanvas.width / rect.width)),
    y: Math.round((e.clientY - rect.top) * (drawCanvas.height / rect.height))
  };
}

function movePreviewTo(e) {
  const c = currentSheetCtx();
  if (!c) return;
  previewPos = clampPreview(getCanvasCoords(e), c.state.orientation);
  redrawActiveCanvas();
}

drawCanvas.addEventListener("pointerdown", (e) => {
  isDraggingPreview = true;
  try { drawCanvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  movePreviewTo(e);
});
drawCanvas.addEventListener("pointermove", (e) => {
  if (isDraggingPreview || e.pointerType === "mouse") movePreviewTo(e);
});
window.addEventListener("pointerup", () => { isDraggingPreview = false; });
window.addEventListener("pointercancel", () => { isDraggingPreview = false; });

// スタンプ確定
function commitStamp() {
  const c = currentSheetCtx();
  if (!c || c.submitted) return;
  if (c.state.stamps.length >= stampLimit(roomData.round)) return;
  c.state.stamps.push({
    type: selectedStampType,
    x: Math.round(previewPos.x),
    y: Math.round(previewPos.y),
    angle: currentAngle
  });
  saveDraft(c.rsKey);
  updateUI();
}
$("btn-stamp-commit").addEventListener("click", commitStamp);
drawCanvas.addEventListener("dblclick", commitStamp);

// シート縦横切替（紙ごと90度回転。描いた内容も一緒に回る）
$("btn-rotate-sheet").addEventListener("click", () => {
  const c = currentSheetCtx();
  if (!c || c.submitted) return;
  const from = c.state.orientation;
  c.state.stamps = rotateStamps(c.state.stamps, from);
  previewPos = clampPreview(rotatePoint(previewPos, from), from === "landscape" ? "portrait" : "landscape");
  c.state.orientation = from === "landscape" ? "portrait" : "landscape";
  saveDraft(c.rsKey);
  updateUI();
});

$("btn-undo").addEventListener("click", () => {
  const c = currentSheetCtx();
  if (!c || c.submitted) return;
  c.state.stamps.pop();
  saveDraft(c.rsKey);
  updateUI();
});

$("btn-clear").addEventListener("click", () => {
  const c = currentSheetCtx();
  if (!c || c.submitted) return;
  if (c.state.stamps.length === 0) return;
  c.state.stamps = [];
  saveDraft(c.rsKey);
  updateUI();
});

$("btn-submit-sheet").addEventListener("click", guard(async () => {
  const c = currentSheetCtx();
  if (!c || c.submitted) return;
  if (c.state.stamps.length === 0) {
    alert("スタンプを1つ以上押してから提出してください。");
    return;
  }
  await update(ref(db, `rooms/${roomKey}/sheets/${c.sheetId}`), {
    orientation: c.state.orientation,
    stamps: c.state.stamps,
    submitted: true
  });
  // 担当シートがまだ残っていれば次のシートへ
  const next = c.mine.findIndex(sid => !roomData.sheets[sid]?.submitted && sid !== c.sheetId);
  if (next >= 0) {
    activeSheetIndex = next;
    previewPos = centerOf("landscape");
    updateUI();
  }
}));

// ---------------- 予想 ----------------
async function assignGuess(sheetKey, word) {
  const sheets = roomData.sheets || {};
  const upd = {};
  Object.keys(sheets).forEach(k => {
    if (k !== sheetKey && sheets[k].guess === word && word) upd[`${k}/guess`] = ""; // 同じカードは1枚のみ
  });
  upd[`${sheetKey}/guess`] = word;
  await update(ref(db, `rooms/${roomKey}/sheets`), upd);
}

function renderGuess(captainId, isCaptain) {
  showScreen("guess");
  const sheets = roomData.sheets || {};
  const order = toArray(roomData.sheetOrder).filter(k => sheets[k]);
  const choices = toArray(roomData.choices);
  const assigned = new Set(order.map(k => sheets[k].guess).filter(Boolean));

  $("guess-title").textContent = isCaptain
    ? "👑 あなたはキャプテンです！各シートのお題を推理して割り当ててください"
    : `🔍 キャプテン（${nameOf(captainId)}）が推理中です...（ヒント出しは禁止！）`;

  // お題カード（キャプテンはドラッグ＆ドロップ、またはタップで選んでからシートをタップ）
  const pool = $("guess-word-pool");
  pool.innerHTML = "";
  choices.forEach(w => {
    const chip = el("span", "word-chip", w);
    if (assigned.has(w)) chip.classList.add("assigned");
    if (isCaptain) {
      chip.classList.add("pickable");
      if (pickedWord === w) chip.classList.add("picked");
      chip.draggable = true;
      chip.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", w);
        e.dataTransfer.effectAllowed = "move";
      });
      chip.addEventListener("click", () => {
        pickedWord = pickedWord === w ? null : w;
        updateUI();
      });
    }
    pool.appendChild(chip);
  });
  if (isCaptain) {
    pool.appendChild(el("div", "note", "※ カードをシートへドラッグ、またはカードをタップ→シートをタップで割り当て（下のプルダウンでも選べます）")).style.width = "100%";
  }

  const gallery = $("guess-gallery");
  gallery.innerHTML = "";
  order.forEach((k, idx) => {
    const s = sheets[k];
    const card = el("div", "sheet-card");
    const title = el("div", "", `シート #${idx + 1}`);
    title.style.cssText = "font-weight:bold; margin-bottom:6px;";
    card.appendChild(title);

    const c = document.createElement("canvas");
    renderSheetToCanvas(c, { orientation: s.orientation, stamps: toArray(s.stamps) });
    card.appendChild(c);

    if (isCaptain) {
      const sel = el("select", "guess-select");
      sel.appendChild(new Option("-- お題を選択 --", ""));
      choices.forEach(w => {
        const usedElsewhere = assigned.has(w) && s.guess !== w;
        const opt = new Option(usedElsewhere ? `${w}（割当済）` : w, w);
        opt.disabled = usedElsewhere;
        sel.appendChild(opt);
      });
      sel.value = s.guess || "";
      sel.addEventListener("change", guard((e) => assignGuess(k, e.target.value)));
      card.appendChild(sel);

      card.addEventListener("click", guard(async (e) => {
        if (e.target.tagName === "SELECT" || e.target.tagName === "OPTION") return;
        if (pickedWord) {
          const w = pickedWord;
          pickedWord = null;
          await assignGuess(k, w);
        }
      }));
      card.addEventListener("dragover", (e) => { e.preventDefault(); card.classList.add("drop-over"); });
      card.addEventListener("dragleave", () => card.classList.remove("drop-over"));
      card.addEventListener("drop", guard(async (e) => {
        e.preventDefault();
        card.classList.remove("drop-over");
        const w = e.dataTransfer.getData("text/plain");
        if (w && choices.includes(w)) await assignGuess(k, w);
      }));
    } else {
      const label = el("div", "", `キャプテンの仮置き: ${s.guess || "（思案中...）"}`);
      label.style.cssText = "margin-top:6px; font-weight:bold;";
      card.appendChild(label);
    }
    gallery.appendChild(card);
  });

  $("captain-submit-area").classList.toggle("hidden", !isCaptain);
  if (isCaptain) {
    const remaining = order.filter(k => !sheets[k].guess).length;
    $("guess-remaining").textContent = remaining > 0 ? `あと ${remaining} 枚のシートにお題を割り当ててください` : "すべて割り当て済みです。確定できます！";
    $("btn-confirm-guesses").disabled = remaining > 0;
  }
}

$("btn-confirm-guesses").addEventListener("click", guard(async () => {
  if (!roomData || roomData.status !== "guessing") return;
  const sheets = roomData.sheets || {};
  const keys = Object.keys(sheets);
  if (keys.some(k => !sheets[k].guess)) {
    alert("すべてのシートにお題を割り当ててください！");
    return;
  }
  const added = keys.filter(k => sheets[k].guess !== sheets[k].word).length;
  const total = (roomData.mistakes || 0) + added;
  const n = gameIds().length;
  let gameResult = null;
  if (total > n) gameResult = "lose";
  else if (roomData.round >= MAX_ROUNDS) gameResult = "win";

  await update(roomRef(), {
    status: "reveal",
    mistakes: total,
    roundMistakes: added,
    gameResult,
    revealAt: serverNow() + DRUM_MS
  });
}));

// ---------------- 答え合わせ ----------------
function renderReveal(ids, isHost) {
  showScreen("reveal");
  const headerEl = $("reveal-header");
  const contentEl = $("reveal-content");
  const revealAt = roomData.revealAt || 0;
  const now = serverNow();

  clearTimeout(revealTimer);
  if (now < revealAt) {
    // ドラムロール演出（全員で同時に結果を開示するためサーバー時刻基準）
    headerEl.innerHTML = '<span class="drum">🥁</span> ドラムロール……（まもなく結果発表！）';
    contentEl.classList.add("hidden");
    revealTimer = setTimeout(updateUI, revealAt - now + 30);
    return;
  }

  headerEl.textContent = `🎉 ラウンド ${roomData.round} 結果発表！`;
  contentEl.classList.remove("hidden");
  const animate = revealAnimatedRound !== roomData.roundId;
  revealAnimatedRound = roomData.roundId;

  const sheets = roomData.sheets || {};
  const order = toArray(roomData.sheetOrder).filter(k => sheets[k]);
  const gallery = $("reveal-gallery");
  gallery.innerHTML = "";
  order.forEach((k, idx) => {
    const s = sheets[k];
    const ok = s.guess === s.word;
    const card = el("div", "sheet-card " + (ok ? "correct" : "wrong"));
    if (animate) {
      card.classList.add("reveal-pop");
      card.style.animationDelay = `${idx * 0.25}s`;
      card.style.animationFillMode = "backwards";
    }
    const t = el("div", "", `シート #${idx + 1}（画家: ${s.ownerName}）`);
    t.style.cssText = "font-weight:bold; margin-bottom:4px;";
    card.appendChild(t);

    const c = document.createElement("canvas");
    renderSheetToCanvas(c, { orientation: s.orientation, stamps: toArray(s.stamps) });
    card.appendChild(c);

    const info = el("div");
    const l1 = el("div", "", "キャプテン予想: ");
    l1.appendChild(el("strong", "", s.guess || "未選択"));
    const l2 = el("div", "", "正解のお題: ");
    const ans = el("strong", "", s.word);
    ans.style.color = "var(--accent)";
    l2.appendChild(ans);
    info.append(l1, l2, el("div", ok ? "result-ok" : "result-ng", ok ? "⭕ 正解！" : "❌ ミス！ (+1)"));
    card.appendChild(info);
    gallery.appendChild(card);
  });

  const total = roomData.mistakes || 0;
  const maxAllowed = ids.length;
  const result = roomData.gameResult;
  const summaryEl = $("reveal-summary");
  const nextArea = $("next-action-area");
  nextArea.innerHTML = "";
  const addBtn = (label, cls, handler) => {
    const b = el("button", cls, label);
    b.addEventListener("click", guard(handler));
    nextArea.appendChild(b);
  };

  if (result === "lose") {
    summaryEl.innerHTML = "";
    summaryEl.appendChild(el("span", "", `💥 ゲームオーバー！ 累計ミスが ${total} 回となり、許容上限（${maxAllowed}回）を超えました。`)).style.color = "#dc2626";
  } else if (result === "win") {
    summaryEl.innerHTML = "";
    summaryEl.appendChild(el("span", "", `🏆 完全勝利！ 全${MAX_ROUNDS}ラウンドを累計ミス ${total} 回で突破しました！おめでとうございます！`)).style.color = "#16a34a";
  } else {
    summaryEl.textContent = `このラウンドのミス: ${roomData.roundMistakes || 0} ／ 現在の累計ミス: ${total} / ${maxAllowed} 回（セーフ！）`;
  }

  if (result) {
    if (isHost) recordSeriesIfNeeded().catch(console.error); // 連戦成績に記録（1回だけ）
    const s = roomData.series || {};
    const recorded = roomData.recordedGameNo === roomData.gameNo;
    const note = el("p", "note", recorded ? `連戦成績: ${seriesSummary(s)}　${s.log || ""}` : "成績を記録中...");
    nextArea.appendChild(note);
    if (isHost) {
      addBtn("🔁 同じメンバーでもう1戦！", "", startGame);
      addBtn("ロビーへ戻る", "secondary", async () => { await recordSeriesIfNeeded(); await backToLobby(); });
    } else {
      nextArea.appendChild(el("p", "", "ホストが次の操作を選ぶのを待っています..."));
    }
  } else if (isHost) {
    const nextRound = roomData.round + 1;
    addBtn(`次のラウンド（ラウンド ${nextRound}・上限 ${stampLimit(nextRound)} 押し）へ進む`, "", async () => {
      await startRound({
        round: nextRound,
        captainIndex: roomData.captainIndex + 1,
        mistakes: total,
        order: gameIds(),
        usedWords: toArray(roomData.usedWords)
      });
    });
  } else {
    nextArea.appendChild(el("p", "", "ホストが次のラウンドを開始するのを待っています..."));
  }
}

// ============================================================
// 起動処理
// ============================================================
$("btn-create").addEventListener("click", () => enterRoom(true));
$("btn-join").addEventListener("click", () => enterRoom(false));
[$("input-name"), $("input-pass")].forEach(input => {
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) $("btn-join").click();
  });
});

(function init() {
  const params = new URLSearchParams(location.search);
  $("input-name").value = localStorage.getItem("inkd_name") || "";
  const roomParam = params.get("room");
  if (roomParam) $("input-pass").value = roomParam;

  let session = null;
  try { session = JSON.parse(sessionStorage.getItem("inkd_session")); } catch { /* ignore */ }
  if (session && session.name && session.pass) {
    // リロード時：自動で元の部屋に復帰
    $("input-name").value = session.name;
    $("input-pass").value = session.pass;
    enterRoom(false, true);
  }
})();
