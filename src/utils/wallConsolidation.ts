import type {
  ArchElement,
  MaterialPreset,
  Opening,
  Point2D,
  Room,
  SurfaceMaterialSettings,
  Wall,
} from '../types/plan';
import {
  getWallArcLength,
  resolveWallFaces,
  wallOffsets,
} from './geometry';

export interface WallConsolidationEligibility {
  eligible: boolean;
  reason?: string;
  isConsolidated: boolean;
  hasAnyConsolidated: boolean;
  groupId?: string;
  orderedWallIds: string[];
  flatSideOnly?: boolean;
  flatSideRef?: 'both' | 'left' | 'right';
  refUx?: number;
  refUy?: number;
}

export interface ConsolidatedWallSegment {
  wall: Wall;
  startRunS: number;
  endRunS: number;
  lengthMm: number;
  sameDir: boolean;
  segPhysicalSide: 'left' | 'right';
  faceSlot: 'inner' | 'outer';
  color: string;
  secondaryColor?: string;
  material: MaterialPreset;
  textureScale: number;
  textureRotDeg: number;
  settings?: SurfaceMaterialSettings;
  heightMm: number;
  hasBaseboard: boolean;
  baseboardHeightMm: number;
  baseboardColor: string;
  hasCrownMolding: boolean;
  crownHeightMm: number;
  crownColor: string;
  roomId: string | null;
  roomName: string | null;
}

export interface ConsolidatedWallGap {
  startRunS: number;
  endRunS: number;
  widthMm: number;
}

export interface ConsolidatedWallRun {
  groupId: string;
  source: 'manual' | 'auto';
  originPt: Point2D;
  endPt: Point2D;
  ux: number;
  uy: number;
  nx: number;
  ny: number;
  totalLenMm: number;
  maxHeightMm: number;
  segments: ConsolidatedWallSegment[];
  gaps: ConsolidatedWallGap[];
  wallIds: Set<string>;
  hasStartCap: boolean;
  hasEndCap: boolean;
}

function unitWallDir(w: Wall): { ux: number; uy: number; len: number } {
  const dx = w.end.x - w.start.x;
  const dy = w.end.y - w.start.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-3) return { ux: 1, uy: 0, len: 0 };
  return { ux: dx / len, uy: dy / len, len };
}

function getWallCenterlineOffset(w: Wall, ux: number, uy: number): number {
  const dir = unitWallDir(w);
  const sign = dir.ux * ux + dir.uy * uy >= 0 ? 1 : -1;
  const { left, right } = wallOffsets(w.thicknessMm, w.alignment);
  return sign * ((left + right) / 2);
}

/**
 * Validates whether 2+ selected wall segments form an inline, matching-width run
 * without corners, angled walls, interior T-junctions, or unrelated distant gaps.
 */
