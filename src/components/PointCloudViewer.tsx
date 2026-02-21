import './PointCloudViewer.css';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

interface PointCloudViewerProps {
  src: string;
  className?: string;
}

interface Annotation {
  type: 'point' | 'circle' | 'freehand';
  positions: number[];
  radius?: number;
  color?: [number, number, number];
}

interface LssnapData {
  vertexCount: number;
  positions: Float32Array;
  colors: Float32Array;
  annotations: Annotation[];
}

function parseLssnap(buffer: ArrayBuffer): LssnapData {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2));
  const version = view.getUint8(3);
  if (magic !== 'LSS' || version !== 1) {
    throw new Error('Not a valid .lssnap file (magic: ' + magic + version + ')');
  }
  const vertexCount = view.getInt32(4, true);
  const annotJsonLen = view.getInt32(8, true);
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  let offset = 16;
  for (let i = 0; i < vertexCount; i++) {
    positions[i * 3]     = view.getInt16(offset,     true) / 1000.0;
    positions[i * 3 + 1] = view.getInt16(offset + 2, true) / 1000.0;
    positions[i * 3 + 2] = view.getInt16(offset + 4, true) / 1000.0;
    colors[i * 3]     = view.getUint8(offset + 6) / 255.0;
    colors[i * 3 + 1] = view.getUint8(offset + 7) / 255.0;
    colors[i * 3 + 2] = view.getUint8(offset + 8) / 255.0;
    offset += 9;
  }
  let annotations: Annotation[] = [];
  if (annotJsonLen > 0) {
    try {
      const annotStr = new TextDecoder().decode(new Uint8Array(buffer, offset, annotJsonLen));
      annotations = JSON.parse(annotStr);
    } catch { /* ignore bad annotations */ }
  }
  return { vertexCount, positions, colors, annotations };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

