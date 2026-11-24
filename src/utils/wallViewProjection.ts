import type {
  FurnitureInstance,
  Point2D,
  ProjectedViewSvg,
  RepresentationMode,
  SvgVectorElement,
  Wall,
} from '../types/plan';
import { getGlbAssetSync } from './assetStore';
import { getGlbSceneFromCacheSync } from './furnitureRepresentationSync';
import {
  computeFurnitureBoundsMm,
  computeWallPolygon,
  WallViewFurnitureProjection,
  wallOffsets,
} from './geometry';
import { computeSvgFitScale, extractSvgElementLocalPoints } from './svgImport';
import {
  computeFurnitureGeometrySignature,
  extractNormalizedMeshDataFromObject3D,
  extractNormalizedMeshDataFromParts,
  generateProjectedViewAtYawDeg,
  type NormalizedMeshData,
} from './svgProjection';
import {
  defaultMountingFaceForType,
  resolveFurnitureMountingFace,
  resolveFurnitureMountingType,
} from './mounting';

export interface SvgElementsBoundsMm {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  widthMm: number;
  heightMm: number;
  centerX: number;
  bottomY: number;
}

export interface WallCameraRelativeYaw {
  relYawDeg: number;
  bucketYawDeg: number;
  isCardinal: boolean;
}

export interface WallEndOcclusionInfo {
  leftBlockingOutMm: number;
  rightBlockingOutMm: number;
  leftClipX: number | null;
  rightClipX: number | null;
}

export interface CustomSvgWallTransform {
  translateX: number;
  translateY: number;
  scaleX: number;
  scaleY: number;
  srcCenterX: number;
  srcBottomY: number;
  srcWidthMm: number;
  srcHeightMm: number;
}

const MAX_MESH_CACHE = 64;
const MAX_PROJ_CACHE = 180;

const meshCache = new Map<string, NormalizedMeshData>();
const projCache = new Map<string, ProjectedViewSvg>();

let cacheHits = 0;
let cacheMisses = 0;

function lruGet<K, V>(map: Map<K, V>, key: K): V | undefined {
  const val = map.get(key);
  if (val !== undefined) {
    map.delete(key);
    map.set(key, val);
  }
  return val;
}

function lruSet<K, V>(map: Map<K, V>, key: K, val: V, maxEntries: number): void {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, val);
}

export function clearWallAngleProjectionCache(): void {
  meshCache.clear();
  projCache.clear();
  cacheHits = 0;
  cacheMisses = 0;
}

export function getWallAngleProjectionCacheStats(): {
  meshEntries: number;
  projEntries: number;
  hits: number;
  misses: number;
} {
  return {
    meshEntries: meshCache.size,
    projEntries: projCache.size,
    hits: cacheHits,
    misses: cacheMisses,
  };
}

/**
 * Computes the true local bounding box across visible SVG vector elements.
 */
export function computeSvgElementsBoundsMm(
  elements: SvgVectorElement[],
  fallbackBox?: { minX: number; minY: number; width: number; height: number }
): SvgElementsBoundsMm {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const el of elements) {
    if (!el.visible) continue;
    const pts = extractSvgElementLocalPoints(el);
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    if (fallbackBox && fallbackBox.width > 0 && fallbackBox.height > 0) {
      return {
        minX: fallbackBox.minX,
        maxX: fallbackBox.minX + fallbackBox.width,
        minY: fallbackBox.minY,
        maxY: fallbackBox.minY + fallbackBox.height,
        widthMm: fallbackBox.width,
        heightMm: fallbackBox.height,
        centerX: fallbackBox.minX + fallbackBox.width / 2,
        bottomY: fallbackBox.minY + fallbackBox.height,
      };
    }
    return {
      minX: -100,
      maxX: 100,
      minY: -200,
      maxY: 0,
      widthMm: 200,
      heightMm: 200,
      centerX: 0,
      bottomY: 0,
    };
  }

  const widthMm = Math.max(10, maxX - minX);
  const heightMm = Math.max(10, maxY - minY);
  return {
    minX,
    maxX,
    minY,
    maxY,
    widthMm,
    heightMm,
    centerX: (minX + maxX) / 2,
    bottomY: maxY,
  };
}

/**
 * Computes camera-relative yaw angle in [0, 360) for a furniture item facing the Wall View camera
 * (0=front, 90=right, 180=rear, 270=left) and quantizes it to 10-degree increments.
 */
export function computeWallCameraRelativeYawDeg(
  wall: Wall,
  faceSide: 'inner' | 'outer' | 'left' | 'right',
  furn: Pick<FurnitureInstance, 'rotationDeg'>
): WallCameraRelativeYaw {
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const straightLen = Math.hypot(dx, dy) || 1;
  const ux = dx / straightLen;
  const uy = dy / straightLen;
  const isLeftView = faceSide === 'inner' || faceSide === 'left';
  const screenRightX = isLeftView ? ux : -ux;
  const screenRightY = isLeftView ? uy : -uy;
  const wallScreenAngleDeg = (Math.atan2(screenRightY, screenRightX) * 180) / Math.PI;
  const relYawDeg = (((furn.rotationDeg - wallScreenAngleDeg) % 360) + 360) % 360;
  const bucketYawDeg = (Math.round(relYawDeg / 10) * 10) % 360;
  const mod90 = ((relYawDeg % 90) + 90) % 90;
  const isCardinal = mod90 < 1 || mod90 > 89;
  return { relYawDeg, bucketYawDeg, isCardinal };
}

