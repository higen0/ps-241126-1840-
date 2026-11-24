import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyWallConsolidation,
  buildConsolidatedWallRun,
  buildRoomWallSelectorEntries,
  clearWallConsolidation,
  mapWallOpeningsToRun,
  resolveWallViewRoomId,
  validateWallConsolidationEligibility,
} from './wallConsolidation.ts';
import type { Opening, Room, Wall } from '../types/plan.ts';

function makeWall(
  id: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  opts: Partial<Wall> = {}
): Wall {
  return {
    id,
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 },
    thicknessMm: 150,
    heightMm: 2600,
    alignment: 'center',
    isCurved: false,
    curveBulgeMm: 0,
    innerColor: '#FFFFFF',
    outerColor: '#E2E8F0',
    innerMaterial: 'paint',
    outerMaterial: 'paint',
    innerTextureScale: 1,
    outerTextureScale: 1,
    innerTextureRotDeg: 0,
    outerTextureRotDeg: 0,
    hasBaseboard: true,
    baseboardHeightMm: 80,
    baseboardColor: '#FFFFFF',
    hasCrownMolding: false,
    crownHeightMm: 60,
    crownColor: '#FFFFFF',
    visible: true,
    locked: false,
    ...opts,
  };
}

function makeDoor(id: string, wallId: string, t: number, widthMm = 900): Opening {
  return {
    id,
    wallId,
    category: 'door',
    subtype: 'single',
    name: 'Door',
    t,
    widthMm,
    heightMm: 2100,
    sillHeightMm: 0,
    frameThicknessMm: 50,
    frameColor: '#475569',
    panelColor: '#94A3B8',
    glassColor: '#BAE6FD',
    swingSide: 'left',
    swingDirection: 'in',
    openAngleDeg: 0,
    visible: true,
    locked: false,
  };
}

test('validateWallConsolidationEligibility accepts inline touching or doorway-bridged walls and rejects corners, T-junctions & mismatched widths', () => {
  // Split touching walls
  const w1 = makeWall('w1', 0, 0, 1500, 0);
  const w2 = makeWall('w2', 1500, 0, 3200, 0);
  const touchRes = validateWallConsolidationEligibility([w1, w2], [w1, w2]);
  assert.equal(touchRes.eligible, true);
  assert.deepEqual(touchRes.orderedWallIds, ['w1', 'w2']);

  // Doorway-bridged inline walls (900mm gap)
  const wGap2 = makeWall('w2g', 2400, 0, 4000, 0);
  const gapRes = validateWallConsolidationEligibility([w1, wGap2], [w1, wGap2]);
  assert.equal(gapRes.eligible, true);

  // Corner (90 deg) -> rejected
  const wCorner = makeWall('wc', 1500, 0, 1500, 2000);
  const cornerRes = validateWallConsolidationEligibility([w1, wCorner], [w1, wCorner]);
  assert.equal(cornerRes.eligible, false);

  // Mismatched thickness -> rejected
  const wThick = makeWall('wt', 1500, 0, 3000, 0, { thicknessMm: 220 });
  const thickRes = validateWallConsolidationEligibility([w1, wThick], [w1, wThick]);
  assert.equal(thickRes.eligible, false);

  // One-sided T-junction intersecting at shared vertex -> eligible on flat side only
  const wTee = makeWall('wtee', 1500, 0, 1500, 2000);
  const teeRes = validateWallConsolidationEligibility([w1, w2], [w1, w2, wTee]);
  assert.equal(teeRes.eligible, true);
  assert.equal(teeRes.flatSideOnly, true);
  assert.equal(teeRes.flatSideRef, 'right');

  // Crossing (+) wall -> rejected
  const wCross = makeWall('wcross', 1500, -1500, 1500, 2000);
  const crossRes = validateWallConsolidationEligibility([w1, w2], [w1, w2, wCross]);
  assert.equal(crossRes.eligible, false);

  // Opposite-side T-junctions on both left and right sides -> rejected
  const wTeeTop = makeWall('wteetop', 800, 0, 800, -1500);
  const oppTeeRes = validateWallConsolidationEligibility([w1, w2], [w1, w2, wTee, wTeeTop]);
  assert.equal(oppTeeRes.eligible, false);

  // Outer corner walls meeting run ends (including inner-face corner snap within miter zone) -> eligible
  const wCornerLeft = makeWall('wcl', 0, 0, 0, 2500);
  const wCornerRight = makeWall('wcr', 3125, 0, 3125, 2500);
  const outerCornerRes = validateWallConsolidationEligibility([w1, w2], [w1, w2, wCornerLeft, wCornerRight]);
  assert.equal(outerCornerRes.eligible, true);

  // Unrelated distant gap -> rejected
  const wFar = makeWall('wfar', 6000, 0, 7500, 0);
  const farRes = validateWallConsolidationEligibility([w1, wFar], [w1, wFar]);
  assert.equal(farRes.eligible, false);
});

