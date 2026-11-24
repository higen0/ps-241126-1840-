import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FurnitureInstance } from '../types/plan.ts';
import {
  computePlanFurnitureOverlapMetadata,
  polygonSignedArea2D,
  sortFurnitureByElevationForPlan,
} from './geometry.ts';
import {
  computeContactShadowOffsetPx,
  computePlanStackVisualData,
  outsetPolygon2D,
} from './stackVisualization.ts';

function makeFurn(
  id: string,
  name: string,
  opts: {
    templateId?: string;
    category?: FurnitureInstance['category'];
    xMm?: number;
    yMm?: number;
    elevationMm?: number;
    rotationDeg?: number;
    widthMm: number;
    depthMm: number;
    heightMm: number;
    mountingType?: FurnitureInstance['mountingType'];
    surfaceHostId?: string;
    detailStyle?: FurnitureInstance['parts'][number]['detailStyle'];
    parts?: FurnitureInstance['parts'];
  }
): FurnitureInstance {
  return {
    id,
    templateId: opts.templateId ?? `tpl_${id}`,
    name,
    category: opts.category ?? 'Tables & Desks',
    xMm: opts.xMm ?? 2000,
    yMm: opts.yMm ?? 2000,
    elevationMm: opts.elevationMm ?? 0,
    rotationDeg: opts.rotationDeg ?? 0,
    mirroredX: false,
    mirroredY: false,
    lockProportions: false,
    mountingType: opts.mountingType,
    surfaceHostId: opts.surfaceHostId,
    visible: true,
    locked: false,
    parts: opts.parts ?? [
      {
        id: `${id}_body`,
        name: 'Body',
        shape: 'box',
        detailStyle: opts.detailStyle,
        xMm: 0,
        yMm: 0,
        zMm: 0,
        widthMm: opts.widthMm,
        depthMm: opts.depthMm,
        heightMm: opts.heightMm,
        rotationDeg: 0,
        material: 'oak',
        color: '#CBD5E1',
      },
    ],
  };
}

