import test from 'node:test';
import assert from 'node:assert/strict';
import type { FurnitureInstance, FurniturePart, Room, Wall } from '../types/plan';
import {
  computeFurnitureClashIntersectionRegions,
  computeLocalStackPlacementZOrder,
  computePlanFurnitureOverlapMetadata,
  computeRoomGeometricCenter,
  findSupportingSurfacesForProp,
  insetPolygon2D,
  intersectConvexPolygons2D,
  isSurfaceMountable,
  isSupportingSurfaceFurniture,
  normalizeFurnitureLocalZOrders,
  pointInPolygon,
  polygonSignedArea2D,
  reorderFurnitureZOrder,
  snapFurnitureToPlan,
  solveSolidFurnitureMove,
} from './geometry';

function makePart(overrides: Partial<FurniturePart> = {}): FurniturePart {
  return {
    id: 'p1',
    name: 'Body',
    shape: 'box',
    xMm: 0,
    yMm: 0,
    zMm: 0,
    widthMm: 1000,
    depthMm: 600,
    heightMm: 750,
    rotationDeg: 0,
    color: '#D6D3D1',
    material: 'wood',
    ...overrides,
  };
}

function makeFurn(overrides: Partial<FurnitureInstance> = {}): FurnitureInstance {
  return {
    id: 'furn_1',
    templateId: 'custom_item',
    name: 'Item',
    category: 'Storage & Media',
    xMm: 2000,
    yMm: 2000,
    elevationMm: 0,
    rotationDeg: 0,
    rotationXDeg: 0,
    rotationYDeg: 0,
    mirroredX: false,
    mirroredY: false,
    lockProportions: false,
    parts: [makePart()],
    visible: true,
    locked: false,
    ...overrides,
  };
}

function makeRoom(id: string, name: string, polygon: Array<{ x: number; y: number }>): Room {
  return {
    id,
    name,
    polygon,
    areaM2: 16,
    perimeterM: 16,
    floorMaterial: 'oak',
    floorColor: '#E2E8F0',
    floorTextureScale: 1,
    floorTextureRotDeg: 0,
    floorLevelMm: 0,
    hasCeiling: true,
    ceilingHeightMm: 2700,
    ceilingColor: '#FFFFFF',
    ceilingMaterial: 'paint',
    visible: true,
    locked: false,
  };
}

