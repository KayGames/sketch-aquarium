// 水槽シーン（仕様 §3[8], §6-5）
import * as THREE from "three";

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
  uniform float uTime;
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
    c += r * vec3(0.55, 0.85, 0.9) * smoothstep(0.15, 1.0, vUv.y) * 0.45;
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

export class Aquarium {
  constructor(container, maskImage) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    this.camera.position.set(0, 1.0, 10);
    this.camera.lookAt(0, 0, 0);

    this.mask = new THREE.Texture(maskImage);
    this.mask.needsUpdate = true;
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
      uniforms: { uTime: { value: 0 } }, vertexShader: PASS_VERT, fragmentShader: BG_FRAG, depthWrite: false,
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
    for (const f of this.fish) f.mesh.scale.setScalar(this.fishSize * f.sizeK);
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
    mesh.rotation.order = "YZX";
    const sizeK = 0.85 + Math.random() * 0.3;
    mesh.scale.setScalar(this.fishSize * sizeK);
    this.scene.add(mesh);

    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.45),
      new THREE.MeshBasicMaterial({ map: this.shadowTex, transparent: true, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2;
    this.scene.add(shadow);

    const b = this.bounds;
    const f = {
      id: opt.id, mesh, shadow, mat, sizeK,
      pos: opt.spawn ? new THREE.Vector3(0, 0, 3)
        : new THREE.Vector3((Math.random() * 2 - 1) * b.x, (Math.random() * 2 - 1) * b.y,
          b.zMin + Math.random() * (b.zMax - b.zMin)),
      vel: new THREE.Vector3(Math.random() < 0.5 ? -1 : 1, 0, 0),
      target: new THREE.Vector3(),
      cruise: 0.9 + Math.random() * 0.6,
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
    this.scene.remove(f.mesh, f.shadow);
    f.mesh.geometry.dispose(); f.mat.uniforms.uMap.value.dispose(); f.mat.dispose();
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
      f.mesh.position.copy(f.pos);
      f.mesh.rotation.set(0, f.yaw, f.pitch);
      f.mesh.scale.setScalar(this.fishSize * f.sizeK * Math.max(0.001, pop));
      const u = f.mat.uniforms;
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