export function validateWallConsolidationEligibility(
  selectedWalls: Wall[],
  allWalls: Wall[]
): WallConsolidationEligibility {
  if (selectedWalls.length < 2) {
    return {
      eligible: false,
      reason: 'Select 2 or more inline wall segments.',
      isConsolidated: false,
      hasAnyConsolidated: selectedWalls.some((w) => Boolean(w.consolidatedGroupId)),
      orderedWallIds: selectedWalls.map((w) => w.id),
    };
  }

  for (const w of selectedWalls) {
    if (w.visible === false) {
      return {
        eligible: false,
        reason: 'Hidden walls cannot be consolidated.',
        isConsolidated: false,
        hasAnyConsolidated: false,
        orderedWallIds: [],
      };
    }
    if (w.isCurved && Math.abs(w.curveBulgeMm) >= 1) {
      return {
        eligible: false,
        reason: 'Curved walls cannot be consolidated.',
        isConsolidated: false,
        hasAnyConsolidated: false,
        orderedWallIds: [],
      };
    }
    if (Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y) < 10) {
      return {
        eligible: false,
        reason: 'Wall segment is too short.',
        isConsolidated: false,
        hasAnyConsolidated: false,
        orderedWallIds: [],
      };
    }
  }

  // Matching widths (thicknessMm within 2 mm)
  const thicknesses = selectedWalls.map((w) => w.thicknessMm);
  if (Math.max(...thicknesses) - Math.min(...thicknesses) > 2) {
    return {
      eligible: false,
      reason: 'Selected wall segments must have matching thicknesses.',
      isConsolidated: false,
      hasAnyConsolidated: selectedWalls.some((w) => Boolean(w.consolidatedGroupId)),
      orderedWallIds: [],
    };
  }

  // Reference line from the longest selected wall
  let ref = selectedWalls[0];
  let refLen = 0;
  for (const w of selectedWalls) {
    const l = Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y);
    if (l > refLen) {
      refLen = l;
      ref = w;
    }
  }
  const { ux, uy } = unitWallDir(ref);
  const nx = -uy;
  const ny = ux;
  const refCenterOff = getWallCenterlineOffset(ref, ux, uy);

  const projected: Array<{
    wall: Wall;
    sMin: number;
    sMax: number;
  }> = [];

  for (const w of selectedWalls) {
    const d = unitWallDir(w);
    const cosAngle = Math.abs(d.ux * ux + d.uy * uy);
    if (cosAngle < 0.998) {
      return {
        eligible: false,
        reason: 'Corners and angled wall segments cannot be consolidated.',
        isConsolidated: false,
        hasAnyConsolidated: selectedWalls.some((x) => Boolean(x.consolidatedGroupId)),
        orderedWallIds: [],
      };
    }

    const wCenterOff = getWallCenterlineOffset(w, ux, uy);
    const pStart = (w.start.x - ref.start.x) * nx + (w.start.y - ref.start.y) * ny + wCenterOff;
    const pEnd = (w.end.x - ref.start.x) * nx + (w.end.y - ref.start.y) * ny + wCenterOff;
    if (Math.abs(pStart - refCenterOff) > 16 || Math.abs(pEnd - refCenterOff) > 16) {
      return {
        eligible: false,
        reason: 'Selected walls are not aligned on the same line.',
        isConsolidated: false,
        hasAnyConsolidated: selectedWalls.some((x) => Boolean(x.consolidatedGroupId)),
        orderedWallIds: [],
      };
    }

    const sA = (w.start.x - ref.start.x) * ux + (w.start.y - ref.start.y) * uy;
    const sB = (w.end.x - ref.start.x) * ux + (w.end.y - ref.start.y) * uy;
    projected.push({
      wall: w,
      sMin: Math.min(sA, sB),
      sMax: Math.max(sA, sB),
    });
  }

  projected.sort((a, b) => a.sMin - b.sMin);

  // Check consecutive gaps (allow touching or doorway gaps <= 2600 mm)
  for (let i = 1; i < projected.length; i++) {
    const gap = projected[i].sMin - projected[i - 1].sMax;
    if (gap < -12) {
      return {
        eligible: false,
        reason: 'Overlapping wall segments cannot be consolidated.',
        isConsolidated: false,
        hasAnyConsolidated: selectedWalls.some((x) => Boolean(x.consolidatedGroupId)),
        orderedWallIds: [],
      };
    }
    if (gap > 2600) {
      return {
        eligible: false,
        reason: 'Gap between wall segments is too large for a doorway or opening.',
        isConsolidated: false,
        hasAnyConsolidated: selectedWalls.some((x) => Boolean(x.consolidatedGroupId)),
        orderedWallIds: [],
      };
    }
  }

  // Reject cross-intersections or opposing T-junctions on both sides; allow one-sided T-junctions on the flat side only
  const selectedIds = new Set(selectedWalls.map((w) => w.id));
  const runMinS = projected[0].sMin;
  const runMaxS = projected[projected.length - 1].sMax;
  const maxThick = Math.max(...thicknesses);
  const perpReach = maxThick / 2 + 12;
  const faceReach = maxThick / 2 + 4;
  let stemOnLeft = false;
  let stemOnRight = false;

  for (const other of allWalls) {
    if (other.visible === false || selectedIds.has(other.id)) continue;
    const os1 = (other.start.x - ref.start.x) * ux + (other.start.y - ref.start.y) * uy;
    const os2 = (other.end.x - ref.start.x) * ux + (other.end.y - ref.start.y) * uy;
    const op1 = (other.start.x - ref.start.x) * nx + (other.start.y - ref.start.y) * ny - refCenterOff;
    const op2 = (other.end.x - ref.start.x) * nx + (other.end.y - ref.start.y) * ny - refCenterOff;

    const oDir = unitWallDir(other);
    const oCenterOff = getWallCenterlineOffset(other, ux, uy);
    const isCollinearOther =
      Math.abs(oDir.ux * ux + oDir.uy * uy) >= 0.995 &&
      Math.abs(op1 + oCenterOff) <= 16 &&
      Math.abs(op2 + oCenterOff) <= 16;

    if (isCollinearOther) {
      const oMin = Math.min(os1, os2);
      const oMax = Math.max(os1, os2);
      if (oMax > runMinS + 12 && oMin < runMaxS - 12) {
        return {
          eligible: false,
          reason: 'Cannot consolidate across an unselected inline wall segment.',
          isConsolidated: false,
          hasAnyConsolidated: selectedWalls.some((x) => Boolean(x.consolidatedGroupId)),
          orderedWallIds: [],
        };
      }
      continue;
    }

    // Check if non-collinear wall crosses or terminates (T-junction) strictly inside the consolidated run
    const crossesOrTouchesLine =
      (op1 >= -perpReach && op1 <= perpReach) ||
      (op2 >= -perpReach && op2 <= perpReach) ||
      op1 * op2 <= 0;
    if (!crossesOrTouchesLine) continue;

    // Find s-coordinates where `other` is within perpReach of the run centerline
    const sHits: number[] = [];
    if (Math.abs(op1) <= perpReach) sHits.push(os1);
    if (Math.abs(op2) <= perpReach) sHits.push(os2);
    if (Math.abs(op2 - op1) > 1e-4 && op1 * op2 <= 0) {
      const t = -op1 / (op2 - op1);
      sHits.push(os1 + t * (os2 - os1));
    }
    const crossesCompletelyThrough = op1 * op2 < 0 && Math.min(Math.abs(op1), Math.abs(op2)) > perpReach;
    const endMargin = crossesCompletelyThrough
      ? 12
      : Math.min((runMaxS - runMinS) * 0.22, Math.max(20, maxThick / 2 + other.thicknessMm / 2 + 12));
    const hasInteriorHit = sHits.some((sHit) => sHit > runMinS + endMargin && sHit < runMaxS - endMargin);
    if (!hasInteriorHit) continue;

    const hasLeftStem = op1 > faceReach || op2 > faceReach;
    const hasRightStem = op1 < -faceReach || op2 < -faceReach;
    if (hasLeftStem && hasRightStem) {
      return {
        eligible: false,
        reason: 'Cannot consolidate across an intersecting cross wall.',
        isConsolidated: false,
        hasAnyConsolidated: selectedWalls.some((x) => Boolean(x.consolidatedGroupId)),
        orderedWallIds: [],
      };
    }
    if (hasLeftStem) stemOnLeft = true;
    else if (hasRightStem) stemOnRight = true;
    else if (op1 + op2 >= 0) stemOnLeft = true;
    else stemOnRight = true;

    if (stemOnLeft && stemOnRight) {
      return {
        eligible: false,
        reason: 'Cannot consolidate across opposing T-junctions on both sides.',
        isConsolidated: false,
        hasAnyConsolidated: selectedWalls.some((x) => Boolean(x.consolidatedGroupId)),
        orderedWallIds: [],
      };
    }
  }

  const groupIds = Array.from(
    new Set(selectedWalls.map((w) => w.consolidatedGroupId).filter((g): g is string => Boolean(g)))
  );
  const isConsolidated =
    groupIds.length === 1 && selectedWalls.every((w) => w.consolidatedGroupId === groupIds[0]);
  const flatSideRef: 'both' | 'left' | 'right' = stemOnLeft
    ? 'right'
    : stemOnRight
      ? 'left'
      : 'both';

  return {
    eligible: true,
    isConsolidated,
    hasAnyConsolidated: groupIds.length > 0,
    groupId: isConsolidated ? groupIds[0] : undefined,
    orderedWallIds: projected.map((p) => p.wall.id),
    flatSideOnly: flatSideRef !== 'both',
    flatSideRef,
    refUx: ux,
    refUy: uy,
  };
}

