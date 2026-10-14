// 画像処理（OpenCV.js は使わない §5）。仕様 §3 [2]〜[6] / §6-1〜6-4
// 座標系: 「カード」= layout.json の単位（四隅マーカーの外接正方形を 0..1）

export const DETECT_LONG = 640;

// ---------------------------------------------------------------- [2] 二値化
function toGray(rgba, n) {
  const g = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  }
  return g;
}

function otsu(gray) {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = -1, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = gray.length - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const d = sumB / wB - (sum - sumB) / wF;
    const v = wB * wF * d * d;
    if (v > best) { best = v; thr = t; }
  }
  return thr;
}

// ---------------------------------------------------------------- 連結成分（4近傍・Union-Find）
function components(bin, w, h) {
  const lab = new Int32Array(w * h);
  const parent = [0];
  const find = (x) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (!bin[i]) continue;
      const up = y ? lab[i - w] : 0;
      const left = x ? lab[i - 1] : 0;
      if (!up && !left) { lab[i] = parent.length; parent.push(parent.length); }
      else if (up && left) {
        const a = find(up), b = find(left);
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
        lab[i] = Math.min(a, b);
      } else lab[i] = up || left;
    }
  }
  const n = parent.length;
  const area = new Float64Array(n), sx = new Float64Array(n), sy = new Float64Array(n);
  const sxx = new Float64Array(n), syy = new Float64Array(n), sxy = new Float64Array(n);
  const border = new Uint8Array(n);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (!lab[i]) continue;
      const r = find(lab[i]);
      area[r]++; sx[r] += x; sy[r] += y;
      sxx[r] += x * x; syy[r] += y * y; sxy[r] += x * y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border[r] = 1;
    }
  }
  const out = [];
  for (let r = 1; r < n; r++) {
    const a = area[r];
    if (!a || border[r]) continue;
    const cx = sx[r] / a, cy = sy[r] / a;
    const vxx = sxx[r] / a - cx * cx, vyy = syy[r] / a - cy * cy, vxy = sxy[r] / a - cx * cy;
    const det = Math.max(vxx * vyy - vxy * vxy, 1e-9);
    const tr2 = (vxx + vyy) / 2;
    const disc = Math.sqrt(Math.max(tr2 * tr2 - det, 0));
    out.push({
      area: a, cx: cx + 0.5, cy: cy + 0.5,
      // 正方形らしさ。塗りつぶし正方形は回転に関係なく 1.0（BBox 充填率だと45°回転で0.5に落ちる）
      squareness: a / (12 * Math.sqrt(det)),
      aspect: Math.sqrt((tr2 + disc) / Math.max(tr2 - disc, 1e-9)),
    });
  }
  return out;
}

// ---------------------------------------------------------------- [3] 4つの組と並び順
const cross = (o, a, b) => (a.cx - o.cx) * (b.cy - o.cy) - (a.cy - o.cy) * (b.cx - o.cx);

function orderFour(four) {
  const s = [...four].sort((a, b) => a.area - b.area);
  const BR = s[0];
  const rest = s.slice(1);
  rest.sort((a, b) => Math.hypot(b.cx - BR.cx, b.cy - BR.cy) - Math.hypot(a.cx - BR.cx, a.cy - BR.cy));
  const TL = rest[0];
  let TR = null, BL = null;
  for (const p of rest.slice(1)) {
    // 画像座標(y下向き)で TL→BR に対し右上は負、左下は正（テンプレ座標と同じ向き）
    if (cross(TL, BR, p) < 0) TR = p; else BL = p;
  }
  if (!TR || !BL) return null;
  return { TL, TR, BR, BL };
}

function isConvex(q) {
  const pts = [q.TL, q.TR, q.BR, q.BL];
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const c = cross(pts[i], pts[(i + 1) % 4], pts[(i + 2) % 4]);
    if (Math.abs(c) < 1e-6) return false;
    if (!sign) sign = Math.sign(c); else if (Math.sign(c) !== sign) return false;
  }
  return true;
}