describe('Milestone 3 — Stack Visualization', () => {
  it('links a 3-layer stack (rug, table, vase) with overlap clip polygons and vertically adjacent contact shadows', () => {
    const rug = makeFurn('rug', 'Living Rug', {
      templateId: 'rug_woven',
      category: 'Decor & Plants',
      widthMm: 2400,
      depthMm: 1600,
      heightMm: 12,
      detailStyle: 'rug',
    });

    // Canopy table: legs 0..710, tabletop 710..750
    const table = makeFurn('table', 'Dining Table', {
      templateId: 'dining_table',
      category: 'Tables & Desks',
      widthMm: 1400,
      depthMm: 800,
      heightMm: 750,
      parts: [
        {
          id: 'top',
          name: 'Top',
          shape: 'box',
          xMm: 0,
          yMm: 0,
          zMm: 710,
          widthMm: 1400,
          depthMm: 800,
          heightMm: 40,
          rotationDeg: 0,
          material: 'oak',
          color: '#D6B38C',
        },
        {
          id: 'leg1',
          name: 'Leg',
          shape: 'box',
          xMm: -620,
          yMm: -340,
          zMm: 0,
          widthMm: 60,
          depthMm: 60,
          heightMm: 710,
          rotationDeg: 0,
          material: 'oak',
          color: '#B8956E',
        },
        {
          id: 'leg2',
          name: 'Leg',
          shape: 'box',
          xMm: 620,
          yMm: 340,
          zMm: 0,
          widthMm: 60,
          depthMm: 60,
          heightMm: 710,
          rotationDeg: 0,
          material: 'oak',
          color: '#B8956E',
        },
      ],
    });

    const vase = makeFurn('vase', 'Ceramic Vase', {
      templateId: 'decor_vase',
      category: 'Decor & Plants',
      mountingType: 'surface',
      surfaceHostId: 'table',
      elevationMm: 750,
      widthMm: 220,
      depthMm: 220,
      heightMm: 300,
    });

    const items = [vase, rug, table];
    const infoMap = computePlanFurnitureOverlapMetadata(items, 2700);
    const ordered = sortFurnitureByElevationForPlan(items, infoMap, 2700);
    assert.deepEqual(
      ordered.map((i) => i.id),
      ['rug', 'table', 'vase']
    );

    // All 3 belong to the same stack cluster
    assert.equal(infoMap.get('rug')?.sameSpotOverlapIds.includes('table'), true);
    assert.equal(infoMap.get('table')?.coveredByUpperIds.includes('vase'), true);
    assert.equal(infoMap.get('rug')?.coveredByUpperIds.includes('table'), true);

    const visual = computePlanStackVisualData(ordered, infoMap, 0.1, 2700);

    // Overlap clip polygons exist for both covered layers (rug & table), strictly matching overlap areas
    const rugClip = visual.overlapClipPolygonsByLowerId.get('rug') ?? [];
    const tableClip = visual.overlapClipPolygonsByLowerId.get('table') ?? [];
    assert.ok(rugClip.length >= 1, 'rug should have overlap clip polygons under table');
    assert.ok(tableClip.length >= 1, 'table should have overlap clip polygons under vase');

    const tableClipArea = tableClip.reduce((s, p) => s + Math.abs(polygonSignedArea2D(p)), 0);
    assert.ok(Math.abs(tableClipArea - 220 * 220) < 500, `table clip should match vase area (~48400), got ${tableClipArea}`);

    // Vertically adjacent contact shadows: table->rug and vase->table (NOT vase->rug directly)
    const tableShadows = visual.shadowsBeforeUpperId.get('table') ?? [];
    const vaseShadows = visual.shadowsBeforeUpperId.get('vase') ?? [];
    assert.deepEqual(
      tableShadows.map((s) => s.lowerId),
      ['rug']
    );
    assert.deepEqual(
      vaseShadows.map((s) => s.lowerId),
      ['table']
    );

    // Table canopy hovering 710 - 12 = 698 mm above rug has larger capped pixel offset than vase resting flush (0 mm) on table
    assert.ok(tableShadows[0].offsetPx > vaseShadows[0].offsetPx);
    assert.equal(vaseShadows[0].offsetPx, 2.5);
    assert.ok(tableShadows[0].offsetPx <= 10);

    // Neither table nor vase fully covers the larger item underneath, so no full-cover hairlines
    assert.equal(visual.fullCoverHairlinesByUpperId.size, 0);
  });

  it('keeps contact shadow offset constant in screen pixels across zoom levels and caps at 10 px', () => {
    assert.equal(computeContactShadowOffsetPx(0), 2.5);
    assert.equal(computeContactShadowOffsetPx(5000), 10);

    const rug = makeFurn('rug', 'Rug', {
      templateId: 'rug_base',
      category: 'Decor & Plants',
      widthMm: 2200,
      depthMm: 1600,
      heightMm: 10,
      detailStyle: 'rug',
    });
    const shelf = makeFurn('shelf', 'Elevated Shelf', {
      elevationMm: 950,
      widthMm: 1000,
      depthMm: 500,
      heightMm: 40,
    });
    const infoMap = computePlanFurnitureOverlapMetadata([rug, shelf], 2700);
    const ordered = sortFurnitureByElevationForPlan([rug, shelf], infoMap, 2700);

    const lowZoom = computePlanStackVisualData(ordered, infoMap, 0.05, 2700);
    const highZoom = computePlanStackVisualData(ordered, infoMap, 0.25, 2700);

    const shLow = lowZoom.shadowsBeforeUpperId.get('shelf')?.[0]!;
    const shHigh = highZoom.shadowsBeforeUpperId.get('shelf')?.[0]!;
    assert.equal(shLow.offsetPx, shHigh.offsetPx);
    assert.equal(shLow.offsetPx, 10);
    // In world mm, offset scales inversely with pxPerMm to stay constant in screen pixels
    assert.ok(Math.abs(shLow.offsetMm - 200) < 1e-6);
    assert.ok(Math.abs(shHigh.offsetMm - 40) < 1e-6);
  });

  it('draws 1-3 hairline outward offset outlines when upper layers fully cover lower items', () => {
    const base = makeFurn('b1', 'Crate 1', { elevationMm: 0, widthMm: 800, depthMm: 800, heightMm: 300 });
    const mid = makeFurn('b2', 'Crate 2', { elevationMm: 300, widthMm: 800, depthMm: 800, heightMm: 300 });
    const mid2 = makeFurn('b3', 'Crate 3', { elevationMm: 600, widthMm: 800, depthMm: 800, heightMm: 300 });
    const mid3 = makeFurn('b4', 'Crate 4', { elevationMm: 900, widthMm: 800, depthMm: 800, heightMm: 300 });
    const top = makeFurn('b5', 'Crate 5', { elevationMm: 1200, widthMm: 800, depthMm: 800, heightMm: 300 });

    // 2 layers -> 1 hairline ring
    const info2 = computePlanFurnitureOverlapMetadata([base, mid], 2700);
    const vis2 = computePlanStackVisualData(
      sortFurnitureByElevationForPlan([base, mid], info2, 2700),
      info2,
      0.1,
      2700
    );
    assert.equal(vis2.fullCoverHairlinesByUpperId.get('b2')?.count, 1);

    // 5 identical layers -> capped at 3 hairline rings on topmost item only
    const all5 = [base, mid, mid2, mid3, top];
    const info5 = computePlanFurnitureOverlapMetadata(all5, 2700);
    const vis5 = computePlanStackVisualData(
      sortFurnitureByElevationForPlan(all5, info5, 2700),
      info5,
      0.1,
      2700
    );
    assert.equal(vis5.fullCoverHairlinesByUpperId.size, 1);
    assert.equal(vis5.fullCoverHairlinesByUpperId.get('b5')?.count, 3);

    // Verify outsetPolygon2D strictly expands rotated polygons
    const poly = [
      { x: 0, y: 0 },
      { x: 400, y: 0 },
      { x: 400, y: 300 },
      { x: 0, y: 300 },
    ];
    const expanded = outsetPolygon2D(poly, 30);
    assert.ok(Math.abs(polygonSignedArea2D(expanded)) > Math.abs(polygonSignedArea2D(poly)));
  });

  it('preserves ceiling fixture and wall-mounted domain exclusions', () => {
    const floorConsole = makeFurn('console', 'Console', {
      elevationMm: 0,
      widthMm: 1600,
      depthMm: 450,
      heightMm: 500,
    });
    const wallTv = makeFurn('tv', 'Wall TV', {
      mountingType: 'wall',
      elevationMm: 1100,
      widthMm: 1200,
      depthMm: 80,
      heightMm: 700,
    });
    const pendant = makeFurn('pendant', 'Ceiling Pendant', {
      templateId: 'light_pendant',
      category: 'Lighting',
      mountingType: 'ceiling',
      elevationMm: 2450,
      widthMm: 500,
      depthMm: 500,
      heightMm: 250,
    });

    const items = [floorConsole, wallTv, pendant];
    const infoMap = computePlanFurnitureOverlapMetadata(items, 2700);
    const ordered = sortFurnitureByElevationForPlan(items, infoMap, 2700);
    const visual = computePlanStackVisualData(ordered, infoMap, 0.1, 2700);

    // Neither wall TV nor ceiling pendant shadows or clips floor console
    assert.equal(infoMap.get('console')?.coveredByUpperIds.length, 0);
    assert.equal(visual.shadowsBeforeUpperId.has('tv'), false);
    assert.equal(visual.shadowsBeforeUpperId.has('pendant'), false);
    assert.equal(visual.overlapClipPolygonsByLowerId.has('console'), false);
  });
});
