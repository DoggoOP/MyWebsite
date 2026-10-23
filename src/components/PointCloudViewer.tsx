import './PointCloudViewer.css';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import { Airflow, type FlowMode } from './airflow';

interface PointCloudViewerProps {
  src: string;
  className?: string;
  filter?: boolean;
  airflow?: boolean;
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

export default function PointCloudViewer({ src, className, filter = true, airflow = false }: PointCloudViewerProps) {
  const [flowMode, setFlowMode] = useState<FlowMode>('pressure');
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<{
    renderer?: THREE.WebGLRenderer;
    animId?: number;
    material?: THREE.ShaderMaterial;
    controls?: TrackballControls;
    autoRotating: boolean;
    initialPos?: THREE.Vector3;
    initialTarget?: THREE.Vector3;
    scene?: THREE.Scene;
    camera?: THREE.PerspectiveCamera;
    darkBg: boolean;
  }>({ darkBg: false, autoRotating: false });

  const statusRef = useRef<HTMLDivElement>(null);
  const uiRef = useRef<HTMLDivElement>(null);
  const autoRotateBtnRef = useRef<HTMLButtonElement>(null);
  const bgBtnRef = useRef<HTMLButtonElement>(null);
  const flowControlRef = useRef<Airflow | null>(null);
  const flowSpeedRef = useRef(1);
  const flowDirectionRef = useRef<1 | -1>(1);
  const speedReadoutRef = useRef<HTMLOutputElement>(null);
  const directionBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!mountRef.current) return;
    const container = mountRef.current;
    const s = stateRef.current;
    const flowCanvas = airflow ? document.getElementById('flow-canvas') as HTMLCanvasElement | null : null;
    const flow = flowCanvas ? new Airflow(flowCanvas) : null;
    flowControlRef.current = flow;
    flow?.setFlow(flowSpeedRef.current, flowDirectionRef.current);
    let modelPositions: Float32Array | null = null;
    let frame = 0;
    let lastFlow = 0;
    const card = document.getElementById('bio-card');
    const onPointerMove = (event: PointerEvent) => flow?.pointerMove(event.clientX, event.clientY);
    const onPointerOut = (event: PointerEvent) => { if (!event.relatedTarget) flow?.pointerLeave(); };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerout', onPointerOut);

    const scene = new THREE.Scene();
    scene.background = null;
    s.scene = scene;