/**
 * Assigns a shared consolidatedGroupId across the selected walls (and clears stale single-member leftovers).
 */
export function applyWallConsolidation(
  walls: Wall[],
  targetWallIds: string[],
  groupId: string
): Wall[] {
  const idSet = new Set(targetWallIds);
  const next = walls.map((w) => (idSet.has(w.id) ? { ...w, consolidatedGroupId: groupId } : w));
  return cleanupOrphanConsolidatedGroups(next);
}

/**
 * Clears consolidatedGroupId from the specified walls (reversible separation).
 */
export function clearWallConsolidation(walls: Wall[], targetWallIds: string[]): Wall[] {
  const idSet = new Set(targetWallIds);
  const next = walls.map((w) => {
    if (!idSet.has(w.id)) return w;
    const copy = { ...w };
    delete copy.consolidatedGroupId;
    return copy;
  });
  return cleanupOrphanConsolidatedGroups(next);
}

export function cleanupOrphanConsolidatedGroups(walls: Wall[]): Wall[] {
  const counts = new Map<string, number>();
  for (const w of walls) {
    if (w.visible === false || !w.consolidatedGroupId) continue;
    counts.set(w.consolidatedGroupId, (counts.get(w.consolidatedGroupId) ?? 0) + 1);
  }
  return walls.map((w) => {
    if (!w.consolidatedGroupId) return w;
    if ((counts.get(w.consolidatedGroupId) ?? 0) >= 2) return w;
    const copy = { ...w };
    delete copy.consolidatedGroupId;
    return copy;
  });
}