function pickFour(cands, layout) {
  const expectRatio = (layout.markerSize.small / layout.markerSize.large) ** 2;   // ≈0.34
  const expectRel = layout.markerSize.large / (1 - layout.markerSize.large);     // 大マーカー辺 / 中心間距離
  const c = cands.slice(0, 10);
  let best = null;
  for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++)
    for (let k = j + 1; k < c.length; k++) for (let l = k + 1; l < c.length; l++) {
      const four = [c[i], c[j], c[k], c[l]];
      const s = [...four].sort((a, b) => a.area - b.area);
      const big = s.slice(1);
      const bigMin = big[0].area, bigMax = big[2].area;
      if (bigMax / bigMin > 2.5) continue;                       // 大3つは同程度（透視ぶん余裕）
      const ratio = s[0].area / ((bigMin + bigMax) / 2);
      if (ratio < expectRatio * 0.4 || ratio > expectRatio * 1.9) continue;
      const q = orderFour(four);
      if (!q || !isConvex(q)) continue;
      // マーカーの大きさと四隅の間隔の比が合っているか（無関係な黒い塊を弾く）
      const side = (Math.hypot(q.TR.cx - q.TL.cx, q.TR.cy - q.TL.cy) +
                    Math.hypot(q.BL.cx - q.TL.cx, q.BL.cy - q.TL.cy)) / 2;
      const rel = Math.sqrt((bigMin + bigMax) / 2) / side;
      if (rel < expectRel * 0.45 || rel > expectRel * 2.2) continue;
      const score = big[0].area + big[1].area + big[2].area;
      if (!best || score > best.score) best = { q, score };
    }
  return best && best.q;
}

/**
 * 四隅マーカー検出。small: 長辺 DETECT_LONG に縮小した ImageData
 * 戻り値 { ok, quad:{TL,TR,BR,BL}(縮小画像座標), debug, reason }
 */
export function detectMarkers(small, layout) {
  const { width: w, height: h, data } = small;
  const n = w * h;
  const gray = toGray(data, n);
  const t0 = otsu(gray);
  // 仕様は 0.05%〜5%。カードが画面の 1/3 程度でも小マーカー（≈0.03%）を拾えるよう下限を緩めた。
  // 塗った魚が正方形っぽい塊として残ることがあるが、pickFour の幾何チェックで弾かれる
  const minA = n * 0.00015, maxA = n * 0.05;
  let bestFail = null;
  for (const k of [1, 0.85, 0.7, 1.12]) {     // 照明ムラで Otsu が外れた時のためにしきい値を振る
    const thr = t0 * k;
    const bin = new Uint8Array(n);
    for (let i = 0; i < n; i++) bin[i] = gray[i] < thr ? 1 : 0;
    const comps = components(bin, w, h);
    const cands = comps
      .filter((c) => c.area >= minA && c.area <= maxA && c.squareness > 0.75 && c.squareness < 1.3 && c.aspect < 1.6)
      .sort((a, b) => b.area - a.area);
    const quad = cands.length >= 4 ? pickFour(cands, layout) : null;
    const debug = { thr, bin, w, h, cands, quad };
    if (quad) return { ok: true, quad, debug };
    if (!bestFail || cands.length > bestFail.cands.length) bestFail = debug;
  }
  // 白飛び画素の割合では「白い紙」と「映り込み」を区別できないので、映り込み対策は常に案内する
  const nc = bestFail.cands.length;
  const reason = nc < 4
    ? `四すみの ■ マーカーが ${nc} 個しか見つかりませんでした。照明の映り込みを避けて、` +
      "四すみが全部写るように、ななめ 15〜30° から撮り直してください。"
    : "マーカーの並び（右下だけ小さい ■）を判別できませんでした。照明の映り込みを避けて、" +
      "カード全体が画面の半分以上に写るように撮り直してください。";
  return { ok: false, reason, debug: bestFail };
}

// ---------------------------------------------------------------- [4] ホモグラフィ
/** src[i]=[x,y] → dst[i]=[u,v] の 3x3（h8=1）。8元連立をガウスの消去法で解く */
export function homography(src, dst) {
  const A = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) throw new Error("homography: singular");
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => row[8] / row[i]).concat(1);
}

