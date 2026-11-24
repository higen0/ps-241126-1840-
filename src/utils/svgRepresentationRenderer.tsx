import React from 'react';
import type {
  FurnitureInstance,
  FurnitureRepresentation,
  ProjectedViewSvg,
  ProjectionViewId,
  SvgVectorElement,
} from '../types/plan';

export interface RenderSvgElementsOptions {
  baseStrokeMm: number;
  selected?: boolean;
  selectedStrokeColor?: string;
  useMaterialFill?: boolean;
  darkMode?: boolean;
  blackAndWhite?: boolean;
  ghostMode?: boolean;
  /** Multiplier applied cleanly to element fills (e.g., translucent upper canopies) */
  fillOpacityScale?: number;
  /** Overall opacity applied to rendered elements (e.g., overhead dashed objects) */
  elementOpacity?: number;
  /** Optional SVG stroke-dasharray for overhead/hidden-edge drafting conventions */
  strokeDasharray?: string;
  /** Optional stroke override when not selected (e.g., progressive depth gray on covered layers) */
  overrideStrokeColor?: string;
  /** Optional scaleX/scaleY if live object dimensions changed relative to baseWidthMm/baseHeightMm */
  scaleX?: number;
  scaleY?: number;
}

export function hasCustomView(rep: FurnitureRepresentation | undefined, view: ProjectionViewId): boolean {
  return Boolean(rep?.customViews && Array.isArray(rep.customViews[view]));
}

export function hasAnyCustomViews(rep: FurnitureRepresentation | undefined): boolean {
  if (!rep?.customViews) return false;
  return (['top', 'front', 'rear', 'left', 'right'] as ProjectionViewId[]).some(
    (v) => Array.isArray(rep.customViews?.[v])
  );
}

export function getEffectiveViewElements(
  rep: FurnitureRepresentation | undefined,
  view: ProjectionViewId
): {
  elements: SvgVectorElement[] | null;
  fillElements: SvgVectorElement[] | null;
  autoView: ProjectedViewSvg | undefined;
  isCustom: boolean;
} {
  if (!rep) {
    return { elements: null, fillElements: null, autoView: undefined, isCustom: false };
  }
  const defaultView = rep.defaultViews?.[view];
  const autoView = rep.autoViews?.[view];
  const activeMeta = rep.mode === 'default' ? (defaultView ?? autoView) : autoView;
  const customEls = rep.customViews?.[view];
  if (Array.isArray(customEls)) {
    return {
      elements: customEls,
      fillElements: null,
      autoView: activeMeta,
      isCustom: true,
    };
  }
  if (rep.mode === 'default') {
    if (defaultView && Array.isArray(defaultView.elements) && defaultView.elements.length > 0) {
      return {
        elements: defaultView.elements,
        fillElements: defaultView.fillElements ?? null,
        autoView: defaultView,
        isCustom: false,
      };
    }
    return { elements: null, fillElements: null, autoView, isCustom: false };
  }
  if (autoView && Array.isArray(autoView.elements)) {
    return {
      elements: autoView.elements,
      fillElements: autoView.fillElements ?? null,
      autoView,
      isCustom: false,
    };
  }
  return { elements: null, fillElements: null, autoView, isCustom: false };
}

export function resolveBwArchitecturalStroke(
  rawStroke: string,
  strokeWidthMm: number,
  elementId: string
): string {
  if (elementId.startsWith('sil_') || elementId.startsWith('def_sil_')) {
    return '#0F172A';
  }
  const normalized = rawStroke.trim().toUpperCase();
  if (
    normalized === '#0F172A' ||
    normalized === '#1E293B' ||
    normalized === '#334155' ||
    normalized === '#475569' ||
    normalized === '#64748B'
  ) {
    return normalized;
  }
  return strokeWidthMm >= 8 ? '#0F172A' : '#475569';
}