function isWallSideUnobstructed(
  targetWall: Wall,
  viewedPhysicalSide: 'left' | 'right',
  elig: WallConsolidationEligibility
): boolean {
  if (!elig.eligible) return false;
  if (!elig.flatSideRef || elig.flatSideRef === 'both') return true;
  if (elig.refUx === undefined || elig.refUy === undefined) return true;
  const dir = unitWallDir(targetWall);
  const sameDirAsRef = dir.ux * elig.refUx + dir.uy * elig.refUy >= 0;
  const viewedOnRefSide: 'left' | 'right' = sameDirAsRef
    ? viewedPhysicalSide
    : viewedPhysicalSide === 'left'
      ? 'right'
      : 'left';
  return elig.flatSideRef === viewedOnRefSide;
}

function discoverAutoRoomWallGroup(
  targetWall: Wall,
  viewedPhysicalSide: 'left' | 'right',
  allWalls: Wall[],
  rooms: Room[]
): Wall[] | null {
  if (targetWall.visible === false) return null;
  if (targetWall.isCurved && Math.abs(targetWall.curveBulgeMm) >= 1) return null;
  const { ux, uy, len } = unitWallDir(targetWall);
  if (len < 10) return null;
  const nx = -uy;
  const ny = ux;
  const targetCenterOff = getWallCenterlineOffset(targetWall, ux, uy);
  const targetFaces = resolveWallFaces(targetWall, rooms);
  const targetRoomId =
    (viewedPhysicalSide === 'left' ? targetFaces.left.roomId : targetFaces.right.roomId) ?? null;

  const candidates: Array<{ wall: Wall; sMin: number; sMax: number }> = [];
  for (const w of allWalls) {
    if (w.visible === false) continue;
    if (w.isCurved && Math.abs(w.curveBulgeMm) >= 1) continue;
    if (Math.abs(w.thicknessMm - targetWall.thicknessMm) > 2) continue;
    const d = unitWallDir(w);
    if (d.len < 10) continue;
    const dot = d.ux * ux + d.uy * uy;
    if (Math.abs(dot) < 0.998) continue;

    const wCenterOff = getWallCenterlineOffset(w, ux, uy);
    const pStart = (w.start.x - targetWall.start.x) * nx + (w.start.y - targetWall.start.y) * ny + wCenterOff;
    const pEnd = (w.end.x - targetWall.start.x) * nx + (w.end.y - targetWall.start.y) * ny + wCenterOff;
    if (Math.abs(pStart - targetCenterOff) > 16 || Math.abs(pEnd - targetCenterOff) > 16) continue;

    const sameDir = dot >= 0;
    const wSide: 'left' | 'right' = sameDir
      ? viewedPhysicalSide
      : viewedPhysicalSide === 'left'
        ? 'right'
        : 'left';
    const wFaces = resolveWallFaces(w, rooms);
    const wRoomId = (wSide === 'left' ? wFaces.left.roomId : wFaces.right.roomId) ?? null;
    if (wRoomId !== targetRoomId) continue;

    const sA = (w.start.x - targetWall.start.x) * ux + (w.start.y - targetWall.start.y) * uy;
    const sB = (w.end.x - targetWall.start.x) * ux + (w.end.y - targetWall.start.y) * uy;
    candidates.push({ wall: w, sMin: Math.min(sA, sB), sMax: Math.max(sA, sB) });
  }

  if (candidates.length < 2) return null;
  candidates.sort((a, b) => a.sMin - b.sMin);
  const targetIdx = candidates.findIndex((c) => c.wall.id === targetWall.id);
  if (targetIdx < 0) return null;

  const maxGap = targetRoomId !== null ? 2600 : 16;
  let lo = targetIdx;
  let hi = targetIdx;

  // Walk rightward
  while (hi + 1 < candidates.length) {
    const gap = candidates[hi + 1].sMin - candidates[hi].sMax;
    if (gap < -12 || gap > maxGap) break;
    const nextChain = candidates.slice(lo, hi + 2).map((c) => c.wall);
    const elig = validateWallConsolidationEligibility(nextChain, allWalls);
    if (!isWallSideUnobstructed(targetWall, viewedPhysicalSide, elig)) break;
    hi += 1;
  }

  // Walk leftward
  while (lo - 1 >= 0) {
    const gap = candidates[lo].sMin - candidates[lo - 1].sMax;
    if (gap < -12 || gap > maxGap) break;
    const nextChain = candidates.slice(lo - 1, hi + 1).map((c) => c.wall);
    const elig = validateWallConsolidationEligibility(nextChain, allWalls);
    if (!isWallSideUnobstructed(targetWall, viewedPhysicalSide, elig)) break;
    lo -= 1;
  }

  const chain = candidates.slice(lo, hi + 1).map((c) => c.wall);
  return chain.length >= 2 ? chain : null;
}

