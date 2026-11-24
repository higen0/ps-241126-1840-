import * as THREE from 'three';
import type { FurniturePart } from '../types/plan';

export function roundedRectShape(w: number, d: number, r: number): THREE.Shape {
  const hw = w / 2;
  const hd = d / 2;
  const rx = Math.max(0.002, Math.min(r, hw * 0.48, hd * 0.48));
  const s = new THREE.Shape();
  s.moveTo(-hw + rx, -hd);
  s.lineTo(hw - rx, -hd);
  s.quadraticCurveTo(hw, -hd, hw, -hd + rx);
  s.lineTo(hw, hd - rx);
  s.quadraticCurveTo(hw, hd, hw - rx, hd);
  s.lineTo(-hw + rx, hd);
  s.quadraticCurveTo(-hw, hd, -hw, hd - rx);
  s.lineTo(-hw, -hd + rx);
  s.quadraticCurveTo(-hw, -hd, -hw + rx, -hd);
  return s;
}

export function ovalShape(w: number, d: number): THREE.Shape {
  const s = new THREE.Shape();
  s.absellipse(0, 0, Math.max(0.005, w / 2), Math.max(0.005, d / 2), 0, Math.PI * 2, false, 0);
  return s;
}

function fitGeometryToExactPartBounds(
  geo: THREE.BufferGeometry,
  pw: number,
  ph: number,
  pd: number
): THREE.BufferGeometry {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  if (!bb) return geo;
  const sx = bb.max.x - bb.min.x;
  const sy = bb.max.y - bb.min.y;
  const sz = bb.max.z - bb.min.z;
  const scaleX = sx > 1e-5 && Math.abs(sx - pw) > 1e-4 ? pw / sx : 1;
  const scaleY = sy > 1e-5 && Math.abs(sy - ph) > 1e-4 ? ph / sy : 1;
  const scaleZ = sz > 1e-5 && Math.abs(sz - pd) > 1e-4 ? pd / sz : 1;
  if (scaleX !== 1 || scaleY !== 1 || scaleZ !== 1) {
    geo.scale(scaleX, scaleY, scaleZ);
    geo.center();
  }
  return geo;
}

export function createExtrudedCentered(
  shape: THREE.Shape,
  height: number,
  bevelThickness = 0,
  bevelSize = 0,
  bevelSegments = 2,
  targetBounds?: { pw: number; ph: number; pd: number }
): THREE.ExtrudeGeometry {
  const useBevel = bevelThickness > 0.001 && bevelSize > 0.001 && height > bevelThickness * 2.2;
  const extrudeDepth = useBevel ? Math.max(0.004, height - bevelThickness * 2) : height;
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: extrudeDepth,
    bevelEnabled: useBevel,
    bevelThickness: useBevel ? bevelThickness : 0,
    bevelSize: useBevel ? bevelSize : 0,
    bevelSegments: useBevel ? bevelSegments : 1,
    curveSegments: 20,
  });
  geo.rotateX(-Math.PI / 2);
  geo.center();
  if (targetBounds) {
    fitGeometryToExactPartBounds(geo, targetBounds.pw, targetBounds.ph, targetBounds.pd);
  }
  return geo;
}

function createBeveledOvalGeometry(
  pw: number,
  ph: number,
  pd: number,
  bev: number
): THREE.BufferGeometry {
  const r = Math.max(0.005, pw / 2);
  const b = Math.min(bev, r * 0.35, ph * 0.32);
  const hh = ph / 2;
  const pts = [
    new THREE.Vector2(0.0001, -hh),
    new THREE.Vector2(Math.max(0.002, r - b * 0.75), -hh),
    new THREE.Vector2(r, -hh + b),
    new THREE.Vector2(r, hh - b),
    new THREE.Vector2(Math.max(0.002, r - b * 0.75), hh),
    new THREE.Vector2(0.0001, hh),
  ];
  const geo = new THREE.LatheGeometry(pts, 28);
  if (Math.abs(pd - pw) > 0.001) {
    geo.scale(1, 1, pd / pw);
  }
  return fitGeometryToExactPartBounds(geo, pw, ph, pd);
}

/**
 * Canonical single-part geometry builder shared by 3D Viewport, GLB export, and 2D SVG projection.
 * Every returned geometry fits strictly within [-pw/2..pw/2] x [-ph/2..ph/2] x [-pd/2..pd/2].
 */