test('Case 1 & 3: table lamp, floor TV, monitor, and kitchen appliance auto-stack smoothly onto exact supporting decks without Shift', () => {
  const tvStand = makeFurn({
    id: 'tv_stand',
    templateId: 'tv_unit_media',
    name: 'Fluted Media Lowboard',
    category: 'Storage & Media',
    xMm: 2000,
    yMm: 2000,
    parts: [
      makePart({
        id: 'console',
        zMm: 140,
        widthMm: 1800,
        depthMm: 440,
        heightMm: 360,
        detailStyle: 'cabinet',
      }),
      makePart({ id: 'leg_l', xMm: -800, zMm: 0, widthMm: 36, depthMm: 36, heightMm: 140 }),
    ],
  });

  const tableLamp = makeFurn({
    id: 'lamp1',
    templateId: 'light_table_ceramic',
    name: 'Ceramic Drum Table Lamp',
    category: 'Lighting',
    xMm: 2000,
    yMm: 1200,
    elevationMm: 0,
    parts: [makePart({ id: 'l', shape: 'oval', widthMm: 340, depthMm: 340, heightMm: 570 })],
  });

  // Dragging table lamp onto TV stand auto-mounts cleanly at exact deck height (500 mm) with zero clash
  const lampOnStand = solveSolidFurnitureMove(
    { x: tableLamp.xMm, y: tableLamp.yMm },
    { x: 2000, y: 2000 },
    tableLamp,
    { walls: [], furniture: [tvStand, tableLamp], archElements: [] },
    { snapEnabled: false, gridSizeMm: 50, allowFurnitureOverlap: false }
  );
  assert.equal(lampOnStand.surfaceHostId, 'tv_stand');
  assert.equal(lampOnStand.elevationMm, 500);
  assert.equal(lampOnStand.placingOnHostName, 'Fluted Media Lowboard');
  assert.deepEqual(lampOnStand.clashingNames, []);

  // Dragging near edge past capped 1/3 threshold (min(340/3, 120) = 113.3mm into deck) also mounts cleanly
  // tvStand spans Y [1780, 2220]. Lamp radius = 170, so at Y = 1720 overlap depth = 110 < 113.3 (blocks outside),
  // whereas at Y = 1700 overlap depth = 130 >= 113.3 -> stacks cleanly at 500mm!
  const lampGrazing = solveSolidFurnitureMove(
    { x: 2000, y: 1200 },
    { x: 2000, y: 1720 },
    tableLamp,
    { walls: [], furniture: [tvStand, tableLamp], archElements: [] },
    { snapEnabled: false, gridSizeMm: 50, allowFurnitureOverlap: false }
  );
  assert.equal(lampGrazing.surfaceHostId, undefined);
  assert.equal(lampGrazing.elevationMm, 0);
  assert.ok(lampGrazing.yMm <= 1615, `expected lamp to block outside TV stand edge, got y=${lampGrazing.yMm}`);

  const lampPastThreshold = solveSolidFurnitureMove(
    { x: 2000, y: 1200 },
    { x: 2000, y: 1740 },
    tableLamp,
    { walls: [], furniture: [tvStand, tableLamp], archElements: [] },
    { snapEnabled: false, gridSizeMm: 50, allowFurnitureOverlap: false }
  );
  assert.equal(lampPastThreshold.surfaceHostId, 'tv_stand');
  assert.equal(lampPastThreshold.elevationMm, 500);

  // Floor TV sits atop TV stand preserving rotation & drops cleanly to floor when moved clear
  const floorTv = makeFurn({
    id: 'tv1',
    templateId: 'tv_screen_stand',
    name: '55" Flat-Screen TV',
    category: 'Storage & Media',
    xMm: 600,
    yMm: 600,
    elevationMm: 0,
    rotationDeg: 18,
    parts: [makePart({ id: 'screen', widthMm: 1240, depthMm: 220, heightMm: 840, detailStyle: 'screen' })],
  });
  const onStand = solveSolidFurnitureMove(
    { x: floorTv.xMm, y: floorTv.yMm },
    { x: 2040, y: 2010 },
    floorTv,
    { walls: [], furniture: [tvStand, floorTv], archElements: [] },
    { snapEnabled: false, gridSizeMm: 50, allowFurnitureOverlap: false }
  );
  assert.equal(onStand.surfaceHostId, 'tv_stand');
  assert.equal(onStand.elevationMm, 500);
  assert.equal(onStand.rotationDeg, 18);

  const mountedTv: FurnitureInstance = {
    ...floorTv,
    xMm: onStand.xMm,
    yMm: onStand.yMm,
    elevationMm: onStand.elevationMm,
    surfaceHostId: onStand.surfaceHostId,
  };
  const offStand = solveSolidFurnitureMove(
    { x: mountedTv.xMm, y: mountedTv.yMm },
    { x: 4200, y: 4200 },
    mountedTv,
    { walls: [], furniture: [tvStand, mountedTv], archElements: [] },
    { snapEnabled: false, gridSizeMm: 50, allowFurnitureOverlap: false }
  );
  assert.equal(offStand.surfaceHostId, undefined);
  assert.equal(offStand.elevationMm, 0);

  // Kitchen appliance mounts onto kitchen counter (Case 3) and collides cleanly against another appliance already on the counter
  const counter = makeFurn({
    id: 'k_counter',
    templateId: 'kitchen_base_cabinet',
    name: 'Kitchen Base Cabinet',
    category: 'Kitchen',
    xMm: 8000,
    yMm: 2000,
    parts: [
      makePart({ id: 'cab', widthMm: 900, depthMm: 580, heightMm: 860, detailStyle: 'cabinet' }),
      makePart({ id: 'ct', zMm: 860, widthMm: 900, depthMm: 610, heightMm: 40, detailStyle: 'table_top' }),
    ],
  });
  const toasterOnCounter = makeFurn({
    id: 'toast',
    templateId: 'appliance_toaster',
    name: 'Toaster',
    category: 'Kitchen',
    xMm: 7850,
    yMm: 2000,
    elevationMm: 900,
    surfaceHostId: 'k_counter',
    parts: [makePart({ id: 'tb', widthMm: 260, depthMm: 220, heightMm: 210 })],
  });
  const espresso = makeFurn({
    id: 'esp',
    templateId: 'appliance_espresso_machine',
    name: 'Espresso Machine',
    category: 'Kitchen',
    xMm: 8220,
    yMm: 2000,
    elevationMm: 900,
    surfaceHostId: 'k_counter',
    parts: [makePart({ id: 'body', widthMm: 300, depthMm: 340, heightMm: 360 })],
  });
  const onCounterFree = solveSolidFurnitureMove(
    { x: 8220, y: 500 },
    { x: 8220, y: 2000 },
    { ...espresso, yMm: 500, elevationMm: 0, surfaceHostId: undefined },
    { walls: [], furniture: [counter, toasterOnCounter], archElements: [] },
    { snapEnabled: false, gridSizeMm: 50, allowFurnitureOverlap: false }
  );
  assert.equal(onCounterFree.surfaceHostId, 'k_counter');
  assert.equal(onCounterFree.elevationMm, 900);
  assert.deepEqual(onCounterFree.clashingNames, []);

  // Dragging espresso sideways into toaster on the counter with counter as preferredHostId stops cleanly outside toaster
  const blockedByToaster = solveSolidFurnitureMove(
    { x: espresso.xMm, y: espresso.yMm },
    { x: 7850, y: 2000 },
    espresso,
    { walls: [], furniture: [counter, toasterOnCounter, espresso], archElements: [] },
    { snapEnabled: false, gridSizeMm: 50, allowFurnitureOverlap: false, preferredHostId: 'k_counter' }
  );
  assert.ok(
    blockedByToaster.xMm >= 7850 + 130 + 150 - 10,
    `expected espresso to stop before clipping toaster at counter height, got x=${blockedByToaster.xMm}`
  );
  assert.deepEqual(blockedByToaster.clashingNames, []);

  // Without preferredHostId, dragging directly onto toaster auto-stacks atop toaster cleanly (universal stacking)
  const stackedOnToaster = solveSolidFurnitureMove(
    { x: espresso.xMm, y: espresso.yMm },
    { x: 7850, y: 2000 },
    espresso,
    { walls: [], furniture: [counter, toasterOnCounter, espresso], archElements: [] },
    { snapEnabled: false, gridSizeMm: 50, allowFurnitureOverlap: false }
  );
  assert.equal(stackedOnToaster.surfaceHostId, 'toast');
  assert.equal(stackedOnToaster.elevationMm, 1110);
  assert.deepEqual(stackedOnToaster.stackCandidates?.map((c) => c.hostId), ['toast', 'k_counter']);
});

