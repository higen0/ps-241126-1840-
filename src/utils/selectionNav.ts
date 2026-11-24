import {
  ArchElement,
  Curtain,
  FurnitureInstance,
  Level,
  Opening,
  PersonInstance,
  Point2D,
  SelectionTarget,
  Wall,
} from '../types/plan';
import {
  computeWallPolygon,
  getChimneyWorldCorners,
  getFurnitureOrientedCorners,
  getFurnitureSolidFootprintPrimitives,
  getWallCenterlinePoint,
  pointInPolygon,
  segmentIntersection,
} from './geometry';
import { localToWorldPoint, resolveRailingConfig } from './railings';

export interface MarqueeRect {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export type MarqueeMode = 'enclosed' | 'crossing';

export function resolveMarqueeMode(startX: number, curX: number): MarqueeMode {
  return curX >= startX ? 'enclosed' : 'crossing';
}

export function normalizeMarqueeRect(a: Point2D, b: Point2D): MarqueeRect {
  return {
    minX: Math.min(a.x, b.x),
    maxX: Math.max(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxY: Math.max(a.y, b.y),
  };
}

export function isPointInRect(pt: Point2D, rect: MarqueeRect): boolean {
  return pt.x >= rect.minX && pt.x <= rect.maxX && pt.y >= rect.minY && pt.y <= rect.maxY;
}

export function segmentIntersectsRect(a: Point2D, b: Point2D, rect: MarqueeRect): boolean {
  if (isPointInRect(a, rect) || isPointInRect(b, rect)) return true;
  if (
    (a.x < rect.minX && b.x < rect.minX) ||
    (a.x > rect.maxX && b.x > rect.maxX) ||
    (a.y < rect.minY && b.y < rect.minY) ||
    (a.y > rect.maxY && b.y > rect.maxY)
  ) {
    return false;
  }
  const c0: Point2D = { x: rect.minX, y: rect.minY };
  const c1: Point2D = { x: rect.maxX, y: rect.minY };
  const c2: Point2D = { x: rect.maxX, y: rect.maxY };
  const c3: Point2D = { x: rect.minX, y: rect.maxY };
  return (
    segmentIntersection(a, b, c0, c1) !== null ||
    segmentIntersection(a, b, c1, c2) !== null ||
    segmentIntersection(a, b, c2, c3) !== null ||
    segmentIntersection(a, b, c3, c0) !== null
  );
}

export function polygonEnclosedInRect(poly: Point2D[], rect: MarqueeRect): boolean {
  if (poly.length === 0) return false;
  for (const pt of poly) {
    if (!isPointInRect(pt, rect)) return false;
  }
  return true;
}

export function polygonIntersectsRect(poly: Point2D[], rect: MarqueeRect): boolean {
  if (poly.length === 0) return false;
  for (const pt of poly) {
    if (isPointInRect(pt, rect)) return true;
  }
  const corners: Point2D[] = [
    { x: rect.minX, y: rect.minY },
    { x: rect.maxX, y: rect.minY },
    { x: rect.maxX, y: rect.maxY },
    { x: rect.minX, y: rect.maxY },
  ];
  for (const c of corners) {
    if (pointInPolygon(c, poly)) return true;
  }
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (segmentIntersectsRect(a, b, rect)) return true;
  }
  return false;
}

export function polylineEnclosedInRect(pts: Point2D[], rect: MarqueeRect): boolean {
  return polygonEnclosedInRect(pts, rect);
}

export function polylineIntersectsRect(
  pts: Point2D[],
  rect: MarqueeRect,
  closed = false
): boolean {
  if (pts.length === 0) return false;
  if (pts.length === 1) return isPointInRect(pts[0], rect);
  const segCount = closed && pts.length >= 3 ? pts.length : pts.length - 1;
  for (let i = 0; i < segCount; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if (segmentIntersectsRect(a, b, rect)) return true;
  }
  return false;
}

export function circleEnclosedInRect(center: Point2D, r: number, rect: MarqueeRect): boolean {
  return (
    center.x - r >= rect.minX &&
    center.x + r <= rect.maxX &&
    center.y - r >= rect.minY &&
    center.y + r <= rect.maxY
  );
}

export function circleIntersectsRect(center: Point2D, r: number, rect: MarqueeRect): boolean {
  const cx = Math.max(rect.minX, Math.min(rect.maxX, center.x));
  const cy = Math.max(rect.minY, Math.min(rect.maxY, center.y));
  return Math.hypot(center.x - cx, center.y - cy) <= r;
}

export function getRotatedBoxCorners(
  center: Point2D,
  widthMm: number,
  heightMm: number,
  rotationDeg: number
): Point2D[] {
  return getChimneyWorldCorners(center.x, center.y, widthMm, heightMm, rotationDeg);
}

export function getOpeningFootprintCorners(op: Opening, wall: Wall): Point2D[] {
  const { point, tangent } = getWallCenterlinePoint(wall, op.t);
  const angleDeg = (Math.atan2(tangent.y, tangent.x) * 180) / Math.PI;
  return getRotatedBoxCorners(point, op.widthMm, Math.max(80, wall.thicknessMm), angleDeg);
}

export function getCurtainFootprintCorners(c: Curtain): Point2D[] {
  const depthMm = c.style === 'blinds' || c.style === 'roller_shade' ? 70 : 90;
  return getRotatedBoxCorners({ x: c.xMm, y: c.yMm }, c.widthMm, depthMm, c.rotationDeg);
}

export function getPersonFootprintCorners(p: PersonInstance): Point2D[] {
  const scale = p.heightMm / 1750;
  const isLying = p.pose === 'lying_back' || p.pose === 'lying_side';
  if (isLying) {
    const wMm = (p.pose === 'lying_side' ? 380 : 440) * scale;
    const minLocalY = -765 * scale;
    const maxLocalY = 820 * scale;
    const hMm = maxLocalY - minLocalY;
    const cyLocal = (minLocalY + maxLocalY) / 2;
    const rad = (p.rotationDeg * Math.PI) / 180;
    const center: Point2D = {
      x: p.xMm - cyLocal * Math.sin(rad),
      y: p.yMm + cyLocal * Math.cos(rad),
    };
    return getRotatedBoxCorners(center, wMm, hMm, p.rotationDeg);
  }
  const wMm = 460 * scale;
  const dMm = (p.pose === 'seated' ? 290 : 224) * scale;
  return getRotatedBoxCorners({ x: p.xMm, y: p.yMm }, wMm, dMm, p.rotationDeg);
}

export function getFurnitureFootprintPolygons(f: FurnitureInstance): Point2D[][] {
  const prims = getFurnitureSolidFootprintPrimitives({ x: f.xMm, y: f.yMm }, f);
  if (prims.length > 0) {
    return prims.map((pr) => pr.poly);
  }
  const corners = getFurnitureOrientedCorners({ x: f.xMm, y: f.yMm }, f);
  return corners.length > 0 ? [corners] : [];
}

function getWallSegmentPoints(w: Wall): Point2D[] {
  if (!w.isCurved) return [w.start, w.end];
  const pts: Point2D[] = [];
  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    pts.push(getWallCenterlinePoint(w, i / steps).point);
  }
  return pts;
}