export function createCanonicalPartBaseGeometry(part: FurniturePart): THREE.BufferGeometry {
  const pw = Math.max(0.01, part.widthMm / 1000);
  const pd = Math.max(0.01, part.depthMm / 1000);
  const ph = Math.max(0.01, part.heightMm / 1000);
  const ds = part.detailStyle;
  const bounds = { pw, ph, pd };

  // Soft beveled pillow/cushion/mattress contours
  if (
    (ds === 'cushion' || ds === 'pillow' || ds === 'mattress' || ds === 'blanket') &&
    part.shape !== 'cylinder' &&
    part.shape !== 'sphere'
  ) {
    const bev = Math.min(ph * 0.24, Math.min(pw, pd) * 0.14, 0.036);
    if (part.shape === 'oval') {
      return createBeveledOvalGeometry(pw, ph, pd, bev);
    }
    const bevSize = bev * 0.85;
    const rad = Math.min(pw * 0.16, pd * 0.16, 0.09);
    const innerW = Math.max(0.006, pw - bevSize * 2);
    const innerD = Math.max(0.006, pd - bevSize * 2);
    const innerRad = Math.max(0.002, rad - bevSize * 1.17);
    return createExtrudedCentered(
      roundedRectShape(innerW, innerD, innerRad),
      ph,
      bev,
      bevSize,
      3,
      bounds
    );
  }

  // Chamfered / beveled tabletops, chair seats, armrests, headrests
  if (
    (ds === 'table_top' || ds === 'chair_seat' || ds === 'armrest' || ds === 'backrest' || part.bevel) &&
    (part.shape === 'rounded_rect' || part.shape === 'oval' || part.shape === 'box')
  ) {
    const bev = Math.min(ph * 0.16, Math.min(pw, pd) * 0.05, 0.014);
    if (part.shape === 'oval') {
      return createBeveledOvalGeometry(pw, ph, pd, bev);
    }
    const bevSize = bev * 0.7;
    const rad = part.shape === 'box' ? Math.min(pw, pd) * 0.04 : Math.min(pw * 0.2, pd * 0.2, 0.12);
    const innerW = Math.max(0.006, pw - bevSize * 2);
    const innerD = Math.max(0.006, pd - bevSize * 2);
    const innerRad = Math.max(0.002, rad - bevSize * 1.17);
    return createExtrudedCentered(
      roundedRectShape(innerW, innerD, innerRad),
      ph,
      bev,
      bevSize,
      2,
      bounds
    );
  }

  if (part.shape === 'cylinder' || part.shape === 'oval') {
    const r = Math.max(0.005, pw / 2);
    const geo = new THREE.CylinderGeometry(r, r, ph, 28);
    if (Math.abs(pd - pw) > 0.001) {
      geo.scale(1, 1, pd / pw);
    }
    return geo;
  }

  if (part.shape === 'rounded_rect') {
    const rx = Math.min(pw * 0.22, pd * 0.22, 0.14);
    return createExtrudedCentered(roundedRectShape(pw, pd, rx), ph, 0, 0, 1, bounds);
  }

  if (part.shape === 'sphere') {
    const geo = new THREE.SphereGeometry(0.5, 24, 16);
    geo.scale(pw, ph, pd);
    return geo;
  }

  if (part.shape === 'wedge') {
    const s = new THREE.Shape();
    s.moveTo(-pw / 2, 0);
    s.lineTo(pw / 2, 0);
    s.lineTo(-pw / 2, ph);
    s.closePath();
    const geo = new THREE.ExtrudeGeometry(s, { depth: pd, bevelEnabled: false });
    geo.translate(0, -ph / 2, -pd / 2);
    return geo;
  }

  if (part.shape === 'arc') {
    const hw = pw / 2;
    const hd = pd / 2;
    const steps = 36;
    const s = new THREE.Shape();
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * Math.PI;
      const x = Math.cos(t) * hw;
      const sy = Math.sin(t) * pd - hd;
      if (i === 0) s.moveTo(x, sy);
      else s.lineTo(x, sy);
    }
    for (let i = steps; i >= 0; i--) {
      const t = (i / steps) * Math.PI;
      const x = Math.cos(t) * hw * 0.65;
      const sy = Math.sin(t) * pd * 0.65 - hd;
      s.lineTo(x, sy);
    }
    s.closePath();
    return createExtrudedCentered(s, ph, 0, 0, 1, bounds);
  }

  if (part.shape === 'l_profile') {
    const hw = pw / 2;
    const hd = pd / 2;
    const armW = Math.min(pw * 0.42, Math.max(pw * 0.25, 0.32));
    const armD = Math.min(pd * 0.42, Math.max(pd * 0.25, 0.32));
    // Note: rotateX(-PI/2) maps shape +Y -> -Z (2D -Y), matching 2D plan outline 1:1
    const s = new THREE.Shape();
    s.moveTo(-hw, hd);
    s.lineTo(hw, hd);
    s.lineTo(hw, hd - armD);
    s.lineTo(-hw + armW, hd - armD);
    s.lineTo(-hw + armW, -hd);
    s.lineTo(-hw, -hd);
    s.closePath();
    return createExtrudedCentered(s, ph, 0, 0, 1, bounds);
  }

  if (part.shape === 'u_profile') {
    const hw = pw / 2;
    const hd = pd / 2;
    const armW = Math.min(pw * 0.3, Math.max(pw * 0.2, 0.26));
    const backD = Math.min(pd * 0.35, Math.max(pd * 0.22, 0.26));
    const s = new THREE.Shape();
    s.moveTo(-hw, hd);
    s.lineTo(hw, hd);
    s.lineTo(hw, -hd);
    s.lineTo(hw - armW, -hd);
    s.lineTo(hw - armW, hd - backD);
    s.lineTo(-hw + armW, hd - backD);
    s.lineTo(-hw + armW, -hd);
    s.lineTo(-hw, -hd);
    s.closePath();
    return createExtrudedCentered(s, ph, 0, 0, 1, bounds);
  }

  return new THREE.BoxGeometry(pw, ph, pd);
}

