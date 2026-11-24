import * as THREE from 'three';
import {
  getDefaultTileMeters,
  getEffectiveMaterialHex,
  getMaterialCapabilities,
  getMaterialPresetMeta,
  type MaterialCapabilities,
} from '../data/materials';
import type {
  BacksplashCorner,
  MaterialPreset,
  SurfaceMaterialSettings,
  WallBacksplash,
} from '../types/plan';

export interface PatternResolveOptions {
  color?: string;
  secondaryColor?: string;
  textureScale?: number;
  textureRotDeg?: number;
  settings?: SurfaceMaterialSettings;
}

export interface ResolvedPatternMetrics {
  preset: MaterialPreset;
  capabilities: MaterialCapabilities;
  scale: number;
  rotDeg: number;
  primaryHex: string;
  secondaryHex: string;
  tileWidthMm: number;
  tileLengthMm: number;
  repeatWidthMm: number;
  repeatHeightMm: number;
  repeatWidthM: number;
  repeatHeightM: number;
  cellsX: number;
  cellsY: number;
  groutWidthMm: number;
  groutRatioX: number;
  groutRatioY: number;
  staggerPct: number;
  roughness: number;
  reflectivity: number;
  hasPattern: boolean;
}

const PLAIN_NO_PATTERN_PRESETS = new Set<MaterialPreset>([
  'paint',
  'satin_paint',
  'plastic_matte',
  'plastic_gloss',
  'glass',
]);

export function clampNum(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return v < min ? min : v > max ? max : v;
}

export function normalizeTextureScale(rawScale?: number): number {
  if (typeof rawScale !== 'number' || !Number.isFinite(rawScale) || rawScale <= 0) {
    return 1;
  }
  return clampNum(rawScale, 0.05, 8);
}

/**
 * Single source of truth for material pattern dimensions, colors, grout, stagger,
 * roughness, reflectivity, and real-world metric repeat sizes across 2D, Wall View, and 3D.
 * Larger `textureScale` always produces proportionally larger tiles/planks everywhere.
 */
export function resolvePatternMetrics(
  preset: MaterialPreset,
  opts: PatternResolveOptions = {}
): ResolvedPatternMetrics {
  const capabilities = getMaterialCapabilities(preset);
  const meta = getMaterialPresetMeta(preset);
  const scale = normalizeTextureScale(opts.textureScale);
  const rotDeg = Number.isFinite(opts.textureRotDeg) ? (opts.textureRotDeg as number) : 0;

  const primaryHex = getEffectiveMaterialHex(preset, opts.color);
  const rawSec =
    opts.secondaryColor ??
    opts.settings?.secondaryColor ??
    meta.previewSecondary ??
    meta.previewAccent ??
    '#334155';
  const secondaryHex = (rawSec || '#334155').toUpperCase();

  const cellsX = capabilities.cellsX ?? 1;
  const cellsY = capabilities.cellsY ?? 1;

  let tileWidthMm: number;
  let tileLengthMm: number;
  let repeatWidthMm: number;
  let repeatHeightMm: number;

  if (
    capabilities.supportsDimensions &&
    capabilities.defaultWidthMm &&
    capabilities.defaultLengthMm
  ) {
    const baseW = clampNum(
      opts.settings?.tileWidthMm ?? capabilities.defaultWidthMm,
      15,
      4000
    );
    const baseL = clampNum(
      opts.settings?.tileLengthMm ?? capabilities.defaultLengthMm,
      15,
      4000
    );
    tileWidthMm = baseW * scale;
    tileLengthMm = baseL * scale;
    repeatWidthMm = tileWidthMm * cellsX;
    repeatHeightMm = tileLengthMm * cellsY;
  } else {
    const baseMm = getDefaultTileMeters(preset) * 1000;
    tileWidthMm = baseMm * scale;
    tileLengthMm = baseMm * scale;
    repeatWidthMm = tileWidthMm;
    repeatHeightMm = tileLengthMm;
  }

  const groutWidthMm = capabilities.supportsGrout
    ? clampNum(opts.settings?.groutWidthMm ?? capabilities.defaultGroutMm ?? 3, 0, 40)
    : 0;

  const groutRatioX = clampNum(groutWidthMm / Math.max(10, repeatWidthMm), 0, 0.16);
  const groutRatioY = clampNum(groutWidthMm / Math.max(10, repeatHeightMm), 0, 0.16);

  const staggerPct = capabilities.supportsStagger
    ? clampNum(opts.settings?.staggerPct ?? capabilities.defaultStaggerPct ?? 50, 0, 50)
    : capabilities.defaultStaggerPct ?? 50;

  const roughness = clampNum(opts.settings?.roughness ?? meta.roughness, 0.04, 1);
  const reflectivity = clampNum(
    opts.settings?.reflectivity ?? capabilities.defaultReflectivity ?? 0.35,
    0,
    1
  );

  return {
    preset,
    capabilities,
    scale,
    rotDeg,
    primaryHex,
    secondaryHex,
    tileWidthMm,
    tileLengthMm,
    repeatWidthMm,
    repeatHeightMm,
    repeatWidthM: repeatWidthMm / 1000,
    repeatHeightM: repeatHeightMm / 1000,
    cellsX,
    cellsY,
    groutWidthMm,
    groutRatioX,
    groutRatioY,
    staggerPct,
    roughness,
    reflectivity,
    hasPattern: !PLAIN_NO_PATTERN_PRESETS.has(preset),
  };
}

