import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BUILTIN_CATALOG } from '../data/catalog';
import type {
  CatalogTemplate,
  FurnitureInstance,
  Level,
  Point2D,
  ProjectedViewSvg,
  Wall,
} from '../types/plan';
import {
  getFurniturePlacement,
  isPointInFurniture2D,
  projectFurnitureForWallCutThrough,
  solveSolidFurnitureMove,
} from './geometry';
import {
  buildProceduralFurnitureGroup,
  type Furniture3DBuildContext,
} from './furniture3d';
import {
  computeSvgFitScale,
  extractSvgElementLocalPoints,
  generateDefaultTopViewFromParts,
  generateWallCutThroughElevationElements,
} from './svgImport';
import { evaluateFurniturePlanParity } from './parityOverlay';
import { resolveFurnitureMountingType } from './mounting';
import { buildWalkColliders } from './walkPhysics';

function makeBuildContext(effectiveCeilingMm = 2800): Furniture3DBuildContext {
  return {
    matOpts: {
      materialQuality: 'standard',
      reflectionQuality: 'off',
      transparentQuality: 'standard',
      textureFiltering: 'bilinear',
      isSoftwareGl: true,
    },
    castShadows: false,
    clippingPlanes: [],
    nightMix: 0,
    partEdgeMat: new THREE.LineBasicMaterial({ color: 0x1e293b }),
    kelvinToColor: () => new THREE.Color('#FFE4C4'),
    effectiveCeilingMm,
    isSoftwareGl: true,
  };
}

function makeInstanceFromTemplate(
  tpl: CatalogTemplate,
  overrides: Partial<FurnitureInstance> = {}
): FurnitureInstance {
  return {
    id: `test_${tpl.id}`,
    templateId: tpl.id,
    name: tpl.name,
    category: tpl.category,
    xMm: 1400,
    yMm: 1100,
    elevationMm: tpl.defaultElevationMm ?? 0,
    rotationDeg: 0,
    rotationXDeg: 0,
    rotationYDeg: 0,
    mirroredX: false,
    mirroredY: false,
    visible: true,
    locked: false,
    mountingType: tpl.defaultMountingType,
    mountingFace: tpl.defaultMountingFace,
    lockProportions: false,
    parts: tpl.parts.map((p) => ({ ...p })),
    ...overrides,
  };
}

interface Bounds3DMm {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

function measureThreeGroupWorldBoundsMm(group: THREE.Object3D): Bounds3DMm {
  group.updateMatrixWorld(true);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const v = new THREE.Vector3();

  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const pos = mesh.geometry.getAttribute('position');
    if (!pos) return;
    const matWorld = mesh.matrixWorld;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(matWorld);
      const xMm = v.x * 1000;
      const yMm = v.z * 1000;
      const zMm = v.y * 1000;
      if (xMm < minX) minX = xMm;
      if (xMm > maxX) maxX = xMm;
      if (yMm < minY) minY = yMm;
      if (yMm > maxY) maxY = yMm;
      if (zMm < minZ) minZ = zMm;
      if (zMm > maxZ) maxZ = zMm;
    }
  });

  return { minX, maxX, minY, maxY, minZ, maxZ };
}

function rotatePoint2D(pt: Point2D, rad: number): Point2D {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return {
    x: pt.x * c - pt.y * s,
    y: pt.x * s + pt.y * c,
  };
}

// Local point extraction uses extractSvgElementLocalPoints imported from ./svgImport

