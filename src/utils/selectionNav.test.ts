import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  ArchElement,
  Curtain,
  FurnitureInstance,
  Level,
  Opening,
  PersonInstance,
  Wall,
} from '../types/plan';
import {
  classifyWheelGesture,
  computeAnchoredZoom,
  evaluateMarqueeSelection,
  getAdjacentStackLayerIds,
  mergeMarqueeSelection,
  resolveAltStackClickId,
  resolveMarqueeMode,
  resolvePlainStackClickId,
} from './selectionNav';
import { DEFAULT_KEYBINDS, matchKeybindAction } from './keybinds';
import { buildEmptyLevel } from '../data/templates';

function makeBaseLevel(): Level {
  return buildEmptyLevel('Ground');
}

function makeChair(id: string, xMm: number, yMm: number, rotationDeg = 0): FurnitureInstance {
  return {
    id,
    templateId: 'dining_chair',
    name: 'Chair',
    category: 'Sofas & Seating',
    xMm,
    yMm,
    elevationMm: 0,
    rotationDeg,
    mirroredX: false,
    mirroredY: false,
    lockProportions: true,
    visible: true,
    locked: false,
    parts: [
      {
        id: `${id}_seat`,
        name: 'Seat',
        shape: 'box',
        xMm: 0,
        yMm: 0,
        zMm: 0,
        widthMm: 500,
        depthMm: 500,
        heightMm: 450,
        rotationDeg: 0,
        color: '#94A3B8',
        material: 'fabric',
      },
    ],
  };
}

test('resolveMarqueeMode distinguishes left-to-right enclosed vs right-to-left crossing', () => {
  assert.equal(resolveMarqueeMode(100, 300), 'enclosed');
  assert.equal(resolveMarqueeMode(100, 100), 'enclosed');
  assert.equal(resolveMarqueeMode(300, 100), 'crossing');
});

test('marquee real footprint: touching only the corner of a chair (not its center) selects in R->L crossing and not L->R enclosed', () => {
  const level = makeBaseLevel();
  const chair = makeChair('chair_1', 1000, 1000, 0); // covers x:[750,1250], y:[750,1250]
  level.furniture.push(chair);

  // Corner-only box: x:[600, 820], y:[600, 820] — misses center (1000, 1000) completely!
  const rlHits = evaluateMarqueeSelection(level, { x: 820, y: 820 }, { x: 600, y: 600 });
  assert.deepEqual(rlHits, [{ kind: 'furniture', id: 'chair_1' }]);

  const lrCornerHits = evaluateMarqueeSelection(level, { x: 600, y: 600 }, { x: 820, y: 820 });
  assert.deepEqual(lrCornerHits, []);

  // Full enclosure L->R box: x:[700, 1300], y:[700, 1300]
  const lrFullHits = evaluateMarqueeSelection(level, { x: 700, y: 700 }, { x: 1300, y: 1300 });
  assert.deepEqual(lrFullHits, [{ kind: 'furniture', id: 'chair_1' }]);
});