function assembleConsolidatedWallRun(
  targetWall: Wall,
  viewedPhysicalSide: 'left' | 'right',
  groupWalls: Wall[],
  allWalls: Wall[],
  rooms: Room[],
  groupId: string,
  source: 'manual' | 'auto'
): ConsolidatedWallRun | null {
  // Use targetWall's direction as canonical run axis so viewedPhysicalSide aligns identically
  const { ux, uy, len } = unitWallDir(targetWall);
  if (len < 10) return null;
  const nx = -uy;
  const ny = ux;

  const rawItems = groupWalls.map((w) => {
    const sA = (w.start.x - targetWall.start.x) * ux + (w.start.y - targetWall.start.y) * uy;
    const sB = (w.end.x - targetWall.start.x) * ux + (w.end.y - targetWall.start.y) * uy;
    const sameDir = sB >= sA;
    return {
      wall: w,
      sMin: Math.min(sA, sB),
      sMax: Math.max(sA, sB),
      sameDir,
    };
  });
  rawItems.sort((a, b) => a.sMin - b.sMin);

  const globalMinS = rawItems[0].sMin;
  const globalMaxS = rawItems[rawItems.length - 1].sMax;
  const totalLenMm = Math.max(100, globalMaxS - globalMinS);

  const originPt: Point2D = {
    x: targetWall.start.x + ux * globalMinS,
    y: targetWall.start.y + uy * globalMinS,
  };
  const endPt: Point2D = {
    x: targetWall.start.x + ux * globalMaxS,
    y: targetWall.start.y + uy * globalMaxS,
  };

  const segments: ConsolidatedWallSegment[] = [];
  const gaps: ConsolidatedWallGap[] = [];

  for (let i = 0; i < rawItems.length; i++) {
    const item = rawItems[i];
    const startRunS = item.sMin - globalMinS;
    const endRunS = item.sMax - globalMinS;
    const segLen = Math.max(10, endRunS - startRunS);

    if (i > 0) {
      const prevEnd = rawItems[i - 1].sMax - globalMinS;
      if (startRunS - prevEnd > 12) {
        gaps.push({
          startRunS: prevEnd,
          endRunS: startRunS,
          widthMm: startRunS - prevEnd,
        });
      }
    }

    const segPhysicalSide: 'left' | 'right' = item.sameDir
      ? viewedPhysicalSide
      : viewedPhysicalSide === 'left'
        ? 'right'
        : 'left';

    const faces = resolveWallFaces(item.wall, rooms);
    const faceInfo = segPhysicalSide === 'left' ? faces.left : faces.right;
    const faceSlot = faceInfo.slot;

    segments.push({
      wall: item.wall,
      startRunS,
      endRunS,
      lengthMm: segLen,
      sameDir: item.sameDir,
      segPhysicalSide,
      faceSlot,
      color: faceSlot === 'inner' ? item.wall.innerColor : item.wall.outerColor,
      secondaryColor:
        faceSlot === 'inner' ? item.wall.innerSecondaryColor : item.wall.outerSecondaryColor,
      material: faceSlot === 'inner' ? item.wall.innerMaterial : item.wall.outerMaterial,
      textureScale:
        faceSlot === 'inner'
          ? (item.wall.innerTextureScale ?? 1)
          : (item.wall.outerTextureScale ?? 1),
      textureRotDeg:
        faceSlot === 'inner'
          ? (item.wall.innerTextureRotDeg ?? 0)
          : (item.wall.outerTextureRotDeg ?? 0),
      settings: faceSlot === 'inner' ? item.wall.innerSettings : item.wall.outerSettings,
      heightMm: item.wall.heightMm,
      hasBaseboard: item.wall.hasBaseboard,
      baseboardHeightMm: item.wall.baseboardHeightMm,
      baseboardColor: item.wall.baseboardColor,
      hasCrownMolding: item.wall.hasCrownMolding,
      crownHeightMm: item.wall.crownHeightMm,
      crownColor: item.wall.crownColor,
      roomId: faceInfo.roomId ?? null,
      roomName: faceInfo.roomName ?? null,
    });
  }

  const wallIds = new Set(groupWalls.map((w) => w.id));
  const distPt = (a: Point2D, b: Point2D) => Math.hypot(a.x - b.x, a.y - b.y);
  const hasStartCap = allWalls.some(
    (w) =>
      w.visible !== false &&
      !wallIds.has(w.id) &&
      (distPt(w.start, originPt) < 16 || distPt(w.end, originPt) < 16)
  );
  const hasEndCap = allWalls.some(
    (w) =>
      w.visible !== false &&
      !wallIds.has(w.id) &&
      (distPt(w.start, endPt) < 16 || distPt(w.end, endPt) < 16)
  );

  return {
    groupId,
    source,
    originPt,
    endPt,
    ux,
    uy,
    nx,
    ny,
    totalLenMm,
    maxHeightMm: Math.max(...segments.map((s) => s.heightMm)),
    segments,
    gaps,
    wallIds,
    hasStartCap,
    hasEndCap,
  };
}