function measureTopSvgWorldBoundsMm(
  furn: FurnitureInstance,
  view: ProjectedViewSvg
): { minX: number; maxX: number; minY: number; maxY: number } {
  const placement = getFurniturePlacement(furn);
  const tb = placement.tiltedLocalBounds;
  const repShiftX = (tb.minX + tb.maxX) / 2;
  const repShiftY = (tb.minY + tb.maxY) / 2;
  const applyMirrorX = placement.hasTilt ? 1 : placement.mirrorSignX;
  const applyMirrorY = placement.hasTilt ? 1 : placement.mirrorSignY;
  const sx = view.baseWidthMm > 0 ? tb.widthMm / view.baseWidthMm : 1;
  const sy = view.baseHeightMm > 0 ? tb.depthMm / view.baseHeightMm : 1;
  const radF = (furn.rotationDeg * Math.PI) / 180;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const el of view.elements) {
    for (const p of extractSvgElementLocalPoints(el)) {
      const lx = repShiftX + p.x * sx * applyMirrorX;
      const ly = repShiftY + p.y * sy * applyMirrorY;
      const rw = rotatePoint2D({ x: lx, y: ly }, radF);
      const wx = furn.xMm + rw.x;
      const wy = furn.yMm + rw.y;
      if (wx < minX) minX = wx;
      if (wx > maxX) maxX = wx;
      if (wy < minY) minY = wy;
      if (wy > maxY) maxY = wy;
    }
  }
  return { minX, maxX, minY, maxY };
}

function assertBoundsClose(
  label: string,
  actual: { minX: number; maxX: number; minY: number; maxY: number },
  expected: { minX: number; maxX: number; minY: number; maxY: number },
  tolMm = 1.0
) {
  assert.ok(
    Math.abs(actual.minX - expected.minX) <= tolMm,
    `${label} minX mismatch: actual=${actual.minX.toFixed(3)} expected=${expected.minX.toFixed(3)} (diff=${Math.abs(actual.minX - expected.minX).toFixed(3)}mm)`
  );
  assert.ok(
    Math.abs(actual.maxX - expected.maxX) <= tolMm,
    `${label} maxX mismatch: actual=${actual.maxX.toFixed(3)} expected=${expected.maxX.toFixed(3)} (diff=${Math.abs(actual.maxX - expected.maxX).toFixed(3)}mm)`
  );
  assert.ok(
    Math.abs(actual.minY - expected.minY) <= tolMm,
    `${label} minY mismatch: actual=${actual.minY.toFixed(3)} expected=${expected.minY.toFixed(3)} (diff=${Math.abs(actual.minY - expected.minY).toFixed(3)}mm)`
  );
  assert.ok(
    Math.abs(actual.maxY - expected.maxY) <= tolMm,
    `${label} maxY mismatch: actual=${actual.maxY.toFixed(3)} expected=${expected.maxY.toFixed(3)} (diff=${Math.abs(actual.maxY - expected.maxY).toFixed(3)}mm)`
  );
}