test('Case 2 & 4: floor/ceiling/rug items are excluded from stacking; drawers tuck under elevated tabletop without Shift', () => {
  const tvStand = makeFurn({
    id: 'tv_stand',
    templateId: 'tv_unit_media',
    name: 'Fluted Media Lowboard',
    category: 'Storage & Media',
    xMm: 2500,
    yMm: 2500,
    parts: [makePart({ id: 'console', zMm: 140, widthMm: 1800, depthMm: 440, heightMm: 360, detailStyle: 'cabinet' })],
  });
  const floorCabinet = makeFurn({
    id: 'fc1',
    templateId: 'sideboard_fluted',
    name: 'Sideboard',
    category: 'Storage & Media',
    mountingType: 'floor',
    xMm: 2500,
    yMm: 1200,
    elevationMm: 0,
    parts: [makePart({ id: 'base', widthMm: 600, depthMm: 340, heightMm: 800 })],
  });
  const ceilingLight = makeFurn({
    id: 'cl1',
    templateId: 'light_pendant',
    name: 'Pendant',
    category: 'Lighting',
    mountingType: 'ceiling',
    xMm: 2500,
    yMm: 1200,
    elevationMm: 2200,
    parts: [makePart({ id: 'pend', widthMm: 360, depthMm: 360, heightMm: 300 })],
  });
  const rug = makeFurn({
    id: 'rug1',
    templateId: 'rug_woven',
    name: 'Woven Rug',
    category: 'Decor & Plants',
    xMm: 2500,
    yMm: 1200,
    elevationMm: 0,
    parts: [makePart({ id: 'r', widthMm: 2000, depthMm: 1400, heightMm: 12, detailStyle: 'rug' })],
  });
  assert.equal(isSurfaceMountable(floorCabinet), false);
  assert.equal(isSurfaceMountable(ceilingLight), false);
  assert.equal(isSurfaceMountable(rug), false);
  assert.equal(isSupportingSurfaceFurniture(ceilingLight), false);
  assert.equal(isSupportingSurfaceFurniture(rug), false);

  // Floor-mounted cabinet dragged into TV stand stops cleanly outside (never stacks or clips!)
  const floorCabBlocked = solveSolidFurnitureMove(
    { x: floorCabinet.xMm, y: floorCabinet.yMm },
    { x: 2500, y: 2500 },
    floorCabinet,
    { walls: [], furniture: [tvStand, floorCabinet], archElements: [] },
    { snapEnabled: false, gridSizeMm: 50, allowFurnitureOverlap: false }
  );
  assert.equal(floorCabBlocked.elevationMm, 0);
  assert.equal(floorCabBlocked.surfaceHostId, undefined);
  assert.ok(floorCabBlocked.yMm <= 2500 - 220 - 170 + 10, `expected floor item to stop before TV stand, got y=${floorCabBlocked.yMm}`);
  assert.deepEqual(floorCabBlocked.clashingNames, []);

  // Custom tabletop + under-desk floor drawers (Case 4)
  const customTop = makeFurn({
    id: 'top_slab',
    templateId: 'custom_tabletop',
    name: 'Custom Desk Top',
    category: 'Storage & Media',
    xMm: 6000,
    yMm: 2500,
    elevationMm: 720,
    parts: [makePart({ id: 'top', widthMm: 1600, depthMm: 800, heightMm: 40 })],
  });
  const drawers = makeFurn({
    id: 'drawers',
    templateId: 'custom_drawers',
    name: 'Under-Desk Drawers',
    category: 'Storage & Media',
    xMm: 6000,
    yMm: 800,
    parts: [makePart({ id: 'd', widthMm: 450, depthMm: 550, heightMm: 660 })],
  });

  const drawersRes = solveSolidFurnitureMove(
    { x: drawers.xMm, y: drawers.yMm },
    { x: 6000, y: 2500 },
    drawers,
    { walls: [], furniture: [customTop, drawers], archElements: [] },
    { snapEnabled: false, gridSizeMm: 50, allowFurnitureOverlap: false }
  );
  assert.equal(drawersRes.surfaceHostId, undefined);
  assert.equal(drawersRes.elevationMm, 0);
  assert.equal(drawersRes.xMm, 6000);
  assert.equal(drawersRes.yMm, 2500);
  assert.deepEqual(drawersRes.clashingNames, []);

  // Verify stack metadata classifies drawers beneath opaque tabletop
  const infoMap = computePlanFurnitureOverlapMetadata([
    customTop,
    { ...drawers, xMm: drawersRes.xMm, yMm: drawersRes.yMm },
  ]);
  assert.deepEqual(infoMap.get('drawers')?.coveredByUpperIds, ['top_slab']);
  assert.equal(infoMap.get('top_slab')?.stackDepthBelowTop, 0);
  assert.equal(infoMap.get('drawers')?.stackDepthBelowTop, 1);
});