/**
 * Builds a continuous Wall View run from an explicit consolidatedGroupId (when unobstructed on
 * the viewed side) or automatically across collinear same-room walls on the flat side of a T-junction.
 * Preserves each segment's individual height, finishes, materials, openings, and room face orientation.
 */
export function buildConsolidatedWallRun(
  targetWall: Wall,
  viewedPhysicalSide: 'left' | 'right',
  allWalls: Wall[],
  rooms: Room[]
): ConsolidatedWallRun | null {
  const gid = targetWall.consolidatedGroupId;
  if (gid) {
    const groupWalls = allWalls.filter((w) => w.visible !== false && w.consolidatedGroupId === gid);
    if (groupWalls.length >= 2) {
      const check = validateWallConsolidationEligibility(groupWalls, allWalls);
      if (isWallSideUnobstructed(targetWall, viewedPhysicalSide, check)) {
        return assembleConsolidatedWallRun(
          targetWall,
          viewedPhysicalSide,
          groupWalls,
          allWalls,
          rooms,
          gid,
          'manual'
        );
      }
    }
  }

  const autoChain = discoverAutoRoomWallGroup(targetWall, viewedPhysicalSide, allWalls, rooms);
  if (autoChain && autoChain.length >= 2) {
    const autoId = `auto:${autoChain.map((w) => w.id).sort().join('|')}`;
    return assembleConsolidatedWallRun(
      targetWall,
      viewedPhysicalSide,
      autoChain,
      allWalls,
      rooms,
      autoId,
      'auto'
    );
  }

  return null;
}

