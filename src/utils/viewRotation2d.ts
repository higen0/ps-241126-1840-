import { Point2D } from '../types/plan';

export type CardinalRotationDeg = 0 | 90 | 180 | 270;

export function normalizeCardinalRotation(deg: number): CardinalRotationDeg {
  const snapped = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  if (snapped === 90 || snapped === 180 || snapped === 270) return snapped;
  return 0;
}

export function stepCardinalRotation(
  current: CardinalRotationDeg,
  deltaDeg: -90 | 90
): CardinalRotationDeg {
  return normalizeCardinalRotation(current + deltaDeg);
}

/**
 * Rotates a 2D vector clockwise in screen Y-down coordinates by a cardinal angle
 * (or counter-clockwise when given a negative angle such as -rotDeg).
 */
export function rotateVectorCardinal(x: number, y: number, deg: number): Point2D {
  const norm = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  if (norm === 90) return { x: -y, y: x };
  if (norm === 180) return { x: -x, y: -y };
  if (norm === 270) return { x: y, y: -x };
  return { x, y };
}

export function screenRelCenterToWorld(
  sxRelCenter: number,
  syRelCenter: number,
  panPx: Point2D,
  pxPerMm: number,
  rotDeg: CardinalRotationDeg
): Point2D {
  const dx = sxRelCenter - panPx.x;
  const dy = syRelCenter - panPx.y;
  const unrotated = rotateVectorCardinal(dx, dy, -rotDeg);
  return {
    x: unrotated.x / pxPerMm,
    y: unrotated.y / pxPerMm,
  };
}

export function worldToScreenPoint(
  worldPt: Point2D,
  viewportWidth: number,
  viewportHeight: number,
  panPx: Point2D,
  pxPerMm: number,
  rotDeg: CardinalRotationDeg
): Point2D {
  const rotated = rotateVectorCardinal(
    worldPt.x * pxPerMm,
    worldPt.y * pxPerMm,
    rotDeg
  );
  return {
    x: viewportWidth / 2 + panPx.x + rotated.x,
    y: viewportHeight / 2 + panPx.y + rotated.y,
  };
}

/**
 * Maps a screen-space movement vector (e.g. keyboard arrow nudge) into world coordinates
 * so pressing Right always moves right on screen regardless of cardinal view rotation.
 */
export function screenDeltaToWorldDelta(
  dxScreen: number,
  dyScreen: number,
  rotDeg: CardinalRotationDeg
): Point2D {
  return rotateVectorCardinal(dxScreen, dyScreen, -rotDeg);
}

/**
 * Adjusts panPx when stepping view rotation so the world point at the viewport center
 * remains anchored at the viewport center instead of swinging around world (0, 0).
 */
export function computePanForViewRotationStep(
  panPx: Point2D,
  deltaDeg: number
): Point2D {
  return rotateVectorCardinal(panPx.x, panPx.y, deltaDeg);
}

export function computeRotatedGridWorldBounds(
  viewportWidth: number,
  viewportHeight: number,
  panPx: Point2D,
  pxPerMm: number,
  rotDeg: CardinalRotationDeg
): { minX: number; maxX: number; minY: number; maxY: number } {
  const hw = viewportWidth / 2;
  const hh = viewportHeight / 2;
  const corners = [
    screenRelCenterToWorld(-hw, -hh, panPx, pxPerMm, rotDeg),
    screenRelCenterToWorld(hw, -hh, panPx, pxPerMm, rotDeg),
    screenRelCenterToWorld(hw, hh, panPx, pxPerMm, rotDeg),
    screenRelCenterToWorld(-hw, hh, panPx, pxPerMm, rotDeg),
  ];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const c of corners) {
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.y > maxY) maxY = c.y;
  }
  return { minX, maxX, minY, maxY };
}

export function computeRotatedPlanFit(params: {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  viewportWidth: number;
  viewportHeight: number;
  baseScalePxPerMm: number;
  rotDeg: CardinalRotationDeg;
}): { zoomMultiplier: number; panPx: Point2D } {
  const {
    minX,
    maxX,
    minY,
    maxY,
    viewportWidth,
    viewportHeight,
    baseScalePxPerMm,
    rotDeg,
  } = params;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const padPx = 28;
  const availW = Math.max(240, viewportWidth - padPx * 2);
  const availH = Math.max(220, viewportHeight - 96);
  const rawSpanX = Math.max(2000, maxX - minX + 1200);
  const rawSpanY = Math.max(2000, maxY - minY + 1400);
  const swapped = rotDeg === 90 || rotDeg === 270;
  const rotSpanX = swapped ? rawSpanY : rawSpanX;
  const rotSpanY = swapped ? rawSpanX : rawSpanY;
  const targetPxPerMm = Math.min(availW / rotSpanX, availH / rotSpanY);
  const zoomMultiplier = Math.max(0.15, Math.min(6, targetPxPerMm / baseScalePxPerMm));
  const pxPerMm = baseScalePxPerMm * zoomMultiplier;
  const rotatedCenter = rotateVectorCardinal(cx * pxPerMm, cy * pxPerMm, rotDeg);
  return {
    zoomMultiplier,
    panPx: {
      x: -rotatedCenter.x,
      y: -rotatedCenter.y - 14,
    },
  };
}

/**
 * Adjusts a world-space line/dimension label rotation angle so the text stays upright
 * on screen (never upside-down) after the parent SVG group applies viewRotDeg.
 */
export function normalizeScreenUprightAngleDeg(
  worldAngleDeg: number,
  viewRotDeg: CardinalRotationDeg
): number {
  const screenDeg = (((worldAngleDeg + viewRotDeg) % 360) + 360) % 360;
  if (screenDeg > 90 && screenDeg <= 270) {
    return worldAngleDeg + 180;
  }
  return worldAngleDeg;
}
