// スケッチアクアリウム（バルーン版）— 読み取り → 水槽（紙のさかな / 3D バルーン）→ 記念写真
import { Aquarium, loadBalloonModel } from "./aquarium.js";
import { extractAuto, mirrorX, DETECT_LONG } from "./cv.js";

const FULL_LONG_MAX = 3000;     // 原寸サンプリング用。iOS のキャンバス面積上限対策で長辺を抑える
const SAVE_SIZE = 384;          // §6-6 保存テクスチャ（紙のさかな）
const BALLOON_SAVE_SIZE = 512;  // バルーンは 3D で大きく見えるので高め（表裏で約 100KB）
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

// ------------------------------------------------------------------ デモ（水槽が空の時だけ）
function demoTexture(hue, eye, S = SAVE_SIZE) {
  const c = canvasOf(S, S);
  const g = c.getContext("2d");
  const gr = g.createLinearGradient(0, 0, S, S * 0.4);
  gr.addColorStop(0, `hsl(${hue},85%,60%)`);
  gr.addColorStop(1, `hsl(${(hue + 50) % 360},85%,55%)`);
  g.fillStyle = gr;
  g.fillRect(0, 0, S, S);
  g.fillStyle = `hsla(${(hue + 180) % 360},80%,70%,0.8)`;
  for (let i = 0; i < 3; i++) g.fillRect(S * (0.33 + i * 0.13), 0, S * 0.05, S);
  g.fillStyle = "#fff";
  g.beginPath(); g.arc(S * eye[0], S * eye[1], S * 0.035, 0, 7); g.fill();
  g.fillStyle = "#111";
  g.beginPath(); g.arc(S * (eye[0] + 0.005), S * (eye[1] + 0.005), S * 0.016, 0, 7); g.fill();
  return c;
}

