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