export function renderSingleSvgVectorElement(
  el: SvgVectorElement,
  opts: {
    baseStrokeMm: number;
    minStrokeMm?: number;
    selected?: boolean;
    selectedStrokeColor?: string;
    overrideFill?: string;
    overrideStroke?: string;
    forceOutlineOnStrokeless?: boolean;
    ghostMode?: boolean;
    fillOpacityScale?: number;
    elementOpacity?: number;
    strokeDasharray?: string;
  }
): React.ReactNode {
  if (!el.visible) return null;

  const promotedStrokeless = Boolean(opts.forceOutlineOnStrokeless && el.stroke === 'none');
  const strokeFactor = el.strokeWidthMm > 0 ? el.strokeWidthMm / 12 : promotedStrokeless ? 0.75 : 0;
  const minSw = opts.minStrokeMm ?? 2;
  const sw =
    (el.stroke === 'none' && !promotedStrokeless) || strokeFactor === 0
      ? 0
      : Math.max(minSw, opts.baseStrokeMm * strokeFactor);
  const stroke =
    el.stroke === 'none' && !promotedStrokeless
      ? 'none'
      : opts.ghostMode
        ? '#94A3B8'
        : opts.selected
          ? opts.selectedStrokeColor ?? '#2563EB'
          : opts.overrideStroke ?? (promotedStrokeless ? '#0F172A' : el.stroke);
  const fillScale = opts.fillOpacityScale ?? 1;
  const itemOpacity = opts.ghostMode ? 0.35 : (opts.elementOpacity ?? 1);
  const dash = opts.strokeDasharray;

  const key = el.id;

  switch (el.kind) {
    case 'path': {
      const fill = opts.ghostMode
        ? 'none'
        : opts.overrideFill !== undefined
          ? opts.overrideFill
          : el.fill;
      const fillOpacity =
        opts.ghostMode || fill === 'none' ? 0 : el.fillOpacity * fillScale;
      return (
        <path
          key={key}
          d={el.d}
          fill={fill}
          fillOpacity={fillOpacity}
          fillRule={el.fillRule ?? 'evenodd'}
          stroke={stroke}
          strokeWidth={sw}
          strokeDasharray={dash}
          strokeLinejoin="round"
          strokeLinecap="round"
          opacity={itemOpacity}
        />
      );
    }
    case 'line':
      return (
        <line
          key={key}
          x1={el.x1}
          y1={el.y1}
          x2={el.x2}
          y2={el.y2}
          stroke={stroke}
          strokeWidth={sw}
          strokeDasharray={dash}
          strokeLinecap="round"
          opacity={itemOpacity}
        />
      );
    case 'rect': {
      const cx = el.x + el.width / 2;
      const cy = el.y + el.height / 2;
      const rot = el.rotationDeg ? `rotate(${el.rotationDeg}, ${cx}, ${cy})` : undefined;
      const fill = opts.ghostMode ? 'none' : opts.overrideFill !== undefined ? opts.overrideFill : el.fill;
      return (
        <rect
          key={key}
          x={el.x}
          y={el.y}
          width={Math.max(1, el.width)}
          height={Math.max(1, el.height)}
          rx={el.rx ?? 0}
          transform={rot}
          fill={fill}
          fillOpacity={opts.ghostMode || fill === 'none' ? 0 : el.fillOpacity * fillScale}
          stroke={stroke}
          strokeWidth={sw}
          strokeDasharray={dash}
          strokeLinejoin="round"
          opacity={itemOpacity}
        />
      );
    }
    case 'ellipse': {
      const rot = el.rotationDeg ? `rotate(${el.rotationDeg}, ${el.cx}, ${el.cy})` : undefined;
      const fill = opts.ghostMode ? 'none' : opts.overrideFill !== undefined ? opts.overrideFill : el.fill;
      return (
        <ellipse
          key={key}
          cx={el.cx}
          cy={el.cy}
          rx={Math.max(1, el.rx)}
          ry={Math.max(1, el.ry)}
          transform={rot}
          fill={fill}
          fillOpacity={opts.ghostMode || fill === 'none' ? 0 : el.fillOpacity * fillScale}
          stroke={stroke}
          strokeWidth={sw}
          strokeDasharray={dash}
          opacity={itemOpacity}
        />
      );
    }
    case 'polyline': {
      const pts = el.points.map((p) => `${p.x},${p.y}`).join(' ');
      if (el.closed) {
        const fill = opts.ghostMode ? 'none' : opts.overrideFill !== undefined ? opts.overrideFill : el.fill;
        return (
          <polygon
            key={key}
            points={pts}
            fill={fill}
            fillOpacity={opts.ghostMode || fill === 'none' ? 0 : el.fillOpacity * fillScale}
            stroke={stroke}
            strokeWidth={sw}
            strokeDasharray={dash}
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={itemOpacity}
          />
        );
      }
      return (
        <polyline
          key={key}
          points={pts}
          fill="none"
          stroke={stroke}
          strokeWidth={sw}
          strokeDasharray={dash}
          strokeLinejoin="round"
          strokeLinecap="round"
          opacity={itemOpacity}
        />
      );
    }
  }
}