test('Milestone 4 — Exhaustive 2D/Wall/3D parity within 1 mm across all catalog items and transform variants', () => {
  const ctx = makeBuildContext(2800);
  const referenceWall: Wall = {
    id: 'parity_wall',
    start: { x: 0, y: 0 },
    end: { x: 6000, y: 0 },
    thicknessMm: 150,
    heightMm: 2800,
    alignment: 'center',
    isCurved: false,
    curveBulgeMm: 0,
    innerColor: '#F8FAFC',
    outerColor: '#E2E8F0',
    innerMaterial: 'plaster',
    outerMaterial: 'plaster',
    innerTextureScale: 1,
    outerTextureScale: 1,
    innerTextureRotDeg: 0,
    outerTextureRotDeg: 0,
    hasBaseboard: false,
    baseboardHeightMm: 100,
    baseboardColor: '#FFFFFF',
    hasCrownMolding: false,
    crownHeightMm: 80,
    crownColor: '#FFFFFF',
    visible: true,
    locked: false,
  };

  const variants: Array<{
    tag: string;
    patch: Partial<FurnitureInstance>;
  }> = [
    { tag: 'default', patch: { xMm: 2200, yMm: 1800, rotationDeg: 0 } },
    { tag: 'rotated_37', patch: { xMm: 2200, yMm: 1800, rotationDeg: 37 } },
    { tag: 'mirrored_x', patch: { xMm: 2200, yMm: 1800, rotationDeg: 25, mirroredX: true } },
    { tag: 'mirrored_y', patch: { xMm: 2200, yMm: 1800, rotationDeg: -42, mirroredY: true } },
    {
      tag: 'mirrored_xy',
      patch: { xMm: 2200, yMm: 1800, rotationDeg: 15, mirroredX: true, mirroredY: true },
    },
    {
      tag: 'tilted_yxz',
      patch: {
        xMm: 2200,
        yMm: 1800,
        rotationDeg: 33,
        rotationXDeg: 18,
        rotationYDeg: -12,
      },
    },
    {
      tag: 'tilted_mirrored',
      patch: {
        xMm: 2200,
        yMm: 1800,
        rotationDeg: 62,
        rotationXDeg: 14,
        rotationYDeg: 19,
        mirroredX: true,
        mirroredY: false,
      },
    },
  ];

  for (const tpl of BUILTIN_CATALOG) {
    for (const v of variants) {
      const furn = makeInstanceFromTemplate(tpl, v.patch);
      const label = `[${tpl.id} / ${v.tag}]`;

      // 1. Real Three.js 3D mesh bounds
      const built3d = buildProceduralFurnitureGroup(furn, ctx);
      const b3d = measureThreeGroupWorldBoundsMm(built3d.group);

      // 2. Canonical placement solver bounds
      const placement = getFurniturePlacement(furn, { effectiveCeilingMm: 2800 });
      assertBoundsClose(`${label} placement.worldBounds2D vs 3D`, placement.worldBounds2D, b3d, 1.0);
      assert.ok(
        Math.abs(placement.elevationSpanMm.minZ - b3d.minZ) <= 1.0,
        `${label} minZ mismatch: placement=${placement.elevationSpanMm.minZ.toFixed(3)} 3D=${b3d.minZ.toFixed(3)}`
      );
      assert.ok(
        Math.abs(placement.elevationSpanMm.maxZ - b3d.maxZ) <= 1.0,
        `${label} maxZ mismatch: placement=${placement.elevationSpanMm.maxZ.toFixed(3)} 3D=${b3d.maxZ.toFixed(3)}`
      );

      // 3. Derived 2D Plan SVG bounds
      const topView = generateDefaultTopViewFromParts(furn.parts, {
        rotationXDeg: furn.rotationXDeg,
        rotationYDeg: furn.rotationYDeg,
        mirroredX: furn.mirroredX,
        mirroredY: furn.mirroredY,
        templateId: furn.templateId,
      });
      assert.ok(topView, `${label} generateDefaultTopViewFromParts returned null`);
      const topWorld = measureTopSvgWorldBoundsMm(furn, topView);
      assertBoundsClose(`${label} topSvg vs 3D`, topWorld, b3d, 1.0);

      // 4. Wall View Cut-Through projection bounds along +X reference wall (inner face -> left normal +Y, viewX = world X)
      const cut = projectFurnitureForWallCutThrough(referenceWall, 'inner', furn, 2800, 3000);
      assert.equal(cut.status, 'visible', `${label} expected visible in Wall View`);
      assert.ok(cut.projection, `${label} missing Wall View projection summary`);
      const projMinX = cut.projection.viewXCenter - cut.projection.elevW / 2;
      const projMaxX = cut.projection.viewXCenter + cut.projection.elevW / 2;
      const projMinZ = cut.projection.zBottom;
      const projMaxZ = cut.projection.zBottom + cut.projection.elevH;
      assert.ok(
        Math.abs(projMinX - b3d.minX) <= 1.0 && Math.abs(projMaxX - b3d.maxX) <= 1.0,
        `${label} Wall View X [${projMinX.toFixed(2)}..${projMaxX.toFixed(2)}] vs 3D [${b3d.minX.toFixed(2)}..${b3d.maxX.toFixed(2)}]`
      );
      assert.ok(
        Math.abs(projMinZ - b3d.minZ) <= 1.0 && Math.abs(projMaxZ - b3d.maxZ) <= 1.0,
        `${label} Wall View Z [${projMinZ.toFixed(2)}..${projMaxZ.toFixed(2)}] vs 3D [${b3d.minZ.toFixed(2)}..${b3d.maxZ.toFixed(2)}]`
      );

      const wallElements = generateWallCutThroughElevationElements(cut.visibleParts, furn, false);
      assert.ok(wallElements.length > 0, `${label} wallElements should be non-empty`);
    }
  }
});