/**
 * Maps an opening or chimney's local s/t on a consolidated segment to the run's global s [0..totalLenMm].
 */
export function mapSegmentTToRunS(seg: ConsolidatedWallSegment, t: number): number {
  const segArc = Math.max(10, getWallArcLength(seg.wall));
  const localS = Math.max(0, Math.min(1, t)) * segArc;
  const clamped = Math.max(0, Math.min(seg.lengthMm, localS));
  return seg.sameDir ? seg.startRunS + clamped : seg.endRunS - clamped;
}

export function mapWallOpeningsToRun(
  run: ConsolidatedWallRun,
  openings: Opening[]
): Array<{ op: Opening; seg: ConsolidatedWallSegment; centerS: number; leftS: number; rightS: number }> {
  const segByWallId = new Map(run.segments.map((s) => [s.wall.id, s]));
  const result: Array<{
    op: Opening;
    seg: ConsolidatedWallSegment;
    centerS: number;
    leftS: number;
    rightS: number;
  }> = [];

  for (const op of openings) {
    if (!op.visible) continue;
    const seg = segByWallId.get(op.wallId);
    if (!seg) continue;
    const centerS = mapSegmentTToRunS(seg, op.t);
    const leftS = Math.max(seg.startRunS, centerS - op.widthMm / 2);
    const rightS = Math.min(seg.endRunS, centerS + op.widthMm / 2);
    result.push({ op, seg, centerS, leftS, rightS });
  }

  return result.sort((a, b) => a.leftS - b.leftS);
}

export function mapWallChimneysToRun(
  run: ConsolidatedWallRun,
  archElements: ArchElement[],
  projectToRun: (xMm: number, yMm: number) => { s: number; signedPerp: number }
): {
  chimneys: Array<{
    el: ArchElement;
    sCenter: number;
    leftS: number;
    rightS: number;
    effHeightMm: number;
    isDirectlyAttached: boolean;
  }>;
  oppositeSideCount: number;
} {
  const segByWallId = new Map(run.segments.map((s) => [s.wall.id, s]));
  const chimneys: Array<{
    el: ArchElement;
    sCenter: number;
    leftS: number;
    rightS: number;
    effHeightMm: number;
    isDirectlyAttached: boolean;
  }> = [];
  let oppositeSideCount = 0;

  for (const el of archElements) {
    if (!el.visible || el.type !== 'chimney') continue;
    if (el.attachedWallId && segByWallId.has(el.attachedWallId)) {
      const seg = segByWallId.get(el.attachedWallId)!;
      if (el.attachedFace && el.attachedFace !== seg.segPhysicalSide) {
        oppositeSideCount += 1;
        continue;
      }
      const sCenter =
        typeof el.attachedT === 'number'
          ? mapSegmentTToRunS(seg, el.attachedT)
          : projectToRun(el.xMm, el.yMm).s;
      const effHeightMm = el.connectToCeiling ? seg.heightMm : el.heightMm;
      chimneys.push({
        el,
        sCenter,
        leftS: Math.max(0, sCenter - el.widthMm / 2),
        rightS: Math.min(run.totalLenMm, sCenter + el.widthMm / 2),
        effHeightMm,
        isDirectlyAttached: true,
      });
    }
  }

  return { chimneys, oppositeSideCount };
}

export interface RoomWallSelectorEntry {
  id: string;
  representativeWallId: string;
  walls: Wall[];
  memberWallIds: string[];
  isConsolidated: boolean;
  source: 'manual' | 'auto' | 'single';
  totalLenMm: number;
  minHeightMm: number;
  maxHeightMm: number;
}

/**
 * Groups a room's walls so any consolidated wall run (explicit consolidatedGroupId or unobstructed
 * inline same-room chain) is represented as a single selectable entry while preserving individual
 * Wall segments untouched.
 */
