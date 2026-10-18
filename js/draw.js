// スタンプ・シートの描画ロジック（Firebase 非依存）

export const SHEET_SIZE = {
  landscape: { w: 320, h: 220 },
  portrait:  { w: 220, h: 320 }
};

// キャンバス外へどれだけはみ出して押せるか（スタンプ中心の許容範囲）
export const OVERHANG = 30;

// スタンプ描画関数（プレビュー時はガイド枠線を表示）
export function drawStampShape(ctx, st, isGhost = false) {
  ctx.save();
  ctx.translate(st.x, st.y);
  ctx.rotate(((st.angle || 0) * Math.PI) / 180);
  if (isGhost) ctx.globalAlpha = 0.55;

  const outline = () => {
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
  };

  if (st.type === "circle") {
    ctx.fillStyle = "#e63946";
    ctx.beginPath();
    ctx.arc(0, 0, 28, 0, Math.PI * 2);
    ctx.fill();
    if (isGhost) { outline(); ctx.stroke(); }
  } else if (st.type === "square") {
    ctx.fillStyle = "#2563eb";
    ctx.fillRect(-26, -26, 52, 52);
    if (isGhost) { outline(); ctx.strokeRect(-26, -26, 52, 52); }
  } else if (st.type === "triangle") {
    ctx.fillStyle = "#16a34a";
    ctx.beginPath();
    ctx.moveTo(0, -32);
    ctx.lineTo(30, 24);
    ctx.lineTo(-30, 24);
    ctx.closePath();
    ctx.fill();
    if (isGhost) { outline(); ctx.stroke(); }
  } else if (st.type === "bar") {
    ctx.fillStyle = "#eab308";
    ctx.fillRect(-7, -38, 14, 76);
    if (isGhost) { outline(); ctx.strokeRect(-7, -38, 14, 76); }
  }

  // プレビュー時は中心点に小さな十字マークを表示（位置合わせガイド）
  if (isGhost) {
    ctx.globalAlpha = 0.9;
    ctx.setLineDash([]);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-5, 0); ctx.lineTo(5, 0);
    ctx.moveTo(0, -5); ctx.lineTo(0, 5);
    ctx.stroke();
  }
  ctx.restore();
}

export function renderSheetToCanvas(canvas, sheetObj, ghost = null) {
  const orient = sheetObj.orientation === "portrait" ? "portrait" : "landscape";
  const { w, h } = SHEET_SIZE[orient];
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  (sheetObj.stamps || []).forEach(st => drawStampShape(ctx, st, false));
  if (ghost) drawStampShape(ctx, ghost, true);
}

// ---- シートを90度回転させたときの座標変換（紙そのものを回す動き）----
// 横長→縦長は時計回り90°、縦長→横長は反時計回り90°。描いた内容は保持される。
export function rotatePoint(pt, fromOrient) {
  if (fromOrient === "landscape") {
    return { x: SHEET_SIZE.landscape.h - pt.y, y: pt.x };
  }
  return { x: pt.y, y: SHEET_SIZE.portrait.w - pt.x };
}

export function rotateStamps(stamps, fromOrient) {
  const da = fromOrient === "landscape" ? 90 : -90;
  return stamps.map(st => {
    const p = rotatePoint(st, fromOrient);
    return {
      type: st.type,
      x: Math.round(p.x),
      y: Math.round(p.y),
      angle: (((st.angle || 0) + da) % 360 + 360) % 360
    };
  });
}

// ---- スタンプの当たり判定・選択表示（選択モード／消しゴム／レイヤー操作用） ----

// スタンプのローカル座標系（中心が原点・回転前）での当たり判定。tol は許容の余白(px)
function hitLocal(type, lx, ly, tol) {
  if (type === "circle") return lx * lx + ly * ly <= (28 + tol) * (28 + tol);
  if (type === "square") return Math.abs(lx) <= 26 + tol && Math.abs(ly) <= 26 + tol;
  if (type === "bar") return Math.abs(lx) <= 7 + tol && Math.abs(ly) <= 38 + tol;
  if (type === "triangle") {
    // 頂点 (0,-32) (30,24) (-30,24)。tol 分だけ外側に膨らませた簡易判定
    if (ly > 24 + tol || ly < -32 - tol) return false;
    const t = Math.max(0, Math.min(1, (ly + 32) / 56));
    const half = 30 * t + tol;
    return Math.abs(lx) <= half;
  }
  return false;
}

export function hitTestStamp(st, px, py, tol = 0) {
  const rad = -((st.angle || 0) * Math.PI) / 180;
  const dx = px - st.x;
  const dy = py - st.y;
  const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
  return hitLocal(st.type, lx, ly, tol);
}

// 最前面（配列の後ろ）から順に探す。細い棒も指で選べるよう、見つからなければ許容を広げて再探索
export function findStampAt(stamps, px, py) {
  for (const tol of [0, 10, 18]) {
    for (let i = stamps.length - 1; i >= 0; i--) {
      if (hitTestStamp(stamps[i], px, py, tol)) return i;
    }
  }
  return -1;
}

function drawSelectionOutline(ctx, st) {
  ctx.save();
  ctx.translate(st.x, st.y);
  ctx.rotate(((st.angle || 0) * Math.PI) / 180);
  const pad = 4;
  const trace = () => {
    ctx.beginPath();
    if (st.type === "circle") ctx.arc(0, 0, 28 + pad, 0, Math.PI * 2);
    else if (st.type === "square") ctx.rect(-26 - pad, -26 - pad, 52 + pad * 2, 52 + pad * 2);
    else if (st.type === "bar") ctx.rect(-7 - pad, -38 - pad, 14 + pad * 2, 76 + pad * 2);
    else if (st.type === "triangle") {
      ctx.moveTo(0, -32 - pad * 1.6);
      ctx.lineTo(30 + pad * 1.6, 24 + pad);
      ctx.lineTo(-30 - pad * 1.6, 24 + pad);
      ctx.closePath();
    }
  };
  trace();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 5;
  ctx.setLineDash([]);
  ctx.stroke();
  trace();
  ctx.strokeStyle = "#ec4899";
  ctx.lineWidth = 3;
  ctx.setLineDash([6, 4]);
  ctx.stroke();
  ctx.restore();
}

// selectedIdx に該当するスタンプの周囲に選択枠を描く
export function renderSheetWithSelection(canvas, sheetObj, selectedIdx) {
  renderSheetToCanvas(canvas, sheetObj, null);
  const st = (sheetObj.stamps || [])[selectedIdx];
  if (st) drawSelectionOutline(canvas.getContext("2d"), st);
}
