// スケッチアクアリウム（バルーン版）Phase 1 — 撮影 → 抽出 → 水槽
import { Aquarium } from "./aquarium.js";
import { extract, DETECT_LONG } from "./cv.js";

const FULL_LONG_MAX = 3000;     // 原寸サンプリング用。iOS のキャンバス面積上限対策で長辺を抑える
const SAVE_SIZE = 384;          // §6-6 保存テクスチャ
const SAVE_QUALITY = 0.8;
const MAX_FISH = 20;
const STORE_KEY = "sketchAquarium.fish.v1";

const $ = (s) => document.querySelector(s);

// ------------------------------------------------------------------ 保存（§6-6）
// localStorage はプライベートブラウズ等で例外を投げるので、全部 try/catch。失敗してもその場限りで動く
const store = {
  load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); } catch { return []; }
  },
  /** 容量超過なら古い順に捨てて再試行。捨てた id の配列を返す */
  save(list) {
    const dropped = [];
    while (list.length) {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); return dropped; }
      catch { dropped.push(list.shift().id); }
    }
    try { localStorage.removeItem(STORE_KEY); } catch { /* 使えない環境 */ }
    return dropped;
  },
};

// ------------------------------------------------------------------ 画像
function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("画像を読み込めませんでした"));
    im.src = src;
  });
}

function canvasOf(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

/** img でも video でも可 */
function sizeOf(src) {
  return src.videoWidth ? [src.videoWidth, src.videoHeight] : [src.naturalWidth, src.naturalHeight];
}

function drawScaled(img, long) {
  const [w, h] = sizeOf(img);
  const k = Math.min(1, long / Math.max(w, h));
  const c = canvasOf(Math.round(w * k), Math.round(h * k));
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, 0, 0, c.width, c.height);
  return g.getImageData(0, 0, c.width, c.height);
}

/** マスクを掛けたプレビュー（アルファ付き） */
function maskedPreview(texCanvas, maskImg) {
  // マスク PNG はグレースケール（不透明）なので、輝度をアルファに移す（シェーダと同じ .r 参照）
  const { width: w, height: h } = texCanvas;
  const m = canvasOf(w, h).getContext("2d");
  m.drawImage(maskImg, 0, 0, w, h);
  const md = m.getImageData(0, 0, w, h).data;
  const c = canvasOf(w, h);
  const g = c.getContext("2d");
  g.drawImage(texCanvas, 0, 0);
  const id = g.getImageData(0, 0, w, h);
  for (let i = 3; i < id.data.length; i += 4) id.data[i] = md[i - 3];
  g.putImageData(id, 0, 0);
  return c;
}

/** 検出の様子（二値化 + 候補 + 採用した4点） */
function debugCanvas(dbg) {
  const { w, h, bin, cands, quad } = dbg;
  const c = canvasOf(w, h);
  const g = c.getContext("2d");
  const id = g.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = bin[i] ? 30 : 235;
    id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v;
    id.data[i * 4 + 3] = 255;
  }
  g.putImageData(id, 0, 0);
  g.lineWidth = 2;
  g.strokeStyle = "#f80";
  for (const k of cands.slice(0, 10)) {
    g.beginPath(); g.arc(k.cx, k.cy, Math.sqrt(k.area) * 0.8, 0, 7); g.stroke();
  }
  if (quad) {
    g.strokeStyle = "#0c6";
    g.fillStyle = "#0c6";
    g.font = "bold 16px sans-serif";
    g.beginPath();
    ["TL", "TR", "BR", "BL", "TL"].forEach((k, i) => (i ? g.lineTo : g.moveTo).call(g, quad[k].cx, quad[k].cy));
    g.stroke();
    for (const k of ["TL", "TR", "BR", "BL"]) g.fillText(k, quad[k].cx + 8, quad[k].cy - 8);
  }
  return c;
}

// ------------------------------------------------------------------ デモ魚（水槽が空の時だけ）
function demoTexture(maskImg, hue) {
  const c = canvasOf(SAVE_SIZE, SAVE_SIZE);
  const g = c.getContext("2d");
  const gr = g.createLinearGradient(0, 0, SAVE_SIZE, SAVE_SIZE * 0.4);
  gr.addColorStop(0, `hsl(${hue},85%,60%)`);
  gr.addColorStop(1, `hsl(${(hue + 50) % 360},85%,55%)`);
  g.fillStyle = gr;
  g.fillRect(0, 0, SAVE_SIZE, SAVE_SIZE);
  g.fillStyle = `hsla(${(hue + 180) % 360},80%,70%,0.8)`;
  for (let i = 0; i < 3; i++) g.fillRect(SAVE_SIZE * (0.33 + i * 0.13), 0, SAVE_SIZE * 0.05, SAVE_SIZE);
  // 目
  g.fillStyle = "#fff";
  g.beginPath(); g.arc(SAVE_SIZE * 0.17, SAVE_SIZE * 0.43, SAVE_SIZE * 0.035, 0, 7); g.fill();
  g.fillStyle = "#111";
  g.beginPath(); g.arc(SAVE_SIZE * 0.175, SAVE_SIZE * 0.435, SAVE_SIZE * 0.016, 0, 7); g.fill();
  return c;
}

