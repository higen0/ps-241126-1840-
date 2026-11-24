import { FurnitureInstance, Point2D } from '../types/plan.ts';
import {
  computeFurnitureCanopyUndersideZMm,
  computeFurnitureElevationSpanMm,
  FurnitureElevationPlanInfo,
  getFurnitureOrientedCorners,
  getFurnitureSolidFootprintPrimitives,
  intersectConvexPolygons2D,
  isCeilingFixture,
  isRugFurniture,
  polygonSignedArea2D,
  pointInPolygon,
  projectPointOnSegment,
} from './geometry.ts';
import { resolveFurnitureMountingType } from './mounting.ts';

export interface StackAdjacentShadow {
  key: string;
  upperId: string;
  lowerId: string;
  elevGapMm: number;
  offsetPx: number;
  offsetMm: number;
  polygons: Point2D[][];
}

export interface StackFullCoverHairlineCluster {
  upperId: string;
  /** Number of fully covered lower layers underneath (1..3) */
  count: number;
  basePolygons: Point2D[][];
}

export interface PlanStackVisualData {
  /** Keyed by lower furniture ID: intersection polygons with all covering items above it */
  overlapClipPolygonsByLowerId: Map<string, Point2D[][]>;
  /** Keyed by upper furniture ID: contact shadows cast onto immediately adjacent lower layers */
  shadowsBeforeUpperId: Map<string, StackAdjacentShadow[]>;
  /** Keyed by covering upper furniture ID: 1..3 hairline offset outlines when lower item(s) are fully covered */
  fullCoverHairlinesByUpperId: Map<string, StackFullCoverHairlineCluster>;
}

/**
 * Computes the constant-screen-pixel bottom-right contact shadow offset (px)
 * from the vertical elevation gap between an upper and adjacent lower layer.
 */
export function computeContactShadowOffsetPx(elevGapMm: number): number {
  const safeGap = Math.max(0, elevGapMm);
  return Math.min(10, 2.5 + safeGap / 95);
}

/**
 * Expands a convex 2D polygon outward by `outsetMm` using edge-normal offsets
 * so full-cover hairline rings track arbitrary rotated footprints cleanly.
 */
export function outsetPolygon2D(poly: Point2D[], outsetMm: number): Point2D[] {
  if (poly.length < 3 || outsetMm <= 0.05) return poly;

  // Normalize to CCW winding
  const area = polygonSignedArea2D(poly);
  const pts = area < 0 ? [...poly].reverse() : poly;
  if (Math.abs(area) <= 1) return pts;

  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= pts.length;
  cy /= pts.length;

  interface EdgeLine {
    px: number;
    py: number;
    dx: number;
    dy: number;
  }
  const edges: EdgeLine[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len < 1e-4) continue;
    // In CCW coordinates in screen/world plane, (ey, -ex) points outward
    const nx = ey / len;
    const ny = -ex / len;
    edges.push({
      px: a.x + nx * outsetMm,
      py: a.y + ny * outsetMm,
      dx: ex / len,
      dy: ey / len,
    });
  }
  if (edges.length < 3) return pts;

  const out: Point2D[] = [];
  let valid = true;
  for (let i = 0; i < edges.length; i++) {
    const e1 = edges[(i - 1 + edges.length) % edges.length];
    const e2 = edges[i];
    const denom = e1.dx * e2.dy - e1.dy * e2.dx;
    if (Math.abs(denom) < 1e-4) {
      valid = false;
      break;
    }
    const t = ((e2.px - e1.px) * e2.dy - (e2.py - e1.py) * e2.dx) / denom;
    const ix = e1.px + t * e1.dx;
    const iy = e1.py + t * e1.dy;
    const orig = pts[i % pts.length];
    if (Math.hypot(ix - orig.x, iy - orig.y) > outsetMm * 6) {
      valid = false;
      break;
    }
    out.push({ x: ix, y: iy });
  }

  if (valid && out.length >= 3) {
    return out;
  }

  // Fallback radial scale around centroid
  const perim = pts.reduce((acc, p, i) => {
    const nxt = pts[(i + 1) % pts.length];
    return acc + Math.hypot(nxt.x - p.x, nxt.y - p.y);
  }, 0);
  const inradius = Math.max(10, (2 * Math.abs(area)) / Math.max(1, perim));
  const scale = 1 + outsetMm / inradius;
  return pts.map((p) => ({
    x: cx + (p.x - cx) * scale,
    y: cy + (p.y - cy) * scale,
  }));
}

