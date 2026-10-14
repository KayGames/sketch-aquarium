// 水槽シーン（仕様 §3[8], §6-5）
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const FISH_VERT = /* glsl */ `
  uniform float uTime, uSpeed, uWaveLength, uMaxAmp, uPhase0;
  varying vec2 vUv;
  varying float vDepth;
  void main() {
    vUv = uv;
    vec3 pos = position;
    float x = uv.x;                                  // 0=頭, 1=尾
    float phase = uTime * uSpeed - x * uWaveLength + uPhase0;
    float amp = x * x * uMaxAmp;                     // 頭はほぼ動かず、尾ほど大きく振れる
    pos.z += sin(phase) * amp;
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;

const FISH_FRAG = /* glsl */ `
  uniform sampler2D uMap, uMask;
  uniform float uOpacity;
  uniform vec3 uWater;
  varying vec2 vUv;
  varying float vDepth;
  void main() {
    float a = texture2D(uMask, vUv).r * uOpacity;
    if (a < 0.02) discard;
    vec3 c = texture2D(uMap, vUv).rgb;
    float fog = smoothstep(8.0, 16.0, vDepth) * 0.55;   // 奥の魚ほど水の色に沈む
    gl_FragColor = vec4(mix(c, uWater, fog), a);
  }`;

const BG_FRAG = /* glsl */ `
  uniform float uTime, uCamera;
  varying vec2 vUv;
  void main() {
    vec3 top = vec3(0.16, 0.62, 0.78), deep = vec3(0.02, 0.10, 0.25);
    vec3 c = mix(deep, top, pow(vUv.y, 1.4));
    // 水面から差し込む光の筋
    float r = 0.0;
    float sx = vUv.x + (1.0 - vUv.y) * 0.35;
    r += pow(max(0.0, sin(sx * 23.0 + uTime * 0.35)), 18.0);
    r += 0.7 * pow(max(0.0, sin(sx * 37.0 - uTime * 0.27 + 1.3)), 24.0);
    r += 0.5 * pow(max(0.0, sin(sx * 13.0 + uTime * 0.18 + 4.0)), 30.0);
    float ray = r * smoothstep(0.15, 1.0, vUv.y);
    if (uCamera > 0.5) {
      // カメラ背景モード：うすい水色のベール + 光の筋だけを重ねる（現実の景色が水中っぽく見える）
      float a = mix(0.10, 0.28, 1.0 - vUv.y) + ray * 0.22;
      vec3 col = mix(vec3(0.05, 0.30, 0.45), vec3(0.75, 0.95, 1.0), clamp(ray, 0.0, 1.0));
      gl_FragColor = vec4(col, a);
      return;
    }
    c += ray * vec3(0.55, 0.85, 0.9) * 0.45;
    gl_FragColor = vec4(c, 1.0);
  }`;

const PASS_VERT = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;

const WATER = new THREE.Color(0.05, 0.25, 0.42);
const MAX_PITCH = 0.35;

function easeOutBack(t) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function radialTexture(inner, outer) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, inner);
  gr.addColorStop(1, outer);
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/**
 * 膨らんだバルーンの形をマスクから作る。輪郭からの距離で高さを決める「枕型」。
 * 実物と同じく、平らなフィルムに刷った絵がそのまま膨らむので UV は平面のまま。
 * 戻り値 { front, back }：表は +Z、裏は -Z。どちらも同じ UV（裏の絵は左右反転して渡す）
 */
function buildBalloonGeometry(maskImg, G = 128, puff = 0.14) {
  const S = G + 1;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(maskImg, 0, 0, S, S);
  const md = g.getImageData(0, 0, S, S).data;
  const m = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) m[i] = md[i * 4] / 255;

  // 高さ：内圧のかかった膜（Δh = -p、縁は 0）を SOR で解く。実際のバルーンのフィルムと同じ考え方で、
  // 距離変換と違って中心線に折り目が出ない
  const inside = new Uint8Array(S * S);
  for (let y = 1; y < S - 1; y++) for (let x = 1; x < S - 1; x++) inside[y * S + x] = m[y * S + x] > 0.5 ? 1 : 0;
  const memb = new Float32Array(S * S);
  const omega = 1.9;
  for (let it = 0; it < 500; it++) {
    for (let i = S + 1; i < S * S - S - 1; i++) {
      if (!inside[i]) continue;
      memb[i] += omega * ((memb[i - 1] + memb[i + 1] + memb[i - S] + memb[i + S] + 1) / 4 - memb[i]);
    }
  }
  let umax = 0;
  for (let i = 0; i < S * S; i++) if (memb[i] > umax) umax = memb[i];
  // 膜の解は放物線ぎみなので、平方根で縁を丸く立ち上げて中央を平らにする（アルミバルーンの枕型）
  const hf = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) hf[i] = Math.sqrt(memb[i] / Math.max(umax, 1e-6));

  const pos = new Float32Array(S * S * 3), posB = new Float32Array(S * S * 3), uv = new Float32Array(S * S * 2);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = y * S + x, u = x / G, v = y / G;
    const h = puff * hf[i];
    pos[i * 3] = posB[i * 3] = u - 0.5;
    pos[i * 3 + 1] = posB[i * 3 + 1] = 0.5 - v;
    pos[i * 3 + 2] = h; posB[i * 3 + 2] = -h;
    uv[i * 2] = u; uv[i * 2 + 1] = 1 - v;
  }
  const idx = [], idxB = [];
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
    const a = y * S + x, b = a + 1, cc = a + S, d = cc + 1;
    if (Math.max(m[a], m[b], m[cc], m[d]) < 0.02) continue;   // 輪郭の外は張らない（縁はアルファで切る）
    idx.push(a, cc, b, b, cc, d);
    idxB.push(a, b, cc, b, d, cc);
  }
  const make = (p, ix) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(p, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setIndex(ix);
    geo.computeVertexNormals();
    return geo;
  };
  return { front: make(pos, idx), back: make(posB, idxB) };
}

export class Aquarium {
  /** masks: { flat: 紙のさかなのマスク画像, balloon: バルーンのマスク画像 } */
  constructor(container, masks) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });   // 背後のカメラ映像を透かす
    this.renderer.setClearColor(0x000000, 0);
    this.cameraMode = false;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    this.camera.position.set(0, 1.0, 10);
    this.camera.lookAt(0, 0, 0);

    this.mask = new THREE.Texture(masks.flat);
    this.mask.needsUpdate = true;
    this.balloonMask = new THREE.Texture(masks.balloon);
    this.balloonMask.needsUpdate = true;
    this.balloonGeo = buildBalloonGeometry(masks.balloon);

    // バルーンのつや（フィルムの光沢）は環境マップの映り込みで出す
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.fish = [];
    this.time = 0;
    this.bounds = { x: 4, y: 2.5, zMin: -3, zMax: 1.5 };

    this._buildBackground();
    this._buildFloor();
    this._buildBubbles();

    this.shadowTex = radialTexture("rgba(0,10,25,0.55)", "rgba(0,10,25,0)");
    this.clock = new THREE.Clock();
    addEventListener("resize", () => this.resize());
    this.resize();
    this.renderer.setAnimationLoop(() => this._tick());
  }

  // ------------------------------------------------------------ 環境
  _buildBackground() {
    this.bgMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uCamera: { value: 0 } },
      vertexShader: PASS_VERT, fragmentShader: BG_FRAG, depthWrite: false,
    });
    this.bg = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.bgMat);
    this.bg.position.z = -12;
    this.scene.add(this.bg);
  }

  _buildFloor() {
    const c = document.createElement("canvas");
    c.width = 4; c.height = 64;
    const g = c.getContext("2d");
    const gr = g.createLinearGradient(0, 0, 0, 64);
    gr.addColorStop(0, "rgba(40,90,110,0)");       // 奥は水に溶ける
    gr.addColorStop(0.55, "rgba(120,140,130,0.55)");
    gr.addColorStop(1, "rgba(175,160,120,0.95)");  // 手前の砂
    g.fillStyle = gr;
    g.fillRect(0, 0, 4, 64);
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 22),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.z = 0;
    this.floor.renderOrder = -1;
    this.scene.add(this.floor);
  }

  _buildBubbles() {
    const N = 90;
    this.bubbleData = [];
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) this.bubbleData.push(this._newBubble(true));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.bubbles = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.13, map: radialTexture("rgba(255,255,255,0.9)", "rgba(200,240,255,0)"),
      transparent: true, depthWrite: false, opacity: 0.8,
    }));
    this.scene.add(this.bubbles);
  }

  _newBubble(anywhere, at) {
    const b = this.bounds;
    return {
      x: at ? at.x + (Math.random() - 0.5) * 0.8 : (Math.random() * 2 - 1) * b.x * 1.3,
      y: at ? at.y + (Math.random() - 0.5) * 0.6 : anywhere ? (Math.random() * 2 - 1) * b.y : -b.y - 1,
      z: at ? at.z + (Math.random() - 0.5) * 0.5 : b.zMin + Math.random() * (b.zMax - b.zMin + 2),
      v: 0.4 + Math.random() * 0.8, ph: Math.random() * 6.28,
    };
  }

  /** 魚が放たれた時のあぶく */
  burst(at, n = 24) {
    for (let i = 0; i < n; i++) {
      const k = (Math.random() * this.bubbleData.length) | 0;
      this.bubbleData[k] = this._newBubble(false, at);
      this.bubbleData[k].v *= 1.8;
    }
  }

  /** true: 背景はカメラ映像（水のベールと光の筋だけ描く）／ false: 描いた水槽 */
  setCameraMode(on) {
    this.cameraMode = on;
    this.bgMat.uniforms.uCamera.value = on ? 1 : 0;
    this.bgMat.transparent = on;
    this.bgMat.needsUpdate = true;
    this.floor.visible = !on;           // カメラ映像には床がないので、床と床の影は出さない
    for (const f of this.fish) f.shadow.visible = !on;
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const halfH = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.position.z;
    const halfW = halfH * this.camera.aspect;
    this.fishSize = THREE.MathUtils.clamp(Math.min(halfW, halfH) * 0.6, 1.3, 2.6);
    this.bounds.x = Math.max(0.5, halfW - this.fishSize * 0.45);
    this.bounds.y = Math.max(0.5, halfH * 0.72 - this.fishSize * 0.3);
    this.floor.position.y = -halfH * 0.95;
    const bgDist = this.camera.position.z - this.bg.position.z;
    const s = (bgDist / this.camera.position.z) * 2.3;
    this.bg.scale.set(halfW * s, halfH * s, 1);
    for (const f of this.fish) f.obj.scale.setScalar(this.fishSize * f.sizeK);
  }

  // ------------------------------------------------------------ 魚
  /**
   * @param {HTMLCanvasElement|HTMLImageElement} texSource 抽出テクスチャ（アルファなし）
   * @param {{id?:string, spawn?:boolean}} opt
   */
  addFish(texSource, opt = {}) {
    const map = new THREE.Texture(texSource);
    map.needsUpdate = true;
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: map }, uMask: { value: this.mask }, uOpacity: { value: 1 },
        uWater: { value: WATER },
        uTime: { value: 0 }, uSpeed: { value: 5 }, uWaveLength: { value: 3.2 },
        uMaxAmp: { value: 0.22 }, uPhase0: { value: Math.random() * 6.28 },
      },
      vertexShader: FISH_VERT, fragmentShader: FISH_FRAG,
      transparent: true, side: THREE.DoubleSide, depthWrite: true,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 24, 1), mat);
    return this._addCreature(mesh, mat.uniforms, () => {
      mesh.geometry.dispose(); map.dispose(); mat.dispose();
    }, opt, { cruise: 0.9 + Math.random() * 0.6, bob: 0 });
  }

  /**
   * 3D バルーン。front/back はどちらも表と同じ向き（頭が左）の絵。裏は呼び出し側で左右反転済み
   */
  addBalloon(frontSource, backSource, opt = {}) {
    // くねり：魚と同じ式を MeshPhysicalMaterial の頂点処理に差し込む（表裏で同じ uniform を共有）
    const wag = {
      uTime: { value: 0 }, uSpeed: { value: 3 }, uWaveLength: { value: 2.6 },
      uMaxAmp: { value: 0.12 }, uPhase0: { value: Math.random() * 6.28 },
    };
    const textures = [];
    const makeMat = (src) => {
      const map = new THREE.Texture(src);
      map.colorSpace = THREE.SRGBColorSpace;
      map.anisotropy = 4;
      map.needsUpdate = true;
      textures.push(map);
      const mat = new THREE.MeshPhysicalMaterial({
        map, alphaMap: this.balloonMask, alphaTest: 0.5,
        roughness: 0.42, clearcoat: 0.8, clearcoatRoughness: 0.22, envMapIntensity: 0.75,
      });
      mat.onBeforeCompile = (sh) => {
        Object.assign(sh.uniforms, wag);
        sh.vertexShader = "uniform float uTime, uSpeed, uWaveLength, uMaxAmp, uPhase0;\n" +
          sh.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>
            { float wx = uv.x;   // 0=頭, 1=尾
              transformed.z += sin(uTime * uSpeed - wx * uWaveLength + uPhase0) * wx * wx * uMaxAmp; }`);
      };
      return mat;
    };
    const fm = makeMat(frontSource), bm = makeMat(backSource);
    const group = new THREE.Group();
    group.add(new THREE.Mesh(this.balloonGeo.front, fm), new THREE.Mesh(this.balloonGeo.back, bm));
    return this._addCreature(group, wag, () => {
      textures.forEach((t) => t.dispose()); fm.dispose(); bm.dispose();
    }, opt, { cruise: 0.6 + Math.random() * 0.4, bob: 0.12 });
  }

  _addCreature(obj, u, dispose, opt, extra) {
    obj.rotation.order = "YZX";
    const sizeK = 0.85 + Math.random() * 0.3;
    obj.scale.setScalar(this.fishSize * sizeK);
    this.scene.add(obj);

    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.45),
      new THREE.MeshBasicMaterial({ map: this.shadowTex, transparent: true, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.visible = !this.cameraMode;
    this.scene.add(shadow);

    const b = this.bounds;
    const f = {
      id: opt.id, obj, u, shadow, sizeK, dispose,
      pos: opt.spawn ? new THREE.Vector3(0, 0, 3)
        : new THREE.Vector3((Math.random() * 2 - 1) * b.x, (Math.random() * 2 - 1) * b.y,
          b.zMin + Math.random() * (b.zMax - b.zMin)),
      vel: new THREE.Vector3(Math.random() < 0.5 ? -1 : 1, 0, 0),
      target: new THREE.Vector3(),
      cruise: extra.cruise, bob: extra.bob, bobPh: Math.random() * 6.28,
      retargetAt: 0, yaw: 0, pitch: 0,
      born: opt.spawn ? this.time : -10,
    };
    this._retarget(f);
    this.fish.push(f);
    if (opt.spawn) this.burst(f.pos, 30);
    return f;
  }

  removeFish(id) {
    const i = this.fish.findIndex((f) => f.id === id);
    if (i < 0) return;
    const f = this.fish[i];
    this.scene.remove(f.obj, f.shadow);
    f.dispose();
    f.shadow.geometry.dispose(); f.shadow.material.dispose();
    this.fish.splice(i, 1);
  }

  _retarget(f) {
    const b = this.bounds;
    f.target.set((Math.random() * 2 - 1) * b.x, (Math.random() * 2 - 1) * b.y,
      b.zMin + Math.random() * (b.zMax - b.zMin));
    f.retargetAt = this.time + 4 + Math.random() * 5;
  }

  _swim(f, dt) {
    const b = this.bounds, p = f.pos;
    if (this.time > f.retargetAt || p.distanceTo(f.target) < 0.7) this._retarget(f);
    // 壁の手前で反転：外向きに進んでいたら反対側に目標を置き直す
    const wall = (v, lim) => Math.abs(v) > lim;
    if ((wall(p.x, b.x) && Math.sign(f.vel.x) === Math.sign(p.x)) ||
        (wall(p.y, b.y) && Math.sign(f.vel.y) === Math.sign(p.y))) {
      this._retarget(f);
      if (wall(p.x, b.x)) f.target.x = -Math.sign(p.x) * Math.abs(f.target.x);
      if (wall(p.y, b.y)) f.target.y = -Math.sign(p.y) * Math.abs(f.target.y);
    }
    const desired = f.target.clone().sub(p);
    desired.y *= 0.6;                       // 上下はゆるめ（魚らしく水平寄り）
    desired.normalize().multiplyScalar(f.cruise);
    f.vel.lerp(desired, 1 - Math.exp(-dt * 0.9));
    p.addScaledVector(f.vel, dt);
    p.z = THREE.MathUtils.clamp(p.z, b.zMin - 0.5, b.zMax + 2);

    // 向き。メッシュの頭は -X 方向（uv.x=0）
    const yaw = Math.atan2(f.vel.z, -f.vel.x);
    let d = yaw - f.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    f.yaw += d * (1 - Math.exp(-dt * 3));
    const h = Math.hypot(f.vel.x, f.vel.z);
    const pitch = THREE.MathUtils.clamp(-Math.atan2(f.vel.y, h), -MAX_PITCH, MAX_PITCH);
    f.pitch += (pitch - f.pitch) * (1 - Math.exp(-dt * 3));
  }

  _tick() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.time += dt;
    this.bgMat.uniforms.uTime.value = this.time;

    for (const f of this.fish) {
      const age = this.time - f.born;
      if (age > 0.9) this._swim(f, dt);
      const pop = age < 0.9 ? easeOutBack(Math.max(0, age) / 0.9) : 1;   // 放たれる瞬間（ar-popup 流用）
      f.obj.position.copy(f.pos);
      // バルーンはふわふわ上下して、ゆっくり傾く
      f.obj.position.y += Math.sin(this.time * 0.9 + f.bobPh) * f.bob;
      f.obj.rotation.set(Math.sin(this.time * 0.7 + f.bobPh) * f.bob * 0.8, f.yaw, f.pitch);
      f.obj.scale.setScalar(this.fishSize * f.sizeK * Math.max(0.001, pop));
      const u = f.u;
      u.uTime.value = this.time;
      u.uSpeed.value = 3 + f.vel.length() * 3.5;

      // 床の影：高いほど薄く大きく
      const height = f.pos.y - this.floor.position.y;
      f.shadow.position.set(f.pos.x, this.floor.position.y + 0.01, f.pos.z);
      const s = this.fishSize * f.sizeK * (0.7 + height * 0.08) * pop;
      f.shadow.scale.set(s, s, 1);
      f.shadow.material.opacity = THREE.MathUtils.clamp(1.1 - height * 0.12, 0.2, 0.9);
    }

    const arr = this.bubbles.geometry.attributes.position.array;
    for (let i = 0; i < this.bubbleData.length; i++) {
      const bb = this.bubbleData[i];
      bb.y += bb.v * dt;
      bb.x += Math.sin(this.time * 2 + bb.ph) * 0.004;
      if (bb.y > this.bounds.y + 3) this.bubbleData[i] = this._newBubble(false);
      arr[i * 3] = bb.x; arr[i * 3 + 1] = bb.y; arr[i * 3 + 2] = bb.z;
    }
    this.bubbles.geometry.attributes.position.needsUpdate = true;

    this.renderer.render(this.scene, this.camera);
  }
}