/**
 * Applies metric planar UV rotation + anisotropic division directly onto geometry UVs
 * (which must initially be in meters, e.g. Three.js ShapeGeometry / ExtrudeGeometry caps).
 * Rotating before dividing by (repeatWidthM, repeatHeightM) prevents any texture shearing
 * on rectangular plank/tile patterns at arbitrary angles, and guarantees 1:1 parity with 2D SVG.
 */
export function applyPlanarUVTransform(
  geo: THREE.BufferGeometry,
  repeatWidthM: number,
  repeatHeightM: number,
  rotDeg = 0,
  vertStart = 0,
  vertCount?: number
): void {
  const uvAttr = geo.getAttribute('uv') as THREE.BufferAttribute | undefined;
  if (!uvAttr) return;
  const safeW = Math.max(0.02, repeatWidthM);
  const safeH = Math.max(0.02, repeatHeightM);
  const theta = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  const start = Math.max(0, vertStart);
  const end =
    vertCount !== undefined ? Math.min(uvAttr.count, start + vertCount) : uvAttr.count;

  for (let i = start; i < end; i++) {
    const uM = uvAttr.getX(i);
    const vM = uvAttr.getY(i);
    const ru = uM * cos - vM * sin;
    const rv = uM * sin + vM * cos;
    uvAttr.setXY(i, ru / safeW, rv / safeH);
  }
  uvAttr.needsUpdate = true;
}

// ============================================================================
// WALL BACKSPLASH GEOMETRY & EDITING HELPERS
// ============================================================================

export function clampBacksplashCorner(
  corner: BacksplashCorner,
  wallHeightMm: number
): BacksplashCorner {
  return {
    u: clampNum(Number.isFinite(corner.u) ? corner.u : 0.5, 0, 1),
    zMm: Math.round(clampNum(Number.isFinite(corner.zMm) ? corner.zMm : 0, 0, Math.max(100, wallHeightMm))),
  };
}

export function ensureNonCrossingQuadCorners(
  corners: [BacksplashCorner, BacksplashCorner, BacksplashCorner, BacksplashCorner],
  wallLenMm = 3000
): [BacksplashCorner, BacksplashCorner, BacksplashCorner, BacksplashCorner] {
  const pts = corners.map((c, idx) => ({
    idx,
    c,
    x: c.u * wallLenMm,
    y: c.zMm,
  }));
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  // Sort CCW around centroid so edges never form a self-intersecting bowtie
  const sorted = [...pts].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)
  );
  // Start with the corner closest to top-left (smallest x, highest y) so A,B,C,D read intuitively
  let topLeftIdx = 0;
  let bestScore = Infinity;
  for (let i = 0; i < 4; i++) {
    const score = sorted[i].x - sorted[i].y * 0.5;
    if (score < bestScore) {
      bestScore = score;
      topLeftIdx = i;
    }
  }
  // Order clockwise starting from top-left (top-left -> top-right -> bottom-right -> bottom-left)
  const cw = [sorted[0], sorted[3], sorted[2], sorted[1]];
  let cwTopLeft = 0;
  let cwBest = Infinity;
  for (let i = 0; i < 4; i++) {
    const score = cw[i].x - cw[i].y * 0.5;
    if (score < cwBest) {
      cwBest = score;
      cwTopLeft = i;
    }
  }
  void topLeftIdx;
  const rotated = [
    cw[cwTopLeft],
    cw[(cwTopLeft + 1) % 4],
    cw[(cwTopLeft + 2) % 4],
    cw[(cwTopLeft + 3) % 4],
  ];
  return [rotated[0].c, rotated[1].c, rotated[2].c, rotated[3].c];
}

