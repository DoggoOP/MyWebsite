import './PointCloudViewer.css';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import { Airflow, type FlowMode } from './airflow';
import { ParticleLife, SPECIES, DEFAULT_FORCES } from './particleLife';

interface PointCloudViewerProps {
  src: string;
  axesSrc?: string;
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

function flowDirectionLabel(vertical: boolean, direction: 1 | -1) {
  return `Flow ${vertical ? (direction === 1 ? '↓' : '↑') : (direction === 1 ? '→' : '←')}`;
}

async function fetchAsset(url: string, signal: AbortSignal, onProgress: (loaded: number, total: number) => void) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Could not load ${url}`);
  const total = Number(response.headers.get('content-length')) || 0;
  onProgress(0, total);
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    onProgress(buffer.byteLength, total || buffer.byteLength);
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  onProgress(loaded, total || loaded);
  return bytes.buffer;
}

export default function PointCloudViewer({ src, axesSrc = '/assets/3dImage-surfels.bin', className, filter = true, airflow = false }: PointCloudViewerProps) {
  const [flowMode, setFlowMode] = useState<FlowMode>('vorticity');
  const [sceneMode, setSceneMode] = useState<'particles' | 'flow'>('flow');
  const sceneModeRef = useRef<'particles' | 'flow'>('flow');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dockOpen, setDockOpen] = useState(false);
  const [particleCount, setParticleCount] = useState(1300);
  const [particleRadius, setParticleRadius] = useState(58);
  const [particleStrength, setParticleStrength] = useState(1);
  const [particleFriction, setParticleFriction] = useState(0.08);
  const [forceMatrix, setForceMatrix] = useState(DEFAULT_FORCES.map(row => [...row]));
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<{
    animId?: number;
  }>({});

  const statusRef = useRef<HTMLDivElement>(null);
  const uiRef = useRef<HTMLDivElement>(null);
  const flowControlRef = useRef<Airflow | null>(null);
  const particleControlRef = useRef<ParticleLife | null>(null);
  const flowSpeedRef = useRef(1.25);
  const flowDirectionRef = useRef<1 | -1>(1);
  const speedReadoutRef = useRef<HTMLOutputElement>(null);
  const directionBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!mountRef.current) return;
    const container = mountRef.current;
    const s = stateRef.current;
    const flowCanvas = airflow ? document.getElementById('flow-canvas') as HTMLCanvasElement | null : null;
    const flow = flowCanvas ? new Airflow(flowCanvas) : null;
    const particles = flowCanvas ? new ParticleLife(flowCanvas) : null;
    flowControlRef.current = flow;
    particleControlRef.current = particles;
    flow?.setFlow(flowSpeedRef.current, flowDirectionRef.current);
    if (directionBtnRef.current && flow)
      directionBtnRef.current.textContent = flowDirectionLabel(flow.isVertical(), flowDirectionRef.current);
    let modelPositions: Float32Array | null = null;
    let sortSurfels: (() => void) | null = null;
    let lastSort = 0;
    const lastSortedPos = new THREE.Vector3();
    const lastSortedQuat = new THREE.Quaternion();
    let frame = 0;
    let lastFlow = 0;
    let modelReady = false;
    const card = document.getElementById('bio-card');
    const onPointerMove = (event: PointerEvent) => {
      if (sceneModeRef.current === 'flow') flow?.pointerMove(event.clientX, event.clientY);
      else particles?.pointerMove(event.clientX, event.clientY);
    };
    const onPointerOut = (event: PointerEvent) => {
      if (!event.relatedTarget) { flow?.pointerLeave(); particles?.pointerLeave(); }
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerout', onPointerOut);

    const scene = new THREE.Scene();
    scene.background = null;

    const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.01, 100);
    camera.position.set(0, 1, 3);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    const controls = new TrackballControls(camera, renderer.domElement);
    controls.rotateSpeed = 2.5;
    controls.zoomSpeed = 1.2;
    controls.panSpeed = 0.8;
    controls.dynamicDampingFactor = 0.15;
    // The homepage scan sits in a half-width canvas. Keep orbit/zoom interactive,
    // but prevent the camera from moving so close (or panning so far) that the
    // person is sliced by that canvas edge.
    controls.noPan = airflow;

    scene.add(new THREE.AmbientLight(0xffffff, 0.8));

    const animate = () => {
      s.animId = requestAnimationFrame(animate);
      controls.update();
      if (sortSurfels && performance.now() - lastSort > 120 &&
          (camera.position.distanceToSquared(lastSortedPos) > 0.0001 ||
            camera.quaternion.angleTo(lastSortedQuat) > 0.01)) {
        sortSurfels();
        lastSort = performance.now();
        lastSortedPos.copy(camera.position);
        lastSortedQuat.copy(camera.quaternion);
      }
      if (flow && performance.now() - lastFlow > (modelReady ? 30 : 90)) {
        if (++frame % 6 === 0) {
          flow.updateObstacles(modelPositions, camera,
            container.getBoundingClientRect(), card?.getBoundingClientRect() || null);
          particles?.setObstacles(flow.getObstacleMask());
        }
        if (sceneModeRef.current === 'flow') flow.step();
        else particles?.step();
        lastFlow = performance.now();
      }
      renderer.render(scene, camera);
    };
    animate();

    const onResize = () => {
      if (!container) return;
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.filmOffset = window.innerWidth <= 900 ? 0 : 4;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
      controls.handleResize();
      flow?.resize();
      particles?.resize();
      if (directionBtnRef.current && flow)
        directionBtnRef.current.textContent = flowDirectionLabel(flow.isVertical(), flowDirectionRef.current);
      flow?.updateObstacles(modelPositions, camera, container.getBoundingClientRect(), card?.getBoundingClientRect() || null);
      if (flow) particles?.setObstacles(flow.getObstacleMask());
    };
    window.addEventListener('resize', onResize);

    const loadAbort = new AbortController();
    const loaded = [0, 0];
    const totals = [0, 0];
    const loadingStatus = document.getElementById('hero-load-status');
    const loadingPercent = document.getElementById('hero-load-percent');
    const loadingProgress = document.getElementById('hero-load-progress') as HTMLProgressElement | null;
    const showProgress = (percent: number) => {
      if (statusRef.current) statusRef.current.textContent = `Loading 3D scan · ${percent}%`;
      if (loadingPercent) loadingPercent.textContent = `${percent}%`;
      if (loadingProgress) loadingProgress.value = percent;
    };
    const reportProgress = (index: number) => (bytes: number, total: number) => {
      loaded[index] = bytes;
      totals[index] = total || totals[index];
      // Some hosts stream assets without Content-Length. Keep the bar moving in
      // that case, then use the exact size when each download finishes.
      const estimatedTotal = totals.reduce((sum, size, i) =>
        sum + (size || Math.max(loaded[i] + 256 * 1024, 512 * 1024)), 0);
      const percent = Math.min(90, Math.round((loaded[0] + loaded[1]) / estimatedTotal * 90));
      showProgress(percent);
    };

    Promise.all([
      fetchAsset(src, loadAbort.signal, reportProgress(0)),
      fetchAsset(axesSrc, loadAbort.signal, reportProgress(1)),
    ])
      .then(async ([buffer, axesBuffer]) => {
        showProgress(94);
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
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
        const sortedPositions = new Float32Array(finalPositions.length);
        const sortedColors = new Float32Array(finalColors.length);
        const sortedAxisA = new Float32Array(axisA.length);
        const sortedAxisB = new Float32Array(axisB.length);
        const geo = new THREE.InstancedBufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute([
          -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0,
        ], 3));
        geo.setIndex([0, 1, 2, 0, 2, 3]);
        const centerAttr = new THREE.InstancedBufferAttribute(sortedPositions, 3);
        const colorAttr = new THREE.InstancedBufferAttribute(sortedColors, 3);
        const axisAAttr = new THREE.InstancedBufferAttribute(sortedAxisA, 3);
        const axisBAttr = new THREE.InstancedBufferAttribute(sortedAxisB, 3);
        geo.setAttribute('instanceCenter', centerAttr);
        geo.setAttribute('instanceColor', colorAttr);
        geo.setAttribute('instanceAxisA', axisAAttr);
        geo.setAttribute('instanceAxisB', axisBAttr);
        geo.instanceCount = count;
        const drawOrder = Array.from({ length: count }, (_, i) => i);
        const depths = new Float32Array(count);
        const viewDirection = new THREE.Vector3();
        sortSurfels = () => {
          camera.getWorldDirection(viewDirection);
          for (let i = 0; i < count; i++) {
            const offset = i * 3;
            depths[i] = (finalPositions[offset] - camera.position.x) * viewDirection.x
              + (finalPositions[offset + 1] - camera.position.y) * viewDirection.y
              + (finalPositions[offset + 2] - camera.position.z) * viewDirection.z;
          }
          // Blend distant samples first; the nearest samples finish each pixel.
          drawOrder.sort((a, b) => depths[b] - depths[a]);
          for (let i = 0; i < count; i++) {
            const source = drawOrder[i] * 3;
            const target = i * 3;
            for (let component = 0; component < 3; component++) {
              sortedPositions[target + component] = finalPositions[source + component];
              sortedColors[target + component] = finalColors[source + component];
              sortedAxisA[target + component] = axisA[source + component];
              sortedAxisB[target + component] = axisB[source + component];
            }
          }
          centerAttr.needsUpdate = true;
          colorAttr.needsUpdate = true;
          axisAAttr.needsUpdate = true;
          axisBAttr.needsUpdate = true;
        };
        // PCA tangent axes form geometric ellipses. Their projection changes with the camera.
        const splatSize = { value: 0.6 };
        const vertexShader = `
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
              vec4 centerClip = projectionMatrix * modelViewMatrix * vec4(instanceCenter, 1.0);
              vec4 splatClip = projectionMatrix * modelViewMatrix * vec4(splatPosition, 1.0);
              // A surfel is one sample: use its center depth across the entire
              // footprint so intersecting quads cannot cut holes through it.
              splatClip.z = centerClip.z * splatClip.w / centerClip.w;
              gl_Position = splatClip;
            }
          `;
        const fragmentShader = `
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
          `;
        const mat = new THREE.ShaderMaterial({
          uniforms: { uSplatSize: splatSize },
          vertexShader,
          fragmentShader,
          transparent: true,
          depthTest: true,
          depthWrite: false,
          blending: THREE.NormalBlending,
          side: THREE.DoubleSide,
        });
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
        camera.filmOffset = window.innerWidth <= 900 ? 0 : 4;
        camera.updateProjectionMatrix();
        camera.lookAt(controls.target);
        if (airflow) {
          const framingDistance = camera.position.distanceTo(controls.target);
          controls.minDistance = framingDistance * 0.88;
          controls.maxDistance = framingDistance * 1.8;
        }
        controls.update();
        sortSurfels();
        lastSort = performance.now();
        lastSortedPos.copy(camera.position);
        lastSortedQuat.copy(camera.quaternion);
        flow?.updateObstacles(modelPositions, camera, container.getBoundingClientRect(), card?.getBoundingClientRect() || null);
        if (flow) particles?.setObstacles(flow.getObstacleMask());

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

        modelReady = true;
        showProgress(100);
        if (statusRef.current) statusRef.current.style.display = 'none';
        if (loadingStatus) loadingStatus.style.display = 'none';
        if (uiRef.current) uiRef.current.style.display = 'flex';
        const flowKey = document.getElementById('flow-key');
        if (flowKey) flowKey.style.display = sceneModeRef.current === 'flow' ? '' : 'none';
      })
      .catch(err => {
        if (err.name === 'AbortError') return;
        if (statusRef.current) statusRef.current.textContent = 'Error: ' + err.message;
        if (loadingStatus) loadingStatus.textContent = '3D scan could not be loaded';
      });

    return () => {
      loadAbort.abort();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerout', onPointerOut);
      flowControlRef.current = null;
      particleControlRef.current = null;
      if (s.animId) cancelAnimationFrame(s.animId);
      controls.dispose();
      renderer.dispose();
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
    };
  }, [src, axesSrc, filter, airflow]);

  const handleFlowSpeed = (event: React.ChangeEvent<HTMLInputElement>) => {
    flowSpeedRef.current = Number(event.target.value);
    flowControlRef.current?.setFlow(flowSpeedRef.current, flowDirectionRef.current);
    if (speedReadoutRef.current) speedReadoutRef.current.value = `${flowSpeedRef.current.toFixed(2)}×`;
  };

  const handleFlowDirection = () => {
    flowDirectionRef.current = flowDirectionRef.current === 1 ? -1 : 1;
    flowControlRef.current?.setFlow(flowSpeedRef.current, flowDirectionRef.current);
    if (directionBtnRef.current)
      directionBtnRef.current.textContent = flowDirectionLabel(flowControlRef.current?.isVertical() ?? false, flowDirectionRef.current);
  };

  const handleFlowMode = (mode: FlowMode) => {
    setFlowMode(mode);
    flowControlRef.current?.setMode(mode);
    const name = document.getElementById('flow-key-mode');
    const low = document.getElementById('flow-key-low');
    const high = document.getElementById('flow-key-high');
    if (name) name.textContent = mode === 'pressure' ? 'Pressure field' : mode === 'vorticity' ? 'Vorticity' : 'Flow speed';
    if (low) low.textContent = mode === 'vorticity' ? '−' : mode === 'speed' ? 'slow' : 'low';
    if (high) high.textContent = mode === 'vorticity' ? '+' : mode === 'speed' ? 'fast' : 'high';
  };

  const handleSceneMode = (mode: 'particles' | 'flow') => {
    sceneModeRef.current = mode;
    setSceneMode(mode);
    setSettingsOpen(false);
    flowControlRef.current?.pointerLeave();
    particleControlRef.current?.pointerLeave();
    const flowKey = document.getElementById('flow-key');
    if (flowKey) flowKey.style.display = mode === 'flow' ? '' : 'none';
  };

  const handleMatrixCell = (from: number, to: number) => {
    setForceMatrix(current => {
      const updated = current.map(row => [...row]);
      const value = updated[from][to];
      updated[from][to] = value >= 0.75 ? -1 : Math.round((value + 0.5) * 2) / 2;
      particleControlRef.current?.setForce(from, to, updated[from][to]);
      return updated;
    });
  };

  return (
    <div className={`pcv-wrapper ${className || ''}`}>
      <div ref={mountRef} className="pcv-canvas" />
      <div ref={statusRef} className="pcv-status">Loading point cloud…</div>
      {airflow && <>
        {sceneMode === 'particles' && settingsOpen && <aside className="pcv-particle-settings" aria-label="Particle interaction settings">
          <div className="pcv-settings-heading"><span>Particle settings</span><button onClick={() => setSettingsOpen(false)} aria-label="Close particle settings">×</button></div>
          <label>Count <input type="range" min="300" max="3000" step="100" value={particleCount} onChange={event => { const value = Number(event.target.value); setParticleCount(value); particleControlRef.current?.setCount(value); }} /><output>{particleCount}</output></label>
          <label>Radius <input type="range" min="25" max="100" step="1" value={particleRadius} onChange={event => { const value = Number(event.target.value); setParticleRadius(value); particleControlRef.current?.setRadius(value); }} /><output>{particleRadius}px</output></label>
          <label>Force <input type="range" min="0.2" max="2" step="0.05" value={particleStrength} onChange={event => { const value = Number(event.target.value); setParticleStrength(value); particleControlRef.current?.setStrength(value); }} /><output>{particleStrength.toFixed(2)}×</output></label>
          <label>Friction <input type="range" min="0.02" max="0.4" step="0.01" value={particleFriction} onChange={event => { const value = Number(event.target.value); setParticleFriction(value); particleControlRef.current?.setFriction(value); }} /><output>{particleFriction.toFixed(2)}</output></label>
          <div className="pcv-matrix-title">Interaction matrix <span>tap a cell to adjust its force</span></div>
          <div className="pcv-matrix" role="group" aria-label="Species interaction matrix">
            <span className="pcv-matrix-corner" />
            {SPECIES.map(species => <span key={`head-${species.name}`} className="pcv-species-dot" style={{ background: species.color }} title={species.name} />)}
            {SPECIES.map((from, row) => <div className="pcv-matrix-row" key={from.name}>
              <span className="pcv-species-dot" style={{ background: from.color }} title={from.name} />
              {SPECIES.map((to, col) => {
                const value = forceMatrix[row][col];
                return <button key={to.name} type="button" onClick={() => handleMatrixCell(row, col)}
                  className={`pcv-matrix-cell ${value > 0.2 ? 'positive' : value < -0.2 ? 'negative' : 'neutral'}`}
                  aria-label={`${from.name} toward ${to.name}: ${value.toFixed(2)}; change force`}
                  title={`${from.name} → ${to.name}: ${value.toFixed(2)}`}>
                  {value > 0.2 ? '+' : value < -0.2 ? '−' : '·'}
                </button>;
              })}
            </div>)}
          </div>
        </aside>}
        <div ref={uiRef} className="pcv-dock" style={{ display: 'none' }}>
          {dockOpen && <div className="pcv-panel" id="pcv-panel" role="group" aria-label="Wind tunnel controls">
            <div className="pcv-row">
              <span className="pcv-row-label">Sim</span>
              <div className="pcv-seg">
                <button className={`pcv-btn ${sceneMode === 'flow' ? 'is-active' : ''}`} aria-pressed={sceneMode === 'flow'} onClick={() => handleSceneMode('flow')}>Flow</button>
                <button className={`pcv-btn ${sceneMode === 'particles' ? 'is-active' : ''}`} aria-pressed={sceneMode === 'particles'} onClick={() => handleSceneMode('particles')}>Particles</button>
              </div>
            </div>
            {sceneMode === 'particles'
              ? <div className="pcv-row">
                  <span className="pcv-row-label">Rules</span>
                  <button className={`pcv-btn ${settingsOpen ? 'is-active' : ''}`} aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}>{settingsOpen ? 'Hide settings' : 'Settings'}</button>
                </div>
              : <>
                  <div className="pcv-row">
                    <span className="pcv-row-label">Show</span>
                    <div className="pcv-seg">
                      {(['vorticity', 'pressure', 'speed'] as FlowMode[]).map(mode =>
                        <button key={mode} className={`pcv-btn ${flowMode === mode ? 'is-active' : ''}`} aria-pressed={flowMode === mode} onClick={() => handleFlowMode(mode)}>{mode === 'pressure' ? 'Pressure' : mode === 'vorticity' ? 'Vorticity' : 'Speed'}</button>
                      )}
                    </div>
                  </div>
                  <label className="pcv-row pcv-flow-speed">
                    <span className="pcv-row-label">Wind</span>
                    <input type="range" min="0.4" max="2" step="0.05" defaultValue={flowSpeedRef.current} onChange={handleFlowSpeed} aria-label="Airflow speed" />
                    <output ref={speedReadoutRef}>{flowSpeedRef.current.toFixed(2)}×</output>
                  </label>
                  <div className="pcv-row">
                    <span className="pcv-row-label">Direction</span>
                    <button onClick={handleFlowDirection} ref={directionBtnRef} className="pcv-btn" aria-label="Reverse airflow direction">{flowDirectionLabel(flowControlRef.current?.isVertical() ?? false, flowDirectionRef.current)}</button>
                  </div>
                </>}
          </div>}
          <button className="pcv-toggle" aria-expanded={dockOpen} aria-controls="pcv-panel" onClick={() => { setDockOpen(!dockOpen); if (dockOpen) setSettingsOpen(false); }}>
            <span className="pcv-toggle-title">Wind tunnel</span>
            <span id="flow-key" className="pcv-key" aria-hidden="true">
              <span id="flow-key-mode">Vorticity</span>
              <i className="pcv-key-low" /><span id="flow-key-low">−</span>
              <i className="pcv-key-high" /><span id="flow-key-high">+</span>
            </span>
            <span className="pcv-toggle-caret" aria-hidden="true">{dockOpen ? '×' : '+'}</span>
          </button>
        </div>
      </>}
    </div>
  );
}