function getBoundsPolygonPolys(
  f: FurnitureInstance,
  tween?: { targetKey: string; dx: number; dy: number } | null
): Point2D[][] {
  const dx =
    tween &&
    (tween.targetKey === `furniture:${f.id}` ||
      (f.surfaceHostId && tween.targetKey === `furniture:${f.surfaceHostId}`))
      ? tween.dx
      : 0;
  const dy =
    tween &&
    (tween.targetKey === `furniture:${f.id}` ||
      (f.surfaceHostId && tween.targetKey === `furniture:${f.surfaceHostId}`))
      ? tween.dy
      : 0;
  const pos = { x: f.xMm + dx, y: f.yMm + dy };
  const prims = getFurnitureSolidFootprintPrimitives(pos, f);
  if (prims.length > 0) {
    return prims.map((p) => p.poly);
  }
  return [getFurnitureOrientedCorners(pos, f)];
}

function getEffectiveEnvelopePolys(
  f: FurnitureInstance,
  tween?: { targetKey: string; dx: number; dy: number } | null
): Point2D[][] {
  const dx =
    tween &&
    (tween.targetKey === `furniture:${f.id}` ||
      (f.surfaceHostId && tween.targetKey === `furniture:${f.surfaceHostId}`))
      ? tween.dx
      : 0;
  const dy =
    tween &&
    (tween.targetKey === `furniture:${f.id}` ||
      (f.surfaceHostId && tween.targetKey === `furniture:${f.surfaceHostId}`))
      ? tween.dy
      : 0;
  const pos = { x: f.xMm + dx, y: f.yMm + dy };
  const corners = getFurnitureOrientedCorners(pos, f);
  const prims = getFurnitureSolidFootprintPrimitives(pos, f);
  // Single-part or table/canopy whose top covers bounding envelope: corners cleanly clip internal details
  if (prims.length <= 1 || computeFurnitureCanopyUndersideZMm(f) !== null) {
    return [corners];
  }
  return prims.map((p) => p.poly);
}

function shiftPolygons(polys: Point2D[][], dx: number, dy: number): Point2D[][] {
  return polys.map((poly) => poly.map((p) => ({ x: p.x + dx, y: p.y + dy })));
}

function intersectPolygonSets(polysA: Point2D[][], polysB: Point2D[][], minAreaMm2 = 25): Point2D[][] {
  const out: Point2D[][] = [];
  for (const a of polysA) {
    for (const b of polysB) {
      const inter = intersectConvexPolygons2D(a, b);
      if (inter.length >= 3 && Math.abs(polygonSignedArea2D(inter)) >= minAreaMm2) {
        out.push(inter);
      }
    }
  }
  return out;
}

function isPointInsideAnyPolygonWithTol(pt: Point2D, polys: Point2D[][], tolMm = 8): boolean {
  for (const poly of polys) {
    if (pointInPolygon(pt, poly)) return true;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if (projectPointOnSegment(pt, a, b).distance <= tolMm) return true;
    }
  }
  return false;
}

function isFootprintFullyCoveredByUpperPolys(
  lowerPolys: Point2D[][],
  upperPolys: Point2D[][],
  tolMm = 8
): boolean {
  if (lowerPolys.length === 0 || upperPolys.length === 0) return false;
  for (const poly of lowerPolys) {
    let cx = 0;
    let cy = 0;
    for (const v of poly) {
      cx += v.x;
      cy += v.y;
      if (!isPointInsideAnyPolygonWithTol(v, upperPolys, tolMm)) {
        return false;
      }
    }
    const centroid = { x: cx / poly.length, y: cy / poly.length };
    if (!isPointInsideAnyPolygonWithTol(centroid, upperPolys, tolMm)) {
      return false;
    }
  }
  return true;
}

/**
 * Computes per-stack visual overlays for Milestone 3:
 * 1. Exact overlap clip polygons for each covered lower object (clipped dashed contour).
 * 2. Unblurred screen-pixel contact shadows between vertically adjacent pairs.
 * 3. 1–3 outward hairline offset outlines when an upper object fully covers lower layer(s).
 */