export function renderFurnitureRepresentationView(
  furnOrRep: Pick<FurnitureInstance, 'representation'> | FurnitureRepresentation | undefined,
  view: ProjectionViewId,
  opts: Partial<RenderSvgElementsOptions> = {}
): React.ReactNode | null {
  const rep =
    furnOrRep && 'representation' in furnOrRep
      ? furnOrRep.representation
      : (furnOrRep as FurnitureRepresentation | undefined);
  const resolved = getEffectiveViewElements(rep, view);
  if (!resolved.elements || resolved.elements.length === 0) return null;

  const baseStrokeMm = opts.baseStrokeMm ?? 10;
  const isBw = Boolean(opts.blackAndWhite);
  const useMatFill = Boolean(
    opts.useMaterialFill && !isBw && !resolved.isCustom && resolved.fillElements?.length
  );
  const sx = opts.scaleX ?? 1;
  const sy = opts.scaleY ?? 1;
  const needsScale = Math.abs(sx - 1) > 0.005 || Math.abs(sy - 1) > 0.005;

  const content = (
    <>
      {useMatFill &&
        resolved.fillElements!.map((fe) =>
          renderSingleSvgVectorElement(fe, {
            baseStrokeMm,
            selected: false,
            ghostMode: opts.ghostMode,
            fillOpacityScale: opts.fillOpacityScale,
            elementOpacity: opts.elementOpacity,
          })
        )}
      {resolved.elements.map((el) => {
        // When rendering material fills underneath auto silhouette, make silhouette fill transparent so color fills show through
        const isSilhouetteWithFill = useMatFill && el.id === `sil_${view}`;
        const elHasVisibleFill =
          'fill' in el && el.fill !== 'none' && el.fill !== 'transparent' && el.fillOpacity > 0;
        const bwFillOverride = isBw ? 'none' : undefined;
        const bwStrokeOverride =
          opts.overrideStrokeColor ??
          (isBw
            ? el.stroke === 'none'
              ? '#0F172A'
              : resolveBwArchitecturalStroke(el.stroke, el.strokeWidthMm, el.id)
            : undefined);
        return renderSingleSvgVectorElement(el, {
          baseStrokeMm,
          minStrokeMm: isBw ? Math.max(2.2, baseStrokeMm * 0.52) : undefined,
          selected: opts.selected,
          selectedStrokeColor: opts.selectedStrokeColor,
          overrideFill: isSilhouetteWithFill ? 'none' : bwFillOverride,
          overrideStroke: bwStrokeOverride,
          forceOutlineOnStrokeless: isBw && el.stroke === 'none' && elHasVisibleFill,
          ghostMode: opts.ghostMode,
          fillOpacityScale: opts.fillOpacityScale,
          elementOpacity: opts.elementOpacity,
          strokeDasharray: opts.strokeDasharray,
        });
      })}
    </>
  );

  if (needsScale) {
    return <g transform={`scale(${sx}, ${sy})`}>{content}</g>;
  }
  return <>{content}</>;
}