export function doesFurnitureMatchMarquee(
  f: FurnitureInstance,
  rect: MarqueeRect,
  mode: MarqueeMode
): boolean {
  const polys = getFurnitureFootprintPolygons(f);
  if (polys.length === 0) return false;
  if (mode === 'enclosed') {
    return polys.every((poly) => polygonEnclosedInRect(poly, rect));
  }
  return polys.some((poly) => polygonIntersectsRect(poly, rect));
}

export function doesWallMatchMarquee(
  w: Wall,
  allWalls: Wall[],
  rect: MarqueeRect,
  mode: MarqueeMode
): boolean {
  const segPts = getWallSegmentPoints(w);
  if (mode === 'enclosed') {
    return polylineEnclosedInRect(segPts, rect);
  }
  if (polylineIntersectsRect(segPts, rect, false)) return true;
  const poly = computeWallPolygon(w, allWalls);
  return polygonIntersectsRect(poly, rect);
}

export function doesArchElementMatchMarquee(
  el: ArchElement,
  rect: MarqueeRect,
  mode: MarqueeMode
): boolean {
  if (el.type === 'railing') {
    const cfg = resolveRailingConfig(el);
    const worldPts = cfg.nodes.map((n) =>
      localToWorldPoint(el.xMm, el.yMm, el.rotationDeg, n.xMm, n.yMm)
    );
    if (worldPts.length === 0) return false;
    return mode === 'enclosed'
      ? polylineEnclosedInRect(worldPts, rect)
      : polylineIntersectsRect(worldPts, rect, Boolean(cfg.closed));
  }
  if (el.type === 'column_round') {
    const r = Math.max(20, el.widthMm / 2);
    const center = { x: el.xMm, y: el.yMm };
    return mode === 'enclosed'
      ? circleEnclosedInRect(center, r, rect)
      : circleIntersectsRect(center, r, rect);
  }
  const corners = getRotatedBoxCorners(
    { x: el.xMm, y: el.yMm },
    el.widthMm,
    el.depthMm,
    el.rotationDeg
  );
  return mode === 'enclosed'
    ? polygonEnclosedInRect(corners, rect)
    : polygonIntersectsRect(corners, rect);
}