test('Milestone 4 — Wall-mounted, ceiling-mounted, and 3-layer stacked furniture preserve <= 1 mm parity on transform, size, mirror & tilt edits', () => {
  const ceilingMm = 2950;
  const ctx = makeBuildContext(ceilingMm);

  const wallMountedTpls = BUILTIN_CATALOG.filter(
    (tpl) =>
      resolveFurnitureMountingType({
        templateId: tpl.id,
        category: tpl.category,
        parts: tpl.parts,
        mountingType: tpl.defaultMountingType,
      }) === 'wall'
  );
  const ceilingMountedTpls = BUILTIN_CATALOG.filter(
    (tpl) =>
      resolveFurnitureMountingType({
        templateId: tpl.id,
        category: tpl.category,
        parts: tpl.parts,
        mountingType: tpl.defaultMountingType,
      }) === 'ceiling'
  );
  assert.ok(wallMountedTpls.length > 0, 'Expected wall-mounted catalog items');
  assert.ok(ceilingMountedTpls.length > 0, 'Expected ceiling-mounted catalog items');

  // Verify wall-mounted & ceiling-mounted items with rotation + tilt + mirror
  for (const tpl of [...wallMountedTpls, ...ceilingMountedTpls]) {
    const furn = makeInstanceFromTemplate(tpl, {
      xMm: 1850,
      yMm: 950,
      rotationDeg: 28,
      mirroredX: true,
      rotationXDeg: 10,
      rotationYDeg: -8,
      attachedWallId: tpl.defaultMountingType === 'wall' ? 'w1' : undefined,
    });
    const b3d = measureThreeGroupWorldBoundsMm(buildProceduralFurnitureGroup(furn, ctx).group);
    const placement = getFurniturePlacement(furn, { effectiveCeilingMm: ceilingMm });
    const topView = generateDefaultTopViewFromParts(furn.parts, {
      rotationXDeg: furn.rotationXDeg,
      rotationYDeg: furn.rotationYDeg,
      mirroredX: furn.mirroredX,
      mirroredY: furn.mirroredY,
      templateId: furn.templateId,
    });
    assert.ok(topView);
    const topWorld = measureTopSvgWorldBoundsMm(furn, topView);
    assertBoundsClose(`[mounted:${tpl.id}] placement vs 3D`, placement.worldBounds2D, b3d, 1.0);
    assertBoundsClose(`[mounted:${tpl.id}] topSvg vs 3D`, topWorld, b3d, 1.0);
    assert.ok(
      Math.abs(placement.elevationSpanMm.minZ - b3d.minZ) <= 1.0 &&
        Math.abs(placement.elevationSpanMm.maxZ - b3d.maxZ) <= 1.0,
      `[mounted:${tpl.id}] Z mismatch: placement=[${placement.elevationSpanMm.minZ.toFixed(2)}..${placement.elevationSpanMm.maxZ.toFixed(2)}] 3D=[${b3d.minZ.toFixed(2)}..${b3d.maxZ.toFixed(2)}]`
    );
  }

  // Stacked 3-layer scenario: rug + dining table + vase
  const rugTpl = BUILTIN_CATALOG.find((c) => c.id === 'rug_rect_large') ?? BUILTIN_CATALOG[0];
  const tableTpl = BUILTIN_CATALOG.find((c) => c.id === 'dining_table_rect') ?? BUILTIN_CATALOG[1];
  const vaseTpl = BUILTIN_CATALOG.find((c) => c.id === 'vase_ceramic') ?? BUILTIN_CATALOG[2];

  const rug = makeInstanceFromTemplate(rugTpl, { id: 'rug1', xMm: 2000, yMm: 1600, rotationDeg: 15 });
  const table = makeInstanceFromTemplate(tableTpl, {
    id: 'table1',
    xMm: 2050,
    yMm: 1620,
    rotationDeg: 15,
    mirroredX: true,
    surfaceHostId: 'rug1',
    elevationMm: getFurniturePlacement(rug).elevationSpanMm.maxZ,
  });
  const vaseBase = makeInstanceFromTemplate(vaseTpl, {
    id: 'vase1',
    xMm: 2100,
    yMm: 1640,
    rotationDeg: 40,
    rotationXDeg: 12,
  });
  const baseLevel: Level = {
    id: 'lvl1',
    name: 'Ground',
    elevationMm: 0,
    ceilingHeightMm: ceilingMm,
    walls: [],
    openings: [],
    rooms: [],
    furniture: [rug, table, vaseBase],
    archElements: [],
    curtains: [],
    people: [],
    measurements: [],
    annotations: [],
    sectionLine: null,
    backgroundTrace: null,
    layers: {
      walls: true,
      openings: true,
      rooms: true,
      furniture: true,
      curtains: true,
      people: true,
      archElements: true,
      measurements: true,
      annotations: true,
      autoDimensions: true,
      grid: true,
    },
  };
  const solvedVase = solveSolidFurnitureMove(
    { x: vaseBase.xMm, y: vaseBase.yMm },
    { x: vaseBase.xMm, y: vaseBase.yMm },
    vaseBase,
    baseLevel,
    { snapEnabled: false, gridSizeMm: 50 }
  );
  const vase: FurnitureInstance = {
    ...vaseBase,
    elevationMm: solvedVase.elevationMm,
    surfaceHostId: solvedVase.surfaceHostId,
  };
  assert.equal(vase.surfaceHostId, 'table1', 'Vase must stack onto dining table');

  // Inspector resize + mirror + tilt mutation on table & vase
  const resizedTable: FurnitureInstance = {
    ...table,
    mirroredY: true,
    rotationYDeg: 9,
    parts: table.parts.map((p) => ({
      ...p,
      widthMm: Math.round(p.widthMm * 1.15),
      depthMm: Math.round(p.depthMm * 0.9),
      xMm: Math.round(p.xMm * 1.15),
      yMm: Math.round(p.yMm * 0.9),
    })),
  };

  for (const item of [rug, resizedTable, vase]) {
    const b3d = measureThreeGroupWorldBoundsMm(buildProceduralFurnitureGroup(item, ctx).group);
    const placement = getFurniturePlacement(item, { effectiveCeilingMm: ceilingMm });
    const topView = generateDefaultTopViewFromParts(item.parts, {
      rotationXDeg: item.rotationXDeg,
      rotationYDeg: item.rotationYDeg,
      mirroredX: item.mirroredX,
      mirroredY: item.mirroredY,
      templateId: item.templateId,
    });
    assert.ok(topView);
    const topWorld = measureTopSvgWorldBoundsMm(item, topView);
    assertBoundsClose(`[stack:${item.id}] placement vs 3D`, placement.worldBounds2D, b3d, 1.0);
    assertBoundsClose(`[stack:${item.id}] topSvg vs 3D`, topWorld, b3d, 1.0);
    assert.ok(
      Math.abs(placement.elevationSpanMm.minZ - b3d.minZ) <= 1.0 &&
        Math.abs(placement.elevationSpanMm.maxZ - b3d.maxZ) <= 1.0,
      `[stack:${item.id}] Z mismatch`
    );
  }
});