test('automatic same-room Wall View merges across flat side of T-junction while keeping T-stem side separated per room', () => {
  // Living room sits on the top/right side (y < 0), Bedroom 1 and Bedroom 2 sit on bottom/left side (y > 0) split by wDiv
  const wLeft = makeWall('wl', 0, 0, 2500, 0, { outerColor: '#E0F2FE', innerColor: '#FEF3C7' });
  const wRight = makeWall('wr', 2500, 0, 5000, 0, { outerColor: '#E0F2FE', innerColor: '#DCFCE7' });
  const wDiv = makeWall('wdiv', 2500, 0, 2500, 3000);
  const allWalls = [wLeft, wRight, wDiv];

  const livingRoom: Room = {
    id: 'r_living',
    name: 'Living Room',
    polygon: [
      { x: 75, y: -3000 },
      { x: 4925, y: -3000 },
      { x: 4925, y: -75 },
      { x: 75, y: -75 },
    ],
    areaM2: 14,
    perimeterM: 16,
    floorColor: '#FFFFFF',
    floorMaterial: 'wood',
    floorTextureScale: 1,
    floorTextureRotDeg: 0,
    floorLevelMm: 0,
    hasCeiling: true,
    ceilingHeightMm: 2600,
    ceilingColor: '#FFFFFF',
    ceilingMaterial: 'paint',
    visible: true,
    locked: false,
  };
  const bed1: Room = {
    ...livingRoom,
    id: 'r_bed1',
    name: 'Bedroom 1',
    polygon: [
      { x: 75, y: 75 },
      { x: 2425, y: 75 },
      { x: 2425, y: 2925 },
      { x: 75, y: 2925 },
    ],
  };
  const bed2: Room = {
    ...livingRoom,
    id: 'r_bed2',
    name: 'Bedroom 2',
    polygon: [
      { x: 2575, y: 75 },
      { x: 4925, y: 75 },
      { x: 4925, y: 2925 },
      { x: 2575, y: 2925 },
    ],
  };
  const rooms = [livingRoom, bed1, bed2];

  // Viewing from Living Room ('right' physical side -> y < 0, flat side) automatically builds continuous 5000mm run
  const flatAutoRun = buildConsolidatedWallRun(wLeft, 'right', allWalls, rooms);
  assert.ok(flatAutoRun);
  assert.equal(flatAutoRun.source, 'auto');
  assert.equal(flatAutoRun.totalLenMm, 5000);
  assert.equal(flatAutoRun.segments.length, 2);
  assert.equal(flatAutoRun.segments[0].roomName, 'Living Room');
  assert.equal(flatAutoRun.segments[1].roomName, 'Living Room');

  // Viewing from T-stem side ('left' physical side -> y > 0, Bedroom 1 vs Bedroom 2) remains separated even if manually consolidated
  assert.equal(buildConsolidatedWallRun(wLeft, 'left', allWalls, rooms), null);
  const manualWalls = applyWallConsolidation(allWalls, ['wl', 'wr'], 'wgrp_t');
  const flatManualRun = buildConsolidatedWallRun(manualWalls[0], 'right', manualWalls, rooms);
  assert.ok(flatManualRun);
  assert.equal(flatManualRun.source, 'manual');
  assert.equal(buildConsolidatedWallRun(manualWalls[0], 'left', manualWalls, rooms), null);
});

