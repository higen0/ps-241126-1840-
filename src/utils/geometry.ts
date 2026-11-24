import {
  ArchElement,
  Curtain,
  FurnitureInstance,
  FurniturePart,
  Level,
  Opening,
  Point2D,
  ProjectionViewId,
  ResizeAnchor,
  Room,
  Wall,
  WallAlignment,
} from '../types/plan';
import {
  resolveFurnitureMountingType,
} from './mounting';
import {
  pickWithSnapHysteresis,
  type SnapHysteresisState,
} from './dragErgonomics';
import { getCanonicalPartBoundaryVertices3DMm } from './partGeometry3d';
import { uid } from './units';

export function dist(a: Point2D, b: Point2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function lerpPoint(a: Point2D, b: Point2D, t: number): Point2D {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function wallOffsets(thicknessMm: number, alignment: WallAlignment): { left: number; right: number } {
  // Left normal is (-dy/L, dx/L)
  if (alignment === 'inner') {
    return { left: thicknessMm, right: 0 };
  }
  if (alignment === 'outer') {
    return { left: 0, right: -thicknessMm };
  }
  return { left: thicknessMm / 2, right: -thicknessMm / 2 };
}

export function projectPointOnSegment(
  p: Point2D,
  a: Point2D,
  b: Point2D
): { point: Point2D; t: number; distance: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-6) {
    return { point: { ...a }, t: 0, distance: dist(p, a) };
  }
  const rawT = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  const t = Math.max(0, Math.min(1, rawT));
  const proj = { x: a.x + t * dx, y: a.y + t * dy };
  return { point: proj, t, distance: dist(p, proj) };
}

export function lineIntersection(
  p1: Point2D,
  d1: Point2D,
  p2: Point2D,
  d2: Point2D
): Point2D | null {
  const cross = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(cross) < 1e-6) return null;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const t = (dx * d2.y - dy * d2.x) / cross;
  return { x: p1.x + t * d1.x, y: p1.y + t * d1.y };
}

export function segmentIntersection(
  a1: Point2D,
  a2: Point2D,
  b1: Point2D,
  b2: Point2D
): { point: Point2D; tA: number; tB: number } | null {
  const dA = { x: a2.x - a1.x, y: a2.y - a1.y };
  const dB = { x: b2.x - b1.x, y: b2.y - b1.y };
  const cross = dA.x * dB.y - dA.y * dB.x;
  if (Math.abs(cross) < 1e-6) return null;
  const dx = b1.x - a1.x;
  const dy = b1.y - a1.y;
  const tA = (dx * dB.y - dy * dB.x) / cross;
  const tB = (dx * dA.y - dy * dA.x) / cross;
  if (tA > 0.001 && tA < 0.999 && tB > 0.001 && tB < 0.999) {
    return {
      point: { x: a1.x + tA * dA.x, y: a1.y + tA * dA.y },
      tA,
      tB,
    };
  }
  return null;
}

export function getWallCenterlinePoint(wall: Wall, t: number): {
  point: Point2D;
  tangent: Point2D;
  normal: Point2D;
} {
  if (!wall.isCurved || Math.abs(wall.curveBulgeMm) < 1) {
    const dx = wall.end.x - wall.start.x;
    const dy = wall.end.y - wall.start.y;
    const len = Math.hypot(dx, dy) || 1;
    const tangent = { x: dx / len, y: dy / len };
    const normal = { x: -tangent.y, y: tangent.x };
    return {
      point: lerpPoint(wall.start, wall.end, t),
      tangent,
      normal,
    };
  }

  // Quadratic Bezier where control point is midpoint + normal * 2 * curveBulgeMm
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const len = Math.hypot(dx, dy) || 1;
  const baseNormal = { x: -dy / len, y: dx / len };
  const mid = lerpPoint(wall.start, wall.end, 0.5);
  const ctrl = {
    x: mid.x + baseNormal.x * wall.curveBulgeMm * 2,
    y: mid.y + baseNormal.y * wall.curveBulgeMm * 2,
  };

  const u = 1 - t;
  const point = {
    x: u * u * wall.start.x + 2 * u * t * ctrl.x + t * t * wall.end.x,
    y: u * u * wall.start.y + 2 * u * t * ctrl.y + t * t * wall.end.y,
  };
  const dxdt = 2 * u * (ctrl.x - wall.start.x) + 2 * t * (wall.end.x - ctrl.x);
  const dydt = 2 * u * (ctrl.y - wall.start.y) + 2 * t * (wall.end.y - ctrl.y);
  const tLen = Math.hypot(dxdt, dydt) || 1;
  const tangent = { x: dxdt / tLen, y: dydt / tLen };
  const normal = { x: -tangent.y, y: tangent.x };
  return { point, tangent, normal };
}

export function getWallArcLength(wall: Wall): number {
  if (!wall.isCurved || Math.abs(wall.curveBulgeMm) < 1) {
    return dist(wall.start, wall.end);
  }
  let total = 0;
  let prev = wall.start;
  const steps = 20;
  for (let i = 1; i <= steps; i++) {
    const cur = getWallCenterlinePoint(wall, i / steps).point;
    total += dist(prev, cur);
    prev = cur;
  }
  return total;
}

/**
 * Computes a clean 2D wall polygon with mitered corner joins and T-junction awareness.
 * Ensures wall thickness joins seamlessly without eating into interior space.
 */
export function computeWallPolygon(wall: Wall, allWalls: Wall[]): Point2D[] {
  if (wall.isCurved && Math.abs(wall.curveBulgeMm) >= 1) {
    const steps = 18;
    const { left, right } = wallOffsets(wall.thicknessMm, wall.alignment);
    const leftPts: Point2D[] = [];
    const rightPts: Point2D[] = [];
    for (let i = 0; i <= steps; i++) {
      const { point, normal } = getWallCenterlinePoint(wall, i / steps);
      leftPts.push({ x: point.x + normal.x * left, y: point.y + normal.y * left });
      rightPts.push({ x: point.x + normal.x * right, y: point.y + normal.y * right });
    }
    return [...leftPts, ...rightPts.reverse()];
  }

  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return [];

  const u = { x: dx / len, y: dy / len };
  const n = { x: -u.y, y: u.x };
  const { left, right } = wallOffsets(wall.thicknessMm, wall.alignment);

  let sLeft = { x: wall.start.x + n.x * left, y: wall.start.y + n.y * left };
  let sRight = { x: wall.start.x + n.x * right, y: wall.start.y + n.y * right };
  let eLeft = { x: wall.end.x + n.x * left, y: wall.end.y + n.y * left };
  let eRight = { x: wall.end.x + n.x * right, y: wall.end.y + n.y * right };

  const maxMitreDist = Math.max(wall.thicknessMm * 4, 800);
  const joinTolMm = 6;

  const clampMitrePoint = (pt: Point2D | null, vertex: Point2D, fallback: Point2D): Point2D => {
    if (!pt) return fallback;
    const d = dist(pt, vertex);
    if (d <= maxMitreDist) return pt;
    if (d < 1e-3) return fallback;
    const scale = maxMitreDist / d;
    return {
      x: vertex.x + (pt.x - vertex.x) * scale,
      y: vertex.y + (pt.y - vertex.y) * scale,
    };
  };

  const computeMitreAtEndpoint = (
    vertex: Point2D,
    isStart: boolean,
    defaultLeft: Point2D,
    defaultRight: Point2D
  ): { leftPt: Point2D; rightPt: Point2D } => {
    const dirOut = isStart ? u : { x: -u.x, y: -u.y };
    const baseAngle = Math.atan2(dirOut.y, dirOut.x);

    const neighbors: Array<{
      delta: number;
      ou: Point2D;
      plusFacePt: Point2D;
      minusFacePt: Point2D;
    }> = [];

    for (const other of allWalls) {
      if (other.id === wall.id || other.isCurved) continue;
      const startsAtVertex = dist(other.start, vertex) < joinTolMm;
      const endsAtVertex = dist(other.end, vertex) < joinTolMm;
      if (!startsAtVertex && !endsAtVertex) continue;

      const odx = other.end.x - other.start.x;
      const ody = other.end.y - other.start.y;
      const olen = Math.hypot(odx, ody);
      if (olen < 1) continue;

      const ou = { x: odx / olen, y: ody / olen };
      const on = { x: -ou.y, y: ou.x };
      const oOff = wallOffsets(other.thicknessMm, other.alignment);
      const oDirOut = startsAtVertex ? ou : { x: -ou.x, y: -ou.y };

      let delta = Math.atan2(oDirOut.y, oDirOut.x) - baseAngle;
      delta = ((delta % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      if (delta < 0.015 || delta > Math.PI * 2 - 0.015) continue;

      // Relative to oDirOut, +oPerp is left-normal of oDirOut.
      // When other starts at vertex, on === +oPerp (left is +oPerp, right is -oPerp).
      // When other ends at vertex, on === -oPerp (right is +oPerp, left is -oPerp).
      const plusOff = startsAtVertex ? oOff.left : oOff.right;
      const minusOff = startsAtVertex ? oOff.right : oOff.left;

      neighbors.push({
        delta,
        ou,
        plusFacePt: { x: vertex.x + on.x * plusOff, y: vertex.y + on.y * plusOff },
        minusFacePt: { x: vertex.x + on.x * minusOff, y: vertex.y + on.y * minusOff },
      });
    }

    if (neighbors.length >= 1) {
      neighbors.sort((a, b) => a.delta - b.delta);
      const ccwNeighbor = neighbors[0]; // meets wall's +perp(dirOut) face with its -oPerp face
      const cwNeighbor = neighbors[neighbors.length - 1]; // meets wall's -perp(dirOut) face with its +oPerp face

      // At isStart, wall.left is +perp(dirOut) and wall.right is -perp(dirOut).
      // At !isStart, wall.right is +perp(dirOut) and wall.left is -perp(dirOut).
      const leftInt = isStart
        ? lineIntersection(defaultLeft, u, ccwNeighbor.minusFacePt, ccwNeighbor.ou)
        : lineIntersection(defaultLeft, u, cwNeighbor.plusFacePt, cwNeighbor.ou);
      const rightInt = isStart
        ? lineIntersection(defaultRight, u, cwNeighbor.plusFacePt, cwNeighbor.ou)
        : lineIntersection(defaultRight, u, ccwNeighbor.minusFacePt, ccwNeighbor.ou);

      return {
        leftPt: clampMitrePoint(leftInt, vertex, defaultLeft),
        rightPt: clampMitrePoint(rightInt, vertex, defaultRight),
      };
    }

    // Check if endpoint terminates in a T-junction on another wall body
    for (const other of allWalls) {
      if (other.id === wall.id || other.isCurved) continue;
      const proj = projectPointOnSegment(vertex, other.start, other.end);
      if (proj.distance < joinTolMm && proj.t > 0.01 && proj.t < 0.99) {
        const odx = other.end.x - other.start.x;
        const ody = other.end.y - other.start.y;
        const olen = Math.hypot(odx, ody) || 1;
        const ou = { x: odx / olen, y: ody / olen };
        const on = { x: -ou.y, y: ou.x };
        const oOff = wallOffsets(other.thicknessMm, other.alignment);
        const wallMid = lerpPoint(wall.start, wall.end, 0.5);
        const sideSign = (wallMid.x - vertex.x) * on.x + (wallMid.y - vertex.y) * on.y;
        const faceOffset = sideSign >= 0 ? oOff.left : oOff.right;
        const facePt = { x: vertex.x + on.x * faceOffset, y: vertex.y + on.y * faceOffset };

        const intL = lineIntersection(defaultLeft, u, facePt, ou);
        const intR = lineIntersection(defaultRight, u, facePt, ou);
        return {
          leftPt: clampMitrePoint(intL, vertex, defaultLeft),
          rightPt: clampMitrePoint(intR, vertex, defaultRight),
        };
      }
    }

    return { leftPt: defaultLeft, rightPt: defaultRight };
  };

  const startMitre = computeMitreAtEndpoint(wall.start, true, sLeft, sRight);
  const endMitre = computeMitreAtEndpoint(wall.end, false, eLeft, eRight);
  sLeft = startMitre.leftPt;
  sRight = startMitre.rightPt;
  eLeft = endMitre.leftPt;
  eRight = endMitre.rightPt;

  return [sLeft, eLeft, eRight, sRight];
}

export function computePolygonSignedAreaMm2(points: Point2D[]): number {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

export function computePolygonAreaM2(points: Point2D[]): number {
  return Math.abs(computePolygonSignedAreaMm2(points)) / 1_000_000;
}

export function computePolygonPerimeterM(points: Point2D[]): number {
  if (points.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    total += dist(points[i], points[(i + 1) % points.length]);
  }
  return total / 1000;
}

export function pointInPolygon(p: Point2D, poly: Point2D[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect =
      yi > p.y !== yj > p.y &&
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi + 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function polygonCentroid(poly: Point2D[]): Point2D {
  if (poly.length === 0) return { x: 0, y: 0 };
  let sx = 0;
  let sy = 0;
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const p0 = poly[i];
    const p1 = poly[(i + 1) % poly.length];
    const cross = p0.x * p1.y - p1.x * p0.y;
    sx += (p0.x + p1.x) * cross;
    sy += (p0.y + p1.y) * cross;
    area += cross;
  }
  if (Math.abs(area) < 1e-3) {
    const avgX = poly.reduce((acc, p) => acc + p.x, 0) / poly.length;
    const avgY = poly.reduce((acc, p) => acc + p.y, 0) / poly.length;
    return { x: avgX, y: avgY };
  }
  return { x: sx / (3 * area), y: sy / (3 * area) };
}

/**
 * Computes a room's true geometric center, falling back cleanly inside the
 * room polygon for strongly concave (L-shaped / U-shaped) rooms where the
 * raw polygon centroid may lie near or outside a wall.
 */
export function computeRoomGeometricCenter(room: Pick<Room, 'polygon'>): Point2D {
  const poly = room.polygon;
  if (poly.length === 0) return { x: 0, y: 0 };
  const centroid = polygonCentroid(poly);
  if (poly.length < 3) {
    return { x: Math.round(centroid.x), y: Math.round(centroid.y) };
  }

  const minEdgeDist = (pt: Point2D): number => {
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const d = projectPointOnSegment(pt, poly[i], poly[(i + 1) % poly.length]).distance;
      if (d < best) best = d;
    }
    return best;
  };

  if (pointInPolygon(centroid, poly) && minEdgeDist(centroid) >= 80) {
    return { x: Math.round(centroid.x), y: Math.round(centroid.y) };
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  const w = Math.max(10, maxX - minX);
  const h = Math.max(10, maxY - minY);
  let bestPt = centroid;
  let bestScore = -Infinity;
  const steps = 16;

  for (let ix = 1; ix < steps; ix++) {
    for (let iy = 1; iy < steps; iy++) {
      const probe = { x: minX + (w * ix) / steps, y: minY + (h * iy) / steps };
      if (!pointInPolygon(probe, poly)) continue;
      const clearance = minEdgeDist(probe);
      const score = clearance - 0.35 * dist(probe, centroid);
      if (score > bestScore) {
        bestScore = score;
        bestPt = probe;
      }
    }
  }

  if (bestScore > -Infinity) {
    const stepX = w / steps;
    const stepY = h / steps;
    for (let rx = -2; rx <= 2; rx++) {
      for (let ry = -2; ry <= 2; ry++) {
        const probe = { x: bestPt.x + (rx * stepX) / 3, y: bestPt.y + (ry * stepY) / 3 };
        if (!pointInPolygon(probe, poly)) continue;
        const clearance = minEdgeDist(probe);
        const score = clearance - 0.35 * dist(probe, centroid);
        if (score > bestScore) {
          bestScore = score;
          bestPt = probe;
        }
      }
    }
  }

  return { x: Math.round(bestPt.x), y: Math.round(bestPt.y) };
}

/**
 * Splits a wall at point P (or parametric t) and remaps all openings on that wall
 * cleanly onto the resulting two wall segments.
 */
export function splitWallAtPoint(
  wall: Wall,
  splitPt: Point2D,
  openings: Opening[]
): { walls: [Wall, Wall]; openings: Opening[]; tSplit: number } {
  const proj = projectPointOnSegment(splitPt, wall.start, wall.end);
  const tSplit = Math.max(0.05, Math.min(0.95, proj.t));
  const splitPoint = lerpPoint(wall.start, wall.end, tSplit);

  const w1: Wall = {
    ...wall,
    id: wall.id,
    end: splitPoint,
    isCurved: false,
    curveBulgeMm: 0,
  };
  const w2: Wall = {
    ...wall,
    id: uid('wall'),
    start: splitPoint,
    isCurved: false,
    curveBulgeMm: 0,
  };

  const updatedOpenings = openings.map((op) => {
    if (op.wallId !== wall.id) return op;
    if (op.t <= tSplit) {
      return { ...op, t: Math.max(0.05, Math.min(0.95, op.t / tSplit)) };
    }
    return {
      ...op,
      wallId: w2.id,
      t: Math.max(0.05, Math.min(0.95, (op.t - tSplit) / (1 - tSplit))),
    };
  });

  return { walls: [w1, w2], openings: updatedOpenings, tSplit };
}

/**
 * Planar face detection: splits intersecting segments, merges vertices, peels spurs,
 * and extracts all minimal enclosed rooms. Preserves existing room names/styles.
 */
export function detectRoomsFromWalls(
  walls: Wall[],
  existingRooms: Room[],
  defaultCeilingHeightMm = 2800
): Room[] {
  if (walls.length < 3) return [];

  // 1. Sample curved walls as chords and collect raw segments
  interface Seg {
    a: Point2D;
    b: Point2D;
  }
  const rawSegs: Seg[] = [];
  for (const w of walls) {
    if (dist(w.start, w.end) < 20) continue;
    if (w.isCurved && Math.abs(w.curveBulgeMm) >= 1) {
      const steps = 8;
      let prev = w.start;
      for (let i = 1; i <= steps; i++) {
        const cur = getWallCenterlinePoint(w, i / steps).point;
        rawSegs.push({ a: prev, b: cur });
        prev = cur;
      }
    } else {
      rawSegs.push({ a: w.start, b: w.end });
    }
  }

  // 2. Split segments at T-junctions and crossings
  const splitParams: number[][] = rawSegs.map(() => [0, 1]);
  for (let i = 0; i < rawSegs.length; i++) {
    for (let j = i + 1; j < rawSegs.length; j++) {
      const s1 = rawSegs[i];
      const s2 = rawSegs[j];
      const cross = segmentIntersection(s1.a, s1.b, s2.a, s2.b);
      if (cross) {
        splitParams[i].push(cross.tA);
        splitParams[j].push(cross.tB);
      }
      // Check T-junctions (endpoints of s1 on s2 and vice versa)
      for (const pt of [s1.a, s1.b]) {
        const p = projectPointOnSegment(pt, s2.a, s2.b);
        if (p.distance < 6 && p.t > 0.01 && p.t < 0.99) splitParams[j].push(p.t);
      }
      for (const pt of [s2.a, s2.b]) {
        const p = projectPointOnSegment(pt, s1.a, s1.b);
        if (p.distance < 6 && p.t > 0.01 && p.t < 0.99) splitParams[i].push(p.t);
      }
    }
  }

  // 3. Merge close vertices (< 8mm)
  const vertices: Point2D[] = [];
  const getVertexId = (p: Point2D): number => {
    for (let i = 0; i < vertices.length; i++) {
      if (dist(vertices[i], p) < 8) return i;
    }
    vertices.push({ x: p.x, y: p.y });
    return vertices.length - 1;
  };

  const edgeSet = new Set<string>();
  const undirectedEdges: Array<[number, number]> = [];

  for (let i = 0; i < rawSegs.length; i++) {
    const params = Array.from(new Set(splitParams[i].map((t) => Math.round(t * 10000) / 10000))).sort(
      (a, b) => a - b
    );
    for (let k = 0; k < params.length - 1; k++) {
      const p1 = lerpPoint(rawSegs[i].a, rawSegs[i].b, params[k]);
      const p2 = lerpPoint(rawSegs[i].a, rawSegs[i].b, params[k + 1]);
      if (dist(p1, p2) < 15) continue;
      const u = getVertexId(p1);
      const v = getVertexId(p2);
      if (u === v) continue;
      const key = u < v ? `${u}_${v}` : `${v}_${u}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        undirectedEdges.push([u, v]);
      }
    }
  }

  // 4. Peel degree-1 spurs iteratively
  let activeEdges = [...undirectedEdges];
  let changed = true;
  while (changed) {
    changed = false;
    const deg = new Map<number, number>();
    for (const [u, v] of activeEdges) {
      deg.set(u, (deg.get(u) ?? 0) + 1);
      deg.set(v, (deg.get(v) ?? 0) + 1);
    }
    const filtered = activeEdges.filter(([u, v]) => (deg.get(u) ?? 0) >= 2 && (deg.get(v) ?? 0) >= 2);
    if (filtered.length !== activeEdges.length) {
      activeEdges = filtered;
      changed = true;
    }
  }

  if (activeEdges.length < 3) return [];

  // 5. Build half-edge adjacency sorted by angle
  interface HalfEdge {
    id: number;
    u: number;
    v: number;
    angle: number;
    twin: number;
    visited: boolean;
  }

  const halfEdges: HalfEdge[] = [];
  const adj = new Map<number, number[]>();

  for (const [u, v] of activeEdges) {
    const pu = vertices[u];
    const pv = vertices[v];
    const id1 = halfEdges.length;
    const id2 = id1 + 1;
    halfEdges.push({
      id: id1,
      u,
      v,
      angle: Math.atan2(pv.y - pu.y, pv.x - pu.x),
      twin: id2,
      visited: false,
    });
    halfEdges.push({
      id: id2,
      u: v,
      v: u,
      angle: Math.atan2(pu.y - pv.y, pu.x - pv.x),
      twin: id1,
      visited: false,
    });
    if (!adj.has(u)) adj.set(u, []);
    if (!adj.has(v)) adj.set(v, []);
    adj.get(u)!.push(id1);
    adj.get(v)!.push(id2);
  }

  for (const list of adj.values()) {
    list.sort((a, b) => halfEdges[a].angle - halfEdges[b].angle);
  }

  const nextHalfEdge = (heId: number): number => {
    const he = halfEdges[heId];
    const twinId = he.twin;
    const list = adj.get(he.v)!;
    const idx = list.indexOf(twinId);
    // Walk previous in CCW sorted list to get minimal interior face (CCW cycle in screen-Y-down / math-Y-up)
    const nextIdx = (idx - 1 + list.length) % list.length;
    return list[nextIdx];
  };

  const detectedPolys: Point2D[][] = [];
  for (let i = 0; i < halfEdges.length; i++) {
    if (halfEdges[i].visited) continue;
    const cycle: number[] = [];
    let cur = i;
    let guard = 0;
    while (!halfEdges[cur].visited && guard < 200) {
      halfEdges[cur].visited = true;
      cycle.push(halfEdges[cur].u);
      cur = nextHalfEdge(cur);
      guard++;
    }
    if (cur === i && cycle.length >= 3) {
      const poly = cycle.map((vid) => vertices[vid]);
      const signedArea = computePolygonSignedAreaMm2(poly);
      // Interior minimal faces have positive signed area (> 0.05 m² = 50,000 mm²)
      if (signedArea > 50_000) {
        detectedPolys.push(poly);
      }
    }
  }

  // 6. Match with existing rooms to preserve user names & floor/ceiling customization
  const usedExistingIds = new Set<string>();
  return detectedPolys.map((poly, idx) => {
    const centroid = polygonCentroid(poly);
    let matched: Room | undefined;
    for (const er of existingRooms) {
      if (usedExistingIds.has(er.id)) continue;
      if (pointInPolygon(centroid, er.polygon)) {
        matched = er;
        break;
      }
    }
    if (!matched) {
      // Fallback: nearest centroid within 1.5m
      let bestDist = 1500;
      for (const er of existingRooms) {
        if (usedExistingIds.has(er.id)) continue;
        const d = dist(centroid, polygonCentroid(er.polygon));
        if (d < bestDist) {
          bestDist = d;
          matched = er;
        }
      }
    }
    if (matched) usedExistingIds.add(matched.id);

    const areaM2 = Math.round(computePolygonAreaM2(poly) * 100) / 100;
    const perimeterM = Math.round(computePolygonPerimeterM(poly) * 100) / 100;

    return {
      id: matched?.id ?? uid('room'),
      name: matched?.name ?? `Room ${idx + 1}`,
      polygon: poly,
      areaM2,
      perimeterM,
      floorColor: matched?.floorColor ?? '#FFFFFF',
      floorSecondaryColor: matched?.floorSecondaryColor,
      floorMaterial: matched?.floorMaterial ?? 'parquet',
      floorTextureScale: matched?.floorTextureScale ?? 1,
      floorTextureRotDeg: matched?.floorTextureRotDeg ?? 0,
      floorSettings: matched?.floorSettings,
      floorLevelMm: matched?.floorLevelMm ?? 0,
      hasCeiling: matched?.hasCeiling ?? true,
      ceilingHeightMm: matched?.ceilingHeightMm ?? defaultCeilingHeightMm,
      ceilingColor: matched?.ceilingColor ?? '#FFFFFF',
      ceilingSecondaryColor: matched?.ceilingSecondaryColor,
      ceilingMaterial: matched?.ceilingMaterial ?? 'paint',
      ceilingTextureScale: matched?.ceilingTextureScale,
      ceilingTextureRotDeg: matched?.ceilingTextureRotDeg,
      ceilingSettings: matched?.ceilingSettings,
      visible: matched?.visible ?? true,
      locked: matched?.locked ?? false,
    };
  });
}

export function computeWallSurfaceAreaM2(wall: Wall, openings: Opening[]): {
  grossAreaM2: number;
  netAreaM2: number;
  lengthM: number;
} {
  const lengthMm = getWallArcLength(wall);
  const grossMm2 = lengthMm * wall.heightMm;
  const hostOpenings = openings.filter((o) => o.wallId === wall.id);
  const openingMm2 = hostOpenings.reduce((sum, o) => sum + o.widthMm * o.heightMm, 0);
  const netMm2 = Math.max(0, grossMm2 - openingMm2);
  return {
    grossAreaM2: Math.round((grossMm2 / 1_000_000) * 100) / 100,
    netAreaM2: Math.round((netMm2 / 1_000_000) * 100) / 100,
    lengthM: Math.round((lengthMm / 1000) * 100) / 100,
  };
}

export function computeFurnitureBoundsMm(parts: FurniturePart[]): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  widthMm: number;
  depthMm: number;
  heightMm: number;
} {
  if (parts.length === 0) {
    return {
      minX: -250,
      maxX: 250,
      minY: -250,
      maxY: 250,
      minZ: 0,
      maxZ: 500,
      widthMm: 500,
      depthMm: 500,
      heightMm: 500,
    };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (const p of parts) {
    const rad = (p.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const pts2d = getPartLocalOutline2D(p);
    for (const pt of pts2d) {
      const lx = p.xMm + pt.x * cos - pt.y * sin;
      const ly = p.yMm + pt.x * sin + pt.y * cos;
      if (lx < minX) minX = lx;
      if (lx > maxX) maxX = lx;
      if (ly < minY) minY = ly;
      if (ly > maxY) maxY = ly;
    }
    minZ = Math.min(minZ, p.zMm);
    maxZ = Math.max(maxZ, p.zMm + p.heightMm);
  }

  return {
    minX,
    maxX,
    minY,
    maxY,
    minZ,
    maxZ,
    widthMm: Math.max(10, Math.round(maxX - minX)),
    depthMm: Math.max(10, Math.round(maxY - minY)),
    heightMm: Math.max(10, Math.round(maxZ - minZ)),
  };
}

export function scaleFurnitureParts(
  parts: FurniturePart[],
  scaleX: number,
  scaleY: number,
  scaleZ: number
): FurniturePart[] {
  return parts.map((p) => ({
    ...p,
    xMm: Math.round(p.xMm * scaleX),
    yMm: Math.round(p.yMm * scaleY),
    zMm: Math.round(p.zMm * scaleZ),
    widthMm: Math.max(10, Math.round(p.widthMm * scaleX)),
    depthMm: Math.max(10, Math.round(p.depthMm * scaleY)),
    heightMm: Math.max(10, Math.round(p.heightMm * scaleZ)),
  }));
}

export function getPlanCorners(
  walls: Wall[],
  furniture: FurnitureInstance[] = []
): Point2D[] {
  const corners: Point2D[] = [];
  for (const w of walls) {
    if (!w.visible) continue;
    corners.push({ ...w.start }, { ...w.end });
    const poly = computeWallPolygon(w, walls);
    for (const p of poly) {
      corners.push({ ...p });
    }
  }
  for (const f of furniture) {
    if (!f.visible) continue;
    const placement = getFurniturePlacement(f);
    for (const c of placement.orientedCorners) {
      corners.push({
        x: Math.round(c.x),
        y: Math.round(c.y),
      });
    }
  }
  return corners;
}

export interface AlignmentGuide {
  axis: 'x' | 'y' | 'ext' | 'perp';
  from: Point2D;
  to: Point2D;
  coordMm?: number;
  label?: string;
}

export interface ConnectedWallEndpoint {
  wallId: string;
  endpoint: 'start' | 'end';
  point: Point2D;
}

export interface NearMissWallGap {
  wallAId: string;
  endA: 'start' | 'end';
  pointA: Point2D;
  wallBId: string;
  endB: 'start' | 'end';
  pointB: Point2D;
  distanceMm: number;
}

export function findConnectedWallEndpoints(
  walls: Wall[],
  point: Point2D,
  tolMm = 8,
  excludeWallIds?: Set<string>
): ConnectedWallEndpoint[] {
  const hits: ConnectedWallEndpoint[] = [];
  for (const w of walls) {
    if (w.visible === false) continue;
    if (excludeWallIds?.has(w.id)) continue;
    if (dist(w.start, point) <= tolMm) {
      hits.push({ wallId: w.id, endpoint: 'start', point: { ...w.start } });
    }
    if (dist(w.end, point) <= tolMm) {
      hits.push({ wallId: w.id, endpoint: 'end', point: { ...w.end } });
    }
  }
  return hits;
}

export function findNearMissWallGaps(
  walls: Wall[],
  maxGapMm = 260,
  minGapMm = 6
): NearMissWallGap[] {
  const visible = walls.filter((w) => w.visible !== false && dist(w.start, w.end) >= 10);
  const endpoints: Array<{ wallId: string; end: 'start' | 'end'; pt: Point2D }> = [];
  for (const w of visible) {
    endpoints.push({ wallId: w.id, end: 'start', pt: w.start });
    endpoints.push({ wallId: w.id, end: 'end', pt: w.end });
  }

  const gaps: NearMissWallGap[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < endpoints.length; i++) {
    const a = endpoints[i];
    // Only flag gaps for endpoints that aren't already cleanly joined to another wall
    const alreadyJoined = endpoints.some(
      (o, j) => j !== i && o.wallId !== a.wallId && dist(o.pt, a.pt) < minGapMm
    );
    if (alreadyJoined) continue;

    let bestB: (typeof endpoints)[number] | null = null;
    let bestD = maxGapMm;
    for (let j = 0; j < endpoints.length; j++) {
      if (i === j) continue;
      const b = endpoints[j];
      if (b.wallId === a.wallId) continue;
      const d = dist(a.pt, b.pt);
      if (d >= minGapMm && d <= bestD) {
        bestD = d;
        bestB = b;
      }
    }
    if (bestB) {
      const k1 = `${a.wallId}:${a.end}`;
      const k2 = `${bestB.wallId}:${bestB.end}`;
      const key = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
      if (!seen.has(key)) {
        seen.add(key);
        gaps.push({
          wallAId: a.wallId,
          endA: a.end,
          pointA: { ...a.pt },
          wallBId: bestB.wallId,
          endB: bestB.end,
          pointB: { ...bestB.pt },
          distanceMm: Math.round(bestD),
        });
      }
    }
  }
  return gaps;
}

export function healNearWallGaps(
  walls: Wall[],
  maxGapMm = 260
): { walls: Wall[]; healedCount: number } {
  const nextWalls = walls.map((w) => ({
    ...w,
    start: { ...w.start },
    end: { ...w.end },
  }));
  const eps: Array<{ wallIdx: number; end: 'start' | 'end'; pt: Point2D; locked: boolean }> = [];
  nextWalls.forEach((w, idx) => {
    if (w.visible === false || dist(w.start, w.end) < 10) return;
    eps.push({ wallIdx: idx, end: 'start', pt: w.start, locked: w.locked });
    eps.push({ wallIdx: idx, end: 'end', pt: w.end, locked: w.locked });
  });

  const visited = new Array<boolean>(eps.length).fill(false);
  let healedCount = 0;

  for (let i = 0; i < eps.length; i++) {
    if (visited[i]) continue;
    const cluster: number[] = [i];
    visited[i] = true;
    for (let q = 0; q < cluster.length; q++) {
      const cur = eps[cluster[q]];
      for (let j = 0; j < eps.length; j++) {
        if (visited[j]) continue;
        if (eps[j].wallIdx === cur.wallIdx) continue;
        if (dist(cur.pt, eps[j].pt) <= maxGapMm) {
          visited[j] = true;
          cluster.push(j);
        }
      }
    }
    if (cluster.length < 2) continue;

    // Check if any endpoints in this cluster are actually separated (>= 2mm)
    let maxPairDist = 0;
    for (let a = 0; a < cluster.length; a++) {
      for (let b = a + 1; b < cluster.length; b++) {
        maxPairDist = Math.max(maxPairDist, dist(eps[cluster[a]].pt, eps[cluster[b]].pt));
      }
    }
    if (maxPairDist < 2) continue;

    const lockedNode = cluster.map((ci) => eps[ci]).find((e) => e.locked);
    let targetPt: Point2D;
    if (lockedNode) {
      targetPt = { ...lockedNode.pt };
    } else {
      // Snap to the average cluster coordinate rounded cleanly
      const sum = cluster.reduce(
        (acc, ci) => ({ x: acc.x + eps[ci].pt.x, y: acc.y + eps[ci].pt.y }),
        { x: 0, y: 0 }
      );
      targetPt = {
        x: Math.round(sum.x / cluster.length),
        y: Math.round(sum.y / cluster.length),
      };
    }

    let movedCluster = false;
    for (const ci of cluster) {
      const node = eps[ci];
      if (node.locked) continue;
      if (dist(node.pt, targetPt) >= 1) {
        if (node.end === 'start') {
          nextWalls[node.wallIdx].start = { ...targetPt };
        } else {
          nextWalls[node.wallIdx].end = { ...targetPt };
        }
        movedCluster = true;
      }
    }
    if (movedCluster) healedCount++;
  }

  return { walls: nextWalls, healedCount };
}

export function snapPointToPlan(
  raw: Point2D,
  options: {
    walls: Wall[];
    furniture?: FurnitureInstance[];
    gridSizeMm: number;
    snapEnabled: boolean;
    angleSnapDeg: number;
    orthoMode: boolean;
    anchor?: Point2D | null;
    excludeWallId?: string;
    excludeWallIds?: string[];
    ignoreEndpoints?: Point2D[];
    ignoreWallEnd?: { wallId: string; endpoint: 'start' | 'end' };
    snapThresholdMm?: number;
    alignThresholdMm?: number;
    hysteresis?: SnapHysteresisState;
    preferCornersOnly?: boolean;
    enableAxisAlignment?: boolean;
  }
): {
  point: Point2D;
  snappedKind: 'vertex' | 'wall' | 'align' | 'grid' | 'none';
  snappedWallId?: string;
  isOpenEndpointSnap?: boolean;
  snapLabel?: string;
  snapKey?: string;
  hysteresis?: SnapHysteresisState;
  guides: AlignmentGuide[];
} {
  const threshold = options.snapThresholdMm ?? 180;
  const nextHyst: SnapHysteresisState = { ...(options.hysteresis ?? {}) };
  const ignoreEps = options.ignoreEndpoints ?? [];
  const excludeSet = new Set<string>(options.excludeWallIds ?? []);
  if (options.excludeWallId) excludeSet.add(options.excludeWallId);

  const isIgnoredEp = (ep: Point2D) => ignoreEps.some((ig) => dist(ig, ep) < 6);
  const visibleWalls = options.walls.filter((w) => w.visible !== false);

  // Determine open (unconnected) endpoints across the entire visible plan so reconnection feels magnetic
  const allEndpointList: Array<{ wallId: string; end: 'start' | 'end'; pt: Point2D }> = [];
  for (const w of visibleWalls) {
    allEndpointList.push({ wallId: w.id, end: 'start', pt: w.start });
    allEndpointList.push({ wallId: w.id, end: 'end', pt: w.end });
  }

  const wallEndpoints: Array<{ pt: Point2D; wallId: string; isOpen: boolean }> = [];
  for (const w of visibleWalls) {
    if (excludeSet.has(w.id)) continue;
    for (const endKind of ['start', 'end'] as const) {
      if (
        options.ignoreWallEnd &&
        options.ignoreWallEnd.wallId === w.id &&
        options.ignoreWallEnd.endpoint === endKind
      ) {
        continue;
      }
      const ep = w[endKind];
      if (!options.ignoreWallEnd && isIgnoredEp(ep)) continue;
      const peerCount = allEndpointList.filter(
        (other) => other.wallId !== w.id && dist(other.pt, ep) < 8
      ).length;
      wallEndpoints.push({ pt: ep, wallId: w.id, isOpen: peerCount === 0 });
    }
  }

  const collectGuidesAt = (pt: Point2D): AlignmentGuide[] => {
    if (options.enableAxisAlignment === false) return [];
    const guides: AlignmentGuide[] = [];
    let bestXTarget: Point2D | null = null;
    let bestXDist = Infinity;
    let bestYTarget: Point2D | null = null;
    let bestYDist = Infinity;
    for (const { pt: ep } of wallEndpoints) {
      if (options.anchor && dist(ep, options.anchor) < 6) continue;
      if (Math.abs(pt.x - ep.x) < 2) {
        const dy = Math.abs(pt.y - ep.y);
        if (dy > 8 && dy < bestXDist) {
          bestXDist = dy;
          bestXTarget = ep;
        }
      }
      if (Math.abs(pt.y - ep.y) < 2) {
        const dx = Math.abs(pt.x - ep.x);
        if (dx > 8 && dx < bestYDist) {
          bestYDist = dx;
          bestYTarget = ep;
        }
      }
    }
    if (bestXTarget) {
      guides.push({ axis: 'x', from: pt, to: { ...bestXTarget }, coordMm: bestXTarget.x });
    }
    if (bestYTarget) {
      guides.push({ axis: 'y', from: pt, to: { ...bestYTarget }, coordMm: bestYTarget.y });
    }
    return guides;
  };

  if (options.snapEnabled) {
    // 1. Priority 1: Snap to wall endpoints & corners (magnetic boost for loose/open endpoints)
    if (options.preferCornersOnly) {
      const corners = getPlanCorners(
        visibleWalls.filter((w) => !excludeSet.has(w.id)),
        options.furniture ?? []
      ).filter((c) => !isIgnoredEp(c));
      const cornerCands = corners.map((c) => ({
        key: `corner_${Math.round(c.x)}_${Math.round(c.y)}`,
        dist: dist(raw, c),
        data: { ...c },
      }));
      const pickedCorner = pickWithSnapHysteresis(cornerCands, nextHyst.pointKey, threshold);
      if (pickedCorner) {
        nextHyst.pointKey = pickedCorner.key;
        nextHyst.wallKey = undefined;
        nextHyst.alignXKey = undefined;
        nextHyst.alignYKey = undefined;
        return {
          point: pickedCorner.data,
          snappedKind: 'vertex',
          snapLabel: 'Corner',
          snapKey: pickedCorner.key,
          hysteresis: nextHyst,
          guides: collectGuidesAt(pickedCorner.data),
        };
      }
    } else {
      const epCands = wallEndpoints.map((item) => {
        const d = dist(raw, item.pt);
        return {
          key: `ep_${item.wallId}_${Math.round(item.pt.x)}_${Math.round(item.pt.y)}`,
          dist: item.isOpen ? d * 0.8 : d,
          data: item,
        };
      });
      const pickedEp = pickWithSnapHysteresis(epCands, nextHyst.pointKey, threshold);
      if (pickedEp) {
        const bestEp = pickedEp.data;
        nextHyst.pointKey = pickedEp.key;
        nextHyst.wallKey = undefined;
        nextHyst.alignXKey = undefined;
        nextHyst.alignYKey = undefined;
        return {
          point: { ...bestEp.pt },
          snappedKind: 'vertex',
          snappedWallId: bestEp.wallId,
          isOpenEndpointSnap: bestEp.isOpen,
          snapLabel: bestEp.isOpen ? 'Connect Open Corner' : 'Corner Joint',
          snapKey: pickedEp.key,
          hysteresis: nextHyst,
          guides: collectGuidesAt(bestEp.pt),
        };
      }

      // 2. Priority 2: Angled closing intersections (extension/perpendicular intersections of crooked walls)
      if (options.enableAxisAlignment !== false && !options.orthoMode) {
        type RayGuide = {
          wallId: string;
          origin: Point2D;
          dir: Point2D;
          axis: 'ext' | 'perp';
        };
        const rayGuides: RayGuide[] = [];
        for (const w of visibleWalls) {
          if (excludeSet.has(w.id) || w.isCurved) continue;
          const dx = w.end.x - w.start.x;
          const dy = w.end.y - w.start.y;
          const len = Math.hypot(dx, dy);
          if (len < 20) continue;
          const ux = dx / len;
          const uy = dy / len;
          const nx = -uy;
          const ny = ux;
          const origExt = dist(raw, w.start) <= dist(raw, w.end) ? w.start : w.end;
          rayGuides.push({ wallId: w.id, origin: origExt, dir: { x: ux, y: uy }, axis: 'ext' });
          for (const epKind of ['start', 'end'] as const) {
            if (
              options.ignoreWallEnd &&
              options.ignoreWallEnd.wallId === w.id &&
              options.ignoreWallEnd.endpoint === epKind
            ) {
              continue;
            }
            const ep = w[epKind];
            if (!options.ignoreWallEnd && isIgnoredEp(ep)) continue;
            rayGuides.push({ wallId: w.id, origin: ep, dir: { x: nx, y: ny }, axis: 'perp' });
          }
        }

        const interThreshold = threshold * 0.78;
        const interCands: Array<{
          key: string;
          dist: number;
          data: { pt: Point2D; a: RayGuide; b: RayGuide };
        }> = [];
        for (let i = 0; i < rayGuides.length; i++) {
          for (let j = i + 1; j < rayGuides.length; j++) {
            const gA = rayGuides[i];
            const gB = rayGuides[j];
            if (gA.wallId === gB.wallId) continue;
            const inter = lineIntersection(gA.origin, gA.dir, gB.origin, gB.dir);
            if (!inter) continue;
            if (options.anchor && dist(inter, options.anchor) < 30) continue;
            const d = dist(raw, inter);
            if (d <= interThreshold * 1.45) {
              interCands.push({
                key: `inter_${gA.wallId}_${gA.axis}_${gB.wallId}_${gB.axis}`,
                dist: d,
                data: { pt: inter, a: gA, b: gB },
              });
            }
          }
        }
        const pickedInter = pickWithSnapHysteresis(interCands, nextHyst.pointKey, interThreshold);
        if (pickedInter) {
          const snappedPt = { x: Math.round(pickedInter.data.pt.x), y: Math.round(pickedInter.data.pt.y) };
          nextHyst.pointKey = pickedInter.key;
          nextHyst.wallKey = undefined;
          nextHyst.alignXKey = undefined;
          nextHyst.alignYKey = undefined;
          return {
            point: snappedPt,
            snappedKind: 'align',
            snapLabel: 'Angled Intersection',
            snapKey: pickedInter.key,
            hysteresis: nextHyst,
            guides: [
              { axis: pickedInter.data.a.axis, from: pickedInter.data.a.origin, to: snappedPt },
              { axis: pickedInter.data.b.axis, from: pickedInter.data.b.origin, to: snappedPt },
              ...collectGuidesAt(snappedPt),
            ],
          };
        }
      }

      // 3. Priority 3: Snap onto interior of wall segment (T-junction), away from endpoints
      const wallTol = threshold * 0.55;
      const wallCands: Array<{ key: string; dist: number; data: { pt: Point2D; wallId: string } }> = [];
      for (const w of visibleWalls) {
        if (excludeSet.has(w.id)) continue;
        const proj = projectPointOnSegment(raw, w.start, w.end);
        if (proj.t > 0.03 && proj.t < 0.97 && proj.distance <= wallTol * 1.45) {
          wallCands.push({
            key: `wall_${w.id}`,
            dist: proj.distance,
            data: {
              pt: { x: Math.round(proj.point.x), y: Math.round(proj.point.y) },
              wallId: w.id,
            },
          });
        }
      }
      const pickedWall = pickWithSnapHysteresis(wallCands, nextHyst.wallKey, wallTol);
      if (pickedWall) {
        nextHyst.pointKey = undefined;
        nextHyst.wallKey = pickedWall.key;
        nextHyst.alignXKey = undefined;
        nextHyst.alignYKey = undefined;
        return {
          point: pickedWall.data.pt,
          snappedKind: 'wall',
          snappedWallId: pickedWall.data.wallId,
          snapLabel: 'Wall Junction',
          snapKey: pickedWall.key,
          hysteresis: nextHyst,
          guides: collectGuidesAt(pickedWall.data.pt),
        };
      }
    }
  }

  nextHyst.pointKey = undefined;
  let pt = { ...raw };

  // 4a. Apply ortho or angle snap relative to anchor
  let anchorAxisLock: 'x' | 'y' | null = null;
  if (options.anchor) {
    const dx = pt.x - options.anchor.x;
    const dy = pt.y - options.anchor.y;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      const stepDeg = options.orthoMode ? 90 : options.angleSnapDeg;
      if (stepDeg > 0) {
        const ang = Math.atan2(dy, dx);
        const stepRad = (stepDeg * Math.PI) / 180;
        const snappedAng = Math.round(ang / stepRad) * stepRad;
        pt = {
          x: options.anchor.x + Math.cos(snappedAng) * len,
          y: options.anchor.y + Math.sin(snappedAng) * len,
        };
        if (Math.abs(Math.sin(snappedAng)) < 1e-4) {
          anchorAxisLock = 'y';
          pt.y = options.anchor.y;
        }
        if (Math.abs(Math.cos(snappedAng)) < 1e-4) {
          anchorAxisLock = 'x';
          pt.x = options.anchor.x;
        }
      }
    }
  }

  // 4b. Reference Alignment Guides: Collinear Wall Extension, Perpendicular, and X/Y Endpoint Inference
  let alignedX = false;
  let alignedY = false;
  let alignedAngled = false;
  const angledGuides: AlignmentGuide[] = [];
  const guides: AlignmentGuide[] = [];
  let alignSnapKey: string | undefined;

  if (options.snapEnabled && options.enableAxisAlignment !== false && !options.preferCornersOnly) {
    const alignTol = options.alignThresholdMm ?? Math.max(45, threshold * 0.8);

    const angledCands: Array<{
      key: string;
      dist: number;
      data: { pt: Point2D; err: number; guide: AlignmentGuide; label: string };
    }> = [];
    if (!options.orthoMode) {
      for (const w of visibleWalls) {
        if (excludeSet.has(w.id) || w.isCurved) continue;
        const dx = w.end.x - w.start.x;
        const dy = w.end.y - w.start.y;
        const len = Math.hypot(dx, dy);
        if (len < 20) continue;
        const ux = dx / len;
        const uy = dy / len;
        const nx = -uy;
        const ny = ux;
        const isCardinal = Math.abs(ux) < 0.015 || Math.abs(uy) < 0.015;
        if (!isCardinal) {
          const relX = raw.x - w.start.x;
          const relY = raw.y - w.start.y;
          const sProj = relX * ux + relY * uy;
          const perpErr = Math.abs(relX * nx + relY * ny);
          if ((sProj < -10 || sProj > len + 10) && perpErr <= alignTol * 0.85 * 1.45) {
            const snapped = { x: w.start.x + ux * sProj, y: w.start.y + uy * sProj };
            const fromEp = sProj < 0 ? w.start : w.end;
            angledCands.push({
              key: `angled_ext_${w.id}_${sProj < 0 ? 's' : 'e'}`,
              dist: perpErr,
              data: {
                pt: snapped,
                err: perpErr,
                guide: { axis: 'ext', from: fromEp, to: snapped, label: 'Wall Extension' },
                label: 'Wall Extension',
              },
            });
          }

          for (const epKind of ['start', 'end'] as const) {
            if (
              options.ignoreWallEnd &&
              options.ignoreWallEnd.wallId === w.id &&
              options.ignoreWallEnd.endpoint === epKind
            ) {
              continue;
            }
            const ep = w[epKind];
            if (!options.ignoreWallEnd && isIgnoredEp(ep)) continue;
            if (options.anchor && dist(ep, options.anchor) < 6) continue;
            const dX = raw.x - ep.x;
            const dY = raw.y - ep.y;
            const alongN = dX * nx + dY * ny;
            const errU = Math.abs(dX * ux + dY * uy);
            if (Math.abs(alongN) > 25 && errU <= alignTol * 0.72 * 1.45) {
              const snapped = { x: ep.x + nx * alongN, y: ep.y + ny * alongN };
              angledCands.push({
                key: `angled_perp_${w.id}_${epKind}`,
                dist: errU,
                data: {
                  pt: snapped,
                  err: errU,
                  guide: { axis: 'perp', from: ep, to: snapped, label: '90° Perpendicular' },
                  label: '90° Perpendicular',
                },
              });
            }
          }
        }
      }
    }
    const pickedAngled = pickWithSnapHysteresis(angledCands, nextHyst.wallKey, alignTol * 0.85);

    const alignXCands: Array<{ key: string; dist: number; data: Point2D }> = [];
    const alignYCands: Array<{ key: string; dist: number; data: Point2D }> = [];
    for (const { pt: ep } of wallEndpoints) {
      if (options.anchor && dist(ep, options.anchor) < 6) continue;
      if (anchorAxisLock !== 'x') {
        const ex = Math.abs(pt.x - ep.x);
        if (ex <= alignTol * 1.45) {
          alignXCands.push({ key: `ax_${Math.round(ep.x)}`, dist: ex, data: ep });
        }
      }
      if (anchorAxisLock !== 'y') {
        const ey = Math.abs(pt.y - ep.y);
        if (ey <= alignTol * 1.45) {
          alignYCands.push({ key: `ay_${Math.round(ep.y)}`, dist: ey, data: ep });
        }
      }
    }

    const pickedAlignX = pickWithSnapHysteresis(alignXCands, nextHyst.alignXKey, alignTol);
    const pickedAlignY = pickWithSnapHysteresis(alignYCands, nextHyst.alignYKey, alignTol);
    const bestXYErr = Math.min(
      pickedAlignX ? pickedAlignX.dist : Infinity,
      pickedAlignY ? pickedAlignY.dist : Infinity
    );

    if (
      pickedAngled &&
      ((!pickedAlignX && !pickedAlignY) || pickedAngled.data.err < bestXYErr * 0.85)
    ) {
      pt = { ...pickedAngled.data.pt };
      alignedAngled = true;
      nextHyst.wallKey = pickedAngled.key;
      nextHyst.alignXKey = undefined;
      nextHyst.alignYKey = undefined;
      alignSnapKey = pickedAngled.key;
      angledGuides.push({
        ...pickedAngled.data.guide,
        to: { x: Math.round(pt.x), y: Math.round(pt.y) },
      });
    } else {
      nextHyst.wallKey = undefined;
      nextHyst.alignXKey = pickedAlignX?.key;
      nextHyst.alignYKey = pickedAlignY?.key;
      if (pickedAlignX) {
        pt.x = pickedAlignX.data.x;
        alignedX = true;
      }
      if (pickedAlignY) {
        pt.y = pickedAlignY.data.y;
        alignedY = true;
      }
      if (pickedAlignX || pickedAlignY) {
        alignSnapKey = `align_${pickedAlignX?.key ?? ''}_${pickedAlignY?.key ?? ''}`;
      }
    }
  } else {
    nextHyst.wallKey = undefined;
    nextHyst.alignXKey = undefined;
    nextHyst.alignYKey = undefined;
  }

  // 5. Grid snap (never override an axis or point locked by anchor or alignment guide)
  if (options.snapEnabled && options.gridSizeMm > 0 && !alignedAngled) {
    if (!alignedX && anchorAxisLock !== 'x') {
      pt.x = Math.round(pt.x / options.gridSizeMm) * options.gridSizeMm;
    }
    if (!alignedY && anchorAxisLock !== 'y') {
      pt.y = Math.round(pt.y / options.gridSizeMm) * options.gridSizeMm;
    }
  }

  const finalPt = { x: Math.round(pt.x), y: Math.round(pt.y) };
  if (options.snapEnabled && options.enableAxisAlignment !== false && !options.preferCornersOnly) {
    guides.push(...angledGuides, ...collectGuidesAt(finalPt));
  }

  const anyAligned = alignedX || alignedY || alignedAngled;
  const snapLabel = alignedAngled
    ? angledGuides[0]?.label ?? 'Angled Guide'
    : anyAligned
      ? 'Aligned Guide'
      : options.snapEnabled && options.gridSizeMm > 0
        ? 'Grid'
        : undefined;

  if (options.snapEnabled && options.gridSizeMm > 0) {
    return {
      point: finalPt,
      snappedKind: anyAligned ? 'align' : 'grid',
      snapLabel,
      snapKey: anyAligned ? alignSnapKey : undefined,
      hysteresis: nextHyst,
      guides,
    };
  }

  return {
    point: finalPt,
    snappedKind: anyAligned ? 'align' : 'none',
    snapLabel,
    snapKey: anyAligned ? alignSnapKey : undefined,
    hysteresis: nextHyst,
    guides,
  };
}

// ============================================================================
// Architectural Dimension Chains, Inside-Corner Clearances & Constraint Solver
// ============================================================================

export interface WallInnerBounds {
  lengthMm: number;
  innerStartS: number;
  innerEndS: number;
  leftStartS: number;
  leftEndS: number;
  rightStartS: number;
  rightEndS: number;
}

export interface WallMountedComponent {
  id: string;
  kind: 'opening' | 'chimney';
  name: string;
  centerS: number;
  widthMm: number;
  leftS: number;
  rightS: number;
  t: number;
  locked: boolean;
  resizeAnchor: ResizeAnchor;
}

export interface WallDimensionSegment {
  key: string;
  kind: 'wall_gap' | 'component';
  startS: number;
  endS: number;
  lengthMm: number;
  componentId?: string;
  componentKind?: 'opening' | 'chimney';
  locked: boolean;
  label: string;
}

export interface NonCrossingClearance {
  side: 'left' | 'right';
  startS: number;
  endS: number;
  lengthMm: number;
  stopsAt: 'corner' | 'component';
  neighborId?: string;
  neighborName?: string;
  locked: boolean;
}

export function computeWallInnerBounds(wall: Wall, allWalls: Wall[]): WallInnerBounds {
  const lengthMm = getWallArcLength(wall);
  if (lengthMm < 1 || (wall.isCurved && Math.abs(wall.curveBulgeMm) >= 1)) {
    return {
      lengthMm,
      innerStartS: 0,
      innerEndS: lengthMm,
      leftStartS: 0,
      leftEndS: lengthMm,
      rightStartS: 0,
      rightEndS: lengthMm,
    };
  }

  const poly = computeWallPolygon(wall, allWalls);
  if (poly.length !== 4) {
    return {
      lengthMm,
      innerStartS: 0,
      innerEndS: lengthMm,
      leftStartS: 0,
      leftEndS: lengthMm,
      rightStartS: 0,
      rightEndS: lengthMm,
    };
  }

  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const u = { x: dx / lengthMm, y: dy / lengthMm };
  const projS = (p: Point2D) => (p.x - wall.start.x) * u.x + (p.y - wall.start.y) * u.y;

  // poly = [sLeft, eLeft, eRight, sRight]
  const leftStartS = projS(poly[0]);
  const leftEndS = projS(poly[1]);
  const rightEndS = projS(poly[2]);
  const rightStartS = projS(poly[3]);

  const rawInnerStart = Math.max(leftStartS, rightStartS);
  const rawInnerEnd = Math.min(leftEndS, rightEndS);

  const innerStartS = Math.max(0, Math.min(lengthMm * 0.45, Math.round(rawInnerStart)));
  const innerEndS = Math.min(lengthMm, Math.max(lengthMm * 0.55, Math.round(rawInnerEnd)));

  return {
    lengthMm,
    innerStartS,
    innerEndS: Math.max(innerStartS, innerEndS),
    leftStartS,
    leftEndS,
    rightStartS,
    rightEndS,
  };
}

export function getWallMountedComponents(
  wall: Wall,
  openings: Opening[],
  archElements: ArchElement[]
): WallMountedComponent[] {
  const wallLen = getWallArcLength(wall);
  if (wallLen < 1) return [];

  const list: WallMountedComponent[] = [];

  for (const op of openings) {
    if (op.wallId !== wall.id || !op.visible) continue;
    const centerS = op.t * wallLen;
    list.push({
      id: op.id,
      kind: 'opening',
      name: op.name,
      centerS,
      widthMm: op.widthMm,
      leftS: centerS - op.widthMm / 2,
      rightS: centerS + op.widthMm / 2,
      t: op.t,
      locked: op.locked,
      resizeAnchor: op.resizeAnchor ?? 'center',
    });
  }

  for (const el of archElements) {
    if (el.type !== 'chimney' || el.attachedWallId !== wall.id || !el.visible) continue;
    const t =
      typeof el.attachedT === 'number'
        ? el.attachedT
        : projectPointOnSegment({ x: el.xMm, y: el.yMm }, wall.start, wall.end).t;
    const centerS = t * wallLen;
    list.push({
      id: el.id,
      kind: 'chimney',
      name: el.name,
      centerS,
      widthMm: el.widthMm,
      leftS: centerS - el.widthMm / 2,
      rightS: centerS + el.widthMm / 2,
      t,
      locked: el.locked,
      resizeAnchor: el.resizeAnchor ?? 'center',
    });
  }

  list.sort((a, b) => a.centerS - b.centerS);
  return list;
}

export function buildWallDimensionChain(
  wall: Wall,
  allWalls: Wall[],
  openings: Opening[],
  archElements: ArchElement[]
): {
  bounds: WallInnerBounds;
  components: WallMountedComponent[];
  segments: WallDimensionSegment[];
} {
  const bounds = computeWallInnerBounds(wall, allWalls);
  const components = getWallMountedComponents(wall, openings, archElements);
  const lockedGaps = new Set(wall.lockedSegments ?? []);
  const segments: WallDimensionSegment[] = [];

  let cursor = bounds.innerStartS;
  let prevId = 'start';

  for (const comp of components) {
    const gapStart = cursor;
    const gapEnd = Math.max(gapStart, comp.leftS);
    if (gapEnd - gapStart >= 1) {
      const key = `gap:${prevId}:${comp.id}`;
      segments.push({
        key,
        kind: 'wall_gap',
        startS: gapStart,
        endS: gapEnd,
        lengthMm: gapEnd - gapStart,
        locked: wall.locked || lockedGaps.has(key),
        label: 'Wall',
      });
    }
    segments.push({
      key: `comp:${comp.id}`,
      kind: 'component',
      startS: comp.leftS,
      endS: comp.rightS,
      lengthMm: comp.widthMm,
      componentId: comp.id,
      componentKind: comp.kind,
      locked: wall.locked || comp.locked,
      label: comp.name,
    });
    cursor = Math.max(cursor, comp.rightS);
    prevId = comp.id;
  }

  if (bounds.innerEndS - cursor >= 1 || components.length === 0) {
    const gapStart = cursor;
    const gapEnd = Math.max(gapStart, bounds.innerEndS);
    const key = `gap:${prevId}:end`;
    segments.push({
      key,
      kind: 'wall_gap',
      startS: gapStart,
      endS: gapEnd,
      lengthMm: gapEnd - gapStart,
      locked: wall.locked || lockedGaps.has(key),
      label: 'Wall',
    });
  }

  return { bounds, components, segments };
}

export function getNonCrossingClearances(
  targetId: string,
  components: WallMountedComponent[],
  bounds: WallInnerBounds,
  wallLocked: boolean
): {
  target: WallMountedComponent | null;
  left: NonCrossingClearance | null;
  right: NonCrossingClearance | null;
} {
  const idx = components.findIndex((c) => c.id === targetId);
  if (idx === -1) return { target: null, left: null, right: null };
  const target = components[idx];

  const prev = idx > 0 ? components[idx - 1] : null;
  const leftStart = prev ? prev.rightS : bounds.innerStartS;
  const leftEnd = Math.max(leftStart, target.leftS);

  const next = idx < components.length - 1 ? components[idx + 1] : null;
  const rightEnd = next ? next.leftS : bounds.innerEndS;
  const rightStart = Math.min(rightEnd, target.rightS);

  return {
    target,
    left: {
      side: 'left',
      startS: leftStart,
      endS: leftEnd,
      lengthMm: Math.max(0, leftEnd - leftStart),
      stopsAt: prev ? 'component' : 'corner',
      neighborId: prev?.id,
      neighborName: prev?.name,
      locked: wallLocked || target.locked,
    },
    right: {
      side: 'right',
      startS: rightStart,
      endS: rightEnd,
      lengthMm: Math.max(0, rightEnd - rightStart),
      stopsAt: next ? 'component' : 'corner',
      neighborId: next?.id,
      neighborName: next?.name,
      locked: wallLocked || target.locked,
    },
  };
}

export interface SolveWallComponentsResult {
  ok: boolean;
  error?: string;
  updates: Array<{ id: string; kind: 'opening' | 'chimney'; t: number; widthMm: number }>;
}

function getEffectiveWallBounds(
  components: WallMountedComponent[],
  bounds: WallInnerBounds
): { minBound: number; maxBound: number } {
  let minBound = bounds.innerStartS;
  let maxBound = bounds.innerEndS;
  for (const c of components) {
    if (c.leftS < minBound) minBound = Math.max(0, c.leftS);
    if (c.rightS > maxBound) maxBound = Math.min(bounds.lengthMm, c.rightS);
  }
  return { minBound, maxBound };
}

function computeBarriersForIndex(
  components: WallMountedComponent[],
  targetIdx: number,
  minBound: number,
  maxBound: number
): { minLeftS: number; maxRightS: number; leftBlockedByLock: boolean; rightBlockedByLock: boolean } {
  let leftBlockedByLock = false;
  let leftStartLimit = minBound;
  let leftPushWidthSum = 0;
  for (let k = targetIdx - 1; k >= 0; k--) {
    if (components[k].locked) {
      leftBlockedByLock = true;
      leftStartLimit = components[k].rightS;
      break;
    }
    leftPushWidthSum += components[k].widthMm;
  }
  const minLeftS = leftStartLimit + leftPushWidthSum;

  let rightBlockedByLock = false;
  let rightEndLimit = maxBound;
  let rightPushWidthSum = 0;
  for (let k = targetIdx + 1; k < components.length; k++) {
    if (components[k].locked) {
      rightBlockedByLock = true;
      rightEndLimit = components[k].leftS;
      break;
    }
    rightPushWidthSum += components[k].widthMm;
  }
  const maxRightS = rightEndLimit - rightPushWidthSum;

  return { minLeftS, maxRightS, leftBlockedByLock, rightBlockedByLock };
}

/**
 * Constraint-based component resize along a wall:
 * - Honors resizeAnchor ('center' default, 'left' edge pinned, 'right' edge pinned)
 * - Consumes adjacent wall gaps first, then pushes unlocked neighboring components
 * - Fails with a clear error message if locked barriers or free wall length are exceeded
 */
export function solveWallComponentResize(
  wall: Wall,
  components: WallMountedComponent[],
  bounds: WallInnerBounds,
  targetId: string,
  nextWidthMm: number,
  anchorOverride?: ResizeAnchor
): SolveWallComponentsResult {
  if (wall.locked) {
    return { ok: false, error: 'Host wall is locked and cannot be modified.', updates: [] };
  }
  const idx = components.findIndex((c) => c.id === targetId);
  if (idx === -1) {
    return { ok: false, error: 'Component not found on wall.', updates: [] };
  }
  const target = components[idx];
  if (target.locked) {
    return { ok: false, error: `"${target.name}" is locked.`, updates: [] };
  }

  const minWidth = target.kind === 'chimney' ? 50 : 150;
  if (!Number.isFinite(nextWidthMm) || nextWidthMm < minWidth) {
    return {
      ok: false,
      error: `Width must be at least ${Math.round(minWidth / 10)} cm.`,
      updates: [],
    };
  }

  const { minBound, maxBound } = getEffectiveWallBounds(components, bounds);
  const { minLeftS, maxRightS, leftBlockedByLock, rightBlockedByLock } = computeBarriersForIndex(
    components,
    idx,
    minBound,
    maxBound
  );
  const maxAvailableW = Math.max(0, maxRightS - minLeftS);

  if (nextWidthMm > maxAvailableW + 0.5) {
    const blockerNote =
      leftBlockedByLock || rightBlockedByLock ? ' (blocked by locked component)' : '';
    return {
      ok: false,
      error: `Width exceeds available free wall length${blockerNote}. Maximum: ${(maxAvailableW / 10).toFixed(1)} cm.`,
      updates: [],
    };
  }

  const anchor = anchorOverride ?? target.resizeAnchor;
  let newLeft = target.leftS;
  let newRight = target.rightS;

  if (anchor === 'left') {
    newLeft = target.leftS;
    newRight = newLeft + nextWidthMm;
    if (newRight > maxRightS + 0.5) {
      const maxRightW = Math.max(0, maxRightS - newLeft);
      return {
        ok: false,
        error: rightBlockedByLock
          ? `Cannot expand right edge: blocked by locked component (max ${(maxRightW / 10).toFixed(1)} cm).`
          : `Cannot expand right edge past corner: max ${(maxRightW / 10).toFixed(1)} cm available on right.`,
        updates: [],
      };
    }
  } else if (anchor === 'right') {
    newRight = target.rightS;
    newLeft = newRight - nextWidthMm;
    if (newLeft < minLeftS - 0.5) {
      const maxLeftW = Math.max(0, newRight - minLeftS);
      return {
        ok: false,
        error: leftBlockedByLock
          ? `Cannot expand left edge: blocked by locked component (max ${(maxLeftW / 10).toFixed(1)} cm).`
          : `Cannot expand left edge past corner: max ${(maxLeftW / 10).toFixed(1)} cm available on left.`,
        updates: [],
      };
    }
  } else {
    // 'center': expand/shrink symmetrically from middle; if one side hits its hard stop while total fits, slide minimally
    const mid = (target.leftS + target.rightS) / 2;
    newLeft = mid - nextWidthMm / 2;
    newRight = mid + nextWidthMm / 2;
    if (newLeft < minLeftS) {
      const shift = minLeftS - newLeft;
      newLeft += shift;
      newRight += shift;
    }
    if (newRight > maxRightS) {
      const shift = newRight - maxRightS;
      newLeft -= shift;
      newRight -= shift;
    }
  }

  // Cascade push neighbors outward only when adjacent wall gap reaches zero
  const solved = components.map((c) => ({ ...c }));
  solved[idx].leftS = newLeft;
  solved[idx].rightS = newRight;
  solved[idx].widthMm = nextWidthMm;
  solved[idx].centerS = (newLeft + newRight) / 2;

  for (let j = idx - 1; j >= 0; j--) {
    if (solved[j].rightS > solved[j + 1].leftS) {
      solved[j].rightS = solved[j + 1].leftS;
      solved[j].leftS = solved[j].rightS - solved[j].widthMm;
      solved[j].centerS = (solved[j].leftS + solved[j].rightS) / 2;
    }
  }

  for (let j = idx + 1; j < solved.length; j++) {
    if (solved[j].leftS < solved[j - 1].rightS) {
      solved[j].leftS = solved[j - 1].rightS;
      solved[j].rightS = solved[j].leftS + solved[j].widthMm;
      solved[j].centerS = (solved[j].leftS + solved[j].rightS) / 2;
    }
  }

  const wallLen = bounds.lengthMm || 1;
  return {
    ok: true,
    updates: solved.map((c) => ({
      id: c.id,
      kind: c.kind,
      widthMm: Math.round(c.widthMm),
      t: Math.max(0.001, Math.min(0.999, c.centerS / wallLen)),
    })),
  };
}

/**
 * Edits the left or right clearance dimension of a selected wall-mounted component,
 * repositioning the component without distorting unrelated walls.
 */
export function solveWallClearanceEdit(
  wall: Wall,
  components: WallMountedComponent[],
  bounds: WallInnerBounds,
  targetId: string,
  side: 'left' | 'right',
  nextClearanceMm: number
): SolveWallComponentsResult {
  if (wall.locked) {
    return { ok: false, error: 'Host wall is locked.', updates: [] };
  }
  if (!Number.isFinite(nextClearanceMm) || nextClearanceMm < 0) {
    return { ok: false, error: 'Distance cannot be negative.', updates: [] };
  }
  const idx = components.findIndex((c) => c.id === targetId);
  if (idx === -1) {
    return { ok: false, error: 'Component not found.', updates: [] };
  }
  const target = components[idx];
  if (target.locked) {
    return { ok: false, error: `"${target.name}" is locked.`, updates: [] };
  }

  const { minBound, maxBound } = getEffectiveWallBounds(components, bounds);
  const { minLeftS, maxRightS, leftBlockedByLock, rightBlockedByLock } = computeBarriersForIndex(
    components,
    idx,
    minBound,
    maxBound
  );

  let newLeft = target.leftS;
  let newRight = target.rightS;

  if (side === 'left') {
    const refStart = idx > 0 ? components[idx - 1].rightS : minBound;
    newLeft = refStart + nextClearanceMm;
    newRight = newLeft + target.widthMm;
    if (newRight > maxRightS + 0.5) {
      const maxClear = Math.max(0, maxRightS - target.widthMm - refStart);
      return {
        ok: false,
        error: rightBlockedByLock
          ? `Cannot shift right: blocked by locked component (max ${(maxClear / 10).toFixed(1)} cm).`
          : `Distance exceeds free wall length (max ${(maxClear / 10).toFixed(1)} cm).`,
        updates: [],
      };
    }
  } else {
    const refEnd = idx < components.length - 1 ? components[idx + 1].leftS : maxBound;
    newRight = refEnd - nextClearanceMm;
    newLeft = newRight - target.widthMm;
    if (newLeft < minLeftS - 0.5) {
      const maxClear = Math.max(0, refEnd - target.widthMm - minLeftS);
      return {
        ok: false,
        error: leftBlockedByLock
          ? `Cannot shift left: blocked by locked component (max ${(maxClear / 10).toFixed(1)} cm).`
          : `Distance exceeds free wall length (max ${(maxClear / 10).toFixed(1)} cm).`,
        updates: [],
      };
    }
  }

  const solved = components.map((c) => ({ ...c }));
  solved[idx].leftS = newLeft;
  solved[idx].rightS = newRight;
  solved[idx].centerS = (newLeft + newRight) / 2;

  for (let j = idx - 1; j >= 0; j--) {
    if (solved[j].rightS > solved[j + 1].leftS) {
      solved[j].rightS = solved[j + 1].leftS;
      solved[j].leftS = solved[j].rightS - solved[j].widthMm;
      solved[j].centerS = (solved[j].leftS + solved[j].rightS) / 2;
    }
  }
  for (let j = idx + 1; j < solved.length; j++) {
    if (solved[j].leftS < solved[j - 1].rightS) {
      solved[j].leftS = solved[j - 1].rightS;
      solved[j].rightS = solved[j].leftS + solved[j].widthMm;
      solved[j].centerS = (solved[j].leftS + solved[j].rightS) / 2;
    }
  }

  const wallLen = bounds.lengthMm || 1;
  return {
    ok: true,
    updates: solved.map((c) => ({
      id: c.id,
      kind: c.kind,
      widthMm: Math.round(c.widthMm),
      t: Math.max(0.001, Math.min(0.999, c.centerS / wallLen)),
    })),
  };
}

/**
 * Constrained drag placement along host wall with snapping to neighboring components & inside corners,
 * preventing any overlap between wall-mounted openings/chimneys.
 */
export function solveWallComponentDrag(
  components: WallMountedComponent[],
  bounds: WallInnerBounds,
  targetId: string,
  proposedCenterS: number,
  snapEnabled: boolean,
  snapThresholdMm = 65,
  hysteresisPrevKey?: string
): { centerS: number; t: number; snappedTo?: string; snapKey?: string } {
  const idx = components.findIndex((c) => c.id === targetId);
  if (idx === -1 || bounds.lengthMm < 1) {
    return {
      centerS: proposedCenterS,
      t: Math.max(0.02, Math.min(0.98, proposedCenterS / (bounds.lengthMm || 1))),
    };
  }
  const target = components[idx];
  const halfW = target.widthMm / 2;
  const others = components.filter((c) => c.id !== targetId);
  const { minBound, maxBound } = getEffectiveWallBounds(components, bounds);

  // Collect valid non-overlapping center intervals [slotMin, slotMax]
  const intervals: Array<{ min: number; max: number }> = [];
  let cursor = minBound;
  for (const sib of others) {
    if (sib.leftS - cursor >= target.widthMm - 1) {
      intervals.push({ min: cursor + halfW, max: sib.leftS - halfW });
    }
    cursor = Math.max(cursor, sib.rightS);
  }
  if (maxBound - cursor >= target.widthMm - 1) {
    intervals.push({ min: cursor + halfW, max: maxBound - halfW });
  }

  let bestCenter = proposedCenterS;
  if (intervals.length > 0) {
    let bestDist = Infinity;
    for (const iv of intervals) {
      const clamped = Math.max(iv.min, Math.min(iv.max, proposedCenterS));
      const d = Math.abs(clamped - proposedCenterS);
      if (d < bestDist) {
        bestDist = d;
        bestCenter = clamped;
      }
    }
  } else {
    bestCenter = Math.max(halfW, Math.min(bounds.lengthMm - halfW, proposedCenterS));
  }

  let snappedTo: string | undefined;
  let snapKey: string | undefined;
  if (snapEnabled && intervals.length > 0) {
    // Check flush edge snaps and wall midpoint snap within active interval with 1.4x hysteresis
    const activeIv = intervals.find((iv) => bestCenter >= iv.min - 1 && bestCenter <= iv.max + 1);
    if (activeIv) {
      const candidates = [
        { c: activeIv.min, label: 'left_edge' },
        { c: activeIv.max, label: 'right_edge' },
        { c: bounds.lengthMm / 2, label: 'wall_center' },
      ]
        .filter((cand) => cand.c >= activeIv.min - 0.5 && cand.c <= activeIv.max + 0.5)
        .map((cand) => ({
          key: cand.label,
          dist: Math.abs(bestCenter - cand.c),
          data: cand,
        }));
      const picked = pickWithSnapHysteresis(candidates, hysteresisPrevKey, snapThresholdMm);
      if (picked) {
        bestCenter = picked.data.c;
        snappedTo = picked.data.label;
        snapKey = picked.key;
      }
    }
  }

  return {
    centerS: bestCenter,
    t: Math.max(0.005, Math.min(0.995, bestCenter / bounds.lengthMm)),
    snappedTo,
    snapKey,
  };
}

/**
 * Solves wall total length edit honoring the wall's anchorMode without displacing unrelated walls.
 */
export function solveWallLengthChange(
  wall: Wall,
  nextLengthMm: number
): { ok: boolean; start: Point2D; end: Point2D; error?: string } {
  if (wall.locked) {
    return { ok: false, start: wall.start, end: wall.end, error: 'Wall is locked.' };
  }
  if ((wall.anchorMode ?? 'free') === 'fixed_length') {
    return {
      ok: false,
      start: wall.start,
      end: wall.end,
      error: 'Wall length is anchored as Fixed Total Length.',
    };
  }
  if (!Number.isFinite(nextLengthMm) || nextLengthMm < 100) {
    return {
      ok: false,
      start: wall.start,
      end: wall.end,
      error: 'Wall length must be at least 10 cm.',
    };
  }

  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const curLen = Math.hypot(dx, dy);
  if (curLen < 1) {
    return {
      ok: true,
      start: wall.start,
      end: { x: wall.start.x + nextLengthMm, y: wall.start.y },
    };
  }
  const ux = dx / curLen;
  const uy = dy / curLen;
  const mode = wall.anchorMode ?? 'fixed_left';

  if (mode === 'fixed_right') {
    return {
      ok: true,
      start: {
        x: Math.round(wall.end.x - ux * nextLengthMm),
        y: Math.round(wall.end.y - uy * nextLengthMm),
      },
      end: { ...wall.end },
    };
  }
  if (mode === 'free') {
    const midX = (wall.start.x + wall.end.x) / 2;
    const midY = (wall.start.y + wall.end.y) / 2;
    return {
      ok: true,
      start: {
        x: Math.round(midX - (ux * nextLengthMm) / 2),
        y: Math.round(midY - (uy * nextLengthMm) / 2),
      },
      end: {
        x: Math.round(midX + (ux * nextLengthMm) / 2),
        y: Math.round(midY + (uy * nextLengthMm) / 2),
      },
    };
  }
  // 'fixed_left' (default)
  return {
    ok: true,
    start: { ...wall.start },
    end: {
      x: Math.round(wall.start.x + ux * nextLengthMm),
      y: Math.round(wall.start.y + uy * nextLengthMm),
    },
  };
}

/**
 * Corner-preserving wall length edit:
 * Resizes the target wall according to its anchorMode and updates shared endpoints on
 * connected neighbor walls so closed crooked/angled rooms stay connected without gaps.
 * Refuses with a clear message if a displaced corner joins a locked or fixed_length wall
 * or if resizing shrinks any affected wall below its placed components.
 */
export interface ConnectedWallLengthResult {
  ok: boolean;
  error?: string;
  wallUpdates: Array<{ id: string; start: Point2D; end: Point2D }>;
  openingUpdates: Array<{ id: string; t: number }>;
  chimneyUpdates: Array<{
    id: string;
    attachedT: number;
    xMm: number;
    yMm: number;
    rotationDeg: number;
  }>;
}

export function solveConnectedWallLengthChange(
  wall: Wall,
  allWalls: Wall[],
  openings: Opening[],
  archElements: ArchElement[],
  nextLengthMm: number,
  joinTolMm = 8
): ConnectedWallLengthResult {
  const base = solveWallLengthChange(wall, nextLengthMm);
  if (!base.ok) {
    return {
      ok: false,
      error: base.error,
      wallUpdates: [],
      openingUpdates: [],
      chimneyUpdates: [],
    };
  }

  const startMoved = dist(wall.start, base.start) > 0.5;
  const endMoved = dist(wall.end, base.end) > 0.5;
  const excludeSelf = new Set([wall.id]);

  const startNeighbors = startMoved
    ? findConnectedWallEndpoints(allWalls, wall.start, joinTolMm, excludeSelf)
    : [];
  const endNeighbors = endMoved
    ? findConnectedWallEndpoints(allWalls, wall.end, joinTolMm, excludeSelf)
    : [];

  const updatedWallMap = new Map<string, { start: Point2D; end: Point2D; movedStart: boolean; movedEnd: boolean }>();
  updatedWallMap.set(wall.id, {
    start: { ...base.start },
    end: { ...base.end },
    movedStart: startMoved,
    movedEnd: endMoved,
  });

  for (const hit of startNeighbors) {
    const nw = allWalls.find((w) => w.id === hit.wallId);
    if (!nw) continue;
    if (nw.locked) {
      return {
        ok: false,
        error: 'Cannot shift start corner: connected neighbor wall is locked. Unlock it or pin Start Corner.',
        wallUpdates: [],
        openingUpdates: [],
        chimneyUpdates: [],
      };
    }
    if ((nw.anchorMode ?? 'free') === 'fixed_length') {
      return {
        ok: false,
        error: 'Cannot shift start corner: connected neighbor wall has Fixed Total Length.',
        wallUpdates: [],
        openingUpdates: [],
        chimneyUpdates: [],
      };
    }
    const prev = updatedWallMap.get(nw.id) ?? {
      start: { ...nw.start },
      end: { ...nw.end },
      movedStart: false,
      movedEnd: false,
    };
    if (hit.endpoint === 'start') {
      prev.start = { ...base.start };
      prev.movedStart = true;
    } else {
      prev.end = { ...base.start };
      prev.movedEnd = true;
    }
    updatedWallMap.set(nw.id, prev);
  }

  for (const hit of endNeighbors) {
    const nw = allWalls.find((w) => w.id === hit.wallId);
    if (!nw) continue;
    if (nw.locked) {
      return {
        ok: false,
        error: 'Cannot shift end corner: connected neighbor wall is locked. Unlock it or pin End Corner.',
        wallUpdates: [],
        openingUpdates: [],
        chimneyUpdates: [],
      };
    }
    if ((nw.anchorMode ?? 'free') === 'fixed_length') {
      return {
        ok: false,
        error: 'Cannot shift end corner: connected neighbor wall has Fixed Total Length.',
        wallUpdates: [],
        openingUpdates: [],
        chimneyUpdates: [],
      };
    }
    const prev = updatedWallMap.get(nw.id) ?? {
      start: { ...nw.start },
      end: { ...nw.end },
      movedStart: false,
      movedEnd: false,
    };
    if (hit.endpoint === 'start') {
      prev.start = { ...base.end };
      prev.movedStart = true;
    } else {
      prev.end = { ...base.end };
      prev.movedEnd = true;
    }
    updatedWallMap.set(nw.id, prev);
  }

  // Validate new neighbor lengths and keep mounted openings/chimneys bounded without overlaps
  const openingUpdates: ConnectedWallLengthResult['openingUpdates'] = [];
  const chimneyUpdates: ConnectedWallLengthResult['chimneyUpdates'] = [];
  const wallUpdates: ConnectedWallLengthResult['wallUpdates'] = [];

  for (const [wid, upd] of updatedWallMap.entries()) {
    const oldWall = allWalls.find((w) => w.id === wid);
    if (!oldWall) continue;
    const oldLen = getWallArcLength(oldWall);
    const nextWall: Wall = { ...oldWall, start: upd.start, end: upd.end };
    const newLen = getWallArcLength(nextWall);

    if (newLen < 100) {
      return {
        ok: false,
        error: 'Resizing would collapse a connected wall below 10 cm.',
        wallUpdates: [],
        openingUpdates: [],
        chimneyUpdates: [],
      };
    }

    const comps = getWallMountedComponents(oldWall, openings, archElements);
    if (comps.length > 0 && oldLen > 1) {
      const totalCompWidth = comps.reduce((sum, c) => sum + c.widthMm, 0);
      if (totalCompWidth > newLen - 10) {
        return {
          ok: false,
          error:
            wid === wall.id
              ? `Wall length (${(newLen / 10).toFixed(1)} cm) is smaller than its placed components (${(totalCompWidth / 10).toFixed(1)} cm).`
              : `Connected neighbor wall cannot shrink to ${(newLen / 10).toFixed(1)} cm because of its placed components.`,
          wallUpdates: [],
          openingUpdates: [],
          chimneyUpdates: [],
        };
      }

      // Compute desired center S for each component preserving position from stationary end where possible
      const desired = comps.map((c) => {
        let newCenterS: number;
        if (upd.movedStart && !upd.movedEnd) {
          newCenterS = newLen - (oldLen - c.centerS);
        } else if (!upd.movedStart && upd.movedEnd) {
          newCenterS = c.centerS;
        } else {
          newCenterS = c.t * newLen;
        }
        return {
          ...c,
          leftS: newCenterS - c.widthMm / 2,
          rightS: newCenterS + c.widthMm / 2,
          centerS: newCenterS,
        };
      });

      // Clamp inside [4, newLen - 4] and pack sequentially without overlaps
      const margin = Math.min(40, Math.max(4, (newLen - totalCompWidth) / (comps.length + 1)));
      let cursor = margin;
      for (let i = 0; i < desired.length; i++) {
        if (desired[i].leftS < cursor) {
          desired[i].leftS = cursor;
          desired[i].rightS = cursor + desired[i].widthMm;
        }
        cursor = desired[i].rightS + 4;
      }
      let rightLimit = newLen - margin;
      for (let i = desired.length - 1; i >= 0; i--) {
        if (desired[i].rightS > rightLimit) {
          desired[i].rightS = rightLimit;
          desired[i].leftS = rightLimit - desired[i].widthMm;
        }
        desired[i].centerS = (desired[i].leftS + desired[i].rightS) / 2;
        rightLimit = desired[i].leftS - 4;
      }

      for (const c of desired) {
        const nextT = Math.max(0.002, Math.min(0.998, c.centerS / newLen));
        if (Math.abs(nextT - c.t) > 1e-5 || upd.movedStart || upd.movedEnd) {
          if (c.kind === 'opening') {
            openingUpdates.push({ id: c.id, t: nextT });
          } else {
            const el = archElements.find((a) => a.id === c.id);
            if (el) {
              const tf = computeAttachedChimneyTransform(
                nextWall,
                nextT,
                el.depthMm,
                el.attachedFace ?? 'left'
              );
              chimneyUpdates.push({
                id: c.id,
                attachedT: nextT,
                xMm: tf.xMm,
                yMm: tf.yMm,
                rotationDeg: tf.rotationDeg,
              });
            }
          }
        }
      }
    }

    wallUpdates.push({ id: wid, start: upd.start, end: upd.end });
  }

  return {
    ok: true,
    wallUpdates,
    openingUpdates,
    chimneyUpdates,
  };
}

/**
 * Computes world center (xMm, yMm) and rotationDeg for a wall-attached chimney
 * so it sits strictly flush on the chosen wall face without overlapping or floating.
 */
export function computeAttachedChimneyTransform(
  wall: Wall,
  t: number,
  depthMm: number,
  face: 'left' | 'right'
): { xMm: number; yMm: number; rotationDeg: number } {
  const { point, tangent, normal } = getWallCenterlinePoint(wall, t);
  const { left, right } = wallOffsets(wall.thicknessMm, wall.alignment);
  const offsetDist = face === 'left' ? left + depthMm / 2 : right - depthMm / 2;
  const rotationDeg = (Math.atan2(tangent.y, tangent.x) * 180) / Math.PI;
  return {
    xMm: Math.round(point.x + normal.x * offsetDist),
    yMm: Math.round(point.y + normal.y * offsetDist),
    rotationDeg,
  };
}

export function getChimneyWorldCorners(
  xMm: number,
  yMm: number,
  widthMm: number,
  depthMm: number,
  rotationDeg: number
): [Point2D, Point2D, Point2D, Point2D] {
  const hw = widthMm / 2;
  const hd = depthMm / 2;
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const xf = (lx: number, ly: number): Point2D => ({
    x: xMm + lx * cos - ly * sin,
    y: yMm + lx * sin + ly * cos,
  });
  return [xf(-hw, -hd), xf(hw, -hd), xf(hw, hd), xf(-hw, hd)];
}

function polygonsOverlapDepth(polyA: Point2D[], polyB: Point2D[]): number {
  if (polyA.length < 3 || polyB.length < 3) return 0;
  let minDepth = Infinity;
  const polys = [polyA, polyB];
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const len = Math.hypot(ex, ey);
      if (len < 1e-6) continue;
      const nx = -ey / len;
      const ny = ex / len;

      let minA = Infinity;
      let maxA = -Infinity;
      for (const p of polyA) {
        const pr = p.x * nx + p.y * ny;
        if (pr < minA) minA = pr;
        if (pr > maxA) maxA = pr;
      }

      let minB = Infinity;
      let maxB = -Infinity;
      for (const p of polyB) {
        const pr = p.x * nx + p.y * ny;
        if (pr < minB) minB = pr;
        if (pr > maxB) maxB = pr;
      }

      const overlap = Math.min(maxA, maxB) - Math.max(minA, minB);
      if (overlap <= 0) return 0;
      if (overlap < minDepth) minDepth = overlap;
    }
  }
  return Number.isFinite(minDepth) ? minDepth : 0;
}

function pointToPolygonDistance(pt: Point2D, poly: Point2D[]): number {
  if (poly.length < 3) return Infinity;
  // Inside check via winding / raycast
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    if (yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi + 1e-12) + xi) {
      inside = !inside;
    }
  }
  if (inside) return 0;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const d = projectPointOnSegment(pt, poly[i], poly[(i + 1) % poly.length]).distance;
    if (d < best) best = d;
  }
  return best;
}

/**
 * Checks whether a chimney footprint penetrates (> toleranceMm) into any visible wall polygon.
 * Flush edge contact (penetration <= toleranceMm) is allowed.
 */
export function doesChimneyOverlapWalls(
  xMm: number,
  yMm: number,
  widthMm: number,
  depthMm: number,
  rotationDeg: number,
  walls: Wall[],
  toleranceMm = 4
): boolean {
  const chimPoly = getChimneyWorldCorners(xMm, yMm, widthMm, depthMm, rotationDeg);
  for (const w of walls) {
    if (w.visible === false) continue;
    if (w.isCurved && Math.abs(w.curveBulgeMm) >= 1) {
      // Sample curved wall into quad segments
      const steps = 12;
      const { left, right } = wallOffsets(w.thicknessMm, w.alignment);
      const pts: Point2D[] = [];
      const nrms: Point2D[] = [];
      for (let i = 0; i <= steps; i++) {
        const res = getWallCenterlinePoint(w, i / steps);
        pts.push(res.point);
        nrms.push(res.normal);
      }
      for (let i = 0; i < steps; i++) {
        const quad: Point2D[] = [
          { x: pts[i].x + nrms[i].x * left, y: pts[i].y + nrms[i].y * left },
          { x: pts[i + 1].x + nrms[i + 1].x * left, y: pts[i + 1].y + nrms[i + 1].y * left },
          { x: pts[i + 1].x + nrms[i + 1].x * right, y: pts[i + 1].y + nrms[i + 1].y * right },
          { x: pts[i].x + nrms[i].x * right, y: pts[i].y + nrms[i].y * right },
        ];
        if (polygonsOverlapDepth(chimPoly, quad) > toleranceMm) return true;
      }
      continue;
    }
    const wallPoly = computeWallPolygon(w, walls);
    if (polygonsOverlapDepth(chimPoly, wallPoly) > toleranceMm) {
      return true;
    }
  }
  return false;
}

/**
 * Computes exact valid [minS, maxS] along a wall's chosen face ('left' or 'right') for a chimney
 * of given depthMm, accounting for corner miters and any adjacent/perpendicular walls on that face.
 */
export function computeChimneyFaceBounds(
  wall: Wall,
  allWalls: Wall[],
  face: 'left' | 'right',
  depthMm: number,
  refS?: number
): { minS: number; maxS: number; lengthMm: number; hasLeftCornerWall: boolean; hasRightCornerWall: boolean } {
  const lengthMm = getWallArcLength(wall);
  if (lengthMm < 1) {
    return { minS: 0, maxS: 0, lengthMm: 0, hasLeftCornerWall: false, hasRightCornerWall: false };
  }
  const inner = computeWallInnerBounds(wall, allWalls);
  let minS = face === 'left' ? Math.min(inner.leftStartS, inner.leftEndS) : Math.min(inner.rightStartS, inner.rightEndS);
  let maxS = face === 'left' ? Math.max(inner.leftStartS, inner.leftEndS) : Math.max(inner.rightStartS, inner.rightEndS);
  const pivotS = typeof refS === 'number' && Number.isFinite(refS) ? refS : (minS + maxS) / 2;

  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const ux = dx / lengthMm;
  const uy = dy / lengthMm;
  const { left, right } = wallOffsets(wall.thicknessMm, wall.alignment);
  const faceSgn = face === 'left' ? 1 : -1;
  const nx = -uy * faceSgn;
  const ny = ux * faceSgn;
  const faceOriginOffset = face === 'left' ? left : -right;

  let hasLeftCornerWall = Math.abs(minS) > 2 || findConnectedWallEndpoints(allWalls, wall.start, 10, new Set([wall.id])).length > 0;
  let hasRightCornerWall = Math.abs(maxS - lengthMm) > 2 || findConnectedWallEndpoints(allWalls, wall.end, 10, new Set([wall.id])).length > 0;

  // Clip against any other visible wall polygon that protrudes into the outward chimney band (0 < outD < depthMm)
  for (const other of allWalls) {
    if (other.id === wall.id || other.visible === false) continue;
    const oPoly = computeWallPolygon(other, allWalls);
    if (oPoly.length < 3) continue;

    // Collect s-extents of other polygon edges/vertices inside the outward strip (4mm .. depthMm - 4mm)
    const stripS: number[] = [];
    const dMin = 4;
    const dMax = Math.max(dMin + 2, depthMm - 4);
    const toLocal = (p: Point2D) => {
      const vx = p.x - wall.start.x;
      const vy = p.y - wall.start.y;
      return {
        s: vx * ux + vy * uy,
        d: vx * nx + vy * ny - faceOriginOffset,
      };
    };
    const lPts = oPoly.map(toLocal);
    for (const lp of lPts) {
      if (lp.d >= dMin && lp.d <= dMax) {
        stripS.push(lp.s);
      }
    }
    // Also intersect polygon edges with d = dMin and d = dMax
    for (let i = 0; i < lPts.length; i++) {
      const a = lPts[i];
      const b = lPts[(i + 1) % lPts.length];
      for (const dPlane of [dMin, dMax]) {
        if ((a.d < dPlane && b.d > dPlane) || (a.d > dPlane && b.d < dPlane)) {
          const t = (dPlane - a.d) / (b.d - a.d);
          stripS.push(a.s + (b.s - a.s) * t);
        }
      }
    }

    if (stripS.length === 0) continue;
    const oMinS = Math.min(...stripS);
    const oMaxS = Math.max(...stripS);
    if (oMaxS <= pivotS + 5 && oMaxS > minS && oMaxS < maxS - 20) {
      minS = Math.max(minS, Math.round(oMaxS));
      hasLeftCornerWall = true;
    } else if (oMinS >= pivotS - 5 && oMinS < maxS && oMinS > minS + 20) {
      maxS = Math.min(maxS, Math.round(oMinS));
      hasRightCornerWall = true;
    } else if (oMinS < pivotS && oMaxS > pivotS) {
      // Pivot is right over a perpendicular T-wall: keep whichever side of the T-wall has more room or is closer
      const distToRightOfT = Math.abs(pivotS - oMaxS);
      const distToLeftOfT = Math.abs(oMinS - pivotS);
      if (distToRightOfT <= distToLeftOfT && oMaxS < maxS - 20) {
        minS = Math.max(minS, Math.round(oMaxS));
        hasLeftCornerWall = true;
      } else if (oMinS > minS + 20) {
        maxS = Math.min(maxS, Math.round(oMinS));
        hasRightCornerWall = true;
      }
    }
  }

  return {
    minS,
    maxS: Math.max(minS, maxS),
    lengthMm,
    hasLeftCornerWall,
    hasRightCornerWall,
  };
}

/**
 * Determines whether an attached chimney is glued into the left or right corner of its host wall.
 */
export function getChimneyCornerPin(
  wall: Wall,
  allWalls: Wall[],
  t: number,
  widthMm: number,
  depthMm: number,
  face: 'left' | 'right',
  tolMm = 12
): 'left' | 'right' | null {
  const lengthMm = getWallArcLength(wall);
  const centerS = t * lengthMm;
  const bounds = computeChimneyFaceBounds(wall, allWalls, face, depthMm, centerS);
  const leftS = centerS - widthMm / 2;
  const rightS = centerS + widthMm / 2;
  if (bounds.hasLeftCornerWall && Math.abs(leftS - bounds.minS) <= tolMm) {
    return 'left';
  }
  if (bounds.hasRightCornerWall && Math.abs(rightS - bounds.maxS) <= tolMm) {
    return 'right';
  }
  return null;
}

/**
 * Snaps a chimney strictly flush onto the nearest valid wall edge without ever overlapping any wall.
 */
export function snapChimneyToWallEdge(
  worldPt: Point2D,
  widthMm: number,
  depthMm: number,
  walls: Wall[],
  openings: Opening[],
  archElements: ArchElement[],
  excludeChimneyId: string | undefined,
  snapEnabled: boolean,
  preferWallId?: string,
  preferFace?: 'left' | 'right',
  options?: { snapThresholdMm?: number; hysteresisPrevKey?: string }
): {
  wallId: string;
  face: 'left' | 'right';
  t: number;
  xMm: number;
  yMm: number;
  rotationDeg: number;
  cornerPin: 'left' | 'right' | null;
  snapKey?: string;
} | null {
  const visibleWalls = walls.filter((w) => w.visible !== false && getWallArcLength(w) >= 40);
  if (visibleWalls.length === 0) return null;

  const compSnapTol = options?.snapThresholdMm ?? 65;
  const cornerPinTol = Math.max(20, Math.min(60, Math.round(compSnapTol * 0.7)));

  type Candidate = {
    wall: Wall;
    face: 'left' | 'right';
    t: number;
    xMm: number;
    yMm: number;
    rotationDeg: number;
    cornerPin: 'left' | 'right' | null;
    compSnapKey?: string;
    score: number;
  };

  let best: Candidate | null = null;

  for (const w of visibleWalls) {
    const wallLen = getWallArcLength(w);
    const proj = projectPointOnSegment(worldPt, w.start, w.end);
    const { normal } = getWallCenterlinePoint(w, proj.t);
    const { left, right } = wallOffsets(w.thicknessMm, w.alignment);

    // Distance from worldPt to the centerline along normal
    const signedPerp = (worldPt.x - proj.point.x) * normal.x + (worldPt.y - proj.point.y) * normal.y;

    for (const face of ['left', 'right'] as const) {
      // Distance from cursor to the target chimney center on this face
      const faceCenterOffset = face === 'left' ? left + depthMm / 2 : right - depthMm / 2;
      const faceSurfaceOffset = face === 'left' ? left : right;

      const faceBounds = computeChimneyFaceBounds(w, walls, face, depthMm, proj.t * wallLen);
      if (faceBounds.maxS - faceBounds.minS < widthMm - 2) continue;

      const existingComps = getWallMountedComponents(w, openings, archElements).filter(
        (c) => c.id !== excludeChimneyId
      );
      const chimBounds: WallInnerBounds = {
        lengthMm: wallLen,
        innerStartS: faceBounds.minS,
        innerEndS: faceBounds.maxS,
        leftStartS: faceBounds.minS,
        leftEndS: faceBounds.maxS,
        rightStartS: faceBounds.minS,
        rightEndS: faceBounds.maxS,
      };
      const minCenterS = faceBounds.minS + widthMm / 2;
      const maxCenterS = faceBounds.maxS - widthMm / 2;
      const candCenterS =
        minCenterS <= maxCenterS
          ? Math.max(minCenterS, Math.min(maxCenterS, proj.t * wallLen))
          : (faceBounds.minS + faceBounds.maxS) / 2;
      const candT = Math.max(0.001, Math.min(0.999, candCenterS / wallLen));

      const tempComps: WallMountedComponent[] = [
        ...existingComps,
        {
          id: excludeChimneyId ?? '__preview__',
          kind: 'chimney' as const,
          name: 'Chimney',
          centerS: candCenterS,
          widthMm,
          leftS: candCenterS - widthMm / 2,
          rightS: candCenterS + widthMm / 2,
          t: candT,
          locked: false,
          resizeAnchor: 'center' as const,
        },
      ].sort((a, b) => a.centerS - b.centerS);

      const solved = solveWallComponentDrag(
        tempComps,
        chimBounds,
        excludeChimneyId ?? '__preview__',
        candCenterS,
        snapEnabled,
        compSnapTol,
        options?.hysteresisPrevKey
      );

      // Snap strongly into corners if close to corner boundary and not blocked by another component
      let finalS = solved.centerS;
      let cornerPin: 'left' | 'right' | null = null;
      const isIntervalBlocked = (leftEdge: number, rightEdge: number) =>
        existingComps.some((c) => c.rightS > leftEdge + 1 && c.leftS < rightEdge - 1);

      if (
        snapEnabled &&
        faceBounds.hasLeftCornerWall &&
        Math.abs(finalS - minCenterS) <= cornerPinTol &&
        !isIntervalBlocked(faceBounds.minS, faceBounds.minS + widthMm)
      ) {
        finalS = minCenterS;
        cornerPin = 'left';
      } else if (
        snapEnabled &&
        faceBounds.hasRightCornerWall &&
        Math.abs(finalS - maxCenterS) <= cornerPinTol &&
        !isIntervalBlocked(faceBounds.maxS - widthMm, faceBounds.maxS)
      ) {
        finalS = maxCenterS;
        cornerPin = 'right';
      } else {
        if (faceBounds.hasLeftCornerWall && Math.abs(finalS - minCenterS) <= 10) cornerPin = 'left';
        else if (faceBounds.hasRightCornerWall && Math.abs(finalS - maxCenterS) <= 10) cornerPin = 'right';
      }

      const finalT = Math.max(0.001, Math.min(0.999, finalS / wallLen));
      const xf = computeAttachedChimneyTransform(w, finalT, depthMm, face);

      // Reject any candidate that penetrates another wall polygon
      if (doesChimneyOverlapWalls(xf.xMm, xf.yMm, widthMm, depthMm, xf.rotationDeg, walls, 6)) {
        continue;
      }

      const perpDistToIdealCenter = Math.abs(signedPerp - faceCenterOffset);
      const isCursorOnThisSide =
        face === 'left' ? signedPerp >= faceSurfaceOffset - w.thicknessMm * 0.45 : signedPerp <= faceSurfaceOffset + w.thicknessMm * 0.45;
      const alongDelta = Math.abs(proj.t * wallLen - finalS);
      let score = Math.hypot(perpDistToIdealCenter, alongDelta);
      if (!isCursorOnThisSide) {
        score += w.thicknessMm + depthMm;
      }
      if (preferWallId && w.id === preferWallId) {
        score -= preferFace === face ? 55 : 18;
      }

      if (!best || score < best.score) {
        best = {
          wall: w,
          face,
          t: finalT,
          xMm: xf.xMm,
          yMm: xf.yMm,
          rotationDeg: xf.rotationDeg,
          cornerPin,
          compSnapKey: solved.snapKey,
          score,
        };
      }
    }
  }

  if (!best) return null;
  const resolvedSnapKey = best.cornerPin
    ? `${best.wall.id}:${best.face}:corner_${best.cornerPin}`
    : best.compSnapKey
      ? `${best.wall.id}:${best.face}:${best.compSnapKey}`
      : `${best.wall.id}:${best.face}`;
  return {
    wallId: best.wall.id,
    face: best.face,
    t: best.t,
    xMm: best.xMm,
    yMm: best.yMm,
    rotationDeg: best.rotationDeg,
    cornerPin: best.cornerPin,
    snapKey: resolvedSnapKey,
  };
}

/**
 * Determines which local edges of a chimney touch a visible wall face
 * so 2D rendering can erase wall-chimney seam lines cleanly.
 */
export function getChimneyTouchingEdges(
  el: Pick<ArchElement, 'xMm' | 'yMm' | 'widthMm' | 'depthMm' | 'rotationDeg' | 'attachedWallId' | 'attachedFace'>,
  walls: Wall[],
  tolMm = 8
): { top: boolean; bottom: boolean; left: boolean; right: boolean } {
  const hw = el.widthMm / 2;
  const hd = el.depthMm / 2;
  const rad = (el.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const toWorld = (lx: number, ly: number): Point2D => ({
    x: el.xMm + lx * cos - ly * sin,
    y: el.yMm + lx * sin + ly * cos,
  });

  const wallPolys = walls
    .filter((w) => w.visible !== false)
    .map((w) => ({ id: w.id, poly: computeWallPolygon(w, walls) }))
    .filter((item) => item.poly.length >= 3);

  const edgeTouchesWall = (a: Point2D, b: Point2D): boolean => {
    // Sample interior points (25%, 50%, 75%) so perpendicular corner intersections at endpoints don't falsely trigger
    const samples = [lerpPoint(a, b, 0.25), lerpPoint(a, b, 0.5), lerpPoint(a, b, 0.75)];
    for (const wp of wallPolys) {
      let hits = 0;
      for (const s of samples) {
        if (pointToPolygonDistance(s, wp.poly) <= tolMm) hits++;
      }
      if (hits >= 2) return true;
    }
    return false;
  };

  let top = edgeTouchesWall(toWorld(-hw, -hd), toWorld(hw, -hd));
  let bottom = edgeTouchesWall(toWorld(-hw, hd), toWorld(hw, hd));
  const left = edgeTouchesWall(toWorld(-hw, -hd), toWorld(-hw, hd));
  const right = edgeTouchesWall(toWorld(hw, -hd), toWorld(hw, hd));

  if (el.attachedWallId) {
    if ((el.attachedFace ?? 'left') === 'left') top = true;
    else bottom = true;
  }

  return { top, bottom, left, right };
}

/**
 * Resizes an attached chimney's width and/or depth while keeping it glued in a corner
 * (adding/removing on the side opposite the corner) and preventing any wall overlap.
 */
export function solveChimneyResize(
  wall: Wall,
  allWalls: Wall[],
  openings: Opening[],
  archElements: ArchElement[],
  chimneyId: string,
  nextWidthMm: number,
  nextDepthMm: number,
  anchorOverride?: ResizeAnchor
): {
  ok: boolean;
  error?: string;
  updates: Array<{ id: string; kind: 'opening' | 'chimney'; t: number; widthMm: number }>;
  depthMm: number;
  cornerPin: 'left' | 'right' | null;
} {
  const el = archElements.find((a) => a.id === chimneyId);
  if (!el) {
    return { ok: false, error: 'Chimney not found.', updates: [], depthMm: nextDepthMm, cornerPin: null };
  }
  if (el.locked) {
    return { ok: false, error: `"${el.name}" is locked.`, updates: [], depthMm: el.depthMm, cornerPin: null };
  }
  if (!Number.isFinite(nextWidthMm) || nextWidthMm < 50) {
    return { ok: false, error: 'Width must be at least 5 cm.', updates: [], depthMm: el.depthMm, cornerPin: null };
  }
  if (!Number.isFinite(nextDepthMm) || nextDepthMm < 50) {
    return { ok: false, error: 'Depth must be at least 5 cm.', updates: [], depthMm: el.depthMm, cornerPin: null };
  }

  const face = el.attachedFace ?? 'left';
  const curT = typeof el.attachedT === 'number'
    ? el.attachedT
    : projectPointOnSegment({ x: el.xMm, y: el.yMm }, wall.start, wall.end).t;
  const wallLengthApprox = getWallArcLength(wall) || 1;
  const curBounds = computeChimneyFaceBounds(wall, allWalls, face, el.depthMm, curT * wallLengthApprox);
  const nextBounds = computeChimneyFaceBounds(wall, allWalls, face, nextDepthMm, curT * wallLengthApprox);
  const wallLen = nextBounds.lengthMm || 1;

  const curPin = getChimneyCornerPin(wall, allWalls, curT, el.widthMm, el.depthMm, face);
  const effectiveAnchor: ResizeAnchor = curPin ?? anchorOverride ?? el.resizeAnchor ?? 'center';

  const comps = getWallMountedComponents(wall, openings, archElements);
  // Ensure the chimney's current center respects curBounds if already in corner
  const chimBounds: WallInnerBounds = {
    lengthMm: wallLen,
    innerStartS: nextBounds.minS,
    innerEndS: nextBounds.maxS,
    leftStartS: nextBounds.minS,
    leftEndS: nextBounds.maxS,
    rightStartS: nextBounds.minS,
    rightEndS: nextBounds.maxS,
  };

  // If depth changed while pinned to an angled corner, keep corner edge aligned to nextBounds
  const adjustedComps = comps.map((c) => {
    if (c.id !== chimneyId) return c;
    if (curPin === 'left' && Math.abs(curBounds.minS - nextBounds.minS) > 0.5) {
      const leftS = nextBounds.minS;
      const rightS = leftS + c.widthMm;
      return { ...c, leftS, rightS, centerS: (leftS + rightS) / 2, t: (leftS + rightS) / 2 / wallLen };
    }
    if (curPin === 'right' && Math.abs(curBounds.maxS - nextBounds.maxS) > 0.5) {
      const rightS = nextBounds.maxS;
      const leftS = rightS - c.widthMm;
      return { ...c, leftS, rightS, centerS: (leftS + rightS) / 2, t: (leftS + rightS) / 2 / wallLen };
    }
    return c;
  });

  const res = solveWallComponentResize(
    wall,
    adjustedComps,
    chimBounds,
    chimneyId,
    Math.round(nextWidthMm),
    effectiveAnchor
  );

  if (!res.ok) {
    return {
      ok: false,
      error: res.error,
      updates: [],
      depthMm: el.depthMm,
      cornerPin: curPin,
    };
  }

  // Verify the resized chimney (with nextDepthMm) does not penetrate ANY visible wall
  const selfUpd = res.updates.find((u) => u.id === chimneyId);
  if (selfUpd) {
    const xf = computeAttachedChimneyTransform(wall, selfUpd.t, nextDepthMm, face);
    if (doesChimneyOverlapWalls(xf.xMm, xf.yMm, selfUpd.widthMm, nextDepthMm, xf.rotationDeg, allWalls, 6)) {
      return {
        ok: false,
        error: 'Chimney cannot extend inside an adjacent or opposing wall.',
        updates: [],
        depthMm: el.depthMm,
        cornerPin: curPin,
      };
    }
  }

  const nextPin = selfUpd
    ? getChimneyCornerPin(wall, allWalls, selfUpd.t, selfUpd.widthMm, nextDepthMm, face)
    : curPin;

  return {
    ok: true,
    updates: res.updates,
    depthMm: Math.round(nextDepthMm),
    cornerPin: nextPin ?? curPin,
  };
}

export interface FurnitureWorldBox {
  id: string;
  name: string;
  cx: number;
  cy: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  isOverlay: boolean;
  corners: Point2D[];
}

export function rotateThreeYXZ(
  px: number,
  pz: number,
  py: number,
  rxDeg: number,
  ryDeg: number
): { x: number; y: number; z: number } {
  const rx = (rxDeg * Math.PI) / 180;
  const ry = (ryDeg * Math.PI) / 180;
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  // Three.js intrinsic 'YXZ' Euler (rx, ry, 0): M = R_y(ry) * R_x(rx)
  // Coordinates map as Three.X = px (planX), Three.Y = pz (upZ), Three.Z = py (planY)
  const x1 = px;
  const y1 = pz * cx - py * sx;
  const z1 = pz * sx + py * cx;
  const x2 = x1 * cy + z1 * sy;
  const y2 = y1;
  const z2 = -x1 * sy + z1 * cy;
  return { x: x2, y: z2, z: y2 };
}

/**
 * Exact 2D plan outline vertices of a FurniturePart in its own centered local space (mm),
 * matching createPartBaseGeometry in furniture3d.ts.
 */
export function getPartLocalOutline2D(part: FurniturePart, radialSegs = 28): Point2D[] {
  const w = Math.max(10, part.widthMm);
  const d = Math.max(10, part.depthMm);
  const hw = w / 2;
  const hd = d / 2;
  const ds = part.detailStyle;

  if (ds === 'caster_base') {
    const pw = Math.max(380, w);
    const r = pw / 2;
    const armLen = r * 0.88;
    const pts: Point2D[] = [];
    for (let i = 0; i < 5; i++) {
      const ang = (i / 5) * Math.PI * 2;
      const sin = Math.sin(ang);
      const cos = Math.cos(ang);
      const cx = sin * armLen;
      const cy = cos * armLen;
      // Wheel cylinder rotated by ang: local X half=18, local Z/Y half=24
      const wheelCorners: Array<[number, number]> = [
        [-18, -24],
        [18, -24],
        [18, 24],
        [-18, 24],
      ];
      for (const [lx, ly] of wheelCorners) {
        pts.push({
          x: cx + lx * cos + ly * sin,
          y: (cy - lx * sin + ly * cos) * (Math.abs(d - w) > 1 ? d / pw : 1),
        });
      }
    }
    return computeConvexHull2D(pts);
  }

  if (part.shape === 'cylinder' || part.shape === 'oval' || part.shape === 'sphere') {
    const segs = part.shape === 'sphere' ? 22 : radialSegs;
    const pts: Point2D[] = [];
    for (let i = 0; i < segs; i++) {
      const a = (i * 2 * Math.PI) / segs;
      pts.push({ x: Math.cos(a) * hw, y: Math.sin(a) * hd });
    }
    return pts;
  }

  const isCushioned = ds === 'cushion' || ds === 'pillow' || ds === 'mattress' || ds === 'blanket';
  const isBeveledStyle =
    ds === 'table_top' || ds === 'chair_seat' || ds === 'armrest' || ds === 'backrest' || Boolean(part.bevel);

  if (part.shape === 'rounded_rect' || (part.shape === 'box' && isBeveledStyle)) {
    const r =
      part.shape === 'box'
        ? Math.min(w, d) * 0.04
        : isCushioned
          ? Math.min(w * 0.16, d * 0.16, 90)
          : isBeveledStyle
            ? Math.min(w * 0.2, d * 0.2, 120)
            : Math.min(w * 0.22, d * 0.22, 140);
    const rx = Math.max(2, Math.min(r, hw * 0.48, hd * 0.48));
    const pts: Point2D[] = [];
    const sampleQuad = (x0: number, y0: number, cx: number, cy: number, x1: number, y1: number) => {
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        const omt = 1 - t;
        pts.push({
          x: omt * omt * x0 + 2 * omt * t * cx + t * t * x1,
          y: omt * omt * y0 + 2 * omt * t * cy + t * t * y1,
        });
      }
    };
    sampleQuad(hw - rx, -hd, hw, -hd, hw, -hd + rx);
    sampleQuad(hw, hd - rx, hw, hd, hw - rx, hd);
    sampleQuad(-hw + rx, hd, -hw, hd, -hw, hd - rx);
    sampleQuad(-hw, -hd + rx, -hw, -hd, -hw + rx, -hd);
    return pts;
  }

  if (part.shape === 'l_profile') {
    const armW = Math.min(w * 0.42, Math.max(w * 0.25, 320));
    const armD = Math.min(d * 0.42, Math.max(d * 0.25, 320));
    return [
      { x: -hw, y: -hd },
      { x: hw, y: -hd },
      { x: hw, y: -hd + armD },
      { x: -hw + armW, y: -hd + armD },
      { x: -hw + armW, y: hd },
      { x: -hw, y: hd },
    ];
  }

  if (part.shape === 'u_profile') {
    const armW = Math.min(w * 0.3, Math.max(w * 0.2, 260));
    const backD = Math.min(d * 0.35, Math.max(d * 0.22, 260));
    return [
      { x: -hw, y: -hd },
      { x: hw, y: -hd },
      { x: hw, y: hd },
      { x: hw - armW, y: hd },
      { x: hw - armW, y: -hd + backD },
      { x: -hw + armW, y: -hd + backD },
      { x: -hw + armW, y: hd },
      { x: -hw, y: hd },
    ];
  }

  if (part.shape === 'arc') {
    const steps = 36;
    const pts: Point2D[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * Math.PI;
      pts.push({ x: Math.cos(t) * hw, y: hd - Math.sin(t) * d });
    }
    for (let i = steps; i >= 0; i--) {
      const t = (i / steps) * Math.PI;
      pts.push({ x: Math.cos(t) * hw * 0.65, y: hd - Math.sin(t) * d * 0.65 });
    }
    return pts;
  }

  // box, extruded_svg, wedge (in 2D plan, wedge spans full width x depth; slope is along X-Z)
  return [
    { x: -hw, y: -hd },
    { x: hw, y: -hd },
    { x: hw, y: hd },
    { x: -hw, y: hd },
  ];
}

export interface Point3DMm {
  x: number;
  y: number; // plan Y
  z: number; // up Z
}

/**
 * Exact 3D boundary vertices for a single FurniturePart in unrotated furniture-local space (mm),
 * delegated to the canonical Three.js part geometry & composite boundary extractor.
 */
export function getPartFurnitureLocalBoundary3D(
  part: FurniturePart,
  templateId?: string
): Point3DMm[] {
  return getCanonicalPartBoundaryVertices3DMm(part, templateId);
}

export function computeFurnitureTiltedLocalBoundsMm(
  parts: FurniturePart[],
  rotationXDeg = 0,
  rotationYDeg = 0,
  mirroredX = false,
  mirroredY = false,
  templateId?: string
): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  zShift: number;
} {
  const b = computeFurnitureBoundsMm(parts);
  const mx = mirroredX ? -1 : 1;
  const my = mirroredY ? -1 : 1;
  const hasTilt = Math.abs(rotationXDeg) >= 0.05 || Math.abs(rotationYDeg) >= 0.05;

  if (!parts || parts.length === 0) {
    if (!hasTilt) {
      const xs = [b.minX * mx, b.maxX * mx];
      const ys = [b.minY * my, b.maxY * my];
      return {
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
        minY: Math.min(...ys),
        maxY: Math.max(...ys),
        minZ: b.minZ,
        maxZ: b.maxZ,
        zShift: 0,
      };
    }
    const corners = [
      [b.minX * mx, b.minY * my, b.minZ],
      [b.maxX * mx, b.minY * my, b.minZ],
      [b.minX * mx, b.maxY * my, b.minZ],
      [b.maxX * mx, b.maxY * my, b.minZ],
      [b.minX * mx, b.minY * my, b.maxZ],
      [b.maxX * mx, b.minY * my, b.maxZ],
      [b.minX * mx, b.maxY * my, b.maxZ],
      [b.maxX * mx, b.maxY * my, b.maxZ],
    ];
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const [cx, cy, cz] of corners) {
      const r = rotateThreeYXZ(cx, cz, cy, rotationXDeg, rotationYDeg);
      if (r.x < minX) minX = r.x;
      if (r.x > maxX) maxX = r.x;
      if (r.y < minY) minY = r.y;
      if (r.y > maxY) maxY = r.y;
      if (r.z < minZ) minZ = r.z;
      if (r.z > maxZ) maxZ = r.z;
    }
    const zShift = b.minZ - minZ;
    return { minX, maxX, minY, maxY, minZ: b.minZ, maxZ: maxZ + zShift, zShift };
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (const part of parts) {
    for (const v of getPartFurnitureLocalBoundary3D(part, templateId)) {
      const vx = v.x * mx;
      const vy = v.y * my;
      const vz = v.z;
      const r = hasTilt ? rotateThreeYXZ(vx, vz, vy, rotationXDeg, rotationYDeg) : { x: vx, y: vy, z: vz };
      if (r.x < minX) minX = r.x;
      if (r.x > maxX) maxX = r.x;
      if (r.y < minY) minY = r.y;
      if (r.y > maxY) maxY = r.y;
      if (r.z < minZ) minZ = r.z;
      if (r.z > maxZ) maxZ = r.z;
    }
  }

  const zShift = hasTilt ? b.minZ - minZ : 0;
  return { minX, maxX, minY, maxY, minZ: b.minZ, maxZ: maxZ + zShift, zShift };
}

export type FurniturePlacementInput = Pick<
  FurnitureInstance,
  'parts' | 'rotationDeg' | 'elevationMm'
> &
  Partial<
    Pick<
      FurnitureInstance,
      | 'id'
      | 'name'
      | 'templateId'
      | 'category'
      | 'xMm'
      | 'yMm'
      | 'rotationXDeg'
      | 'rotationYDeg'
      | 'mirroredX'
      | 'mirroredY'
      | 'mountingType'
      | 'attachedWallId'
      | 'surfaceHostId'
    >
  >;

export interface FurniturePlacement {
  xMm: number;
  yMm: number;
  rotationDeg: number;
  rotationXDeg: number;
  rotationYDeg: number;
  mirroredX: boolean;
  mirroredY: boolean;
  mirrorSignX: 1 | -1;
  mirrorSignY: 1 | -1;
  hasTilt: boolean;
  groupElevationMm: number;
  tiltZShiftMm: number;
  untiltLocalBounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
    widthMm: number;
    depthMm: number;
    heightMm: number;
  };
  tiltedLocalBounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
    widthMm: number;
    depthMm: number;
    heightMm: number;
    zShift: number;
  };
  orientedCorners: Point2D[];
  tiltedLocalConvexHull: Point2D[];
  worldConvexHull: Point2D[];
  worldBounds2D: { minX: number; maxX: number; minY: number; maxY: number; cx: number; cy: number };
  elevationSpanMm: { minZ: number; maxZ: number };
  localToWorld3D: (lx: number, ly: number, lz: number) => Point3DMm;
  worldToLocalPlan2D: (wx: number, wy: number) => Point2D;
}

/**
 * Single source of truth for furniture placement across 2D Plan, Wall View, 3D Viewport,
 * 3D GLB Export, snapping, collision, and stack visualization.
 *
 * Canonical transform order:
 *   Part local -> Mirror (mx, my) -> Tilt (YXZ rx, ry) -> Ground Z shift (zShift)
 *   -> World yaw (rotationDeg) -> World translation (xMm, groupElevationMm, yMm).
 */
export function getFurniturePlacement(
  furn: FurniturePlacementInput,
  options?: {
    pos?: Point2D;
    effectiveCeilingMm?: number;
  }
): FurniturePlacement {
  const xMm = options?.pos ? options.pos.x : furn.xMm ?? 0;
  const yMm = options?.pos ? options.pos.y : furn.yMm ?? 0;
  const rotationDeg = furn.rotationDeg ?? 0;
  const rotationXDeg = furn.rotationXDeg ?? 0;
  const rotationYDeg = furn.rotationYDeg ?? 0;
  const mirroredX = Boolean(furn.mirroredX);
  const mirroredY = Boolean(furn.mirroredY);
  const mirrorSignX: 1 | -1 = mirroredX ? -1 : 1;
  const mirrorSignY: 1 | -1 = mirroredY ? -1 : 1;
  const hasTilt = Math.abs(rotationXDeg) >= 0.05 || Math.abs(rotationYDeg) >= 0.05;

  const parts = furn.parts ?? [];
  const untiltLocalBounds = computeFurnitureBoundsMm(parts);

  // Single traversal for tilted+mirrored local geometry bounds and convex hull
  let tMinX = Infinity;
  let tMaxX = -Infinity;
  let tMinY = Infinity;
  let tMaxY = -Infinity;
  let tMinZ = Infinity;
  let tMaxZ = -Infinity;
  const tiltedPts2D: Point2D[] = [];

  if (parts.length === 0) {
    const emptyTb = computeFurnitureTiltedLocalBoundsMm(parts, rotationXDeg, rotationYDeg, mirroredX, mirroredY);
    tMinX = emptyTb.minX;
    tMaxX = emptyTb.maxX;
    tMinY = emptyTb.minY;
    tMaxY = emptyTb.maxY;
    tMinZ = emptyTb.minZ - emptyTb.zShift;
    tMaxZ = emptyTb.maxZ - emptyTb.zShift;
    tiltedPts2D.push(
      { x: tMinX, y: tMinY },
      { x: tMaxX, y: tMinY },
      { x: tMaxX, y: tMaxY },
      { x: tMinX, y: tMaxY }
    );
  } else {
    for (const part of parts) {
      for (const v of getPartFurnitureLocalBoundary3D(part, furn.templateId)) {
        const vx = v.x * mirrorSignX;
        const vy = v.y * mirrorSignY;
        const vz = v.z;
        const r = hasTilt ? rotateThreeYXZ(vx, vz, vy, rotationXDeg, rotationYDeg) : { x: vx, y: vy, z: vz };
        if (r.x < tMinX) tMinX = r.x;
        if (r.x > tMaxX) tMaxX = r.x;
        if (r.y < tMinY) tMinY = r.y;
        if (r.y > tMaxY) tMaxY = r.y;
        if (r.z < tMinZ) tMinZ = r.z;
        if (r.z > tMaxZ) tMaxZ = r.z;
        tiltedPts2D.push({ x: r.x, y: r.y });
      }
    }
  }

  const tiltZShiftMm = hasTilt ? untiltLocalBounds.minZ - tMinZ : 0;
  const tiltedLocalBounds = {
    minX: tMinX,
    maxX: tMaxX,
    minY: tMinY,
    maxY: tMaxY,
    minZ: untiltLocalBounds.minZ,
    maxZ: tMaxZ + tiltZShiftMm,
    widthMm: Math.max(10, tMaxX - tMinX),
    depthMm: Math.max(10, tMaxY - tMinY),
    heightMm: Math.max(10, tMaxZ + tiltZShiftMm - untiltLocalBounds.minZ),
    zShift: tiltZShiftMm,
  };

  // Resolve ceiling / indoor AC elevation offset consistently with 3D builders
  const hasCeilingIdentity = typeof furn.templateId === 'string' && typeof furn.category === 'string';
  const mType = hasCeilingIdentity
    ? resolveFurnitureMountingType({
        templateId: furn.templateId!,
        category: furn.category!,
        parts,
        elevationMm: furn.elevationMm,
        surfaceHostId: furn.surfaceHostId,
        mountingType: furn.mountingType,
        attachedWallId: furn.attachedWallId,
      })
    : furn.mountingType ?? (furn.attachedWallId ? 'wall' : 'floor');
  const ceilingCandidate =
    hasCeilingIdentity &&
    (mType === 'ceiling' ||
      (isAcIndoorUnit({ templateId: furn.templateId!, parts }) && mType === 'wall'));
  let groupElevationMm = furn.elevationMm ?? 0;
  if (ceilingCandidate && typeof options?.effectiveCeilingMm === 'number') {
    const ceilMm = options.effectiveCeilingMm;
    if (mType === 'wall') {
      const targetTopOffset = ceilMm - 50 - tiltedLocalBounds.maxZ;
      groupElevationMm = Math.max(1200 - tiltedLocalBounds.minZ, targetTopOffset);
    } else {
      const dropOffset = ceilMm - 1 - tiltedLocalBounds.maxZ;
      const minSafeOffset = 150 - tiltedLocalBounds.minZ;
      groupElevationMm = Math.max(minSafeOffset, dropOffset);
    }
  }

  const radF = (rotationDeg * Math.PI) / 180;
  const cosF = Math.cos(radF);
  const sinF = Math.sin(radF);

  const orientedCorners: Point2D[] = [
    { x: tiltedLocalBounds.minX, y: tiltedLocalBounds.minY },
    { x: tiltedLocalBounds.maxX, y: tiltedLocalBounds.minY },
    { x: tiltedLocalBounds.maxX, y: tiltedLocalBounds.maxY },
    { x: tiltedLocalBounds.minX, y: tiltedLocalBounds.maxY },
  ].map((pt) => ({
    x: xMm + pt.x * cosF - pt.y * sinF,
    y: yMm + pt.x * sinF + pt.y * cosF,
  }));

  const tiltedLocalConvexHull = computeConvexHull2D(tiltedPts2D);
  const worldConvexHull = tiltedLocalConvexHull.map((pt) => ({
    x: xMm + pt.x * cosF - pt.y * sinF,
    y: yMm + pt.x * sinF + pt.y * cosF,
  }));

  let wMinX = Infinity;
  let wMaxX = -Infinity;
  let wMinY = Infinity;
  let wMaxY = -Infinity;
  const boundsPts = worldConvexHull.length >= 3 ? worldConvexHull : orientedCorners;
  for (const pt of boundsPts) {
    if (pt.x < wMinX) wMinX = pt.x;
    if (pt.x > wMaxX) wMaxX = pt.x;
    if (pt.y < wMinY) wMinY = pt.y;
    if (pt.y > wMaxY) wMaxY = pt.y;
  }

  const localToWorld3D = (lx: number, ly: number, lz: number): Point3DMm => {
    const mxVal = lx * mirrorSignX;
    const myVal = ly * mirrorSignY;
    const tilted = hasTilt
      ? rotateThreeYXZ(mxVal, lz, myVal, rotationXDeg, rotationYDeg)
      : { x: mxVal, y: myVal, z: lz };
    return {
      x: xMm + tilted.x * cosF - tilted.y * sinF,
      y: yMm + tilted.x * sinF + tilted.y * cosF,
      z: groupElevationMm + tilted.z + tiltZShiftMm,
    };
  };

  const worldToLocalPlan2D = (wx: number, wy: number): Point2D => {
    const dx = wx - xMm;
    const dy = wy - yMm;
    const invRx = dx * cosF + dy * sinF;
    const invRy = -dx * sinF + dy * cosF;
    return {
      x: invRx * mirrorSignX,
      y: invRy * mirrorSignY,
    };
  };

  return {
    xMm,
    yMm,
    rotationDeg,
    rotationXDeg,
    rotationYDeg,
    mirroredX,
    mirroredY,
    mirrorSignX,
    mirrorSignY,
    hasTilt,
    groupElevationMm,
    tiltZShiftMm,
    untiltLocalBounds,
    tiltedLocalBounds,
    orientedCorners,
    tiltedLocalConvexHull,
    worldConvexHull,
    worldBounds2D: {
      minX: wMinX,
      maxX: wMaxX,
      minY: wMinY,
      maxY: wMaxY,
      cx: (wMinX + wMaxX) / 2,
      cy: (wMinY + wMaxY) / 2,
    },
    elevationSpanMm: {
      minZ: groupElevationMm + tiltedLocalBounds.minZ,
      maxZ: groupElevationMm + tiltedLocalBounds.maxZ,
    },
    localToWorld3D,
    worldToLocalPlan2D,
  };
}

function getFurnitureOrientedOffsets(
  parts: FurniturePart[],
  rotationDeg: number,
  mirroredX = false,
  mirroredY = false,
  rotationXDeg = 0,
  rotationYDeg = 0
): Point2D[] {
  return getFurniturePlacement({
    xMm: 0,
    yMm: 0,
    elevationMm: 0,
    parts,
    rotationDeg,
    mirroredX,
    mirroredY,
    rotationXDeg,
    rotationYDeg,
  }).orientedCorners;
}

export function computeFurnitureWorldBox(
  pos: Point2D,
  furn: Pick<
    FurnitureInstance,
    | 'id'
    | 'name'
    | 'templateId'
    | 'category'
    | 'elevationMm'
    | 'parts'
    | 'rotationDeg'
    | 'rotationXDeg'
    | 'rotationYDeg'
    | 'mirroredX'
    | 'mirroredY'
  >
): FurnitureWorldBox {
  const placement = getFurniturePlacement(furn, { pos });
  const { minX, maxX, minY, maxY, cx, cy } = placement.worldBounds2D;
  const { minZ, maxZ } = placement.elevationSpanMm;
  const isRug =
    furn.templateId.startsWith('rug_') ||
    (furn.parts.length > 0 &&
      furn.parts.every((p) => p.detailStyle === 'rug' || p.detailStyle === 'fringe_rug')) ||
    maxZ <= 60;
  const isCeiling = minZ >= 1750;
  return {
    id: furn.id,
    name: furn.name,
    cx,
    cy,
    minX,
    maxX,
    minY,
    maxY,
    minZ,
    maxZ,
    isOverlay: isRug || isCeiling,
    corners: placement.orientedCorners,
  };
}

export interface AttachmentTargetPreview {
  kind: 'wall' | 'surface';
  label: string;
  wallId?: string;
  wallFace?: 'left' | 'right';
  wallT?: number;
  wallSegment?: { from: Point2D; to: Point2D };
  surfaceHostId?: string;
  surfacePolygon?: Point2D[];
}

export interface FurnitureSnapResult {
  xMm: number;
  yMm: number;
  rotationDeg: number;
  snappedKind: 'vertex' | 'wall' | 'align' | 'grid' | 'none';
  snapLabel?: string;
  snapKey?: string;
  hysteresis?: SnapHysteresisState;
  guides: AlignmentGuide[];
  attachedWallId?: string;
  attachedFace?: 'left' | 'right';
  attachedT?: number;
  attachmentPreview?: AttachmentTargetPreview;
  roomCenterSnap?: { roomId: string; roomName: string; center: Point2D };
}

/**
 * Snaps furniture seamlessly flush against wall faces & room corners,
 * flush edge-to-edge against adjacent furniture pieces, aligns centers / edges,
 * and magnetically snaps to true geometric room centers.
 */
export function snapFurnitureToPlan(
  targetPos: Point2D,
  furn: Pick<
    FurnitureInstance,
    'id' | 'name' | 'templateId' | 'category' | 'elevationMm' | 'parts' | 'rotationDeg' | 'mirroredX' | 'mirroredY'
  > &
    Partial<
      Pick<
        FurnitureInstance,
        'rotationXDeg' | 'rotationYDeg' | 'mountingType' | 'mountingFace' | 'attachedWallId' | 'attachedFace' | 'wallOffsetMm' | 'surfaceHostId'
      >
    >,
  walls: Wall[],
  otherFurniture: FurnitureInstance[],
  options: {
    snapEnabled: boolean;
    gridSizeMm: number;
    wallSnapTolMm?: number;
    furnSnapTolMm?: number;
    alignTolMm?: number;
    roomCenterTolMm?: number;
    strongRoomCenterTolMm?: number;
    surfaceRoomCenterTolMm?: number;
    hysteresis?: SnapHysteresisState;
    rooms?: Room[];
  }
): FurnitureSnapResult {
  const isCurtain = isCurtainOrBlindFurniture(furn);
  const mountingType = resolveFurnitureMountingType(furn);
  const visibleWalls = walls.filter((w) => w.visible !== false && !w.isCurved && getWallArcLength(w) >= 40);
  const nextHyst: SnapHysteresisState = { ...(options.hysteresis ?? {}) };

  // Curtains & blinds must stick exclusively onto walls (and freely overlap furniture)
  if (isCurtain && visibleWalls.length > 0) {
    let bestCurtainSnap: {
      x: number;
      y: number;
      rot: number;
      distToTarget: number;
      guide: AlignmentGuide;
      wallId: string;
      wallFace: 'left' | 'right';
      wallT: number;
      segFrom: Point2D;
      segTo: Point2D;
    } | null = null;

    for (const w of visibleWalls) {
      const wallLen = getWallArcLength(w);
      const ux = (w.end.x - w.start.x) / wallLen;
      const uy = (w.end.y - w.start.y) / wallLen;
      const nx = -uy;
      const ny = ux;
      const { left, right } = wallOffsets(w.thicknessMm, w.alignment);
      const wallMid = (left + right) / 2;
      const dNormCur = (targetPos.x - w.start.x) * nx + (targetPos.y - w.start.y) * ny;
      let onLeft = dNormCur >= wallMid;
      if (furn.attachedWallId === w.id && (furn.attachedFace === 'left' || furn.attachedFace === 'right')) {
        onLeft = furn.attachedFace === 'left' ? dNormCur >= right - 25 : dNormCur > left + 25;
      }
      const wallAngleDeg = (Math.atan2(uy, ux) * 180) / Math.PI;
      const candRot = Math.round(((onLeft ? wallAngleDeg : wallAngleDeg + 180) % 360 + 360) % 360);

      const rotOffsets = getFurnitureOrientedOffsets(
        furn.parts,
        candRot,
        furn.mirroredX,
        furn.mirroredY,
        furn.rotationXDeg ?? 0,
        furn.rotationYDeg ?? 0
      );
      const tVals = rotOffsets.map((o) => o.x * ux + o.y * uy);
      const nVals = rotOffsets.map((o) => o.x * nx + o.y * ny);
      const tMin = Math.min(...tVals);
      const tMax = Math.max(...tVals);
      const nMin = Math.min(...nVals);
      const nMax = Math.max(...nVals);

      const wallOff = furn.wallOffsetMm ?? 0;
      const faceOffset = onLeft ? left : right;
      const idealDNorm = onLeft ? faceOffset + wallOff - nMin : faceOffset - wallOff - nMax;

      const sRaw = (targetPos.x - w.start.x) * ux + (targetPos.y - w.start.y) * uy;
      const spanMin = tMax - tMin <= wallLen ? Math.max(0, -tMin) : 0;
      const spanMax = tMax - tMin <= wallLen ? Math.min(wallLen, wallLen - tMax) : wallLen;
      const clampedS = Math.max(spanMin, Math.min(spanMax, sRaw));

      const sx = w.start.x + ux * clampedS + nx * idealDNorm;
      const sy = w.start.y + uy * clampedS + ny * idealDNorm;
      const dTarget = Math.hypot(sx - targetPos.x, sy - targetPos.y);

      if (!bestCurtainSnap || dTarget < bestCurtainSnap.distToTarget) {
        const s1 = Math.max(0, Math.min(wallLen, clampedS + tMin));
        const s2 = Math.max(0, Math.min(wallLen, clampedS + tMax));
        const segFrom = {
          x: w.start.x + ux * s1 + nx * faceOffset,
          y: w.start.y + uy * s1 + ny * faceOffset,
        };
        const segTo = {
          x: w.start.x + ux * s2 + nx * faceOffset,
          y: w.start.y + uy * s2 + ny * faceOffset,
        };
        bestCurtainSnap = {
          x: sx,
          y: sy,
          rot: candRot,
          distToTarget: dTarget,
          wallId: w.id,
          wallFace: onLeft ? 'left' : 'right',
          wallT: Math.max(0, Math.min(1, clampedS / wallLen)),
          segFrom,
          segTo,
          guide: {
            axis: Math.abs(ux) > Math.abs(uy) ? 'y' : 'x',
            from: segFrom,
            to: segTo,
            label: 'WALL MOUNTED',
          },
        };
      }
    }

    if (bestCurtainSnap) {
      return {
        xMm: Math.round(bestCurtainSnap.x),
        yMm: Math.round(bestCurtainSnap.y),
        rotationDeg: bestCurtainSnap.rot,
        snappedKind: 'wall',
        snapLabel: 'Wall Mounted',
        snapKey: `curtain_${bestCurtainSnap.wallId}_${bestCurtainSnap.wallFace}`,
        hysteresis: nextHyst,
        guides: [bestCurtainSnap.guide],
        attachedWallId: bestCurtainSnap.wallId,
        attachedFace: bestCurtainSnap.wallFace,
        attachedT: bestCurtainSnap.wallT,
        attachmentPreview: {
          kind: 'wall',
          label: 'Wall Mounted',
          wallId: bestCurtainSnap.wallId,
          wallFace: bestCurtainSnap.wallFace,
          wallT: bestCurtainSnap.wallT,
          wallSegment: { from: bestCurtainSnap.segFrom, to: bestCurtainSnap.segTo },
        },
      };
    }
  }

  if (!options.snapEnabled) {
    return {
      xMm: Math.round(targetPos.x),
      yMm: Math.round(targetPos.y),
      rotationDeg: furn.rotationDeg,
      snappedKind: 'none',
      hysteresis: {},
      guides: [],
    };
  }

  const baseWallTol = options.wallSnapTolMm ?? 135;
  const wallTol = mountingType === 'wall' ? Math.max(baseWallTol, 175) : baseWallTol;
  const furnTol = options.furnSnapTolMm ?? 95;
  const alignTol = options.alignTolMm ?? 70;
  const guides: AlignmentGuide[] = [];

  let curRot = furn.rotationDeg;
  let curPos: Point2D = { x: targetPos.x, y: targetPos.y };

  // --- 1. Wall-Face & Room-Corner Snapping ---
  interface WallSnapCandidate {
    key: string;
    wall: Wall;
    u: Point2D;
    n: Point2D;
    onLeft: boolean;
    idealDNorm: number;
    faceOffset: number;
    deltaSigned: number;
    absDelta: number;
    tMin: number;
    tMax: number;
    sCenter: number;
    wallLen: number;
    wallAngleDeg: number;
    wallDeltaMod90: number;
  }

  const wallCands: WallSnapCandidate[] = [];
  const wallOff = mountingType === 'wall' ? (furn.wallOffsetMm ?? 0) : 0;
  const offsetsBase = getFurnitureOrientedOffsets(
    furn.parts,
    curRot,
    furn.mirroredX,
    furn.mirroredY,
    furn.rotationXDeg ?? 0,
    furn.rotationYDeg ?? 0
  );

  for (const w of visibleWalls) {
    const wallLen = getWallArcLength(w);
    const ux = (w.end.x - w.start.x) / wallLen;
    const uy = (w.end.y - w.start.y) / wallLen;
    const nx = -uy;
    const ny = ux;
    const { left, right } = wallOffsets(w.thicknessMm, w.alignment);
    const wallMid = (left + right) / 2;

    const sCenter = (curPos.x - w.start.x) * ux + (curPos.y - w.start.y) * uy;
    const dNorm = (curPos.x - w.start.x) * nx + (curPos.y - w.start.y) * ny;

    const tVals = offsetsBase.map((o) => o.x * ux + o.y * uy);
    const nVals = offsetsBase.map((o) => o.x * nx + o.y * ny);
    const tMin = Math.min(...tVals);
    const tMax = Math.max(...tVals);
    const nMin = Math.min(...nVals);
    const nMax = Math.max(...nVals);

    // Must overlap the wall span (with small 45mm corner grace)
    if (sCenter + tMax < -45 || sCenter + tMin > wallLen + 45) continue;

    const preserveExistingFaceOnWall =
      mountingType === 'wall' &&
      furn.attachedWallId === w.id &&
      (furn.attachedFace === 'left' || furn.attachedFace === 'right');
    let onLeft = dNorm >= wallMid;
    if (preserveExistingFaceOnWall) {
      onLeft = furn.attachedFace === 'left' ? dNorm >= right - 25 : dNorm > left + 25;
    }
    const faceOffset = onLeft ? left : right;
    const idealDNorm = onLeft ? faceOffset + wallOff - nMin : faceOffset - wallOff - nMax;
    const deltaSigned = idealDNorm - dNorm;
    const absDelta = Math.abs(deltaSigned);

    const pushingIntoWall = onLeft
      ? dNorm < idealDNorm && dNorm >= right - 25
      : dNorm > idealDNorm && dNorm <= left + 25;

    const wallKey = `${w.id}:${onLeft ? 'L' : 'R'}`;
    if (absDelta <= wallTol * 1.45 || pushingIntoWall) {
      const wallAngleDeg = (Math.atan2(uy, ux) * 180) / Math.PI;
      let diff = ((curRot - wallAngleDeg) % 90 + 90) % 90;
      if (diff > 45) diff -= 90;
      wallCands.push({
        key: wallKey,
        wall: w,
        u: { x: ux, y: uy },
        n: { x: nx, y: ny },
        onLeft,
        idealDNorm,
        faceOffset,
        deltaSigned,
        absDelta: pushingIntoWall ? Math.min(absDelta, wallTol * 0.5) : absDelta,
        tMin,
        tMax,
        sCenter,
        wallLen,
        wallAngleDeg,
        wallDeltaMod90: diff,
      });
    }
  }

  wallCands.sort((a, b) => a.absDelta - b.absDelta);
  const pickedWall = pickWithSnapHysteresis(
    wallCands.map((c) => ({ key: c.key, dist: c.absDelta, data: c })),
    nextHyst.wallKey,
    wallTol
  );

  let wallLockedX = false;
  let wallLockedY = false;
  let snappedKind: FurnitureSnapResult['snappedKind'] = 'none';
  let snapLabel: string | undefined;
  let attachedWallId: string | undefined;
  let attachedFace: 'left' | 'right' | undefined;
  let attachedT: number | undefined;
  let wallAttachmentPreview: AttachmentTargetPreview | undefined;
  let activeWallSnapKey: string | undefined;

  if (pickedWall) {
    const primary = pickedWall.data;
    nextHyst.wallKey = primary.key;
    activeWallSnapKey = primary.key;
    const isAutoOrientWallMount = mountingType === 'wall';

    let nextRot: number | null = null;
    if (isAutoOrientWallMount) {
      const targetRot = Math.round(((primary.onLeft ? primary.wallAngleDeg : primary.wallAngleDeg + 180) % 360 + 360) % 360);
      const curNorm = ((curRot % 360) + 360) % 360;
      if (Math.abs(targetRot - curNorm) > 0.5) {
        nextRot = targetRot;
      }
    } else if (Math.abs(primary.wallDeltaMod90) > 0.2 && Math.abs(primary.wallDeltaMod90) <= 12) {
      nextRot = Math.round(curRot - primary.wallDeltaMod90);
    }

    if (nextRot !== null) {
      curRot = nextRot;
      const rotOffsets = getFurnitureOrientedOffsets(
        furn.parts,
        curRot,
        furn.mirroredX,
        furn.mirroredY,
        furn.rotationXDeg ?? 0,
        furn.rotationYDeg ?? 0
      );
      const { left, right } = wallOffsets(primary.wall.thicknessMm, primary.wall.alignment);
      const dNorm = (curPos.x - primary.wall.start.x) * primary.n.x + (curPos.y - primary.wall.start.y) * primary.n.y;
      const onLeft = primary.onLeft;
      const nVals = rotOffsets.map((o) => o.x * primary.n.x + o.y * primary.n.y);
      const tVals = rotOffsets.map((o) => o.x * primary.u.x + o.y * primary.u.y);
      primary.onLeft = onLeft;
      primary.tMin = Math.min(...tVals);
      primary.tMax = Math.max(...tVals);
      primary.faceOffset = onLeft ? left : right;
      primary.idealDNorm = onLeft
        ? primary.faceOffset + wallOff - Math.min(...nVals)
        : primary.faceOffset - wallOff - Math.max(...nVals);
      primary.deltaSigned = primary.idealDNorm - dNorm;
    }

    // Check for a secondary non-parallel intersecting wall (Room Corner Snap)
    let cornerCand: WallSnapCandidate | null = null;
    for (const c of wallCands) {
      if (c.key === primary.key || c.absDelta > wallTol) continue;
      const cross = Math.abs(primary.n.x * c.n.y - primary.n.y * c.n.x);
      if (cross > 0.35) {
        cornerCand = c;
        break;
      }
    }

    if (cornerCand) {
      const n1 = primary.n;
      const n2 = cornerCand.n;
      const c1 = n1.x * primary.wall.start.x + n1.y * primary.wall.start.y + primary.idealDNorm;
      const c2 = n2.x * cornerCand.wall.start.x + n2.y * cornerCand.wall.start.y + cornerCand.idealDNorm;
      const det = n1.x * n2.y - n1.y * n2.x;
      if (Math.abs(det) > 0.2) {
        const solvedX = (c1 * n2.y - c2 * n1.y) / det;
        const solvedY = (n1.x * c2 - n2.x * c1) / det;
        if (Math.hypot(solvedX - curPos.x, solvedY - curPos.y) <= wallTol * 2.1) {
          curPos = { x: solvedX, y: solvedY };
          wallLockedX = true;
          wallLockedY = true;
          snappedKind = 'vertex';
          snapLabel = 'Corner Flush';
          activeWallSnapKey = `${primary.key}+${cornerCand.key}`;

          for (const wc of [primary, cornerCand]) {
            const s = (curPos.x - wc.wall.start.x) * wc.u.x + (curPos.y - wc.wall.start.y) * wc.u.y;
            const s1 = Math.max(0, Math.min(wc.wallLen, s + wc.tMin));
            const s2 = Math.max(0, Math.min(wc.wallLen, s + wc.tMax));
            guides.push({
              axis: Math.abs(wc.u.x) > Math.abs(wc.u.y) ? 'y' : 'x',
              from: {
                x: wc.wall.start.x + wc.u.x * s1 + wc.n.x * wc.faceOffset,
                y: wc.wall.start.y + wc.u.y * s1 + wc.n.y * wc.faceOffset,
              },
              to: {
                x: wc.wall.start.x + wc.u.x * s2 + wc.n.x * wc.faceOffset,
                y: wc.wall.start.y + wc.u.y * s2 + wc.n.y * wc.faceOffset,
              },
              label: 'CORNER',
            });
          }
        }
      }
    }

    if (!wallLockedX && !wallLockedY) {
      curPos = {
        x: curPos.x + primary.n.x * primary.deltaSigned,
        y: curPos.y + primary.n.y * primary.deltaSigned,
      };
      if (Math.abs(primary.n.x) > 0.85) wallLockedX = true;
      if (Math.abs(primary.n.y) > 0.85) wallLockedY = true;
      if (!wallLockedX && !wallLockedY) {
        wallLockedX = true;
        wallLockedY = true;
      }
      snappedKind = 'wall';
      snapLabel = mountingType === 'wall' ? 'Wall Mounted' : 'Wall Flush';
      const s = (curPos.x - primary.wall.start.x) * primary.u.x + (curPos.y - primary.wall.start.y) * primary.u.y;
      const s1 = Math.max(0, Math.min(primary.wallLen, s + primary.tMin));
      const s2 = Math.max(0, Math.min(primary.wallLen, s + primary.tMax));
      const segFrom = {
        x: primary.wall.start.x + primary.u.x * s1 + primary.n.x * primary.faceOffset,
        y: primary.wall.start.y + primary.u.y * s1 + primary.n.y * primary.faceOffset,
      };
      const segTo = {
        x: primary.wall.start.x + primary.u.x * s2 + primary.n.x * primary.faceOffset,
        y: primary.wall.start.y + primary.u.y * s2 + primary.n.y * primary.faceOffset,
      };
      guides.push({
        axis: Math.abs(primary.u.x) > Math.abs(primary.u.y) ? 'y' : 'x',
        from: segFrom,
        to: segTo,
        label: mountingType === 'wall' ? 'WALL MOUNTED' : 'WALL FLUSH',
      });
      if (mountingType === 'wall') {
        attachedWallId = primary.wall.id;
        attachedFace = primary.onLeft ? 'left' : 'right';
        attachedT = Math.max(0.01, Math.min(0.99, s / Math.max(1, primary.wallLen)));
        wallAttachmentPreview = {
          kind: 'wall',
          label: 'Wall Mounted',
          wallId: attachedWallId,
          wallFace: attachedFace,
          wallT: attachedT,
          wallSegment: { from: segFrom, to: segTo },
        };
      }
    } else if (mountingType === 'wall') {
      const s = (curPos.x - primary.wall.start.x) * primary.u.x + (curPos.y - primary.wall.start.y) * primary.u.y;
      const s1 = Math.max(0, Math.min(primary.wallLen, s + primary.tMin));
      const s2 = Math.max(0, Math.min(primary.wallLen, s + primary.tMax));
      attachedWallId = primary.wall.id;
      attachedFace = primary.onLeft ? 'left' : 'right';
      attachedT = Math.max(0.01, Math.min(0.99, s / Math.max(1, primary.wallLen)));
      wallAttachmentPreview = {
        kind: 'wall',
        label: 'Wall Mounted (Corner)',
        wallId: attachedWallId,
        wallFace: attachedFace,
        wallT: attachedT,
        wallSegment: {
          from: {
            x: primary.wall.start.x + primary.u.x * s1 + primary.n.x * primary.faceOffset,
            y: primary.wall.start.y + primary.u.y * s1 + primary.n.y * primary.faceOffset,
          },
          to: {
            x: primary.wall.start.x + primary.u.x * s2 + primary.n.x * primary.faceOffset,
            y: primary.wall.start.y + primary.u.y * s2 + primary.n.y * primary.faceOffset,
          },
        },
      };
    }
  } else {
    nextHyst.wallKey = undefined;
  }

  // --- 2. Adjacent Furniture Flush Contact & Center / Edge Alignment ---
  const selfBox = computeFurnitureWorldBox(curPos, { ...furn, rotationDeg: curRot });
  const visibleOtherFurn = otherFurniture.filter((o) => o.id !== furn.id && o.visible !== false);
  const otherBoxes = visibleOtherFurn.map((o) => ({
    item: o,
    box: computeFurnitureWorldBox({ x: o.xMm, y: o.yMm }, o),
  }));
  const selfIsSeating = isSeatingItem(furn);

  let lockedX = wallLockedX;
  let lockedY = wallLockedY;

  type FlushCandidate = { delta: number; dist: number; guide: AlignmentGuide; name: string };
  const flushXCands: Array<{ key: string; dist: number; data: FlushCandidate }> = [];
  const flushYCands: Array<{ key: string; dist: number; data: FlushCandidate }> = [];

  for (const { item: otherItem, box: ob } of otherBoxes) {
    if (selfBox.isOverlay || ob.isOverlay || isCurtainOrBlindFurniture(otherItem)) continue;
    if (
      selfIsSeating &&
      (otherItem.category === 'Tables & Desks' ||
        SUPPORTING_SURFACE_IDS.has(otherItem.templateId) ||
        computeFurnitureCanopyUndersideZMm(otherItem) !== null)
    ) {
      continue;
    }
    const zOverlap = selfBox.minZ < ob.maxZ - 20 && selfBox.maxZ > ob.minZ + 20;
    if (!zOverlap) continue;

    const yOverlap = Math.min(selfBox.maxY, ob.maxY) - Math.max(selfBox.minY, ob.minY);
    const yNear = yOverlap >= -220;
    if (!lockedX && yNear) {
      const candidates = [
        { tag: 'R', delta: ob.maxX - selfBox.minX, seamX: ob.maxX },
        { tag: 'L', delta: ob.minX - selfBox.maxX, seamX: ob.minX },
      ];
      for (const c of candidates) {
        const d = Math.abs(c.delta);
        if (d <= furnTol * 1.45) {
          const y1 = Math.min(selfBox.minY, ob.minY);
          const y2 = Math.max(selfBox.maxY, ob.maxY);
          flushXCands.push({
            key: `flushX_${ob.id}_${c.tag}`,
            dist: d,
            data: {
              delta: c.delta,
              dist: d,
              name: ob.name,
              guide: {
                axis: 'x',
                from: { x: c.seamX, y: y1 },
                to: { x: c.seamX, y: y2 },
                coordMm: c.seamX,
                label: 'FLUSH',
              },
            },
          });
        }
      }
    }

    const xOverlap = Math.min(selfBox.maxX, ob.maxX) - Math.max(selfBox.minX, ob.minX);
    const xNear = xOverlap >= -220;
    if (!lockedY && xNear) {
      const candidates = [
        { tag: 'B', delta: ob.maxY - selfBox.minY, seamY: ob.maxY },
        { tag: 'T', delta: ob.minY - selfBox.maxY, seamY: ob.minY },
      ];
      for (const c of candidates) {
        const d = Math.abs(c.delta);
        if (d <= furnTol * 1.45) {
          const x1 = Math.min(selfBox.minX, ob.minX);
          const x2 = Math.max(selfBox.maxX, ob.maxX);
          flushYCands.push({
            key: `flushY_${ob.id}_${c.tag}`,
            dist: d,
            data: {
              delta: c.delta,
              dist: d,
              name: ob.name,
              guide: {
                axis: 'y',
                from: { x: x1, y: c.seamY },
                to: { x: x2, y: c.seamY },
                coordMm: c.seamY,
                label: 'FLUSH',
              },
            },
          });
        }
      }
    }
  }

  const pickedFlushX = !lockedX
    ? pickWithSnapHysteresis(flushXCands, nextHyst.furnFlushXKey, furnTol)
    : null;
  const pickedFlushY = !lockedY
    ? pickWithSnapHysteresis(flushYCands, nextHyst.furnFlushYKey, furnTol)
    : null;

  nextHyst.furnFlushXKey = pickedFlushX?.key;
  nextHyst.furnFlushYKey = pickedFlushY?.key;

  if (pickedFlushX && !lockedX) {
    curPos.x += pickedFlushX.data.delta;
    lockedX = true;
    guides.push(pickedFlushX.data.guide);
    if (snappedKind === 'none') snappedKind = 'align';
    snapLabel = snapLabel
      ? `${snapLabel} · Flush w/ ${pickedFlushX.data.name}`
      : `Flush w/ ${pickedFlushX.data.name}`;
  }
  if (pickedFlushY && !lockedY) {
    curPos.y += pickedFlushY.data.delta;
    lockedY = true;
    guides.push(pickedFlushY.data.guide);
    if (snappedKind === 'none') snappedKind = 'align';
    snapLabel = snapLabel
      ? `${snapLabel} · Flush w/ ${pickedFlushY.data.name}`
      : `Flush w/ ${pickedFlushY.data.name}`;
  }

  // Edge & Center Alignment on any remaining free axes
  const updatedSelf = computeFurnitureWorldBox(curPos, { ...furn, rotationDeg: curRot });
  type AlignCand = { delta: number; guide: AlignmentGuide; text: string };
  const alignXCands: Array<{ key: string; dist: number; data: AlignCand }> = [];
  const alignYCands: Array<{ key: string; dist: number; data: AlignCand }> = [];

  for (const { box: ob } of otherBoxes) {
    if (!lockedX) {
      const xSpecs: Array<{ delta: number; coord: number; text: string }> = [
        { delta: ob.cx - updatedSelf.cx, coord: ob.cx, text: 'CENTER' },
        { delta: ob.minX - updatedSelf.minX, coord: ob.minX, text: 'ALIGN' },
        { delta: ob.maxX - updatedSelf.maxX, coord: ob.maxX, text: 'ALIGN' },
      ];
      for (const s of xSpecs) {
        const d = Math.abs(s.delta);
        const priorityBias = s.text === 'CENTER' ? 0 : 6;
        if (d + priorityBias <= alignTol * 1.45) {
          alignXCands.push({
            key: `ax_${ob.id}_${s.text}_${Math.round(s.coord)}`,
            dist: d + priorityBias,
            data: {
              delta: s.delta,
              text: s.text,
              guide: {
                axis: 'x',
                from: { x: s.coord, y: updatedSelf.cy },
                to: { x: s.coord, y: ob.cy },
                coordMm: s.coord,
                label: s.text,
              },
            },
          });
        }
      }
    }

    if (!lockedY) {
      const ySpecs: Array<{ delta: number; coord: number; text: string }> = [
        { delta: ob.cy - updatedSelf.cy, coord: ob.cy, text: 'CENTER' },
        { delta: ob.minY - updatedSelf.minY, coord: ob.minY, text: 'ALIGN' },
        { delta: ob.maxY - updatedSelf.maxY, coord: ob.maxY, text: 'ALIGN' },
      ];
      for (const s of ySpecs) {
        const d = Math.abs(s.delta);
        const priorityBias = s.text === 'CENTER' ? 0 : 6;
        if (d + priorityBias <= alignTol * 1.45) {
          alignYCands.push({
            key: `ay_${ob.id}_${s.text}_${Math.round(s.coord)}`,
            dist: d + priorityBias,
            data: {
              delta: s.delta,
              text: s.text,
              guide: {
                axis: 'y',
                from: { x: updatedSelf.cx, y: s.coord },
                to: { x: ob.cx, y: s.coord },
                coordMm: s.coord,
                label: s.text,
              },
            },
          });
        }
      }
    }
  }

  // --- 2b. Geometric Room-Center Snapping ---
  let roomCenterSnap: FurnitureSnapResult['roomCenterSnap'] | undefined;
  const rooms = options.rooms ?? [];
  if (
    !wallLockedX &&
    !wallLockedY &&
    !isCurtain &&
    mountingType !== 'wall' &&
    rooms.length > 0
  ) {
    const tid = furn.templateId || '';
    const isStrongCenterItem =
      isCeilingFixture(furn) ||
      isRugFurniture(furn) ||
      furn.category === 'Tables & Desks' ||
      tid === 'kitchen_island';
    const roomCenterTol = isStrongCenterItem
      ? (options.strongRoomCenterTolMm ?? 180)
      : furn.surfaceHostId || mountingType === 'surface'
        ? (options.surfaceRoomCenterTolMm ?? 85)
        : (options.roomCenterTolMm ?? 120);

    const rcCands: Array<{
      key: string;
      dist: number;
      data: { roomId: string; roomName: string; center: Point2D };
    }> = [];

    for (const r of rooms) {
      if (r.visible === false || r.polygon.length < 3) continue;
      const center = computeRoomGeometricCenter(r);
      const d = dist(targetPos, center);
      if (d <= roomCenterTol * 1.45) {
        rcCands.push({
          key: `room_${r.id}`,
          dist: d,
          data: {
            roomId: r.id,
            roomName: r.name || 'Room',
            center,
          },
        });
      }
    }

    const pickedRc = pickWithSnapHysteresis(rcCands, nextHyst.roomCenterKey, roomCenterTol);
    nextHyst.roomCenterKey = pickedRc?.key;

    if (pickedRc) {
      const bestRoomCenter = pickedRc.data;
      curPos = { x: bestRoomCenter.center.x, y: bestRoomCenter.center.y };
      lockedX = true;
      lockedY = true;
      snappedKind = 'align';
      snapLabel = 'Room center';
      roomCenterSnap = {
        roomId: bestRoomCenter.roomId,
        roomName: bestRoomCenter.roomName,
        center: bestRoomCenter.center,
      };
      const crossHalf = 360;
      guides.push(
        {
          axis: 'x',
          from: { x: bestRoomCenter.center.x, y: bestRoomCenter.center.y - crossHalf },
          to: { x: bestRoomCenter.center.x, y: bestRoomCenter.center.y + crossHalf },
          coordMm: bestRoomCenter.center.x,
          label: 'ROOM CENTER',
        },
        {
          axis: 'y',
          from: { x: bestRoomCenter.center.x - crossHalf, y: bestRoomCenter.center.y },
          to: { x: bestRoomCenter.center.x + crossHalf, y: bestRoomCenter.center.y },
          coordMm: bestRoomCenter.center.y,
          label: 'ROOM CENTER',
        }
      );
    }
  } else {
    nextHyst.roomCenterKey = undefined;
  }

  let pickedAlignX: { key: string; dist: number; data: AlignCand } | null = null;
  let pickedAlignY: { key: string; dist: number; data: AlignCand } | null = null;

  if (!roomCenterSnap) {
    pickedAlignX = !lockedX
      ? pickWithSnapHysteresis(alignXCands, nextHyst.alignXKey, alignTol)
      : null;
    pickedAlignY = !lockedY
      ? pickWithSnapHysteresis(alignYCands, nextHyst.alignYKey, alignTol)
      : null;
    nextHyst.alignXKey = pickedAlignX?.key;
    nextHyst.alignYKey = pickedAlignY?.key;

    if (pickedAlignX && !lockedX) {
      curPos.x += pickedAlignX.data.delta;
      lockedX = true;
      guides.push(pickedAlignX.data.guide);
      if (snappedKind === 'none') snappedKind = 'align';
      if (!snapLabel) snapLabel = pickedAlignX.data.text === 'CENTER' ? 'Align Center' : 'Align Edge';
    }
    if (pickedAlignY && !lockedY) {
      curPos.y += pickedAlignY.data.delta;
      lockedY = true;
      guides.push(pickedAlignY.data.guide);
      if (snappedKind === 'none') snappedKind = 'align';
      if (!snapLabel) snapLabel = pickedAlignY.data.text === 'CENTER' ? 'Align Center' : 'Align Edge';
    }
  } else {
    nextHyst.alignXKey = undefined;
    nextHyst.alignYKey = undefined;
  }

  // --- 3. Grid Snap Fallback on Remaining Unlocked Axes ---
  const g = Math.max(10, options.gridSizeMm || 50);
  if (!lockedX) {
    curPos.x = Math.round(curPos.x / g) * g;
    if (snappedKind === 'none') snappedKind = 'grid';
  }
  if (!lockedY) {
    curPos.y = Math.round(curPos.y / g) * g;
    if (snappedKind === 'none') snappedKind = 'grid';
  }

  const resolvedSnapKey = roomCenterSnap
    ? nextHyst.roomCenterKey
    : activeWallSnapKey
      ? `${activeWallSnapKey}|${pickedFlushX?.key ?? ''}|${pickedFlushY?.key ?? ''}`
      : pickedFlushX || pickedFlushY || pickedAlignX || pickedAlignY
        ? `align|${pickedFlushX?.key ?? ''}|${pickedFlushY?.key ?? ''}|${pickedAlignX?.key ?? ''}|${pickedAlignY?.key ?? ''}`
        : undefined;

  return {
    xMm: Math.round(curPos.x),
    yMm: Math.round(curPos.y),
    rotationDeg: curRot,
    snappedKind,
    snapLabel,
    snapKey: resolvedSnapKey,
    hysteresis: nextHyst,
    guides,
    attachedWallId,
    attachedFace,
    attachedT,
    attachmentPreview: wallAttachmentPreview,
    roomCenterSnap,
  };
}

// ============================================================================
// CEILING LIGHT UNDERSIDE MOUNTING & ELEVATION HELPERS
// ============================================================================

export function isCeilingFixture(
  f: Pick<FurnitureInstance, 'templateId' | 'category' | 'parts'> &
    Partial<Pick<FurnitureInstance, 'mountingType' | 'attachedWallId' | 'surfaceHostId' | 'elevationMm'>>
): boolean {
  return resolveFurnitureMountingType(f) === 'ceiling';
}

export function getEnclosingRoomCeilingMm(
  pos: Point2D,
  rooms: Room[],
  levelCeilingMm: number
): number {
  let bestArea = Infinity;
  let bestCeiling = levelCeilingMm || 2800;
  for (const r of rooms) {
    if (r.visible === false || r.polygon.length < 3) continue;
    if (pointInPolygon(pos, r.polygon)) {
      const area = r.areaM2 > 0 ? r.areaM2 : Math.abs(computePolygonAreaM2(r.polygon));
      if (area < bestArea) {
        bestArea = area;
        bestCeiling = r.ceilingHeightMm || levelCeilingMm || 2800;
      }
    }
  }
  return bestCeiling;
}

export function isAcIndoorUnit(
  f: Pick<FurnitureInstance, 'templateId' | 'parts'>
): boolean {
  const tid = f.templateId || '';
  return tid === 'ac_european_indoor' || f.parts.some((p) => p.detailStyle === 'ac_indoor');
}

export function isCurtainOrBlindFurniture(
  f: Pick<FurnitureInstance, 'templateId' | 'parts'>
): boolean {
  const tid = f.templateId || '';
  return (
    tid.startsWith('curtain_') ||
    tid.startsWith('blinds_') ||
    f.parts.some(
      (p) =>
        p.detailStyle === 'curtain_pleat' ||
        p.detailStyle === 'blinds_slats' ||
        p.detailStyle === 'roller_blind'
    )
  );
}

/**
 * Returns the vertical translation offset (mm) needed so a ceiling-mounted
 * fixture sits 1 mm below the ceiling, or a European split AC indoor unit sits
 * automatically 5 cm (50 mm) below the room's ceiling height.
 */
export function getCeilingFixtureOffsetMm(
  f: Pick<FurnitureInstance, 'templateId' | 'category' | 'parts' | 'elevationMm'> &
    Partial<
      Pick<
        FurnitureInstance,
        | 'mountingType'
        | 'attachedWallId'
        | 'surfaceHostId'
        | 'rotationXDeg'
        | 'rotationYDeg'
        | 'mirroredX'
        | 'mirroredY'
      >
    >,
  effectiveCeilingMm: number
): number {
  return getFurniturePlacement(
    { ...f, rotationDeg: 0 },
    { effectiveCeilingMm }
  ).groupElevationMm;
}

export function computeFurnitureElevationSpanMm(
  f: Pick<FurnitureInstance, 'templateId' | 'category' | 'parts' | 'elevationMm'> &
    Partial<
      Pick<
        FurnitureInstance,
        | 'rotationXDeg'
        | 'rotationYDeg'
        | 'mirroredX'
        | 'mirroredY'
        | 'mountingType'
        | 'attachedWallId'
        | 'surfaceHostId'
      >
    >,
  effectiveCeilingMm?: number
): { minZ: number; maxZ: number } {
  return getFurniturePlacement(
    { ...f, rotationDeg: 0 },
    { effectiveCeilingMm }
  ).elevationSpanMm;
}

// ============================================================================
// ROOM & LEVEL CEILING HEIGHT <-> PERIMETER WALL HEIGHT SYNCHRONIZATION
// ============================================================================

export function findRoomPerimeterWallIds(
  room: Pick<Room, 'polygon'>,
  walls: Wall[],
  tolMm = 260
): Set<string> {
  const matched = new Set<string>();
  const poly = room.polygon;
  if (poly.length < 3) return matched;

  for (const w of walls) {
    if (w.visible === false) continue;
    const len = getWallArcLength(w);
    if (len < 10) continue;

    // Sample wall centerline & inner/outer faces at 25%, 50%, 75%
    const { left, right } = wallOffsets(w.thicknessMm, w.alignment);
    const faceOffsets = [left, 0, right];
    let edgeHits = 0;

    for (const t of [0.25, 0.5, 0.75]) {
      const { point, normal } = getWallCenterlinePoint(w, t);
      let sampleNearBoundary = false;
      for (const off of faceOffsets) {
        const probe = { x: point.x + normal.x * off, y: point.y + normal.y * off };
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i];
          const b = poly[(i + 1) % poly.length];
          if (projectPointOnSegment(probe, a, b).distance <= Math.max(tolMm, w.thicknessMm * 0.75)) {
            sampleNearBoundary = true;
            break;
          }
        }
        if (sampleNearBoundary) break;
      }
      if (sampleNearBoundary) edgeHits++;
    }

    if (edgeHits >= 2) {
      matched.add(w.id);
    }
  }
  return matched;
}

export function syncRoomCeilingHeight(
  lvl: Level,
  roomId: string,
  nextCeilingMm: number
): Level {
  const clamped = Math.max(1800, Math.min(8000, Math.round(nextCeilingMm)));
  const targetRoom = lvl.rooms.find((r) => r.id === roomId);
  if (!targetRoom) return lvl;

  const prevDefault = lvl.ceilingHeightMm;
  const perimeterWallIds = findRoomPerimeterWallIds(targetRoom, lvl.walls);

  // Also keep any arch elements (e.g., chimneys, columns) connected to ceiling inside room synced
  const updatedWalls = lvl.walls.map((w) => {
    if (!perimeterWallIds.has(w.id) || w.locked) return w;
    return { ...w, heightMm: clamped };
  });

  const updatedArch = lvl.archElements.map((a) => {
    if (!a.connectToCeiling || a.locked) return a;
    if (a.attachedWallId && perimeterWallIds.has(a.attachedWallId)) {
      return { ...a, heightMm: clamped };
    }
    if (pointInPolygon({ x: a.xMm, y: a.yMm }, targetRoom.polygon)) {
      return { ...a, heightMm: clamped };
    }
    return a;
  });

  const updatedRooms = lvl.rooms.map((r) =>
    r.id === roomId ? { ...r, ceilingHeightMm: clamped } : r
  );

  // Sync level default if all rooms match or if this room previously matched level default
  const allMatchTarget = updatedRooms.every((r) => r.ceilingHeightMm === clamped);
  const matchedOldDefault = Math.abs(targetRoom.ceilingHeightMm - prevDefault) <= 1;

  return {
    ...lvl,
    ceilingHeightMm: allMatchTarget || matchedOldDefault ? clamped : prevDefault,
    rooms: updatedRooms,
    walls: updatedWalls,
    archElements: updatedArch,
  };
}

export function syncLevelCeilingHeight(lvl: Level, nextCeilingMm: number): Level {
  const clamped = Math.max(1800, Math.min(8000, Math.round(nextCeilingMm)));
  const prevDefault = lvl.ceilingHeightMm;

  const updatedRooms = lvl.rooms.map((r) =>
    r.locked
      ? r
      : Math.abs(r.ceilingHeightMm - prevDefault) <= 1 || !r.ceilingHeightMm
        ? { ...r, ceilingHeightMm: clamped }
        : r
  );

  const updatedWalls = lvl.walls.map((w) =>
    w.locked
      ? w
      : Math.abs(w.heightMm - prevDefault) <= 1
        ? { ...w, heightMm: clamped }
        : w
  );

  const updatedArch = lvl.archElements.map((a) =>
    a.locked || !a.connectToCeiling
      ? a
      : Math.abs(a.heightMm - prevDefault) <= 1
        ? { ...a, heightMm: clamped }
        : a
  );

  return {
    ...lvl,
    ceilingHeightMm: clamped,
    rooms: updatedRooms,
    walls: updatedWalls,
    archElements: updatedArch,
  };
}

// ============================================================================
// DETERMINISTIC CHIMNEY 4-FACE COLORS
// ============================================================================

const CHIMNEY_FACE_PALETTES: Array<{ front: string; back: string; left: string; right: string }> = [
  { front: '#E07A5F', back: '#3D405B', left: '#81B29A', right: '#F2CC8F' },
  { front: '#2A9D8F', back: '#264653', left: '#E9C46A', right: '#E76F51' },
  { front: '#457B9D', back: '#1D3557', left: '#A8DADC', right: '#E63946' },
  { front: '#6D597A', back: '#355070', left: '#B56576', right: '#EAAC8B' },
  { front: '#588157', back: '#344E41', left: '#A3B18A', right: '#DDA15E' },
  { front: '#BC6C25', back: '#283618', left: '#DDA15E', right: '#606C38' },
];

export function getDefaultChimneyFaceColors(seed: string): {
  front: string;
  back: string;
  left: string;
  right: string;
} {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const palette = CHIMNEY_FACE_PALETTES[hash % CHIMNEY_FACE_PALETTES.length];
  return { ...palette };
}

export function resolveChimneyFaceColors(
  el: Pick<ArchElement, 'id' | 'faceColors'>
): { front: string; back: string; left: string; right: string } {
  const defaults = getDefaultChimneyFaceColors(el.id);
  return {
    front: el.faceColors?.front || defaults.front,
    back: el.faceColors?.back || defaults.back,
    left: el.faceColors?.left || defaults.left,
    right: el.faceColors?.right || defaults.right,
  };
}

// ============================================================================
// 2D FURNITURE Z-ORDER (VISUAL STACKING ONLY)
// ============================================================================

export function isRugFurniture(
  f: Pick<FurnitureInstance, 'templateId' | 'parts'>
): boolean {
  if (f.templateId?.startsWith('rug_')) return true;
  if (
    f.parts.length > 0 &&
    f.parts.every((p) => p.detailStyle === 'rug' || p.detailStyle === 'fringe_rug')
  ) {
    return true;
  }
  return false;
}

export function getEffectiveFurnitureZOrder(
  f: Pick<FurnitureInstance, 'templateId' | 'parts' | 'zOrder'>,
  _fallbackIndex = 0
): number {
  if (typeof f.zOrder === 'number' && Number.isFinite(f.zOrder)) {
    return f.zOrder;
  }
  return isRugFurniture(f) ? -1 : 0;
}

export function sortFurnitureByZOrder<T extends Pick<FurnitureInstance, 'templateId' | 'parts' | 'zOrder'>>(
  items: T[]
): T[] {
  return items
    .map((item, idx) => ({ item, idx, z: getEffectiveFurnitureZOrder(item, idx) }))
    .sort((a, b) => (a.z !== b.z ? a.z - b.z : a.idx - b.idx))
    .map((entry) => entry.item);
}

export type ZOrderAction =
  | 'bring_forward'
  | 'send_backward'
  | 'bring_to_front'
  | 'send_to_back'
  | 'forward'
  | 'backward'
  | 'front'
  | 'back';

function buildLocalFurnitureOverlapComponents(
  furniture: FurnitureInstance[],
  minOverlapDepthMm = 2
): number[][] {
  const n = furniture.length;
  if (n === 0) return [];

  const cached = furniture.map((f) => {
    const corners = getFurnitureOrientedCorners({ x: f.xMm, y: f.yMm }, f);
    const aabb = getBoundsArea2D(corners);
    const prims = getFurnitureSolidFootprintPrimitives({ x: f.xMm, y: f.yMm }, f);
    return { corners, aabb, prims };
  });

  const adj: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    const a = cached[i];
    for (let j = i + 1; j < n; j++) {
      const b = cached[j];
      if (
        doFurnitureFootprintsOverlap2D(
          a.corners,
          a.aabb,
          a.prims,
          b.corners,
          b.aabb,
          b.prims,
          minOverlapDepthMm
        )
      ) {
        adj[i].push(j);
        adj[j].push(i);
      }
    }
  }

  const visited = new Uint8Array(n);
  const components: number[][] = [];
  for (let i = 0; i < n; i++) {
    if (visited[i]) continue;
    const comp: number[] = [];
    const queue = [i];
    visited[i] = 1;
    while (queue.length > 0) {
      const cur = queue.pop()!;
      comp.push(cur);
      for (const nxt of adj[cur]) {
        if (!visited[nxt]) {
          visited[nxt] = 1;
          queue.push(nxt);
        }
      }
    }
    components.push(comp);
  }
  return components;
}

function assignLocalComponentRanks(
  orderedItems: FurnitureInstance[],
  rankMap: Map<string, number>
): void {
  if (orderedItems.length === 0) return;
  if (orderedItems.length === 1) {
    const only = orderedItems[0];
    rankMap.set(only.id, isRugFurniture(only) ? -1 : 0);
    return;
  }
  const firstNonRugIdx = orderedItems.findIndex((f) => !isRugFurniture(f));
  if (firstNonRugIdx === -1) {
    for (let i = 0; i < orderedItems.length; i++) {
      rankMap.set(orderedItems[i].id, i - orderedItems.length);
    }
    return;
  }
  for (let i = 0; i < orderedItems.length; i++) {
    rankMap.set(orderedItems[i].id, i - firstNonRugIdx);
  }
}

/**
 * Normalizes `zOrder` strictly per 2D overlapping stack cluster so standalone items remain `0`
 * (or `-1` for rugs) and overlapping stacks use compact local integers (`0, 1, 2...`),
 * preventing global index inflation across large plans.
 */
export function normalizeFurnitureLocalZOrders(
  furniture: FurnitureInstance[]
): FurnitureInstance[] {
  if (furniture.length === 0) return furniture;
  const components = buildLocalFurnitureOverlapComponents(furniture, 2);
  const rankMap = new Map<string, number>();

  for (const comp of components) {
    const ordered = comp
      .map((origIdx) => ({
        item: furniture[origIdx],
        origIdx,
        z: getEffectiveFurnitureZOrder(furniture[origIdx], origIdx),
      }))
      .sort((a, b) => (a.z !== b.z ? a.z - b.z : a.origIdx - b.origIdx))
      .map((e) => e.item);
    assignLocalComponentRanks(ordered, rankMap);
  }

  return furniture.map((f) => ({
    ...f,
    zOrder: rankMap.get(f.id) ?? (isRugFurniture(f) ? -1 : 0),
  }));
}

/**
 * Computes a compact local `zOrder` for an item placed or moved against existing furniture,
 * scoping increments strictly to locally overlapping footprints.
 */
export function computeLocalStackPlacementZOrder(
  candidate: FurnitureInstance,
  existingFurniture: FurnitureInstance[],
  minAboveHostId?: string
): number {
  const isRug = isRugFurniture(candidate);
  const cornersA = getFurnitureOrientedCorners({ x: candidate.xMm, y: candidate.yMm }, candidate);
  const aabbA = getBoundsArea2D(cornersA);
  const primsA = getFurnitureSolidFootprintPrimitives({ x: candidate.xMm, y: candidate.yMm }, candidate);

  const overlapping: FurnitureInstance[] = [];
  for (const other of existingFurniture) {
    if (other.id === candidate.id || other.visible === false) continue;
    const cornersB = getFurnitureOrientedCorners({ x: other.xMm, y: other.yMm }, other);
    const aabbB = getBoundsArea2D(cornersB);
    const primsB = getFurnitureSolidFootprintPrimitives({ x: other.xMm, y: other.yMm }, other);
    if (doFurnitureFootprintsOverlap2D(cornersA, aabbA, primsA, cornersB, aabbB, primsB, 2)) {
      overlapping.push(other);
    }
  }

  if (isRug) {
    const rugZs = overlapping
      .filter((o) => isRugFurniture(o))
      .map((o) => getEffectiveFurnitureZOrder(o, 0));
    return rugZs.length > 0 ? Math.min(-1, Math.min(...rugZs) - 1) : -1;
  }

  const nonRugZs = overlapping
    .filter((o) => !isRugFurniture(o))
    .map((o) => getEffectiveFurnitureZOrder(o, 0));
  let minRequired = 0;
  if (minAboveHostId) {
    const host = existingFurniture.find((o) => o.id === minAboveHostId);
    if (host) {
      minRequired = Math.max(minRequired, getEffectiveFurnitureZOrder(host, 0) + 1);
    }
  }
  if (nonRugZs.length === 0) return minRequired;
  return Math.max(minRequired, Math.max(...nonRugZs) + 1);
}

export function reorderFurnitureZOrder(
  furniture: FurnitureInstance[],
  targets: Set<string> | string[],
  action: ZOrderAction
): FurnitureInstance[] {
  const targetIds = targets instanceof Set ? targets : new Set(targets);
  if (furniture.length === 0 || targetIds.size === 0) return furniture;

  const components = buildLocalFurnitureOverlapComponents(furniture, 2);
  const rankMap = new Map<string, number>();

  for (const comp of components) {
    const ordered = comp
      .map((origIdx) => ({
        item: furniture[origIdx],
        origIdx,
        z: getEffectiveFurnitureZOrder(furniture[origIdx], origIdx),
      }))
      .sort((a, b) => (a.z !== b.z ? a.z - b.z : a.origIdx - b.origIdx))
      .map((e) => e.item);

    const hasTarget = ordered.some((f) => targetIds.has(f.id));
    if (!hasTarget || ordered.length <= 1) {
      assignLocalComponentRanks(ordered, rankMap);
      continue;
    }

    let nextOrder: FurnitureInstance[];
    if (action === 'bring_to_front' || action === 'front') {
      const rest = ordered.filter((f) => !targetIds.has(f.id));
      const moved = ordered.filter((f) => targetIds.has(f.id));
      nextOrder = [...rest, ...moved];
    } else if (action === 'send_to_back' || action === 'back') {
      const moved = ordered.filter((f) => targetIds.has(f.id));
      const rest = ordered.filter((f) => !targetIds.has(f.id));
      nextOrder = [...moved, ...rest];
    } else {
      nextOrder = [...ordered];
      const len = nextOrder.length;
      if (action === 'bring_forward' || action === 'forward') {
        for (let i = len - 2; i >= 0; i--) {
          if (targetIds.has(nextOrder[i].id) && !targetIds.has(nextOrder[i + 1].id)) {
            const tmp = nextOrder[i];
            nextOrder[i] = nextOrder[i + 1];
            nextOrder[i + 1] = tmp;
          }
        }
      } else {
        // send_backward / backward
        for (let i = 1; i < len; i++) {
          if (targetIds.has(nextOrder[i].id) && !targetIds.has(nextOrder[i - 1].id)) {
            const tmp = nextOrder[i];
            nextOrder[i] = nextOrder[i - 1];
            nextOrder[i - 1] = tmp;
          }
        }
      }
    }

    assignLocalComponentRanks(nextOrder, rankMap);
  }

  return furniture.map((f) => ({
    ...f,
    zOrder: rankMap.get(f.id) ?? (isRugFurniture(f) ? -1 : 0),
  }));
}

// ============================================================================
// MULTI-SELECT COMMON PROPERTY RESOLUTION
// ============================================================================

export function getCommonValue<V>(values: V[]): { mixed: boolean; value: V };
export function getCommonValue<T, V>(
  items: T[],
  getter: (item: T) => V,
  eq?: (a: V, b: V) => boolean
): { mixed: boolean; value: V };
export function getCommonValue<T, V>(
  items: T[],
  getter?: (item: T) => V,
  eq: (a: V, b: V) => boolean = (a, b) => a === b
): { mixed: boolean; value: V } {
  const resolve = getter ?? ((x: T) => x as unknown as V);
  if (items.length === 0) return { mixed: true, value: undefined as unknown as V };
  const first = resolve(items[0]);
  for (let i = 1; i < items.length; i++) {
    if (!eq(first, resolve(items[i]))) {
      return { mixed: true, value: first };
    }
  }
  return { mixed: false, value: first };
}

// ============================================================================
// LOGICAL OVERLAP, SOLID COLLISION & SMOOTH WALL/OBSTACLE GLIDING
// ============================================================================

export type FurnitureRole =
  | 'rug'
  | 'ceiling'
  | 'tabletop_prop'
  | 'wall_mount'
  | 'supporting_surface'
  | 'solid';

const FIXED_SIZE_TEMPLATE_IDS = new Set([
  'decor_books_stack',
  'decor_books_row',
  'decor_vase_amphora',
  'decor_vase_bud',
  'decor_bowl_fruit',
  'decor_candle_tray',
  'decor_sculpture',
  'decor_books_vase_set',
  'plant_table_succulent',
  'appliance_espresso_machine',
  'appliance_drip_coffee',
  'appliance_kettle',
  'appliance_toaster',
  'appliance_stand_mixer',
  'kitchen_microwave_countertop',
]);

export function isFixedSizeFurniture(
  f: Pick<FurnitureInstance, 'templateId' | 'fixedSize'>
): boolean {
  if (typeof f.fixedSize === 'boolean') return f.fixedSize;
  const tid = f.templateId || '';
  if (tid.startsWith('decor_') && tid !== 'decor_gallery_triptych' && tid !== 'decor_coat_stand') {
    return true;
  }
  return FIXED_SIZE_TEMPLATE_IDS.has(tid);
}

export function isSeatingItem(
  f: Pick<FurnitureInstance, 'templateId' | 'category' | 'parts'>
): boolean {
  const tid = f.templateId || '';
  if (
    tid.startsWith('chair_') ||
    tid.startsWith('stool_') ||
    tid.startsWith('bench_') ||
    tid === 'ottoman_round' ||
    tid === 'armchair_lounge'
  ) {
    return true;
  }
  return (
    f.category === 'Sofas & Seating' &&
    !tid.startsWith('sofa_') &&
    f.parts.some((p) => p.detailStyle === 'chair_seat')
  );
}

export function isWallMountedTv(
  f: Pick<FurnitureInstance, 'templateId' | 'parts'> &
    Partial<Pick<FurnitureInstance, 'mountingType' | 'elevationMm' | 'surfaceHostId'>>
): boolean {
  const tid = f.templateId || '';
  if (tid.startsWith('tv_wall_') || f.parts.some((p) => p.detailStyle === 'wall_tv')) {
    return true;
  }
  return tid === 'tv_screen_stand' && f.mountingType === 'wall';
}

export function isTabletopProp(
  f: Pick<FurnitureInstance, 'templateId' | 'parts'>
): boolean {
  const tid = f.templateId || '';
  return (
    tid.startsWith('light_table_') ||
    tid === 'tv_screen_stand' ||
    tid === 'plant_table_succulent' ||
    tid.startsWith('decor_books') ||
    tid.startsWith('decor_vase') ||
    tid.startsWith('decor_bowl') ||
    tid === 'decor_candle_tray' ||
    tid === 'decor_sculpture' ||
    tid.startsWith('appliance_') ||
    tid === 'kitchen_microwave_countertop'
  );
}

export function isWallMountItem(
  f: Pick<FurnitureInstance, 'templateId' | 'parts' | 'elevationMm' | 'surfaceHostId'> &
    Partial<Pick<FurnitureInstance, 'category' | 'mountingType' | 'attachedWallId'>>
): boolean {
  return (
    resolveFurnitureMountingType({
      category: f.category ?? 'Decor & Plants',
      ...f,
    }) === 'wall'
  );
}

const ELECTRONICS_OR_APPLIANCE_RE =
  /\b(monitor|display|screen|tv|television|laptop|notebook|imac|macbook|desktop|computer|pc|keyboard|printer|scanner|speaker|soundbar|router|projector|toaster|kettle|espresso|coffee|microwave|blender|mixer|lamp)\b/i;

const INCOMPATIBLE_SURFACE_CHILD_NAME_RE =
  /\b(sofa|couch|sectional|settee|armchair|chair|stool|bench|ottoman|bed|mattress|wardrobe|closet|bookcase|bookshelf|sideboard|credenza|dresser|chest|drawer|pedestal|table|desk|counter|island|fridge|refrigerator|freezer|washer|dryer|dishwasher|oven|range|hood|toilet|bathtub|shower|vanity|sink|rug|carpet|floor lamp|standing lamp)\b/i;

export function isSurfaceMountable(
  f: Pick<FurnitureInstance, 'templateId' | 'parts'> &
    Partial<
      Pick<
        FurnitureInstance,
        | 'name'
        | 'category'
        | 'elevationMm'
        | 'surfaceHostId'
        | 'mountingType'
        | 'attachedWallId'
        | 'glbAssetId'
        | 'glbDataUrl'
      >
    >
): boolean {
  if (
    isRugFurniture(f) ||
    isCurtainOrBlindFurniture(f) ||
    isWallMountedTv(f)
  ) {
    return false;
  }

  const mType = resolveFurnitureMountingType({
    ...f,
    category: f.category ?? 'Decor & Plants',
    elevationMm: f.elevationMm ?? 0,
  });
  // Universal stacking applies to all freestanding ("Free") and surface ("Surface") items;
  // items labeled "floor", "ceiling", or "wall" retain their floor/ceiling/wall mounting behavior.
  return mType === 'freestanding' || mType === 'surface';
}

const SUPPORTING_SURFACE_IDS = new Set([
  'sideboard_fluted',
  'dresser_3drawer_wide',
  'dresser_4drawer',
  'dresser_6drawer_double',
  'dresser_tallboy',
  'tv_unit_media',
  'tv_unit_floating',
  'nightstand_oak',
  'bedside_fluted',
  'console_entryway',
  'vanity_makeup',
  'credenza_low_locker',
  'shoe_cabinet_slim',
  'kitchen_base_cabinet',
  'kitchen_island',
  'kitchen_dishwasher',
  'kitchen_dishwasher_freestanding',
  'kitchen_corner_base',
  'kitchen_coffee_bar',
  'kitchen_wine_cooler',
  'kitchen_washing_machine',
  'kitchen_dryer',
  'bath_washer',
  'bath_vanity',
  'bath_double_vanity',
  'outdoor_table',
  'outdoor_coffee_table',
]);

export function isSupportingSurfaceFurniture(
  f: Pick<FurnitureInstance, 'templateId' | 'category' | 'parts'> &
    Partial<
      Pick<
        FurnitureInstance,
        'name' | 'elevationMm' | 'mountingType' | 'attachedWallId' | 'glbAssetId' | 'glbDataUrl'
      >
    >
): boolean {
  const tid = f.templateId || '';
  if (
    isRugFurniture(f) ||
    isCurtainOrBlindFurniture(f) ||
    isCeilingFixture(f) ||
    isWallMountedTv(f)
  ) {
    return false;
  }
  const mType = resolveFurnitureMountingType({
    ...f,
    category: f.category ?? 'Decor & Plants',
    elevationMm: f.elevationMm ?? 0,
  });
  if (mType === 'ceiling') return false;
  if (mType === 'wall') {
    if (
      tid === 'tv_unit_floating' ||
      tid === 'bed_shelf_floating' ||
      tid === 'kitchen_wall_cabinet'
    ) {
      return true;
    }
    if (
      tid === 'wall_art' ||
      tid === 'decor_gallery_triptych' ||
      tid.startsWith('mirror_') ||
      tid.startsWith('light_sconce') ||
      tid.startsWith('radiator_') ||
      tid.startsWith('ac_') ||
      tid === 'bath_towel_warmer'
    ) {
      return false;
    }
    const b = computeFurnitureBoundsMm(f.parts);
    return b.depthMm >= 220 && b.widthMm >= 300;
  }
  return true;
}

export function isCompatibleSurfaceChild(
  child: Pick<FurnitureInstance, 'id' | 'templateId' | 'parts'> &
    Partial<
      Pick<
        FurnitureInstance,
        | 'name'
        | 'category'
        | 'elevationMm'
        | 'surfaceHostId'
        | 'mountingType'
        | 'attachedWallId'
        | 'glbAssetId'
        | 'glbDataUrl'
      >
    >,
  host: Pick<FurnitureInstance, 'id' | 'templateId' | 'category' | 'parts'> &
    Partial<
      Pick<
        FurnitureInstance,
        'name' | 'elevationMm' | 'mountingType' | 'attachedWallId' | 'glbAssetId' | 'glbDataUrl'
      >
    >
): boolean {
  if (child.id === host.id) return false;
  return isSurfaceMountable(child) && isSupportingSurfaceFurniture(host);
}

export function classifyFurnitureRole(
  f: Pick<FurnitureInstance, 'templateId' | 'category' | 'parts' | 'elevationMm' | 'surfaceHostId'> &
    Partial<Pick<FurnitureInstance, 'mountingType' | 'attachedWallId'>>
): FurnitureRole {
  if (isRugFurniture(f)) return 'rug';
  const mType = resolveFurnitureMountingType(f);
  if (mType === 'ceiling') return 'ceiling';
  if (mType === 'wall') return 'wall_mount';
  if (mType === 'surface' || isTabletopProp(f)) return 'tabletop_prop';
  if (isSupportingSurfaceFurniture(f)) return 'supporting_surface';
  return 'solid';
}

interface SupportingDeckPartCandidate {
  polys: Point2D[][];
  deckHeightMm: number;
  area: number;
}

const MAX_SURFACE_STACK_INTRUSION_MM = 120;

function getSupportingDeckPartCandidates(
  hostPos: Point2D,
  host: Pick<FurnitureInstance, 'templateId' | 'elevationMm' | 'parts'> &
    Partial<
      Pick<
        FurnitureInstance,
        'rotationDeg' | 'rotationXDeg' | 'rotationYDeg' | 'mirroredX' | 'mirroredY'
      >
    >
): SupportingDeckPartCandidate[] {
  const baseElev = host.elevationMm ?? 0;
  const parts = host.parts ?? [];
  if (parts.length === 0) {
    return [
      {
        polys: [
          getFurnitureOrientedCorners(hostPos, {
            parts,
            rotationDeg: host.rotationDeg ?? 0,
            rotationXDeg: host.rotationXDeg ?? 0,
            rotationYDeg: host.rotationYDeg ?? 0,
            mirroredX: host.mirroredX ?? false,
            mirroredY: host.mirroredY ?? false,
          }),
        ],
        deckHeightMm: Math.round(baseElev + 750),
        area: 600000,
      },
    ];
  }

  let selectedParts: FurniturePart[] = [];
  if (host.templateId === 'tv_unit_media' || host.templateId === 'tv_unit_floating') {
    selectedParts = parts.filter((p) => p.id === 'console' || p.detailStyle === 'cabinet');
  } else if (host.templateId === 'nightstand_oak' || host.templateId === 'bedside_fluted') {
    selectedParts = parts.filter((p) => p.id === 'carcass' || p.detailStyle === 'cabinet');
  }
  if (selectedParts.length === 0) {
    selectedParts = parts.filter((p) => p.detailStyle === 'table_top');
  }
  if (selectedParts.length === 0) {
    selectedParts = parts.filter((p) => p.detailStyle === 'cabinet');
  }
  if (selectedParts.length === 0) {
    const b = computeFurnitureBoundsMm(parts);
    const totalArea = Math.max(1, b.widthMm * b.depthMm);
    const topDeckParts = parts.filter((p) => {
      const topZ = p.zMm + p.heightMm;
      const area = p.widthMm * p.depthMm;
      return topZ >= b.maxZ - 45 && area >= totalArea * 0.2;
    });
    selectedParts = topDeckParts.length > 0 ? topDeckParts : parts;
  }

  const hostPlacement = getFurniturePlacement(
    {
      parts,
      rotationDeg: host.rotationDeg ?? 0,
      rotationXDeg: host.rotationXDeg ?? 0,
      rotationYDeg: host.rotationYDeg ?? 0,
      mirroredX: host.mirroredX ?? false,
      mirroredY: host.mirroredY ?? false,
      elevationMm: baseElev,
    },
    { pos: hostPos }
  );

  return selectedParts.map((p) => {
    const radP = (p.rotationDeg * Math.PI) / 180;
    const cosP = Math.cos(radP);
    const sinP = Math.sin(radP);
    const polys: Point2D[][] = [];
    let partMaxZ = baseElev + p.zMm + p.heightMm;

    for (const localPoly of buildPartLocalConvexPolygons(p)) {
      if (!hostPlacement.hasTilt) {
        polys.push(
          localPoly.map((pt) => {
            const lx = pt.x * cosP - pt.y * sinP + p.xMm;
            const ly = pt.x * sinP + pt.y * cosP + p.yMm;
            const wPt = hostPlacement.localToWorld3D(lx, ly, p.zMm + p.heightMm);
            return { x: wPt.x, y: wPt.y };
          })
        );
      } else {
        const pts3d: Point2D[] = [];
        let maxZ = -Infinity;
        for (const pt of localPoly) {
          const lx = pt.x * cosP - pt.y * sinP + p.xMm;
          const ly = pt.x * sinP + pt.y * cosP + p.yMm;
          for (const zVal of [p.zMm, p.zMm + p.heightMm]) {
            const wPt = hostPlacement.localToWorld3D(lx, ly, zVal);
            pts3d.push({ x: wPt.x, y: wPt.y });
            if (wPt.z > maxZ) maxZ = wPt.z;
          }
        }
        const hull = computeConvexHull2D(pts3d);
        if (hull.length >= 3) polys.push(hull);
        if (Number.isFinite(maxZ)) partMaxZ = maxZ;
      }
    }

    return {
      polys,
      deckHeightMm: Math.round(partMaxZ),
      area: Math.max(1, p.widthMm * p.depthMm),
    };
  });
}

export function getSupportingDeckHeightMm(
  host: Pick<FurnitureInstance, 'templateId' | 'elevationMm' | 'parts'> &
    Partial<
      Pick<
        FurnitureInstance,
        'xMm' | 'yMm' | 'rotationDeg' | 'rotationXDeg' | 'rotationYDeg' | 'mirroredX' | 'mirroredY'
      >
    >,
  pos?: Point2D
): number {
  const hostPos = { x: host.xMm ?? 0, y: host.yMm ?? 0 };
  const candidates = getSupportingDeckPartCandidates(hostPos, host);
  if (pos && host.xMm !== undefined && host.yMm !== undefined) {
    let bestAtPos: SupportingDeckPartCandidate | null = null;
    for (const cand of candidates) {
      if (cand.polys.some((poly) => pointInPolygon(pos, poly))) {
        if (!bestAtPos || cand.deckHeightMm > bestAtPos.deckHeightMm) {
          bestAtPos = cand;
        }
      }
    }
    if (bestAtPos) return bestAtPos.deckHeightMm;
  }
  return Math.max(...candidates.map((c) => c.deckHeightMm));
}

export function getFurnitureOrientedCorners(
  pos: Point2D,
  furn: Pick<
    FurnitureInstance,
    'parts' | 'rotationDeg' | 'rotationXDeg' | 'rotationYDeg' | 'mirroredX' | 'mirroredY'
  >
): Point2D[] {
  return getFurniturePlacement(
    { ...furn, elevationMm: 0 },
    { pos }
  ).orientedCorners;
}

function buildPartLocalConvexPolygons(part: FurniturePart): Point2D[][] {
  const w = Math.max(10, part.widthMm);
  const d = Math.max(10, part.depthMm);
  const hw = w / 2;
  const hd = d / 2;

  if (part.shape === 'l_profile') {
    const armW = Math.min(w * 0.42, Math.max(w * 0.25, 320));
    const armD = Math.min(d * 0.42, Math.max(d * 0.25, 320));
    return [
      // Top horizontal wing
      [
        { x: -hw, y: -hd },
        { x: hw, y: -hd },
        { x: hw, y: -hd + armD },
        { x: -hw, y: -hd + armD },
      ],
      // Left vertical wing
      [
        { x: -hw, y: -hd + armD },
        { x: -hw + armW, y: -hd + armD },
        { x: -hw + armW, y: hd },
        { x: -hw, y: hd },
      ],
    ];
  }

  if (part.shape === 'u_profile') {
    const armW = Math.min(w * 0.3, Math.max(w * 0.2, 260));
    const backD = Math.min(d * 0.35, Math.max(d * 0.22, 260));
    return [
      // Back bar
      [
        { x: -hw, y: -hd },
        { x: hw, y: -hd },
        { x: hw, y: -hd + backD },
        { x: -hw, y: -hd + backD },
      ],
      // Left arm
      [
        { x: -hw, y: -hd + backD },
        { x: -hw + armW, y: -hd + backD },
        { x: -hw + armW, y: hd },
        { x: -hw, y: hd },
      ],
      // Right arm
      [
        { x: hw - armW, y: -hd + backD },
        { x: hw, y: -hd + backD },
        { x: hw, y: hd },
        { x: hw - armW, y: hd },
      ],
    ];
  }

  if (part.shape === 'arc') {
    // Decompose curved crescent / wraparound shell into convex quads matching furniture3d.ts
    const segs = 10;
    const polys: Point2D[][] = [];
    for (let i = 0; i < segs; i++) {
      const t0 = (i / segs) * Math.PI;
      const t1 = ((i + 1) / segs) * Math.PI;
      polys.push([
        { x: Math.cos(t0) * hw, y: hd - Math.sin(t0) * d },
        { x: Math.cos(t1) * hw, y: hd - Math.sin(t1) * d },
        { x: Math.cos(t1) * hw * 0.65, y: hd - Math.sin(t1) * d * 0.65 },
        { x: Math.cos(t0) * hw * 0.65, y: hd - Math.sin(t0) * d * 0.65 },
      ]);
    }
    return polys;
  }

  if (part.detailStyle === 'caster_base') {
    return [getPartLocalOutline2D(part)];
  }

  if (part.shape === 'oval' || part.shape === 'cylinder' || part.shape === 'sphere') {
    const pts: Point2D[] = [];
    const segs = 16;
    for (let i = 0; i < segs; i++) {
      const a = (i * 2 * Math.PI) / segs;
      pts.push({ x: Math.cos(a) * hw, y: Math.sin(a) * hd });
    }
    return [pts];
  }

  if (part.shape === 'rounded_rect') {
    return [getPartLocalOutline2D(part)];
  }

  // box, extruded_svg, wedge (in 2D plan wedge occupies full w x d)
  return [
    [
      { x: -hw, y: -hd },
      { x: hw, y: -hd },
      { x: hw, y: hd },
      { x: -hw, y: hd },
    ],
  ];
}

export interface SolidFootprintPrimitive {
  poly: Point2D[];
  minZ: number;
  maxZ: number;
}

/**
 * Returns Z-bounded convex 2D collision primitives representing every structural part of a
 * furniture piece in world coordinates via canonical getFurniturePlacement.
 */
export function getFurnitureSolidFootprintPrimitives(
  pos: Point2D,
  furn: Pick<FurnitureInstance, 'parts' | 'rotationDeg' | 'mirroredX' | 'mirroredY' | 'elevationMm'> &
    Partial<
      Pick<
        FurnitureInstance,
        'templateId' | 'category' | 'mountingType' | 'attachedWallId' | 'surfaceHostId' | 'rotationXDeg' | 'rotationYDeg'
      >
    >,
  effectiveCeilingMm?: number
): SolidFootprintPrimitive[] {
  const placement = getFurniturePlacement(furn, { pos, effectiveCeilingMm });
  const baseElev = placement.groupElevationMm;
  if (!furn.parts || furn.parts.length === 0) {
    return [{ poly: placement.orientedCorners, minZ: baseElev, maxZ: baseElev + 700 }];
  }

  const activeParts = furn.parts.filter((p) => Math.max(p.widthMm, p.depthMm) >= 24 && p.heightMm >= 8);
  const partsToUse = activeParts.length > 0 ? activeParts : furn.parts;

  const fullRectCovers = partsToUse
    .filter((p) => (p.shape === 'box' || p.shape === 'rounded_rect') && Math.abs(p.rotationDeg) < 0.5)
    .map((p) => ({
      id: p.id,
      minX: p.xMm - p.widthMm / 2,
      maxX: p.xMm + p.widthMm / 2,
      minY: p.yMm - p.depthMm / 2,
      maxY: p.yMm + p.depthMm / 2,
      minZ: p.zMm,
      maxZ: p.zMm + p.heightMm,
      area: p.widthMm * p.depthMm,
    }));

  const isSubsumedByLargerRect = (p: FurniturePart): boolean => {
    const radP = (p.rotationDeg * Math.PI) / 180;
    const cosP = Math.abs(Math.cos(radP));
    const sinP = Math.abs(Math.sin(radP));
    const hw = (p.widthMm * cosP + p.depthMm * sinP) / 2;
    const hd = (p.widthMm * sinP + p.depthMm * cosP) / 2;
    const areaP = p.widthMm * p.depthMm;
    const pMinZ = p.zMm;
    const pMaxZ = p.zMm + p.heightMm;
    return fullRectCovers.some((cov) => {
      if (cov.id === p.id || cov.area < areaP) return false;
      const xyInside =
        p.xMm - hw >= cov.minX - 1 &&
        p.xMm + hw <= cov.maxX + 1 &&
        p.yMm - hd >= cov.minY - 1 &&
        p.yMm + hd <= cov.maxY + 1;
      if (!xyInside) return false;
      const zCovered = cov.minZ <= pMinZ + 25 && cov.maxZ >= pMaxZ - 25;
      const lowCabinetLegCovered = cov.minZ <= 280 && pMaxZ <= cov.minZ + 40;
      return zCovered || lowCabinetLegCovered;
    });
  };

  const primitives: SolidFootprintPrimitive[] = [];
  for (const p of partsToUse) {
    if (partsToUse.length > 1 && isSubsumedByLargerRect(p)) continue;

    const radP = (p.rotationDeg * Math.PI) / 180;
    const cosP = Math.cos(radP);
    const sinP = Math.sin(radP);

    if (
      placement.hasTilt &&
      p.shape !== 'l_profile' &&
      p.shape !== 'u_profile' &&
      p.shape !== 'arc'
    ) {
      const boundaryVerts = getPartFurnitureLocalBoundary3D(p, furn.templateId);
      if (boundaryVerts.length >= 3) {
        const pts3d: Point2D[] = [];
        let pMinZ = Infinity;
        let pMaxZ = -Infinity;
        for (const v of boundaryVerts) {
          const wPt = placement.localToWorld3D(v.x, v.y, v.z);
          pts3d.push({ x: wPt.x, y: wPt.y });
          if (wPt.z < pMinZ) pMinZ = wPt.z;
          if (wPt.z > pMaxZ) pMaxZ = wPt.z;
        }
        const hull = computeConvexHull2D(pts3d);
        if (hull.length >= 3) {
          primitives.push({
            poly: hull,
            minZ: pMinZ,
            maxZ: pMaxZ,
          });
          continue;
        }
      }
    }

    for (const localPoly of buildPartLocalConvexPolygons(p)) {
      if (!placement.hasTilt) {
        const worldPoly = localPoly.map((pt) => {
          const lx = pt.x * cosP - pt.y * sinP + p.xMm;
          const ly = pt.x * sinP + pt.y * cosP + p.yMm;
          const wPt = placement.localToWorld3D(lx, ly, p.zMm);
          return { x: wPt.x, y: wPt.y };
        });
        primitives.push({
          poly: worldPoly,
          minZ: baseElev + p.zMm,
          maxZ: baseElev + p.zMm + p.heightMm,
        });
      } else {
        const pts3d: Point2D[] = [];
        let pMinZ = Infinity;
        let pMaxZ = -Infinity;
        for (const pt of localPoly) {
          const lx = pt.x * cosP - pt.y * sinP + p.xMm;
          const ly = pt.x * sinP + pt.y * cosP + p.yMm;
          const zLevels =
            p.shape === 'wedge' && pt.x > 0 ? [p.zMm] : [p.zMm, p.zMm + p.heightMm];
          for (const zVal of zLevels) {
            const wPt = placement.localToWorld3D(lx, ly, zVal);
            pts3d.push({ x: wPt.x, y: wPt.y });
            if (wPt.z < pMinZ) pMinZ = wPt.z;
            if (wPt.z > pMaxZ) pMaxZ = wPt.z;
          }
        }
        const hull = computeConvexHull2D(pts3d);
        if (hull.length >= 3) {
          primitives.push({
            poly: hull,
            minZ: pMinZ,
            maxZ: pMaxZ,
          });
        }
      }
    }
  }

  return primitives.length > 0
    ? primitives
    : [{ poly: placement.orientedCorners, minZ: baseElev, maxZ: baseElev + 700 }];
}

export function computeConvexHull2D(points: Point2D[]): Point2D[] {
  if (points.length <= 3) return points;
  const sorted = [...points].sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));
  const cross = (o: Point2D, a: Point2D, b: Point2D) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point2D[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Point2D[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return [...lower, ...upper];
}

export function getFurnitureSolidFootprintPolygons(
  pos: Point2D,
  furn: Pick<FurnitureInstance, 'parts' | 'rotationDeg' | 'mirroredX' | 'mirroredY' | 'elevationMm'> &
    Partial<Pick<FurnitureInstance, 'rotationXDeg' | 'rotationYDeg'>>
): Point2D[][] {
  return getFurnitureSolidFootprintPrimitives(pos, furn).map((pr) => pr.poly);
}

export function computePolygonOverlapMTV(
  polyA: Point2D[],
  polyB: Point2D[]
): { nx: number; ny: number; depth: number } | null {
  if (polyA.length < 3 || polyB.length < 3) return null;

  const projectPoly = (poly: Point2D[], ax: number, ay: number) => {
    let min = Infinity;
    let max = -Infinity;
    for (const p of poly) {
      const d = p.x * ax + p.y * ay;
      if (d < min) min = d;
      if (d > max) max = d;
    }
    return { min, max };
  };

  let minDepth = Infinity;
  let bestNx = 0;
  let bestNy = 0;

  for (const poly of [polyA, polyB]) {
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i];
      const p2 = poly[(i + 1) % poly.length];
      const ex = p2.x - p1.x;
      const ey = p2.y - p1.y;
      const len = Math.hypot(ex, ey);
      if (len < 1e-6) continue;
      const ax = -ey / len;
      const ay = ex / len;

      const projA = projectPoly(polyA, ax, ay);
      const projB = projectPoly(polyB, ax, ay);
      const overlap = Math.min(projA.max, projB.max) - Math.max(projA.min, projB.min);
      if (overlap <= 0) return null;

      if (overlap < minDepth) {
        minDepth = overlap;
        bestNx = ax;
        bestNy = ay;
      }
    }
  }

  // Ensure normal points from polyB center toward polyA center (pushing A out of B)
  const cA = {
    x: polyA.reduce((s, p) => s + p.x, 0) / polyA.length,
    y: polyA.reduce((s, p) => s + p.y, 0) / polyA.length,
  };
  const cB = {
    x: polyB.reduce((s, p) => s + p.x, 0) / polyB.length,
    y: polyB.reduce((s, p) => s + p.y, 0) / polyB.length,
  };
  if ((cA.x - cB.x) * bestNx + (cA.y - cB.y) * bestNy < 0) {
    bestNx = -bestNx;
    bestNy = -bestNy;
  }

  return { nx: bestNx, ny: bestNy, depth: minDepth };
}

export function polygonSignedArea2D(poly: Point2D[]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum * 0.5;
}

export function ensureCCWPolygon2D(poly: Point2D[]): Point2D[] {
  if (poly.length < 3) return poly;
  return polygonSignedArea2D(poly) < 0 ? [...poly].reverse() : poly;
}

/**
 * Computes the exact 2D convex intersection polygon between two convex polygons using
 * Sutherland-Hodgman half-plane clipping (normalized to positive-area winding first so
 * mirrored furniture objects clip accurately).
 */
export function intersectConvexPolygons2D(polyA: Point2D[], polyB: Point2D[]): Point2D[] {
  if (polyA.length < 3 || polyB.length < 3) return [];
  let output = ensureCCWPolygon2D(polyA);
  const clip = ensureCCWPolygon2D(polyB);

  const isInsideEdge = (p: Point2D, a: Point2D, b: Point2D): boolean =>
    (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= -1e-5;

  const lineIntersect = (p1: Point2D, p2: Point2D, a: Point2D, b: Point2D): Point2D => {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) < 1e-8) return p2;
    const t = ((a.x - p1.x) * ey - (a.y - p1.y) * ex) / denom;
    return { x: p1.x + t * dx, y: p1.y + t * dy };
  };

  for (let i = 0; i < clip.length; i++) {
    const edgeStart = clip[i];
    const edgeEnd = clip[(i + 1) % clip.length];
    const input = output;
    output = [];
    if (input.length === 0) break;

    let prev = input[input.length - 1];
    let prevInside = isInsideEdge(prev, edgeStart, edgeEnd);
    for (const cur of input) {
      const curInside = isInsideEdge(cur, edgeStart, edgeEnd);
      if (curInside) {
        if (!prevInside) {
          output.push(lineIntersect(prev, cur, edgeStart, edgeEnd));
        }
        output.push(cur);
      } else if (prevInside) {
        output.push(lineIntersect(prev, cur, edgeStart, edgeEnd));
      }
      prev = cur;
      prevInside = curInside;
    }
  }

  // Deduplicate near-coincident consecutive vertices
  const cleaned: Point2D[] = [];
  for (const pt of output) {
    const prev = cleaned[cleaned.length - 1];
    if (!prev || Math.hypot(pt.x - prev.x, pt.y - prev.y) > 0.05) {
      cleaned.push(pt);
    }
  }
  if (
    cleaned.length >= 2 &&
    Math.hypot(cleaned[0].x - cleaned[cleaned.length - 1].x, cleaned[0].y - cleaned[cleaned.length - 1].y) <= 0.05
  ) {
    cleaned.pop();
  }

  if (cleaned.length < 3 || Math.abs(polygonSignedArea2D(cleaned)) < 25) {
    return [];
  }
  return cleaned;
}

/**
 * Offsets a convex 2D polygon inward by `insetMm` (safely clamped to the polygon's inradius)
 * so stacked identical furniture pieces can be differentiated visually without inversion.
 */
export function insetPolygon2D(poly: Point2D[], insetMm: number): Point2D[] {
  if (poly.length < 3) return poly;
  const pts = ensureCCWPolygon2D(poly);
  if (insetMm <= 0.5) return pts;

  const area = polygonSignedArea2D(pts);
  if (area <= 1) return pts;

  let perim = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    perim += Math.hypot(b.x - a.x, b.y - a.y);
    cx += a.x;
    cy += a.y;
  }
  cx /= pts.length;
  cy /= pts.length;

  const inradius = (2 * area) / Math.max(1, perim);
  const d = Math.min(insetMm, inradius * 0.68);
  if (d <= 0.5) return pts;

  interface OffsetEdge {
    px: number;
    py: number;
    dx: number;
    dy: number;
  }
  const edges: OffsetEdge[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len < 1e-4) continue;
    const nx = -ey / len;
    const ny = ex / len;
    edges.push({
      px: a.x + nx * d,
      py: a.y + ny * d,
      dx: ex / len,
      dy: ey / len,
    });
  }

  if (edges.length < 3) return pts;

  const insetPts: Point2D[] = [];
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
    if (Math.hypot(ix - orig.x, iy - orig.y) > d * 5) {
      valid = false;
      break;
    }
    insetPts.push({ x: ix, y: iy });
  }

  if (valid && insetPts.length >= 3 && polygonSignedArea2D(insetPts) > area * 0.04) {
    return insetPts;
  }

  const scale = Math.max(0.22, 1 - d / Math.max(1, inradius));
  return pts.map((p) => ({
    x: cx + (p.x - cx) * scale,
    y: cy + (p.y - cy) * scale,
  }));
}

export function wouldCreateSurfaceCycle(
  childId: string,
  candidateHostId: string,
  allFurniture: Array<Pick<FurnitureInstance, 'id' | 'surfaceHostId'>>
): boolean {
  if (childId === candidateHostId) return true;
  const byId = new Map(allFurniture.map((f) => [f.id, f]));
  const visited = new Set<string>([childId]);
  let cur: string | undefined = candidateHostId;
  while (cur) {
    if (visited.has(cur)) return true;
    visited.add(cur);
    cur = byId.get(cur)?.surfaceHostId;
  }
  return false;
}

export function findSupportingSurfacesForProp(
  pos: Point2D,
  prop: Pick<FurnitureInstance, 'id' | 'templateId' | 'parts'> &
    Partial<
      Pick<
        FurnitureInstance,
        | 'name'
        | 'category'
        | 'elevationMm'
        | 'surfaceHostId'
        | 'mountingType'
        | 'attachedWallId'
        | 'rotationDeg'
        | 'rotationXDeg'
        | 'rotationYDeg'
        | 'mirroredX'
        | 'mirroredY'
        | 'glbAssetId'
        | 'glbDataUrl'
      >
    >,
  allFurniture: FurnitureInstance[]
): Array<{ host: FurnitureInstance; deckHeightMm: number }> {
  if (!isSurfaceMountable(prop)) return [];

  const propBounds = computeFurnitureTiltedLocalBoundsMm(
    prop.parts,
    prop.rotationXDeg ?? 0,
    prop.rotationYDeg ?? 0,
    prop.mirroredX ?? false,
    prop.mirroredY ?? false
  );
  const propSpanMm = Math.max(
    10,
    Math.min(propBounds.maxX - propBounds.minX, propBounds.maxY - propBounds.minY)
  );
  // Required overlap threshold: 1/3 of dragged item's footprint span, hard-capped at 120 mm
  const requiredIntrusionMm = Math.min(propSpanMm / 3, MAX_SURFACE_STACK_INTRUSION_MM);
  const propPolys = getFurnitureSolidFootprintPolygons(pos, {
    parts: prop.parts,
    rotationDeg: prop.rotationDeg ?? 0,
    mirroredX: prop.mirroredX ?? false,
    mirroredY: prop.mirroredY ?? false,
    elevationMm: prop.elevationMm ?? 0,
    rotationXDeg: prop.rotationXDeg ?? 0,
    rotationYDeg: prop.rotationYDeg ?? 0,
  });

  const hits: Array<{ host: FurnitureInstance; deckHeightMm: number; area: number; intrusion: number }> = [];
  for (const cand of allFurniture) {
    if (cand.id === prop.id || cand.visible === false) continue;
    if (wouldCreateSurfaceCycle(prop.id, cand.id, allFurniture)) continue;
    if (!isCompatibleSurfaceChild(prop, cand)) continue;

    const deckCandidates = getSupportingDeckPartCandidates({ x: cand.xMm, y: cand.yMm }, cand);
    let candDeckHeightMm: number | null = null;
    let candMaxIntrusion = 0;

    for (const deck of deckCandidates) {
      const centerInside = deck.polys.some((poly) => pointInPolygon(pos, poly));
      let maxIntrusion = 0;
      for (const pPoly of propPolys) {
        for (const dPoly of deck.polys) {
          const mtv = computePolygonOverlapMTV(pPoly, dPoly);
          if (mtv && mtv.depth > maxIntrusion) {
            maxIntrusion = mtv.depth;
          }
        }
      }
      if (!centerInside && maxIntrusion < requiredIntrusionMm) continue;

      const effIntrusion = centerInside ? Math.max(maxIntrusion, requiredIntrusionMm + 1) : maxIntrusion;
      if (
        candDeckHeightMm === null ||
        deck.deckHeightMm > candDeckHeightMm ||
        (deck.deckHeightMm === candDeckHeightMm && effIntrusion > candMaxIntrusion)
      ) {
        candDeckHeightMm = deck.deckHeightMm;
        candMaxIntrusion = effIntrusion;
      }
    }

    if (candDeckHeightMm === null) continue;

    // Ensure the stacked item sits completely above any taller overlapping structural parts
    // (such as backrests, armrests, or upper frames) so it never clips through the host.
    let safeDeckHeightMm = candDeckHeightMm;
    const hostPrims = getFurnitureSolidFootprintPrimitives({ x: cand.xMm, y: cand.yMm }, cand);
    for (const oPrim of hostPrims) {
      const oMaxZ = Math.round(oPrim.maxZ);
      if (oMaxZ <= safeDeckHeightMm) continue;
      for (const pPoly of propPolys) {
        const mtv = computePolygonOverlapMTV(pPoly, oPrim.poly);
        if (mtv && mtv.depth > 6) {
          safeDeckHeightMm = oMaxZ;
          break;
        }
      }
    }

    const b = computeFurnitureBoundsMm(cand.parts);
    const hostArea = b.widthMm * b.depthMm;
    hits.push({
      host: cand,
      deckHeightMm: safeDeckHeightMm,
      area: hostArea,
      intrusion: candMaxIntrusion,
    });
  }

  hits.sort((a, b) => {
    if (b.deckHeightMm !== a.deckHeightMm) return b.deckHeightMm - a.deckHeightMm;
    if (Math.abs(b.intrusion - a.intrusion) > 2) return b.intrusion - a.intrusion;
    return a.area - b.area;
  });

  return hits.map(({ host, deckHeightMm }) => ({ host, deckHeightMm }));
}

export function findSupportingSurfaceForProp(
  pos: Point2D,
  prop: Pick<FurnitureInstance, 'id' | 'templateId' | 'parts'> &
    Partial<
      Pick<
        FurnitureInstance,
        | 'name'
        | 'category'
        | 'elevationMm'
        | 'surfaceHostId'
        | 'mountingType'
        | 'attachedWallId'
        | 'rotationDeg'
        | 'rotationXDeg'
        | 'rotationYDeg'
        | 'mirroredX'
        | 'mirroredY'
        | 'glbAssetId'
        | 'glbDataUrl'
      >
    >,
  allFurniture: FurnitureInstance[]
): { host: FurnitureInstance; deckHeightMm: number } | null {
  return findSupportingSurfacesForProp(pos, prop, allFurniture)[0] ?? null;
}

export function canFurnitureCoexist(
  moving: Pick<FurnitureInstance, 'id' | 'templateId' | 'category' | 'parts' | 'elevationMm' | 'surfaceHostId'> &
    Partial<Pick<FurnitureInstance, 'mountingType' | 'attachedWallId'>>,
  other: FurnitureInstance,
  candidateHostId?: string
): boolean {
  if (other.id === moving.id || other.visible === false) return true;
  if (isRugFurniture(moving) || isRugFurniture(other)) return true;
  if (isCeilingFixture(moving) || isCeilingFixture(other)) return true;
  if (isCurtainOrBlindFurniture(moving) || isCurtainOrBlindFurniture(other)) return true;
  if (other.surfaceHostId === moving.id) return true;

  // Surface-mountable item sitting ON or dragged onto its supporting host is naturally allowed
  if (isSurfaceMountable(moving) && candidateHostId && other.id === candidateHostId) {
    return true;
  }
  // Supporting surface sliding under a prop already hosted on it shouldn't block
  if (moving.surfaceHostId === other.id && isSurfaceMountable(moving)) {
    return true;
  }

  // Respect 3D vertical separation (e.g., wall cabinet above base cabinet, or raised wall-mounted TV above lowboard)
  const spanA = computeFurnitureElevationSpanMm(moving);
  const spanB = computeFurnitureElevationSpanMm(other);
  const zOverlap = spanA.minZ < spanB.maxZ - 25 && spanA.maxZ > spanB.minZ + 25;
  return !zOverlap;
}

/**
 * Returns names of any other visible furniture objects that genuinely overlap
 * `furn` at `pos` in both 2D plan polygons (> 12 mm penetration) and 3D vertical
 * Z span (> 20 mm), excluding surface host/child relationships, rugs, curtains,
 * and vertically separated Z layers (e.g., drawers under elevated tabletops).
 */
export function detectFurnitureClashesAt(
  pos: Point2D,
  furn: FurnitureInstance,
  otherFurniture: FurnitureInstance[]
): string[] {
  if (isRugFurniture(furn) || isCurtainOrBlindFurniture(furn)) return [];
  const selfPrims = getFurnitureSolidFootprintPrimitives(pos, furn);
  if (selfPrims.length === 0) return [];

  const clashes: string[] = [];
  const seen = new Set<string>();

  for (const other of otherFurniture) {
    if (other.id === furn.id || other.visible === false) continue;
    if (isRugFurniture(other) || isCurtainOrBlindFurniture(other)) continue;
    if (other.id === furn.surfaceHostId || other.surfaceHostId === furn.id) continue;

    const otherPrims = getFurnitureSolidFootprintPrimitives({ x: other.xMm, y: other.yMm }, other);
    let hits = false;
    for (const sPrim of selfPrims) {
      for (const oPrim of otherPrims) {
        if (sPrim.minZ >= oPrim.maxZ - 20 || sPrim.maxZ <= oPrim.minZ + 20) continue;
        const mtv = computePolygonOverlapMTV(sPrim.poly, oPrim.poly);
        if (mtv && mtv.depth > 12) {
          hits = true;
          break;
        }
      }
      if (hits) break;
    }

    if (hits && !seen.has(other.id)) {
      seen.add(other.id);
      clashes.push(other.name);
    }
  }

  return clashes;
}

export interface FurnitureClashRegion {
  idA: string;
  idB: string;
  poly: Point2D[];
}

/**
 * Computes exact 2D convex intersection polygons for every pair of visible non-coexisting
 * furniture primitives that genuinely clash in both 2D (> 12 mm penetration) and 3D Z span.
 * Used to paint red diagonal-line clash overlays strictly across intersecting areas.
 */
export function computeFurnitureClashIntersectionRegions(
  furnitureList: FurnitureInstance[]
): FurnitureClashRegion[] {
  const active = furnitureList.filter(
    (f) =>
      f.visible !== false &&
      !isRugFurniture(f) &&
      !isCeilingFixture(f) &&
      !isCurtainOrBlindFurniture(f)
  );
  if (active.length < 2) return [];

  const cached = active.map((f) => {
    const corners = getFurnitureOrientedCorners({ x: f.xMm, y: f.yMm }, f);
    return {
      f,
      aabb: getBoundsArea2D(corners),
      prims: getFurnitureSolidFootprintPrimitives({ x: f.xMm, y: f.yMm }, f),
    };
  });

  const regions: FurnitureClashRegion[] = [];
  for (let i = 0; i < cached.length; i++) {
    const a = cached[i];
    for (let j = i + 1; j < cached.length; j++) {
      const b = cached[j];
      if (a.f.surfaceHostId === b.f.id || b.f.surfaceHostId === a.f.id) continue;
      if (
        a.aabb.maxX - b.aabb.minX <= 12 ||
        b.aabb.maxX - a.aabb.minX <= 12 ||
        a.aabb.maxY - b.aabb.minY <= 12 ||
        b.aabb.maxY - a.aabb.minY <= 12
      ) {
        continue;
      }

      for (const sPrim of a.prims) {
        for (const oPrim of b.prims) {
          if (sPrim.minZ >= oPrim.maxZ - 20 || sPrim.maxZ <= oPrim.minZ + 20) continue;
          const mtv = computePolygonOverlapMTV(sPrim.poly, oPrim.poly);
          if (!mtv || mtv.depth <= 12) continue;
          const inter = intersectConvexPolygons2D(sPrim.poly, oPrim.poly);
          if (inter.length >= 3 && Math.abs(polygonSignedArea2D(inter)) >= 100) {
            regions.push({ idA: a.f.id, idB: b.f.id, poly: inter });
          }
        }
      }
    }
  }

  return regions;
}

function getSolidWallAndArchPrimitives(
  walls: Wall[],
  archElements: ArchElement[],
  furnMinZ: number,
  furnMaxZ: number
): SolidFootprintPrimitive[] {
  const prims: SolidFootprintPrimitive[] = [];

  for (const w of walls) {
    if (w.visible === false) continue;
    if (furnMinZ >= w.heightMm - 10) continue;

    if (w.isCurved && Math.abs(w.curveBulgeMm) >= 1) {
      const steps = 12;
      const { left, right } = wallOffsets(w.thicknessMm, w.alignment);
      const pts: Point2D[] = [];
      const nrms: Point2D[] = [];
      for (let i = 0; i <= steps; i++) {
        const res = getWallCenterlinePoint(w, i / steps);
        pts.push(res.point);
        nrms.push(res.normal);
      }
      for (let i = 0; i < steps; i++) {
        prims.push({
          poly: [
            { x: pts[i].x + nrms[i].x * left, y: pts[i].y + nrms[i].y * left },
            { x: pts[i + 1].x + nrms[i + 1].x * left, y: pts[i + 1].y + nrms[i + 1].y * left },
            { x: pts[i + 1].x + nrms[i + 1].x * right, y: pts[i + 1].y + nrms[i + 1].y * right },
            { x: pts[i].x + nrms[i].x * right, y: pts[i].y + nrms[i].y * right },
          ],
          minZ: 0,
          maxZ: w.heightMm,
        });
      }
    } else {
      const wallPoly = computeWallPolygon(w, walls);
      if (wallPoly.length >= 3) {
        prims.push({ poly: wallPoly, minZ: 0, maxZ: w.heightMm });
      }
    }
  }

  for (const el of archElements) {
    if (el.visible === false) continue;
    if (
      el.type !== 'chimney' &&
      el.type !== 'column_round' &&
      el.type !== 'column_square' &&
      el.type !== 'fireplace'
    ) {
      continue;
    }
    const elMinZ = el.elevationMm ?? 0;
    const elMaxZ = elMinZ + el.heightMm;
    if (furnMinZ >= elMaxZ - 15 || furnMaxZ <= elMinZ + 15) continue;
    prims.push({
      poly: getChimneyWorldCorners(el.xMm, el.yMm, el.widthMm, el.depthMm, el.rotationDeg),
      minZ: elMinZ,
      maxZ: elMaxZ,
    });
  }

  return prims;
}

export interface SolidFurnitureMoveResult {
  xMm: number;
  yMm: number;
  rotationDeg: number;
  elevationMm: number;
  surfaceHostId?: string;
  rawSurfaceHostCandidateId?: string;
  attachedWallId?: string;
  attachedFace?: 'left' | 'right';
  attachedT?: number;
  zOrder?: number;
  snappedKind: FurnitureSnapResult['snappedKind'];
  snapLabel?: string;
  snapKey?: string;
  hysteresis?: SnapHysteresisState;
  guides: AlignmentGuide[];
  attachmentPreview?: AttachmentTargetPreview;
  roomCenterSnap?: { roomId: string; roomName: string; center: Point2D };
  clashingNames: string[];
  isForceFloor?: boolean;
  placingOnHostName?: string;
  stackCandidates?: Array<{ hostId: string; hostName: string; deckHeightMm: number }>;
}

/**
 * Resolves solid-body furniture placement with:
 * - Flush wall & corner snapping + adjacent furniture edge snapping + room-center snapping (with hysteresis)
 * - Smooth parallel & tangential edge sliding around angled walls, columns, chimneys, and rotated furniture
 * - Free separation from any pre-existing wall, arch, or furniture overlap while preventing new overlap
 * - Surface host dwell gating hook (`resolveSurfaceHost`)
 * - Logical vertical/overlap exceptions (rugs, ceiling lights, Z-separated wall mounts,
 *   chairs/drawers beneath elevated tabletops, and automatic surface host placement).
 */
export function solveSolidFurnitureMove(
  prevPos: Point2D,
  targetPos: Point2D,
  furn: FurnitureInstance,
  level: Pick<Level, 'walls' | 'furniture' | 'archElements'> & Partial<Pick<Level, 'rooms'>>,
  options: {
    snapEnabled: boolean;
    gridSizeMm: number;
    wallSnapTolMm?: number;
    furnSnapTolMm?: number;
    alignTolMm?: number;
    roomCenterTolMm?: number;
    strongRoomCenterTolMm?: number;
    surfaceRoomCenterTolMm?: number;
    hysteresis?: SnapHysteresisState;
    resolveSurfaceHost?: (
      rawHostId: string | undefined,
      candidates: Array<{ host: FurnitureInstance; deckHeightMm: number }>
    ) => string | undefined;
    allowOverlap?: boolean;
    allowFurnitureOverlap?: boolean;
    forceFloor?: boolean;
    preferredHostId?: string;
    rooms?: Room[];
  }
): SolidFurnitureMoveResult {
  const otherFurniture = level.furniture.filter((o) => o.id !== furn.id && o.visible !== false);
  const rooms = options.rooms ?? level.rooms ?? [];

  const wallMountedTv = isWallMountedTv(furn);
  const mountingType = resolveFurnitureMountingType(furn);

  const evaluateHostAt = (pos: Point2D): {
    elevationMm: number;
    surfaceHostId?: string;
    rawCandidateId?: string;
    candidates: Array<{ host: FurnitureInstance; deckHeightMm: number }>;
  } => {
    if (options.forceFloor) {
      return { elevationMm: 0, surfaceHostId: undefined, rawCandidateId: undefined, candidates: [] };
    }
    if (options.allowOverlap) {
      return {
        elevationMm: furn.surfaceHostId ? 0 : (furn.elevationMm ?? 0),
        surfaceHostId: undefined,
        rawCandidateId: undefined,
        candidates: [],
      };
    }
    if (wallMountedTv || !isSurfaceMountable(furn)) {
      return {
        elevationMm: furn.elevationMm ?? 0,
        surfaceHostId: furn.surfaceHostId,
        rawCandidateId: furn.surfaceHostId,
        candidates: [],
      };
    }
    const candidates = findSupportingSurfacesForProp(pos, furn, otherFurniture);
    const rawChosen =
      (options.preferredHostId
        ? candidates.find((c) => c.host.id === options.preferredHostId)
        : undefined) ?? candidates[0];
    const rawCandidateId = rawChosen?.host.id;

    if (options.resolveSurfaceHost) {
      const gatedId = options.resolveSurfaceHost(rawCandidateId, candidates);
      if (gatedId) {
        const match = candidates.find((c) => c.host.id === gatedId);
        if (match) {
          return {
            elevationMm: match.deckHeightMm,
            surfaceHostId: match.host.id,
            rawCandidateId,
            candidates,
          };
        }
        const heldHost = otherFurniture.find((o) => o.id === gatedId);
        if (heldHost) {
          const heldDeck = getSupportingDeckHeightMm(heldHost, pos);
          return {
            elevationMm: heldDeck,
            surfaceHostId: heldHost.id,
            rawCandidateId,
            candidates,
          };
        }
      }
      return {
        elevationMm: 0,
        surfaceHostId: undefined,
        rawCandidateId,
        candidates,
      };
    }

    if (rawChosen) {
      return {
        elevationMm: rawChosen.deckHeightMm,
        surfaceHostId: rawChosen.host.id,
        rawCandidateId,
        candidates,
      };
    }
    if (furn.surfaceHostId) {
      return { elevationMm: 0, surfaceHostId: undefined, rawCandidateId: undefined, candidates: [] };
    }
    return {
      elevationMm: furn.elevationMm ?? 0,
      surfaceHostId: undefined,
      rawCandidateId: undefined,
      candidates: [],
    };
  };

  const initialHost = evaluateHostAt(targetPos);
  const furnForSnap: FurnitureInstance = {
    ...furn,
    elevationMm: initialHost.elevationMm,
    surfaceHostId: initialHost.surfaceHostId,
  };

  const snap = snapFurnitureToPlan(
    targetPos,
    furnForSnap,
    level.walls,
    otherFurniture,
    {
      snapEnabled: options.allowOverlap ? false : options.snapEnabled,
      gridSizeMm: options.gridSizeMm,
      wallSnapTolMm: options.wallSnapTolMm ?? (mountingType === 'wall' ? 175 : 115),
      furnSnapTolMm: options.furnSnapTolMm ?? 75,
      alignTolMm: options.alignTolMm ?? 55,
      roomCenterTolMm: options.roomCenterTolMm,
      strongRoomCenterTolMm: options.strongRoomCenterTolMm,
      surfaceRoomCenterTolMm: options.surfaceRoomCenterTolMm,
      hysteresis: options.hysteresis,
      rooms,
    }
  );

  let curRot = snap.rotationDeg;
  const resolvedHost = evaluateHostAt({ x: snap.xMm, y: snap.yMm });
  const furnWithElev: FurnitureInstance = {
    ...furn,
    rotationDeg: curRot,
    elevationMm: resolvedHost.elevationMm,
    surfaceHostId: resolvedHost.surfaceHostId,
  };

  const nextAttachedWallId =
    options.allowOverlap || options.forceFloor
      ? undefined
      : mountingType === 'wall'
        ? snap.attachedWallId
        : undefined;
  let nextAttachedFace = nextAttachedWallId ? snap.attachedFace : undefined;
  let nextAttachedT = nextAttachedWallId ? snap.attachedT : undefined;

  if (
    options.allowOverlap ||
    isRugFurniture(furnWithElev) ||
    isCeilingFixture(furnWithElev) ||
    isCurtainOrBlindFurniture(furnWithElev)
  ) {
    const clashingNames = detectFurnitureClashesAt(
      { x: snap.xMm, y: snap.yMm },
      furnWithElev,
      otherFurniture
    );
    return {
      xMm: snap.xMm,
      yMm: snap.yMm,
      rotationDeg: curRot,
      elevationMm: resolvedHost.elevationMm,
      surfaceHostId: resolvedHost.surfaceHostId,
      rawSurfaceHostCandidateId: initialHost.rawCandidateId,
      attachedWallId: nextAttachedWallId,
      attachedFace: nextAttachedFace,
      attachedT: nextAttachedT,
      zOrder: furn.zOrder,
      snappedKind: snap.snappedKind,
      snapLabel: options.allowOverlap ? 'Free Overlap' : snap.snapLabel,
      snapKey: snap.snapKey,
      hysteresis: snap.hysteresis,
      guides: snap.guides,
      attachmentPreview: options.allowOverlap ? undefined : snap.attachmentPreview,
      roomCenterSnap: snap.roomCenterSnap,
      clashingNames,
      isForceFloor: Boolean(options.forceFloor),
      stackCandidates: [],
    };
  }

  const span = computeFurnitureElevationSpanMm(furnWithElev);
  const wallAndArchPrims = getSolidWallAndArchPrimitives(
    level.walls,
    level.archElements,
    span.minZ,
    span.maxZ
  ).map((pr, idx) => ({ ...pr, groupId: `arch_${idx}` }));

  const solidOtherPrims: Array<SolidFootprintPrimitive & { groupId: string }> = [];
  if (!options.allowFurnitureOverlap) {
    for (const other of otherFurniture) {
      if (canFurnitureCoexist(furnWithElev, other, resolvedHost.surfaceHostId)) continue;
      for (const pr of getFurnitureSolidFootprintPrimitives({ x: other.xMm, y: other.yMm }, other)) {
        solidOtherPrims.push({ ...pr, groupId: `furn_${other.id}` });
      }
    }
  }

  const allObstacles: Array<SolidFootprintPrimitive & { groupId: string }> = [
    ...wallAndArchPrims,
    ...solidOtherPrims,
  ];

  const getSelfPrims = (pos: Point2D, rotDeg: number): SolidFootprintPrimitive[] =>
    getFurnitureSolidFootprintPrimitives(pos, { ...furnWithElev, rotationDeg: rotDeg });

  const getGroupPenetration = (
    pos: Point2D,
    rotDeg: number,
    groupId: string
  ): number => {
    const selfPrims = getSelfPrims(pos, rotDeg);
    let worst = 0;
    for (const sPrim of selfPrims) {
      for (const obsPrim of allObstacles) {
        if (obsPrim.groupId !== groupId) continue;
        if (sPrim.minZ >= obsPrim.maxZ - 20 || sPrim.maxZ <= obsPrim.minZ + 20) continue;
        const mtv = computePolygonOverlapMTV(sPrim.poly, obsPrim.poly);
        if (mtv && mtv.depth > worst) worst = mtv.depth;
      }
    }
    return worst;
  };

  const findDeepestBlockingMTV = (
    pos: Point2D,
    rotDeg: number,
    ignoreGroups: Set<string>
  ): { nx: number; ny: number; depth: number } | null => {
    const selfPrims = getSelfPrims(pos, rotDeg);
    let worst: { nx: number; ny: number; depth: number } | null = null;
    for (const sPrim of selfPrims) {
      for (const obsPrim of allObstacles) {
        if (ignoreGroups.has(obsPrim.groupId)) continue;
        if (sPrim.minZ >= obsPrim.maxZ - 20 || sPrim.maxZ <= obsPrim.minZ + 20) continue;
        const mtv = computePolygonOverlapMTV(sPrim.poly, obsPrim.poly);
        if (mtv && mtv.depth > 0.5 && (!worst || mtv.depth > worst.depth)) {
          worst = mtv;
        }
      }
    }
    return worst;
  };

  // Identify wall, arch, or furniture overlaps that ALREADY existed at prevPos so users can pull
  // clashing items freely out of overlap without Shift, while never allowing new clashes or re-entry.
  const activeEscapeGroups = new Set<string>();
  const startGroupSet = new Set(allObstacles.map((p) => p.groupId));
  const previousHostGroupId =
    options.forceFloor && furn.surfaceHostId ? `furn_${furn.surfaceHostId}` : undefined;
  for (const gid of startGroupSet) {
    if (gid === previousHostGroupId) continue;
    const pen = getGroupPenetration(prevPos, furn.rotationDeg, gid);
    if (pen > 0.5) {
      activeEscapeGroups.add(gid);
    }
  }

  const resolvePenetrations = (
    pos: Point2D,
    rotDeg: number,
    ignoreGroups: Set<string>
  ): Point2D => {
    let p = { x: pos.x, y: pos.y };
    for (let iter = 0; iter < 12; iter++) {
      let pushed = false;
      const selfPrims = getSelfPrims(p, rotDeg);
      for (const sPrim of selfPrims) {
        for (const obsPrim of allObstacles) {
          if (ignoreGroups.has(obsPrim.groupId)) continue;
          if (sPrim.minZ >= obsPrim.maxZ - 20 || sPrim.maxZ <= obsPrim.minZ + 20) continue;
          const mtv = computePolygonOverlapMTV(sPrim.poly, obsPrim.poly);
          if (mtv && mtv.depth > 0.5) {
            p = {
              x: p.x + mtv.nx * mtv.depth,
              y: p.y + mtv.ny * mtv.depth,
            };
            pushed = true;
            break;
          }
        }
        if (pushed) break;
      }
      if (!pushed) break;
    }
    return p;
  };

  const isValidStep = (
    candidatePos: Point2D,
    rotDeg: number,
    refPos: Point2D,
    ignoreGroups: Set<string>
  ): boolean => {
    const selfPrims = getSelfPrims(candidatePos, rotDeg);
    for (const sPrim of selfPrims) {
      for (const obsPrim of allObstacles) {
        if (ignoreGroups.has(obsPrim.groupId)) continue;
        if (sPrim.minZ >= obsPrim.maxZ - 20 || sPrim.maxZ <= obsPrim.minZ + 20) continue;
        const mtv = computePolygonOverlapMTV(sPrim.poly, obsPrim.poly);
        if (mtv && mtv.depth > 6) return false;
      }
    }
    for (const gid of ignoreGroups) {
      const prevPen = getGroupPenetration(refPos, rotDeg, gid);
      const nextPen = getGroupPenetration(candidatePos, rotDeg, gid);
      if (nextPen > prevPen + 1.5) return false;
    }
    return true;
  };

  const goal = { x: snap.xMm, y: snap.yMm };
  const travel = dist(prevPos, goal);
  const substeps = Math.max(1, Math.min(250, Math.ceil(travel / 30)));
  const stepX = (goal.x - prevPos.x) / substeps;
  const stepY = (goal.y - prevPos.y) / substeps;
  const dirX = Math.sign(goal.x - prevPos.x);
  const dirY = Math.sign(goal.y - prevPos.y);
  let curPos: Point2D = { x: prevPos.x, y: prevPos.y };

  if (previousHostGroupId && startGroupSet.has(previousHostGroupId)) {
    const escapedFromHost = resolvePenetrations(curPos, curRot, activeEscapeGroups);
    if (isValidStep(escapedFromHost, curRot, curPos, activeEscapeGroups)) {
      curPos = escapedFromHost;
    }
  }

  for (let s = 1; s <= substeps; s++) {
    const dx = dirX !== 0 ? dirX * Math.min(Math.abs(stepX), Math.max(0, (goal.x - curPos.x) * dirX)) : 0;
    const dy = dirY !== 0 ? dirY * Math.min(Math.abs(stepY), Math.max(0, (goal.y - curPos.y) * dirY)) : 0;
    if (Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4) break;

    const probe = { x: curPos.x + dx, y: curPos.y + dy };
    const resolved = resolvePenetrations(probe, curRot, activeEscapeGroups);
    if (
      isValidStep(resolved, curRot, curPos, activeEscapeGroups) &&
      Math.hypot(resolved.x - curPos.x, resolved.y - curPos.y) > 0.05
    ) {
      curPos = resolved;
    } else {
      // Tangent-projected surface sliding along any angle + orthogonal fallbacks
      const blockMtv = findDeepestBlockingMTV(probe, curRot, activeEscapeGroups);
      const slideCands: Point2D[] = [];
      if (blockMtv) {
        const tx = -blockMtv.ny;
        const ty = blockMtv.nx;
        const tProj = dx * tx + dy * ty;
        if (Math.abs(tProj) > 1e-4) {
          slideCands.push({
            x: curPos.x + tx * tProj + blockMtv.nx * 0.6,
            y: curPos.y + ty * tProj + blockMtv.ny * 0.6,
          });
          slideCands.push({
            x: curPos.x + tx * tProj * 0.5 + blockMtv.nx * 1.2,
            y: curPos.y + ty * tProj * 0.5 + blockMtv.ny * 1.2,
          });
        }
      }
      if (Math.abs(dx) > 1e-4) slideCands.push({ x: curPos.x + dx, y: curPos.y });
      if (Math.abs(dy) > 1e-4) slideCands.push({ x: curPos.x, y: curPos.y + dy });

      let bestSlide: Point2D | null = null;
      let bestSlideGoalDist = Math.hypot(goal.x - curPos.x, goal.y - curPos.y);
      for (const rawCand of slideCands) {
        const cand = resolvePenetrations(rawCand, curRot, activeEscapeGroups);
        const stepDist = Math.hypot(cand.x - curPos.x, cand.y - curPos.y);
        if (stepDist > 0.05 && isValidStep(cand, curRot, curPos, activeEscapeGroups)) {
          const dGoal = Math.hypot(goal.x - cand.x, goal.y - cand.y);
          if (dGoal <= bestSlideGoalDist + 0.5) {
            bestSlideGoalDist = dGoal;
            bestSlide = cand;
          }
        }
      }
      if (bestSlide) {
        curPos = bestSlide;
      } else {
        break;
      }
    }

    // Once an initially overlapping item clears another obstacle, lock collision prevention back on
    for (const gid of Array.from(activeEscapeGroups)) {
      if (getGroupPenetration(curPos, curRot, gid) <= 0.5) {
        activeEscapeGroups.delete(gid);
      }
    }
  }

  // Final host re-evaluation at resolved position
  let finalHost = evaluateHostAt(curPos);
  if (
    !options.allowFurnitureOverlap &&
    finalHost.surfaceHostId !== resolvedHost.surfaceHostId &&
    !finalHost.surfaceHostId
  ) {
    let adjusted = { x: curPos.x, y: curPos.y };
    const dropFurn = {
      ...furn,
      rotationDeg: curRot,
      elevationMm: finalHost.elevationMm,
      surfaceHostId: undefined,
    };
    for (let iter = 0; iter < 8; iter++) {
      let pushed = false;
      const selfDropPrims = getFurnitureSolidFootprintPrimitives(adjusted, dropFurn);
      for (const other of otherFurniture) {
        if (activeEscapeGroups.has(`furn_${other.id}`)) continue;
        if (canFurnitureCoexist(dropFurn, other, undefined)) continue;
        const otherPrims = getFurnitureSolidFootprintPrimitives({ x: other.xMm, y: other.yMm }, other);
        for (const sPrim of selfDropPrims) {
          for (const oPrim of otherPrims) {
            if (sPrim.minZ >= oPrim.maxZ - 20 || sPrim.maxZ <= oPrim.minZ + 20) continue;
            const mtv = computePolygonOverlapMTV(sPrim.poly, oPrim.poly);
            if (mtv && mtv.depth > 0.5) {
              adjusted = {
                x: adjusted.x + mtv.nx * mtv.depth,
                y: adjusted.y + mtv.ny * mtv.depth,
              };
              pushed = true;
              break;
            }
          }
          if (pushed) break;
        }
        if (pushed) break;
      }
      if (!pushed) break;
    }
    const checkHost = evaluateHostAt(adjusted);
    if (!checkHost.surfaceHostId) {
      curPos = adjusted;
      finalHost = checkHost;
    }
  }
  let nextZOrder = furn.zOrder;
  let finalLabel = snap.snapLabel;
  let attachmentPreview: AttachmentTargetPreview | undefined = snap.attachmentPreview;
  let placingOnHostName: string | undefined;

  if (nextAttachedWallId && nextAttachedFace) {
    const aw = level.walls.find((w) => w.id === nextAttachedWallId && w.visible !== false && !w.isCurved);
    if (aw) {
      const awLen = getWallArcLength(aw);
      if (awLen > 1) {
        const ux = (aw.end.x - aw.start.x) / awLen;
        const uy = (aw.end.y - aw.start.y) / awLen;
        const nx = -uy;
        const ny = ux;
        const { left, right } = wallOffsets(aw.thicknessMm, aw.alignment);
        const wallMid = (left + right) / 2;
        const dNormFinal = (curPos.x - aw.start.x) * nx + (curPos.y - aw.start.y) * ny;
        const finalOnLeft = dNormFinal >= wallMid;
        const expectedFace: 'left' | 'right' = finalOnLeft ? 'left' : 'right';
        if (expectedFace !== nextAttachedFace) {
          const sProj = (curPos.x - aw.start.x) * ux + (curPos.y - aw.start.y) * uy;
          const tClamped = Math.max(0.01, Math.min(0.99, sProj / awLen));
          const corrected = computeAttachedWallFurnitureTransform(aw, tClamped, expectedFace, furn);
          curPos = { x: corrected.xMm, y: corrected.yMm };
          curRot = corrected.rotationDeg;
          nextAttachedFace = expectedFace;
          nextAttachedT = corrected.attachedT;
          if (attachmentPreview?.kind === 'wall') {
            attachmentPreview = {
              ...attachmentPreview,
              wallFace: expectedFace,
              wallT: corrected.attachedT,
            };
          }
        }
      }
    }
  }

  if (finalHost.surfaceHostId) {
    const hostObj = otherFurniture.find((o) => o.id === finalHost.surfaceHostId);
    if (hostObj) {
      const movedCandidate: FurnitureInstance = {
        ...furn,
        xMm: Math.round(curPos.x),
        yMm: Math.round(curPos.y),
        rotationDeg: curRot,
        elevationMm: finalHost.elevationMm,
        surfaceHostId: finalHost.surfaceHostId,
      };
      const hostZ = getEffectiveFurnitureZOrder(hostObj, 0);
      const curZ = getEffectiveFurnitureZOrder(furn, 0);
      if (furn.surfaceHostId !== finalHost.surfaceHostId || curZ <= hostZ) {
        nextZOrder = computeLocalStackPlacementZOrder(
          movedCandidate,
          otherFurniture,
          finalHost.surfaceHostId
        );
      }
      placingOnHostName = hostObj.name;
      finalLabel = finalLabel ? `${finalLabel} · On ${hostObj.name}` : `On ${hostObj.name}`;
      attachmentPreview = {
        kind: 'surface',
        label: `On ${hostObj.name}`,
        surfaceHostId: hostObj.id,
        surfacePolygon: getFurnitureOrientedCorners({ x: hostObj.xMm, y: hostObj.yMm }, hostObj),
      };
    }
  } else if (!isRugFurniture(furn)) {
    const movedCandidate: FurnitureInstance = {
      ...furn,
      xMm: Math.round(curPos.x),
      yMm: Math.round(curPos.y),
      rotationDeg: curRot,
      elevationMm: finalHost.elevationMm,
      surfaceHostId: undefined,
    };
    const localZ = computeLocalStackPlacementZOrder(movedCandidate, otherFurniture);
    if (localZ === 0 || typeof nextZOrder !== 'number' || nextZOrder > localZ) {
      nextZOrder = localZ;
    }
  }

  const finalFurnForClash: FurnitureInstance = {
    ...furn,
    xMm: Math.round(curPos.x),
    yMm: Math.round(curPos.y),
    rotationDeg: curRot,
    elevationMm: finalHost.elevationMm,
    surfaceHostId: finalHost.surfaceHostId,
  };
  const clashingNames = detectFurnitureClashesAt(
    { x: Math.round(curPos.x), y: Math.round(curPos.y) },
    finalFurnForClash,
    otherFurniture
  );

  return {
    xMm: Math.round(curPos.x),
    yMm: Math.round(curPos.y),
    rotationDeg: curRot,
    elevationMm: finalHost.elevationMm,
    surfaceHostId: finalHost.surfaceHostId,
    rawSurfaceHostCandidateId: initialHost.rawCandidateId ?? finalHost.rawCandidateId,
    attachedWallId: nextAttachedWallId,
    attachedFace: nextAttachedFace,
    attachedT: nextAttachedT,
    zOrder: nextZOrder,
    snappedKind: snap.snappedKind,
    snapLabel: finalLabel,
    snapKey: snap.snapKey,
    hysteresis: snap.hysteresis,
    guides: snap.guides,
    attachmentPreview,
    roomCenterSnap: snap.roomCenterSnap,
    clashingNames,
    isForceFloor: Boolean(options.forceFloor),
    placingOnHostName,
    stackCandidates: finalHost.candidates.map((c) => ({
      hostId: c.host.id,
      hostName: c.host.name,
      deckHeightMm: c.deckHeightMm,
    })),
  };
}

export interface CutThroughProjectedPart {
  part: FurniturePart;
  viewX: number;
  elevW: number;
  elevH: number;
  zBottom: number;
  outCenter: number;
  outBack: number;
  outFront: number;
  elevPolygon?: Point2D[];
}

export interface WallViewFurnitureProjection {
  viewId: Exclude<ProjectionViewId, 'top'>;
  flipX: boolean;
  hasTilt?: boolean;
  viewXCenter: number;
  elevW: number;
  elevH: number;
  zBottom: number;
}

export type CutThroughFurnitureResult =
  | { status: 'hidden' }
  | { status: 'opposite_side' }
  | {
      status: 'visible';
      item: FurnitureInstance;
      perpDistMm: number;
      visibleParts: CutThroughProjectedPart[];
      projection?: WallViewFurnitureProjection;
    };

interface ElevRect {
  x1: number;
  x2: number;
  z1: number;
  z2: number;
}

function subtractElevRect(rects: ElevRect[], cut: ElevRect): ElevRect[] {
  const out: ElevRect[] = [];
  for (const r of rects) {
    const ix1 = Math.max(r.x1, cut.x1);
    const ix2 = Math.min(r.x2, cut.x2);
    const iz1 = Math.max(r.z1, cut.z1);
    const iz2 = Math.min(r.z2, cut.z2);
    if (ix1 >= ix2 - 0.1 || iz1 >= iz2 - 0.1) {
      out.push(r);
      continue;
    }
    if (r.x1 < ix1 - 0.1) out.push({ x1: r.x1, x2: ix1, z1: r.z1, z2: r.z2 });
    if (r.x2 > ix2 + 0.1) out.push({ x1: ix2, x2: r.x2, z1: r.z1, z2: r.z2 });
    if (r.z1 < iz1 - 0.1) out.push({ x1: ix1, x2: ix2, z1: r.z1, z2: iz1 });
    if (r.z2 > iz2 + 0.1) out.push({ x1: ix1, x2: ix2, z1: iz2, z2: r.z2 });
  }
  return out;
}

/**
 * Projects a furniture item onto a wall's Cut-Through elevation plane within maxDistMm
 * (default 700 mm / 0.7 m) and culls back/interior parts occluded from the viewing angle.
 */
export function projectFurnitureForWallCutThrough(
  wall: Wall,
  faceSide: 'inner' | 'outer' | 'left' | 'right',
  furn: FurnitureInstance,
  roomCeilingHeightMm: number,
  maxDistMm = 700
): CutThroughFurnitureResult {
  if (!furn.visible || furn.parts.length === 0) return { status: 'hidden' };

  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const lenMm = Math.max(100, getWallArcLength(wall));
  const straightLen = Math.hypot(dx, dy) || 1;
  const ux = dx / straightLen;
  const uy = dy / straightLen;
  const nx = -uy;
  const ny = ux;

  const isLeftView = faceSide === 'inner' || faceSide === 'left';
  const faceOffsets = wallOffsets(wall.thicknessMm, wall.alignment);
  const viewedFacePerp = isLeftView ? faceOffsets.left : faceOffsets.right;
  const outN = isLeftView ? { x: nx, y: ny } : { x: -nx, y: -ny };

  const placement = getFurniturePlacement(furn, { effectiveCeilingMm: roomCeilingHeightMm });
  const furnFloorOffsetMm = placement.elevationSpanMm.minZ;

  let minS = Infinity;
  let maxS = -Infinity;
  let minOut = Infinity;
  let maxOut = -Infinity;
  let minSignedPerp = Infinity;
  let maxSignedPerp = -Infinity;

  const projectedAll: Array<CutThroughProjectedPart & { canOcclude: boolean }> = [];

  for (const p of furn.parts) {
    let pMinS = Infinity;
    let pMaxS = -Infinity;
    let pMinOut = Infinity;
    let pMaxOut = -Infinity;
    let pMinSigned = Infinity;
    let pMaxSigned = -Infinity;
    let pMinZ = Infinity;
    let pMaxZ = -Infinity;
    const rawElevPts: Point2D[] = [];

    for (const v of getPartFurnitureLocalBoundary3D(p, furn.templateId)) {
      const wPt = placement.localToWorld3D(v.x, v.y, v.z);
      const rx = wPt.x - wall.start.x;
      const ry = wPt.y - wall.start.y;
      const cS = rx * ux + ry * uy;
      const cSigned = rx * nx + ry * ny;
      const cOut = isLeftView ? cSigned - viewedFacePerp : viewedFacePerp - cSigned;
      if (cS < pMinS) pMinS = cS;
      if (cS > pMaxS) pMaxS = cS;
      if (cOut < pMinOut) pMinOut = cOut;
      if (cOut > pMaxOut) pMaxOut = cOut;
      if (cSigned < pMinSigned) pMinSigned = cSigned;
      if (cSigned > pMaxSigned) pMaxSigned = cSigned;
      if (wPt.z < pMinZ) pMinZ = wPt.z;
      if (wPt.z > pMaxZ) pMaxZ = wPt.z;
      const partYawMod = Math.abs((((furn.rotationDeg + p.rotationDeg) % 90) + 90) % 90);
      const nonCardinalCurved =
        partYawMod > 0.5 &&
        partYawMod < 89.5 &&
        (p.shape === 'arc' || p.shape === 'l_profile' || p.shape === 'u_profile' || p.detailStyle === 'caster_base');
      if (placement.hasTilt || p.shape === 'wedge' || p.shape === 'sphere' || nonCardinalCurved) {
        rawElevPts.push({ x: isLeftView ? cS : lenMm - cS, y: -wPt.z });
      }
    }

    const partS = (pMinS + pMaxS) / 2;
    const halfElevW = Math.max(2.5, (pMaxS - pMinS) / 2);
    const partOut = (pMinOut + pMaxOut) / 2;
    const halfOutD = Math.max(2.5, (pMaxOut - pMinOut) / 2);
    const signedPerp = (pMinSigned + pMaxSigned) / 2;
    const zBottom = pMinZ;
    const elevH = Math.max(5, pMaxZ - pMinZ);

    minS = Math.min(minS, partS - halfElevW);
    maxS = Math.max(maxS, partS + halfElevW);
    minOut = Math.min(minOut, partOut - halfOutD);
    maxOut = Math.max(maxOut, partOut + halfOutD);
    minSignedPerp = Math.min(minSignedPerp, signedPerp - halfOutD);
    maxSignedPerp = Math.max(maxSignedPerp, signedPerp + halfOutD);

    const viewX = isLeftView ? partS : lenMm - partS;
    const elevW = Math.max(5, halfElevW * 2);
    const elevPolygon =
      rawElevPts.length >= 3 ? computeConvexHull2D(rawElevPts) : undefined;

    const canOcclude =
      p.material !== 'glass' &&
      p.shape !== 'arc' &&
      p.shape !== 'wedge' &&
      p.heightMm >= 5 &&
      p.widthMm >= 10 &&
      p.depthMm >= 10;

    projectedAll.push({
      part: p,
      viewX,
      elevW,
      elevH,
      zBottom,
      outCenter: partOut,
      outBack: partOut - halfOutD,
      outFront: partOut + halfOutD,
      elevPolygon,
      canOcclude,
    });
  }

  // Must overlap horizontally along the wall segment
  if (maxS <= 0 || minS >= lenMm) return { status: 'hidden' };

  // True geometric wall-thickness occlusion: anything behind the viewed wall face surface
  // (never emerging past the viewed surface toward the camera, or centered behind the wall core
  // without extending substantially into the viewed room) is occluded by the opaque wall.
  const centerOut = (minOut + maxOut) * 0.5;
  const wallHalfThick = Math.max(20, wall.thicknessMm * 0.5);
  const behindViewedFace = maxOut <= 4 || (centerOut < -wallHalfThick && maxOut <= 15);
  if (behindViewedFace) {
    return centerOut < -wallHalfThick * 0.4 ? { status: 'opposite_side' } : { status: 'hidden' };
  }

  const perpDistMm = Math.max(0, minOut);
  if (perpDistMm > maxDistMm) {
    return { status: 'hidden' };
  }

  // Filter out individual parts completely behind the viewed face so rear appendages cannot bleed through
  const unoccludedParts = projectedAll.filter((part) => part.outFront > 2);
  if (unoccludedParts.length === 0) {
    return { status: 'opposite_side' };
  }

  // Cull parts whose entire projected elevation face is hidden behind closer opaque parts
  const frontToBack = [...unoccludedParts].sort(
    (a, b) => b.outCenter - a.outCenter || b.outFront - a.outFront || b.zBottom - a.zBottom
  );

  const visibleParts: CutThroughProjectedPart[] = [];
  for (let i = 0; i < frontToBack.length; i++) {
    const cand = frontToBack[i];
    const insetX = Math.min(3, cand.elevW * 0.15);
    const insetZ = Math.min(3, cand.elevH * 0.15);
    const candRect: ElevRect = {
      x1: cand.viewX - cand.elevW / 2 + insetX,
      x2: cand.viewX + cand.elevW / 2 - insetX,
      z1: cand.zBottom + insetZ,
      z2: cand.zBottom + cand.elevH - insetZ,
    };
    const candArea = Math.max(1, (candRect.x2 - candRect.x1) * (candRect.z2 - candRect.z1));
    let uncovered: ElevRect[] = [candRect];

    for (let j = 0; j < i && uncovered.length > 0; j++) {
      const blocker = frontToBack[j];
      if (!blocker.canOcclude) continue;
      // Blocker must sit genuinely in front of candidate relative to the cut-through angle
      if (blocker.outCenter <= cand.outCenter + 2 || blocker.outFront < cand.outFront - 2) {
        continue;
      }
      uncovered = subtractElevRect(uncovered, {
        x1: blocker.viewX - blocker.elevW / 2,
        x2: blocker.viewX + blocker.elevW / 2,
        z1: blocker.zBottom,
        z2: blocker.zBottom + blocker.elevH,
      });
    }

    const remArea = uncovered.reduce((s, r) => s + Math.max(0, r.x2 - r.x1) * Math.max(0, r.z2 - r.z1), 0);
    if (remArea / candArea > 0.02) {
      visibleParts.push({
        part: cand.part,
        viewX: cand.viewX,
        elevW: cand.elevW,
        elevH: cand.elevH,
        zBottom: cand.zBottom,
        outCenter: cand.outCenter,
        outBack: cand.outBack,
        outFront: cand.outFront,
        elevPolygon: cand.elevPolygon,
      });
    }
  }

  // Render strictly back-to-front (painter's order from cut-through viewing angle)
  visibleParts.sort(
    (a, b) => a.outCenter - b.outCenter || a.outFront - b.outFront || a.zBottom - b.zBottom
  );

  const dirMatch = resolveWallViewProjectionForFurniture(wall, faceSide, furn);
  const elevW = Math.max(5, maxS - minS);
  const viewXCenter = isLeftView ? (minS + maxS) / 2 : lenMm - (minS + maxS) / 2;
  const minPartZ = unoccludedParts.reduce((m, p) => Math.min(m, p.zBottom), Infinity);
  const maxPartZ = unoccludedParts.reduce((m, p) => Math.max(m, p.zBottom + p.elevH), -Infinity);

  return {
    status: 'visible',
    item: furn,
    perpDistMm,
    visibleParts,
    projection: {
      viewId: dirMatch.viewId,
      flipX: dirMatch.flipX,
      hasTilt: placement.hasTilt,
      viewXCenter,
      elevW,
      elevH: Math.max(5, maxPartZ - minPartZ),
      zBottom: Number.isFinite(minPartZ) ? minPartZ : furnFloorOffsetMm,
    },
  };
}

/**
 * Selects which canonical vertical elevation ('front' | 'rear' | 'left' | 'right')
 * faces the Wall View camera and whether it should be horizontally flipped due to mirroring.
 */
export function resolveWallViewProjectionForFurniture(
  wall: Wall,
  faceSide: 'inner' | 'outer' | 'left' | 'right',
  furn: Pick<FurnitureInstance, 'rotationDeg' | 'mirroredX' | 'mirroredY'>
): { viewId: Exclude<ProjectionViewId, 'top'>; flipX: boolean } {
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const straightLen = Math.hypot(dx, dy) || 1;
  const ux = dx / straightLen;
  const uy = dy / straightLen;
  const nx = -uy;
  const ny = ux;

  const isLeftView = faceSide === 'inner' || faceSide === 'left';
  // Outward normal from viewed wall face toward camera
  const outN = isLeftView ? { x: nx, y: ny } : { x: -nx, y: -ny };
  // Screen right vector in Wall View coordinates
  const screenRight = isLeftView ? { x: ux, y: uy } : { x: -ux, y: -uy };

  const radF = (furn.rotationDeg * Math.PI) / 180;
  const cosF = Math.cos(radF);
  const sinF = Math.sin(radF);
  const mx = furn.mirroredX ? -1 : 1;
  const my = furn.mirroredY ? -1 : 1;

  // Furniture local axes in 2D world coordinates
  const localX = { x: mx * cosF, y: mx * sinF };
  const localY = { x: -my * sinF, y: my * cosF };

  const candidates: Array<{
    viewId: Exclude<ProjectionViewId, 'top'>;
    normal: Point2D;
    rightAxis: Point2D;
  }> = [
    { viewId: 'front', normal: localY, rightAxis: localX },
    { viewId: 'rear', normal: { x: -localY.x, y: -localY.y }, rightAxis: { x: -localX.x, y: -localX.y } },
    { viewId: 'left', normal: { x: -localX.x, y: -localX.y }, rightAxis: localY },
    { viewId: 'right', normal: localX, rightAxis: { x: -localY.x, y: -localY.y } },
  ];

  let best = candidates[0];
  let bestDot = -Infinity;
  for (const c of candidates) {
    const d = c.normal.x * outN.x + c.normal.y * outN.y;
    if (d > bestDot) {
      bestDot = d;
      best = c;
    }
  }

  const rightDot = best.rightAxis.x * screenRight.x + best.rightAxis.y * screenRight.y;
  return {
    viewId: best.viewId,
    flipX: rightDot < 0,
  };
}

// ============================================================================
// ARCHITECTURAL BLOCK EDGE-TO-EDGE FLUSH SNAPPING
// ============================================================================

export interface ArchElementSnapResult {
  xMm: number;
  yMm: number;
  snappedKind: 'wall' | 'align' | 'grid' | 'none';
  snapLabel?: string;
  snapKey?: string;
  hysteresis?: SnapHysteresisState;
  guides: AlignmentGuide[];
}

function getArchWorldAabb(
  xMm: number,
  yMm: number,
  widthMm: number,
  depthMm: number,
  rotationDeg: number
): { minX: number; maxX: number; minY: number; maxY: number; cx: number; cy: number } {
  const rad = (rotationDeg * Math.PI) / 180;
  const hw = widthMm / 2;
  const hd = depthMm / 2;
  const extX = hw * Math.abs(Math.cos(rad)) + hd * Math.abs(Math.sin(rad));
  const extY = hw * Math.abs(Math.sin(rad)) + hd * Math.abs(Math.cos(rad));
  return {
    minX: xMm - extX,
    maxX: xMm + extX,
    minY: yMm - extY,
    maxY: yMm + extY,
    cx: xMm,
    cy: yMm,
  };
}

/**
 * Snaps architectural blocks (platforms, balconies, columns, beams, fireplaces, stairs, etc.)
 * cleanly edge-to-edge flush against neighboring architectural blocks and wall faces.
 */
export function snapArchElementToPlan(
  targetPos: Point2D,
  el: Pick<ArchElement, 'id' | 'name' | 'widthMm' | 'depthMm' | 'rotationDeg'>,
  walls: Wall[],
  otherArchElements: ArchElement[],
  options: {
    snapEnabled: boolean;
    gridSizeMm: number;
    blockTolMm?: number;
    wallTolMm?: number;
    hysteresis?: SnapHysteresisState;
  }
): ArchElementSnapResult {
  let curX = Math.round(targetPos.x);
  let curY = Math.round(targetPos.y);
  const guides: AlignmentGuide[] = [];
  const nextHyst: SnapHysteresisState = { ...(options.hysteresis ?? {}) };

  if (!options.snapEnabled) {
    return { xMm: curX, yMm: curY, snappedKind: 'none', hysteresis: {}, guides };
  }

  const blockTol = options.blockTolMm ?? 95;
  const wallTol = options.wallTolMm ?? 85;
  const self = getArchWorldAabb(curX, curY, el.widthMm, el.depthMm, el.rotationDeg);
  const others = otherArchElements.filter((a) => a.id !== el.id && a.visible !== false);

  let lockedX = false;
  let lockedY = false;
  let snappedKind: ArchElementSnapResult['snappedKind'] = 'none';
  let snapLabel: string | undefined;

  type ArchSnapCand = { delta: number; guide: AlignmentGuide; text: string; name: string };
  const candsX: Array<{ key: string; dist: number; data: ArchSnapCand }> = [];
  const candsY: Array<{ key: string; dist: number; data: ArchSnapCand }> = [];

  for (const ob of others) {
    const obBox = getArchWorldAabb(ob.xMm, ob.yMm, ob.widthMm, ob.depthMm, ob.rotationDeg);
    const yOverlap = Math.min(self.maxY, obBox.maxY) - Math.max(self.minY, obBox.minY);
    const xOverlap = Math.min(self.maxX, obBox.maxX) - Math.max(self.minX, obBox.minX);

    if (yOverlap >= -350) {
      const specsX: Array<{ tag: string; delta: number; coord: number; text: string; bias: number }> = [
        { tag: 'FR', delta: obBox.maxX - self.minX, coord: obBox.maxX, text: 'FLUSH', bias: 0 },
        { tag: 'FL', delta: obBox.minX - self.maxX, coord: obBox.minX, text: 'FLUSH', bias: 0 },
        { tag: 'AL', delta: obBox.minX - self.minX, coord: obBox.minX, text: 'ALIGN', bias: 14 },
        { tag: 'AR', delta: obBox.maxX - self.maxX, coord: obBox.maxX, text: 'ALIGN', bias: 14 },
        { tag: 'CX', delta: obBox.cx - self.cx, coord: obBox.cx, text: 'CENTER', bias: 18 },
      ];
      for (const s of specsX) {
        const d = Math.abs(s.delta);
        if (d + s.bias <= blockTol * 1.45) {
          candsX.push({
            key: `archX_${ob.id}_${s.tag}`,
            dist: d + s.bias,
            data: {
              delta: s.delta,
              text: s.text,
              name: ob.name,
              guide: {
                axis: 'x',
                from: { x: s.coord, y: Math.min(self.minY, obBox.minY) },
                to: { x: s.coord, y: Math.max(self.maxY, obBox.maxY) },
                coordMm: s.coord,
                label: s.text,
              },
            },
          });
        }
      }
    }

    if (xOverlap >= -350) {
      const specsY: Array<{ tag: string; delta: number; coord: number; text: string; bias: number }> = [
        { tag: 'FB', delta: obBox.maxY - self.minY, coord: obBox.maxY, text: 'FLUSH', bias: 0 },
        { tag: 'FT', delta: obBox.minY - self.maxY, coord: obBox.minY, text: 'FLUSH', bias: 0 },
        { tag: 'AT', delta: obBox.minY - self.minY, coord: obBox.minY, text: 'ALIGN', bias: 14 },
        { tag: 'AB', delta: obBox.maxY - self.maxY, coord: obBox.maxY, text: 'ALIGN', bias: 14 },
        { tag: 'CY', delta: obBox.cy - self.cy, coord: obBox.cy, text: 'CENTER', bias: 18 },
      ];
      for (const s of specsY) {
        const d = Math.abs(s.delta);
        if (d + s.bias <= blockTol * 1.45) {
          candsY.push({
            key: `archY_${ob.id}_${s.tag}`,
            dist: d + s.bias,
            data: {
              delta: s.delta,
              text: s.text,
              name: ob.name,
              guide: {
                axis: 'y',
                from: { x: Math.min(self.minX, obBox.minX), y: s.coord },
                to: { x: Math.max(self.maxX, obBox.maxX), y: s.coord },
                coordMm: s.coord,
                label: s.text,
              },
            },
          });
        }
      }
    }
  }

  const pickedX = pickWithSnapHysteresis(candsX, nextHyst.alignXKey, blockTol);
  const pickedY = pickWithSnapHysteresis(candsY, nextHyst.alignYKey, blockTol);
  nextHyst.alignXKey = pickedX?.key;
  nextHyst.alignYKey = pickedY?.key;

  if (pickedX) {
    curX = Math.round(curX + pickedX.data.delta);
    lockedX = true;
    guides.push(pickedX.data.guide);
    snappedKind = 'align';
    snapLabel = `${pickedX.data.text === 'FLUSH' ? 'Flush' : 'Aligned'} w/ ${pickedX.data.name}`;
  }
  if (pickedY) {
    curY = Math.round(curY + pickedY.data.delta);
    lockedY = true;
    guides.push(pickedY.data.guide);
    snappedKind = 'align';
    snapLabel = snapLabel
      ? `${snapLabel} · Corner`
      : `${pickedY.data.text === 'FLUSH' ? 'Flush' : 'Aligned'} w/ ${pickedY.data.name}`;
  }

  // Orthogonal wall face flush on remaining free axes
  let pickedWallXKey: string | undefined;
  let pickedWallYKey: string | undefined;
  if (!lockedX || !lockedY) {
    const updated = getArchWorldAabb(curX, curY, el.widthMm, el.depthMm, el.rotationDeg);
    const wallXCands: Array<{ key: string; dist: number; data: { delta: number; coord: number } }> = [];
    const wallYCands: Array<{ key: string; dist: number; data: { delta: number; coord: number } }> = [];
    for (const w of walls) {
      if (w.visible === false || w.isCurved) continue;
      const dx = w.end.x - w.start.x;
      const dy = w.end.y - w.start.y;
      const { left, right } = wallOffsets(w.thicknessMm, w.alignment);
      if (Math.abs(dy) < 5 && !lockedY) {
        const wMinX = Math.min(w.start.x, w.end.x);
        const wMaxX = Math.max(w.start.x, w.end.x);
        if (updated.maxX >= wMinX - 150 && updated.minX <= wMaxX + 150) {
          const sign = dx >= 0 ? 1 : -1;
          const facesY = [w.start.y + left * sign, w.start.y + right * sign];
          facesY.forEach((fy, fIdx) => {
            [fy - updated.minY, fy - updated.maxY].forEach((delta, dIdx) => {
              if (Math.abs(delta) <= wallTol * 1.45) {
                wallYCands.push({
                  key: `awY_${w.id}_${fIdx}_${dIdx}`,
                  dist: Math.abs(delta),
                  data: { delta, coord: fy },
                });
              }
            });
          });
        }
      }
      if (Math.abs(dx) < 5 && !lockedX) {
        const wMinY = Math.min(w.start.y, w.end.y);
        const wMaxY = Math.max(w.start.y, w.end.y);
        if (updated.maxY >= wMinY - 150 && updated.minY <= wMaxY + 150) {
          const sign = dy >= 0 ? -1 : 1;
          const facesX = [w.start.x + left * sign, w.start.x + right * sign];
          facesX.forEach((fx, fIdx) => {
            [fx - updated.minX, fx - updated.maxX].forEach((delta, dIdx) => {
              if (Math.abs(delta) <= wallTol * 1.45) {
                wallXCands.push({
                  key: `awX_${w.id}_${fIdx}_${dIdx}`,
                  dist: Math.abs(delta),
                  data: { delta, coord: fx },
                });
              }
            });
          });
        }
      }
    }

    const pickedWallX = !lockedX
      ? pickWithSnapHysteresis(wallXCands, nextHyst.furnFlushXKey, wallTol)
      : null;
    const pickedWallY = !lockedY
      ? pickWithSnapHysteresis(wallYCands, nextHyst.furnFlushYKey, wallTol)
      : null;
    nextHyst.furnFlushXKey = pickedWallX?.key;
    nextHyst.furnFlushYKey = pickedWallY?.key;
    pickedWallXKey = pickedWallX?.key;
    pickedWallYKey = pickedWallY?.key;

    if (pickedWallX && !lockedX) {
      curX = Math.round(curX + pickedWallX.data.delta);
      lockedX = true;
      guides.push({
        axis: 'x',
        from: { x: pickedWallX.data.coord, y: updated.minY },
        to: { x: pickedWallX.data.coord, y: updated.maxY },
        coordMm: pickedWallX.data.coord,
        label: 'WALL FLUSH',
      });
      if (snappedKind === 'none') snappedKind = 'wall';
      if (!snapLabel) snapLabel = 'Wall Flush';
    }
    if (pickedWallY && !lockedY) {
      curY = Math.round(curY + pickedWallY.data.delta);
      lockedY = true;
      guides.push({
        axis: 'y',
        from: { x: updated.minX, y: pickedWallY.data.coord },
        to: { x: updated.maxX, y: pickedWallY.data.coord },
        coordMm: pickedWallY.data.coord,
        label: 'WALL FLUSH',
      });
      if (snappedKind === 'none') snappedKind = 'wall';
      if (!snapLabel) snapLabel = 'Wall Flush';
    }
  } else {
    nextHyst.furnFlushXKey = undefined;
    nextHyst.furnFlushYKey = undefined;
  }

  const g = Math.max(10, options.gridSizeMm || 50);
  if (!lockedX) {
    curX = Math.round(curX / g) * g;
    if (snappedKind === 'none') snappedKind = 'grid';
  }
  if (!lockedY) {
    curY = Math.round(curY / g) * g;
    if (snappedKind === 'none') snappedKind = 'grid';
  }

  const snapKey =
    pickedX || pickedY || pickedWallXKey || pickedWallYKey
      ? `${pickedX?.key ?? ''}|${pickedY?.key ?? ''}|${pickedWallXKey ?? ''}|${pickedWallYKey ?? ''}`
      : undefined;

  return { xMm: curX, yMm: curY, snappedKind, snapLabel, snapKey, hysteresis: nextHyst, guides };
}

/**
 * Snaps a standalone Curtain object exclusively onto the nearest straight wall face.
 */
export function snapStandaloneCurtainToWall(
  targetPos: Point2D,
  curtain: Pick<Curtain, 'widthMm' | 'rotationDeg'> & Partial<Pick<Curtain, 'wallId'>>,
  walls: Wall[]
): { xMm: number; yMm: number; rotationDeg: number; wallId?: string; snapped: boolean } {
  const visibleWalls = walls.filter((w) => w.visible !== false && !w.isCurved && getWallArcLength(w) >= 40);
  if (visibleWalls.length === 0) {
    return {
      xMm: Math.round(targetPos.x),
      yMm: Math.round(targetPos.y),
      rotationDeg: curtain.rotationDeg,
      snapped: false,
    };
  }

  let best: { x: number; y: number; rot: number; wallId: string; dist: number } | null = null;
  const hw = Math.max(100, curtain.widthMm / 2);
  const standOff = 55;

  for (const w of visibleWalls) {
    const wallLen = getWallArcLength(w);
    const ux = (w.end.x - w.start.x) / wallLen;
    const uy = (w.end.y - w.start.y) / wallLen;
    const nx = -uy;
    const ny = ux;
    const { left, right } = wallOffsets(w.thicknessMm, w.alignment);
    const wallMid = (left + right) / 2;
    const dNorm = (targetPos.x - w.start.x) * nx + (targetPos.y - w.start.y) * ny;
    const wallAngleDeg = (Math.atan2(uy, ux) * 180) / Math.PI;
    let onLeft = dNorm >= wallMid;
    if (curtain.wallId === w.id) {
      const leftDiff = Math.abs((((curtain.rotationDeg - wallAngleDeg) % 360) + 540) % 360 - 180);
      const prevWasLeft = leftDiff <= 90;
      onLeft = prevWasLeft ? dNorm >= right - 25 : dNorm > left + 25;
    }
    const faceOffset = onLeft ? left + standOff : right - standOff;

    const sRaw = (targetPos.x - w.start.x) * ux + (targetPos.y - w.start.y) * uy;
    const spanMin = hw * 2 <= wallLen ? hw : 0;
    const spanMax = hw * 2 <= wallLen ? wallLen - hw : wallLen;
    const clampedS = Math.max(spanMin, Math.min(spanMax, sRaw));

    const sx = w.start.x + ux * clampedS + nx * faceOffset;
    const sy = w.start.y + uy * clampedS + ny * faceOffset;
    const dTarget = Math.hypot(sx - targetPos.x, sy - targetPos.y);
    const rot = Math.round(((onLeft ? wallAngleDeg : wallAngleDeg + 180) % 360 + 360) % 360);

    if (!best || dTarget < best.dist) {
      best = { x: sx, y: sy, rot, wallId: w.id, dist: dTarget };
    }
  }

  if (!best) {
    return {
      xMm: Math.round(targetPos.x),
      yMm: Math.round(targetPos.y),
      rotationDeg: curtain.rotationDeg,
      snapped: false,
    };
  }

  return {
    xMm: Math.round(best.x),
    yMm: Math.round(best.y),
    rotationDeg: best.rot,
    wallId: best.wallId,
    snapped: true,
  };
}

function pointToPolygonEdgeDistanceMm(pt: Point2D, poly: Point2D[]): number {
  if (poly.length < 3) return Infinity;
  if (pointInPolygon(pt, poly)) return 0;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const proj = projectPointOnSegment(pt, a, b);
    if (proj.distance < best) best = proj.distance;
  }
  return best;
}

/**
 * Returns the room connected to a balcony slab (overlapping or touching within exterior-wall tolerance).
 * Returns null if the balcony is placed standalone in open space without touching any main floor room.
 */
export function findConnectedRoomForBalcony(
  balcony: Pick<ArchElement, 'type' | 'xMm' | 'yMm' | 'widthMm' | 'depthMm' | 'rotationDeg' | 'visible'>,
  rooms: Room[],
  walls: Wall[] = [],
  tolMm = 320
): Room | null {
  if (balcony.type !== 'balcony' || balcony.visible === false || rooms.length === 0) {
    return null;
  }

  const maxWallThick = walls.reduce(
    (mx, w) => (w.visible !== false ? Math.max(mx, w.thicknessMm) : mx),
    200
  );
  const effectiveTol = Math.max(tolMm, maxWallThick + 80);

  const corners = getChimneyWorldCorners(
    balcony.xMm,
    balcony.yMm,
    balcony.widthMm,
    balcony.depthMm,
    balcony.rotationDeg
  );
  const samplePts: Point2D[] = [...corners];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    samplePts.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  }
  samplePts.push({ x: balcony.xMm, y: balcony.yMm });

  let bestRoom: Room | null = null;
  let bestDist = Infinity;

  for (const room of rooms) {
    if (!room.visible || room.polygon.length < 3) continue;
    let minD = Infinity;
    for (const sp of samplePts) {
      const d = pointToPolygonEdgeDistanceMm(sp, room.polygon);
      if (d < minD) minD = d;
      if (minD === 0) break;
    }
    if (minD > 0) {
      for (const rv of room.polygon) {
        const d = pointToPolygonEdgeDistanceMm(rv, corners);
        if (d < minD) minD = d;
        if (minD === 0) break;
      }
    }
    if (minD <= effectiveTol) {
      const betterDistance = minD < bestDist - 1;
      const sameDistPreferCeiling =
        Math.abs(minD - bestDist) <= 1 && !!room.hasCeiling && !bestRoom?.hasCeiling;
      if (!bestRoom || betterDistance || sameDistPreferCeiling) {
        bestRoom = room;
        bestDist = minD;
      }
    }
  }

  return bestRoom;
}

// ============================================================================
// AUTOMATIC WALL FACE IDENTIFICATION, ROOM ASSOCIATION & FLIP FACE
// ============================================================================

export interface ResolvedWallFaceInfo {
  id: 'inner' | 'outer';
  physicalSide: 'left' | 'right';
  slot: 'inner' | 'outer';
  label: string;
  subtitle: string;
  roomId?: string;
  roomName?: string;
  isRoomFacing: boolean;
}

export interface ResolvedWallFaces {
  kind: 'single_room' | 'shared' | 'freestanding';
  orientationFlipped: boolean;
  /** Physical +normal ('left') face */
  left: ResolvedWallFaceInfo;
  /** Physical -normal ('right') face */
  right: ResolvedWallFaceInfo;
  /** Primary editable/viewable face (room-facing Inner for single-room walls) */
  primary: ResolvedWallFaceInfo;
  /** Secondary editable/viewable face */
  secondary: ResolvedWallFaceInfo;
}

function findContainingRoomForPoint(pt: Point2D, visibleRooms: Room[]): Room | null {
  let best: Room | null = null;
  let bestArea = Infinity;
  for (const r of visibleRooms) {
    if (pointInPolygon(pt, r.polygon)) {
      const area = r.areaM2 > 0 ? r.areaM2 : Math.abs(computePolygonAreaM2(r.polygon));
      if (area < bestArea) {
        bestArea = area;
        best = r;
      }
    }
  }
  return best;
}

/**
 * Automatically identifies which physical side (+normal left vs -normal right) borders
 * enclosing room(s), dynamically resolving room names for shared walls and Inner/Outer
 * for single-room or freestanding walls without mutating geometry.
 */
export function resolveWallFaces(wall: Wall, rooms: Room[]): ResolvedWallFaces {
  const visibleRooms = rooms.filter((r) => r.visible !== false && r.polygon.length >= 3);
  const { left: offLeft, right: offRight } = wallOffsets(wall.thicknessMm, wall.alignment);
  const primaryProbe = Math.max(85, Math.min(240, wall.thicknessMm * 0.55));
  const probeDists = [primaryProbe, 42];
  const sampleTs = [0.22, 0.36, 0.5, 0.64, 0.78];

  const leftVotes = new Map<string, { room: Room; count: number }>();
  const rightVotes = new Map<string, { room: Room; count: number }>();

  if (visibleRooms.length > 0 && getWallArcLength(wall) >= 20) {
    for (const t of sampleTs) {
      const { point, normal } = getWallCenterlinePoint(wall, t);
      for (const pDist of probeDists) {
        const lPt = {
          x: point.x + normal.x * (offLeft + pDist),
          y: point.y + normal.y * (offLeft + pDist),
        };
        const rPt = {
          x: point.x + normal.x * (offRight - pDist),
          y: point.y + normal.y * (offRight - pDist),
        };
        const lRoom = findContainingRoomForPoint(lPt, visibleRooms);
        if (lRoom) {
          const prev = leftVotes.get(lRoom.id);
          leftVotes.set(lRoom.id, { room: lRoom, count: (prev?.count ?? 0) + (pDist === primaryProbe ? 2 : 1) });
        }
        const rRoom = findContainingRoomForPoint(rPt, visibleRooms);
        if (rRoom) {
          const prev = rightVotes.get(rRoom.id);
          rightVotes.set(rRoom.id, { room: rRoom, count: (prev?.count ?? 0) + (pDist === primaryProbe ? 2 : 1) });
        }
      }
    }
  }

  const pickBest = (votes: Map<string, { room: Room; count: number }>): Room | null => {
    let best: { room: Room; count: number } | null = null;
    for (const v of votes.values()) {
      if (!best || v.count > best.count) best = v;
    }
    return best?.room ?? null;
  };

  const leftRoom = pickBest(leftVotes);
  const rightRoom = pickBest(rightVotes);
  const flipped = Boolean(wall.faceFlipped);

  // Shared wall separating two distinct rooms
  if (leftRoom && rightRoom && leftRoom.id !== rightRoom.id) {
    const leftName = leftRoom.name.trim() || 'Room A';
    const rightName = rightRoom.name.trim() || 'Room B';
    const leftInfo: ResolvedWallFaceInfo = {
      id: 'inner',
      physicalSide: 'left',
      slot: 'inner',
      label: leftName,
      subtitle: `Shared · Facing ${leftName}`,
      roomId: leftRoom.id,
      roomName: leftName,
      isRoomFacing: true,
    };
    const rightInfo: ResolvedWallFaceInfo = {
      id: 'outer',
      physicalSide: 'right',
      slot: 'outer',
      label: rightName,
      subtitle: `Shared · Facing ${rightName}`,
      roomId: rightRoom.id,
      roomName: rightName,
      isRoomFacing: true,
    };
    return {
      kind: 'shared',
      orientationFlipped: flipped,
      left: leftInfo,
      right: rightInfo,
      primary: flipped ? rightInfo : leftInfo,
      secondary: flipped ? leftInfo : rightInfo,
    };
  }

  // Single-room wall (one side faces room, opposite side is exterior/outside)
  if ((leftRoom && !rightRoom) || (rightRoom && !leftRoom)) {
    const roomOnLeft = Boolean(leftRoom && !rightRoom);
    const room = (roomOnLeft ? leftRoom : rightRoom)!;
    const roomName = room.name.trim() || 'Room';
    const innerInfo: ResolvedWallFaceInfo = {
      id: 'inner',
      physicalSide: roomOnLeft ? 'left' : 'right',
      slot: 'inner',
      label: 'Inner',
      subtitle: `Facing ${roomName}`,
      roomId: room.id,
      roomName,
      isRoomFacing: true,
    };
    const outerInfo: ResolvedWallFaceInfo = {
      id: 'outer',
      physicalSide: roomOnLeft ? 'right' : 'left',
      slot: 'outer',
      label: 'Outer',
      subtitle: 'Exterior / Opposite Side',
      isRoomFacing: false,
    };
    return {
      kind: 'single_room',
      orientationFlipped: flipped,
      left: roomOnLeft ? innerInfo : outerInfo,
      right: roomOnLeft ? outerInfo : innerInfo,
      primary: innerInfo,
      secondary: outerInfo,
    };
  }

  // Freestanding partition (0 rooms or identical room polygon on both sides)
  const sharedRoomName = leftRoom && rightRoom && leftRoom.id === rightRoom.id ? leftRoom.name.trim() : '';
  const innerPhysSide: 'left' | 'right' = flipped ? 'right' : 'left';
  const leftInfo: ResolvedWallFaceInfo = {
    id: innerPhysSide === 'left' ? 'inner' : 'outer',
    physicalSide: 'left',
    slot: 'inner',
    label: innerPhysSide === 'left' ? 'Inner' : 'Outer',
    subtitle: sharedRoomName
      ? `Inside ${sharedRoomName} (+Normal)`
      : innerPhysSide === 'left'
        ? 'Primary Face (+Normal)'
        : 'Opposite Face (+Normal)',
    roomId: sharedRoomName ? leftRoom?.id : undefined,
    roomName: sharedRoomName || undefined,
    isRoomFacing: innerPhysSide === 'left',
  };
  const rightInfo: ResolvedWallFaceInfo = {
    id: innerPhysSide === 'right' ? 'inner' : 'outer',
    physicalSide: 'right',
    slot: 'outer',
    label: innerPhysSide === 'right' ? 'Inner' : 'Outer',
    subtitle: sharedRoomName
      ? `Inside ${sharedRoomName} (-Normal)`
      : innerPhysSide === 'right'
        ? 'Primary Face (-Normal)'
        : 'Opposite Face (-Normal)',
    roomId: sharedRoomName ? rightRoom?.id : undefined,
    roomName: sharedRoomName || undefined,
    isRoomFacing: innerPhysSide === 'right',
  };
  return {
    kind: 'freestanding',
    orientationFlipped: flipped,
    left: leftInfo,
    right: rightInfo,
    primary: innerPhysSide === 'left' ? leftInfo : rightInfo,
    secondary: innerPhysSide === 'left' ? rightInfo : leftInfo,
  };
}

/**
 * Reverses a wall's physical face orientation and exchanges face-specific materials,
 * colors, and texture mappings without moving the wall, resizing it, altering alignment,
 * or breaking shared room associations.
 */
export function flipWallFace(wall: Wall): Wall {
  return {
    ...wall,
    faceFlipped: !wall.faceFlipped,
    innerColor: wall.outerColor,
    outerColor: wall.innerColor,
    innerSecondaryColor: wall.outerSecondaryColor,
    outerSecondaryColor: wall.innerSecondaryColor,
    innerMaterial: wall.outerMaterial,
    outerMaterial: wall.innerMaterial,
    innerTextureScale: wall.outerTextureScale,
    outerTextureScale: wall.innerTextureScale,
    innerTextureRotDeg: wall.outerTextureRotDeg,
    outerTextureRotDeg: wall.innerTextureRotDeg,
    innerSettings: wall.outerSettings,
    outerSettings: wall.innerSettings,
  };
}

// ============================================================================
// WALL-MOUNTED FURNITURE ATTACHMENT & PARENT-CHILD HIERARCHY PROPAGATION
// ============================================================================

/**
 * Computes exact flush world position (xMm, yMm) and room-facing rotationDeg
 * for any furniture item mounted on `wall` at parametric position `t` and physical `face`.
 */
export function computeAttachedWallFurnitureTransform(
  wall: Wall,
  t: number,
  face: 'left' | 'right',
  furn: Pick<
    FurnitureInstance,
    'parts' | 'mirroredX' | 'mirroredY' | 'rotationXDeg' | 'rotationYDeg' | 'wallOffsetMm'
  >,
  overrideOffsetMm?: number
): { xMm: number; yMm: number; rotationDeg: number; attachedT: number } {
  const clampedT = Math.max(0.01, Math.min(0.99, Number.isFinite(t) ? t : 0.5));
  const { point, tangent, normal } = getWallCenterlinePoint(wall, clampedT);
  const { left, right } = wallOffsets(wall.thicknessMm, wall.alignment);
  const wallAngleDeg = (Math.atan2(tangent.y, tangent.x) * 180) / Math.PI;
  const rotationDeg = Math.round(((face === 'left' ? wallAngleDeg : wallAngleDeg + 180) % 360 + 360) % 360);

  const rotOffsets = getFurnitureOrientedOffsets(
    furn.parts,
    rotationDeg,
    furn.mirroredX,
    furn.mirroredY,
    furn.rotationXDeg ?? 0,
    furn.rotationYDeg ?? 0
  );
  const nVals = rotOffsets.map((o) => o.x * normal.x + o.y * normal.y);
  const nMin = Math.min(...nVals);
  const nMax = Math.max(...nVals);
  const faceOffset = face === 'left' ? left : right;
  const off = overrideOffsetMm ?? furn.wallOffsetMm ?? 0;
  const idealDNorm = face === 'left' ? faceOffset + off - nMin : faceOffset - off - nMax;

  return {
    xMm: Math.round(point.x + normal.x * idealDNorm),
    yMm: Math.round(point.y + normal.y * idealDNorm),
    rotationDeg,
    attachedT: clampedT,
  };
}

/**
 * Finds the nearest visible wall & physical face to snap and attach a wall-mounted item.
 */
export function findNearestWallAttachmentTarget(
  pos: Point2D,
  furn: Pick<
    FurnitureInstance,
    'parts' | 'mirroredX' | 'mirroredY' | 'rotationXDeg' | 'rotationYDeg' | 'wallOffsetMm'
  > &
    Partial<Pick<FurnitureInstance, 'attachedWallId' | 'attachedFace'>>,
  walls: Wall[],
  maxDistMm = Infinity
): {
  wall: Wall;
  face: 'left' | 'right';
  t: number;
  xMm: number;
  yMm: number;
  rotationDeg: number;
  distanceMm: number;
} | null {
  let best: {
    wall: Wall;
    face: 'left' | 'right';
    t: number;
    xMm: number;
    yMm: number;
    rotationDeg: number;
    distanceMm: number;
  } | null = null;

  for (const w of walls) {
    if (w.visible === false || getWallArcLength(w) < 40) continue;
    let t = 0.5;
    if (!w.isCurved || Math.abs(w.curveBulgeMm) < 1) {
      t = projectPointOnSegment(pos, w.start, w.end).t;
    } else {
      let minD = Infinity;
      for (let i = 0; i <= 20; i++) {
        const ti = i / 20;
        const pt = getWallCenterlinePoint(w, ti).point;
        const d = dist(pos, pt);
        if (d < minD) {
          minD = d;
          t = ti;
        }
      }
    }
    const clampedT = Math.max(0.03, Math.min(0.97, t));
    const { point, normal } = getWallCenterlinePoint(w, clampedT);
    const { left, right } = wallOffsets(w.thicknessMm, w.alignment);
    const wallMid = (left + right) / 2;
    const dNorm = (pos.x - point.x) * normal.x + (pos.y - point.y) * normal.y;
    let face: 'left' | 'right' = dNorm >= wallMid ? 'left' : 'right';
    if (furn.attachedWallId === w.id && (furn.attachedFace === 'left' || furn.attachedFace === 'right')) {
      face =
        furn.attachedFace === 'left'
          ? dNorm >= right - 25
            ? 'left'
            : 'right'
          : dNorm > left + 25
            ? 'left'
            : 'right';
    }
    const xf = computeAttachedWallFurnitureTransform(w, clampedT, face, furn);
    const distanceMm = Math.hypot(xf.xMm - pos.x, xf.yMm - pos.y);
    if (distanceMm <= maxDistMm && (!best || distanceMm < best.distanceMm)) {
      best = { wall: w, face, t: xf.attachedT, xMm: xf.xMm, yMm: xf.yMm, rotationDeg: xf.rotationDeg, distanceMm };
    }
  }
  return best;
}

/**
 * Converts a child furniture world position & rotation into host-local unmirrored coordinates.
 */
export function computeSurfaceLocalCoords(
  worldPos: Point2D,
  childRotDeg: number,
  host: Pick<FurnitureInstance, 'xMm' | 'yMm' | 'rotationDeg' | 'mirroredX' | 'mirroredY'>
): { localXMm: number; localYMm: number; localRotDeg: number } {
  const dx = worldPos.x - host.xMm;
  const dy = worldPos.y - host.yMm;
  const rad = (-host.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rx = dx * cos - dy * sin;
  const ry = dx * sin + dy * cos;
  return {
    localXMm: rx * (host.mirroredX ? -1 : 1),
    localYMm: ry * (host.mirroredY ? -1 : 1),
    localRotDeg: (((childRotDeg - host.rotationDeg) % 360) + 360) % 360,
  };
}

/**
 * Projects host-local coordinates back into world space after host move, rotate, mirror, or resize.
 */
export function computeWorldFromSurfaceLocal(
  localXMm: number,
  localYMm: number,
  localRotDeg: number,
  host: Pick<FurnitureInstance, 'xMm' | 'yMm' | 'rotationDeg' | 'mirroredX' | 'mirroredY'>
): { xMm: number; yMm: number; rotationDeg: number } {
  const mx = localXMm * (host.mirroredX ? -1 : 1);
  const my = localYMm * (host.mirroredY ? -1 : 1);
  const rad = (host.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    xMm: Math.round(host.xMm + mx * cos - my * sin),
    yMm: Math.round(host.yMm + mx * sin + my * cos),
    rotationDeg: Math.round((((host.rotationDeg + localRotDeg) % 360) + 360) % 360 * 100) / 100,
  };
}

/**
 * Propagates parent move, rotation, mirror, and resize transformations recursively to all
 * surface-hosted descendant furniture items so attachments never drift, detach, or float.
 */
export function propagateParentFurnitureTransforms(
  furnitureList: FurnitureInstance[],
  parentId: string,
  prevParent: FurnitureInstance,
  nextParent: FurnitureInstance
): FurnitureInstance[] {
  const prevBounds = computeFurnitureBoundsMm(prevParent.parts);
  const nextBounds = computeFurnitureBoundsMm(nextParent.parts);
  const scaleX = nextBounds.widthMm / Math.max(10, prevBounds.widthMm);
  const scaleY = nextBounds.depthMm / Math.max(10, prevBounds.depthMm);
  const resized = Math.abs(scaleX - 1) > 1e-4 || Math.abs(scaleY - 1) > 1e-4;
  const nextDeckZ = getSupportingDeckHeightMm(nextParent);

  let updated = furnitureList;
  const directChildren = furnitureList.filter((f) => f.surfaceHostId === parentId);
  if (directChildren.length === 0) return updated;

  const childMap = new Map<string, FurnitureInstance>();
  for (const child of directChildren) {
    if (child.locked) continue;
    const local = computeSurfaceLocalCoords(
      { x: child.xMm, y: child.yMm },
      child.rotationDeg,
      prevParent
    );
    let lx = local.localXMm;
    let ly = local.localYMm;
    if (resized) {
      lx = Math.max(-nextBounds.widthMm * 0.48, Math.min(nextBounds.widthMm * 0.48, lx * scaleX));
      ly = Math.max(-nextBounds.depthMm * 0.48, Math.min(nextBounds.depthMm * 0.48, ly * scaleY));
    }
    const world = computeWorldFromSurfaceLocal(lx, ly, local.localRotDeg, nextParent);
    const nextChild: FurnitureInstance = {
      ...child,
      xMm: world.xMm,
      yMm: world.yMm,
      rotationDeg: world.rotationDeg,
      elevationMm: nextDeckZ,
      surfaceLocalXMm: Math.round(lx * 10) / 10,
      surfaceLocalYMm: Math.round(ly * 10) / 10,
      surfaceLocalRotDeg: Math.round(local.localRotDeg * 10) / 10,
    };
    childMap.set(child.id, nextChild);
  }

  updated = updated.map((f) => childMap.get(f.id) ?? f);
  for (const child of directChildren) {
    const nextChild = childMap.get(child.id);
    if (nextChild) {
      updated = propagateParentFurnitureTransforms(updated, child.id, child, nextChild);
    }
  }
  return updated;
}

/**
 * Recomputes wall-attached furniture positions & room-facing rotations when walls move,
 * resize, or flip, and propagates to any items stacked on floating consoles.
 */
export function propagateWallAttachments(
  furnitureList: FurnitureInstance[],
  walls: Wall[],
  movedWallIds?: Set<string>
): FurnitureInstance[] {
  const wallById = new Map(walls.map((w) => [w.id, w]));
  let updated = [...furnitureList];
  const movedParents: Array<{ prev: FurnitureInstance; next: FurnitureInstance }> = [];

  updated = updated.map((f) => {
    if (!f.attachedWallId || f.locked) return f;
    if (movedWallIds && !movedWallIds.has(f.attachedWallId)) return f;
    const w = wallById.get(f.attachedWallId);
    if (!w) {
      return {
        ...f,
        attachedWallId: undefined,
        attachedFace: undefined,
        attachedT: undefined,
      };
    }
    const face = f.attachedFace ?? 'left';
    const xf = computeAttachedWallFurnitureTransform(w, f.attachedT ?? 0.5, face, f);
    if (xf.xMm === f.xMm && xf.yMm === f.yMm && xf.rotationDeg === f.rotationDeg) {
      return f;
    }
    const nextItem: FurnitureInstance = {
      ...f,
      xMm: xf.xMm,
      yMm: xf.yMm,
      rotationDeg: xf.rotationDeg,
      attachedT: xf.attachedT,
    };
    movedParents.push({ prev: f, next: nextItem });
    return nextItem;
  });

  for (const pair of movedParents) {
    updated = propagateParentFurnitureTransforms(updated, pair.next.id, pair.prev, pair.next);
  }
  return updated;
}

/**
 * Safely detaches child furniture when their parent wall or supporting furniture is deleted,
 * clearing attachment links and lowering orphaned surface children back to the floor cleanly.
 */
export function detachChildrenOnParentDelete(
  furnitureList: FurnitureInstance[],
  deletedWallIds: Set<string>,
  deletedFurnIds: Set<string>
): FurnitureInstance[] {
  if (deletedWallIds.size === 0 && deletedFurnIds.size === 0) return furnitureList;
  return furnitureList.map((f) => {
    let changed = false;
    let next = f;
    if (f.attachedWallId && deletedWallIds.has(f.attachedWallId)) {
      next = {
        ...next,
        attachedWallId: undefined,
        attachedFace: undefined,
        attachedT: undefined,
      };
      changed = true;
    }
    if (f.surfaceHostId && deletedFurnIds.has(f.surfaceHostId)) {
      next = {
        ...next,
        surfaceHostId: undefined,
        surfaceLocalXMm: undefined,
        surfaceLocalYMm: undefined,
        surfaceLocalRotDeg: undefined,
        elevationMm: 0,
      };
      changed = true;
    }
    return changed ? next : f;
  });
}

// ============================================================================
// ELEVATION-AWARE 2D FURNITURE REPRESENTATION & STACK HIT-TESTING
// ============================================================================

export type FurnitureElevationBand = 'rug' | 'floor' | 'elevated' | 'overhead';

export interface FurnitureElevationPlanInfo {
  span: { minZ: number; maxZ: number };
  band: FurnitureElevationBand;
  canopyUndersideZ: number | null;
  coveringLowerIds: string[];
  coveredByUpperIds: string[];
  sameSpotOverlapIds: string[];
  /** Vertical depth steps below the uppermost overlapping object (0 = topmost, 1+ = lower tiers) */
  stackDepthBelowTop: number;
  footprintCorners: Point2D[];
}

function getBoundsArea2D(corners: Point2D[]): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of corners) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, maxX, minY, maxY };
}

/**
 * Returns the underside Z height (mm) of an elevated canopy/tabletop if this object
 * bridges open space above the floor (either via elevationMm / raised base, or via
 * elevated wide parts spanning above narrower floor legs).
 */
export function computeFurnitureCanopyUndersideZMm(
  f: Pick<FurnitureInstance, 'parts' | 'elevationMm' | 'templateId' | 'category'> &
    Partial<Pick<FurnitureInstance, 'rotationXDeg' | 'rotationYDeg' | 'mirroredX' | 'mirroredY' | 'mountingType' | 'attachedWallId' | 'surfaceHostId'>>,
  effectiveCeilingMm?: number
): number | null {
  const span = computeFurnitureElevationSpanMm(f, effectiveCeilingMm);
  if (span.minZ >= 80) {
    return span.minZ;
  }
  if (!f.parts || f.parts.length < 2) {
    return null;
  }
  const b = computeFurnitureBoundsMm(f.parts);
  const totalArea = Math.max(1, b.widthMm * b.depthMm);
  let baseElev = f.elevationMm ?? 0;
  const upperParts = f.parts.filter(
    (p) => p.zMm >= 480 && p.widthMm * p.depthMm >= totalArea * 0.45
  );
  if (upperParts.length === 0) return null;

  const minUpperZ = Math.min(...upperParts.map((p) => p.zMm));
  const lowerCoverage = f.parts
    .filter((p) => p.zMm < minUpperZ - 20)
    .reduce((acc, p) => acc + p.widthMm * p.depthMm, 0);

  // Open under-clearance when ground-level supports/legs cover <= 55% of total plan footprint
  if (lowerCoverage <= totalArea * 0.55) {
    return baseElev + minUpperZ;
  }
  return null;
}

function doFurnitureFootprintsOverlap2D(
  cornersA: Point2D[],
  aabbA: { minX: number; maxX: number; minY: number; maxY: number },
  primsA: SolidFootprintPrimitive[],
  cornersB: Point2D[],
  aabbB: { minX: number; maxX: number; minY: number; maxY: number },
  primsB: SolidFootprintPrimitive[],
  minOverlapDepthMm = 12
): boolean {
  if (
    aabbA.maxX - aabbB.minX <= minOverlapDepthMm ||
    aabbB.maxX - aabbA.minX <= minOverlapDepthMm ||
    aabbA.maxY - aabbB.minY <= minOverlapDepthMm ||
    aabbB.maxY - aabbA.minY <= minOverlapDepthMm
  ) {
    return false;
  }
  const polysA = primsA.length > 0 ? primsA.map((p) => p.poly) : [cornersA];
  const polysB = primsB.length > 0 ? primsB.map((p) => p.poly) : [cornersB];
  for (const pa of polysA) {
    for (const pb of polysB) {
      const mtv = computePolygonOverlapMTV(pa, pb);
      if (mtv && mtv.depth > minOverlapDepthMm) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Classifies visible furniture items into vertical architectural bands and computes
 * vertical overlap relationships (covering upper objects vs progressively deeper lower objects)
 * strictly from real 3D spans without mutating positions or dimensions.
 */
export function computePlanFurnitureOverlapMetadata(
  furnitureList: FurnitureInstance[],
  effectiveCeilingMm?: number
): Map<string, FurnitureElevationPlanInfo> {
  const result = new Map<string, FurnitureElevationPlanInfo>();

  interface Entry {
    f: FurnitureInstance;
    span: { minZ: number; maxZ: number };
    band: FurnitureElevationBand;
    canopyUndersideZ: number | null;
    isCeilingLight: boolean;
    isWallMounted: boolean;
    corners: Point2D[];
    aabb: { minX: number; maxX: number; minY: number; maxY: number };
    prims: SolidFootprintPrimitive[];
    area: number;
    coveringLowerIds: string[];
    coveredByUpperIds: string[];
    sameSpotOverlapIds: string[];
    stackDepthBelowTop: number;
  }

  const entries: Entry[] = [];
  for (const f of furnitureList) {
    if (f.visible === false) continue;
    const span = computeFurnitureElevationSpanMm(f, effectiveCeilingMm);
    const mounting = resolveFurnitureMountingType(f);
    const band: FurnitureElevationBand = isRugFurniture(f)
      ? 'rug'
      : mounting === 'ceiling' || span.minZ >= 1350
        ? 'overhead'
        : span.minZ >= 80
          ? 'elevated'
          : 'floor';
    const canopyUndersideZ =
      band === 'rug' ? null : computeFurnitureCanopyUndersideZMm(f, effectiveCeilingMm);
    const corners = getFurnitureOrientedCorners({ x: f.xMm, y: f.yMm }, f);
    const aabb = getBoundsArea2D(corners);
    const prims = getFurnitureSolidFootprintPrimitives({ x: f.xMm, y: f.yMm }, f);
    const tb = computeFurnitureTiltedLocalBoundsMm(
      f.parts,
      f.rotationXDeg ?? 0,
      f.rotationYDeg ?? 0,
      f.mirroredX,
      f.mirroredY
    );
    const area = Math.max(1, (tb.maxX - tb.minX) * (tb.maxY - tb.minY));

    entries.push({
      f,
      span,
      band,
      canopyUndersideZ,
      isCeilingLight: isCeilingFixture(f),
      isWallMounted: mounting === 'wall',
      corners,
      aabb,
      prims,
      area,
      coveringLowerIds: [],
      coveredByUpperIds: [],
      sameSpotOverlapIds: [],
      stackDepthBelowTop: 0,
    });
  }

  for (let i = 0; i < entries.length; i++) {
    const a = entries[i];
    for (let j = i + 1; j < entries.length; j++) {
      const b = entries[j];
      if (a.band === 'rug' && b.band === 'rug') continue;
      if (
        !doFurnitureFootprintsOverlap2D(
          a.corners,
          a.aabb,
          a.prims,
          b.corners,
          b.aabb,
          b.prims,
          12
        )
      ) {
        continue;
      }

      // Wall-mounted items do not link with floor/freestanding/surface furniture beneath them
      // in stacking overlays; stack membership applies strictly within the same mounting domain.
      if (a.isWallMounted !== b.isWallMounted) {
        continue;
      }

      a.sameSpotOverlapIds.push(b.f.id);
      b.sameSpotOverlapIds.push(a.f.id);

      const isASurfaceChildOfB = a.f.surfaceHostId === b.f.id;
      const isBSurfaceChildOfA = b.f.surfaceHostId === a.f.id;

      // Determine whether A physically covers B or B physically covers A
      const aCoversB =
        !a.isCeilingLight &&
        a.band !== 'rug' &&
        !isBSurfaceChildOfA &&
        (b.band === 'rug' ||
          isASurfaceChildOfB ||
          (a.span.minZ >= b.span.maxZ - 35 && a.span.maxZ > b.span.maxZ) ||
          (a.canopyUndersideZ !== null &&
            b.span.maxZ <= a.canopyUndersideZ + 35 &&
            a.span.maxZ >= b.span.maxZ));

      const bCoversA =
        !b.isCeilingLight &&
        b.band !== 'rug' &&
        !isASurfaceChildOfB &&
        (a.band === 'rug' ||
          isBSurfaceChildOfA ||
          (b.span.minZ >= a.span.maxZ - 35 && b.span.maxZ > a.span.maxZ) ||
          (b.canopyUndersideZ !== null &&
            a.span.maxZ <= b.canopyUndersideZ + 35 &&
            b.span.maxZ >= a.span.maxZ));

      if (aCoversB && !bCoversA) {
        a.coveringLowerIds.push(b.f.id);
        b.coveredByUpperIds.push(a.f.id);
      } else if (bCoversA && !aCoversB) {
        b.coveringLowerIds.push(a.f.id);
        a.coveredByUpperIds.push(b.f.id);
      }
    }
  }

  // Propagate relative stack depth tiers downward from uppermost overlapping furniture (0 = top)
  const entryById = new Map(entries.map((e) => [e.f.id, e]));
  for (let pass = 0; pass < entries.length; pass++) {
    let updated = false;
    for (const upper of entries) {
      for (const lowerId of upper.coveringLowerIds) {
        const lower = entryById.get(lowerId);
        if (!lower) continue;
        const candidateDepth = upper.stackDepthBelowTop + 1;
        if (candidateDepth > lower.stackDepthBelowTop) {
          lower.stackDepthBelowTop = candidateDepth;
          updated = true;
        }
      }
    }
    if (!updated) break;
  }

  for (const e of entries) {
    result.set(e.f.id, {
      span: e.span,
      band: e.band,
      canopyUndersideZ: e.canopyUndersideZ,
      coveringLowerIds: e.coveringLowerIds,
      coveredByUpperIds: e.coveredByUpperIds,
      sameSpotOverlapIds: e.sameSpotOverlapIds,
      stackDepthBelowTop: e.stackDepthBelowTop,
      footprintCorners: e.corners,
    });
  }

  return result;
}

function getSurfaceHostDepth(
  f: Pick<FurnitureInstance, 'id' | 'surfaceHostId'>,
  byId: Map<string, Pick<FurnitureInstance, 'id' | 'surfaceHostId'>>
): number {
  let depth = 0;
  let cur = f.surfaceHostId;
  const visited = new Set<string>([f.id]);
  while (cur && !visited.has(cur) && depth < 12) {
    visited.add(cur);
    depth++;
    cur = byId.get(cur)?.surfaceHostId;
  }
  return depth;
}

/**
 * Sorts furniture bottom-to-top for 2D plan painting using true 3D elevation spans
 * (rugs -> lower floor -> elevated tops/props -> overhead/ceiling), preserving manual
 * zOrder as a deterministic tie-breaker at matching elevations.
 */
export function sortFurnitureByElevationForPlan<
  T extends Pick<
    FurnitureInstance,
    'id' | 'templateId' | 'category' | 'parts' | 'zOrder' | 'elevationMm' | 'surfaceHostId'
  > &
    Partial<
      Pick<
        FurnitureInstance,
        'rotationXDeg' | 'rotationYDeg' | 'mirroredX' | 'mirroredY' | 'mountingType' | 'attachedWallId'
      >
    >
>(
  items: T[],
  infoMap?: Map<string, FurnitureElevationPlanInfo>,
  effectiveCeilingMm?: number
): T[] {
  const byId = new Map<string, T>(items.map((item) => [item.id, item]));
  const decorated = items.map((item, idx) => {
    const info = infoMap?.get(item.id);
    const span = info?.span ?? computeFurnitureElevationSpanMm(item, effectiveCeilingMm);
    const band: FurnitureElevationBand =
      info?.band ??
      (isRugFurniture(item)
        ? 'rug'
        : resolveFurnitureMountingType(item) === 'ceiling' || span.minZ >= 1350
          ? 'overhead'
          : span.minZ >= 80
            ? 'elevated'
            : 'floor');
    const tierRank = band === 'rug' ? -1 : band === 'overhead' ? 1 : 0;
    const hostDepth = getSurfaceHostDepth(item, byId);
    const manualZ = getEffectiveFurnitureZOrder(item, idx);
    return { item, idx, span, tierRank, hostDepth, manualZ };
  });

  decorated.sort((a, b) => {
    if (a.tierRank !== b.tierRank) return a.tierRank - b.tierRank;
    if (Math.abs(a.span.maxZ - b.span.maxZ) > 5) {
      return a.span.maxZ - b.span.maxZ;
    }
    if (Math.abs(a.span.minZ - b.span.minZ) > 5) {
      return a.span.minZ - b.span.minZ;
    }
    if (a.hostDepth !== b.hostDepth) {
      return a.hostDepth - b.hostDepth;
    }
    if (a.manualZ !== b.manualZ) {
      return a.manualZ - b.manualZ;
    }
    return a.idx - b.idx;
  });

  return decorated.map((d) => d.item);
}

/**
 * Checks whether a 2D world point lies inside a furniture object's rotated footprint
 * (supporting arbitrary parts, custom/GLB bounding envelopes, and small hit padding).
 */
export function isPointInFurniture2D(
  worldPt: Point2D,
  f: FurnitureInstance,
  hitToleranceMm = 12
): boolean {
  const placement = getFurniturePlacement(f);
  const rad = (-placement.rotationDeg * Math.PI) / 180;
  const dx = worldPt.x - placement.xMm;
  const dy = worldPt.y - placement.yMm;
  const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
  const tb = placement.tiltedLocalBounds;
  if (
    lx < tb.minX - hitToleranceMm ||
    lx > tb.maxX + hitToleranceMm ||
    ly < tb.minY - hitToleranceMm ||
    ly > tb.maxY + hitToleranceMm
  ) {
    return false;
  }

  // Custom SVG / GLB representations without parametric parts cover their oriented local bounds directly
  const hasCustomTopRep = Boolean(f.representation?.customViews?.top?.length);
  if (f.parts.length === 0 || (typeof f.svgSource === 'string' && f.svgSource.trim().length > 0) || hasCustomTopRep) {
    return true;
  }

  // Parametric furniture (single or multi-part): hit-test against transformed geometry polygons
  const prims = getFurnitureSolidFootprintPrimitives({ x: f.xMm, y: f.yMm }, f);
  if (prims.length === 0) return true;
  return prims.some((pr) => {
    if (pointInPolygon(worldPt, pr.poly)) return true;
    for (let i = 0; i < pr.poly.length; i++) {
      const a = pr.poly[i];
      const b = pr.poly[(i + 1) % pr.poly.length];
      if (projectPointOnSegment(worldPt, a, b).distance <= hitToleranceMm) {
        return true;
      }
    }
    return false;
  });
}

/**
 * Returns all visible furniture objects under a 2D world point, ordered topmost-first
 * (reverse of 2D painting order) so stacked/overlapping objects can be cycled or picked cleanly.
 */
export function findFurnitureHitsAtPoint(
  worldPt: Point2D,
  furnitureList: FurnitureInstance[],
  infoMap?: Map<string, FurnitureElevationPlanInfo>,
  effectiveCeilingMm?: number,
  hitToleranceMm = 12
): FurnitureInstance[] {
  const ordered = sortFurnitureByElevationForPlan(
    furnitureList.filter((f) => f.visible !== false),
    infoMap,
    effectiveCeilingMm
  );
  const hits: FurnitureInstance[] = [];
  for (let i = ordered.length - 1; i >= 0; i--) {
    const f = ordered[i];
    if (isPointInFurniture2D(worldPt, f, hitToleranceMm)) {
      hits.push(f);
    }
  }
  return hits;
}