// ------------------------------------------------------------------ main
async function main() {
  const layout = await (await fetch("layout.json")).json();
  const fishDef = layout.fishes[0];
  const maskImg = await loadImage(fishDef.mask);
  const aq = new Aquarium($("#tank"), maskImg);

  let saved = store.load();
  for (const f of saved) {
    try { aq.addFish(await loadImage(f.tex), { id: f.id }); } catch { /* 壊れたデータは無視 */ }
  }
  if (!saved.length) [20, 200, 320].forEach((h, i) => aq.addFish(demoTexture(maskImg, h), { id: "demo" + i }));
  updateCount();

  function updateCount() {
    $("#count").textContent = saved.length ? `${saved.length} ひき` : "";
  }

  // ---- シート
  const sheet = $("#sheet");
  function openSheet(mode) {
    sheet.dataset.mode = mode;
    sheet.hidden = false;
  }
  function closeSheet() { sheet.hidden = true; }

  let pending = null;   // 放つ前の抽出結果

  /** src: 画像 URL か、すでに描画できる要素（カメラの video） */
  async function processSource(src) {
    // video は「読み取り中」を出す前にフレームを固定する（シートを描く間に絵が動かないように）
    const img = typeof src === "string" ? null : frameOf(src);
    openSheet("busy");
    await new Promise((r) => setTimeout(r, 30));   // 「読み取り中」を先に描画させる
    const t0 = performance.now();
    const pic = img || await loadImage(src);
    return processImage(pic, t0);
  }

  function frameOf(video) {
    const c = canvasOf(video.videoWidth, video.videoHeight);
    c.getContext("2d").drawImage(video, 0, 0);
    c.naturalWidth = c.width; c.naturalHeight = c.height;
    return c;
  }

  function processImage(img, t0) {
    const full = drawScaled(img, FULL_LONG_MAX);
    const small = drawScaled(img, DETECT_LONG);
    const r = extract(full, small, layout);
    const ms = Math.round(performance.now() - t0);

    $("#debug-img").replaceChildren(debugCanvas(r.debug));
    if (!r.ok) {
      $("#err-msg").textContent = r.reason;
      $("#debug-info").textContent = `しきい値 ${Math.round(r.debug.thr)} / 候補 ${r.debug.cands.length} 個 / ${ms}ms`;
      openSheet("error");
      return r;
    }
    const tex = canvasOf(layout.texSize, layout.texSize);
    tex.getContext("2d").putImageData(r.image, 0, 0);
    const save = canvasOf(SAVE_SIZE, SAVE_SIZE);
    save.getContext("2d").drawImage(tex, 0, 0, SAVE_SIZE, SAVE_SIZE);
    pending = save;
    $("#preview").replaceChildren(maskedPreview(tex, maskImg));
    $("#debug-info").textContent =
      `しきい値 ${Math.round(r.debug.thr)} / 候補 ${r.debug.cands.length} 個 / ` +
      `白補正 R${r.gains[0].toFixed(2)} G${r.gains[1].toFixed(2)} B${r.gains[2].toFixed(2)} / ` +
      `${full.width}×${full.height} / ${ms}ms`;
    openSheet("result");
    return r;
  }

  async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const url = URL.createObjectURL(file);
    try { await processSource(url); }
    catch (err) {
      $("#err-msg").textContent = "読み取りに失敗しました：" + err.message;
      openSheet("error");
    } finally { URL.revokeObjectURL(url); }
  }

  function release() {
    if (!pending) return;
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const dataURL = pending.toDataURL("image/jpeg", SAVE_QUALITY);
    for (const f of [...aq.fish]) if (String(f.id).startsWith("demo")) aq.removeFish(f.id);
    aq.addFish(pending, { id, spawn: true });
    saved.push({ id, ts: Date.now(), tex: dataURL });
    while (saved.length > MAX_FISH) aq.removeFish(saved.shift().id);   // 上限を超えたら古い個体から
    for (const gone of store.save(saved)) aq.removeFish(gone);
    pending = null;
    closeSheet();
    updateCount();
  }

  // ---- カメラ映像を背景に。撮影も同じストリームから1フレーム取る
  // （ストリーム中に <input capture> で標準カメラを開くと、機種によってはカメラの取り合いになる）
  const video = $("#cam");
  let camOn = false;
  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      });
      video.srcObject = stream;
      await video.play();
      camOn = true;
    } catch (e) {
      console.warn("camera unavailable:", e);
      camOn = false;
    }
    document.body.classList.toggle("cam", camOn);
    aq.setCameraMode(camOn);
    return camOn;
  }
  startCamera();

  function shoot() {
    closeSheet();
    if (camOn && video.videoWidth) {
      processSource(video).catch((err) => {
        $("#err-msg").textContent = "読み取りに失敗しました：" + err.message;
        openSheet("error");
      });
    } else {
      $("#in-camera").click();   // カメラが使えない時は端末の標準カメラ
    }
  }

  $("#btn-shoot").addEventListener("click", shoot);
  $("#in-camera").addEventListener("change", onFile);
  $("#in-file").addEventListener("change", onFile);
  $("#btn-release").addEventListener("click", release);
  for (const b of document.querySelectorAll("[data-close]")) b.addEventListener("click", closeSheet);
  $("#btn-retake").addEventListener("click", shoot);
  $("#btn-retake2").addEventListener("click", shoot);
  $("#btn-menu").addEventListener("click", () => openSheet("menu"));
  $("#btn-clear").addEventListener("click", () => {
    if (!confirm("水槽の魚をぜんぶ消します。よろしいですか？")) return;
    for (const f of saved) aq.removeFish(f.id);
    saved = [];
    store.save(saved);
    updateCount();
    closeSheet();
  });

  // 検証用フック（Phase 1/2 の回帰テスト・実測で使う）
  window.__aquarium = { processURL: processSource, release, aq, layout, startCamera };
}

main().catch((e) => {
  document.body.insertAdjacentHTML("beforeend", `<p class="fatal">起動できませんでした：${e.message}</p>`);
});