test('buildConsolidatedWallRun preserves per-segment finishes, heights, opposite drawing directions, openings, and room association', () => {
  // w1 drawn left-to-right (0 -> 1500), w2 drawn right-to-left (3400 -> 2400) with a doorway gap (1500..2400)
  // w2 has tile finish & taller height; w1 has blue paint & door opening
  const w1 = makeWall('w1', 0, 0, 1500, 0, {
    innerColor: '#DBEAFE',
    innerMaterial: 'paint',
    heightMm: 2600,
  });
  const w2 = makeWall('w2', 3400, 0, 2400, 0, {
    innerColor: '#F1F5F9',
    innerMaterial: 'tile',
    heightMm: 2800,
    faceFlipped: false,
  });
  const room: Room = {
    id: 'r1',
    name: 'Kitchen',
    polygon: [
      { x: 75, y: 75 },
      { x: 3325, y: 75 },
      { x: 3325, y: 3000 },
      { x: 75, y: 3000 },
    ],
    areaM2: 9.5,
    perimeterM: 12.4,
    floorColor: '#FFFFFF',
    floorMaterial: 'tile',
    floorTextureScale: 1,
    floorTextureRotDeg: 0,
    floorLevelMm: 0,
    hasCeiling: true,
    ceilingHeightMm: 2600,
    ceilingColor: '#FFFFFF',
    ceilingMaterial: 'paint',
    visible: true,
    locked: false,
  };

  const consolidated = applyWallConsolidation([w1, w2], ['w1', 'w2'], 'wgrp_1');
  assert.equal(consolidated[0].consolidatedGroupId, 'wgrp_1');
  assert.equal(consolidated[1].consolidatedGroupId, 'wgrp_1');

  const run = buildConsolidatedWallRun(consolidated[0], 'left', consolidated, [room]);
  assert.ok(run);
  assert.equal(run.totalLenMm, 3400);
  assert.equal(run.maxHeightMm, 2800);
  assert.equal(run.segments.length, 2);
  assert.equal(run.gaps.length, 1);
  assert.equal(run.gaps[0].startRunS, 1500);
  assert.equal(run.gaps[0].endRunS, 2400);

  // Segment 1 preserves blue paint + 2600mm; Segment 2 normalizes flipped direction to room-facing tile + 2800mm
  assert.equal(run.segments[0].color, '#DBEAFE');
  assert.equal(run.segments[0].material, 'paint');
  assert.equal(run.segments[0].heightMm, 2600);
  assert.equal(run.segments[1].sameDir, false);
  assert.equal(run.segments[1].segPhysicalSide, 'right');
  assert.equal(run.segments[1].color, '#F1F5F9');
  assert.equal(run.segments[1].material, 'tile');
  assert.equal(run.segments[1].heightMm, 2800);

  // Opening on w2 at t=0.3 maps accurately into global runS = 3400 - 300 = 3100
  const openings = mapWallOpeningsToRun(run, [makeDoor('d1', 'w2', 0.3, 600)]);
  assert.equal(openings.length, 1);
  assert.equal(Math.round(openings[0].centerS), 3100);

  // Persists cleanly across JSON save/reopen while keeping individual wall identities and properties intact
  const reopenedWalls = JSON.parse(JSON.stringify(consolidated)) as Wall[];
  assert.equal(reopenedWalls.length, 2);
  assert.equal(reopenedWalls[0].id, 'w1');
  assert.equal(reopenedWalls[1].id, 'w2');
  assert.equal(reopenedWalls[0].heightMm, 2600);
  assert.equal(reopenedWalls[1].heightMm, 2800);
  const reopenedRun = buildConsolidatedWallRun(reopenedWalls[0], 'left', reopenedWalls, [room]);
  assert.ok(reopenedRun);
  assert.equal(reopenedRun.groupId, 'wgrp_1');

  // Reversible separation clears manual group (reverts to auto same-room run inside enclosed room, or null without enclosing room)
  const separated = clearWallConsolidation(reopenedWalls, ['w1', 'w2']);
  assert.equal(separated[0].consolidatedGroupId, undefined);
  assert.equal(separated[1].consolidatedGroupId, undefined);
  assert.equal(buildConsolidatedWallRun(separated[0], 'left', separated, [room])?.source, 'auto');
  assert.equal(buildConsolidatedWallRun(separated[0], 'left', separated, []), null);
});