/**
 * Detects genuine perpendicular/angled walls intersecting the left (x=0) or right (x=lenMm)
 * end of the viewed wall on the camera-facing room side, so open-room overhangs are NOT
 * clipped while real corner walls continue to occlude geometry behind them.
 */
export function computeWallEndOcclusion(
  targetWall: Wall,
  allWalls: Wall[],
  faceSide: 'inner' | 'outer' | 'left' | 'right'
): WallEndOcclusionInfo {
  const dx = targetWall.end.x - targetWall.start.x;
  const dy = targetWall.end.y - targetWall.start.y;
  const lenMm = Math.max(100, Math.hypot(dx, dy));
  const ux = dx / lenMm;
  const uy = dy / lenMm;
  const nx = -uy;
  const ny = ux;
  const isLeftView = faceSide === 'inner' || faceSide === 'left';
  const faceOffsets = wallOffsets(targetWall.thicknessMm, targetWall.alignment);
  const viewedFacePerp = isLeftView ? faceOffsets.left : faceOffsets.right;

  const toScreenOut = (pt: Point2D): { x: number; out: number } => {
    const rx = pt.x - targetWall.start.x;
    const ry = pt.y - targetWall.start.y;
    const s = rx * ux + ry * uy;
    const signedPerp = rx * nx + ry * ny;
    const out = isLeftView ? signedPerp - viewedFacePerp : viewedFacePerp - signedPerp;
    return { x: isLeftView ? s : lenMm - s, out };
  };

  let leftBlockingOutMm = 0;
  let rightBlockingOutMm = 0;
  const endBandMm = Math.max(90, targetWall.thicknessMm * 0.85);

  for (const w of allWalls) {
    if (w.id === targetWall.id || !w.visible) continue;
    const poly = computeWallPolygon(w, allWalls);
    const pts = poly.length >= 3 ? poly : [w.start, w.end];
    let minX = Infinity;
    let maxX = -Infinity;
    let maxOut = -Infinity;
    for (const pt of pts) {
      const proj = toScreenOut(pt);
      if (proj.x < minX) minX = proj.x;
      if (proj.x > maxX) maxX = proj.x;
      if (proj.out > maxOut) maxOut = proj.out;
    }
    if (maxOut <= 30) continue;
    if (minX <= endBandMm && maxX >= -endBandMm) {
      leftBlockingOutMm = Math.max(leftBlockingOutMm, maxOut);
    }
    if (minX <= lenMm + endBandMm && maxX >= lenMm - endBandMm) {
      rightBlockingOutMm = Math.max(rightBlockingOutMm, maxOut);
    }
  }

  return {
    leftBlockingOutMm,
    rightBlockingOutMm,
    leftClipX: leftBlockingOutMm > 30 ? 0 : null,
    rightClipX: rightBlockingOutMm > 30 ? lenMm : null,
  };
}

/**
 * Generates or retrieves from the bounded LRU cache a 10-degree quantized orthographic SVG
 * projection for procedural parts or loaded GLB furniture in Wall View.
 */