test('marquee real footprint covers rotated furniture corners, walls, openings, arch elements, curtains, and people', () => {
  const level = makeBaseLevel();

  const wall: Wall = {
    id: 'w1',
    start: { x: 0, y: 0 },
    end: { x: 2000, y: 0 },
    thicknessMm: 150,
    heightMm: 2700,
    innerColor: '#FFFFFF',
    outerColor: '#FFFFFF',
    innerMaterial: 'plaster',
    outerMaterial: 'plaster',
    innerTextureScale: 1,
    outerTextureScale: 1,
    innerTextureRotDeg: 0,
    outerTextureRotDeg: 0,
    alignment: 'center',
    isCurved: false,
    curveBulgeMm: 0,
    hasBaseboard: true,
    baseboardHeightMm: 80,
    baseboardColor: '#FFFFFF',
    hasCrownMolding: false,
    crownHeightMm: 60,
    crownColor: '#FFFFFF',
    visible: true,
    locked: false,
  };
  const opening: Opening = {
    id: 'op1',
    wallId: 'w1',
    category: 'door',
    subtype: 'single',
    name: 'Door',
    t: 0.5,
    widthMm: 900,
    heightMm: 2100,
    sillHeightMm: 0,
    frameThicknessMm: 45,
    swingSide: 'left',
    swingDirection: 'in',
    openAngleDeg: 90,
    frameColor: '#334155',
    panelColor: '#FFFFFF',
    glassColor: '#E0F2FE',
    visible: true,
    locked: false,
  };
  const pillar: ArchElement = {
    id: 'arch_col',
    type: 'column_round',
    name: 'Column',
    xMm: 1000,
    yMm: 1000,
    elevationMm: 0,
    widthMm: 300,
    depthMm: 300,
    heightMm: 2700,
    rotationDeg: 0,
    color: '#CBD5E1',
    accentColor: '#64748B',
    material: 'plaster',
    visible: true,
    locked: false,
  };
  const railing: ArchElement = {
    id: 'arch_rail',
    type: 'railing',
    name: 'Railing',
    xMm: 1000,
    yMm: 1800,
    elevationMm: 0,
    widthMm: 1200,
    depthMm: 60,
    heightMm: 1000,
    rotationDeg: 0,
    color: '#334155',
    accentColor: '#334155',
    material: 'metal',
    visible: true,
    locked: false,
    railing: {
      style: 'modern_minimalist',
      nodes: [
        { xMm: -500, yMm: 0, elevationMm: 0 },
        { xMm: 500, yMm: 0, elevationMm: 0 },
      ],
      heightMm: 1000,
      widthMm: 60,
      closed: false,
      postSpacingMm: 600,
      balusterSpacingMm: 120,
      horizontalRailCount: 3,
      cableCount: 0,
      handrailShape: 'rectangular',
      handrailWidthMm: 50,
      handrailThicknessMm: 40,
      postShape: 'square',
      postSizeMm: 40,
      balusterSizeMm: 14,
      panelThicknessMm: 10,
      bottomRailEnabled: true,
      bottomRailHeightMm: 60,
      mountingMethod: 'top_mount',
      material: 'metal',
      secondaryColor: '#E2E8F0',
      glassTint: 'clear',
      accentColor: '#334155',
    },
  };
  const curtain: Curtain = {
    id: 'curt1',
    name: 'Curtain',
    style: 'drapes',
    rodType: 'pole',
    fullness: 1.8,
    xMm: 1000,
    yMm: 350,
    widthMm: 1200,
    heightMm: 2400,
    elevationMm: 100,
    rotationDeg: 0,
    color: '#F8FAFC',
    rodColor: '#334155',
    material: 'fabric',
    openPercent: 40,
    visible: true,
    locked: false,
  };
  const person: PersonInstance = {
    id: 'pers1',
    name: 'Person',
    pose: 'standing_man',
    xMm: 1000,
    yMm: 1400,
    elevationMm: 0,
    rotationDeg: 0,
    heightMm: 1750,
    color: '#E2E8F0',
    visible: true,
    locked: false,
  };
  const rotChair = makeChair('rot_c', 400, 1000, 45);

  level.walls.push(wall);
  level.openings.push(opening);
  level.archElements.push(pillar, railing);
  level.curtains.push(curtain);
  level.people.push(person);
  level.furniture.push(rotChair);

  // R->L crossing box slicing through a piece of all items around x:[900..1100], y:[-100..1900]
  // Note: does NOT touch rotated chair at x=400!
  const crossHits = evaluateMarqueeSelection(level, { x: 1100, y: 1900 }, { x: 900, y: -100 });
  const keys = crossHits.map((h) => `${h.kind}:${h.id}`);
  assert.ok(keys.includes('wall:w1'));
  assert.ok(keys.includes('opening:op1'));
  assert.ok(keys.includes('arch:arch_col'));
  assert.ok(keys.includes('arch:arch_rail'));
  assert.ok(keys.includes('curtain:curt1'));
  assert.ok(keys.includes('person:pers1'));
  assert.ok(!keys.includes('furniture:rot_c'));

  // L->R partial box must NOT select objects only partially overlapped
  const partialEnclosed = evaluateMarqueeSelection(level, { x: 900, y: -100 }, { x: 1100, y: 1900 });
  assert.equal(partialEnclosed.length, 0);

  // Huge L->R box enclosing everything selects all 7 items
  const allEnclosed = evaluateMarqueeSelection(level, { x: -200, y: -400 }, { x: 2200, y: 2100 });
  assert.equal(allEnclosed.length, 7);
});

test('mergeMarqueeSelection preserves existing targets cleanly when Shift additive is active', () => {
  const existing = [{ kind: 'furniture' as const, id: 'f1' }];
  const hits = [
    { kind: 'furniture' as const, id: 'f1' },
    { kind: 'wall' as const, id: 'w1' },
  ];
  assert.deepEqual(mergeMarqueeSelection(existing, hits, true), [
    { kind: 'furniture', id: 'f1' },
    { kind: 'wall', id: 'w1' },
  ]);
  assert.deepEqual(mergeMarqueeSelection(existing, hits, false), hits);
});