export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

// ---------------------------------------------------------------- [5] 逆写像 + バイリニア
function sampleInto(img, x, y, out, o) {
  const { width: w, height: h, data } = img;
  x -= 0.5; y -= 0.5;
  if (x < 0) x = 0; else if (x > w - 1.001) x = w - 1.001;
  if (y < 0) y = 0; else if (y > h - 1.001) y = h - 1.001;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
  const i00 = (y0 * w + x0) * 4, i10 = i00 + 4, i01 = i00 + w * 4, i11 = i01 + 4;
  for (let c = 0; c < 3; c++) {
    const top = data[i00 + c] + (data[i10 + c] - data[i00 + c]) * fx;
    const bot = data[i01 + c] + (data[i11 + c] - data[i01 + c]) * fx;
    out[o + c] = top + (bot - top) * fy;
  }
}

/** 出力 N×N の各画素 → カード座標 → H → 原寸画像 の順で引く（順写像だと穴が開く §6-3） */
export function warpRegion(full, H, region, N) {
  const [x0, y0, x1, y1] = region;
  const out = new Float32Array(N * N * 3);
  for (let j = 0; j < N; j++) {
    const ty = y0 + ((j + 0.5) / N) * (y1 - y0);
    for (let i = 0; i < N; i++) {
      const tx = x0 + ((i + 0.5) / N) * (x1 - x0);
      const [u, v] = applyH(H, tx, ty);
      sampleInto(full, u, v, out, (j * N + i) * 3);
    }
  }
  return out;
}

// ---------------------------------------------------------------- [6] 白色正規化
export function whiteGains(full, H, points, radius) {
  const tmp = new Float32Array(3);
  const means = points.map(([px, py]) => {
    const m = [0, 0, 0];
    let cnt = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const [u, v] = applyH(H, px + (dx / 2) * radius, py + (dy / 2) * radius);
      sampleInto(full, u, v, tmp, 0);
      m[0] += tmp[0]; m[1] += tmp[1]; m[2] += tmp[2]; cnt++;
    }
    return m.map((x) => x / cnt);
  });
  // 落書きや影が乗った点を外すため、明るい上位半分だけを使う
  means.sort((a, b) => (b[0] + b[1] + b[2]) - (a[0] + a[1] + a[2]));
  const top = means.slice(0, Math.max(3, Math.ceil(means.length / 2)));
  const ref = [0, 1, 2].map((c) => top.reduce((s, m) => s + m[c], 0) / top.length);
  return ref.map((r) => Math.min(3, Math.max(0.9, 255 / Math.max(r, 1))));
}

/** Float RGB → ImageData（ゲイン適用） */
export function toImageData(rgb, N, gains) {
  const id = new ImageData(N, N);
  const d = id.data;
  for (let i = 0, j = 0; i < N * N; i++, j += 4) {
    d[j] = rgb[i * 3] * gains[0];
    d[j + 1] = rgb[i * 3 + 1] * gains[1];
    d[j + 2] = rgb[i * 3 + 2] * gains[2];
    d[j + 3] = 255;
  }
  return id;
}

/** 一連の処理。full: 原寸 ImageData, small: 検出用縮小 ImageData */
export function extract(full, small, layout) {
  const det = detectMarkers(small, layout);
  if (!det.ok) return det;
  const k = full.width / small.width;         // 検出は縮小、抽出は原寸から（§6-3）
  const keys = ["TL", "TR", "BR", "BL"];
  const src = keys.map((key) => layout.markers[key]);
  const dst = keys.map((key) => [det.quad[key].cx * k, det.quad[key].cy * k]);
  const H = homography(src, dst);
  const N = layout.texSize;
  const rgb = warpRegion(full, H, layout.region, N);
  const gains = whiteGains(full, H, layout.whitePoints, layout.whiteRadius);
  return { ok: true, image: toImageData(rgb, N, gains), gains, H, debug: det.debug };
}