export interface PartLocalVertex3DMm {
  x: number; // plan X (mm)
  y: number; // plan Y (mm) = Three Z
  z: number; // up Z (mm) = Three Y, shifted so z0 = part.zMm
}

export type CompositePartBoundaryExtractor = (
  part: FurniturePart,
  templateId?: string
) => PartLocalVertex3DMm[] | null;

let compositeBoundaryExtractor: CompositePartBoundaryExtractor | null = null;
const partBoundaryCache = new Map<string, PartLocalVertex3DMm[]>();
const MAX_PART_BOUNDARY_CACHE = 2500;

export function registerCompositePartBoundaryExtractor(
  fn: CompositePartBoundaryExtractor
): void {
  if (compositeBoundaryExtractor === fn) return;
  compositeBoundaryExtractor = fn;
  partBoundaryCache.clear();
}

const SPHERE_DIRECTIONS: ReadonlyArray<[number, number, number]> = (() => {
  const dirs: Array<[number, number, number]> = [];
  // 26 axis + edge + corner directions so sharp cuboids/corners are always exact
  for (const dx of [-1, 0, 1]) {
    for (const dy of [-1, 0, 1]) {
      for (const dz of [-1, 0, 1]) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const len = Math.hypot(dx, dy, dz);
        dirs.push([dx / len, dy / len, dz / len]);
      }
    }
  }
  // 96 horizontal XZ azimuths & multi-elevation spherical rings for sub-millimeter 3D tilt & curved parity
  const azSteps = 96;
  for (let i = 0; i < azSteps; i++) {
    const a = (i / azSteps) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    dirs.push([ca, sa, 0]);
    for (const pitch of [-1.1, -0.65, -0.3, 0.3, 0.65, 1.1]) {
      const cp = Math.cos(pitch);
      const sp = Math.sin(pitch);
      dirs.push([ca * cp, sa * cp, sp]);
    }
  }
  // 120 golden-spiral directions for organic/spherical surfaces
  const n = 120;
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const z = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const theta = golden * i;
    dirs.push([Math.cos(theta) * r, Math.sin(theta) * r, z]);
  }
  return dirs;
})();