export function getCachedWallAngleProjection(
  furn: Pick<
    FurnitureInstance,
    | 'category'
    | 'templateId'
    | 'parts'
    | 'glbAssetId'
    | 'glbDataUrl'
    | 'rotationXDeg'
    | 'rotationYDeg'
    | 'mirroredX'
    | 'mirroredY'
    | 'mountingType'
    | 'mountingFace'
    | 'attachedWallId'
    | 'elevationMm'
    | 'surfaceHostId'
  >,
  bucketYawDeg: number,
  mode: RepresentationMode,
  strokeWidthMm = 12
): ProjectedViewSvg | null {
  const effectiveMode: RepresentationMode = mode === 'default' ? 'silhouette' : mode;
  const normYaw = ((Math.round(bucketYawDeg / 10) * 10) % 360 + 360) % 360;
  const hasTilt =
    Math.abs(furn.rotationXDeg ?? 0) >= 0.05 || Math.abs(furn.rotationYDeg ?? 0) >= 0.05;
  const geomSig = computeFurnitureGeometrySignature(furn, effectiveMode);
  const tplKey = furn.templateId ?? '';
  const resolvedGlbDataUrl = furn.glbDataUrl ?? getGlbAssetSync(furn.glbAssetId) ?? undefined;
  const isGlbOrBoundsPlaceholder =
    Boolean(furn.glbAssetId || furn.glbDataUrl) ||
    (furn.parts.length === 1 && furn.parts[0].name === 'GLB Bounding Footprint');
  const glbObj =
    furn.glbAssetId || furn.glbDataUrl
      ? getGlbSceneFromCacheSync(furn.glbAssetId, resolvedGlbDataUrl)
      : null;

  // Never degrade an imported GLB (whose parts are only a GLB Bounding Footprint box)
  // into a bounding-box projection while its 3D scene is unloaded or unavailable.
  if (isGlbOrBoundsPlaceholder && !glbObj) {
    return null;
  }
  if (!glbObj && furn.parts.length === 0) {
    return null;
  }

  const meshSourceKind = glbObj ? 'glb_live' : 'parts';
  const meshKey = `${geomSig}|tpl:${tplKey}|src:${meshSourceKind}`;
  const mxKey = !hasTilt && furn.mirroredX ? 1 : 0;
  const myKey = !hasTilt && furn.mirroredY ? 1 : 0;
  const projKey = `${meshKey}|yaw:${normYaw}|mx:${mxKey}|my:${myKey}|sw:${Math.round(strokeWidthMm)}`;

  const cachedProj = lruGet(projCache, projKey);
  if (cachedProj) {
    cacheHits++;
    return cachedProj;
  }
  cacheMisses++;

  let meshData = lruGet(meshCache, meshKey);
  if (!meshData) {
    if (glbObj) {
      const bounds = computeFurnitureBoundsMm(furn.parts);
      const mType = resolveFurnitureMountingType(furn);
      const mFace = resolveFurnitureMountingFace(furn) ?? defaultMountingFaceForType(mType);
      meshData = extractNormalizedMeshDataFromObject3D(glbObj, {
        targetSizeMm: {
          widthMm: bounds.widthMm,
          depthMm: bounds.depthMm,
          heightMm: bounds.heightMm,
        },
        rotationXDeg: furn.rotationXDeg,
        rotationYDeg: furn.rotationYDeg,
        mirroredX: furn.mirroredX,
        mirroredY: furn.mirroredY,
        mountingType: mType,
        mountingFace: mFace,
        assumeMetersIfSmall: true,
      });
    } else {
      meshData = extractNormalizedMeshDataFromParts(furn.parts, {
        rotationXDeg: furn.rotationXDeg,
        rotationYDeg: furn.rotationYDeg,
        mirroredX: furn.mirroredX,
        mirroredY: furn.mirroredY,
        templateId: furn.templateId,
      });
    }
    if (meshData.triangles.length === 0) {
      return null;
    }
    lruSet(meshCache, meshKey, meshData, MAX_MESH_CACHE);
  }

  if (meshData.triangles.length === 0) {
    return null;
  }

  const projected = generateProjectedViewAtYawDeg(meshData, normYaw, {
    mode: effectiveMode,
    strokeWidthMm,
    mirroredX: furn.mirroredX,
    mirroredY: furn.mirroredY,
    hasTilt,
  });
  lruSet(projCache, projKey, projected, MAX_PROJ_CACHE);
  return projected;
}

/**
 * Computes centering + bounded non-stretching transform for custom/imported SVGs in Wall View
 * so asymmetric shapes never shift off-center and oblique angles interpolate gently without
 * distorting into stretched ribbons.
 */
export function computeCustomSvgWallViewTransform(
  elements: SvgVectorElement[],
  fallbackBox: { minX: number; minY: number; width: number; height: number } | undefined,
  projection: WallViewFurnitureProjection,
  relYawDeg: number,
  options: { preserveAspectOnFlat: boolean }
): CustomSvgWallTransform {
  const elBounds = computeSvgElementsBoundsMm(elements, fallbackBox);
  const srcW = Math.max(10, elBounds.widthMm);
  const srcH = Math.max(10, elBounds.heightMm);
  const mod90 = ((relYawDeg % 90) + 90) % 90;
  const isCardinal = mod90 < 1 || mod90 > 89;

  let rawSx: number;
  let sy: number;
  if (isCardinal) {
    const fitted = computeSvgFitScale(
      srcW,
      srcH,
      projection.elevW,
      projection.elevH,
      options.preserveAspectOnFlat
    );
    rawSx = fitted.scaleX;
    sy = fitted.scaleY;
  } else {
    sy = projection.elevH / srcH;
    const rawTargetSx = projection.elevW / srcW;
    // Allow slight natural interpolation between cardinal SVGs (max ±18%) without wild stretching
    rawSx = Math.max(sy * 0.78, Math.min(sy * 1.18, rawTargetSx));
  }

  const applyFlipX = projection.flipX && !projection.hasTilt;
  const scaleX = (applyFlipX ? -1 : 1) * rawSx;
  const verticalPad =
    isCardinal && options.preserveAspectOnFlat
      ? Math.max(0, (projection.elevH - srcH * sy) / 2)
      : 0;

  return {
    translateX: projection.viewXCenter,
    translateY: -(projection.zBottom + verticalPad),
    scaleX,
    scaleY: sy,
    srcCenterX: elBounds.centerX,
    srcBottomY: elBounds.bottomY,
    srcWidthMm: srcW,
    srcHeightMm: srcH,
  };
}