test('stack selection helpers pick topmost on plain click and cycle downward on Alt+click / context menu', () => {
  const stackTopToBottom = ['lamp_top', 'books_mid', 'table_bot'];
  assert.equal(resolvePlainStackClickId(stackTopToBottom), 'lamp_top');
  assert.equal(resolvePlainStackClickId([]), null);

  assert.equal(
    resolveAltStackClickId(stackTopToBottom, [{ kind: 'furniture', id: 'lamp_top' }]),
    'books_mid'
  );
  assert.equal(
    resolveAltStackClickId(stackTopToBottom, [{ kind: 'furniture', id: 'books_mid' }]),
    'table_bot'
  );
  assert.equal(
    resolveAltStackClickId(stackTopToBottom, [{ kind: 'furniture', id: 'table_bot' }]),
    'lamp_top'
  );

  assert.deepEqual(getAdjacentStackLayerIds(stackTopToBottom, 'lamp_top'), {
    aboveId: null,
    belowId: 'books_mid',
  });
  assert.deepEqual(getAdjacentStackLayerIds(stackTopToBottom, 'books_mid'), {
    aboveId: 'lamp_top',
    belowId: 'table_bot',
  });
  assert.deepEqual(getAdjacentStackLayerIds(stackTopToBottom, 'table_bot'), {
    aboveId: 'books_mid',
    belowId: null,
  });
});

test('classifyWheelGesture handles Ctrl+wheel / pinch proportional zoom, mouse wheel zoom, and trackpad pan', () => {
  // Pinch / Ctrl+wheel scales proportionally with deltaY
  const pinchSmall = classifyWheelGesture({
    deltaX: 0,
    deltaY: -10,
    deltaMode: 0,
    ctrlKey: true,
    metaKey: false,
  });
  const pinchLarge = classifyWheelGesture({
    deltaX: 0,
    deltaY: -40,
    deltaMode: 0,
    ctrlKey: true,
    metaKey: false,
  });
  assert.equal(pinchSmall.kind, 'zoom');
  assert.equal(pinchLarge.kind, 'zoom');
  if (pinchSmall.kind === 'zoom' && pinchLarge.kind === 'zoom') {
    assert.ok(pinchSmall.factor > 1);
    assert.ok(pinchLarge.factor > pinchSmall.factor);
  }

  // Discrete mouse wheel notch (e.g. deltaY = 100, integer, deltaX = 0) zooms
  const mouseWheel = classifyWheelGesture({
    deltaX: 0,
    deltaY: -100,
    deltaMode: 0,
    ctrlKey: false,
    metaKey: false,
  });
  assert.equal(mouseWheel.kind, 'zoom');

  // Two-finger trackpad scroll (non-zero deltaX, fractional deltaY, or small trackpad deltaY) pans
  const trackpadDiag = classifyWheelGesture({
    deltaX: 14,
    deltaY: -22,
    deltaMode: 0,
    ctrlKey: false,
    metaKey: false,
  });
  assert.deepEqual(trackpadDiag, { kind: 'pan', deltaX: 14, deltaY: -22 });

  const trackpadSmooth = classifyWheelGesture({
    deltaX: 0,
    deltaY: 16.5,
    deltaMode: 0,
    ctrlKey: false,
    metaKey: false,
  });
  assert.deepEqual(trackpadSmooth, { kind: 'pan', deltaX: 0, deltaY: 16.5 });
});

test('computeAnchoredZoom keeps the world coordinate beneath the cursor fixed', () => {
  const zoom0 = 1.25;
  const pan0 = { x: 40, y: -30 };
  const cursorRelCenter = { x: 180, y: -95 };
  const worldBefore = {
    x: (cursorRelCenter.x - pan0.x) / zoom0,
    y: (cursorRelCenter.y - pan0.y) / zoom0,
  };

  const next = computeAnchoredZoom(zoom0, pan0, cursorRelCenter, 1.35, 0.25, 4);
  const worldAfter = {
    x: (cursorRelCenter.x - next.panPx.x) / next.zoom,
    y: (cursorRelCenter.y - next.panPx.y) / next.zoom,
  };

  assert.ok(Math.abs(worldAfter.x - worldBefore.x) < 1e-9);
  assert.ok(Math.abs(worldAfter.y - worldBefore.y) < 1e-9);
});

test('matchKeybindAction recognizes V (select) and H (pan) aliases without breaking existing keys', () => {
  assert.equal(matchKeybindAction('v', DEFAULT_KEYBINDS), 'select');
  assert.equal(matchKeybindAction('h', DEFAULT_KEYBINDS), 'pan');
  assert.equal(matchKeybindAction('a', DEFAULT_KEYBINDS), 'select');
  assert.equal(matchKeybindAction('s', DEFAULT_KEYBINDS), 'pan');
  assert.equal(matchKeybindAction('w', DEFAULT_KEYBINDS), 'wall');
  assert.equal(matchKeybindAction('m', DEFAULT_KEYBINDS), 'measure_distance');
});