test('buildRoomWallSelectorEntries collapses consolidated segments into one room entry while preserving segments', () => {
  const w1 = makeWall('w1', 0, 0, 1500, 0, { heightMm: 2600 });
  const w2 = makeWall('w2', 1500, 0, 3200, 0, { heightMm: 2800 });
  const w3 = makeWall('w3', 3200, 0, 3200, 2400);
  const w4 = makeWall('w4', 3200, 2400, 0, 2400);
  const w5 = makeWall('w5', 0, 2400, 0, 0);
  const otherRoomWall = makeWall('other_w', 6000, 0, 8000, 0);

  const consolidated = applyWallConsolidation([w1, w2, w3, w4, w5, otherRoomWall], ['w1', 'w2'], 'grp_a');
  const roomA: Room = {
    id: 'room_a',
    name: 'Living Room',
    polygon: [
      { x: 0, y: 0 },
      { x: 3200, y: 0 },
      { x: 3200, y: 2400 },
      { x: 0, y: 2400 },
    ],
    areaM2: 7.68,
    perimeterM: 11.2,
    floorColor: '#FFFFFF',
    floorMaterial: 'wood',
    floorTextureScale: 1,
    floorTextureRotDeg: 0,
    floorLevelMm: 0,
    hasCeiling: true,
    ceilingHeightMm: 2600,
    ceilingColor: '#FFFFFF',
    ceilingMaterial: 'paint',
    visible: true,
    locked: false,
  };

  const roomWalls = consolidated.slice(0, 5);
  const entries = buildRoomWallSelectorEntries({
    roomWalls,
    allWalls: consolidated,
    rooms: [roomA],
  });

  // w1 + w2 collapse into 1 consolidated entry; total entries = 4 (not 5, and excludes other_w)
  assert.equal(entries.length, 4);
  const consEntry = entries.find((e) => e.isConsolidated);
  assert.ok(consEntry);
  assert.deepEqual(consEntry.memberWallIds, ['w1', 'w2']);
  assert.equal(consEntry.totalLenMm, 3200);
  assert.equal(consEntry.minHeightMm, 2600);
  assert.equal(consEntry.maxHeightMm, 2800);
  assert.equal(entries.some((e) => e.memberWallIds.includes('other_w')), false);
});

test('resolveWallViewRoomId keeps room context scoped and resolves active wall face room on direct entry', () => {
  const wA = makeWall('wA', 0, 0, 3000, 0);
  const wShared = makeWall('wShared', 3000, 0, 3000, 3000);
  const wB = makeWall('wB', 3000, 0, 6000, 0);
  const groups = [
    { id: 'roomA', walls: [wA, wShared] },
    { id: 'roomB', walls: [wShared, wB] },
    { id: '__unassigned__', walls: [] },
  ];

  // User in room wall selection stage stays in roomA
  assert.equal(
    resolveWallViewRoomId({
      selectorRoomId: 'roomA',
      roomGroups: groups,
      targetWall: null,
      viewedFaceRoomId: null,
      primaryRoomId: null,
      secondaryRoomId: null,
      unassignedGroupId: '__unassigned__',
    }),
    'roomA'
  );

  // Direct 2D selection on shared wall scopes mini-viewer to the currently viewed face room
  assert.equal(
    resolveWallViewRoomId({
      selectorRoomId: null,
      roomGroups: groups,
      targetWall: wShared,
      viewedFaceRoomId: 'roomB',
      primaryRoomId: 'roomA',
      secondaryRoomId: 'roomB',
      unassignedGroupId: '__unassigned__',
    }),
    'roomB'
  );

  // If selectorRoomId was pinned to roomA, shared wall preserves roomA until Back to Rooms
  assert.equal(
    resolveWallViewRoomId({
      selectorRoomId: 'roomA',
      roomGroups: groups,
      targetWall: wShared,
      viewedFaceRoomId: 'roomB',
      primaryRoomId: 'roomA',
      secondaryRoomId: 'roomB',
      unassignedGroupId: '__unassigned__',
    }),
    'roomA'
  );
});