test('Milestone 5 — Custom SVG uniform aspect-fit, tilt fallback non-mutation, and dev parity overlay evaluation', () => {
  // 1. Uniform aspect-fit preserves aspect ratio inside non-uniformly resized bounds
  const fit = computeSvgFitScale(1000, 1000, 2000, 800, true);
  assert.equal(fit.scaleX, fit.scaleY, 'Custom SVG aspect-fit must use uniform scale');
  assert.ok(Math.abs(fit.scaleX - 0.8) < 1e-6, `Expected uniform scale 0.8, got ${fit.scaleX}`);

  const stretched = computeSvgFitScale(1000, 1000, 2000, 800, false);
  assert.equal(stretched.scaleX, 2);
  assert.equal(stretched.scaleY, 0.8);

  // 2. Parity overlay passes <= 1 mm across curved, L-shaped, U-shaped, wedge, caster & oval catalog shapes
  const shapeTemplates = [
    'sofa_curved_boucle',
    'chair_swivel_boucle',
    'wardrobe_corner_l',
    'sofa_u_sectional',
    'sofa_l_sectional',
    'chair_office_ergo',
    'bath_oval_tub',
  ];
  for (const tplId of shapeTemplates) {
    const tpl = BUILTIN_CATALOG.find((c) => c.id === tplId);
    assert.ok(tpl, `Missing template ${tplId}`);
    const furn = makeInstanceFromTemplate(tpl, {
      xMm: 1600,
      yMm: 1400,
      rotationDeg: 28,
      rotationXDeg: 14,
      rotationYDeg: -9,
      mirroredX: true,
    });
    const topView = generateDefaultTopViewFromParts(furn.parts, {
      rotationXDeg: furn.rotationXDeg,
      rotationYDeg: furn.rotationYDeg,
      mirroredX: furn.mirroredX,
      mirroredY: furn.mirroredY,
      templateId: furn.templateId,
    });
    assert.ok(topView);
    const pl = getFurniturePlacement(furn, { effectiveCeilingMm: 2800 });
    const report = evaluateFurniturePlanParity(
      furn,
      {
        elements: topView.elements,
        topScaleX: pl.tiltedLocalBounds.widthMm / topView.baseWidthMm,
        topScaleY: pl.tiltedLocalBounds.depthMm / topView.baseHeightMm,
        applyMirrorScale2D: false,
      },
      2800,
      1.0
    );
    assert.equal(
      report.hasMismatch,
      false,
      `${tplId} parity overlay expected <=1mm, got ${report.maxDiffMm.toFixed(3)}mm`
    );
  }

  // 3. Intentional >1 mm custom SVG discrepancy is flagged by dev parity overlay without mutating saved views
  const sofaTpl = BUILTIN_CATALOG.find((c) => c.id === 'sofa_straight_3')!;
  const savedCustomTop = [
    {
      id: 'custom_box',
      kind: 'rect' as const,
      name: 'Undersized Custom Icon',
      x: -400,
      y: -250,
      width: 800,
      height: 500,
      stroke: '#0F172A',
      strokeWidthMm: 8,
      fill: '#FFFFFF',
      fillOpacity: 1,
      visible: true,
    },
  ];
  const furnWithCustom = makeInstanceFromTemplate(sofaTpl, {
    xMm: 2000,
    yMm: 2000,
    svgSource: '<svg viewBox="0 0 800 500"><rect width="800" height="500"/></svg>',
    representation: {
      mode: 'default',
      customViews: { top: savedCustomTop },
    },
  });
  const mismatchReport = evaluateFurniturePlanParity(
    furnWithCustom,
    {
      elements: savedCustomTop,
      topScaleX: 1,
      topScaleY: 1,
      applyMirrorScale2D: true,
    },
    2800,
    1.0
  );
  assert.equal(mismatchReport.hasMismatch, true, 'Parity overlay must flag >1 mm discrepancy');
  assert.ok(mismatchReport.maxDiffMm > 100, `Expected >100mm diff, got ${mismatchReport.maxDiffMm}`);
  const firstCustom = furnWithCustom.representation?.customViews?.top?.[0];
  assert.ok(firstCustom && firstCustom.kind === 'rect');
  assert.equal(firstCustom.width, 800, 'Saved customViews must never be mutated');
  assert.ok(furnWithCustom.svgSource?.includes('800'), 'Saved svgSource must remain untouched');
});

