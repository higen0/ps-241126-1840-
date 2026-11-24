import test from 'node:test';
import assert from 'node:assert/strict';
import type { FurnitureInstance, FurniturePart } from '../types/plan';
import {
  computeFurnitureCanopyUndersideZMm,
  computePlanFurnitureOverlapMetadata,
  findFurnitureHitsAtPoint,
  isPointInFurniture2D,
  solveSolidFurnitureMove,
  sortFurnitureByElevationForPlan,
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

test('sortFurnitureByElevationForPlan orders rugs < floor drawers < elevated tabletops < surface items < ceiling fixtures', () => {
  const rug = makeFurn({
    id: 'rug',
    templateId: 'rug_rect',
    category: 'Decor & Plants',
    name: 'Area Rug',
    zOrder: 99, // High manual zOrder should never paint rug above furniture
    parts: [makePart({ widthMm: 2400, depthMm: 1800, heightMm: 12 })],
  });

  const drawers = makeFurn({
    id: 'drawers',
    name: 'Under-Desk Drawers',
    elevationMm: 0,
    zOrder: 10, // Created after tabletop, higher zOrder, yet physically below it
    parts: [makePart({ widthMm: 450, depthMm: 520, heightMm: 660 })],
  });

  const tabletop = makeFurn({
    id: 'tabletop',
    name: 'Custom Tabletop',
    elevationMm: 720,
    zOrder: 1,
    parts: [makePart({ widthMm: 1600, depthMm: 800, heightMm: 40 })],
  });

  const deskLamp = makeFurn({
    id: 'lamp',
    name: 'Desk Lamp',
    category: 'Lighting',
    surfaceHostId: 'tabletop',
    elevationMm: 760,
    zOrder: 2,
    parts: [makePart({ shape: 'cylinder', widthMm: 220, depthMm: 220, heightMm: 420 })],
  });

  const pendant = makeFurn({
    id: 'pendant',
    name: 'Ceiling Pendant',
    category: 'Lighting',
    mountingType: 'ceiling',
    elevationMm: 2200,
    zOrder: 0,
    parts: [makePart({ shape: 'sphere', widthMm: 360, depthMm: 360, heightMm: 300 })],
  });

  const input = [pendant, drawers, rug, deskLamp, tabletop];
  const infoMap = computePlanFurnitureOverlapMetadata(input, 2700);
  const sorted = sortFurnitureByElevationForPlan(input, infoMap, 2700).map((f) => f.id);

  assert.deepEqual(sorted, ['rug', 'drawers', 'tabletop', 'lamp', 'pendant']);
});

test('sortFurnitureByElevationForPlan preserves manual zOrder tie-breaking at equal elevation spans', () => {
  const boxA = makeFurn({
    id: 'a',
    xMm: 1000,
    zOrder: 2,
    parts: [makePart({ heightMm: 750 })],
  });
  const boxB = makeFurn({
    id: 'b',
    xMm: 1200,
    zOrder: 0,
    parts: [makePart({ heightMm: 750 })],
  });
  const sorted = sortFurnitureByElevationForPlan([boxA, boxB]).map((f) => f.id);
  assert.deepEqual(sorted, ['b', 'a']);
});

test('computePlanFurnitureOverlapMetadata identifies elevated slab canopies and multi-part open desks covering lower drawers', () => {
  const drawers = makeFurn({
    id: 'drawers',
    name: 'Pedestal Drawers',
    xMm: 2400,
    yMm: 2000,
    elevationMm: 0,
    parts: [makePart({ widthMm: 440, depthMm: 520, heightMm: 650 })],
  });

  const deskWithLegs = makeFurn({
    id: 'desk',
    name: 'Open Study Desk',
    category: 'Tables & Desks',
    xMm: 2000,
    yMm: 2000,
    elevationMm: 0,
    parts: [
      makePart({
        id: 'leg_l',
        xMm: -720,
        yMm: 0,
        zMm: 0,
        widthMm: 50,
        depthMm: 700,
        heightMm: 710,
      }),
      makePart({
        id: 'leg_r',
        xMm: 720,
        yMm: 0,
        zMm: 0,
        widthMm: 50,
        depthMm: 700,
        heightMm: 710,
      }),
      makePart({
        id: 'top',
        xMm: 0,
        yMm: 0,
        zMm: 710,
        widthMm: 1600,
        depthMm: 750,
        heightMm: 40,
      }),
    ],
  });

  const adjacentBookshelf = makeFurn({
    id: 'bookshelf',
    name: 'Side Bookshelf',
    xMm: 4200,
    yMm: 2000,
    elevationMm: 0,
    parts: [makePart({ widthMm: 800, depthMm: 360, heightMm: 1800 })],
  });

  const canopyZ = computeFurnitureCanopyUndersideZMm(deskWithLegs, 2700);
  assert.equal(canopyZ, 710);

  const infoMap = computePlanFurnitureOverlapMetadata([drawers, deskWithLegs, adjacentBookshelf], 2700);
  const drawersInfo = infoMap.get('drawers')!;
  const deskInfo = infoMap.get('desk')!;
  const shelfInfo = infoMap.get('bookshelf')!;

  assert.deepEqual(deskInfo.coveringLowerIds, ['drawers']);
  assert.deepEqual(drawersInfo.coveredByUpperIds, ['desk']);
  assert.deepEqual(drawersInfo.sameSpotOverlapIds, ['desk']);
  assert.deepEqual(shelfInfo.sameSpotOverlapIds, []);
  assert.deepEqual(shelfInfo.coveringLowerIds, []);
  assert.deepEqual(shelfInfo.coveredByUpperIds, []);
});

test('findFurnitureHitsAtPoint returns vertical stack topmost-first including rotated custom objects and skips hidden items', () => {
  const customDrawer = makeFurn({
    id: 'drawer_glb',
    name: 'Custom Mesh Drawer',
    xMm: 3000,
    yMm: 3000,
    rotationDeg: 35,
    elevationMm: 0,
    glbDataUrl: '/uploads/drawer.glb',
    parts: [makePart({ widthMm: 500, depthMm: 500, heightMm: 620 })],
  });

  const tabletop = makeFurn({
    id: 'tabletop',
    name: 'Worktop',
    xMm: 3000,
    yMm: 3000,
    rotationDeg: 35,
    elevationMm: 740,
    parts: [makePart({ widthMm: 1400, depthMm: 700, heightMm: 40 })],
  });

  const hiddenLamp = makeFurn({
    id: 'hidden_lamp',
    name: 'Hidden Lamp',
    xMm: 3000,
    yMm: 3000,
    elevationMm: 800,
    visible: false,
    parts: [makePart({ widthMm: 300, depthMm: 300, heightMm: 400 })],
  });

  const items = [customDrawer, tabletop, hiddenLamp];
  const infoMap = computePlanFurnitureOverlapMetadata(items, 2700);

  assert.equal(isPointInFurniture2D({ x: 3000, y: 3000 }, customDrawer), true);
  assert.equal(isPointInFurniture2D({ x: 3450, y: 3300 }, customDrawer), false);
  assert.equal(isPointInFurniture2D({ x: 3450, y: 3300 }, tabletop), true);

  const centerHits = findFurnitureHitsAtPoint({ x: 3000, y: 3000 }, items, infoMap, 2700).map((h) => h.id);
  assert.deepEqual(centerHits, ['tabletop', 'drawer_glb']);

  const edgeHits = findFurnitureHitsAtPoint({ x: 3450, y: 3300 }, items, infoMap, 2700).map((h) => h.id);
  assert.deepEqual(edgeHits, ['tabletop']);
});

test('solveSolidFurnitureMove moves under-table drawers cleanly beneath elevated tabletop without Shift', () => {
  const drawers = makeFurn({
    id: 'drawers',
    name: 'Drawers',
    xMm: 1000,
    yMm: 2000,
    elevationMm: 0,
    parts: [makePart({ widthMm: 480, depthMm: 520, heightMm: 660 })],
  });

  const tabletop = makeFurn({
    id: 'tabletop',
    name: 'Elevated Tabletop',
    xMm: 2000,
    yMm: 2000,
    elevationMm: 720,
    parts: [makePart({ widthMm: 1600, depthMm: 800, heightMm: 40 })],
  });

  // With allowOverlap=false (standard drag without Shift), drawers slide right underneath tabletop (2000, 2000)
  const solved = solveSolidFurnitureMove(
    { x: 1000, y: 2000 },
    { x: 2000, y: 2000 },
    drawers,
    { walls: [], furniture: [drawers, tabletop], archElements: [] },
    { snapEnabled: false, gridSizeMm: 100, allowOverlap: false }
  );

  assert.equal(solved.xMm, 2000);
  assert.equal(solved.yMm, 2000);
  assert.equal(solved.elevationMm, 0);
});