function convexHull2DLocal(pts: PartLocalVertex3DMm[]): PartLocalVertex3DMm[] {
  if (pts.length <= 3) return pts;
  const sorted = [...pts].sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));
  const cross = (o: PartLocalVertex3DMm, a: PartLocalVertex3DMm, b: PartLocalVertex3DMm) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: PartLocalVertex3DMm[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: PartLocalVertex3DMm[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/**
 * Extracts centered 3D boundary vertices (in mm: x=Three.x, y=Three.z, z=Three.y)
 * from any Three.js BufferGeometry or Object3D hierarchy (in meters, local to root).
 */
export function extractThreeObjectBoundaryVerticesMm(
  root: THREE.Object3D | THREE.BufferGeometry
): PartLocalVertex3DMm[] {
  const uniqueMap = new Map<string, PartLocalVertex3DMm>();
  const v = new THREE.Vector3();

  const ingestGeometry = (geo: THREE.BufferGeometry, matWorld?: THREE.Matrix4) => {
    const pos = geo.getAttribute('position');
    if (!pos) return;
    const snapF32 = (n: number) => Math.round(n * 10000) / 10000;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      if (matWorld) v.applyMatrix4(matWorld);
      const px = snapF32(v.x * 1000);
      const py = snapF32(v.z * 1000);
      const pz = snapF32(v.y * 1000);
      const key = `${Math.round(px * 5)},${Math.round(py * 5)},${Math.round(pz * 5)}`;
      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, { x: px, y: py, z: pz });
      }
    }
  };

  if (root instanceof THREE.BufferGeometry) {
    ingestGeometry(root);
  } else {
    root.updateMatrixWorld(true);
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      ingestGeometry(mesh.geometry, mesh.matrixWorld);
    });
  }

  const allPts = Array.from(uniqueMap.values());
  if (allPts.length <= 600) {
    return allPts;
  }

  // Group into fine Z bands so convex hulls of each slice (especially top/bottom rims & bevels)
  // plus the global XY convex hull preserve 3D support extremes within <= 0.1 mm under any tilt/yaw.
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const pt of allPts) {
    if (pt.z < minZ) minZ = pt.z;
    if (pt.z > maxZ) maxZ = pt.z;
  }
  const zSpan = Math.max(1e-3, maxZ - minZ);
  const numBands = 16;
  const bands: PartLocalVertex3DMm[][] = Array.from({ length: numBands }, () => []);
  const bottomRim: PartLocalVertex3DMm[] = [];
  const topRim: PartLocalVertex3DMm[] = [];

  for (const pt of allPts) {
    if (pt.z <= minZ + 0.5) bottomRim.push(pt);
    if (pt.z >= maxZ - 0.5) topRim.push(pt);
    const bi = Math.min(numBands - 1, Math.max(0, Math.floor(((pt.z - minZ) / zSpan) * numBands)));
    bands[bi].push(pt);
  }

  const reduced = new Map<string, PartLocalVertex3DMm>();
  const addPts = (pts: PartLocalVertex3DMm[]) => {
    for (const pt of pts) {
      const key = `${Math.round(pt.x * 5)},${Math.round(pt.y * 5)},${Math.round(pt.z * 5)}`;
      if (!reduced.has(key)) reduced.set(key, pt);
    }
  };

  addPts(convexHull2DLocal(allPts));
  if (bottomRim.length > 0) addPts(convexHull2DLocal(bottomRim));
  if (topRim.length > 0) addPts(convexHull2DLocal(topRim));
  for (const band of bands) {
    if (band.length > 0) addPts(convexHull2DLocal(band));
  }

  // Also include spherical extremes so smooth mid-slice curvature under extreme tilt has exact support
  for (const [dx, dy, dz] of SPHERE_DIRECTIONS) {
    let bestDot = -Infinity;
    let bestPt: PartLocalVertex3DMm | null = null;
    for (const pt of allPts) {
      const dot = pt.x * dx + pt.y * dy + pt.z * dz;
      if (dot > bestDot) {
        bestDot = dot;
        bestPt = pt;
      }
    }
    if (bestPt) {
      const key = `${Math.round(bestPt.x * 5)},${Math.round(bestPt.y * 5)},${Math.round(bestPt.z * 5)}`;
      if (!reduced.has(key)) reduced.set(key, bestPt);
    }
  }
  return Array.from(reduced.values());
}

/**
 * Returns exact cached 3D boundary vertices in unrotated furniture-local space (mm)
 * matching Three.js buildProceduralFurnitureGroup geometry for a FurniturePart.
 * Returns null only if caller needs composite fallback before furniture3d loads.
 */
export function getCanonicalPartBoundaryVertices3DMm(
  part: FurniturePart,
  templateId?: string
): PartLocalVertex3DMm[] {
  const w = Math.max(10, part.widthMm);
  const d = Math.max(10, part.depthMm);
  const h = Math.max(10, part.heightMm);
  const isLightFloorArm = templateId === 'light_floor' && /arm/i.test(part.name);
  const ds = part.detailStyle ?? '';
  const cacheKey = `${part.shape}|${ds}|${part.bevel ? 1 : 0}|${w.toFixed(2)}|${d.toFixed(2)}|${h.toFixed(2)}|${isLightFloorArm ? 1 : 0}`;

  let centeredVerts = partBoundaryCache.get(cacheKey);
  if (!centeredVerts) {
    if (compositeBoundaryExtractor) {
      const extracted = compositeBoundaryExtractor(part, templateId);
      if (extracted && extracted.length > 0) {
        centeredVerts = extracted;
      }
    }
    if (!centeredVerts) {
      const geo = createCanonicalPartBaseGeometry(part);
      centeredVerts = extractThreeObjectBoundaryVerticesMm(geo);
      geo.dispose();
    }
    if (partBoundaryCache.size >= MAX_PART_BOUNDARY_CACHE) {
      partBoundaryCache.clear();
    }
    partBoundaryCache.set(cacheKey, centeredVerts);
  }

  const radP = (part.rotationDeg * Math.PI) / 180;
  const cosP = Math.cos(radP);
  const sinP = Math.sin(radP);
  const zMid = part.zMm + h / 2;
  return centeredVerts.map((v) => ({
    x: part.xMm + v.x * cosP - v.y * sinP,
    y: part.yMm + v.x * sinP + v.y * cosP,
    z: zMid + v.z,
  }));
}