export function evaluateMarqueeSelection(
  level: Level,
  startWorld: Point2D,
  curWorld: Point2D,
  modeOverride?: MarqueeMode
): SelectionTarget[] {
  const rect = normalizeMarqueeRect(startWorld, curWorld);
  const mode = modeOverride ?? resolveMarqueeMode(startWorld.x, curWorld.x);
  const hits: SelectionTarget[] = [];

  if (level.layers.furniture !== false) {
    for (const f of level.furniture) {
      if (f.visible === false) continue;
      if (doesFurnitureMatchMarquee(f, rect, mode)) {
        hits.push({ kind: 'furniture', id: f.id });
      }
    }
  }

  if (level.layers.walls !== false) {
    for (const w of level.walls) {
      if (w.visible === false) continue;
      if (doesWallMatchMarquee(w, level.walls, rect, mode)) {
        hits.push({ kind: 'wall', id: w.id });
      }
    }
  }

  if (level.layers.openings !== false) {
    const wallMap = new Map(level.walls.map((w) => [w.id, w]));
    for (const op of level.openings) {
      if (op.visible === false) continue;
      const wall = wallMap.get(op.wallId);
      if (!wall || wall.visible === false) continue;
      const corners = getOpeningFootprintCorners(op, wall);
      const matched =
        mode === 'enclosed'
          ? polygonEnclosedInRect(corners, rect)
          : polygonIntersectsRect(corners, rect);
      if (matched) {
        hits.push({ kind: 'opening', id: op.id });
      }
    }
  }

  if (level.layers.archElements !== false) {
    for (const el of level.archElements) {
      if (el.visible === false) continue;
      if (doesArchElementMatchMarquee(el, rect, mode)) {
        hits.push({ kind: 'arch', id: el.id });
      }
    }
  }

  if (level.layers.curtains !== false) {
    for (const c of level.curtains) {
      if (c.visible === false) continue;
      const corners = getCurtainFootprintCorners(c);
      const matched =
        mode === 'enclosed'
          ? polygonEnclosedInRect(corners, rect)
          : polygonIntersectsRect(corners, rect);
      if (matched) {
        hits.push({ kind: 'curtain', id: c.id });
      }
    }
  }

  if (level.layers.people !== false) {
    for (const p of level.people) {
      if (p.visible === false) continue;
      const corners = getPersonFootprintCorners(p);
      const matched =
        mode === 'enclosed'
          ? polygonEnclosedInRect(corners, rect)
          : polygonIntersectsRect(corners, rect);
      if (matched) {
        hits.push({ kind: 'person', id: p.id });
      }
    }
  }

  return hits;
}