test('Case 5, 6, 7: Modifier priority matrix (Ctrl, Shift, Ctrl+Shift)', () => {
  const openDesk = makeFurn({
    id: 'desk',
    templateId: 'desk_office',
    name: 'Studio Work Desk',
    category: 'Tables & Desks',
    xMm: 2000,
    yMm: 2000,
    parts: [
      makePart({ id: 'top', zMm: 715, widthMm: 1500, depthMm: 750, heightMm: 35, detailStyle: 'table_top' }),
      makePart({ id: 'ped', xMm: 500, zMm: 0, widthMm: 420, depthMm: 680, heightMm: 715 }),
    ],
  });
  const solidStand = makeFurn({
    id: 'stand',
    templateId: 'tv_unit_media',
    name: 'Media Console',
    category: 'Storage & Media',
    xMm: 6000,
    yMm: 2000,
    parts: [makePart({ id: 'console', zMm: 140, widthMm: 1800, depthMm: 440, heightMm: 360, detailStyle: 'cabinet' })],
  });
  const lamp = makeFurn({
    id: 'lamp',
    templateId: 'light_table_ceramic',
    name: 'Ceramic Table Lamp',
    category: 'Lighting',
    mountingType: 'surface',
    xMm: 2000,
    yMm: 2000,
    elevationMm: 750,
    surfaceHostId: 'desk',
    parts: [makePart({ id: 'l', widthMm: 240, depthMm: 240, heightMm: 380 })],
  });

  // Case 5a: Ctrl over open desk knee-well forces floor (0mm), clears surfaceHostId, stays valid
  const ctrlOpen = solveSolidFurnitureMove(
    { x: 2000, y: 2000 },
    { x: 2000, y: 2000 },
    lamp,
    { walls: [], furniture: [openDesk, lamp], archElements: [] },
    { snapEnabled: false, gridSizeMm: 50, allowFurnitureOverlap: false, forceFloor: true }
  );
  assert.equal(ctrlOpen.isForceFloor, true);
  assert.equal(ctrlOpen.elevationMm, 0);
  assert.equal(ctrlOpen.surfaceHostId, undefined);
  assert.deepEqual(ctrlOpen.clashingNames, []);

  // Case 5b: Ctrl dragging lamp toward solid TV stand forces floor (0mm) AND STILL prevents clashes!
  const ctrlSolid = solveSolidFurnitureMove(
    { x: 6000, y: 1200 },
    { x: 6000, y: 2000 },
    { ...lamp, xMm: 6000, yMm: 1200, elevationMm: 0, surfaceHostId: undefined },
    { walls: [], furniture: [solidStand, lamp], archElements: [] },
    { snapEnabled: false, gridSizeMm: 50, allowFurnitureOverlap: false, forceFloor: true }
  );
  assert.equal(ctrlSolid.isForceFloor, true);
  assert.equal(ctrlSolid.elevationMm, 0);
  assert.equal(ctrlSolid.surfaceHostId, undefined);
  assert.ok(ctrlSolid.yMm <= 2000 - 220 - 120 + 10, `Ctrl must still prevent solid clashes, got y=${ctrlSolid.yMm}`);
  assert.deepEqual(ctrlSolid.clashingNames, []);

  // Case 6: Shift allows free overlapping placement and disables surface stacking
  const shiftOverlap = solveSolidFurnitureMove(
    { x: 6000, y: 1200 },
    { x: 6000, y: 2000 },
    { ...lamp, xMm: 6000, yMm: 1200, elevationMm: 0, surfaceHostId: undefined },
    { walls: [], furniture: [solidStand, lamp], archElements: [] },
    { snapEnabled: false, gridSizeMm: 50, allowOverlap: true, allowFurnitureOverlap: true, forceFloor: false }
  );
  assert.equal(shiftOverlap.xMm, 6000);
  assert.equal(shiftOverlap.yMm, 2000);
  assert.equal(shiftOverlap.surfaceHostId, undefined);
  assert.equal(shiftOverlap.elevationMm, 0);
  assert.equal(shiftOverlap.isForceFloor, false);

  // Case 7: Ctrl + Shift forces floor (0mm) AND permits intentional free overlap
  const ctrlShift = solveSolidFurnitureMove(
    { x: 6000, y: 2000 },
    { x: 6000, y: 2000 },
    { ...lamp, xMm: 6000, yMm: 2000, elevationMm: 500, surfaceHostId: 'stand' },
    { walls: [], furniture: [solidStand, lamp], archElements: [] },
    { snapEnabled: false, gridSizeMm: 50, allowOverlap: true, allowFurnitureOverlap: true, forceFloor: true }
  );
  assert.equal(ctrlShift.isForceFloor, true);
  assert.equal(ctrlShift.elevationMm, 0);
  assert.equal(ctrlShift.surfaceHostId, undefined);
  assert.equal(ctrlShift.xMm, 6000);
  assert.equal(ctrlShift.yMm, 2000);
});

test('Case 8: separating already-overlapping floor items works freely without Shift, then blocks re-clashing once clear', () => {
  const cabA = makeFurn({
    id: 'cab_a',
    templateId: 'sideboard_fluted',
    name: 'Cabinet A',
    category: 'Storage & Media',
    mountingType: 'floor',
    xMm: 3000,
    yMm: 3000,
    parts: [makePart({ id: 'sa', widthMm: 1600, depthMm: 800, heightMm: 780 })],
  });
  const cabB = makeFurn({
    id: 'cab_b',
    templateId: 'sideboard_fluted',
    name: 'Cabinet B',
    category: 'Storage & Media',
    mountingType: 'floor',
    xMm: 3300,
    yMm: 3000,
    parts: [makePart({ id: 'sb', widthMm: 1600, depthMm: 800, heightMm: 780 })],
  });

  // Pull Cabinet B freely outward along +X WITHOUT Shift -> smoothly escapes without snagging or jumping
  const pulledOut = solveSolidFurnitureMove(
    { x: cabB.xMm, y: cabB.yMm },
    { x: 4800, y: 3000 },
    cabB,
    { walls: [], furniture: [cabA, cabB], archElements: [] },
    { snapEnabled: false, gridSizeMm: 50, allowFurnitureOverlap: false }
  );
  assert.equal(pulledOut.xMm, 4800);
  assert.equal(pulledOut.yMm, 3000);
  assert.deepEqual(pulledOut.clashingNames, []);

  // Immediately try to drag Cabinet B back left into Cabinet A without Shift -> strictly blocked at edge (x = 4600)!
  const separatedCabB: FurnitureInstance = { ...cabB, xMm: pulledOut.xMm, yMm: pulledOut.yMm };
  const blockedReentry = solveSolidFurnitureMove(
    { x: separatedCabB.xMm, y: separatedCabB.yMm },
    { x: 3500, y: 3000 },
    separatedCabB,
    { walls: [], furniture: [cabA, separatedCabB], archElements: [] },
    { snapEnabled: false, gridSizeMm: 50, allowFurnitureOverlap: false }
  );
  assert.ok(blockedReentry.xMm >= 4590, `expected re-entry to block cleanly outside x=4600, got ${blockedReentry.xMm}`);
  assert.deepEqual(blockedReentry.clashingNames, []);
});

