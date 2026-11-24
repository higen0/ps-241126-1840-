import * as THREE from 'three';
import type { FurnitureInstance, Point2D, SvgVectorElement } from '../types/plan';
import { fastHashString } from './assetStore';
import { buildProceduralFurnitureGroup, type Furniture3DBuildContext } from './furniture3d';
import { computeConvexHull2D, getFurniturePlacement } from './geometry';
import { extractSvgElementLocalPoints } from './svgImport';

export interface Bounds2DMm {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface FurniturePlanParityReport {
  furnitureId: string;
  bounds3d: Bounds2DMm;
  hull3d: Point2D[];
  bounds2d: Bounds2DMm;
  hull2d: Point2D[];
  maxDiffMm: number;
  hasMismatch: boolean;
}

const PARITY_OVERLAY_BUILD_CTX: Furniture3DBuildContext = {
  matOpts: {
    materialQuality: 'standard',
    reflectionQuality: 'off',
    transparentQuality: 'standard',
    textureFiltering: 'bilinear',
    isSoftwareGl: true,
  },
  castShadows: false,
  clippingPlanes: [],
  nightMix: 0,
  partEdgeMat: new THREE.LineBasicMaterial({ color: 0x1e293b }),
  kelvinToColor: () => new THREE.Color('#FFE4C4'),
  effectiveCeilingMm: 2800,
  isSoftwareGl: true,
};

const local3dHullCache = new Map<string, Point2D[]>();
const MAX_LOCAL_3D_HULL_CACHE = 400;

function computeSignature(f: FurnitureInstance, effectiveCeilingMm: number): string {
  const partsSig = f.parts
    .map(
      (p) =>
        `${p.shape}:${p.detailStyle ?? ''}:${p.bevel ? 1 : 0}:${p.name}:${p.xMm.toFixed(2)},${p.yMm.toFixed(2)},${p.zMm.toFixed(2)}:${p.widthMm.toFixed(2)}x${p.depthMm.toFixed(2)}x${p.heightMm.toFixed(2)}:${p.rotationDeg.toFixed(2)}:${p.svgPath ?? ''}`
    )
    .join(';');
  return [
    f.templateId ?? '',
    f.mountingType ?? '',
    f.mountingFace ?? '',
    Math.round((f.rotationXDeg ?? 0) * 100),
    Math.round((f.rotationYDeg ?? 0) * 100),
    f.mirroredX ? 1 : 0,
    f.mirroredY ? 1 : 0,
    Math.round(effectiveCeilingMm),
    fastHashString(partsSig),
  ].join('|');
}

function getLocalThreeHull2D(f: FurnitureInstance, effectiveCeilingMm: number): Point2D[] {
  const sig = computeSignature(f, effectiveCeilingMm);
  const cached = local3dHullCache.get(sig);
  if (cached) return cached;

  const probe: FurnitureInstance = {
    ...f,
    xMm: 0,
    yMm: 0,
    elevationMm: 0,
    rotationDeg: 0,
  };
  const built = buildProceduralFurnitureGroup(probe, {
    ...PARITY_OVERLAY_BUILD_CTX,
    effectiveCeilingMm,
  });
  built.group.updateMatrixWorld(true);

  const pts: Point2D[] = [];
  const v = new THREE.Vector3();
  built.group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const pos = mesh.geometry.getAttribute('position');
    if (!pos) return;
    const mw = mesh.matrixWorld;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mw);
      pts.push({ x: v.x * 1000, y: v.z * 1000 });
    }
    mesh.geometry.dispose();
  });

  const hull = pts.length >= 3 ? computeConvexHull2D(pts) : pts;
  if (local3dHullCache.size >= MAX_LOCAL_3D_HULL_CACHE) {
    local3dHullCache.clear();
  }
  local3dHullCache.set(sig, hull);
  return hull;
}

function boundsFromPoints(pts: Point2D[], fallback: Bounds2DMm): Bounds2DMm {
  if (pts.length === 0) return fallback;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, maxX, minY, maxY };
}

/**
 * Compares the actual Three.js 3D world XZ geometry bounds against the active 2D plan
 * SVG representation for the development-only parity overlay and test assertions.
 */
export function evaluateFurniturePlanParity(
  f: FurnitureInstance,
  topPlan: {
    elements: SvgVectorElement[] | null | undefined;
    topScaleX: number;
    topScaleY: number;
    applyMirrorScale2D: boolean;
  },
  effectiveCeilingMm = 2800,
  toleranceMm = 1.0
): FurniturePlanParityReport {
  const placement = getFurniturePlacement(f, { effectiveCeilingMm });
  const rad = (f.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  // 1. Actual 3D geometry world XZ hull & bounds
  let hull3d: Point2D[];
  if (f.glbAssetId || f.glbDataUrl) {
    hull3d =
      placement.worldConvexHull.length >= 3
        ? placement.worldConvexHull
        : placement.orientedCorners;
  } else {
    const localHull3d = getLocalThreeHull2D(f, effectiveCeilingMm);
    hull3d = localHull3d.map((pt) => ({
      x: f.xMm + pt.x * cos - pt.y * sin,
      y: f.yMm + pt.x * sin + pt.y * cos,
    }));
  }
  const bounds3d = boundsFromPoints(hull3d, placement.worldBounds2D);

  // 2. Active 2D representation world XZ hull & bounds
  const b = placement.tiltedLocalBounds;
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const mx = topPlan.applyMirrorScale2D ? placement.mirrorSignX : 1;
  const my = topPlan.applyMirrorScale2D ? placement.mirrorSignY : 1;
  const world2dPts: Point2D[] = [];

  if (topPlan.elements && topPlan.elements.length > 0) {
    for (const el of topPlan.elements) {
      if (!el.visible) continue;
      for (const pt of extractSvgElementLocalPoints(el)) {
        const lx = cx + pt.x * topPlan.topScaleX * mx;
        const ly = cy + pt.y * topPlan.topScaleY * my;
        world2dPts.push({
          x: f.xMm + lx * cos - ly * sin,
          y: f.yMm + lx * sin + ly * cos,
        });
      }
    }
  }

  const hull2d =
    world2dPts.length >= 3 ? computeConvexHull2D(world2dPts) : placement.orientedCorners;
  const bounds2d = boundsFromPoints(world2dPts, placement.worldBounds2D);

  const maxDiffMm = Math.max(
    Math.abs(bounds3d.minX - bounds2d.minX),
    Math.abs(bounds3d.maxX - bounds2d.maxX),
    Math.abs(bounds3d.minY - bounds2d.minY),
    Math.abs(bounds3d.maxY - bounds2d.maxY)
  );

  return {
    furnitureId: f.id,
    bounds3d,
    hull3d,
    bounds2d,
    hull2d,
    maxDiffMm,
    hasMismatch: maxDiffMm > toleranceMm,
  };
}