export function computeBacksplashMetrics(
  corners: readonly BacksplashCorner[],
  wallLenMm: number
): {
  minU: number;
  maxU: number;
  minZMm: number;
  maxZMm: number;
  widthMm: number;
  heightMm: number;
  centerU: number;
  centerZMm: number;
  areaM2: number;
} {
  if (corners.length === 0) {
    return {
      minU: 0,
      maxU: 0,
      minZMm: 0,
      maxZMm: 0,
      widthMm: 0,
      heightMm: 0,
      centerU: 0.5,
      centerZMm: 0,
      areaM2: 0,
    };
  }
  let minU = Infinity;
  let maxU = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const c of corners) {
    if (c.u < minU) minU = c.u;
    if (c.u > maxU) maxU = c.u;
    if (c.zMm < minZ) minZ = c.zMm;
    if (c.zMm > maxZ) maxZ = c.zMm;
  }
  let twiceArea = 0;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    const ax = a.u * wallLenMm;
    const bx = b.u * wallLenMm;
    twiceArea += ax * b.zMm - bx * a.zMm;
  }
  return {
    minU,
    maxU,
    minZMm: minZ,
    maxZMm: maxZ,
    widthMm: Math.round((maxU - minU) * wallLenMm),
    heightMm: Math.round(maxZ - minZ),
    centerU: (minU + maxU) / 2,
    centerZMm: (minZ + maxZ) / 2,
    areaM2: Math.round((Math.abs(twiceArea) / 2_000_000) * 100) / 100,
  };
}

export function translateBacksplashCorners(
  corners: [BacksplashCorner, BacksplashCorner, BacksplashCorner, BacksplashCorner],
  deltaU: number,
  deltaZMm: number,
  wallHeightMm: number
): [BacksplashCorner, BacksplashCorner, BacksplashCorner, BacksplashCorner] {
  const minU = Math.min(...corners.map((c) => c.u));
  const maxU = Math.max(...corners.map((c) => c.u));
  const minZ = Math.min(...corners.map((c) => c.zMm));
  const maxZ = Math.max(...corners.map((c) => c.zMm));

  const clampedDU = clampNum(deltaU, -minU, 1 - maxU);
  const clampedDZ = clampNum(deltaZMm, -minZ, Math.max(100, wallHeightMm) - maxZ);

  return [
    { u: corners[0].u + clampedDU, zMm: Math.round(corners[0].zMm + clampedDZ) },
    { u: corners[1].u + clampedDU, zMm: Math.round(corners[1].zMm + clampedDZ) },
    { u: corners[2].u + clampedDU, zMm: Math.round(corners[2].zMm + clampedDZ) },
    { u: corners[3].u + clampedDU, zMm: Math.round(corners[3].zMm + clampedDZ) },
  ];
}

/**
 * Remaps wall-attached backsplashes when a wall is split at parametric `tSplit` into w1 and w2.
 * Backsplashes wholly on w1 or w2 stay attached with re-normalized [0..1] `u`; any backsplash
 * straddling the split point is split/assigned cleanly onto both or the dominant segment.
 */
export function remapBacksplashesOnWallSplit(
  backsplashes: WallBacksplash[],
  oldWallId: string,
  w1Id: string,
  w2Id: string,
  tSplit: number
): WallBacksplash[] {
  const out: WallBacksplash[] = [];
  for (const bs of backsplashes) {
    if (bs.wallId !== oldWallId) {
      out.push(bs);
      continue;
    }
    const avgU = bs.corners.reduce((s, c) => s + c.u, 0) / bs.corners.length;
    if (avgU <= tSplit) {
      out.push({
        ...bs,
        wallId: w1Id,
        corners: bs.corners.map((c) => ({
          u: clampNum(c.u / tSplit, 0, 1),
          zMm: c.zMm,
        })) as WallBacksplash['corners'],
      });
    } else {
      out.push({
        ...bs,
        wallId: w2Id,
        corners: bs.corners.map((c) => ({
          u: clampNum((c.u - tSplit) / Math.max(0.01, 1 - tSplit), 0, 1),
          zMm: c.zMm,
        })) as WallBacksplash['corners'],
      });
    }
  }
  return out;
}