export function mergeMarqueeSelection(
  existing: SelectionTarget[],
  hits: SelectionTarget[],
  additive: boolean
): SelectionTarget[] {
  if (!additive) return hits;
  if (hits.length === 0) return existing;
  const seen = new Set(existing.map((s) => `${s.kind}:${s.id}`));
  const next = [...existing];
  for (const h of hits) {
    const key = `${h.kind}:${h.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      next.push(h);
    }
  }
  return next;
}

export function resolvePlainStackClickId(stackHitIds: string[]): string | null {
  return stackHitIds.length > 0 ? stackHitIds[0] : null;
}

export function resolveAltStackClickId(
  stackHitIds: string[],
  selection: SelectionTarget[]
): string | null {
  if (stackHitIds.length === 0) return null;
  if (stackHitIds.length === 1) return stackHitIds[0];
  const selectedIds = new Set(
    selection.filter((s) => s.kind === 'furniture').map((s) => s.id)
  );
  const curIdx = stackHitIds.findIndex((id) => selectedIds.has(id));
  if (curIdx >= 0) {
    return stackHitIds[(curIdx + 1) % stackHitIds.length];
  }
  return stackHitIds[1];
}

export function getAdjacentStackLayerIds(
  orderedTopToBottomIds: string[],
  targetId: string
): { aboveId: string | null; belowId: string | null } {
  const idx = orderedTopToBottomIds.indexOf(targetId);
  if (idx < 0 || orderedTopToBottomIds.length <= 1) {
    return { aboveId: null, belowId: null };
  }
  return {
    aboveId: idx > 0 ? orderedTopToBottomIds[idx - 1] : null,
    belowId: idx < orderedTopToBottomIds.length - 1 ? orderedTopToBottomIds[idx + 1] : null,
  };
}

export interface WheelInput {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
}

export type WheelGesture =
  | { kind: 'zoom'; factor: number; normalizedDeltaY: number }
  | { kind: 'pan'; deltaX: number; deltaY: number };

export function normalizeWheelDeltaPx(delta: number, deltaMode: number): number {
  if (deltaMode === 1) return delta * 32; // DOM_DELTA_LINE
  if (deltaMode === 2) return delta * 400; // DOM_DELTA_PAGE
  return delta;
}

export function classifyWheelGesture(input: WheelInput): WheelGesture {
  const isPinchOrCtrl = input.ctrlKey || input.metaKey;
  const normY = normalizeWheelDeltaPx(input.deltaY, input.deltaMode);
  const normX = normalizeWheelDeltaPx(input.deltaX, input.deltaMode);

  if (isPinchOrCtrl) {
    const clamped = Math.max(-360, Math.min(360, normY));
    const factor = Math.max(0.5, Math.min(2.0, Math.exp(-clamped * 0.0045)));
    return { kind: 'zoom', factor, normalizedDeltaY: normY };
  }

  if (input.deltaMode !== 0) {
    const clamped = Math.max(-360, Math.min(360, normY));
    const factor = Math.max(0.5, Math.min(2.0, Math.exp(-clamped * 0.0014)));
    return { kind: 'zoom', factor, normalizedDeltaY: normY };
  }

  const hasHorizontal = Math.abs(normX) > 0.01;
  const isFractionalY = !Number.isInteger(input.deltaY);
  const isSmallTrackpadStep = Math.abs(input.deltaY) > 0 && Math.abs(input.deltaY) < 48;

  if (hasHorizontal || isFractionalY || isSmallTrackpadStep) {
    return { kind: 'pan', deltaX: normX, deltaY: normY };
  }

  const clamped = Math.max(-360, Math.min(360, normY));
  const factor = Math.max(0.5, Math.min(2.0, Math.exp(-clamped * 0.0014)));
  return { kind: 'zoom', factor, normalizedDeltaY: normY };
}

export function computeAnchoredZoom(
  currentZoom: number,
  currentPanPx: Point2D,
  cursorRelCenterPx: Point2D,
  factor: number,
  minZoom: number,
  maxZoom: number
): { zoom: number; panPx: Point2D } {
  const nextZoom = Math.max(minZoom, Math.min(maxZoom, currentZoom * factor));
  const ratio = nextZoom / Math.max(1e-6, currentZoom);
  return {
    zoom: nextZoom,
    panPx: {
      x: cursorRelCenterPx.x - (cursorRelCenterPx.x - currentPanPx.x) * ratio,
      y: cursorRelCenterPx.y - (cursorRelCenterPx.y - currentPanPx.y) * ratio,
    },
  };
}