    const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.01, 100);
    camera.position.set(0, 1, 3);
    s.camera = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);
    s.renderer = renderer;

    const controls = new TrackballControls(camera, renderer.domElement);
    controls.rotateSpeed = 2.5;
    controls.zoomSpeed = 1.2;
    controls.panSpeed = 0.8;
    controls.dynamicDampingFactor = 0.15;
    s.controls = controls;

    scene.add(new THREE.AmbientLight(0xffffff, 0.8));

    const animate = () => {
      s.animId = requestAnimationFrame(animate);
      // Z is the scan's up axis, so optional rotation stays upright.
      if (s.autoRotating && s.camera && s.controls) {
        const target = s.controls.target;
        const pos = s.camera.position;
        const dx = pos.x - target.x;
        const dy = pos.y - target.y;
        const angle = 0.0008;
        const cos = Math.cos(angle), sin = Math.sin(angle);
        s.camera.position.x = target.x + dx * cos - dy * sin;
        s.camera.position.y = target.y + dx * sin + dy * cos;
      }
      controls.update();
      if (flow && performance.now() - lastFlow > 30) {
        if (++frame % 6 === 0) flow.updateObstacles(modelPositions, camera,
          container.getBoundingClientRect(), card?.getBoundingClientRect() || null);
        flow.step();
        lastFlow = performance.now();
      }
      renderer.render(scene, camera);
    };
    animate();

    const onResize = () => {
      if (!container) return;
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
      controls.handleResize();
      flow?.resize();
      flow?.updateObstacles(modelPositions, camera, container.getBoundingClientRect(), card?.getBoundingClientRect() || null);
    };
    window.addEventListener('resize', onResize);

    Promise.all([fetch(src), fetch('/assets/3dImage-surfels.bin')])
      .then(async ([scanResponse, axesResponse]) => {
        if (!scanResponse.ok || !axesResponse.ok) throw new Error('Scan asset could not be loaded');
        return [await scanResponse.arrayBuffer(), await axesResponse.arrayBuffer()] as const;
      })
      .then(([buffer, axesBuffer]) => {
        const data = parseLssnap(buffer);
        const axisCount = new DataView(axesBuffer).getUint32(0, true);
        if (axisCount !== data.vertexCount) throw new Error('Scan and splat geometry do not match');
        const packedAxes = new Int16Array(axesBuffer, 4);

        let finalPositions: Float32Array;
        let finalColors: Float32Array;
        let selectedIndices: number[] | null = null;

        if (filter) {
          // ── Filter to right-side person (highlighted quadrant) ──────────────
          const tmpGeo = new THREE.BufferGeometry();
          tmpGeo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
          tmpGeo.computeBoundingBox();
          const fullBox = tmpGeo.boundingBox!;
          const fullCenter = new THREE.Vector3();
          fullBox.getCenter(fullCenter);
          const fullSize = new THREE.Vector3();
          fullBox.getSize(fullSize);

          const xCut = fullCenter.x;
          const yCutMax = fullBox.min.y + fullSize.y * 0.5;
          const filtPos: number[] = [], filtCol: number[] = [];
          selectedIndices = [];
          for (let vi = 0; vi < data.vertexCount; vi++) {
            const x = data.positions[vi*3];
            const y = data.positions[vi*3+1];
            const z = data.positions[vi*3+2];
            if (x >= xCut && y >= yCutMax) {
              filtPos.push(x, y, z);
              filtCol.push(data.colors[vi*3], data.colors[vi*3+1], data.colors[vi*3+2]);
              selectedIndices.push(vi);
            }
          }
          finalPositions = new Float32Array(filtPos);
          finalColors    = new Float32Array(filtCol);
        } else {
          finalPositions = data.positions;
          finalColors    = data.colors;
        }
        modelPositions = finalPositions;

        const count = finalPositions.length / 3;
        const axisA = new Float32Array(count * 3);
        const axisB = new Float32Array(count * 3);
        for (let vi = 0; vi < count; vi++) {
          const original = selectedIndices ? selectedIndices[vi] : vi;
          for (let component = 0; component < 3; component++) {
            axisA[vi * 3 + component] = packedAxes[original * 6 + component] / 10000;
            axisB[vi * 3 + component] = packedAxes[original * 6 + component + 3] / 10000;
          }
        }
        const geo = new THREE.InstancedBufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute([
          -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0,
        ], 3));
        geo.setIndex([0, 1, 2, 0, 2, 3]);
        geo.setAttribute('instanceCenter', new THREE.InstancedBufferAttribute(finalPositions, 3));
        geo.setAttribute('instanceColor', new THREE.InstancedBufferAttribute(finalColors, 3));
        geo.setAttribute('instanceAxisA', new THREE.InstancedBufferAttribute(axisA, 3));
        geo.setAttribute('instanceAxisB', new THREE.InstancedBufferAttribute(axisB, 3));
        geo.instanceCount = count;
        // PCA tangent axes form geometric ellipses. Their projection changes with the camera.
        const mat = new THREE.ShaderMaterial({
          uniforms: { uSplatSize: { value: 0.6 } },
          vertexShader: `
            attribute vec3 instanceCenter;
            attribute vec3 instanceColor;
            attribute vec3 instanceAxisA;
            attribute vec3 instanceAxisB;
            varying vec3 vColor;
            varying vec2 vLocal;
            varying float vFacing;
            uniform float uSplatSize;
            void main() {
              vColor = instanceColor;
              vLocal = position.xy;
              vec3 normal = normalize(cross(instanceAxisA, instanceAxisB));
              vFacing = abs(dot(normal, normalize(cameraPosition - instanceCenter)));
              vec3 splatPosition = instanceCenter
                + uSplatSize * (instanceAxisA * position.x + instanceAxisB * position.y);
              gl_Position = projectionMatrix * modelViewMatrix * vec4(splatPosition, 1.0);
            }
          `,
          fragmentShader: `
            varying vec3 vColor;
            varying vec2 vLocal;
            varying float vFacing;
            void main() {
              float radius2 = dot(vLocal, vLocal);
              float alpha = exp(-radius2 * 2.4) * 0.62;
              alpha *= mix(0.82, 1.0, smoothstep(0.05, 0.45, vFacing));
              if (alpha < 0.045) discard;
              gl_FragColor = vec4(vColor, alpha);
            }
          `,
          transparent: true,
          depthTest: true,
          depthWrite: false,
          blending: THREE.NormalBlending,
          side: THREE.DoubleSide,
        });
        s.material = mat;
        const pc = new THREE.Mesh(geo, mat);
        pc.frustumCulled = false;
        scene.add(pc);

        const bounds = new THREE.BufferGeometry();
        bounds.setAttribute('position', new THREE.BufferAttribute(finalPositions, 3));
        bounds.computeBoundingBox();
        const box = bounds.boundingBox!;
        const center = new THREE.Vector3();
        box.getCenter(center);
        const size = new THREE.Vector3();
        box.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z);
        controls.target.set(center.x, center.y, center.z + maxDim * 0.08);
        camera.up.set(0, 0, 1);
        // A raised near-frontal camera accounts for the scan's leaning pose.
        camera.position.set(center.x - maxDim * 0.12, center.y - maxDim * 1.85, center.z + maxDim * 1.58);
        camera.filmOffset = -8;
        camera.updateProjectionMatrix();
        camera.lookAt(controls.target);
        controls.update();
        flow?.updateObstacles(modelPositions, camera, container.getBoundingClientRect(), card?.getBoundingClientRect() || null);
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

        if (statusRef.current) statusRef.current.style.display = 'none';
        if (uiRef.current) uiRef.current.style.display = 'flex';
      })
      .catch(err => {
        if (statusRef.current) statusRef.current.textContent = 'Error: ' + err.message;
      });

    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerout', onPointerOut);
      flowControlRef.current = null;
      if (s.animId) cancelAnimationFrame(s.animId);
      controls.dispose();
      renderer.dispose();
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
    };
  }, [src, filter, airflow]);

  const handlePointSize = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (stateRef.current.material) stateRef.current.material.uniforms.uSplatSize.value = parseFloat(e.target.value);
  };

  const handleBgToggle = () => {
    const s = stateRef.current;
    s.darkBg = !s.darkBg;
    if (s.scene) s.scene.background = s.darkBg ? new THREE.Color(0x101a20) : null;
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
    s.autoRotating = !s.autoRotating;
    if (autoRotateBtnRef.current)
      autoRotateBtnRef.current.textContent = 'Auto-Rotate: ' + (s.autoRotating ? 'ON' : 'OFF');
  };

  const handleFlowSpeed = (event: React.ChangeEvent<HTMLInputElement>) => {
    flowSpeedRef.current = Number(event.target.value);
    flowControlRef.current?.setFlow(flowSpeedRef.current, flowDirectionRef.current);
    if (speedReadoutRef.current) speedReadoutRef.current.value = `${flowSpeedRef.current.toFixed(1)}×`;
  };

  const handleFlowDirection = () => {
    flowDirectionRef.current = flowDirectionRef.current === 1 ? -1 : 1;
    flowControlRef.current?.setFlow(flowSpeedRef.current, flowDirectionRef.current);
    if (directionBtnRef.current) directionBtnRef.current.textContent = `Flow ${flowDirectionRef.current === 1 ? '→' : '←'}`;
  };

  const handleFlowMode = (mode: FlowMode) => {
    setFlowMode(mode);
    flowControlRef.current?.setMode(mode);
    const name = document.getElementById('flow-key-mode');
    const low = document.getElementById('flow-key-low');
    const high = document.getElementById('flow-key-high');
    if (name) name.textContent = mode === 'pressure' ? 'Projection pressure' : mode === 'vorticity' ? 'Vorticity' : 'Flow speed';
    if (low) low.textContent = mode === 'vorticity' ? 'CW' : mode === 'speed' ? 'slow' : 'low';
    if (high) high.textContent = mode === 'vorticity' ? 'CCW' : mode === 'speed' ? 'fast' : 'high';
  };

  return (
    <div className={`pcv-wrapper ${className || ''}`}>
      <div ref={mountRef} className="pcv-canvas" />
      <div ref={statusRef} className="pcv-status">Loading point cloud…</div>
      <div ref={uiRef} className="pcv-controls" style={{ display: 'none' }}>
        {airflow && <label className="pcv-flow-speed">Air speed
          <input type="range" min="0.4" max="2" step="0.1" defaultValue="1" onChange={handleFlowSpeed} aria-label="Airflow speed" />
          <output ref={speedReadoutRef}>1.0×</output>
        </label>}
        {airflow && <button onClick={handleFlowDirection} ref={directionBtnRef} className="pcv-btn" aria-label="Reverse airflow direction">Flow →</button>}
        {airflow && <div className="pcv-flow-modes" role="group" aria-label="Flow visualization">
          {(['pressure', 'vorticity', 'speed'] as FlowMode[]).map(mode =>
            <button key={mode} className={`pcv-btn ${flowMode === mode ? 'is-active' : ''}`} aria-pressed={flowMode === mode} onClick={() => handleFlowMode(mode)}>{mode === 'pressure' ? 'Pressure' : mode === 'vorticity' ? 'Vorticity' : 'Speed'}</button>
          )}
        </div>}
        <label className="pcv-label">Surfel Size</label>
        <input type="range" min="0.15" max="0.9" step="0.05" defaultValue="0.6" onChange={handlePointSize} className="pcv-slider" aria-label="Surfel footprint size" />
        <button onClick={handleBgToggle} ref={bgBtnRef} className="pcv-btn">Dark Bg</button>
        <button onClick={handleReset} className="pcv-btn">Reset</button>
        <button onClick={handleAutoRotate} ref={autoRotateBtnRef} className="pcv-btn">Auto-Rotate: OFF</button>
      </div>
    </div>
  );
}