export function buildRoomWallSelectorEntries(params: {
  roomWalls: Wall[];
  wallFaceMap?: Map<string, 'inner' | 'outer'>;
  allWalls: Wall[];
  rooms: Room[];
}): RoomWallSelectorEntry[] {
  const { roomWalls, wallFaceMap, allWalls, rooms } = params;
  const visibleRoomWalls = roomWalls.filter((w) => w.visible !== false);
  const roomWallIdSet = new Set(visibleRoomWalls.map((w) => w.id));
  const visited = new Set<string>();
  const entries: RoomWallSelectorEntry[] = [];

  for (const w of visibleRoomWalls) {
    if (visited.has(w.id)) continue;

    const insideFace: 'inner' | 'outer' = wallFaceMap?.get(w.id) ?? 'inner';
    const faces = resolveWallFaces(w, rooms);
    const viewedPhysicalSide: 'left' | 'right' =
      insideFace === 'inner' ? faces.primary.physicalSide : faces.secondary.physicalSide;

    const run = buildConsolidatedWallRun(w, viewedPhysicalSide, allWalls, rooms);
    if (run && run.segments.length >= 2) {
      const runWalls = run.segments.map((s) => s.wall);
      for (const rw of runWalls) {
        visited.add(rw.id);
      }
      const repWall =
        run.segments.find((s) => roomWallIdSet.has(s.wall.id))?.wall ?? run.segments[0].wall;
      const heights = runWalls.map((rw) => rw.heightMm);
      entries.push({
        id: run.groupId,
        representativeWallId: repWall.id,
        walls: runWalls,
        memberWallIds: runWalls.map((rw) => rw.id),
        isConsolidated: true,
        source: run.source,
        totalLenMm: run.totalLenMm,
        minHeightMm: Math.min(...heights),
        maxHeightMm: Math.max(...heights),
      });
      continue;
    }

    visited.add(w.id);
    entries.push({
      id: w.id,
      representativeWallId: w.id,
      walls: [w],
      memberWallIds: [w.id],
      isConsolidated: false,
      source: 'single',
      totalLenMm: getWallArcLength(w),
      minHeightMm: w.heightMm,
      maxHeightMm: w.heightMm,
    });
  }

  return entries;
}

/**
 * Resolves the active room scope for Wall View & its mini-viewer:
 * - Preserves selectorRoomId when no wall is active, or when the active wall belongs to that room.
 * - Otherwise auto-scopes to the room of the currently viewed wall face (or primary/secondary room,
 *   or the unassigned group if the wall does not bound any room).
 */
export function resolveWallViewRoomId(params: {
  selectorRoomId: string | null;
  roomGroups: Array<{ id: string; walls: Wall[] }>;
  targetWall: Wall | null;
  viewedFaceRoomId: string | null;
  primaryRoomId: string | null;
  secondaryRoomId: string | null;
  unassignedGroupId: string;
}): string | null {
  const {
    selectorRoomId,
    roomGroups,
    targetWall,
    viewedFaceRoomId,
    primaryRoomId,
    secondaryRoomId,
    unassignedGroupId,
  } = params;

  const groupIds = new Set(roomGroups.map((g) => g.id));
  const selectedGroup =
    selectorRoomId && groupIds.has(selectorRoomId)
      ? roomGroups.find((g) => g.id === selectorRoomId) ?? null
      : null;

  if (!targetWall) {
    return selectedGroup ? selectedGroup.id : null;
  }

  if (selectedGroup && selectedGroup.walls.some((w) => w.id === targetWall.id)) {
    return selectedGroup.id;
  }

  if (viewedFaceRoomId && groupIds.has(viewedFaceRoomId)) {
    return viewedFaceRoomId;
  }
  if (primaryRoomId && groupIds.has(primaryRoomId)) {
    return primaryRoomId;
  }
  if (secondaryRoomId && groupIds.has(secondaryRoomId)) {
    return secondaryRoomId;
  }

  const containingGroup = roomGroups.find((g) => g.walls.some((w) => w.id === targetWall.id));
  if (containingGroup) {
    return containingGroup.id;
  }

  return groupIds.has(unassignedGroupId) ? unassignedGroupId : null;
}