test('Case 9: wall-mounted items do not gray out floor stacks beneath them, while graying lower wall-mounted items', () => {
  const drawers = makeFurn({
    id: 'lvl0_drawers',
    name: 'Floor Drawers',
    xMm: 2000,
    yMm: 2000,
    elevationMm: 0,
    parts: [makePart({ widthMm: 450, depthMm: 500, heightMm: 650 })],
  });
  const desk = makeFurn({
    id: 'lvl1_desk',
    name: 'Elevated Tabletop',
    xMm: 2000,
    yMm: 2000,
    elevationMm: 720,
    parts: [makePart({ widthMm: 1400, depthMm: 700, heightMm: 40 })],
  });
  const wallTv = makeFurn({
    id: 'lvl2_wall_tv',
    templateId: 'tv_wall_55',
    name: 'Wall TV',
    mountingType: 'wall',
    xMm: 2000,
    yMm: 2000,
    elevationMm: 1100,
    parts: [makePart({ widthMm: 1200, depthMm: 80, heightMm: 700 })],
  });
  const wallCabinet = makeFurn({
    id: 'lvl3_wall_cab',
    templateId: 'kitchen_wall_cabinet',
    name: 'Upper Wall Cabinet',
    mountingType: 'wall',
    xMm: 2000,
    yMm: 2000,
    elevationMm: 1900,
    parts: [makePart({ widthMm: 1200, depthMm: 350, heightMm: 500 })],
  });
  const ceilingLight = makeFurn({
    id: 'pendant',
    templateId: 'light_pendant',
    name: 'Ceiling Pendant',
    category: 'Lighting',
    mountingType: 'ceiling',
    xMm: 2000,
    yMm: 2000,
    elevationMm: 2450,
    parts: [makePart({ widthMm: 400, depthMm: 400, heightMm: 250 })],
  });

  const infoMap = computePlanFurnitureOverlapMetadata(
    [drawers, desk, wallTv, wallCabinet, ceilingLight],
    2700
  );
  // Wall-mounted items NEVER gray out floor/desk furniture beneath them:
  assert.equal(infoMap.get('lvl1_desk')?.stackDepthBelowTop, 0);
  assert.deepEqual(infoMap.get('lvl1_desk')?.coveredByUpperIds, []);
  // Drawers are covered ONLY by lvl1_desk (not by wall items or ceiling lights):
  assert.equal(infoMap.get('lvl0_drawers')?.stackDepthBelowTop, 1);
  assert.deepEqual(infoMap.get('lvl0_drawers')?.coveredByUpperIds, ['lvl1_desk']);

  // Wall-over-wall DOES apply progressive depth graying within the wall-mounted stack:
  assert.equal(infoMap.get('lvl3_wall_cab')?.stackDepthBelowTop, 0);
  assert.equal(infoMap.get('lvl2_wall_tv')?.stackDepthBelowTop, 1);
  assert.deepEqual(infoMap.get('lvl2_wall_tv')?.coveredByUpperIds, ['lvl3_wall_cab']);
});

test('geometric room-center snapping handles rectangular and concave U-shaped rooms accurately', () => {
  const rectRoom = makeRoom('r_rect', 'Dining Room', [
    { x: 0, y: 0 },
    { x: 3330, y: 0 },
    { x: 3330, y: 4230 },
    { x: 0, y: 4230 },
  ]);
  const rectCenter = computeRoomGeometricCenter(rectRoom);
  assert.deepEqual(rectCenter, { x: 1665, y: 2115 });

  const uRoom = makeRoom('r_u', 'Gallery', [
    { x: 0, y: 0 },
    { x: 6000, y: 0 },
    { x: 6000, y: 5000 },
    { x: 4600, y: 5000 },
    { x: 4600, y: 1200 },
    { x: 1400, y: 1200 },
    { x: 1400, y: 5000 },
    { x: 0, y: 5000 },
  ]);
  const uCenter = computeRoomGeometricCenter(uRoom);
  assert.equal(pointInPolygon(uCenter, uRoom.polygon), true);

  const pendant = makeFurn({
    id: 'pend1',
    templateId: 'light_pendant',
    name: 'Glass Pendant',
    category: 'Lighting',
    mountingType: 'ceiling',
    xMm: 500,
    yMm: 500,
    elevationMm: 2200,
    parts: [makePart({ id: 'p', widthMm: 350, depthMm: 350, heightMm: 450 })],
  });

  const snapRect = solveSolidFurnitureMove(
    { x: 1540, y: 2040 },
    { x: 1580, y: 2050 },
    pendant,
    { walls: [], furniture: [pendant], archElements: [], rooms: [rectRoom] },
    { snapEnabled: true, gridSizeMm: 50, allowFurnitureOverlap: false }
  );
  assert.equal(snapRect.xMm, 1665);
  assert.equal(snapRect.yMm, 2115);
  assert.equal(snapRect.roomCenterSnap?.roomId, 'r_rect');

  const snapU = solveSolidFurnitureMove(
    { x: uCenter.x - 100, y: uCenter.y + 80 },
    { x: uCenter.x - 90, y: uCenter.y + 70 },
    pendant,
    { walls: [], furniture: [pendant], archElements: [], rooms: [uRoom] },
    { snapEnabled: true, gridSizeMm: 50, allowFurnitureOverlap: false }
  );
  assert.equal(snapU.xMm, uCenter.x);
  assert.equal(snapU.yMm, uCenter.y);
  assert.equal(snapU.roomCenterSnap?.roomId, 'r_u');
});