test('Milestone 5 — Non-rectangular hit-testing and walkPhysics use transformed geometry bounds', () => {
  // L-shaped sectional has empty concave corner (+X/-X side of chaise leg): point in empty quadrant must NOT hit
  const lSofaTpl = BUILTIN_CATALOG.find((c) => c.id === 'sofa_l_sectional')!;
  const lSofa = makeInstanceFromTemplate(lSofaTpl, { xMm: 2000, yMm: 2000, rotationDeg: 0 });
  // Empty negative-X front corner of the L (-900, +650 relative to center -> 1100, 2650 world)
  assert.equal(
    isPointInFurniture2D({ x: 1100, y: 2650 }, lSofa),
    false,
    'Concave outside corner of L-shaped sofa must not register a hit'
  );
  // Inside main seat cushion (-450, -360 relative -> 1550, 1640 world) must hit
  assert.equal(
    isPointInFurniture2D({ x: 1550, y: 1640 }, lSofa),
    true,
    'Point inside L-shaped seat cushion must register a hit'
  );

  // Curved oval bathtub: extreme rectangular corner (+850, +390) lies outside oval contour
  const ovalTubTpl = BUILTIN_CATALOG.find((c) => c.id === 'bath_oval_tub')!;
  const ovalTub = makeInstanceFromTemplate(ovalTubTpl, { xMm: 3000, yMm: 3000, rotationDeg: 0 });
  assert.equal(
    isPointInFurniture2D({ x: 3850, y: 3390 }, ovalTub),
    false,
    'Rectangular bbox corner outside oval tub must not register a hit'
  );
  assert.equal(
    isPointInFurniture2D({ x: 3000, y: 3000 }, ovalTub),
    true,
    'Center of oval tub must register a hit'
  );

  // Walk physics uses transformed tilted/elevated placement & excludes high ceiling pendants above eye/head height
  const tableTpl = BUILTIN_CATALOG.find((c) => c.id === 'table_dining_square_4')!;
  const pendantTpl = BUILTIN_CATALOG.find((c) => c.id === 'light_pendant')!;
  const tiltedTable = makeInstanceFromTemplate(tableTpl, {
    id: 'walk_table',
    xMm: 2500,
    yMm: 2500,
    rotationXDeg: 25,
  });
  const highPendant = makeInstanceFromTemplate(pendantTpl, {
    id: 'walk_pendant',
    xMm: 5000,
    yMm: 2500,
  });
  const walkLevel: Level = {
    id: 'walk_lvl',
    name: 'Walk Level',
    elevationMm: 0,
    ceilingHeightMm: 2800,
    walls: [],
    openings: [],
    rooms: [],
    furniture: [tiltedTable, highPendant],
    curtains: [],
    people: [],
    archElements: [],
    measurements: [],
    annotations: [],
    sectionLine: null,
    backgroundTrace: null,
    layers: {
      walls: true,
      openings: true,
      rooms: true,
      furniture: true,
      curtains: true,
      people: true,
      archElements: true,
      measurements: true,
      annotations: true,
      autoDimensions: true,
      grid: true,
    },
  };
  const colliders = buildWalkColliders(walkLevel, {
    cutawayEnabled: false,
    cutawayHeightMm: 1500,
  });
  const tableColliders = colliders.filter((c) => c.id.startsWith('furn_walk_table'));
  assert.ok(tableColliders.length >= 1, 'Walk colliders must include tilted floor table');
  const tiltedPl = getFurniturePlacement(tiltedTable, { effectiveCeilingMm: 2800 });
  const maxPolyXMm = Math.max(...tableColliders.flatMap((c) => c.poly.map((p) => p.x * 1000)));
  const maxPolyZMm = Math.max(...tableColliders.flatMap((c) => c.poly.map((p) => p.z * 1000)));
  assert.ok(
    Math.abs(maxPolyXMm - tiltedPl.worldBounds2D.maxX) <= 1.0 &&
      Math.abs(maxPolyZMm - tiltedPl.worldBounds2D.maxY) <= 1.0,
    `Walk physics collider polygon must match canonical tilted placement bounds (poly=${maxPolyXMm},${maxPolyZMm} vs pl=${tiltedPl.worldBounds2D.maxX},${tiltedPl.worldBounds2D.maxY})`
  );
  const pendantColliders = colliders.filter((c) => c.id.startsWith('furn_walk_pendant'));
  assert.ok(
    pendantColliders.every((c) => c.minY > 1.75),
    'Ceiling pendant collider must stay above walking head height'
  );
});