export default function PointCloudViewer({ src, className }: PointCloudViewerProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<{
    renderer?: THREE.WebGLRenderer;
    animId?: number;
    material?: THREE.PointsMaterial;
    controls?: OrbitControls;
    initialPos?: THREE.Vector3;
    initialTarget?: THREE.Vector3;
    scene?: THREE.Scene;
    camera?: THREE.PerspectiveCamera;
    darkBg: boolean;
  }>({ darkBg: false });

  const statVertsRef = useRef<HTMLSpanElement>(null);
  const statAnnotsRef = useRef<HTMLSpanElement>(null);
  const statSizeRef = useRef<HTMLSpanElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const uiRef = useRef<HTMLDivElement>(null);
  const autoRotateBtnRef = useRef<HTMLButtonElement>(null);
  const bgBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!mountRef.current) return;
    const container = mountRef.current;
    const s = stateRef.current;

    const scene = new THREE.Scene();
    scene.background = null; // transparent — fluid canvas shows through
    s.scene = scene;

    const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.01, 100);
    camera.position.set(0, 1, 3);
    s.camera = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);
    s.renderer = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.25;
    s.controls = controls;

    scene.add(new THREE.AmbientLight(0xffffff, 0.8));

    const animate = () => {
      s.animId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const onResize = () => {
      if (!container) return;
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    };
    window.addEventListener('resize', onResize);

    let byteLength = 0;
    fetch(src)
      .then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        byteLength = parseInt(r.headers.get('content-length') || '0');
        return r.arrayBuffer();
      })
      .then(buffer => {
        byteLength = byteLength || buffer.byteLength;
        const data = parseLssnap(buffer);

        // ── Filter to right-side person (highlighted quadrant) ──────────────
        const tmpGeo = new THREE.BufferGeometry();
        tmpGeo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
        tmpGeo.computeBoundingBox();
        const fullBox = tmpGeo.boundingBox!;
        const fullCenter = new THREE.Vector3();
        fullBox.getCenter(fullCenter);
        const fullSize = new THREE.Vector3();
        fullBox.getSize(fullSize);

        // right 50%: x >= center_x
        // back 55%:  z >= min_z + 45% of z-range
        // bottom 70%: y <= min_y + 70% of y-range
        const xCut = fullCenter.x;
        const zCut = fullBox.min.z + fullSize.z * 0.75;
        const yCutMax = fullBox.min.y + fullSize.y * 0.45;
        const filtPos: number[] = [], filtCol: number[] = [];
        for (let vi = 0; vi < data.vertexCount; vi++) {
          const x = data.positions[vi*3];
          const y = data.positions[vi*3+1];
          const z = data.positions[vi*3+2];
          if (x >= xCut && z <= zCut && y >= yCutMax) {
            filtPos.push(x, y, z);
            filtCol.push(data.colors[vi*3], data.colors[vi*3+1], data.colors[vi*3+2]);
          }
        }
        const filtPositions = new Float32Array(filtPos);
        const filtColors    = new Float32Array(filtCol);

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(filtPositions, 3));
        geo.setAttribute('color',    new THREE.BufferAttribute(filtColors, 3));
        const mat = new THREE.PointsMaterial({ size: 3, vertexColors: true, sizeAttenuation: false });
        s.material = mat;
        const pc = new THREE.Points(geo, mat);
        scene.add(pc);

        geo.computeBoundingBox();
        const box = geo.boundingBox!;
        const center = new THREE.Vector3();
        box.getCenter(center);
        const size = new THREE.Vector3();
        box.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z);
        controls.target.copy(center);
        // Slightly elevated, frontal — farther back so model fits the card height
        camera.position.set(center.x - maxDim * 0.1, center.y + maxDim * 0.25, center.z + maxDim * 1.6);
        camera.lookAt(center);
        controls.update();
        s.initialPos = camera.position.clone();
        s.initialTarget = controls.target.clone();

        const annGroup = new THREE.Group();
        for (const ann of data.annotations) {
          if (!ann.positions || ann.positions.length < 3) continue;
          const r = ann.color ? ann.color[0] / 255 : 1;
          const g = ann.color ? ann.color[1] / 255 : 0.4;
          const b = ann.color ? ann.color[2] / 255 : 0.4;
          const color = new THREE.Color(r, g, b);
          if (ann.type === 'point') {
            const radius = (ann.radius && ann.radius > 0.01) ? ann.radius : 0.12;
            const mesh = new THREE.Mesh(
              new THREE.SphereGeometry(radius * 0.3, 12, 8),
              new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7 })
            );
            mesh.position.set(ann.positions[0], ann.positions[1], ann.positions[2]);
            annGroup.add(mesh);
          } else if (ann.type === 'circle') {
            const radius = (ann.radius && ann.radius > 0) ? ann.radius : 0.05;
            const pts = Array.from({ length: 65 }, (_, i) => {
              const theta = (i / 64) * Math.PI * 2;
              return new THREE.Vector3(
                ann.positions[0] + Math.cos(theta) * radius,
                ann.positions[1] + Math.sin(theta) * radius,
                ann.positions[2]
              );
            });
            annGroup.add(new THREE.Line(
              new THREE.BufferGeometry().setFromPoints(pts),
              new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 })
            ));
          } else if (ann.type === 'freehand' && ann.positions.length >= 6) {
            const pts = [];
            for (let i = 0; i < ann.positions.length; i += 3)
              pts.push(new THREE.Vector3(ann.positions[i], ann.positions[i + 1], ann.positions[i + 2]));
            annGroup.add(new THREE.Line(
              new THREE.BufferGeometry().setFromPoints(pts),
              new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 })
            ));
          }
        }
        scene.add(annGroup);

        if (statVertsRef.current) statVertsRef.current.textContent = data.vertexCount.toLocaleString();
        if (statAnnotsRef.current) statAnnotsRef.current.textContent = String(data.annotations.length);
        if (statSizeRef.current) statSizeRef.current.textContent = formatBytes(byteLength);
        if (statusRef.current) statusRef.current.style.display = 'none';
        if (uiRef.current) uiRef.current.style.display = 'flex';
      })
      .catch(err => {
        if (statusRef.current) statusRef.current.textContent = 'Error: ' + err.message;
      });

    return () => {
      window.removeEventListener('resize', onResize);
      if (s.animId) cancelAnimationFrame(s.animId);
      renderer.dispose();
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
    };
  }, [src]);

  const handlePointSize = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (stateRef.current.material) stateRef.current.material.size = parseFloat(e.target.value);
  };

  const handleBgToggle = () => {
    const s = stateRef.current;
    s.darkBg = !s.darkBg;
    if (s.scene) s.scene.background = s.darkBg ? new THREE.Color(0x0a0a0f) : null;
    if (bgBtnRef.current) bgBtnRef.current.textContent = s.darkBg ? 'Clear' : 'Dark';
  };

  const handleReset = () => {
    const s = stateRef.current;
    if (s.camera && s.controls && s.initialPos && s.initialTarget) {
      s.camera.position.copy(s.initialPos);
      s.controls.target.copy(s.initialTarget);
      s.controls.update();
    }
  };

  const handleAutoRotate = () => {
    const s = stateRef.current;
    if (s.controls) {
      s.controls.autoRotate = !s.controls.autoRotate;
      if (autoRotateBtnRef.current)
        autoRotateBtnRef.current.textContent = 'Auto-Rotate: ' + (s.controls.autoRotate ? 'ON' : 'OFF');
    }
  };

  return (
    <div className={`pcv-wrapper ${className || ''}`}>
      <div ref={mountRef} className="pcv-canvas" />
      <div ref={statusRef} className="pcv-status">Loading point cloud…</div>
      <div className="pcv-stats">
        <span className="pcv-stats-title">Ethan Kong · 3D Scan</span>
        <span className="pcv-stats-row">
          <span ref={statVertsRef}>—</span> verts &nbsp;·&nbsp;
          <span ref={statAnnotsRef}>—</span> annotations &nbsp;·&nbsp;
          <span ref={statSizeRef}>—</span>
        </span>
        <span className="pcv-stats-hint">Drag · Scroll · Right-drag to pan</span>
      </div>
      <div ref={uiRef} className="pcv-controls" style={{ display: 'none' }}>
        <label className="pcv-label">Point Size</label>
        <input type="range" min="1" max="5" step="0.5" defaultValue="3" onChange={handlePointSize} className="pcv-slider" />
        <button onClick={handleBgToggle} ref={bgBtnRef} className="pcv-btn">Dark Bg</button>
        <button onClick={handleReset} className="pcv-btn">Reset</button>
        <button onClick={handleAutoRotate} ref={autoRotateBtnRef} className="pcv-btn">Auto-Rotate: ON</button>
      </div>
    </div>
  );
}