test('Case 10: universal category-free stacking places freestanding/custom items onto any furniture and supports sandwich target switching', () => {
  const floorConsole = makeFurn({
    id: 'console_low',
    templateId: 'tv_unit_media',
    name: 'Low Console',
    category: 'Storage & Media',
    mountingType: 'floor',
    xMm: 3000,
    yMm: 3000,
    elevationMm: 0,
    parts: [makePart({ id: 'c', widthMm: 1600, depthMm: 600, heightMm: 450 })],
  });
  const floatingShelf = makeFurn({
    id: 'shelf_upper',
    templateId: 'tv_unit_floating',
    name: 'Floating Shelf',
    category: 'Storage & Media',
    mountingType: 'wall',
    xMm: 3000,
    yMm: 3000,
    elevationMm: 1050,
    parts: [makePart({ id: 's', widthMm: 1400, depthMm: 450, heightMm: 60 })],
  });
  const customPlanter = makeFurn({
    id: 'custom_planter',
    templateId: 'custom_123',
    name: 'Custom Planter',
    category: 'My Library',
    mountingType: 'freestanding',
    xMm: 3000,
    yMm: 1500,
    elevationMm: 0,
    rotationDeg: 27,
    parts: [makePart({ id: 'p', widthMm: 320, depthMm: 320, heightMm: 400 })],
  });

  // Top-to-bottom host candidates include upper shelf (1110) then lower console (450)
  const candidates = findSupportingSurfacesForProp(
    { x: 3000, y: 3000 },
    customPlanter,
    [floorConsole, floatingShelf, customPlanter]
  );
  assert.deepEqual(
    candidates.map((c) => c.host.id),
    ['shelf_upper', 'console_low']
  );

  // Default stacks on top furniture piece preserving rotationDeg
  const topRes = solveSolidFurnitureMove(
    { x: customPlanter.xMm, y: customPlanter.yMm },
    { x: 3000, y: 3000 },
    customPlanter,
    { walls: [], furniture: [floorConsole, floatingShelf, customPlanter], archElements: [] },
    { snapEnabled: false, gridSizeMm: 50, allowFurnitureOverlap: false }
  );
  assert.equal(topRes.surfaceHostId, 'shelf_upper');
  assert.equal(topRes.elevationMm, 1110);
  assert.equal(topRes.rotationDeg, 27);
  assert.equal(topRes.placingOnHostName, 'Floating Shelf');

  // Scrolling to lower host places cleanly in the middle gap (450 + 400 = 850 < 1050)
  const midRes = solveSolidFurnitureMove(
    { x: 3000, y: 3000 },
    { x: 3000, y: 3000 },
    { ...customPlanter, xMm: 3000, yMm: 3000, elevationMm: 1110, surfaceHostId: 'shelf_upper' },
    { walls: [], furniture: [floorConsole, floatingShelf, customPlanter], archElements: [] },
    { snapEnabled: false, gridSizeMm: 50, allowFurnitureOverlap: false, preferredHostId: 'console_low' }
  );
  assert.equal(midRes.surfaceHostId, 'console_low');
  assert.equal(midRes.elevationMm, 450);
  assert.equal(midRes.placingOnHostName, 'Low Console');
  assert.deepEqual(midRes.clashingNames, []);
});

test('Case 11: wall-mounted furniture preserves its wall face when cursor moves across its centerpoint', () => {
  const wall: Wall = {
    id: 'w_wall',
    start: { x: 0, y: 2000 },
    end: { x: 5000, y: 2000 },
    thicknessMm: 200,
    heightMm: 2800,
    alignment: 'center',
    isCurved: false,
    curveBulgeMm: 0,
    hasBaseboard: false,
    baseboardHeightMm: 100,
    baseboardColor: '#FFFFFF',
    hasCrownMolding: false,
    crownHeightMm: 80,
    crownColor: '#FFFFFF',
    innerColor: '#FFFFFF',
    outerColor: '#EEEEEE',
    innerMaterial: 'plaster',
    outerMaterial: 'plaster',
    innerTextureScale: 1,
    outerTextureScale: 1,
    innerTextureRotDeg: 0,
    outerTextureRotDeg: 0,
    visible: true,
    locked: false,
  };
  // Wall spans y = 1900 (right) to y = 2100 (left); normal is (0, +1).
  const wallTv = makeFurn({
    id: 'wall_tv_1',
    templateId: 'tv_wall_55',
    name: '55" Wall TV',
    category: 'Storage & Media',
    mountingType: 'wall',
    attachedWallId: 'w_wall',
    attachedFace: 'left',
    attachedT: 0.5,
    xMm: 2500,
    yMm: 2140,
    elevationMm: 1100,
    rotationDeg: 0,
    parts: [makePart({ id: 'tv', widthMm: 1200, depthMm: 80, heightMm: 700, detailStyle: 'wall_tv' })],
  });

  // Cursor/target jitters past centerpoint (y=2140 -> y=2040 -> y=1960 within hysteresis): face remains 'left' (0 deg)
  const snapNearCenter = snapFurnitureToPlan(
    { x: 2550, y: 1960 },
    wallTv,
    [wall],
    [],
    { snapEnabled: true, gridSizeMm: 50 }
  );
  assert.equal(snapNearCenter.attachedWallId, 'w_wall');
  assert.equal(snapNearCenter.attachedFace, 'left');
  assert.equal(snapNearCenter.rotationDeg, 0);

  // Even when dragged hard through solid wall in solveSolidFurnitureMove, it never flips backward into the wall
  const solidWallMove = solveSolidFurnitureMove(
    { x: 2500, y: 2140 },
    { x: 2550, y: 1700 },
    wallTv,
    { walls: [wall], furniture: [wallTv], archElements: [] },
    { snapEnabled: true, gridSizeMm: 50, allowFurnitureOverlap: false }
  );
  assert.equal(solidWallMove.attachedFace, 'left');
  assert.equal(solidWallMove.rotationDeg, 0);
  assert.ok(solidWallMove.yMm >= 2100, `expected TV to remain on left face y>=2100, got ${solidWallMove.yMm}`);
});