export function computePlanStackVisualData(
  orderedPlanFurniture: FurnitureInstance[],
  furnElevInfo: Map<string, FurnitureElevationPlanInfo>,
  pxPerMm: number,
  effectiveCeilingMm?: number,
  snapTweenOffset?: { targetKey: string; dx: number; dy: number } | null
): PlanStackVisualData {
  const overlapClipPolygonsByLowerId = new Map<string, Point2D[][]>();
  const shadowsBeforeUpperId = new Map<string, StackAdjacentShadow[]>();
  const fullCoverHairlinesByUpperId = new Map<string, StackFullCoverHairlineCluster>();

  const visibleOrdered = orderedPlanFurniture.filter((f) => f.visible !== false);
  if (visibleOrdered.length < 2) {
    return {
      overlapClipPolygonsByLowerId,
      shadowsBeforeUpperId,
      fullCoverHairlinesByUpperId,
    };
  }

  const orderIndexById = new Map<string, number>();
  const furnById = new Map<string, FurnitureInstance>();
  const envelopeCache = new Map<string, Point2D[][]>();
  const primPolysCache = new Map<string, Point2D[][]>();
  const spanCache = new Map<string, { minZ: number; maxZ: number }>();
  const canopyCache = new Map<string, number | null>();

  visibleOrdered.forEach((f, idx) => {
    orderIndexById.set(f.id, idx);
    furnById.set(f.id, f);
  });

  const getEnvelope = (f: FurnitureInstance): Point2D[][] => {
    let v = envelopeCache.get(f.id);
    if (!v) {
      v = getEffectiveEnvelopePolys(f, snapTweenOffset);
      envelopeCache.set(f.id, v);
    }
    return v;
  };

  const getPrims = (f: FurnitureInstance): Point2D[][] => {
    let v = primPolysCache.get(f.id);
    if (!v) {
      v = getBoundsPolygonPolys(f, snapTweenOffset);
      primPolysCache.set(f.id, v);
    }
    return v;
  };

  const getSpan = (f: FurnitureInstance) => {
    const infoSpan = furnElevInfo.get(f.id)?.span;
    if (infoSpan) return infoSpan;
    let s = spanCache.get(f.id);
    if (!s) {
      s = computeFurnitureElevationSpanMm(f, effectiveCeilingMm);
      spanCache.set(f.id, s);
    }
    return s;
  };

  const getCanopy = (f: FurnitureInstance): number | null => {
    const infoCanopy = furnElevInfo.get(f.id)?.canopyUndersideZ;
    if (infoCanopy !== undefined) return infoCanopy;
    let c = canopyCache.get(f.id);
    if (c === undefined) {
      c = computeFurnitureCanopyUndersideZMm(f, effectiveCeilingMm);
      canopyCache.set(f.id, c);
    }
    return c;
  };

  const safePxPerMm = Math.max(0.015, pxPerMm);

  // 1. Overlap clip polygons for each covered lower item (union of intersections with items above it)
  for (const lower of visibleOrdered) {
    const info = furnElevInfo.get(lower.id);
    if (!info || info.coveredByUpperIds.length === 0) continue;
    if (isCeilingFixture(lower)) continue;

    const lowerEnvs = getEnvelope(lower);
    const clipPolys: Point2D[][] = [];

    for (const upperId of info.coveredByUpperIds) {
      const upper = furnById.get(upperId);
      if (!upper || isCeilingFixture(upper)) continue;
      const upperEnvs = getEnvelope(upper);
      const inters = intersectPolygonSets(lowerEnvs, upperEnvs, 20);
      for (const poly of inters) {
        clipPolys.push(poly);
      }
    }

    if (clipPolys.length > 0) {
      overlapClipPolygonsByLowerId.set(lower.id, clipPolys);
    }
  }

  // 2. Contact shadows between vertically adjacent layers
  for (const upper of visibleOrdered) {
    if (isCeilingFixture(upper) || isRugFurniture(upper)) continue;
    const upperInfo = furnElevInfo.get(upper.id);
    if (!upperInfo || upperInfo.coveringLowerIds.length === 0) continue;

    const upperIdx = orderIndexById.get(upper.id) ?? 0;
    const upperMounting = resolveFurnitureMountingType(upper);
    const upperIsWall = upperMounting === 'wall';
    const upperSpan = getSpan(upper);
    const upperCanopy = getCanopy(upper);
    const upperEnvs = getEnvelope(upper);

    // Candidate lowers must strictly appear below upper in draw order & share mounting domain
    const candidateLowerIds = upperInfo.coveringLowerIds.filter((lid) => {
      const l = furnById.get(lid);
      if (!l || isCeilingFixture(l)) return false;
      if ((resolveFurnitureMountingType(l) === 'wall') !== upperIsWall) return false;
      return (orderIndexById.get(lid) ?? 0) < upperIdx;
    });

    const pairShadows: StackAdjacentShadow[] = [];

    for (const lowerId of candidateLowerIds) {
      const lower = furnById.get(lowerId)!;
      const lowerInfo = furnElevInfo.get(lowerId);
      const lowerEnvs = getEnvelope(lower);

      // Determine whether an intermediate item sits strictly between lower and upper
      // overlapping their shared footprint region.
      const sharedInters = intersectPolygonSets(upperEnvs, lowerEnvs, 25);
      if (sharedInters.length === 0) continue;

      const hasIntermediate = candidateLowerIds.some((midId) => {
        if (midId === lowerId) return false;
        const mid = furnById.get(midId);
        const midInfo = furnElevInfo.get(midId);
        if (!mid || !midInfo || isCeilingFixture(mid)) return false;
        if (!midInfo.coveringLowerIds.includes(lowerId)) return false;
        if (lowerInfo && !lowerInfo.coveredByUpperIds.includes(midId)) return false;
        const midEnvs = getEnvelope(mid);
        return intersectPolygonSets(sharedInters, midEnvs, 25).length > 0;
      });
      if (hasIntermediate) continue;

      const lowerSpan = getSpan(lower);
      const effectiveUpperBottomZ =
        upperCanopy !== null && upperCanopy >= lowerSpan.maxZ - 35
          ? upperCanopy
          : upperSpan.minZ;
      const elevGapMm = Math.max(0, effectiveUpperBottomZ - lowerSpan.maxZ);
      const offsetPx = computeContactShadowOffsetPx(elevGapMm);
      const offsetMm = offsetPx / safePxPerMm;

      const shiftedUpperEnvs = shiftPolygons(upperEnvs, offsetMm, offsetMm);
      const shadowPolys = intersectPolygonSets(shiftedUpperEnvs, lowerEnvs, 15);
      if (shadowPolys.length > 0) {
        pairShadows.push({
          key: `shadow_${upper.id}_${lower.id}`,
          upperId: upper.id,
          lowerId: lower.id,
          elevGapMm,
          offsetPx,
          offsetMm,
          polygons: shadowPolys,
        });
      }
    }

    if (pairShadows.length > 0) {
      shadowsBeforeUpperId.set(upper.id, pairShadows);
    }
  }

  // 3. Full-coverage 1-3 hairline offset outlines on covering items not themselves fully hidden above
  for (const upper of visibleOrdered) {
    if (isCeilingFixture(upper) || isRugFurniture(upper)) continue;
    const upperInfo = furnElevInfo.get(upper.id);
    if (!upperInfo || upperInfo.coveringLowerIds.length === 0) continue;

    const upperEnvs = getEnvelope(upper);
    const upperPrims = getPrims(upper);

    // If an item strictly above `upper` already fully covers `upper`, let that higher item carry the hairline rings
    const isUpperFullyCoveredAbove = upperInfo.coveredByUpperIds.some((aboveId) => {
      const above = furnById.get(aboveId);
      if (!above || isCeilingFixture(above)) return false;
      return isFootprintFullyCoveredByUpperPolys(upperEnvs, getEnvelope(above), 8);
    });
    if (isUpperFullyCoveredAbove) continue;

    // Gather all transitive non-ceiling covered lowers beneath `upper`
    const visitedLowers = new Set<string>();
    const queue = [...upperInfo.coveringLowerIds];
    while (queue.length > 0) {
      const lid = queue.pop()!;
      if (visitedLowers.has(lid)) continue;
      visitedLowers.add(lid);
      const lInfo = furnElevInfo.get(lid);
      if (lInfo) {
        for (const subId of lInfo.coveringLowerIds) {
          if (!visitedLowers.has(subId)) queue.push(subId);
        }
      }
    }

    let fullyCoveredCount = 0;
    for (const lid of visitedLowers) {
      const lower = furnById.get(lid);
      if (!lower || isCeilingFixture(lower)) continue;
      const lowerEnvs = getEnvelope(lower);
      if (isFootprintFullyCoveredByUpperPolys(lowerEnvs, upperEnvs, 8)) {
        fullyCoveredCount++;
      }
    }

    if (fullyCoveredCount > 0) {
      fullCoverHairlinesByUpperId.set(upper.id, {
        upperId: upper.id,
        count: Math.min(3, fullyCoveredCount),
        basePolygons: upperEnvs.length > 0 ? upperEnvs : upperPrims,
      });
    }
  }

  return {
    overlapClipPolygonsByLowerId,
    shadowsBeforeUpperId,
    fullCoverHairlinesByUpperId,
  };
}