const MODE_KEY = "sketchAquarium.mode";
const pref = {
  get() { try { return localStorage.getItem(MODE_KEY) || "balloon"; } catch { return "balloon"; } },
  set(v) { try { localStorage.setItem(MODE_KEY, v); } catch { /* その場限り */ } },
};

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ------------------------------------------------------------------ main
async function main() {
  const layout = await (await fetch("layout.json")).json();
  const T = layout.templates;
  const masks = {
    flat: await loadImage(T.paper.mask),
    balloon: await loadImage(T.balloon.mask),
  };
  const modelId = T.balloon.model ? T.balloon.model.id : null;
  let model = null, atlasMask = null;
  if (T.balloon.model) {
    try {
      model = await loadBalloonModel(T.balloon.model.obj);
      const am = T.balloon.model.atlasMask;
      if (am) atlasMask = { front: await loadImage(am.front), back: await loadImage(am.back) };
    } catch (e) { console.warn("balloon model unavailable, using pillow mesh:", e); }
  }
  const aq = new Aquarium($("#tank"), masks, { tpl: T.balloon, model, atlasMask });

  // 別の形（テンプレート）で読んだバルーンは貼り方が合わないので出さない
  let saved = store.load().filter((f) => f.kind !== "balloon" || f.model === modelId);
  for (const f of saved) {
    try {
      if (f.kind === "balloon") aq.addBalloon(await loadImage(f.tex), await loadImage(f.back), { id: f.id });
      else aq.addFish(await loadImage(f.tex), { id: f.id });
    } catch { /* 壊れたデータは無視 */ }
  }
  if (!saved.length) {
    const [rx0, ry0, rx1, ry1] = T.balloon.region;
    const eye = [(T.balloon.eye[0] - rx0) / (rx1 - rx0), (T.balloon.eye[1] - ry0) / (ry1 - ry0)];
    [20, 200].forEach((h, i) => {
      const t = demoTexture(h, eye, BALLOON_SAVE_SIZE);
      aq.addBalloon(t, t, { id: "demo-b" + i });   // 裏も表の座標系なので同じ絵でよい
    });
    aq.addFish(demoTexture(320, [0.17, 0.43]), { id: "demo-f" });
  }

  // ---- 状態
  let mode = pref.get();             // "balloon" | "paper"
  let scan = { step: "front", front: null, back: null };   // バルーンの表→裏
  let pending = null;                // 紙のさかな：放つ前のテクスチャ

  function updateCount() {
    $("#count").textContent = saved.length ? `${saved.length} ひき` : "";
  }
  function updateHint() {
    $("#hint").textContent = mode === "paper"
      ? "四すみの ■ が全部入るように、少しななめから"
      : scan.step === "front"
        ? "🎈 おもて：■ 4つが全部入るように、少しななめから"
        : "🎈 つぎは うら：裏返して ■ 4つを入れてね";
    $("#btn-shoot").textContent = mode === "paper" ? "📷 読み取る"
      : scan.step === "front" ? "📷 おもてを読む" : "📷 うらを読む";
    for (const r of document.querySelectorAll("input[name=mode]")) r.checked = r.value === mode;
  }
  updateCount();
  updateHint();

  // ---- シート
  const sheet = $("#sheet");
  function openSheet(m) { sheet.dataset.mode = m; sheet.hidden = false; }
  function closeSheet() { sheet.hidden = true; }

  // ---- 読み取り
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
    // 紙のさかなかバルーンかはマーカーの寸法比で自動判別。選んでいるモードと違えば切り替える
    const r = extractAuto(full, small, T, mode);
    const ms = Math.round(performance.now() - t0);
    if (r.ok && r.template !== mode) {
      mode = r.template;
      pref.set(mode);
      scan = { step: "front", front: null, back: null };
      updateHint();
    }
    const tpl = T[mode];

    $("#debug-img").replaceChildren(debugCanvas(r.debug));
    if (!r.ok) {
      $("#err-msg").textContent = r.reason;
      $("#debug-info").textContent = `しきい値 ${Math.round(r.debug.thr)} / 候補 ${r.debug.cands.length} 個 / ${ms}ms`;
      openSheet("error");
      return r;
    }
    // 裏面は輪郭が左右反転しているので、反転して表と同じ座標系にそろえる
    const image = mode === "balloon" && scan.step === "back" && tpl.backMirrored ? mirrorX(r.image) : r.image;
    const tex = canvasOf(tpl.texSize, tpl.texSize);
    tex.getContext("2d").putImageData(image, 0, 0);
    const ss = mode === "balloon" ? BALLOON_SAVE_SIZE : SAVE_SIZE;
    const save = canvasOf(ss, ss);
    save.getContext("2d").drawImage(tex, 0, 0, ss, ss);
    $("#debug-info").textContent =
      `しきい値 ${Math.round(r.debug.thr)} / 候補 ${r.debug.cands.length} 個 / ` +
      `白補正 R${r.gains[0].toFixed(2)} G${r.gains[1].toFixed(2)} B${r.gains[2].toFixed(2)} / ` +
      `${full.width}×${full.height} / ${ms}ms`;

    const previews = [];
    if (mode === "paper") {
      pending = save;
      previews.push(maskedPreview(tex, masks.flat));
      setResult("この魚を水槽に放つ？", ["retake", "release"]);
    } else if (scan.step === "front") {
      scan.front = save;
      previews.push(maskedPreview(save, masks.balloon));
      setResult("おもて OK！ つぎは うら", ["retake", "skip", "next"]);
    } else {
      scan.back = save;
      previews.push(maskedPreview(scan.front, masks.balloon), mirroredPreview(save, masks.balloon));
      setResult("このバルーンを放つ？", ["retake", "release"]);
    }
    $("#preview").replaceChildren(...previews);
    openSheet("result");
    return r;
  }

  /** 裏はユーザーが見た向き（頭が右）で確認できるように、プレビューだけ反転して見せる */
  function mirroredPreview(tex, mask) {
    const p = maskedPreview(tex, mask);
    p.style.transform = "scaleX(-1)";
    return p;
  }

  function setResult(title, buttons) {
    $("#result-title").textContent = title;
    for (const b of ["retake", "skip", "next", "release"]) $("#btn-" + b).hidden = !buttons.includes(b);
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

  function removeDemos() {
    for (const f of [...aq.fish]) if (String(f.id).startsWith("demo")) aq.removeFish(f.id);
  }

  function persist(entry) {
    saved.push(entry);
    while (saved.length > MAX_FISH) aq.removeFish(saved.shift().id);   // 上限を超えたら古い個体から
    for (const gone of store.save(saved)) aq.removeFish(gone);
    updateCount();
  }

  function release() {
    const id = newId();
    removeDemos();
    if (mode === "paper") {
      if (!pending) return;
      aq.addFish(pending, { id, spawn: true });
      persist({ id, kind: "flat", ts: Date.now(), tex: pending.toDataURL("image/jpeg", SAVE_QUALITY) });
      pending = null;
    } else {
      if (!scan.front) return;
      const back = scan.back || scan.front;    // 裏なし → 表の絵を裏にも使う
      aq.addBalloon(scan.front, back, { id, spawn: true });
      persist({
        id, kind: "balloon", model: modelId, ts: Date.now(),
        tex: scan.front.toDataURL("image/jpeg", SAVE_QUALITY),
        back: back.toDataURL("image/jpeg", SAVE_QUALITY),
      });
      scan = { step: "front", front: null, back: null };
    }
    closeSheet();
    updateHint();
  }

  // ---- カメラ（背景 + 読み取り + 写真）
  const video = $("#cam");
  let camOn = false;
  let facing = "environment";
  async function startCamera(want = facing) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
    if (video.srcObject) for (const t of video.srcObject.getTracks()) t.stop();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: want }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      });
      video.srcObject = stream;
      await video.play();
      const s = stream.getVideoTracks()[0].getSettings ? stream.getVideoTracks()[0].getSettings() : {};
      facing = s.facingMode || want;
      camOn = true;
    } catch (e) {
      console.warn("camera unavailable:", e);
      camOn = false;
    }
    video.classList.toggle("mirror", camOn && facing === "user");   // インカメラは鏡像で見せる
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

  /** カメラ映像 + 3D を1枚に合成（画面に見えている通り） */
  function composePhoto() {
    const rc = aq.renderer.domElement;
    const W = rc.width, H = rc.height;
    const c = canvasOf(W, H);
    const g = c.getContext("2d");
    g.fillStyle = "#04182e";
    g.fillRect(0, 0, W, H);
    if (camOn && video.videoWidth) {
      // object-fit: cover と同じ切り抜き
      const vw = video.videoWidth, vh = video.videoHeight;
      const k = Math.max(W / vw, H / vh);
      const dw = vw * k, dh = vh * k;
      g.save();
      if (video.classList.contains("mirror")) { g.translate(W, 0); g.scale(-1, 1); }
      g.drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh);
      g.restore();
    }
    aq.renderer.render(aq.scene, aq.camera);   // 直後に読むので preserveDrawingBuffer なしで取れる
    g.drawImage(rc, 0, 0);
    return c;
  }

  let photoBlob = null;
  function takePhoto() {
    const c = composePhoto();
    const flash = $("#flash");
    flash.classList.remove("on"); void flash.offsetWidth; flash.classList.add("on");
    c.toBlob((blob) => {
      photoBlob = blob;
      const img = $("#photo-img");
      if (img.src) URL.revokeObjectURL(img.src);
      img.src = URL.createObjectURL(blob);
      openSheet("photo");
    }, "image/jpeg", 0.92);
  }

  async function savePhoto() {
    if (!photoBlob) return;
    const name = `aquarium_${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}.jpg`;
    const file = new File([photoBlob], name, { type: "image/jpeg" });
    // スマホは共有シートから「画像を保存」で写真アプリへ。使えなければダウンロード
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return; }
      catch (e) { if (e.name === "AbortError") return; }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(photoBlob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ---- ボタン
  $("#btn-shoot").addEventListener("click", shoot);
  $("#btn-photo").addEventListener("click", takePhoto);
  $("#btn-flip").addEventListener("click", () => startCamera(facing === "user" ? "environment" : "user"));
  $("#btn-save-photo").addEventListener("click", savePhoto);
  $("#in-camera").addEventListener("change", onFile);
  $("#in-file").addEventListener("change", (e) => { closeSheet(); onFile(e); });
  $("#btn-release").addEventListener("click", release);
  $("#btn-next").addEventListener("click", () => { scan.step = "back"; updateHint(); shoot(); });
  $("#btn-skip").addEventListener("click", () => { scan.back = null; release(); });
  $("#btn-retake").addEventListener("click", shoot);
  $("#btn-retake2").addEventListener("click", shoot);
  for (const b of document.querySelectorAll("[data-close]")) b.addEventListener("click", closeSheet);
  $("#btn-menu").addEventListener("click", () => openSheet("menu"));
  for (const r of document.querySelectorAll("input[name=mode]")) {
    r.addEventListener("change", () => {
      mode = r.value;
      pref.set(mode);
      scan = { step: "front", front: null, back: null };
      updateHint();
    });
  }
  $("#btn-restart-scan").addEventListener("click", () => {
    scan = { step: "front", front: null, back: null };
    updateHint();
    closeSheet();
  });
  $("#btn-clear").addEventListener("click", () => {
    if (!confirm("水槽の魚をぜんぶ消します。よろしいですか？")) return;
    for (const f of saved) aq.removeFish(f.id);
    saved = [];
    store.save(saved);
    updateCount();
    closeSheet();
  });

  // 検証用フック（回帰テスト・実測で使う）
  window.__aquarium = {
    processURL: processSource, release, aq, layout, startCamera, composePhoto, takePhoto,
    setMode(m) { mode = m; scan = { step: "front", front: null, back: null }; updateHint(); },
    nextBack() { scan.step = "back"; updateHint(); },
  };
}

main().catch((e) => {
  document.body.insertAdjacentHTML("beforeend", `<p class="fatal">起動できませんでした：${e.message}</p>`);
});