test('Case 12: per-stack local zOrder remains compact across 220+ furniture items and reorders independently', () => {
  const items: FurnitureInstance[] = [];
  for (let i = 0; i < 215; i++) {
    items.push(
      makeFurn({
        id: `solo_${i}`,
        name: `Solo ${i}`,
        xMm: 10000 + (i % 20) * 1500,
        yMm: 10000 + Math.floor(i / 20) * 1500,
        zOrder: 500 + i, // bloated legacy index
        parts: [makePart({ widthMm: 500, depthMm: 500, heightMm: 700 })],
      })
    );
  }
  const stackA1 = makeFurn({
    id: 'stackA_low',
    name: 'Table A1',
    xMm: 1500,
    yMm: 1500,
    zOrder: 218,
    parts: [makePart({ widthMm: 1000, depthMm: 800, heightMm: 740 })],
  });
  const stackA2 = makeFurn({
    id: 'stackA_high',
    name: 'Table A2',
    xMm: 1500,
    yMm: 1500,
    zOrder: 219,
    parts: [makePart({ widthMm: 1000, depthMm: 800, heightMm: 740 })],
  });
  const stackB1 = makeFurn({
    id: 'stackB_low',
    name: 'Chair B1',
    xMm: 5000,
    yMm: 1500,
    zOrder: 220,
    parts: [makePart({ widthMm: 600, depthMm: 600, heightMm: 800 })],
  });
  const stackB2 = makeFurn({
    id: 'stackB_high',
    name: 'Chair B2',
    xMm: 5000,
    yMm: 1500,
    zOrder: 221,
    parts: [makePart({ widthMm: 600, depthMm: 600, heightMm: 800 })],
  });

  const normalized = normalizeFurnitureLocalZOrders([...items, stackA1, stackA2, stackB1, stackB2]);
  const byId = new Map(normalized.map((f) => [f.id, f]));

  assert.equal(byId.get('solo_0')?.zOrder, 0);
  assert.equal(byId.get('solo_214')?.zOrder, 0);
  assert.equal(byId.get('stackA_low')?.zOrder, 0);
  assert.equal(byId.get('stackA_high')?.zOrder, 1);
  assert.equal(byId.get('stackB_low')?.zOrder, 0);
  assert.equal(byId.get('stackB_high')?.zOrder, 1);

  // Reordering stack A never alters stack B or standalone items, and keeps max zOrder <= 1
  const swappedA = reorderFurnitureZOrder(normalized, ['stackA_low'], 'forward');
  const byIdSwapped = new Map(swappedA.map((f) => [f.id, f]));
  assert.equal(byIdSwapped.get('stackA_low')?.zOrder, 1);
  assert.equal(byIdSwapped.get('stackA_high')?.zOrder, 0);
  assert.equal(byIdSwapped.get('stackB_low')?.zOrder, 0);
  assert.equal(byIdSwapped.get('stackB_high')?.zOrder, 1);
  assert.equal(byIdSwapped.get('solo_100')?.zOrder, 0);

  // Placing a 3rd item over stack A gets local zOrder = 2, while placing in empty space gets 0
  const stackA3 = makeFurn({
    id: 'stackA_3',
    xMm: 1500,
    yMm: 1500,
    parts: [makePart({ widthMm: 300, depthMm: 300, heightMm: 200 })],
  });
  const openItem = makeFurn({
    id: 'open_new',
    xMm: 2000,
    yMm: 4500,
    parts: [makePart({ widthMm: 400, depthMm: 400, heightMm: 400 })],
  });
  assert.equal(computeLocalStackPlacementZOrder(stackA3, swappedA, 'stackA_low'), 2);
  assert.equal(computeLocalStackPlacementZOrder(openItem, swappedA), 0);
});

test('Case 13: wall-mounted furniture never triggers stacking overlay or Vertical Stack links on floor furniture beneath it', () => {
  const floorConsole = makeFurn({
    id: 'console_floor',
    name: 'Media Console',
    mountingType: 'freestanding',
    xMm: 2000,
    yMm: 2000,
    elevationMm: 0,
    parts: [makePart({ widthMm: 1600, depthMm: 450, heightMm: 500 })],
  });
  const wallTv = makeFurn({
    id: 'wall_tv',
    name: 'Wall TV',
    templateId: 'tv_wall_65',
    mountingType: 'wall',
    attachedWallId: 'w_north',
    xMm: 2000,
    yMm: 1920,
    elevationMm: 1100,
    parts: [makePart({ widthMm: 1400, depthMm: 80, heightMm: 780, detailStyle: 'wall_tv' })],
  });
  const wallUpperShelf = makeFurn({
    id: 'wall_shelf',
    name: 'Wall Shelf Above TV',
    mountingType: 'wall',
    attachedWallId: 'w_north',
    xMm: 2000,
    yMm: 1940,
    elevationMm: 2050,
    parts: [makePart({ widthMm: 1200, depthMm: 220, heightMm: 60 })],
  });

  const infoMap = computePlanFurnitureOverlapMetadata([floorConsole, wallTv, wallUpperShelf], 2800);
  const consoleInfo = infoMap.get('console_floor')!;
  const tvInfo = infoMap.get('wall_tv')!;
  const shelfInfo = infoMap.get('wall_shelf')!;

  // Floor console must NOT be linked to or darkened by wall-mounted objects above it
  assert.deepEqual(consoleInfo.sameSpotOverlapIds, []);
  assert.deepEqual(consoleInfo.coveredByUpperIds, []);
  assert.equal(consoleInfo.stackDepthBelowTop, 0);

  // Wall objects still link & depth-gray strictly within the wall-mounted domain
  assert.deepEqual(tvInfo.sameSpotOverlapIds, ['wall_shelf']);
  assert.deepEqual(tvInfo.coveredByUpperIds, ['wall_shelf']);
  assert.equal(tvInfo.stackDepthBelowTop, 1);
  assert.deepEqual(shelfInfo.coveringLowerIds, ['wall_tv']);
});

test('Case 14: computeFurnitureClashIntersectionRegions returns exact 2D overlap polygons strictly for 3D-clashing areas', () => {
  // Overlapping corner of two 1000x600 floor cabinets shifted by (700, 300):
  // Overlap region should be 300mm x 300mm = 90,000 mm^2 (not the full 600,000 mm^2 piece)
  const cabA = makeFurn({
    id: 'cab_a',
    name: 'Cabinet A',
    xMm: 1000,
    yMm: 1000,
    elevationMm: 0,
    parts: [makePart({ widthMm: 1000, depthMm: 600, heightMm: 750 })],
  });
  const cabB = makeFurn({
    id: 'cab_b',
    name: 'Cabinet B',
    xMm: 1700,
    yMm: 1300,
    elevationMm: 0,
    mirroredX: true,
    parts: [makePart({ widthMm: 1000, depthMm: 600, heightMm: 750 })],
  });
  // Elevated Z-separated wall item overlapping in 2D should NOT clash
  const upperCabinet = makeFurn({
    id: 'cab_upper',
    name: 'Upper Wall Cabinet',
    mountingType: 'wall',
    xMm: 1000,
    yMm: 1000,
    elevationMm: 1400,
    parts: [makePart({ widthMm: 1000, depthMm: 400, heightMm: 600 })],
  });
  // Surface-hosted lamp sitting on cabA must NOT clash with cabA
  const hostedLamp = makeFurn({
    id: 'lamp_hosted',
    name: 'Lamp',
    surfaceHostId: 'cab_a',
    xMm: 1000,
    yMm: 1000,
    elevationMm: 750,
    parts: [makePart({ shape: 'cylinder', widthMm: 220, depthMm: 220, heightMm: 350 })],
  });

  const regions = computeFurnitureClashIntersectionRegions([cabA, cabB, upperCabinet, hostedLamp]);
  assert.equal(regions.length, 1);
  assert.equal(regions[0].idA, 'cab_a');
  assert.equal(regions[0].idB, 'cab_b');
  const overlapArea = Math.abs(polygonSignedArea2D(regions[0].poly));
  assert.ok(Math.abs(overlapArea - 90000) < 200, `expected 90000 mm^2 intersection, got ${overlapArea}`);

  // Mirrored winding clipping check
  const revPoly = [
    { x: 0, y: 0 },
    { x: 0, y: 500 },
    { x: 500, y: 500 },
    { x: 500, y: 0 },
  ];
  const shiftPoly = [
    { x: 300, y: 200 },
    { x: 800, y: 200 },
    { x: 800, y: 700 },
    { x: 300, y: 700 },
  ];
  const inter = intersectConvexPolygons2D(revPoly, shiftPoly);
  assert.ok(Math.abs(Math.abs(polygonSignedArea2D(inter)) - 60000) < 50);
});

test('Case 15: insetPolygon2D generates non-inverted strictly smaller concentric polygons even for small or reversed polygons', () => {
  const outer = [
    { x: 0, y: 0 },
    { x: 0, y: 600 },
    { x: 1000, y: 600 },
    { x: 1000, y: 0 },
  ];
  const tier1Inset = insetPolygon2D(outer, 45);
  const tier2Inset = insetPolygon2D(outer, 90);
  const outerArea = Math.abs(polygonSignedArea2D(outer));
  const t1Area = polygonSignedArea2D(tier1Inset);
  const t2Area = polygonSignedArea2D(tier2Inset);
  assert.ok(t1Area > 0 && t1Area < outerArea, `tier 1 inset must remain positive & smaller (${t1Area})`);
  assert.ok(t2Area > 0 && t2Area < t1Area, `tier 2 inset must be strictly inside tier 1 (${t2Area} < ${t1Area})`);

  // Extreme inset clamps gracefully without inverting
  const hugeInset = insetPolygon2D(outer, 900);
  assert.ok(polygonSignedArea2D(hugeInset) > 0);
});
