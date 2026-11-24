import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Contrast,
  Eye,
  EyeOff,
  Layers,
  Link2,
  Map as MapIcon,
  Maximize2,
  MousePointerClick,
  Plus,
  Ruler,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  ArchElement,
  Curtain,
  FurnitureInstance,
  Level,
  Opening,
  PersonInstance,
  Point2D,
  ProjectSettings,
  SelectionTarget,
  Wall,
} from '../types/plan';
import {
  buildWallDimensionChain,
  computeAttachedChimneyTransform,
  computeChimneyFaceBounds,
  computeWallInnerBounds,
  computeWallPolygon,
  CutThroughProjectedPart,
  dist,
  doesChimneyOverlapWalls,
  getChimneyCornerPin,
  getEnclosingRoomCeilingMm,
  getNonCrossingClearances,
  getWallArcLength,
  getWallCenterlinePoint,
  getWallMountedComponents,
  projectFurnitureForWallCutThrough,
  resolveChimneyFaceColors,
  resolveWallFaces,
  solveChimneyResize,
  solveConnectedWallLengthChange,
  solveWallClearanceEdit,
  solveWallComponentDrag,
  solveWallComponentResize,
  wallOffsets,
  type WallViewFurnitureProjection,
} from '../utils/geometry';
import {
  getEffectiveViewElements,
  hasCustomView,
  renderFurnitureRepresentationView,
  renderSingleSvgVectorElement,
} from '../utils/svgRepresentationRenderer';
import {
  generateWallCutThroughElevationElements,
  resolveEffectiveRepresentationMode,
} from '../utils/svgImport';
import {
  computeCustomSvgWallViewTransform,
  computeWallCameraRelativeYawDeg,
  computeWallEndOcclusion,
  getCachedWallAngleProjection,
} from '../utils/wallViewProjection';
import { getGlbAssetSync } from '../utils/assetStore';
import {
  getGlbSceneFromCacheSync,
  loadGlbObjectCached,
} from '../utils/furnitureRepresentationSync';
import { formatSmartMetric, uid } from '../utils/units';
import { getEffectiveMaterialHex } from '../data/materials';
import { CanvasContextMenu, ContextMenuState } from './CanvasContextMenu';
import { classifyWheelGesture, computeAnchoredZoom } from '../utils/selectionNav';
import {
  computeWallViewFurnitureDimensions,
  computeWallViewRoomDimensions,
  extractWallViewSnapGeometry,
  layoutWallViewDimensions,
  snapWallViewMeasurementPoint,
  type ElevPoint,
  type WallViewSnapResult,
} from '../utils/wallViewMeasurements';
import {
  applyWallConsolidation,
  buildConsolidatedWallRun,
  buildRoomWallSelectorEntries,
  clearWallConsolidation,
  mapWallChimneysToRun,
  mapWallOpeningsToRun,
  resolveWallViewRoomId,
  validateWallConsolidationEligibility,
  type ConsolidatedWallRun,
  type RoomWallSelectorEntry,
} from '../utils/wallConsolidation';
import {
  computeZoomSnapTolerances,
  CursorHintPayload,
  pickWithSnapHysteresis,
  resolveSingleDragHint,
  sampleSnapVisualTween,
  SnapHysteresisState,
  SnapVisualTweenState,
  updateSnapVisualTweenOnSolverResult,
} from '../utils/dragErgonomics';
import { CursorHintChip } from './CursorHintChip';
import {
  applyWallViewFurnitureGroupDelta,
  computeWallViewFurnitureClearances,
  isFurnitureInteractiveInWallView,
  solveWallViewFurnitureDrag,
  type WallViewDragBounds,
  type WallViewElevRect,
  type WallViewGroupOrigItem,
  type WallViewOpeningObstacle,
} from '../utils/wallViewFurniture';

const UNASSIGNED_ROOM_GROUP_ID = '__unassigned__';

interface SelectorRoomGroup {
  id: string;
  name: string;
  areaSqM: number | null;
  polygon: Point2D[] | null;
  color: string;
  walls: Wall[];
  wallFaceMap: Map<string, 'inner' | 'outer'>;
  entryCount: number;
}

function getPolygonVisualCenter(pts: Point2D[]): Point2D {
  if (pts.length === 0) return { x: 0, y: 0 };
  let areaSum = 0;
  let cxSum = 0;
  let cySum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const cross = a.x * b.y - b.x * a.y;
    areaSum += cross;
    cxSum += (a.x + b.x) * cross;
    cySum += (a.y + b.y) * cross;
  }
  if (Math.abs(areaSum) > 1e-3) {
    return { x: cxSum / (3 * areaSum), y: cySum / (3 * areaSum) };
  }
  let sx = 0;
  let sy = 0;
  for (const p of pts) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / pts.length, y: sy / pts.length };
}

interface RoomMiniSelectorMapProps {
  walls: Wall[];
  rooms: SelectorRoomGroup[];
  onSelectRoom: (roomId: string) => void;
}

const RoomMiniSelectorMap: React.FC<RoomMiniSelectorMapProps> = ({
  walls,
  rooms,
  onSelectRoom,
}) => {
  const [hoverRoomId, setHoverRoomId] = useState<string | null>(null);

  let minX = -2000;
  let maxX = 2000;
  let minY = -2000;
  let maxY = 2000;
  const hasGeometry = walls.length > 0 || rooms.some((r) => r.polygon && r.polygon.length >= 3);
  if (hasGeometry) {
    minX = Infinity;
    maxX = -Infinity;
    minY = Infinity;
    maxY = -Infinity;
    for (const w of walls) {
      minX = Math.min(minX, w.start.x, w.end.x);
      maxX = Math.max(maxX, w.start.x, w.end.x);
      minY = Math.min(minY, w.start.y, w.end.y);
      maxY = Math.max(maxY, w.start.y, w.end.y);
    }
    for (const r of rooms) {
      if (!r.polygon) continue;
      for (const p of r.polygon) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
    }
  }
  const pad = 800;
  const vbX = minX - pad;
  const vbY = minY - pad;
  const vbW = Math.max(1500, maxX - minX + pad * 2);
  const vbH = Math.max(1500, maxY - minY + pad * 2);
  const labelSize = Math.max(115, Math.min(260, Math.max(vbW, vbH) * 0.022));
  const unassignedGroup = rooms.find((r) => r.id === UNASSIGNED_ROOM_GROUP_ID) ?? null;
  const unassignedWallIds = new Set(unassignedGroup?.walls.map((w) => w.id) ?? []);

  return (
    <svg
      className="w-full h-full block"
      viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
      preserveAspectRatio="xMidYMid meet"
    >
      {/* Room clickable polygons */}
      {rooms.map((room) => {
        if (!room.polygon || room.polygon.length < 3) return null;
        const ptsStr = room.polygon.map((p) => `${p.x},${p.y}`).join(' ');
        const center = getPolygonVisualCenter(room.polygon);
        const isHov = hoverRoomId === room.id;
        return (
          <g
            key={room.id}
            data-testid={`wallview-room-poly-${room.id}`}
            className="cursor-pointer"
            onPointerEnter={() => setHoverRoomId(room.id)}
            onPointerLeave={() => setHoverRoomId((cur) => (cur === room.id ? null : cur))}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onSelectRoom(room.id);
            }}
          >
            <title>
              {`${room.name} · ${room.entryCount} ${room.entryCount === 1 ? 'wall' : 'walls'}`}
            </title>
            <polygon
              points={ptsStr}
              fill={isHov ? 'rgba(37, 99, 235, 0.24)' : 'rgba(59, 130, 246, 0.10)'}
              stroke={isHov ? '#2563EB' : '#93C5FD'}
              strokeWidth={Math.max(22, labelSize * (isHov ? 0.18 : 0.11))}
              strokeLinejoin="round"
            />
            <text
              x={center.x}
              y={center.y - labelSize * 0.28}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={labelSize}
              fontWeight={600}
              fill={isHov ? '#1D4ED8' : '#1E293B'}
              className="pointer-events-none select-none dark:fill-slate-100"
            >
              {room.name}
            </text>
            <text
              x={center.x}
              y={center.y + labelSize * 0.92}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={labelSize * 0.72}
              fontWeight={500}
              fill={isHov ? '#2563EB' : '#64748B'}
              className="pointer-events-none select-none dark:fill-slate-400"
            >
              {`${room.entryCount} ${room.entryCount === 1 ? 'wall' : 'walls'}${
                room.areaSqM !== null ? ` · ${room.areaSqM.toFixed(1)} m²` : ''
              }`}
            </text>
          </g>
        );
      })}

      {/* Floor plan walls (unassigned walls also clickable if present) */}
      {walls.map((w) => {
        const poly = computeWallPolygon(w, walls);
        const ptsStr = poly.map((p) => `${p.x},${p.y}`).join(' ');
        const isUnassigned = unassignedWallIds.has(w.id);
        const isUnassignedHov = isUnassigned && hoverRoomId === UNASSIGNED_ROOM_GROUP_ID;
        return (
          <polygon
            key={w.id}
            points={ptsStr}
            className={isUnassigned ? 'cursor-pointer' : 'pointer-events-none'}
            fill={
              isUnassigned
                ? isUnassignedHov
                  ? 'rgba(217, 119, 6, 0.50)'
                  : 'rgba(245, 158, 11, 0.25)'
                : 'rgba(100, 116, 139, 0.22)'
            }
            stroke={
              isUnassigned
                ? isUnassignedHov
                  ? '#B45309'
                  : '#D97706'
                : '#64748B'
            }
            strokeWidth={Math.max(18, labelSize * 0.12)}
            strokeLinejoin="round"
            onPointerEnter={isUnassigned ? () => setHoverRoomId(UNASSIGNED_ROOM_GROUP_ID) : undefined}
            onPointerLeave={
              isUnassigned
                ? () => setHoverRoomId((cur) => (cur === UNASSIGNED_ROOM_GROUP_ID ? null : cur))
                : undefined
            }
            onPointerDown={isUnassigned ? (e) => e.stopPropagation() : undefined}
            onClick={
              isUnassigned
                ? (e) => {
                    e.stopPropagation();
                    onSelectRoom(UNASSIGNED_ROOM_GROUP_ID);
                  }
                : undefined
            }
          >
            {isUnassigned && (
              <title>Unassigned / Exterior</title>
            )}
          </polygon>
        );
      })}
    </svg>
  );
};

interface WallMiniSelectorMapProps {
  entries: RoomWallSelectorEntry[];
  polygonContextWalls: Wall[];
  activeWallId: string | null;
  onSelectWall: (wallId: string) => void;
  compact?: boolean;
}

function getWallSelectorEntryMidpoint(entry: RoomWallSelectorEntry): Point2D {
  if (entry.walls.length <= 1) {
    const w = entry.walls[0];
    return w ? getWallCenterlinePoint(w, 0.5).point : { x: 0, y: 0 };
  }
  const first = entry.walls[0];
  const dx = first.end.x - first.start.x;
  const dy = first.end.y - first.start.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  let minProj = Infinity;
  let maxProj = -Infinity;
  let minPt = first.start;
  let maxPt = first.end;
  for (const w of entry.walls) {
    for (const pt of [w.start, w.end]) {
      const p = (pt.x - first.start.x) * ux + (pt.y - first.start.y) * uy;
      if (p < minProj) {
        minProj = p;
        minPt = pt;
      }
      if (p > maxProj) {
        maxProj = p;
        maxPt = pt;
      }
    }
  }
  return { x: (minPt.x + maxPt.x) / 2, y: (minPt.y + maxPt.y) / 2 };
}

const WallMiniSelectorMap: React.FC<WallMiniSelectorMapProps> = ({
  entries,
  polygonContextWalls,
  activeWallId,
  onSelectWall,
  compact = false,
}) => {
  const [hoverEntryId, setHoverEntryId] = useState<string | null>(null);

  const boundsWalls = useMemo(() => entries.flatMap((e) => e.walls), [entries]);
  const miterWalls = polygonContextWalls.length > 0 ? polygonContextWalls : boundsWalls;

  let minX = -2000;
  let maxX = 2000;
  let minY = -2000;
  let maxY = 2000;
  if (boundsWalls.length > 0) {
    minX = Infinity;
    maxX = -Infinity;
    minY = Infinity;
    maxY = -Infinity;
    for (const w of boundsWalls) {
      minX = Math.min(minX, w.start.x, w.end.x);
      maxX = Math.max(maxX, w.start.x, w.end.x);
      minY = Math.min(minY, w.start.y, w.end.y);
      maxY = Math.max(maxY, w.start.y, w.end.y);
    }
  }
  const pad = compact ? 500 : 750;
  const vbX = minX - pad;
  const vbY = minY - pad;
  const vbW = Math.max(1500, maxX - minX + pad * 2);
  const vbH = Math.max(1500, maxY - minY + pad * 2);
  const baseR = Math.max(115, Math.min(280, Math.max(vbW, vbH) * (compact ? 0.044 : 0.025)));

  return (
    <svg
      data-testid="wallview-room-mini-svg"
      className="w-full h-full block"
      viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
      preserveAspectRatio="xMidYMid meet"
    >
      {entries.map((entry, idx) => {
        const isActive = Boolean(activeWallId && entry.memberWallIds.includes(activeWallId));
        const isHov = hoverEntryId === entry.id;
        const mid = getWallSelectorEntryMidpoint(entry);
        return (
          <g
            key={entry.id}
            data-testid={`wallview-selector-wall-${entry.representativeWallId}`}
            data-consolidated={entry.isConsolidated ? 'true' : 'false'}
            className="cursor-pointer"
            onPointerEnter={() => setHoverEntryId(entry.id)}
            onPointerLeave={() => setHoverEntryId((cur) => (cur === entry.id ? null : cur))}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onSelectWall(entry.representativeWallId);
            }}
          >
            <title>
              {entry.isConsolidated
                ? `Wall ${idx + 1} (Consolidated · ${entry.walls.length} segments) · ${formatSmartMetric(entry.totalLenMm)}`
                : `Wall ${idx + 1} · ${formatSmartMetric(entry.totalLenMm)}`}
            </title>
            {entry.walls.map((w) => {
              const poly = computeWallPolygon(w, miterWalls);
              const ptsStr = poly.map((p) => `${p.x},${p.y}`).join(' ');
              return (
                <polygon
                  key={w.id}
                  data-testid={`wallview-mini-seg-${w.id}`}
                  points={ptsStr}
                  fill={
                    isActive
                      ? 'rgba(37, 99, 235, 0.55)'
                      : isHov
                        ? 'rgba(37, 99, 235, 0.34)'
                        : 'rgba(59, 130, 246, 0.16)'
                  }
                  stroke={isActive ? '#1D4ED8' : isHov ? '#2563EB' : '#60A5FA'}
                  strokeWidth={Math.max(22, baseR * (isActive ? 0.2 : 0.14))}
                  strokeLinejoin="round"
                />
              );
            })}
            {isActive && (
              <circle
                cx={mid.x}
                cy={mid.y}
                r={baseR * 1.48}
                fill="rgba(37, 99, 235, 0.22)"
                stroke="#2563EB"
                strokeWidth={baseR * 0.14}
              />
            )}
            <circle
              cx={mid.x}
              cy={mid.y}
              r={isActive ? baseR * 1.12 : isHov ? baseR * 1.15 : baseR * 0.92}
              fill={isActive ? '#2563EB' : isHov ? '#2563EB' : '#64748B'}
              fillOpacity={0.95}
              stroke="#FFFFFF"
              strokeWidth={baseR * 0.22}
            />
            {entry.isConsolidated ? (
              <circle cx={mid.x} cy={mid.y} r={baseR * 0.42} fill="none" stroke="#FFFFFF" strokeWidth={baseR * 0.16} />
            ) : (
              <circle cx={mid.x} cy={mid.y} r={baseR * 0.32} fill="#FFFFFF" />
            )}
          </g>
        );
      })}
    </svg>
  );
};

interface WallCutThroughViewerProps {
  level: Level;
  settings: ProjectSettings;
  selection: SelectionTarget[];
  onSelect: (targets: SelectionTarget[]) => void;
  onUpdateLevel?: (
    updater: (lvl: Level) => Level,
    recomputeRooms?: boolean,
    recordHistory?: boolean,
    label?: string,
    coalesceKey?: string
  ) => void;
  onCommitDrag?: (label: string) => void;
  onCancelDrag?: () => void;
  onConstraintError?: (message: string) => void;
  onToggleBlackAndWhite?: () => void;
  hasClipboard?: boolean;
  onDuplicateSelected?: () => void;
  onDeleteSelected?: () => void;
  onPasteClipboard?: () => void;
}

type ElevDragState =
  | {
      kind: 'pan';
      startClientX: number;
      startClientY: number;
      origPanX: number;
      origPanY: number;
      selectWallOnClick?: boolean;
      selectWallIdOnClick?: string;
    }
  | {
      kind: 'comp_move';
      compId: string;
      compKind: 'opening' | 'chimney';
      startClientX: number;
      startClientY: number;
      origCenterS: number;
      origSillMm: number;
      label: string;
    }
  | {
      kind: 'comp_edge';
      compId: string;
      compKind: 'opening' | 'chimney';
      visualEdge: 'left' | 'right';
      startClientX: number;
      startClientY: number;
      label: string;
    }
  | {
      kind: 'comp_v';
      compId: string;
      compKind: 'opening' | 'chimney';
      handle: 'top' | 'bottom';
      startClientX: number;
      startClientY: number;
      origSillMm: number;
      origHeightMm: number;
      label: string;
    }
  | {
      kind: 'furn_move';
      furnId: string;
      startClientX: number;
      startClientY: number;
      origCenterX: number;
      origZBottom: number;
      origCenterS: number;
      ctrlToggleOnClick: boolean;
      origItemsMap: Map<string, WallViewGroupOrigItem>;
      label: string;
    };

export const WallCutThroughViewer: React.FC<WallCutThroughViewerProps> = ({
  level,
  settings,
  selection,
  onSelect,
  onUpdateLevel,
  onCommitDrag,
  onCancelDrag,
  onConstraintError,
  onToggleBlackAndWhite,
  hasClipboard = false,
  onDuplicateSelected,
  onDeleteSelected,
  onPasteClipboard,
}) => {
  const isBw = !!settings.blackAndWhite2d;
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 900, height: 600 });
  const [faceSide, setFaceSide] = useState<'inner' | 'outer'>('inner');
  const [showObjects, setShowObjects] = useState(true);
  const [maxContextRangeMm, setMaxContextRangeMm] = useState(700);
  const [showDepthEffect, setShowDepthEffect] = useState(true);
  const [showRoomWallDims, setShowRoomWallDims] = useState(true);
  const [showWallFurnitureDims, setShowWallFurnitureDims] = useState(true);
  const [dimsMenuOpen, setDimsMenuOpen] = useState(false);
  const dimsMenuRef = useRef<HTMLDivElement>(null);
  const [measureActive, setMeasureActive] = useState(false);
  const [measureDraftStart, setMeasureDraftStart] = useState<ElevPoint | null>(null);
  const [measureHoverSnap, setMeasureHoverSnap] = useState<WallViewSnapResult | null>(null);
  const [measureResult, setMeasureResult] = useState<{ start: ElevPoint; end: ElevPoint } | null>(
    null
  );
  const [wallMapOpen, setWallMapOpen] = useState(true);
  const [selectorRoomId, setSelectorRoomId] = useState<string | null>(null);
  const emptySelectorCanGoBackRef = useRef(false);
  const [placingChimney, setPlacingChimney] = useState(false);
  const [hoveredDimKey, setHoveredDimKey] = useState<string | null>(null);
  const [hoveredCompId, setHoveredCompId] = useState<string | null>(null);
  const [zoomScale, setZoomScale] = useState(1);
  const [panOffsetPx, setPanOffsetPx] = useState({ x: 0, y: 0 });
  const [spacePressed, setSpacePressed] = useState(false);
  const [glbCacheRev, setGlbCacheRev] = useState(0);
  const [elevDrag, setElevDrag] = useState<ElevDragState | null>(null);
  const elevDragRef = useRef<ElevDragState | null>(null);
  elevDragRef.current = elevDrag;
  const panSnapshotRef = useRef<{ x: number; y: number } | null>(null);
  const elevDragMutatedRef = useRef(false);
  const [cursorHint, setCursorHint] = useState<CursorHintPayload | null>(null);
  const [cursorClientPos, setCursorClientPos] = useState<{ x: number; y: number } | null>(null);
  const snapHysteresisRef = useRef<SnapHysteresisState>({});
  const furnPrevSettledRef = useRef<{ centerX: number; zBottom: number } | null>(null);
  const lastWallIdRef = useRef<string | null>(null);
  const snapTweenRef = useRef<SnapVisualTweenState | null>(null);
  const snapTweenRafRef = useRef<number | null>(null);
  const [snapTweenOffset, setSnapTweenOffset] = useState<{
    targetKey: string;
    dx: number;
    dy: number;
  } | null>(null);

  const clearSnapTween = useCallback(() => {
    if (snapTweenRafRef.current !== null) {
      window.cancelAnimationFrame(snapTweenRafRef.current);
      snapTweenRafRef.current = null;
    }
    snapTweenRef.current = null;
    setSnapTweenOffset(null);
  }, []);

  const triggerSnapTween = useCallback(
    (
      targetKey: string,
      prevPos: Point2D,
      nextPos: Point2D,
      snapKey: string | undefined,
      maxJumpMm: number
    ) => {
      const nextTween = updateSnapVisualTweenOnSolverResult(
        snapTweenRef.current,
        targetKey,
        prevPos,
        nextPos,
        snapKey,
        maxJumpMm,
        performance.now()
      );
      snapTweenRef.current = nextTween;
      if (!nextTween) {
        setSnapTweenOffset(null);
        return;
      }
      const sample = sampleSnapVisualTween(nextTween, performance.now());
      if (!sample.active) {
        setSnapTweenOffset((cur) => (cur ? null : cur));
        return;
      }
      setSnapTweenOffset({ targetKey: nextTween.targetKey, dx: sample.dx, dy: sample.dy });
      if (snapTweenRafRef.current !== null) {
        window.cancelAnimationFrame(snapTweenRafRef.current);
      }
      const step = () => {
        const cur = snapTweenRef.current;
        if (!cur) {
          snapTweenRafRef.current = null;
          setSnapTweenOffset(null);
          return;
        }
        const s = sampleSnapVisualTween(cur, performance.now());
        if (!s.active) {
          snapTweenRafRef.current = null;
          setSnapTweenOffset(null);
          return;
        }
        setSnapTweenOffset({ targetKey: cur.targetKey, dx: s.dx, dy: s.dy });
        snapTweenRafRef.current = window.requestAnimationFrame(step);
      };
      snapTweenRafRef.current = window.requestAnimationFrame(step);
    },
    []
  );

  useEffect(() => clearSnapTween, [clearSnapTween]);

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const ctxMetaRef = useRef<{
    nextLock: boolean;
    consolidateIds?: string[];
    separateIds?: string[];
  } | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const active = elevDragRef.current;
      if (active) {
        e.preventDefault();
        e.stopPropagation();
        if (active.kind === 'pan' && panSnapshotRef.current) {
          setPanOffsetPx(panSnapshotRef.current);
        } else if ('label' in active && elevDragMutatedRef.current) {
          onCancelDrag?.();
        }
        elevDragMutatedRef.current = false;
        panSnapshotRef.current = null;
        snapHysteresisRef.current = {};
        clearSnapTween();
        setCursorHint(null);
        setCursorClientPos(null);
        setElevDrag(null);
        return;
      }
      if (dimsMenuOpen) {
        setDimsMenuOpen(false);
      }
      if (measureDraftStart) {
        e.preventDefault();
        e.stopPropagation();
        setMeasureDraftStart(null);
        return;
      }
      if (measureResult) {
        e.preventDefault();
        e.stopPropagation();
        setMeasureResult(null);
        return;
      }
      if (measureActive) {
        e.preventDefault();
        e.stopPropagation();
        setMeasureActive(false);
        setMeasureHoverSnap(null);
        return;
      }
      if (placingChimney) {
        e.preventDefault();
        e.stopPropagation();
        setPlacingChimney(false);
        return;
      }
      if (emptySelectorCanGoBackRef.current) {
        e.preventDefault();
        e.stopPropagation();
        setSelectorRoomId(null);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [
    clearSnapTween,
    dimsMenuOpen,
    measureActive,
    measureDraftStart,
    measureResult,
    onCancelDrag,
    placingChimney,
  ]);

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    };
    const onSpaceDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setPlacingChimney(false);
        setMeasureActive((v) => {
          const next = !v;
          if (!next) {
            setMeasureDraftStart(null);
            setMeasureHoverSnap(null);
          }
          return next;
        });
        return;
      }
      if (e.code !== 'Space' && e.key !== ' ') return;
      e.preventDefault();
      setSpacePressed(true);
    };
    const onSpaceUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.key === ' ') {
        setSpacePressed(false);
      }
    };
    const onWindowBlur = () => setSpacePressed(false);
    window.addEventListener('keydown', onSpaceDown);
    window.addEventListener('keyup', onSpaceUp);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      window.removeEventListener('keydown', onSpaceDown);
      window.removeEventListener('keyup', onSpaceUp);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, []);

  useEffect(() => {
    if (!dimsMenuOpen) return;
    const onPointerDownOutside = (e: PointerEvent) => {
      if (dimsMenuRef.current && !dimsMenuRef.current.contains(e.target as Node)) {
        setDimsMenuOpen(false);
      }
    };
    window.addEventListener('pointerdown', onPointerDownOutside, true);
    return () => window.removeEventListener('pointerdown', onPointerDownOutside, true);
  }, [dimsMenuOpen]);

  const [editingDim, setEditingDim] = useState<{
    key: string;
    kind:
      | 'component_width'
      | 'clearance_left'
      | 'clearance_right'
      | 'wall_length'
      | 'obj_height'
      | 'obj_sill'
      | 'obj_top_gap'
      | 'wall_height'
      | 'furn_clear_left'
      | 'furn_clear_right'
      | 'furn_clear_bottom'
      | 'furn_clear_top';
    wallId: string;
    compId?: string;
    compKind?: 'opening' | 'chimney' | 'furniture';
    boundaryMm?: number;
    label: string;
    screenX: number;
    screenY: number;
    valueStr: string;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        setSize({
          width: Math.max(240, e.contentRect.width),
          height: Math.max(240, e.contentRect.height),
        });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Resolve active wall strictly from current selection (no auto-fallback when nothing is selected)
  const targetWall = useMemo<Wall | null>(() => {
    const visibleWalls = level.walls.filter((w) => w.visible);
    if (visibleWalls.length === 0) return null;

    const wallSel = selection.find((s) => s.kind === 'wall');
    if (wallSel) {
      const found = visibleWalls.find((w) => w.id === wallSel.id);
      if (found) return found;
    }

    const opSel = selection.find((s) => s.kind === 'opening');
    if (opSel) {
      const op = level.openings.find((o) => o.id === opSel.id);
      if (op) {
        const host = visibleWalls.find((w) => w.id === op.wallId);
        if (host) return host;
      }
    }

    const archSel = selection.find((s) => s.kind === 'arch');
    if (archSel) {
      const el = level.archElements.find((a) => a.id === archSel.id);
      if (el?.attachedWallId) {
        const host = visibleWalls.find((w) => w.id === el.attachedWallId);
        if (host) return host;
      }
    }

    const spatialSel = selection.find(
      (s) => s.kind === 'furniture' || s.kind === 'curtain' || s.kind === 'person' || s.kind === 'arch'
    );
    if (spatialSel) {
      // Keep the currently viewed wall locked when clicking/Ctrl-clicking furniture in Wall View
      if (lastWallIdRef.current) {
        const pinnedWall = visibleWalls.find((w) => w.id === lastWallIdRef.current);
        if (pinnedWall) return pinnedWall;
      }

      if (spatialSel.kind === 'furniture') {
        const furnObj = level.furniture.find((f) => f.id === spatialSel.id);
        if (furnObj?.attachedWallId) {
          const attached = visibleWalls.find((w) => w.id === furnObj.attachedWallId);
          if (attached) return attached;
        }
      }

      const obj =
        spatialSel.kind === 'furniture'
          ? level.furniture.find((f) => f.id === spatialSel.id)
          : spatialSel.kind === 'curtain'
            ? level.curtains.find((c) => c.id === spatialSel.id)
            : spatialSel.kind === 'person'
              ? level.people.find((p) => p.id === spatialSel.id)
              : level.archElements.find((a) => a.id === spatialSel.id);
      if (obj) {
        let bestW: Wall | null = null;
        let bestD = Infinity;
        for (const w of visibleWalls) {
          const dx = w.end.x - w.start.x;
          const dy = w.end.y - w.start.y;
          const len2 = dx * dx + dy * dy || 1;
          const t = Math.max(
            0,
            Math.min(1, ((obj.xMm - w.start.x) * dx + (obj.yMm - w.start.y) * dy) / len2)
          );
          const px = w.start.x + t * dx;
          const py = w.start.y + t * dy;
          const d = Math.hypot(obj.xMm - px, obj.yMm - py);
          if (d < bestD) {
            bestD = d;
            bestW = w;
          }
        }
        if (bestW) return bestW;
      }
    }

    return null;
  }, [
    level.archElements,
    level.curtains,
    level.furniture,
    level.openings,
    level.people,
    level.walls,
    selection,
  ]);

  const wallFaces = useMemo(
    () => (targetWall ? resolveWallFaces(targetWall, level.rooms) : null),
    [level.rooms, targetWall]
  );
  const viewedFaceInfo = wallFaces ? (faceSide === 'inner' ? wallFaces.primary : wallFaces.secondary) : null;
  const viewedPhysicalSide: 'left' | 'right' =
    viewedFaceInfo?.physicalSide ?? (faceSide === 'inner' ? 'left' : 'right');
  const viewedSlot: 'inner' | 'outer' = viewedFaceInfo?.slot ?? faceSide;
  const isLeftView = viewedPhysicalSide === 'left';

  const consolidatedRun = useMemo<ConsolidatedWallRun | null>(
    () =>
      targetWall
        ? buildConsolidatedWallRun(targetWall, viewedPhysicalSide, level.walls, level.rooms)
        : null,
    [level.rooms, level.walls, targetWall, viewedPhysicalSide]
  );

  const targetWallId = targetWall?.id ?? null;
  const targetWallGroupKey = useMemo(() => {
    if (!targetWall) return null;
    if (consolidatedRun) return consolidatedRun.groupId;
    return targetWall.id;
  }, [consolidatedRun, targetWall]);

  useEffect(() => {
    lastWallIdRef.current = targetWallId;
  }, [targetWallId]);

  useEffect(() => {
    setZoomScale(1);
    setPanOffsetPx({ x: 0, y: 0 });
    setEditingDim(null);
    setPlacingChimney(false);
  }, [targetWallGroupKey]);

  const wheelHandlerRef = useRef<(e: WheelEvent) => void>(() => {});
  wheelHandlerRef.current = (e: WheelEvent) => {
    e.preventDefault();
    const gesture = classifyWheelGesture({
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      deltaMode: e.deltaMode,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
    });
    if (gesture.kind === 'pan') {
      setPanOffsetPx((p) => ({ x: p.x - gesture.deltaX, y: p.y - gesture.deltaY }));
      return;
    }
    const rect = svgRef.current?.getBoundingClientRect();
    const cursorRelCenter = rect
      ? {
          x: e.clientX - rect.left - size.width / 2,
          y: e.clientY - rect.top - size.height / 2,
        }
      : { x: 0, y: 0 };
    const next = computeAnchoredZoom(
      zoomScale,
      panOffsetPx,
      cursorRelCenter,
      gesture.factor,
      0.35,
      4.5
    );
    setZoomScale(next.zoom);
    setPanOffsetPx(next.panPx);
  };

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const listener = (e: WheelEvent) => wheelHandlerRef.current(e);
    svg.addEventListener('wheel', listener, { passive: false });
    return () => svg.removeEventListener('wheel', listener);
  }, [targetWallId]);

  const wallMetrics = useMemo(() => {
    if (!targetWall) return null;

    const viewWall: Wall = consolidatedRun
      ? {
          ...targetWall,
          start: consolidatedRun.originPt,
          end: consolidatedRun.endPt,
          heightMm: consolidatedRun.maxHeightMm,
          isCurved: false,
          curveBulgeMm: 0,
        }
      : targetWall;

    const dx = viewWall.end.x - viewWall.start.x;
    const dy = viewWall.end.y - viewWall.start.y;
    const lenMm = consolidatedRun
      ? consolidatedRun.totalLenMm
      : Math.max(100, getWallArcLength(targetWall));
    const straightLen = Math.hypot(dx, dy) || 1;
    const ux = consolidatedRun ? consolidatedRun.ux : dx / straightLen;
    const uy = consolidatedRun ? consolidatedRun.uy : dy / straightLen;
    const nx = consolidatedRun ? consolidatedRun.nx : -uy;
    const ny = consolidatedRun ? consolidatedRun.ny : ux;

    const hasStartCap = consolidatedRun
      ? consolidatedRun.hasStartCap
      : level.walls.some(
          (w) =>
            w.id !== targetWall.id &&
            w.visible &&
            (dist(w.start, targetWall.start) < 16 || dist(w.end, targetWall.start) < 16)
        );
    const hasEndCap = consolidatedRun
      ? consolidatedRun.hasEndCap
      : level.walls.some(
          (w) =>
            w.id !== targetWall.id &&
            w.visible &&
            (dist(w.start, targetWall.end) < 16 || dist(w.end, targetWall.end) < 16)
        );

    const wallOpenings = consolidatedRun
      ? mapWallOpeningsToRun(consolidatedRun, level.openings).map(
          ({ op, centerS, leftS, rightS }) => ({ op, centerS, leftS, rightS })
        )
      : level.openings
          .filter((o) => o.wallId === targetWall.id && o.visible)
          .map((op) => {
            const centerS = op.t * lenMm;
            const leftS = Math.max(0, centerS - op.widthMm / 2);
            const rightS = Math.min(lenMm, centerS + op.widthMm / 2);
            return { op, centerS, leftS, rightS };
          })
          .sort((a, b) => a.leftS - b.leftS);

    const projectToWall = (xMm: number, yMm: number) => {
      const rx = xMm - viewWall.start.x;
      const ry = yMm - viewWall.start.y;
      const s = rx * ux + ry * uy;
      const signedPerp = rx * nx + ry * ny;
      return { s, signedPerp };
    };

    const sideTolerance = viewWall.thicknessMm * 0.55;
    let oppositeSideCount = 0;

    // Wall-attached chimneys (directly attached to viewed physical face OR projecting onto the viewed face)
    const wallChimneys: Array<{
      el: ArchElement;
      sCenter: number;
      leftS: number;
      rightS: number;
      effHeightMm: number;
      isDirectlyAttached: boolean;
    }> = [];

    if (consolidatedRun) {
      const mappedChims = mapWallChimneysToRun(consolidatedRun, level.archElements, projectToWall);
      wallChimneys.push(...mappedChims.chimneys);
      oppositeSideCount += mappedChims.oppositeSideCount;
    }

    for (const el of level.archElements) {
      if (!el.visible || el.type !== 'chimney') continue;
      if (consolidatedRun) {
        if (el.attachedWallId && consolidatedRun.wallIds.has(el.attachedWallId)) continue;
      } else {
        const isAttachedHere = el.attachedWallId === targetWall.id;
        if (isAttachedHere) {
          if (el.attachedFace && el.attachedFace !== viewedPhysicalSide) {
            oppositeSideCount += 1;
            continue;
          }
          const sCenter =
            typeof el.attachedT === 'number'
              ? el.attachedT * lenMm
              : projectToWall(el.xMm, el.yMm).s;
          const effHeightMm = el.connectToCeiling ? targetWall.heightMm : el.heightMm;
          wallChimneys.push({
            el,
            sCenter,
            leftS: Math.max(0, sCenter - el.widthMm / 2),
            rightS: Math.min(lenMm, sCenter + el.widthMm / 2),
            effHeightMm,
            isDirectlyAttached: true,
          });
          continue;
        }
      }
      const { s, signedPerp } = projectToWall(el.xMm, el.yMm);
      if (s + el.widthMm / 2 < -150 || s - el.widthMm / 2 > lenMm + 150) continue;
      if (Math.abs(signedPerp) > viewWall.thicknessMm / 2 + el.depthMm + 800) continue;
      const onViewedSide = isLeftView
        ? signedPerp >= -sideTolerance
        : signedPerp <= sideTolerance;
      if (!onViewedSide) {
        oppositeSideCount += 1;
        continue;
      }
      wallChimneys.push({
        el,
        sCenter: s,
        leftS: Math.max(0, s - el.widthMm / 2),
        rightS: Math.min(lenMm, s + el.widthMm / 2),
        effHeightMm: el.connectToCeiling ? viewWall.heightMm : el.heightMm,
        isDirectlyAttached: false,
      });
    }

    const faceOffsets = wallOffsets(viewWall.thicknessMm, viewWall.alignment);
    const viewedFacePerp = isLeftView ? faceOffsets.left : faceOffsets.right;
    const wallHalfThick = Math.max(20, viewWall.thicknessMm * 0.5);
    const getFrontDistanceMm = (signedPerp: number, objHalfDepth: number): number | null => {
      // Signed outward distance from the viewed wall face toward the room interior side
      const signedOutFromFace = isLeftView
        ? signedPerp - viewedFacePerp
        : viewedFacePerp - signedPerp;
      const maxOutFromFace = signedOutFromFace + objHalfDepth;
      if (maxOutFromFace <= 4 || (signedOutFromFace < -wallHalfThick && maxOutFromFace <= 15)) {
        return null;
      }
      const frontDistMm = Math.max(0, signedOutFromFace - objHalfDepth);
      if (frontDistMm > maxContextRangeMm) {
        return null;
      }
      return frontDistMm;
    };

    const wallFurniture: Array<{
      item: FurnitureInstance;
      visibleParts: CutThroughProjectedPart[];
      perpDistMm: number;
      projection?: WallViewFurnitureProjection;
    }> = [];

    for (const f of level.furniture) {
      if (!f.visible) continue;
      const effCeilMm = getEnclosingRoomCeilingMm(
        { x: f.xMm, y: f.yMm },
        level.rooms,
        level.ceilingHeightMm
      );
      const proj = projectFurnitureForWallCutThrough(
        viewWall,
        viewedPhysicalSide,
        f,
        effCeilMm,
        maxContextRangeMm
      );
      if (proj.status === 'opposite_side') {
        oppositeSideCount += 1;
        continue;
      }
      if (proj.status !== 'visible') continue;
      wallFurniture.push({
        item: proj.item,
        visibleParts: proj.visibleParts,
        perpDistMm: proj.perpDistMm,
        projection: proj.projection,
      });
    }
    wallFurniture.sort((a, b) => a.perpDistMm - b.perpDistMm);

    const wallCurtains: Array<{ item: Curtain; sCenter: number; perpDistMm: number }> = [];
    for (const c of level.curtains) {
      if (!c.visible) continue;
      const { s, signedPerp } = projectToWall(c.xMm, c.yMm);
      if (s + c.widthMm / 2 <= 0 || s - c.widthMm / 2 >= lenMm) continue;
      const perpDistMm = getFrontDistanceMm(signedPerp, 60);
      if (perpDistMm === null) {
        const signedOut = isLeftView
          ? signedPerp - viewedFacePerp
          : viewedFacePerp - signedPerp;
        if (signedOut + 60 <= 4) {
          oppositeSideCount += 1;
        }
        continue;
      }
      wallCurtains.push({ item: c, sCenter: s, perpDistMm });
    }
    wallCurtains.sort((a, b) => a.perpDistMm - b.perpDistMm);

    const wallPeople: Array<{ item: PersonInstance; sCenter: number; perpDistMm: number }> = [];
    for (const p of level.people) {
      if (!p.visible) continue;
      const { s, signedPerp } = projectToWall(p.xMm, p.yMm);
      if (s + 180 <= 0 || s - 180 >= lenMm) continue;
      const perpDistMm = getFrontDistanceMm(signedPerp, 140);
      if (perpDistMm === null) continue;
      wallPeople.push({ item: p, sCenter: s, perpDistMm });
    }
    wallPeople.sort((a, b) => a.perpDistMm - b.perpDistMm);

    // Non-wall-attached architectural elements (columns, stairs, beams, fireplaces, free blocks)
    const wallContextArch: Array<{ item: ArchElement; sCenter: number; projW: number; perpDistMm: number }> = [];
    for (const el of level.archElements) {
      if (!el.visible) continue;
      if (
        el.type === 'chimney' &&
        (el.attachedWallId === targetWall.id ||
          (consolidatedRun && el.attachedWallId && consolidatedRun.wallIds.has(el.attachedWallId)))
      ) {
        continue;
      }
      if (el.type === 'chimney' && wallChimneys.some((c) => c.el.id === el.id)) continue;
      const { s, signedPerp } = projectToWall(el.xMm, el.yMm);
      const rad = (el.rotationDeg * Math.PI) / 180;
      const cosA = Math.abs(Math.cos(rad) * ux + Math.sin(rad) * uy);
      const sinA = Math.abs(-Math.sin(rad) * ux + Math.cos(rad) * uy);
      const projW = el.widthMm * cosA + el.depthMm * sinA;
      const projD = el.widthMm * sinA + el.depthMm * cosA;
      if (s + projW / 2 <= 0 || s - projW / 2 >= lenMm) continue;
      const perpDistMm = getFrontDistanceMm(signedPerp, projD / 2);
      if (perpDistMm === null) continue;
      wallContextArch.push({ item: el, sCenter: s, projW, perpDistMm });
    }
    wallContextArch.sort((a, b) => a.perpDistMm - b.perpDistMm);

    const maxContextDistMm = Math.max(100, maxContextRangeMm);
    const occlusionWalls = consolidatedRun
      ? [...level.walls.filter((w) => !consolidatedRun.wallIds.has(w.id)), viewWall]
      : level.walls;
    const endOcclusion = computeWallEndOcclusion(viewWall, occlusionWalls, viewedPhysicalSide);

    return {
      lenMm,
      heightMm: viewWall.heightMm,
      hasStartCap,
      hasEndCap,
      endOcclusion,
      wallOpenings,
      wallChimneys,
      wallFurniture,
      wallCurtains,
      wallPeople,
      wallContextArch,
      maxContextDistMm,
      oppositeSideCount,
      ux,
      uy,
      consolidatedRun,
      viewWall,
    };
  }, [
    isLeftView,
    level.archElements,
    level.ceilingHeightMm,
    level.curtains,
    level.furniture,
    level.openings,
    level.people,
    level.rooms,
    level.walls,
    maxContextRangeMm,
    targetWall,
    viewedPhysicalSide,
  ]);

  useEffect(() => {
    if (!wallMetrics) return;
    let cancelled = false;
    for (const entry of wallMetrics.wallFurniture) {
      const f = entry.item;
      if (!f.glbAssetId && !f.glbDataUrl) continue;
      const dataUrl = f.glbDataUrl ?? getGlbAssetSync(f.glbAssetId) ?? undefined;
      if (getGlbSceneFromCacheSync(f.glbAssetId, dataUrl)) continue;
      loadGlbObjectCached(f.glbAssetId, dataUrl).then((obj) => {
        if (!cancelled && obj) {
          setGlbCacheRev((r) => r + 1);
        }
      });
    }
    return () => {
      cancelled = true;
    };
  }, [wallMetrics]);

  const basePxPerMm = useMemo(() => {
    if (!wallMetrics) return 0.1;
    const padX = 120;
    const padY = 135;
    const availW = Math.max(200, size.width - padX * 2);
    const availH = Math.max(180, size.height - padY * 2);
    let minWorldX = 0;
    let maxWorldX = wallMetrics.lenMm;
    let maxWorldZ = wallMetrics.heightMm;
    for (const entry of wallMetrics.wallFurniture) {
      const p = entry.projection;
      if (!p) continue;
      if (wallMetrics.endOcclusion.leftClipX === null || entry.perpDistMm >= wallMetrics.endOcclusion.leftBlockingOutMm) {
        minWorldX = Math.min(minWorldX, p.viewXCenter - p.elevW / 2);
      }
      if (wallMetrics.endOcclusion.rightClipX === null || entry.perpDistMm >= wallMetrics.endOcclusion.rightBlockingOutMm) {
        maxWorldX = Math.max(maxWorldX, p.viewXCenter + p.elevW / 2);
      }
      maxWorldZ = Math.max(maxWorldZ, p.zBottom + p.elevH);
    }
    const spanW = Math.max(wallMetrics.lenMm, maxWorldX - minWorldX);
    const spanH = Math.max(wallMetrics.heightMm, maxWorldZ);
    const totalW = spanW + 1150;
    const totalH = spanH + 950;
    return Math.min(availW / totalW, availH / totalH);
  }, [size.height, size.width, wallMetrics]);

  const pxPerMm = basePxPerMm * zoomScale;
  const zoomSnapTols = useMemo(
    () => computeZoomSnapTolerances(pxPerMm),
    [pxPerMm]
  );

  const mapX = useCallback(
    (sMm: number) => {
      if (!wallMetrics) return sMm;
      return isLeftView ? sMm : wallMetrics.lenMm - sMm;
    },
    [isLeftView, wallMetrics]
  );

  // Dimension chain & focused clearances shared cleanly with 2D solver
  const wallChain = useMemo(() => {
    if (!targetWall || !wallMetrics) return null;
    const run = wallMetrics.consolidatedRun;
    if (!run) {
      return buildWallDimensionChain(targetWall, level.walls, level.openings, level.archElements);
    }
    const envWalls = level.walls
      .filter((w) => !run.wallIds.has(w.id) || w.id === targetWall.id)
      .map((w) => (w.id === targetWall.id ? wallMetrics.viewWall : w));
    const bounds = computeWallInnerBounds(wallMetrics.viewWall, envWalls);
    const comps = [
      ...wallMetrics.wallOpenings.map(({ op, centerS, leftS, rightS }) => ({
        id: op.id,
        kind: 'opening' as const,
        name: op.name,
        centerS,
        widthMm: op.widthMm,
        leftS,
        rightS,
        t: centerS / Math.max(100, run.totalLenMm),
        locked: Boolean(op.locked),
        resizeAnchor: op.resizeAnchor ?? ('center' as const),
      })),
      ...wallMetrics.wallChimneys
        .filter((c) => c.isDirectlyAttached)
        .map((c) => ({
          id: c.el.id,
          kind: 'chimney' as const,
          name: c.el.name,
          centerS: c.sCenter,
          widthMm: c.el.widthMm,
          leftS: c.leftS,
          rightS: c.rightS,
          t: c.sCenter / Math.max(100, run.totalLenMm),
          locked: Boolean(c.el.locked),
          resizeAnchor: c.el.resizeAnchor ?? ('center' as const),
        })),
    ].sort((a, b) => a.leftS - b.leftS);

    const anyWallLocked = run.segments.some((s) => s.wall.locked);
    const segments: ReturnType<typeof buildWallDimensionChain>['segments'] = [];
    let cursor = bounds.innerStartS;
    let prevId = 'start';
    for (const comp of comps) {
      const gapStart = cursor;
      const gapEnd = Math.max(gapStart, comp.leftS);
      if (gapEnd - gapStart >= 1) {
        segments.push({
          key: `gap:${prevId}:${comp.id}`,
          kind: 'wall_gap',
          startS: gapStart,
          endS: gapEnd,
          lengthMm: gapEnd - gapStart,
          locked: anyWallLocked,
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
        locked: anyWallLocked || comp.locked,
        label: comp.name,
      });
      cursor = Math.max(cursor, comp.rightS);
      prevId = comp.id;
    }
    if (bounds.innerEndS - cursor >= 1 || comps.length === 0) {
      segments.push({
        key: `gap:${prevId}:end`,
        kind: 'wall_gap',
        startS: cursor,
        endS: Math.max(cursor, bounds.innerEndS),
        lengthMm: Math.max(cursor, bounds.innerEndS) - cursor,
        locked: anyWallLocked,
        label: 'Wall',
      });
    }
    return { bounds, components: comps, segments };
  }, [level.archElements, level.openings, level.walls, targetWall, wallMetrics]);

  const focusedWallComp = useMemo(() => {
    if (!wallChain || !targetWall || selection.length !== 1) return null;
    const sel = selection[0];
    if (sel.kind !== 'opening' && sel.kind !== 'arch') return null;
    return getNonCrossingClearances(sel.id, wallChain.components, wallChain.bounds, targetWall.locked);
  }, [selection, targetWall, wallChain]);

  const wallElevFurnitureMeta = useMemo(() => {
    if (!targetWall || !wallMetrics) return null;
    const run = wallMetrics.consolidatedRun;
    const envWalls = run
      ? level.walls
          .filter((w) => !run.wallIds.has(w.id) || w.id === targetWall.id)
          .map((w) => (w.id === targetWall.id ? wallMetrics.viewWall : w))
      : level.walls;
    const ib = computeWallInnerBounds(wallMetrics.viewWall, envWalls);
    const sMin =
      viewedPhysicalSide === 'left'
        ? Math.min(ib.leftStartS, ib.leftEndS)
        : Math.min(ib.rightStartS, ib.rightEndS);
    const sMax =
      viewedPhysicalSide === 'left'
        ? Math.max(ib.leftStartS, ib.leftEndS)
        : Math.max(ib.rightStartS, ib.rightEndS);
    const xA = mapX(sMin);
    const xB = mapX(sMax);
    const dragBounds: WallViewDragBounds = {
      innerLeftX: Math.min(xA, xB),
      innerRightX: Math.max(xA, xB),
      wallHeightMm: wallMetrics.heightMm,
    };

    const furnRects: WallViewElevRect[] = [];
    const furnRectById = new Map<string, WallViewElevRect>();
    const interactiveIds = new Set<string>();

    for (const entry of wallMetrics.wallFurniture) {
      const p = entry.projection;
      if (!p) continue;
      const rect: WallViewElevRect = {
        id: entry.item.id,
        name: entry.item.name,
        leftX: p.viewXCenter - p.elevW / 2,
        rightX: p.viewXCenter + p.elevW / 2,
        zBottom: p.zBottom,
        zTop: p.zBottom + p.elevH,
        centerX: p.viewXCenter,
        elevW: p.elevW,
        elevH: p.elevH,
      };
      furnRects.push(rect);
      furnRectById.set(entry.item.id, rect);
      const effWallId =
        entry.item.attachedWallId && run?.wallIds.has(entry.item.attachedWallId)
          ? entry.item.attachedWallId
          : targetWall.id;
      if (isFurnitureInteractiveInWallView(entry.item, entry.perpDistMm, effWallId, true)) {
        interactiveIds.add(entry.item.id);
      }
    }

    const wallEdgeObstacles: WallViewOpeningObstacle[] = [
      ...wallMetrics.wallOpenings.map(({ op, leftS, rightS }) => {
        const ox1 = Math.min(mapX(leftS), mapX(rightS));
        const ox2 = Math.max(mapX(leftS), mapX(rightS));
        return {
          id: op.id,
          name: op.name,
          leftX: ox1,
          rightX: ox2,
          zBottom: op.sillHeightMm,
          zTop: Math.min(wallMetrics.heightMm, op.sillHeightMm + op.heightMm),
        };
      }),
      ...wallMetrics.wallChimneys.map(({ el, leftS, rightS, effHeightMm }) => {
        const cx1 = Math.min(mapX(leftS), mapX(rightS));
        const cx2 = Math.max(mapX(leftS), mapX(rightS));
        return {
          id: el.id,
          name: el.name,
          leftX: cx1,
          rightX: cx2,
          zBottom: el.elevationMm,
          zTop: Math.min(wallMetrics.heightMm, el.elevationMm + effHeightMm),
        };
      }),
    ];

    const solidArchObstacles: WallViewOpeningObstacle[] = [
      ...wallMetrics.wallChimneys.map(({ el, leftS, rightS, effHeightMm }) => {
        const cx1 = Math.min(mapX(leftS), mapX(rightS));
        const cx2 = Math.max(mapX(leftS), mapX(rightS));
        return {
          id: el.id,
          name: el.name,
          leftX: cx1,
          rightX: cx2,
          zBottom: el.elevationMm,
          zTop: Math.min(wallMetrics.heightMm, el.elevationMm + effHeightMm),
        };
      }),
      ...wallMetrics.wallContextArch.map(({ item: el, sCenter, projW }) => {
        const ex = mapX(sCenter);
        const h = el.connectToCeiling ? wallMetrics.heightMm - el.elevationMm : el.heightMm;
        return {
          id: el.id,
          name: el.name,
          leftX: ex - projW / 2,
          rightX: ex + projW / 2,
          zBottom: el.elevationMm,
          zTop: Math.min(wallMetrics.heightMm, el.elevationMm + h),
        };
      }),
    ];

    return {
      dragBounds,
      furnRects,
      furnRectById,
      interactiveIds,
      wallEdgeObstacles,
      solidArchObstacles,
    };
  }, [level.walls, mapX, targetWall, viewedPhysicalSide, wallMetrics]);

  const wallViewSnapGeom = useMemo(() => {
    if (!wallMetrics || !wallElevFurnitureMeta) return null;
    return extractWallViewSnapGeometry({
      wallLenMm: wallMetrics.lenMm,
      wallHeightMm: wallMetrics.heightMm,
      innerLeftX: wallElevFurnitureMeta.dragBounds.innerLeftX,
      innerRightX: wallElevFurnitureMeta.dragBounds.innerRightX,
      furnRects: showObjects ? wallElevFurnitureMeta.furnRects : [],
      wallEdgeObstacles: wallElevFurnitureMeta.wallEdgeObstacles,
      solidArchObstacles: wallElevFurnitureMeta.solidArchObstacles,
    });
  }, [showObjects, wallElevFurnitureMeta, wallMetrics]);

  const wallViewRoomDims = useMemo(() => {
    if (!targetWall || !wallMetrics || !showRoomWallDims) return null;
    return computeWallViewRoomDimensions({
      wall: wallMetrics.viewWall,
      rooms: level.rooms,
      viewedPhysicalSide,
      wallLenMm: wallMetrics.lenMm,
      wallHeightMm: wallMetrics.heightMm,
      isLeftView,
    });
  }, [isLeftView, level.rooms, showRoomWallDims, targetWall, viewedPhysicalSide, wallMetrics]);

  useEffect(() => {
    setMeasureDraftStart(null);
    setMeasureHoverSnap(null);
    setMeasureResult(null);
  }, [targetWallGroupKey, viewedPhysicalSide]);

  // Baseboard non-door/non-chimney spans
  const baseboardSpans = useMemo(() => {
    if (!wallMetrics || !targetWall) return [];
    const blocked: Array<[number, number]> = [];
    for (const wo of wallMetrics.wallOpenings) {
      if (wo.op.sillHeightMm < (targetWall.baseboardHeightMm || 80)) {
        const a = mapX(wo.leftS);
        const b = mapX(wo.rightS);
        blocked.push([Math.min(a, b), Math.max(a, b)]);
      }
    }
    blocked.sort((a, b) => a[0] - b[0]);
    const spans: Array<[number, number]> = [];
    let cur = 0;
    for (const [b1, b2] of blocked) {
      if (b1 > cur + 10) spans.push([cur, b1]);
      cur = Math.max(cur, b2);
    }
    if (cur < wallMetrics.lenMm - 10) spans.push([cur, wallMetrics.lenMm]);
    return spans;
  }, [mapX, targetWall, wallMetrics]);

  const worldToScreenElev = useCallback(
    (worldX: number, worldY: number): Point2D => {
      if (!wallMetrics) return { x: size.width / 2, y: size.height / 2 };
      const cxWorld = wallMetrics.lenMm / 2;
      const cyWorld = -wallMetrics.heightMm / 2;
      return {
        x: size.width / 2 + panOffsetPx.x + (worldX - cxWorld) * pxPerMm,
        y: size.height / 2 + panOffsetPx.y + (worldY - cyWorld) * pxPerMm,
      };
    },
    [panOffsetPx.x, panOffsetPx.y, pxPerMm, size.height, size.width, wallMetrics]
  );

  const screenToWorldElev = useCallback(
    (clientX: number, clientY: number): Point2D => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect || !wallMetrics) return { x: 0, y: 0 };
      const cxWorld = wallMetrics.lenMm / 2;
      const cyWorld = -wallMetrics.heightMm / 2;
      const sx = clientX - rect.left;
      const sy = clientY - rect.top;
      return {
        x: cxWorld + (sx - (size.width / 2 + panOffsetPx.x)) / pxPerMm,
        y: cyWorld + (sy - (size.height / 2 + panOffsetPx.y)) / pxPerMm,
      };
    },
    [panOffsetPx.x, panOffsetPx.y, pxPerMm, size.height, size.width, wallMetrics]
  );

  // Place chimney directly on the currently viewed parallel wall face in Cut-Through
  const handlePlaceChimneyOnWall = useCallback(
    (clientX: number, clientY: number) => {
      if (!targetWall || !wallMetrics || !onUpdateLevel) return;
      if (targetWall.locked) {
        onConstraintError?.('Wall is locked. Unlock it before placing a chimney.');
        return;
      }
      const wPt = screenToWorldElev(clientX, clientY);
      const rawS = isLeftView ? wPt.x : wallMetrics.lenMm - wPt.x;
      const defaultW = 650;
      const defaultD = 450;
      const face: 'left' | 'right' = viewedPhysicalSide;
      const id = uid('arch');

      const faceBounds = computeChimneyFaceBounds(targetWall, level.walls, face, defaultD, rawS);
      if (faceBounds.maxS - faceBounds.minS < defaultW - 2) {
        onConstraintError?.('Not enough unobstructed wall length on this face for a chimney.');
        return;
      }
      const chimBounds = {
        lengthMm: wallMetrics.lenMm,
        innerStartS: faceBounds.minS,
        innerEndS: faceBounds.maxS,
        leftStartS: faceBounds.minS,
        leftEndS: faceBounds.maxS,
        rightStartS: faceBounds.minS,
        rightEndS: faceBounds.maxS,
      };
      const existing = getWallMountedComponents(targetWall, level.openings, level.archElements);
      const candComps = [
        ...existing,
        {
          id,
          kind: 'chimney' as const,
          name: 'Chimney',
          centerS: rawS,
          widthMm: defaultW,
          leftS: rawS - defaultW / 2,
          rightS: rawS + defaultW / 2,
          t: Math.max(0.05, Math.min(0.95, rawS / wallMetrics.lenMm)),
          locked: false,
          resizeAnchor: 'center' as const,
        },
      ].sort((a, b) => a.centerS - b.centerS);

      const solvedDrag = solveWallComponentDrag(candComps, chimBounds, id, rawS, settings.snapEnabled);
      const xf = computeAttachedChimneyTransform(targetWall, solvedDrag.t, defaultD, face);
      if (doesChimneyOverlapWalls(xf.xMm, xf.yMm, defaultW, defaultD, xf.rotationDeg, level.walls, 6)) {
        onConstraintError?.('Cannot place chimney overlapping an adjacent wall.');
        return;
      }
      const cornerPin = getChimneyCornerPin(
        targetWall,
        level.walls,
        solvedDrag.t,
        defaultW,
        defaultD,
        face
      );
      const faceColor = viewedSlot === 'inner' ? targetWall.innerColor : targetWall.outerColor;
      const faceMat = viewedSlot === 'inner' ? targetWall.innerMaterial : targetWall.outerMaterial;

      const newEl: ArchElement = {
        id,
        name: 'Chimney',
        type: 'chimney',
        xMm: xf.xMm,
        yMm: xf.yMm,
        elevationMm: 0,
        widthMm: defaultW,
        depthMm: defaultD,
        heightMm: targetWall.heightMm,
        rotationDeg: xf.rotationDeg,
        color: faceColor,
        accentColor: '#334155',
        material: faceMat,
        connectToCeiling: true,
        attachedWallId: targetWall.id,
        attachedFace: face,
        attachedT: solvedDrag.t,
        resizeAnchor: cornerPin ?? 'center',
        hasBaseboard: targetWall.hasBaseboard,
        baseboardHeightMm: targetWall.baseboardHeightMm,
        baseboardColor: targetWall.baseboardColor,
        hasCrownMolding: targetWall.hasCrownMolding,
        crownHeightMm: targetWall.crownHeightMm,
        crownColor: targetWall.crownColor,
        visible: true,
        locked: false,
      };

      onUpdateLevel(
        (lvl) => ({ ...lvl, archElements: [...lvl.archElements, newEl] }),
        false,
        true,
        'Add Chimney on Wall'
      );
      onSelect([{ kind: 'arch', id }]);
      setPlacingChimney(false);
    },
    [
      isLeftView,
      level.archElements,
      level.openings,
      level.walls,
      onConstraintError,
      onSelect,
      onUpdateLevel,
      screenToWorldElev,
      settings.snapEnabled,
      targetWall,
      viewedPhysicalSide,
      viewedSlot,
      wallMetrics,
    ]
  );

  // Commit inline dimension edits in Cut-Through
  const commitElevDimEdit = useCallback(() => {
    if (!editingDim || !targetWall || !onUpdateLevel) return;
    const cm = Number(editingDim.valueStr);
    if (!editingDim.valueStr.trim() || !Number.isFinite(cm) || cm < 0) {
      setEditingDim((d) => (d ? { ...d, error: 'Enter a valid dimension in cm.' } : null));
      return;
    }
    const nextMm = Math.round(cm * 10);

    if (editingDim.kind === 'wall_length') {
      const res = solveConnectedWallLengthChange(
        targetWall,
        level.walls,
        level.openings,
        level.archElements,
        nextMm
      );
      if (!res.ok) {
        const err = res.error ?? 'Cannot resize wall.';
        setEditingDim((d) => (d ? { ...d, error: err } : null));
        onConstraintError?.(err);
        return;
      }
      const wallUpdMap = new Map(res.wallUpdates.map((u) => [u.id, u]));
      const opUpdMap = new Map(res.openingUpdates.map((u) => [u.id, u.t]));
      const chimUpdMap = new Map(res.chimneyUpdates.map((u) => [u.id, u]));
      onUpdateLevel(
        (lvl) => ({
          ...lvl,
          walls: lvl.walls.map((w) => {
            const u = wallUpdMap.get(w.id);
            return u ? { ...w, start: u.start, end: u.end } : w;
          }),
          openings: lvl.openings.map((o) =>
            opUpdMap.has(o.id) ? { ...o, t: opUpdMap.get(o.id)! } : o
          ),
          archElements: lvl.archElements.map((a) => {
            const c = chimUpdMap.get(a.id);
            return c
              ? {
                  ...a,
                  attachedT: c.attachedT,
                  xMm: c.xMm,
                  yMm: c.yMm,
                  rotationDeg: c.rotationDeg,
                }
              : a;
          }),
        }),
        true,
        true,
        'Resize Wall'
      );
      setEditingDim(null);
      return;
    }

    if (editingDim.kind === 'wall_height') {
      if (targetWall.locked) {
        onConstraintError?.('Wall is locked.');
        return;
      }
      if (nextMm < 300 || nextMm > 10000) {
        setEditingDim((d) => (d ? { ...d, error: 'Wall height must be 30–1000 cm.' } : null));
        return;
      }
      onUpdateLevel(
        (lvl) => ({
          ...lvl,
          walls: lvl.walls.map((w) => (w.id === targetWall.id ? { ...w, heightMm: nextMm } : w)),
        }),
        false,
        true,
        'Resize Wall Height'
      );
      setEditingDim(null);
      return;
    }

    if (
      (editingDim.kind === 'component_width' ||
        editingDim.kind === 'clearance_left' ||
        editingDim.kind === 'clearance_right') &&
      editingDim.compId &&
      wallChain
    ) {
      const chimEl =
        editingDim.compKind === 'chimney'
          ? level.archElements.find((a) => a.id === editingDim.compId)
          : undefined;
      const opEl = !chimEl
        ? level.openings.find((o) => o.id === editingDim.compId)
        : undefined;
      const hostWall =
        (opEl ? level.walls.find((w) => w.id === opEl.wallId) : undefined) ??
        (chimEl?.attachedWallId
          ? level.walls.find((w) => w.id === chimEl.attachedWallId)
          : undefined) ??
        targetWall;
      const hostChain =
        hostWall.id === targetWall.id && !wallMetrics?.consolidatedRun
          ? wallChain
          : buildWallDimensionChain(hostWall, level.walls, level.openings, level.archElements);
      const res =
        editingDim.kind === 'component_width'
          ? chimEl
            ? solveChimneyResize(
                hostWall,
                level.walls,
                level.openings,
                level.archElements,
                chimEl.id,
                nextMm,
                chimEl.depthMm
              )
            : solveWallComponentResize(
                hostWall,
                hostChain.components,
                hostChain.bounds,
                editingDim.compId,
                nextMm
              )
          : solveWallClearanceEdit(
              hostWall,
              hostChain.components,
              hostChain.bounds,
              editingDim.compId,
              editingDim.kind === 'clearance_left' ? 'left' : 'right',
              nextMm
            );
      if (!res.ok) {
        const err = res.error ?? 'Constraint violation.';
        setEditingDim((d) => (d ? { ...d, error: err } : null));
        onConstraintError?.(err);
        return;
      }
      const updateMap = new Map(res.updates.map((u) => [u.id, u]));
      onUpdateLevel(
        (lvl) => ({
          ...lvl,
          openings: lvl.openings.map((o) => {
            const u = updateMap.get(o.id);
            return u && u.kind === 'opening' ? { ...o, t: u.t, widthMm: u.widthMm } : o;
          }),
          archElements: lvl.archElements.map((a) => {
            const u = updateMap.get(a.id);
            if (!u || u.kind !== 'chimney') return a;
            const xf = computeAttachedChimneyTransform(
              hostWall,
              u.t,
              a.depthMm,
              a.attachedFace ?? 'left'
            );
            const pin = getChimneyCornerPin(
              hostWall,
              lvl.walls,
              u.t,
              u.widthMm,
              a.depthMm,
              a.attachedFace ?? 'left'
            );
            return {
              ...a,
              widthMm: u.widthMm,
              attachedT: u.t,
              xMm: xf.xMm,
              yMm: xf.yMm,
              rotationDeg: xf.rotationDeg,
              resizeAnchor: pin ?? a.resizeAnchor,
            };
          }),
        }),
        false,
        true,
        'Edit Dimension'
      );
      setEditingDim(null);
      return;
    }

    // Vertical object dimensions (obj_height, obj_sill, obj_top_gap)
    if (editingDim.compId && editingDim.compKind === 'opening') {
      const op = level.openings.find((o) => o.id === editingDim.compId);
      const hostWall = op ? level.walls.find((w) => w.id === op.wallId) ?? targetWall : targetWall;
      if (!op || op.locked || hostWall.locked) {
        onConstraintError?.('Component or wall is locked.');
        return;
      }
      let nextH = op.heightMm;
      let nextSill = op.sillHeightMm;
      if (editingDim.kind === 'obj_height') {
        if (nextMm < 200 || op.sillHeightMm + nextMm > hostWall.heightMm) {
          const maxCm = Math.round((hostWall.heightMm - op.sillHeightMm) / 10);
          setEditingDim((d) =>
            d ? { ...d, error: `Height must be 20–${maxCm} cm (fits below ceiling).` } : null
          );
          return;
        }
        nextH = nextMm;
      } else if (editingDim.kind === 'obj_sill') {
        if (nextMm < 0 || nextMm + op.heightMm > hostWall.heightMm) {
          const maxCm = Math.round((hostWall.heightMm - op.heightMm) / 10);
          setEditingDim((d) =>
            d ? { ...d, error: `Sill height must be 0–${maxCm} cm.` } : null
          );
          return;
        }
        nextSill = nextMm;
      } else if (editingDim.kind === 'obj_top_gap') {
        const nextTop = hostWall.heightMm - nextMm;
        const derivedSill = nextTop - op.heightMm;
        if (nextMm < 0 || derivedSill < 0) {
          setEditingDim((d) =>
            d ? { ...d, error: 'Top gap exceeds remaining wall height above opening.' } : null
          );
          return;
        }
        nextSill = derivedSill;
      }
      onUpdateLevel(
        (lvl) => ({
          ...lvl,
          openings: lvl.openings.map((o) =>
            o.id === op.id ? { ...o, heightMm: nextH, sillHeightMm: nextSill } : o
          ),
        }),
        false,
        true,
        'Edit Vertical Dimension'
      );
      setEditingDim(null);
      return;
    }

    if (editingDim.compId && editingDim.compKind === 'chimney') {
      const el = level.archElements.find((a) => a.id === editingDim.compId);
      const hostWall =
        (el?.attachedWallId ? level.walls.find((w) => w.id === el.attachedWallId) : undefined) ??
        targetWall;
      if (!el || el.locked || hostWall.locked) {
        onConstraintError?.('Chimney or wall is locked.');
        return;
      }
      let nextH = el.heightMm;
      let nextElev = el.elevationMm;
      let connectToCeiling = el.connectToCeiling;
      if (editingDim.kind === 'obj_height') {
        if (nextMm < 100 || el.elevationMm + nextMm > hostWall.heightMm) {
          setEditingDim((d) =>
            d ? { ...d, error: 'Height cannot exceed ceiling height.' } : null
          );
          return;
        }
        nextH = nextMm;
        connectToCeiling = nextMm >= hostWall.heightMm - el.elevationMm;
      } else if (editingDim.kind === 'obj_sill') {
        if (nextMm < 0 || nextMm + el.heightMm > hostWall.heightMm) {
          setEditingDim((d) => (d ? { ...d, error: 'Elevation exceeds wall height.' } : null));
          return;
        }
        nextElev = nextMm;
      } else if (editingDim.kind === 'obj_top_gap') {
        const nextTop = hostWall.heightMm - nextMm;
        if (nextMm < 0 || nextTop - el.elevationMm < 100) {
          setEditingDim((d) => (d ? { ...d, error: 'Invalid top clearance.' } : null));
          return;
        }
        nextH = nextTop - el.elevationMm;
        connectToCeiling = nextMm === 0;
      }
      onUpdateLevel(
        (lvl) => ({
          ...lvl,
          archElements: lvl.archElements.map((a) =>
            a.id === el.id
              ? { ...a, heightMm: nextH, elevationMm: nextElev, connectToCeiling }
              : a
          ),
        }),
        false,
        true,
        'Edit Chimney Vertical Dimension'
      );
      setEditingDim(null);
      return;
    }

    if (
      (editingDim.kind === 'furn_clear_left' ||
        editingDim.kind === 'furn_clear_right' ||
        editingDim.kind === 'furn_clear_bottom' ||
        editingDim.kind === 'furn_clear_top') &&
      editingDim.compId &&
      typeof editingDim.boundaryMm === 'number' &&
      wallElevFurnitureMeta &&
      wallMetrics
    ) {
      const f = level.furniture.find((item) => item.id === editingDim.compId);
      const rect = wallElevFurnitureMeta.furnRectById.get(editingDim.compId);
      if (!f || !rect) return;
      if (f.locked || (f.attachedWallId === targetWall.id && targetWall.locked)) {
        onConstraintError?.('Furniture or wall is locked.');
        return;
      }

      const boundaryMm = editingDim.boundaryMm;
      let deltaX = 0;
      let deltaZ = 0;
      if (editingDim.kind === 'furn_clear_left') {
        deltaX = boundaryMm + nextMm - rect.leftX;
      } else if (editingDim.kind === 'furn_clear_right') {
        deltaX = boundaryMm - nextMm - rect.rightX;
      } else if (editingDim.kind === 'furn_clear_bottom') {
        deltaZ = boundaryMm + nextMm - rect.zBottom;
      } else if (editingDim.kind === 'furn_clear_top') {
        deltaZ = boundaryMm - nextMm - rect.zTop;
      }

      const selectedFurnIds = new Set(
        selection.filter((s) => s.kind === 'furniture').map((s) => s.id)
      );
      const activeGroupIds = selectedFurnIds.has(f.id) ? selectedFurnIds : new Set([f.id]);
      for (const gid of activeGroupIds) {
        const gf = level.furniture.find((x) => x.id === gid);
        const grect = wallElevFurnitureMeta.furnRectById.get(gid);
        if (!gf || gf.locked || !grect) continue;
        const nL = grect.leftX + deltaX;
        const nR = grect.rightX + deltaX;
        const nB = grect.zBottom + deltaZ;
        const nT = grect.zTop + deltaZ;
        if (
          nL < wallElevFurnitureMeta.dragBounds.innerLeftX - 2 ||
          nR > wallElevFurnitureMeta.dragBounds.innerRightX + 2
        ) {
          setEditingDim((d) =>
            d ? { ...d, error: 'Distance pushes furniture beyond inner wall corner.' } : null
          );
          return;
        }
        if (nB < -2 || nT > wallElevFurnitureMeta.dragBounds.wallHeightMm + 2) {
          setEditingDim((d) =>
            d ? { ...d, error: 'Elevation must stay between floor and ceiling.' } : null
          );
          return;
        }
      }

      const origById = new Map<string, WallViewGroupOrigItem>();
      for (const gid of activeGroupIds) {
        const gf = level.furniture.find((x) => x.id === gid);
        const grect = wallElevFurnitureMeta.furnRectById.get(gid);
        if (!gf || gf.locked || !grect) continue;
        origById.set(gid, {
          id: gf.id,
          origXMm: gf.xMm,
          origYMm: gf.yMm,
          origElevationMm: gf.elevationMm ?? 0,
          origRotDeg: gf.rotationDeg,
          origAttachedWallId: gf.attachedWallId,
          origAttachedFace: gf.attachedFace,
          origAttachedT: gf.attachedT,
          origCenterX: grect.centerX,
          origZBottom: grect.zBottom,
          elevW: grect.elevW,
          elevH: grect.elevH,
        });
      }

      const deltaS = isLeftView ? deltaX : -deltaX;
      onUpdateLevel(
        (lvl) => ({
          ...lvl,
          furniture: applyWallViewFurnitureGroupDelta(
            lvl.furniture,
            activeGroupIds,
            wallMetrics.viewWall,
            viewedPhysicalSide,
            deltaS,
            deltaZ,
            origById
          ),
        }),
        false,
        true,
        'Edit Furniture Clearance'
      );
      setEditingDim(null);
    }
  }, [
    editingDim,
    isLeftView,
    level.archElements,
    level.furniture,
    level.openings,
    onConstraintError,
    onUpdateLevel,
    selection,
    targetWall,
    viewedPhysicalSide,
    wallChain,
    wallElevFurnitureMeta,
    wallMetrics,
  ]);

  // Empty or no-wall-selected state → Room-first selector, then filtered "Select wall" schematic
  const visibleWallsList = useMemo(
    () => level.walls.filter((w) => w.visible),
    [level.walls]
  );

  const selectorRoomGroups = useMemo<SelectorRoomGroup[]>(() => {
    const visibleRooms = level.rooms.filter((r) => r.visible !== false && r.polygon.length >= 3);
    const wallsByRoom = new Map<string, Wall[]>();
    const faceMapByRoom = new Map<string, Map<string, 'inner' | 'outer'>>();
    const unassignedWalls: Wall[] = [];

    for (const r of visibleRooms) {
      wallsByRoom.set(r.id, []);
      faceMapByRoom.set(r.id, new Map());
    }

    for (const w of visibleWallsList) {
      const faces = resolveWallFaces(w, level.rooms);
      const roomIds = new Set<string>();
      if (faces.left.roomId && wallsByRoom.has(faces.left.roomId)) {
        roomIds.add(faces.left.roomId);
      }
      if (faces.right.roomId && wallsByRoom.has(faces.right.roomId)) {
        roomIds.add(faces.right.roomId);
      }
      if (roomIds.size === 0) {
        unassignedWalls.push(w);
        continue;
      }
      for (const roomId of roomIds) {
        wallsByRoom.get(roomId)!.push(w);
        const insideFace: 'inner' | 'outer' =
          faces.primary.roomId === roomId ? 'inner' : 'outer';
        faceMapByRoom.get(roomId)!.set(w.id, insideFace);
      }
    }

    const groups: SelectorRoomGroup[] = [];
    for (const r of visibleRooms) {
      const rWalls = wallsByRoom.get(r.id) ?? [];
      if (rWalls.length === 0) continue;
      const wallFaceMap = faceMapByRoom.get(r.id)!;
      const entryCount = buildRoomWallSelectorEntries({
        roomWalls: rWalls,
        wallFaceMap,
        allWalls: level.walls,
        rooms: level.rooms,
      }).length;
      groups.push({
        id: r.id,
        name: r.name.trim() || 'Room',
        areaSqM: Number.isFinite(r.areaM2) ? r.areaM2 : null,
        polygon: r.polygon,
        color: r.floorColor || '#3B82F6',
        walls: rWalls,
        wallFaceMap,
        entryCount,
      });
    }

    if (unassignedWalls.length > 0) {
      const emptyMap = new Map<string, 'inner' | 'outer'>();
      const entryCount = buildRoomWallSelectorEntries({
        roomWalls: unassignedWalls,
        wallFaceMap: emptyMap,
        allWalls: level.walls,
        rooms: level.rooms,
      }).length;
      groups.push({
        id: UNASSIGNED_ROOM_GROUP_ID,
        name: 'Unassigned / Exterior',
        areaSqM: null,
        polygon: null,
        color: '#64748B',
        walls: unassignedWalls,
        wallFaceMap: emptyMap,
        entryCount,
      });
    }

    return groups;
  }, [level.rooms, level.walls, visibleWallsList]);

  const effectiveRoomId = useMemo(
    () =>
      resolveWallViewRoomId({
        selectorRoomId,
        roomGroups: selectorRoomGroups,
        targetWall,
        viewedFaceRoomId: viewedFaceInfo?.roomId ?? null,
        primaryRoomId: wallFaces?.primary.roomId ?? null,
        secondaryRoomId: wallFaces?.secondary.roomId ?? null,
        unassignedGroupId: UNASSIGNED_ROOM_GROUP_ID,
      }),
    [
      selectorRoomGroups,
      selectorRoomId,
      targetWall,
      viewedFaceInfo?.roomId,
      wallFaces?.primary.roomId,
      wallFaces?.secondary.roomId,
    ]
  );

  const activeSelectorRoom = useMemo(
    () => selectorRoomGroups.find((g) => g.id === effectiveRoomId) ?? null,
    [effectiveRoomId, selectorRoomGroups]
  );

  const activeRoomWallEntries = useMemo<RoomWallSelectorEntry[]>(
    () =>
      activeSelectorRoom
        ? buildRoomWallSelectorEntries({
            roomWalls: activeSelectorRoom.walls,
            wallFaceMap: activeSelectorRoom.wallFaceMap,
            allWalls: level.walls,
            rooms: level.rooms,
          })
        : [],
    [activeSelectorRoom, level.rooms, level.walls]
  );

  const selectRoomWall = useCallback(
    (wallId: string) => {
      if (activeSelectorRoom) {
        setSelectorRoomId(activeSelectorRoom.id);
        const insideFace = activeSelectorRoom.wallFaceMap.get(wallId);
        if (insideFace) {
          setFaceSide(insideFace);
        }
      }
      onSelect([{ kind: 'wall', id: wallId }]);
    },
    [activeSelectorRoom, onSelect]
  );

  emptySelectorCanGoBackRef.current = Boolean(
    (!targetWall || !wallMetrics) && activeSelectorRoom !== null
  );

  if (!targetWall || !wallMetrics) {
    return (
      <div
        ref={containerRef}
        data-testid="wall-cutthrough-select-wall"
        className={`w-full h-full flex flex-col select-none overflow-hidden ${
          isBw ? 'bg-white text-slate-900' : 'bg-slate-50 dark:bg-slate-950'
        }`}
      >
        <div className="shrink-0 px-4 py-2.5 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
          {!activeSelectorRoom ? (
            <>
              <div className="flex items-center gap-2">
                <MousePointerClick className="w-4 h-4 text-blue-600" />
                <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Select room
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  Choose a room first to filter its walls in Wall View
                </span>
              </div>
              <span className="text-[11px] font-mono-nums text-slate-400">
                {selectorRoomGroups.length} {selectorRoomGroups.length === 1 ? 'room' : 'rooms'}
              </span>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 min-w-0">
                <button
                  type="button"
                  data-testid="wallview-change-room-btn"
                  onClick={() => setSelectorRoomId(null)}
                  className="h-7 px-2 text-xs font-medium rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-1 cursor-pointer shrink-0 text-slate-700 dark:text-slate-200"
                >
                  <ArrowLeft className="w-3.5 h-3.5 text-blue-600" />
                  <span>Change Room</span>
                </button>
                <MousePointerClick className="w-4 h-4 text-blue-600 shrink-0" />
                <span className="text-sm font-semibold text-slate-900 dark:text-slate-100 shrink-0">
                  Select wall
                </span>
                <span className="px-2 py-0.5 text-xs font-medium rounded bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 truncate">
                  {activeSelectorRoom.name}
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400 hidden sm:inline truncate">
                  Click any highlighted wall or press Esc for rooms
                </span>
              </div>
              <span className="text-[11px] font-mono-nums text-slate-400 shrink-0">
                {activeRoomWallEntries.length}{' '}
                {activeRoomWallEntries.length === 1 ? 'wall' : 'walls'}
              </span>
            </>
          )}
        </div>

        {visibleWallsList.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center text-slate-500">
            <Layers className="w-10 h-10 mb-3 opacity-35" />
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200">
              Select room
            </h3>
            <p className="text-xs max-w-sm mt-1">
              Draw a wall in 2D Plan first, then select a room and wall to inspect its architectural Wall View.
            </p>
          </div>
        ) : !activeSelectorRoom ? (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="shrink-0 px-4 py-2 bg-white/80 dark:bg-slate-900/70 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center gap-2">
              {selectorRoomGroups.map((room) => (
                <button
                  key={room.id}
                  type="button"
                  data-testid={`wallview-room-card-${room.id}`}
                  onClick={() => setSelectorRoomId(room.id)}
                  className="px-3 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-blue-500 hover:bg-blue-50/70 dark:hover:bg-blue-950/40 text-left flex items-center gap-2 cursor-pointer transition-colors"
                >
                  <span
                    className="w-2.5 h-2.5 rounded-sm shrink-0 border border-black/15"
                    style={{ backgroundColor: room.color }}
                  />
                  <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">
                    {room.name}
                  </span>
                  <span className="text-[11px] font-mono-nums text-slate-500 dark:text-slate-400">
                    {room.entryCount} {room.entryCount === 1 ? 'wall' : 'walls'}
                    {room.areaSqM !== null ? ` · ${room.areaSqM.toFixed(1)} m²` : ''}
                  </span>
                </button>
              ))}
            </div>
            <div className="flex-1 min-h-0">
              <RoomMiniSelectorMap
                walls={visibleWallsList}
                rooms={selectorRoomGroups}
                onSelectRoom={(roomId) => setSelectorRoomId(roomId)}
              />
            </div>
          </div>
        ) : (
          <div className="flex-1 min-h-0">
            <WallMiniSelectorMap
              entries={activeRoomWallEntries}
              polygonContextWalls={visibleWallsList}
              activeWallId={null}
              onSelectWall={selectRoomWall}
            />
          </div>
        )}
      </div>
    );
  }

  const faceColor = viewedSlot === 'inner' ? targetWall.innerColor : targetWall.outerColor;
  const faceMat = viewedSlot === 'inner' ? targetWall.innerMaterial : targetWall.outerMaterial;
  const wallSelected = selection.some((s) => s.kind === 'wall' && s.id === targetWall.id);

  const cxWorld = wallMetrics.lenMm / 2;
  const cyWorld = -wallMetrics.heightMm / 2;
  const worldToScreen = `translate(${size.width / 2 + panOffsetPx.x}, ${
    size.height / 2 + panOffsetPx.y
  }) scale(${pxPerMm}) translate(${-cxWorld}, ${-cyWorld})`;

  const cutThicknessLeft = wallMetrics.hasStartCap ? 180 : 120;
  const cutThicknessRight = wallMetrics.hasEndCap ? 180 : 120;
  const leftCapW = isLeftView ? cutThicknessLeft : cutThicknessRight;
  const rightCapW = isLeftView ? cutThicknessRight : cutThicknessLeft;

  const isSelected = (kind: SelectionTarget['kind'], id: string) =>
    selection.some((s) => s.kind === kind && s.id === id);

  // Dimension appearance helper aligned with 2D plan
  const renderElevDim = (opts: {
    dimKey: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    ext1x?: number;
    ext1y?: number;
    ext2x?: number;
    ext2y?: number;
    valueMm: number;
    locked: boolean;
    vertical?: boolean;
    hoverId?: string;
    subtle?: boolean;
    prefix?: string;
    labelOffsetPerpMm?: number;
    onEdit?: () => void;
  }) => {
    const span = Math.hypot(opts.x2 - opts.x1, opts.y2 - opts.y1);
    if (span < 1) return null;
    const midX = (opts.x1 + opts.x2) / 2;
    const midY = (opts.y1 + opts.y2) / 2;
    const ux = (opts.x2 - opts.x1) / span;
    const uy = (opts.y2 - opts.y1) / span;
    const nx = -uy;
    const ny = ux;
    const isHov = hoveredDimKey === opts.dimKey || (opts.hoverId && hoveredCompId === opts.hoverId);
    const lineColor = isBw
      ? opts.locked || opts.subtle
        ? '#64748B'
        : isHov
          ? '#0F172A'
          : '#334155'
      : opts.locked
        ? '#94A3B8'
        : isHov
          ? settings.darkMode
            ? '#38BDF8'
            : '#1D4ED8'
          : opts.subtle
            ? settings.darkMode
              ? '#94A3B8'
              : '#64748B'
            : settings.darkMode
              ? '#CBD5E1'
              : '#0EA5E9';
    const textColor = isBw
      ? opts.locked || opts.subtle
        ? '#475569'
        : '#0F172A'
      : opts.locked
        ? '#94A3B8'
        : isHov
          ? settings.darkMode
            ? '#7DD3FC'
            : '#1D4ED8'
          : opts.subtle
            ? settings.darkMode
              ? '#CBD5E1'
              : '#475569'
            : settings.darkMode
              ? '#F1F5F9'
              : '#0369A1';
    const bgColor = isBw ? '#FFFFFF' : settings.darkMode ? '#020617' : '#F1F5F9';
    const sw = (isHov ? 1.45 : opts.subtle ? 0.78 : 1.0) / pxPerMm;
    const tickHalf = (opts.subtle ? 3.5 : 4.2) / pxPerMm;
    const arrowLen = Math.min(span * 0.2, (opts.subtle ? 4.2 : 5.5) / pxPerMm);
    const arrowHalfW = (opts.subtle ? 1.6 : 2.0) / pxPerMm;
    const formattedVal = formatSmartMetric(opts.valueMm);
    const labelText = opts.prefix ? `${opts.prefix} ${formattedVal}` : formattedVal;
    const fontSizeWorld = opts.subtle
      ? Math.max(68, Math.min(114, 9.8 / pxPerMm))
      : Math.max(75, Math.min(126, 10.8 / pxPerMm));
    const maskW = Math.max(fontSizeWorld * 2.1, labelText.length * fontSizeWorld * 0.62 + 44);
    const maskH = fontSizeWorld * 1.24;
    const labelOff = opts.labelOffsetPerpMm ?? 0;
    const labelX = opts.vertical ? midX + labelOff : midX;
    const labelY = opts.vertical ? midY : midY - labelOff;

    return (
      <g
        key={opts.dimKey}
        className={opts.onEdit && !measureActive ? 'cursor-pointer' : 'pointer-events-none'}
        onPointerEnter={() => {
          setHoveredDimKey(opts.dimKey);
          if (opts.hoverId) setHoveredCompId(opts.hoverId);
        }}
        onPointerLeave={() => {
          setHoveredDimKey((k) => (k === opts.dimKey ? null : k));
          if (opts.hoverId) setHoveredCompId((c) => (c === opts.hoverId ? null : c));
        }}
        onPointerDown={(e) => {
          if (e.button !== 0 || !opts.onEdit) return;
          e.stopPropagation();
          opts.onEdit();
        }}
      >
        {opts.ext1x !== undefined && opts.ext1y !== undefined && (
          <line
            x1={opts.ext1x}
            y1={opts.ext1y}
            x2={opts.x1}
            y2={opts.y1}
            stroke={lineColor}
            strokeOpacity={0.45}
            strokeWidth={0.7 / pxPerMm}
            strokeDasharray={`${4 / pxPerMm} ${3 / pxPerMm}`}
          />
        )}
        {opts.ext2x !== undefined && opts.ext2y !== undefined && (
          <line
            x1={opts.ext2x}
            y1={opts.ext2y}
            x2={opts.x2}
            y2={opts.y2}
            stroke={lineColor}
            strokeOpacity={0.45}
            strokeWidth={0.7 / pxPerMm}
            strokeDasharray={`${4 / pxPerMm} ${3 / pxPerMm}`}
          />
        )}
        <line
          x1={opts.x1}
          y1={opts.y1}
          x2={opts.x2}
          y2={opts.y2}
          stroke={lineColor}
          strokeWidth={sw}
          strokeDasharray={opts.locked ? `${4 / pxPerMm} ${3 / pxPerMm}` : undefined}
        />
        <line
          x1={opts.x1 - nx * tickHalf}
          y1={opts.y1 - ny * tickHalf}
          x2={opts.x1 + nx * tickHalf}
          y2={opts.y1 + ny * tickHalf}
          stroke={lineColor}
          strokeWidth={sw * 1.15}
        />
        <line
          x1={opts.x2 - nx * tickHalf}
          y1={opts.y2 - ny * tickHalf}
          x2={opts.x2 + nx * tickHalf}
          y2={opts.y2 + ny * tickHalf}
          stroke={lineColor}
          strokeWidth={sw * 1.15}
        />
        {arrowLen > 2 / pxPerMm && (
          <>
            <polygon
              points={`${opts.x1},${opts.y1} ${opts.x1 + ux * arrowLen + nx * arrowHalfW},${opts.y1 + uy * arrowLen + ny * arrowHalfW} ${opts.x1 + ux * arrowLen - nx * arrowHalfW},${opts.y1 + uy * arrowLen - ny * arrowHalfW}`}
              fill={lineColor}
            />
            <polygon
              points={`${opts.x2},${opts.y2} ${opts.x2 - ux * arrowLen + nx * arrowHalfW},${opts.y2 - uy * arrowLen + ny * arrowHalfW} ${opts.x2 - ux * arrowLen - nx * arrowHalfW},${opts.y2 - uy * arrowLen - ny * arrowHalfW}`}
              fill={lineColor}
            />
          </>
        )}
        {Math.abs(labelOff) > 1 && (
          <line
            x1={midX}
            y1={midY}
            x2={labelX}
            y2={labelY}
            stroke={lineColor}
            strokeOpacity={0.55}
            strokeWidth={0.65 / pxPerMm}
            strokeDasharray={`${3 / pxPerMm} ${2 / pxPerMm}`}
          />
        )}
        <g transform={`translate(${labelX}, ${labelY}) rotate(${opts.vertical ? -90 : 0})`}>
          <rect
            x={-maskW / 2}
            y={-maskH / 2}
            width={maskW}
            height={maskH}
            rx={maskH * 0.25}
            fill={bgColor}
            fillOpacity={0.95}
            stroke={isHov ? lineColor : 'none'}
            strokeWidth={0.8 / pxPerMm}
          />
          <text
            x={0}
            y={fontSizeWorld * 0.35}
            textAnchor="middle"
            fontSize={fontSizeWorld}
            fontFamily="JetBrains Mono, monospace"
            fontWeight={isHov ? 700 : 600}
            fill={textColor}
          >
            {opts.locked ? `[LOCKED] ${labelText}` : labelText}
          </text>
        </g>
        <line
          x1={opts.x1}
          y1={opts.y1}
          x2={opts.x2}
          y2={opts.y2}
          stroke="transparent"
          strokeWidth={Math.max(160, 18 / pxPerMm)}
        />
      </g>
    );
  };

  const openElevEditor = (
    opts: Omit<NonNullable<typeof editingDim>, 'screenX' | 'screenY' | 'error'> & {
      worldX: number;
      worldY: number;
    }
  ) => {
    const scr = worldToScreenElev(opts.worldX, opts.worldY);
    setEditingDim({
      key: opts.key,
      kind: opts.kind,
      wallId: opts.wallId,
      compId: opts.compId,
      compKind: opts.compKind,
      boundaryMm: opts.boundaryMm,
      label: opts.label,
      valueStr: opts.valueStr,
      screenX: scr.x,
      screenY: scr.y,
      error: null,
    });
  };

  return (
    <div
      ref={containerRef}
      data-testid="wall-cutthrough-viewer"
      className={`relative w-full h-full overflow-hidden flex flex-col select-none ${
        isBw ? 'bg-white text-slate-900' : 'bg-slate-100 dark:bg-slate-950'
      }`}
    >
      {/* Wall View Top Control Bar */}
      <div className="shrink-0 min-h-11 px-3 py-1.5 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs z-10">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5 pr-1">
            <Layers className="w-3.5 h-3.5 text-blue-600" />
            <span>Wall View</span>
          </span>

          <button
            type="button"
            data-testid="wallview-back-rooms-btn"
            onClick={() => {
              setSelectorRoomId(null);
              onSelect([]);
            }}
            title="Return to room selection"
            className="h-7 px-2 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-1 cursor-pointer font-medium text-slate-700 dark:text-slate-200"
          >
            <ArrowLeft className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
            <span>Back to Rooms</span>
          </button>

          <select
            value={
              activeRoomWallEntries.find((entry) => entry.memberWallIds.includes(targetWall.id))
                ?.representativeWallId ?? targetWall.id
            }
            onChange={(e) => selectRoomWall(e.target.value)}
            aria-label="Select wall to inspect"
            className="h-7 px-2 text-xs font-mono-nums bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded cursor-pointer focus:outline-none focus:border-blue-500"
          >
            {activeRoomWallEntries.map((entry, idx) => (
              <option key={entry.id} value={entry.representativeWallId}>
                {entry.isConsolidated
                  ? `Wall ${idx + 1} (Consolidated · ${entry.walls.length} segs) · ${formatSmartMetric(entry.totalLenMm)}`
                  : `Wall ${idx + 1} · ${formatSmartMetric(entry.totalLenMm)} × ${formatSmartMetric(entry.maxHeightMm)}`}
              </option>
            ))}
          </select>

          <button
            type="button"
            data-testid="wallview-change-wall-btn"
            onClick={() => {
              if (activeSelectorRoom) {
                setSelectorRoomId(activeSelectorRoom.id);
              }
              onSelect([]);
            }}
            title="Choose another wall in the active room"
            className="h-7 px-2 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-1 cursor-pointer font-medium"
          >
            <MousePointerClick className="w-3.5 h-3.5 text-blue-600" />
            <span>Change Wall</span>
          </button>

          <div
            role="group"
            aria-label="Wall face view selector"
            className="flex items-center h-7 border border-slate-200 dark:border-slate-700 rounded overflow-hidden"
          >
            <button
              type="button"
              data-testid="wallview-face-primary-btn"
              onClick={() => setFaceSide('inner')}
              title={wallFaces?.primary.subtitle ?? 'Primary Wall Face'}
              className={`h-full px-2 flex items-center gap-1 cursor-pointer font-medium ${
                faceSide === 'inner'
                  ? 'bg-blue-600 text-white'
                  : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300'
              }`}
            >
              <span>{wallFaces?.primary.label ?? 'Inner'}</span>
            </button>
            <button
              type="button"
              data-testid="wallview-face-secondary-btn"
              onClick={() => setFaceSide('outer')}
              title={wallFaces?.secondary.subtitle ?? 'Opposite Wall Face'}
              className={`h-full px-2 border-l border-slate-200 dark:border-slate-700 flex items-center gap-1 cursor-pointer font-medium ${
                faceSide === 'outer'
                  ? 'bg-blue-600 text-white'
                  : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300'
              }`}
            >
              <span>{wallFaces?.secondary.label ?? 'Outer'}</span>
            </button>
          </div>
          {wallMetrics.oppositeSideCount > 0 && (
            <span
              data-testid="wallview-opposite-count"
              title="Items located on the opposite side of this wall are occluded"
              className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-[10px] font-mono-nums"
            >
              {wallMetrics.oppositeSideCount} opposite side hidden
            </span>
          )}
          {wallMetrics.consolidatedRun && (
            <div className="inline-flex items-center gap-1">
              <span
                data-testid="wallview-consolidated-badge"
                title={
                  wallMetrics.consolidatedRun.source === 'auto'
                    ? 'Continuous room wall across inline segments (individual segments remain separate)'
                    : 'Consolidated continuous wall run (individual segments remain separate)'
                }
                className="px-2 py-0.5 rounded bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300 text-[10px] font-semibold inline-flex items-center gap-1"
              >
                <Link2 className="w-3 h-3" />
                <span>
                  {wallMetrics.consolidatedRun.source === 'auto'
                    ? `Room Wall Run (${wallMetrics.consolidatedRun.segments.length})`
                    : `Consolidated (${wallMetrics.consolidatedRun.segments.length})`}
                </span>
              </span>
              <div
                role="group"
                aria-label="Consolidated wall segments"
                data-testid="wallview-segment-switcher"
                className="inline-flex items-center h-6 rounded border border-slate-200 dark:border-slate-700 overflow-hidden bg-slate-50 dark:bg-slate-950"
              >
                {wallMetrics.consolidatedRun.segments.map((seg, idx) => {
                  const isSegActive = seg.wall.id === targetWall.id;
                  return (
                    <button
                      key={seg.wall.id}
                      type="button"
                      data-testid={`wallview-segment-pill-${idx}`}
                      onClick={() => onSelect([{ kind: 'wall', id: seg.wall.id }])}
                      title={`Edit Segment ${idx + 1} properties (${formatSmartMetric(seg.lengthMm)})`}
                      className={`h-full px-1.5 text-[10px] font-mono-nums font-semibold cursor-pointer transition-colors ${
                        idx > 0 ? 'border-l border-slate-200 dark:border-slate-700' : ''
                      } ${
                        isSegActive
                          ? 'bg-blue-600 text-white'
                          : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800'
                      }`}
                    >
                      {`Seg ${idx + 1}`}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          {onUpdateLevel && (
            <button
              type="button"
              onClick={() => setPlacingChimney((v) => !v)}
              title="Click on the exposed wall face to attach a Chimney / Block flush"
              className={`h-7 px-2 rounded border flex items-center gap-1 cursor-pointer font-medium ${
                placingChimney
                  ? 'border-blue-600 bg-blue-600 text-white'
                  : 'border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{placingChimney ? 'Click Wall to Place' : 'Add Chimney'}</span>
            </button>
          )}
          {/* Visibility Selector: Wall Only vs All Furniture in Front + Conditional Depth Effect Toggle */}
          <div
            role="group"
            aria-label="Wall view context object visibility"
            className="flex items-center h-7 border border-slate-200 dark:border-slate-700 rounded overflow-hidden"
          >
            <button
              type="button"
              data-testid="cutthrough-wall-only-btn"
              onClick={() => setShowObjects(false)}
              title="Render only the selected wall and its wall-mounted components"
              className={`h-full px-2 flex items-center gap-1 cursor-pointer font-medium ${
                !showObjects
                  ? 'bg-blue-600 text-white'
                  : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300'
              }`}
            >
              <EyeOff className="w-3.5 h-3.5" />
              <span>Wall Only</span>
            </button>
            <button
              type="button"
              data-testid="cutthrough-context-on-btn"
              onClick={() => setShowObjects(true)}
              title="Show furniture within distance (up to 1.5 m) of the wall, rendering only faces visible from this angle"
              className={`h-full px-2 border-l border-slate-200 dark:border-slate-700 flex items-center gap-1 cursor-pointer font-medium ${
                showObjects
                  ? 'bg-blue-600 text-white'
                  : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300'
              }`}
            >
              <Eye className="w-3.5 h-3.5" />
              <span>+ Furniture</span>
            </button>
          </div>
          {showObjects && (
            <>
              <div
                className="flex items-center h-7 gap-1.5 px-2 rounded border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-800/50"
                title="Maximum distance in front of wall (up to 1.5 m)"
              >
                <input
                  type="range"
                  min={100}
                  max={1500}
                  step={50}
                  value={maxContextRangeMm}
                  onChange={(e) => setMaxContextRangeMm(Math.min(1500, Math.max(100, Number(e.target.value))))}
                  aria-label="Wall view furniture depth range"
                  className="w-16 accent-blue-600 cursor-pointer"
                />
                <span className="text-[11px] font-mono-nums text-slate-600 dark:text-slate-300 whitespace-nowrap">
                  ≤ {(maxContextRangeMm / 1000).toFixed(2).replace(/0$/, '')} m
                </span>
              </div>
              <button
                type="button"
                data-testid="cutthrough-depth-effect-btn"
                onClick={() => setShowDepthEffect((v) => !v)}
                title="Toggle distance-based greying, darkening, and progressive blur"
                className={`h-7 px-2 rounded border flex items-center gap-1 cursor-pointer font-medium ${
                  showDepthEffect
                    ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                    : 'border-slate-200 dark:border-slate-700 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                <Layers className="w-3.5 h-3.5" />
                <span>Depth Effect</span>
              </button>
            </>
          )}
          <button
            type="button"
            data-testid="wallview-measure-btn"
            onClick={() => {
              setPlacingChimney(false);
              setMeasureActive((v) => {
                const next = !v;
                if (!next) {
                  setMeasureDraftStart(null);
                  setMeasureHoverSnap(null);
                }
                return next;
              });
            }}
            title="Measure distance in Wall View (M) · Hold Shift for free measurement"
            className={`h-7 px-2 rounded border flex items-center gap-1 cursor-pointer font-medium ${
              measureActive
                ? 'border-blue-600 bg-blue-600 text-white'
                : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            <Ruler className="w-3.5 h-3.5" />
            <span>Measure</span>
          </button>
          <div ref={dimsMenuRef} className="relative">
            <button
              type="button"
              data-testid="wallview-dims-menu-btn"
              onClick={() => setDimsMenuOpen((o) => !o)}
              aria-expanded={dimsMenuOpen}
              title="Toggle Wall View dimension categories"
              className={`h-7 px-2 rounded border flex items-center gap-1 cursor-pointer font-medium ${
                showRoomWallDims || showWallFurnitureDims
                  ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                  : 'border-slate-200 dark:border-slate-700 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              <Ruler className="w-3.5 h-3.5" />
              <span>Dims</span>
              <ChevronDown className="w-3 h-3 opacity-75" />
            </button>
            {dimsMenuOpen && (
              <div
                data-testid="wallview-dims-popover"
                onPointerDown={(e) => e.stopPropagation()}
                className="absolute right-0 mt-1 w-60 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl p-2 z-50 text-xs"
              >
                <div className="px-1.5 pb-1 mb-1 border-b border-slate-100 dark:border-slate-800 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Wall View Dimensions
                </div>
                <label className="flex items-center gap-2 px-1.5 py-1.5 rounded hover:bg-slate-50 dark:hover:bg-slate-800/70 cursor-pointer select-none text-slate-700 dark:text-slate-200">
                  <input
                    type="checkbox"
                    data-testid="wallview-dim-toggle-room-wall"
                    checked={showRoomWallDims}
                    onChange={(e) => setShowRoomWallDims(e.target.checked)}
                    className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                  />
                  <span>Room and wall dimensions</span>
                </label>
                <label className="flex items-center gap-2 px-1.5 py-1.5 rounded hover:bg-slate-50 dark:hover:bg-slate-800/70 cursor-pointer select-none text-slate-700 dark:text-slate-200">
                  <input
                    type="checkbox"
                    data-testid="wallview-dim-toggle-furniture"
                    checked={showWallFurnitureDims}
                    onChange={(e) => setShowWallFurnitureDims(e.target.checked)}
                    className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                  />
                  <span>Wall-mounted furniture dimensions</span>
                </label>
              </div>
            )}
          </div>
          {onToggleBlackAndWhite && (
            <button
              type="button"
              data-testid="wallview-bw-toggle"
              onClick={onToggleBlackAndWhite}
              title="Toggle print-ready Black & White architectural sheet mode"
              className={`h-7 px-2 rounded border flex items-center gap-1 cursor-pointer font-medium ${
                isBw
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              <Contrast className="w-3.5 h-3.5" />
              <span>B&amp;W</span>
            </button>
          )}

          <div className="flex items-center h-7 border border-slate-200 dark:border-slate-700 rounded overflow-hidden">
            <button
              type="button"
              onClick={() => setZoomScale((z) => Math.max(0.35, +(z * 0.85).toFixed(2)))}
              aria-label="Zoom out elevation"
              className="h-full px-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                setZoomScale(1);
                setPanOffsetPx({ x: 0, y: 0 });
              }}
              aria-label="Fit elevation"
              className="h-full px-1.5 border-x border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setZoomScale((z) => Math.min(4, +(z * 1.15).toFixed(2)))}
              aria-label="Zoom in elevation"
              className="h-full px-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Elevation SVG Stage */}
      <svg
        ref={svgRef}
        data-testid="wall-cutthrough-svg"
        width={size.width}
        height={Math.max(200, size.height - 44)}
        className={`flex-1 block w-full ${
          measureActive || placingChimney
            ? 'cursor-crosshair'
            : elevDrag?.kind === 'pan'
              ? 'cursor-grabbing'
              : spacePressed
                ? 'cursor-grab'
                : elevDrag?.kind === 'comp_edge'
                  ? 'cursor-ew-resize'
                  : elevDrag?.kind === 'comp_v'
                    ? 'cursor-ns-resize'
                    : elevDrag?.kind === 'comp_move'
                      ? 'cursor-move'
                      : 'cursor-grab active:cursor-grabbing'
        }`}
        onPointerDownCapture={(e) => {
          if (e.button === 1 || (spacePressed && e.button === 0)) {
            e.preventDefault();
            e.stopPropagation();
            if (contextMenu) setContextMenu(null);
            panSnapshotRef.current = { ...panOffsetPx };
            setElevDrag({
              kind: 'pan',
              startClientX: e.clientX,
              startClientY: e.clientY,
              origPanX: panOffsetPx.x,
              origPanY: panOffsetPx.y,
            });
            return;
          }
          if (measureActive && e.button === 0 && wallViewSnapGeom) {
            e.preventDefault();
            e.stopPropagation();
            if (contextMenu) setContextMenu(null);
            const wPt = screenToWorldElev(e.clientX, e.clientY);
            const snapped = snapWallViewMeasurementPoint(
              { xMm: wPt.x, zMm: -wPt.y },
              wallViewSnapGeom,
              {
                bypassSnap: e.shiftKey,
                pointTolMm: Math.max(25, 16 / pxPerMm),
                edgeTolMm: Math.max(18, 11 / pxPerMm),
              }
            );
            setMeasureHoverSnap(snapped);
            if (!measureDraftStart) {
              setMeasureResult(null);
              setMeasureDraftStart(snapped.point);
            } else {
              setMeasureResult({ start: measureDraftStart, end: snapped.point });
              setMeasureDraftStart(null);
            }
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const el = (e.target as Element | null)?.closest?.('[data-ctx-kind]');
          const kind = el?.getAttribute('data-ctx-kind') as SelectionTarget['kind'] | undefined;
          const id = el?.getAttribute('data-ctx-id') ?? undefined;
          if (!kind || !id) {
            setContextMenu({
              kind: 'empty',
              clientX: e.clientX,
              clientY: e.clientY,
              canPaste: hasClipboard,
            });
            return;
          }
          const hitTarget: SelectionTarget = { kind, id };
          const alreadyIn = selection.some((s) => s.kind === kind && s.id === id);
          const activeSel = alreadyIn ? selection : [hitTarget];
          if (!alreadyIn) onSelect(activeSel);
          const isLocked = activeSel.every((s) => {
            if (s.kind === 'wall') return Boolean(level.walls.find((w) => w.id === s.id)?.locked);
            if (s.kind === 'opening') return Boolean(level.openings.find((o) => o.id === s.id)?.locked);
            if (s.kind === 'arch') return Boolean(level.archElements.find((a) => a.id === s.id)?.locked);
            if (s.kind === 'furniture') return Boolean(level.furniture.find((f) => f.id === s.id)?.locked);
            return false;
          });
          let canConsolidateWalls = false;
          let canSeparateWalls = false;
          let consolidateIds: string[] | undefined;
          let separateIds: string[] | undefined;
          if (activeSel.length >= 2 && activeSel.every((s) => s.kind === 'wall')) {
            const selWalls = activeSel
              .map((s) => level.walls.find((x) => x.id === s.id))
              .filter((x): x is Wall => Boolean(x));
            const elig = validateWallConsolidationEligibility(selWalls, level.walls);
            if (elig.eligible) {
              canConsolidateWalls = !elig.isConsolidated;
              canSeparateWalls = elig.hasAnyConsolidated;
              consolidateIds = elig.orderedWallIds;
              separateIds = selWalls.map((x) => x.id);
            }
          } else if (activeSel.length === 1 && activeSel[0].kind === 'wall') {
            const hitWall = level.walls.find((x) => x.id === activeSel[0].id);
            if (hitWall?.consolidatedGroupId) {
              const groupPeers = level.walls.filter(
                (x) => x.visible !== false && x.consolidatedGroupId === hitWall.consolidatedGroupId
              );
              if (
                groupPeers.length >= 2 &&
                validateWallConsolidationEligibility(groupPeers, level.walls).eligible
              ) {
                canSeparateWalls = true;
                separateIds = groupPeers.map((x) => x.id);
              }
            }
          }
          ctxMetaRef.current = { nextLock: !isLocked, consolidateIds, separateIds };
          setContextMenu({
            kind: 'object',
            clientX: e.clientX,
            clientY: e.clientY,
            isLocked,
            canDuplicate: activeSel.some(
              (s) => s.kind === 'wall' || s.kind === 'arch' || s.kind === 'furniture'
            ),
            canMirror: activeSel.some((s) => s.kind === 'opening' || s.kind === 'arch'),
            canRotate: activeSel.some((s) => s.kind === 'wall' || s.kind === 'arch'),
            canSelectAbove: false,
            canSelectBelow: false,
            canConsolidateWalls,
            canSeparateWalls,
          });
        }}
        onPointerDown={(e) => {
          if (contextMenu) setContextMenu(null);
          if (placingChimney && e.button === 0) {
            e.stopPropagation();
            handlePlaceChimneyOnWall(e.clientX, e.clientY);
            return;
          }
          if (e.button === 0 || e.button === 1) {
            panSnapshotRef.current = { ...panOffsetPx };
            setElevDrag({
              kind: 'pan',
              startClientX: e.clientX,
              startClientY: e.clientY,
              origPanX: panOffsetPx.x,
              origPanY: panOffsetPx.y,
            });
          }
        }}
        onPointerMove={(e) => {
          if (measureActive && !elevDrag && wallViewSnapGeom) {
            const wPt = screenToWorldElev(e.clientX, e.clientY);
            const snapped = snapWallViewMeasurementPoint(
              { xMm: wPt.x, zMm: -wPt.y },
              wallViewSnapGeom,
              {
                bypassSnap: e.shiftKey,
                pointTolMm: Math.max(25, 16 / pxPerMm),
                edgeTolMm: Math.max(18, 11 / pxPerMm),
              }
            );
            setMeasureHoverSnap(snapped);
            return;
          }
          if (!elevDrag) return;
          if (elevDrag.kind === 'pan') {
            setPanOffsetPx({
              x: elevDrag.origPanX + (e.clientX - elevDrag.startClientX),
              y: elevDrag.origPanY + (e.clientY - elevDrag.startClientY),
            });
            return;
          }

          if (!onUpdateLevel) return;
          if (
            !elevDragMutatedRef.current &&
            Math.hypot(e.clientX - elevDrag.startClientX, e.clientY - elevDrag.startClientY) < 4
          ) {
            return;
          }
          setCursorClientPos({ x: e.clientX, y: e.clientY });
          const wPt = screenToWorldElev(e.clientX, e.clientY);
          const snapEnabled = settings.snapEnabled && !e.shiftKey;

          if (elevDrag.kind === 'comp_move') {
            const deltaX = wPt.x - screenToWorldElev(elevDrag.startClientX, elevDrag.startClientY).x;
            const deltaS = isLeftView ? deltaX : -deltaX;
            const proposedCenterS = elevDrag.origCenterS + deltaS;
            const chimEl =
              elevDrag.compKind === 'chimney'
                ? level.archElements.find((a) => a.id === elevDrag.compId)
                : undefined;
            const opEl =
              elevDrag.compKind === 'opening'
                ? level.openings.find((o) => o.id === elevDrag.compId)
                : undefined;
            const hostWall =
              (opEl ? level.walls.find((w) => w.id === opEl.wallId) : undefined) ??
              (chimEl?.attachedWallId
                ? level.walls.find((w) => w.id === chimEl.attachedWallId)
                : undefined) ??
              targetWall;
            if (hostWall.locked) {
              setCursorHint({ text: 'Wall is locked', tone: 'clash' });
              return;
            }
            const hostSeg = wallMetrics.consolidatedRun?.segments.find(
              (s) => s.wall.id === hostWall.id
            );
            const proposedHostS = hostSeg
              ? hostSeg.sameDir
                ? proposedCenterS - hostSeg.startRunS
                : hostSeg.endRunS - proposedCenterS
              : proposedCenterS;
            const bounds = chimEl
              ? (() => {
                  const fb = computeChimneyFaceBounds(
                    hostWall,
                    level.walls,
                    chimEl.attachedFace ?? 'left',
                    chimEl.depthMm,
                    proposedHostS
                  );
                  return {
                    lengthMm: fb.lengthMm,
                    innerStartS: fb.minS,
                    innerEndS: fb.maxS,
                    leftStartS: fb.minS,
                    leftEndS: fb.maxS,
                    rightStartS: fb.minS,
                    rightEndS: fb.maxS,
                  };
                })()
              : computeWallInnerBounds(hostWall, level.walls);
            const comps = getWallMountedComponents(hostWall, level.openings, level.archElements);
            const curComp = comps.find((c) => c.id === elevDrag.compId);
            const solved = solveWallComponentDrag(
              comps,
              bounds,
              elevDrag.compId,
              proposedHostS,
              snapEnabled,
              zoomSnapTols.furnFlushTolMm,
              snapHysteresisRef.current.wallComponentKey
            );

            if (chimEl) {
              const checkXf = computeAttachedChimneyTransform(
                hostWall,
                solved.t,
                chimEl.depthMm,
                chimEl.attachedFace ?? 'left'
              );
              if (
                doesChimneyOverlapWalls(
                  checkXf.xMm,
                  checkXf.yMm,
                  chimEl.widthMm,
                  chimEl.depthMm,
                  checkXf.rotationDeg,
                  level.walls,
                  6
                )
              ) {
                return;
              }
            }

            // Vertical drag for windows/arches with zoom-aware snap hysteresis
            const deltaY = -(wPt.y - screenToWorldElev(elevDrag.startClientX, elevDrag.startClientY).y);
            const step = snapEnabled ? 50 : 10;
            let nextSill = opEl ? opEl.sillHeightMm : chimEl?.elevationMm ?? elevDrag.origSillMm;
            let sillSnapKey: string | undefined;
            if (opEl && opEl.category !== 'door' && Math.abs(deltaY) > 15) {
              const rawSill = elevDrag.origSillMm + deltaY;
              const maxSill = Math.max(0, hostWall.heightMm - opEl.heightMm);
              if (snapEnabled) {
                const sillCands = [
                  { key: 'floor', dist: Math.abs(rawSill), data: 0 },
                  { key: 'top_flush', dist: Math.abs(maxSill - rawSill), data: maxSill },
                ];
                const pickedSill = pickWithSnapHysteresis(
                  sillCands,
                  snapHysteresisRef.current.sillStepKey,
                  zoomSnapTols.alignTolMm
                );
                sillSnapKey = pickedSill?.key;
                if (pickedSill) {
                  nextSill = pickedSill.data;
                } else {
                  nextSill = Math.max(0, Math.min(maxSill, Math.round(rawSill / step) * step));
                }
              } else {
                nextSill = Math.max(0, Math.min(maxSill, Math.round(rawSill / step) * step));
              }
            }

            snapHysteresisRef.current = {
              ...snapHysteresisRef.current,
              wallComponentKey: solved.snapKey,
              sillStepKey: sillSnapKey,
            };

            const curRunS = curComp
              ? hostSeg
                ? hostSeg.sameDir
                  ? hostSeg.startRunS + curComp.centerS
                  : hostSeg.endRunS - curComp.centerS
                : curComp.centerS
              : elevDrag.origCenterS;
            const solvedRunS = hostSeg
              ? hostSeg.sameDir
                ? hostSeg.startRunS + solved.centerS
                : hostSeg.endRunS - solved.centerS
              : solved.centerS;
            const prevX = mapX(curRunS);
            const prevY = -(opEl ? opEl.sillHeightMm : chimEl?.elevationMm ?? elevDrag.origSillMm);
            const nextX = mapX(solvedRunS);
            const nextY = -nextSill;
            const tweenSnapKey = [solved.snapKey, sillSnapKey].filter(Boolean).join('|') || undefined;

            triggerSnapTween(
              `${elevDrag.compKind}:${elevDrag.compId}`,
              { x: prevX, y: prevY },
              { x: nextX, y: nextY },
              tweenSnapKey,
              zoomSnapTols.furnFlushTolMm * 1.6
            );

            elevDragMutatedRef.current = true;
            setCursorHint(
              resolveSingleDragHint({
                attachedToWall: true,
                snapLabel:
                  solved.snappedTo ??
                  (sillSnapKey === 'floor'
                    ? 'Floor sill'
                    : sillSnapKey === 'top_flush'
                      ? 'Ceiling flush'
                      : undefined),
              })
            );

            onUpdateLevel(
              (lvl) => {
                if (elevDrag.compKind === 'opening') {
                  return {
                    ...lvl,
                    openings: lvl.openings.map((o) => {
                      if (o.id !== elevDrag.compId || o.locked) return o;
                      return { ...o, t: solved.t, sillHeightMm: nextSill };
                    }),
                  };
                }
                const hw = lvl.walls.find((w) => w.id === hostWall.id);
                return {
                  ...lvl,
                  archElements: lvl.archElements.map((a) => {
                    if (a.id !== elevDrag.compId || a.locked || !hw) return a;
                    const xf = computeAttachedChimneyTransform(
                      hw,
                      solved.t,
                      a.depthMm,
                      a.attachedFace ?? 'left'
                    );
                    const pin = getChimneyCornerPin(
                      hw,
                      lvl.walls,
                      solved.t,
                      a.widthMm,
                      a.depthMm,
                      a.attachedFace ?? 'left'
                    );
                    return {
                      ...a,
                      attachedT: solved.t,
                      xMm: xf.xMm,
                      yMm: xf.yMm,
                      rotationDeg: xf.rotationDeg,
                      resizeAnchor: pin ?? a.resizeAnchor,
                    };
                  }),
                };
              },
              false,
              false
            );
            return;
          }

          if (elevDrag.kind === 'comp_edge' && wallChain) {
            let sWorld = isLeftView ? wPt.x : wallMetrics.lenMm - wPt.x;
            const target = wallChain.components.find((c) => c.id === elevDrag.compId);
            const chimEl =
              elevDrag.compKind === 'chimney'
                ? level.archElements.find((a) => a.id === elevDrag.compId)
                : undefined;
            const opEl = !chimEl
              ? level.openings.find((o) => o.id === elevDrag.compId)
              : undefined;
            const hostWall =
              (opEl ? level.walls.find((w) => w.id === opEl.wallId) : undefined) ??
              (chimEl?.attachedWallId
                ? level.walls.find((w) => w.id === chimEl.attachedWallId)
                : undefined) ??
              targetWall;
            if (!target || target.locked || hostWall.locked) return;

            let edgeSnapLabel: string | undefined;
            if (snapEnabled) {
              const snapCands = [
                {
                  key: 'inner_start',
                  dist: Math.abs(wallChain.bounds.innerStartS - sWorld),
                  data: wallChain.bounds.innerStartS,
                },
                {
                  key: 'inner_end',
                  dist: Math.abs(wallChain.bounds.innerEndS - sWorld),
                  data: wallChain.bounds.innerEndS,
                },
                ...wallChain.components
                  .filter((c) => c.id !== target.id)
                  .flatMap((c) => [
                    { key: `comp_${c.id}_l`, dist: Math.abs(c.leftS - sWorld), data: c.leftS },
                    { key: `comp_${c.id}_r`, dist: Math.abs(c.rightS - sWorld), data: c.rightS },
                  ]),
              ];
              const picked = pickWithSnapHysteresis(
                snapCands,
                snapHysteresisRef.current.edgeSKey,
                zoomSnapTols.furnFlushTolMm
              );
              snapHysteresisRef.current = {
                ...snapHysteresisRef.current,
                edgeSKey: picked?.key,
              };
              if (picked) {
                sWorld = picked.data;
                edgeSnapLabel = 'Aligned edge';
              } else {
                const step = Math.max(10, Math.min(50, settings.gridSizeMm));
                sWorld = Math.round(sWorld / step) * step;
              }
            } else {
              snapHysteresisRef.current = {};
            }

            const hostSeg = wallMetrics.consolidatedRun?.segments.find(
              (s) => s.wall.id === hostWall.id
            );
            const segSameDir = hostSeg ? hostSeg.sameDir : true;
            const hostSWorld = hostSeg
              ? segSameDir
                ? sWorld - hostSeg.startRunS
                : hostSeg.endRunS - sWorld
              : sWorld;
            const hostChain =
              hostWall.id === targetWall.id && !wallMetrics.consolidatedRun
                ? wallChain
                : buildWallDimensionChain(hostWall, level.walls, level.openings, level.archElements);
            const hostTarget = hostChain.components.find((c) => c.id === elevDrag.compId) ?? target;

            // Map visual left/right edge to host architectural S edge
            const visualIsLeftS = isLeftView
              ? elevDrag.visualEdge === 'left'
              : elevDrag.visualEdge === 'right';
            const archDragSide: 'left' | 'right' =
              visualIsLeftS === segSameDir ? 'left' : 'right';
            const rawWidthMm =
              archDragSide === 'left'
                ? Math.round(hostTarget.rightS - hostSWorld)
                : Math.round(hostSWorld - hostTarget.leftS);
            const anchor = archDragSide === 'left' ? 'right' : 'left';
            const minW = elevDrag.compKind === 'chimney' ? 50 : 150;

            const solved = chimEl
              ? solveChimneyResize(
                  hostWall,
                  level.walls,
                  level.openings,
                  level.archElements,
                  elevDrag.compId,
                  Math.max(minW, rawWidthMm),
                  chimEl.depthMm,
                  anchor
                )
              : solveWallComponentResize(
                  hostWall,
                  hostChain.components,
                  hostChain.bounds,
                  elevDrag.compId,
                  Math.max(minW, rawWidthMm),
                  anchor
                );
            if (!solved.ok) {
              setCursorHint({ text: solved.error ?? 'Constraint limit', tone: 'clash' });
              onConstraintError?.(solved.error ?? 'Constraint limit');
              return;
            }
            const nextTgt = solved.updates.find((u) => u.id === elevDrag.compId);
            setCursorHint(
              resolveSingleDragHint({
                snapLabel:
                  edgeSnapLabel ?? `Width ${formatSmartMetric(nextTgt?.widthMm ?? target.widthMm)}`,
              })
            );
            elevDragMutatedRef.current = true;
            const updateMap = new Map(solved.updates.map((u) => [u.id, u]));
            onUpdateLevel(
              (lvl) => ({
                ...lvl,
                openings: lvl.openings.map((o) => {
                  const u = updateMap.get(o.id);
                  return u && u.kind === 'opening' ? { ...o, t: u.t, widthMm: u.widthMm } : o;
                }),
                archElements: lvl.archElements.map((a) => {
                  const u = updateMap.get(a.id);
                  if (!u || u.kind !== 'chimney') return a;
                  const xf = computeAttachedChimneyTransform(
                    hostWall,
                    u.t,
                    a.depthMm,
                    a.attachedFace ?? 'left'
                  );
                  const pin = getChimneyCornerPin(
                    hostWall,
                    lvl.walls,
                    u.t,
                    u.widthMm,
                    a.depthMm,
                    a.attachedFace ?? 'left'
                  );
                  return {
                    ...a,
                    widthMm: u.widthMm,
                    attachedT: u.t,
                    xMm: xf.xMm,
                    yMm: xf.yMm,
                    rotationDeg: xf.rotationDeg,
                    resizeAnchor: pin ?? a.resizeAnchor,
                  };
                }),
              }),
              false,
              false
            );
            return;
          }

          if (elevDrag.kind === 'comp_v') {
            const chimEl =
              elevDrag.compKind === 'chimney'
                ? level.archElements.find((a) => a.id === elevDrag.compId)
                : undefined;
            const opEl = !chimEl
              ? level.openings.find((o) => o.id === elevDrag.compId)
              : undefined;
            const hostWall =
              (opEl ? level.walls.find((w) => w.id === opEl.wallId) : undefined) ??
              (chimEl?.attachedWallId
                ? level.walls.find((w) => w.id === chimEl.attachedWallId)
                : undefined) ??
              targetWall;
            const rawHeightAboveFloor = -wPt.y;
            const step = snapEnabled ? 50 : 10;
            const origTop = elevDrag.origSillMm + elevDrag.origHeightMm;

            let targetEdgeMm = Math.round(rawHeightAboveFloor / step) * step;
            let vSnapKey: string | undefined;
            let vSnapLabel: string | undefined;
            if (snapEnabled) {
              const vCands = [
                { key: 'floor', dist: Math.abs(rawHeightAboveFloor), data: 0 },
                {
                  key: 'ceiling',
                  dist: Math.abs(hostWall.heightMm - rawHeightAboveFloor),
                  data: hostWall.heightMm,
                },
                ...wallMetrics.wallOpenings
                  .filter(({ op }) => op.id !== elevDrag.compId)
                  .flatMap(({ op }) => [
                    {
                      key: `op_sill_${op.id}`,
                      dist: Math.abs(op.sillHeightMm - rawHeightAboveFloor),
                      data: op.sillHeightMm,
                    },
                    {
                      key: `op_head_${op.id}`,
                      dist: Math.abs(op.sillHeightMm + op.heightMm - rawHeightAboveFloor),
                      data: op.sillHeightMm + op.heightMm,
                    },
                  ]),
              ];
              const vPicked = pickWithSnapHysteresis(
                vCands,
                snapHysteresisRef.current.sillStepKey,
                zoomSnapTols.alignTolMm
              );
              if (vPicked) {
                targetEdgeMm = vPicked.data;
                vSnapKey = vPicked.key;
                vSnapLabel =
                  vPicked.key === 'floor'
                    ? 'Floor flush'
                    : vPicked.key === 'ceiling'
                      ? 'Ceiling flush'
                      : 'Aligned height';
              }
            }
            snapHysteresisRef.current = {
              ...snapHysteresisRef.current,
              sillStepKey: vSnapKey,
            };

            let nextSill = elevDrag.origSillMm;
            let nextH = elevDrag.origHeightMm;
            if (elevDrag.handle === 'top') {
              const clampedTop = Math.max(
                elevDrag.origSillMm + 200,
                Math.min(hostWall.heightMm, targetEdgeMm)
              );
              nextH = clampedTop - elevDrag.origSillMm;
            } else {
              const clampedSill = Math.max(0, Math.min(origTop - 200, targetEdgeMm));
              nextSill = clampedSill;
              nextH = origTop - clampedSill;
            }
            const curSill =
              elevDrag.compKind === 'opening'
                ? level.openings.find((o) => o.id === elevDrag.compId)?.sillHeightMm ?? elevDrag.origSillMm
                : level.archElements.find((a) => a.id === elevDrag.compId)?.elevationMm ?? elevDrag.origSillMm;
            triggerSnapTween(
              `${elevDrag.compKind}:${elevDrag.compId}`,
              { x: 0, y: -curSill },
              { x: 0, y: -nextSill },
              vSnapKey,
              zoomSnapTols.alignTolMm * 1.6
            );
            setCursorHint(
              resolveSingleDragHint({
                snapLabel: vSnapLabel ?? `Height ${formatSmartMetric(nextH)}`,
              })
            );
            elevDragMutatedRef.current = true;
            onUpdateLevel(
              (lvl) => {
                if (elevDrag.compKind === 'opening') {
                  return {
                    ...lvl,
                    openings: lvl.openings.map((o) =>
                      o.id === elevDrag.compId && !o.locked
                        ? { ...o, heightMm: nextH, sillHeightMm: nextSill }
                        : o
                    ),
                  };
                }
                return {
                  ...lvl,
                  archElements: lvl.archElements.map((a) =>
                    a.id === elevDrag.compId && !a.locked
                      ? {
                          ...a,
                          heightMm: nextH,
                          elevationMm: nextSill,
                          connectToCeiling: nextSill + nextH >= hostWall.heightMm - 5,
                        }
                      : a
                  ),
                };
              },
              false,
              false
            );
            return;
          }

          if (elevDrag.kind === 'furn_move' && wallElevFurnitureMeta) {
            const leaderOrig = elevDrag.origItemsMap.get(elevDrag.furnId);
            if (!leaderOrig) return;
            const leaderItem = level.furniture.find((f) => f.id === elevDrag.furnId);
            if (!leaderItem || leaderItem.locked) return;
            const runWallIds = wallMetrics.consolidatedRun?.wallIds;
            const leaderHost =
              leaderItem.attachedWallId &&
              (leaderItem.attachedWallId === targetWall.id ||
                runWallIds?.has(leaderItem.attachedWallId))
                ? level.walls.find((w) => w.id === leaderItem.attachedWallId)
                : undefined;
            if (leaderHost?.locked) {
              setCursorHint({ text: 'Wall is locked', tone: 'clash' });
              return;
            }

            const startWPt = screenToWorldElev(elevDrag.startClientX, elevDrag.startClientY);
            const proposedCenterX = elevDrag.origCenterX + (wPt.x - startWPt.x);
            const proposedZBottom = elevDrag.origZBottom - (wPt.y - startWPt.y);
            const prevSettled = furnPrevSettledRef.current ?? {
              centerX: elevDrag.origCenterX,
              zBottom: elevDrag.origZBottom,
            };

            const groupIds = new Set(elevDrag.origItemsMap.keys());
            const obstacles = wallElevFurnitureMeta.furnRects.filter((r) => !groupIds.has(r.id));
            const groupSpans = Array.from(elevDrag.origItemsMap.values()).map((gi) => ({
              relLeft: gi.origCenterX - gi.elevW / 2 - elevDrag.origCenterX,
              relRight: gi.origCenterX + gi.elevW / 2 - elevDrag.origCenterX,
              relBottom: gi.origZBottom - elevDrag.origZBottom,
              relTop: gi.origZBottom + gi.elevH - elevDrag.origZBottom,
            }));

            const leaderOrigRect: WallViewElevRect = {
              id: leaderOrig.id,
              name: leaderItem.name,
              leftX: leaderOrig.origCenterX - leaderOrig.elevW / 2,
              rightX: leaderOrig.origCenterX + leaderOrig.elevW / 2,
              zBottom: leaderOrig.origZBottom,
              zTop: leaderOrig.origZBottom + leaderOrig.elevH,
              centerX: leaderOrig.origCenterX,
              elevW: leaderOrig.elevW,
              elevH: leaderOrig.elevH,
            };

            const solved = solveWallViewFurnitureDrag(
              leaderOrigRect,
              proposedCenterX,
              proposedZBottom,
              prevSettled,
              obstacles,
              wallElevFurnitureMeta.wallEdgeObstacles,
              wallElevFurnitureMeta.dragBounds,
              {
                snapEnabled,
                allowOverlap: e.shiftKey,
                gridSizeMm: settings.gridSizeMm,
                horizTolMm: zoomSnapTols.furnFlushTolMm,
                vertTolMm: zoomSnapTols.alignTolMm,
                hysteresis: snapHysteresisRef.current,
                groupSpans,
              }
            );

            snapHysteresisRef.current = solved.hysteresis;
            furnPrevSettledRef.current = {
              centerX: solved.centerX,
              zBottom: solved.zBottom,
            };

            const curRect = wallElevFurnitureMeta.furnRectById.get(elevDrag.furnId);
            const isGroup = groupIds.size > 1;
            triggerSnapTween(
              isGroup ? 'furniture_group' : `furniture:${elevDrag.furnId}`,
              {
                x: curRect?.centerX ?? prevSettled.centerX,
                y: -(curRect?.zBottom ?? prevSettled.zBottom),
              },
              { x: solved.centerX, y: -solved.zBottom },
              solved.snapKey,
              zoomSnapTols.furnFlushTolMm * 1.6
            );

            elevDragMutatedRef.current = true;
            const anyWallMounted = Array.from(groupIds).some((gid) => {
              const gf = level.furniture.find((x) => x.id === gid);
              return (
                gf?.attachedWallId === targetWall.id ||
                Boolean(gf?.attachedWallId && runWallIds?.has(gf.attachedWallId))
              );
            });
            setCursorHint(
              resolveSingleDragHint({
                attachedToWall: anyWallMounted && !solved.snapLabel && !e.shiftKey,
                snapLabel: solved.snapLabel,
                freeOverlap: e.shiftKey,
              })
            );

            const deltaS = isLeftView ? solved.deltaX : -solved.deltaX;
            const deltaZ = solved.deltaZ;
            onUpdateLevel(
              (lvl) => ({
                ...lvl,
                furniture: applyWallViewFurnitureGroupDelta(
                  lvl.furniture,
                  groupIds,
                  wallMetrics.viewWall,
                  viewedPhysicalSide,
                  deltaS,
                  deltaZ,
                  elevDrag.origItemsMap
                ),
              }),
              false,
              false
            );
          }
        }}
        onPointerUp={(e) => {
          if (elevDrag?.kind === 'pan' && elevDrag.selectWallOnClick) {
            const movedPx = Math.hypot(
              e.clientX - elevDrag.startClientX,
              e.clientY - elevDrag.startClientY
            );
            if (movedPx < 4) {
              onSelect([{ kind: 'wall', id: elevDrag.selectWallIdOnClick ?? targetWall.id }]);
            }
          } else if (elevDrag?.kind === 'furn_move' && !elevDragMutatedRef.current) {
            if (elevDrag.ctrlToggleOnClick) {
              onSelect(selection.filter((s) => !(s.kind === 'furniture' && s.id === elevDrag.furnId)));
            } else if (selection.length > 1) {
              onSelect([{ kind: 'furniture', id: elevDrag.furnId }]);
            }
          }
          if (elevDrag && 'label' in elevDrag && elevDragMutatedRef.current) {
            onCommitDrag?.(elevDrag.label);
          }
          elevDragMutatedRef.current = false;
          furnPrevSettledRef.current = null;
          panSnapshotRef.current = null;
          snapHysteresisRef.current = {};
          setCursorHint(null);
          setCursorClientPos(null);
          setElevDrag(null);
        }}
        onPointerLeave={() => {
          setMeasureHoverSnap(null);
        }}
        onPointerCancel={() => {
          if (elevDrag && 'label' in elevDrag && elevDragMutatedRef.current) {
            onCancelDrag?.();
          }
          elevDragMutatedRef.current = false;
          furnPrevSettledRef.current = null;
          panSnapshotRef.current = null;
          snapHysteresisRef.current = {};
          clearSnapTween();
          setCursorHint(null);
          setCursorClientPos(null);
          setElevDrag(null);
        }}
      >
        <defs>
          <pattern id="cut_hatch" width="80" height="80" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="80" height="80" fill={isBw ? '#FFFFFF' : settings.darkMode ? '#1E293B' : '#E2E8F0'} />
            <line x1="0" y1="0" x2="0" y2="80" stroke={isBw ? '#334155' : settings.darkMode ? '#475569' : '#94A3B8'} strokeWidth={isBw ? '12' : '14'} />
          </pattern>
          <pattern id="elev_tile" width="300" height="300" patternUnits="userSpaceOnUse">
            <path d="M300 0 L0 0 0 300" stroke="rgba(15,23,42,0.16)" strokeWidth="6" fill="none" />
          </pattern>
          <pattern id="elev_brick" width="240" height="120" patternUnits="userSpaceOnUse">
            <path d="M0 0 H240 M0 60 H240 M0 0 V60 M120 0 V60 M60 60 V120 M180 60 V120" stroke="rgba(15,23,42,0.20)" strokeWidth="5" fill="none" />
          </pattern>
          <pattern id="elev_wood" width="220" height="480" patternUnits="userSpaceOnUse">
            <path d="M0 0 V480 M110 0 V480 M0 240 H110 M110 120 H220" stroke="rgba(15,23,42,0.16)" strokeWidth="5" fill="none" />
          </pattern>
          <pattern id="elev_panel" width="160" height="300" patternUnits="userSpaceOnUse">
            <path d="M0 0 V300 M80 0 V300" stroke="rgba(15,23,42,0.18)" strokeWidth="6" fill="none" />
          </pattern>
          <pattern id="elev_stone" width="320" height="320" patternUnits="userSpaceOnUse">
            <path d="M0 80 Q90 36 190 100 T320 75 M0 220 Q110 185 215 245 T320 215" stroke="rgba(15,23,42,0.12)" strokeWidth="4" fill="none" />
          </pattern>
          <clipPath id="cutthrough_occ_both">
            <rect x={0} y={-wallMetrics.heightMm - 1500} width={wallMetrics.lenMm} height={wallMetrics.heightMm + 1500} />
          </clipPath>
          <clipPath id="cutthrough_occ_left">
            <rect x={0} y={-wallMetrics.heightMm - 1500} width={wallMetrics.lenMm + 10000} height={wallMetrics.heightMm + 1500} />
          </clipPath>
          <clipPath id="cutthrough_occ_right">
            <rect x={-10000} y={-wallMetrics.heightMm - 1500} width={wallMetrics.lenMm + 10000} height={wallMetrics.heightMm + 1500} />
          </clipPath>
          {!isBw &&
            [0, 1, 2, 3, 4].map((bucket) => {
              const blurPx = [0.35, 0.85, 1.35, 1.85, 2.45][bucket];
              const blurMm = Math.max(0.1, blurPx / Math.max(0.02, pxPerMm));
              const slope = settings.darkMode
                ? [0.78, 0.65, 0.53, 0.41, 0.29][bucket]
                : [0.88, 0.75, 0.62, 0.49, 0.36][bucket];
              const sat = [0.16, 0.1, 0.06, 0.02, 0][bucket];
              return (
                <filter
                  key={bucket}
                  id={`ct_depth_${bucket}`}
                  filterUnits="userSpaceOnUse"
                  x={-3000}
                  y={-wallMetrics.heightMm - 2000}
                  width={wallMetrics.lenMm + 6000}
                  height={wallMetrics.heightMm + 4000}
                >
                  <feColorMatrix type="saturate" values={String(sat)} result="gray" />
                  <feComponentTransfer in="gray" result="dark">
                    <feFuncR type="linear" slope={slope} />
                    <feFuncG type="linear" slope={slope} />
                    <feFuncB type="linear" slope={slope} />
                  </feComponentTransfer>
                  {blurPx > 0 && <feGaussianBlur in="dark" stdDeviation={blurMm} />}
                </filter>
              );
            })}
        </defs>

        <g transform={worldToScreen}>
          {/* 1. Wall Elevation Face (Single Wall or Continuous Multi-Segment Consolidated Run) */}
          {wallMetrics.consolidatedRun ? (
            <g data-testid="consolidated-wall-run">
              {wallMetrics.consolidatedRun.gaps.map((gap, gi) => {
                const gxA = mapX(gap.startRunS);
                const gxB = mapX(gap.endRunS);
                const gLeft = Math.min(gxA, gxB);
                const gWidth = Math.max(1, Math.abs(gxB - gxA));
                return (
                  <g key={`gap_${gi}`} className="pointer-events-none">
                    <rect
                      x={gLeft}
                      y={-wallMetrics.heightMm}
                      width={gWidth}
                      height={wallMetrics.heightMm}
                      fill={isBw ? 'none' : settings.darkMode ? '#090D16' : '#F8FAFC'}
                      fillOpacity={isBw ? 0 : 0.55}
                    />
                    <line
                      x1={gLeft}
                      y1={0}
                      x2={gLeft + gWidth}
                      y2={0}
                      stroke={isBw ? '#475569' : '#94A3B8'}
                      strokeWidth={1.1 / pxPerMm}
                      strokeDasharray={`${8 / pxPerMm} ${5 / pxPerMm}`}
                    />
                  </g>
                );
              })}

              {wallMetrics.consolidatedRun.segments.map((seg) => {
                const sxA = mapX(seg.startRunS);
                const sxB = mapX(seg.endRunS);
                const segLeft = Math.min(sxA, sxB);
                const segRight = Math.max(sxA, sxB);
                const segW = Math.max(10, segRight - segLeft);
                const segSel = isSelected('wall', seg.wall.id);
                const segFill = isBw
                  ? '#FFFFFF'
                  : seg.color === '#FFFFFF' && settings.darkMode
                    ? '#1E293B'
                    : getEffectiveMaterialHex(seg.material, seg.color);
                const hasPattern =
                  !isBw &&
                  (seg.material === 'brick' ||
                    seg.material === 'tile' ||
                    seg.material === 'hex_tile' ||
                    seg.material === 'checker' ||
                    seg.material === 'wood' ||
                    seg.material === 'oak' ||
                    seg.material === 'walnut' ||
                    seg.material === 'teak' ||
                    seg.material === 'smoked_oak' ||
                    seg.material === 'paneling' ||
                    seg.material === 'parquet' ||
                    seg.material === 'herringbone' ||
                    seg.material === 'marble' ||
                    seg.material === 'calacatta_gold' ||
                    seg.material === 'nero_marble' ||
                    seg.material === 'travertine' ||
                    seg.material === 'slate' ||
                    seg.material === 'terrazzo');

                // Per-segment baseboard spans excluding doors/arches crossing floor level
                const blockedBB: Array<[number, number]> = [];
                for (const wo of wallMetrics.wallOpenings) {
                  if (wo.op.sillHeightMm < (seg.baseboardHeightMm || 80)) {
                    const oa = Math.min(mapX(wo.leftS), mapX(wo.rightS));
                    const ob = Math.max(mapX(wo.leftS), mapX(wo.rightS));
                    const cL = Math.max(segLeft, oa);
                    const cR = Math.min(segRight, ob);
                    if (cR > cL + 2) blockedBB.push([cL, cR]);
                  }
                }
                blockedBB.sort((a, b) => a[0] - b[0]);
                const segBbSpans: Array<[number, number]> = [];
                let bbCur = segLeft;
                for (const [b1, b2] of blockedBB) {
                  if (b1 > bbCur + 8) segBbSpans.push([bbCur, b1]);
                  bbCur = Math.max(bbCur, b2);
                }
                if (bbCur < segRight - 8) segBbSpans.push([bbCur, segRight]);

                const edgeStroke = isBw
                  ? '#0F172A'
                  : settings.darkMode
                    ? '#64748B'
                    : '#0F172A';

                return (
                  <g key={`cseg_${seg.wall.id}`}>
                    <rect
                      data-ctx-kind="wall"
                      data-ctx-id={seg.wall.id}
                      data-consolidated-seg-id={seg.wall.id}
                      x={segLeft}
                      y={-seg.heightMm}
                      width={segW}
                      height={seg.heightMm}
                      fill={segFill}
                      stroke="none"
                      onPointerDown={(e) => {
                        if (contextMenu) setContextMenu(null);
                        if (placingChimney) return;
                        if (e.button === 1 || spacePressed) return;
                        if (e.button === 0) {
                          e.stopPropagation();
                          panSnapshotRef.current = { ...panOffsetPx };
                          setElevDrag({
                            kind: 'pan',
                            startClientX: e.clientX,
                            startClientY: e.clientY,
                            origPanX: panOffsetPx.x,
                            origPanY: panOffsetPx.y,
                            selectWallOnClick: true,
                            selectWallIdOnClick: seg.wall.id,
                          });
                        }
                      }}
                      className={
                        placingChimney
                          ? 'cursor-crosshair'
                          : elevDrag?.kind === 'pan'
                            ? 'cursor-grabbing'
                            : 'cursor-grab'
                      }
                    />
                    {hasPattern && (
                      <rect
                        x={segLeft}
                        y={-seg.heightMm}
                        width={segW}
                        height={seg.heightMm}
                        fill={
                          seg.material === 'brick'
                            ? 'url(#elev_brick)'
                            : seg.material === 'tile' ||
                                seg.material === 'hex_tile' ||
                                seg.material === 'checker'
                              ? 'url(#elev_tile)'
                              : seg.material === 'paneling'
                                ? 'url(#elev_panel)'
                                : seg.material === 'marble' ||
                                    seg.material === 'calacatta_gold' ||
                                    seg.material === 'nero_marble' ||
                                    seg.material === 'travertine' ||
                                    seg.material === 'slate' ||
                                    seg.material === 'terrazzo'
                                  ? 'url(#elev_stone)'
                                  : 'url(#elev_wood)'
                        }
                        className="pointer-events-none"
                      />
                    )}
                    {/* Top and floor edges (no vertical joint seam between touching equal-height segments) */}
                    <line
                      x1={segLeft}
                      y1={-seg.heightMm}
                      x2={segRight}
                      y2={-seg.heightMm}
                      stroke={edgeStroke}
                      strokeWidth={1.5 / pxPerMm}
                      className="pointer-events-none"
                    />
                    <line
                      x1={segLeft}
                      y1={0}
                      x2={segRight}
                      y2={0}
                      stroke={edgeStroke}
                      strokeWidth={1.5 / pxPerMm}
                      className="pointer-events-none"
                    />
                    {/* Top section slab over this segment */}
                    <rect
                      x={segLeft}
                      y={-seg.heightMm - 180}
                      width={segW}
                      height={180}
                      fill="url(#cut_hatch)"
                      stroke={isBw ? '#0F172A' : settings.darkMode ? '#64748B' : '#334155'}
                      strokeWidth={1.6 / pxPerMm}
                      className="pointer-events-none"
                    />
                    {seg.hasBaseboard && seg.baseboardHeightMm > 0 && (
                      <g className="pointer-events-none">
                        {segBbSpans.map(([bx1, bx2], bIdx) => (
                          <rect
                            key={`cbb_${seg.wall.id}_${bIdx}`}
                            x={bx1}
                            y={-seg.baseboardHeightMm}
                            width={bx2 - bx1}
                            height={seg.baseboardHeightMm}
                            fill={isBw ? 'none' : seg.baseboardColor || '#F8FAFC'}
                            stroke={isBw ? '#334155' : '#94A3B8'}
                            strokeWidth={0.9 / pxPerMm}
                          />
                        ))}
                      </g>
                    )}
                    {seg.hasCrownMolding && seg.crownHeightMm > 0 && (
                      <rect
                        x={segLeft}
                        y={-seg.heightMm}
                        width={segW}
                        height={seg.crownHeightMm}
                        fill={isBw ? 'none' : seg.crownColor || '#F8FAFC'}
                        stroke={isBw ? '#334155' : '#94A3B8'}
                        strokeWidth={0.9 / pxPerMm}
                        className="pointer-events-none"
                      />
                    )}
                    {segSel && (
                      <rect
                        x={segLeft + 2 / pxPerMm}
                        y={-seg.heightMm + 2 / pxPerMm}
                        width={Math.max(4, segW - 4 / pxPerMm)}
                        height={Math.max(4, seg.heightMm - 4 / pxPerMm)}
                        fill="none"
                        stroke="#2563EB"
                        strokeWidth={2 / pxPerMm}
                        strokeDasharray={`${8 / pxPerMm} ${5 / pxPerMm}`}
                        className="pointer-events-none"
                      />
                    )}
                  </g>
                );
              })}

              {/* Continuous Floor Section Slab + Outer Wall Run End Caps */}
              <rect
                x={-leftCapW}
                y={0}
                width={wallMetrics.lenMm + leftCapW + rightCapW}
                height={180}
                fill="url(#cut_hatch)"
                stroke={isBw ? '#0F172A' : settings.darkMode ? '#64748B' : '#334155'}
                strokeWidth={1.6 / pxPerMm}
                className="pointer-events-none"
              />
              <rect
                x={-leftCapW}
                y={-wallMetrics.heightMm}
                width={leftCapW}
                height={wallMetrics.heightMm}
                fill="url(#cut_hatch)"
                stroke={isBw ? '#0F172A' : settings.darkMode ? '#64748B' : '#334155'}
                strokeWidth={1.6 / pxPerMm}
                className="pointer-events-none"
              />
              <rect
                x={wallMetrics.lenMm}
                y={-wallMetrics.heightMm}
                width={rightCapW}
                height={wallMetrics.heightMm}
                fill="url(#cut_hatch)"
                stroke={isBw ? '#0F172A' : settings.darkMode ? '#64748B' : '#334155'}
                strokeWidth={1.6 / pxPerMm}
                className="pointer-events-none"
              />
            </g>
          ) : (
            <>
              <rect
                data-ctx-kind="wall"
                data-ctx-id={targetWall.id}
                x={0}
                y={-wallMetrics.heightMm}
                width={wallMetrics.lenMm}
                height={wallMetrics.heightMm}
                fill={
                  isBw
                    ? '#FFFFFF'
                    : faceColor === '#FFFFFF' && settings.darkMode
                      ? '#1E293B'
                      : getEffectiveMaterialHex(faceMat, faceColor)
                }
                stroke={wallSelected ? '#2563EB' : isBw ? '#0F172A' : settings.darkMode ? '#64748B' : '#0F172A'}
                strokeWidth={(wallSelected ? 2.5 : 1.5) / pxPerMm}
                onPointerDown={(e) => {
                  if (contextMenu) setContextMenu(null);
                  if (placingChimney) return;
                  if (e.button === 1 || spacePressed) return;
                  if (e.button === 0) {
                    e.stopPropagation();
                    panSnapshotRef.current = { ...panOffsetPx };
                    setElevDrag({
                      kind: 'pan',
                      startClientX: e.clientX,
                      startClientY: e.clientY,
                      origPanX: panOffsetPx.x,
                      origPanY: panOffsetPx.y,
                      selectWallOnClick: true,
                    });
                  }
                }}
                className={
                  placingChimney
                    ? 'cursor-crosshair'
                    : elevDrag?.kind === 'pan'
                      ? 'cursor-grabbing'
                      : 'cursor-grab'
                }
              />

              {/* Wall Material Surface Pattern */}
              {!isBw &&
                (faceMat === 'brick' ||
                  faceMat === 'tile' ||
                  faceMat === 'hex_tile' ||
                  faceMat === 'checker' ||
                  faceMat === 'wood' ||
                  faceMat === 'oak' ||
                  faceMat === 'walnut' ||
                  faceMat === 'teak' ||
                  faceMat === 'smoked_oak' ||
                  faceMat === 'paneling' ||
                  faceMat === 'parquet' ||
                  faceMat === 'herringbone' ||
                  faceMat === 'marble' ||
                  faceMat === 'calacatta_gold' ||
                  faceMat === 'nero_marble' ||
                  faceMat === 'travertine' ||
                  faceMat === 'slate' ||
                  faceMat === 'terrazzo') && (
                  <rect
                    x={0}
                    y={-wallMetrics.heightMm}
                    width={wallMetrics.lenMm}
                    height={wallMetrics.heightMm}
                    fill={
                      faceMat === 'brick'
                        ? 'url(#elev_brick)'
                        : faceMat === 'tile' || faceMat === 'hex_tile' || faceMat === 'checker'
                          ? 'url(#elev_tile)'
                          : faceMat === 'paneling'
                            ? 'url(#elev_panel)'
                            : faceMat === 'marble' ||
                                faceMat === 'calacatta_gold' ||
                                faceMat === 'nero_marble' ||
                                faceMat === 'travertine' ||
                                faceMat === 'slate' ||
                                faceMat === 'terrazzo'
                              ? 'url(#elev_stone)'
                              : 'url(#elev_wood)'
                    }
                    className="pointer-events-none"
                  />
                )}

              {/* 2. Architectural Section Slabs */}
              <rect
                x={-leftCapW}
                y={-wallMetrics.heightMm - 180}
                width={wallMetrics.lenMm + leftCapW + rightCapW}
                height={180}
                fill="url(#cut_hatch)"
                stroke={isBw ? '#0F172A' : settings.darkMode ? '#64748B' : '#334155'}
                strokeWidth={1.6 / pxPerMm}
                className="pointer-events-none"
              />
              <rect
                x={-leftCapW}
                y={0}
                width={wallMetrics.lenMm + leftCapW + rightCapW}
                height={180}
                fill="url(#cut_hatch)"
                stroke={isBw ? '#0F172A' : settings.darkMode ? '#64748B' : '#334155'}
                strokeWidth={1.6 / pxPerMm}
                className="pointer-events-none"
              />
              <rect
                x={-leftCapW}
                y={-wallMetrics.heightMm}
                width={leftCapW}
                height={wallMetrics.heightMm}
                fill="url(#cut_hatch)"
                stroke={isBw ? '#0F172A' : settings.darkMode ? '#64748B' : '#334155'}
                strokeWidth={1.6 / pxPerMm}
                className="pointer-events-none"
              />
              <rect
                x={wallMetrics.lenMm}
                y={-wallMetrics.heightMm}
                width={rightCapW}
                height={wallMetrics.heightMm}
                fill="url(#cut_hatch)"
                stroke={isBw ? '#0F172A' : settings.darkMode ? '#64748B' : '#334155'}
                strokeWidth={1.6 / pxPerMm}
                className="pointer-events-none"
              />

              {/* 3. Baseboard & Crown Molding */}
              {targetWall.hasBaseboard && targetWall.baseboardHeightMm > 0 && (
                <g className="pointer-events-none">
                  {baseboardSpans.map(([x1, x2], i) => (
                    <rect
                      key={`bb_${i}`}
                      x={x1}
                      y={-targetWall.baseboardHeightMm}
                      width={x2 - x1}
                      height={targetWall.baseboardHeightMm}
                      fill={isBw ? 'none' : targetWall.baseboardColor || '#F8FAFC'}
                      stroke={isBw ? '#334155' : '#94A3B8'}
                      strokeWidth={0.9 / pxPerMm}
                    />
                  ))}
                </g>
              )}
              {targetWall.hasCrownMolding && targetWall.crownHeightMm > 0 && (
                <rect
                  x={0}
                  y={-wallMetrics.heightMm}
                  width={wallMetrics.lenMm}
                  height={targetWall.crownHeightMm}
                  fill={isBw ? 'none' : targetWall.crownColor || '#F8FAFC'}
                  stroke={isBw ? '#334155' : '#94A3B8'}
                  strokeWidth={0.9 / pxPerMm}
                  className="pointer-events-none"
                />
              )}
            </>
          )}

          {/* 4. Wall-Attached & Parallel-Side Chimneys / Blocks */}
          {wallMetrics.wallChimneys.map(({ el, leftS, rightS, effHeightMm, isDirectlyAttached, sCenter }) => {
            const x1 = Math.min(mapX(leftS), mapX(rightS));
            const x2 = Math.max(mapX(leftS), mapX(rightS));
            const w = Math.max(40, x2 - x1);
            const hostWall =
              (el.attachedWallId
                ? level.walls.find((wItem) => wItem.id === el.attachedWallId)
                : undefined) ?? targetWall;
            const hostWallH = hostWall.heightMm;
            const h = Math.min(effHeightMm, hostWallH - el.elevationMm);
            const yTop = -(el.elevationMm + h);
            const selected = isSelected('arch', el.id);
            const canEdit = isDirectlyAttached && !el.locked && !hostWall.locked;
            const isDimHov = hoveredCompId === el.id || hoveredDimKey === `comp:${el.id}` || hoveredDimKey === `width:${el.id}`;
            const fc = resolveChimneyFaceColors(el);
            const viewedFaceColor = isLeftView ? fc.front : fc.back;
            const chFill = isBw
              ? 'none'
              : viewedFaceColor === '#FFFFFF' && settings.darkMode
                ? '#334155'
                : viewedFaceColor;
            const chimElevTween =
              snapTweenOffset && snapTweenOffset.targetKey === `chimney:${el.id}`
                ? snapTweenOffset
                : null;
            return (
              <g
                key={el.id}
                data-ctx-kind="arch"
                data-ctx-id={el.id}
                transform={
                  chimElevTween
                    ? `translate(${chimElevTween.dx}, ${chimElevTween.dy})`
                    : undefined
                }
                onPointerEnter={() => setHoveredCompId(el.id)}
                onPointerLeave={() => setHoveredCompId((c) => (c === el.id ? null : c))}
                onPointerDown={(e) => {
                  if (contextMenu) setContextMenu(null);
                  if (placingChimney || e.button === 1) return;
                  e.stopPropagation();
                  const alreadySel = isSelected('arch', el.id);
                  onSelect([{ kind: 'arch', id: el.id }]);
                  if (alreadySel && canEdit && e.button === 0) {
                    snapHysteresisRef.current = {};
                    clearSnapTween();
                    setCursorHint(null);
                    elevDragMutatedRef.current = false;
                    setElevDrag({
                      kind: 'comp_move',
                      compId: el.id,
                      compKind: 'chimney',
                      startClientX: e.clientX,
                      startClientY: e.clientY,
                      origCenterS: sCenter,
                      origSillMm: el.elevationMm,
                      label: `Move ${el.name}`,
                    });
                  }
                }}
                className={selected && canEdit ? 'cursor-move' : 'cursor-pointer'}
              >
                <rect
                  x={x1}
                  y={yTop}
                  width={w}
                  height={h}
                  fill={chFill}
                  fillOpacity={isBw ? 0 : isDirectlyAttached ? 0.96 : 0.85}
                  stroke={selected ? '#2563EB' : isDimHov ? '#0EA5E9' : isBw ? '#0F172A' : '#475569'}
                  strokeWidth={(selected ? 2.4 : 1.3) / pxPerMm}
                />
                {/* Inherit wall baseboard across attached chimney */}
                {(el.hasBaseboard ?? hostWall.hasBaseboard) && el.elevationMm === 0 && (
                  <rect
                    x={x1}
                    y={-(el.baseboardHeightMm ?? hostWall.baseboardHeightMm)}
                    width={w}
                    height={el.baseboardHeightMm ?? hostWall.baseboardHeightMm}
                    fill={isBw ? 'none' : (el.baseboardColor ?? hostWall.baseboardColor)}
                    stroke={isBw ? '#334155' : '#94A3B8'}
                    strokeWidth={0.8 / pxPerMm}
                    className="pointer-events-none"
                  />
                )}
                {/* Edge & Vertical Drag Resize Handles for selected unlocked attached Chimney */}
                {selected && canEdit && (
                  <>
                    {(['left', 'right'] as const).map((edge) => {
                      const hx = edge === 'left' ? x1 : x2;
                      const gw = 8 / pxPerMm;
                      const gh = 22 / pxPerMm;
                      const cy = yTop + h / 2;
                      const hitW = 24 / pxPerMm;
                      const hitH = Math.max(h, 26 / pxPerMm);
                      return (
                        <g
                          key={edge}
                          onPointerDown={(e) => {
                            if (e.button !== 0) return;
                            e.stopPropagation();
                            elevDragMutatedRef.current = false;
                            setElevDrag({
                              kind: 'comp_edge',
                              compId: el.id,
                              compKind: 'chimney',
                              visualEdge: edge,
                              startClientX: e.clientX,
                              startClientY: e.clientY,
                              label: `Resize ${el.name}`,
                            });
                          }}
                          style={{ cursor: 'ew-resize' }}
                        >
                          <rect x={hx - hitW / 2} y={cy - hitH / 2} width={hitW} height={hitH} fill="transparent" />
                          <rect
                            x={hx - gw / 2}
                            y={cy - gh / 2}
                            width={gw}
                            height={gh}
                            rx={3 / pxPerMm}
                            fill="#FFFFFF"
                            stroke="#2563EB"
                            strokeWidth={1.8 / pxPerMm}
                          />
                        </g>
                      );
                    })}
                    {(['top', 'bottom'] as const).map((vh) => {
                      const hy = vh === 'top' ? yTop : -el.elevationMm;
                      const cx = (x1 + x2) / 2;
                      const hwBar = 24 / pxPerMm;
                      const hhBar = 8 / pxPerMm;
                      const hitW = Math.max(w, 28 / pxPerMm);
                      const hitH = 24 / pxPerMm;
                      return (
                        <g
                          key={vh}
                          onPointerDown={(e) => {
                            if (e.button !== 0) return;
                            e.stopPropagation();
                            elevDragMutatedRef.current = false;
                            setElevDrag({
                              kind: 'comp_v',
                              compId: el.id,
                              compKind: 'chimney',
                              handle: vh,
                              startClientX: e.clientX,
                              startClientY: e.clientY,
                              origSillMm: el.elevationMm,
                              origHeightMm: h,
                              label: `Resize ${el.name} Height`,
                            });
                          }}
                          style={{ cursor: 'ns-resize' }}
                        >
                          <rect x={cx - hitW / 2} y={hy - hitH / 2} width={hitW} height={hitH} fill="transparent" />
                          <rect
                            x={cx - hwBar / 2}
                            y={hy - hhBar / 2}
                            width={hwBar}
                            height={hhBar}
                            rx={3 / pxPerMm}
                            fill="#FFFFFF"
                            stroke="#2563EB"
                            strokeWidth={1.8 / pxPerMm}
                          />
                        </g>
                      );
                    })}
                  </>
                )}
                {/* Vertical measurements for selected chimney */}
                {showRoomWallDims && selected && (
                  <>
                    {el.elevationMm + h < hostWallH - 5 &&
                      renderElevDim({
                        dimKey: `v_top_${el.id}`,
                        x1: x1 + w / 2,
                        y1: -hostWallH,
                        x2: x1 + w / 2,
                        y2: yTop,
                        valueMm: hostWallH - (el.elevationMm + h),
                        locked: el.locked || hostWall.locked,
                        vertical: true,
                        onEdit: () => {
                          if (el.locked || hostWall.locked) {
                            onConstraintError?.('Chimney or wall is locked.');
                            return;
                          }
                          openElevEditor({
                            key: `v_top_${el.id}`,
                            kind: 'obj_top_gap',
                            wallId: hostWall.id,
                            compId: el.id,
                            compKind: 'chimney',
                            label: 'Chimney Top to Ceiling',
                            valueStr: String(
                              Math.round(((hostWallH - (el.elevationMm + h)) / 10) * 10) / 10
                            ),
                            worldX: x1 + w / 2,
                            worldY: (-hostWallH + yTop) / 2,
                          });
                        },
                      })}
                    {renderElevDim({
                      dimKey: `v_h_${el.id}`,
                      x1: x2 + 110,
                      y1: yTop,
                      x2: x2 + 110,
                      y2: -el.elevationMm,
                      ext1x: x2,
                      ext1y: yTop,
                      ext2x: x2,
                      ext2y: -el.elevationMm,
                      valueMm: h,
                      locked: el.locked || hostWall.locked,
                      vertical: true,
                      onEdit: () => {
                        if (el.locked || hostWall.locked) {
                          onConstraintError?.('Chimney or wall is locked.');
                          return;
                        }
                        openElevEditor({
                          key: `v_h_${el.id}`,
                          kind: 'obj_height',
                          wallId: hostWall.id,
                          compId: el.id,
                          compKind: 'chimney',
                          label: 'Chimney Height',
                          valueStr: String(Math.round((h / 10) * 10) / 10),
                          worldX: x2 + 110,
                          worldY: (yTop - el.elevationMm) / 2,
                        });
                      },
                    })}
                  </>
                )}
              </g>
            );
          })}

          {/* 5. Wall Openings (Cutouts: Windows, Doors, Arches + Arch Apex Dotted Guides) */}
          {wallMetrics.wallOpenings.map(({ op, leftS, rightS, centerS }) => {
            const hostWall = level.walls.find((wItem) => wItem.id === op.wallId) ?? targetWall;
            const hostWallH = hostWall.heightMm;
            const x1 = Math.min(mapX(leftS), mapX(rightS));
            const x2 = Math.max(mapX(leftS), mapX(rightS));
            const w = Math.max(40, x2 - x1);
            const h = Math.min(op.heightMm, hostWallH - op.sillHeightMm);
            const yTop = -(op.sillHeightMm + h);
            const yBottom = -op.sillHeightMm;
            const fThick = op.frameThicknessMm;
            const selected = isSelected('opening', op.id);
            const canEditOp = !op.locked && !hostWall.locked;
            const isDimHov =
              hoveredCompId === op.id ||
              hoveredDimKey === `comp:${op.id}` ||
              hoveredDimKey === `width:${op.id}`;
            const skyBg = isBw ? 'none' : settings.darkMode ? '#0F172A' : '#E0F2FE';
            const strokeColor = selected ? '#2563EB' : isDimHov ? '#0EA5E9' : isBw ? '#0F172A' : op.frameColor;
            const strokeW = (selected ? 2.6 : isDimHov ? 2.1 : 1.45) / pxPerMm;

            // Curved arch spring heights & paths
            const isCurvedArch =
              op.category === 'arch' &&
              (op.subtype === 'round_arch' ||
                op.subtype === 'pointed_arch' ||
                op.subtype === 'segmental_arch');
            const springDrop =
              op.subtype === 'round_arch'
                ? Math.min(w / 2, h * 0.72)
                : op.subtype === 'pointed_arch'
                  ? Math.min(w * 0.65, h * 0.65)
                  : Math.min(w * 0.24, h * 0.35);
            const ySpring = yTop + springDrop;
            const guideColor = isBw ? '#475569' : settings.darkMode ? '#CBD5E1' : '#0284C7';

            const opElevTween =
              snapTweenOffset && snapTweenOffset.targetKey === `opening:${op.id}`
                ? snapTweenOffset
                : null;

            return (
              <g
                key={op.id}
                data-ctx-kind="opening"
                data-ctx-id={op.id}
                transform={
                  opElevTween
                    ? `translate(${opElevTween.dx}, ${opElevTween.dy})`
                    : undefined
                }
                onPointerEnter={() => setHoveredCompId(op.id)}
                onPointerLeave={() => setHoveredCompId((c) => (c === op.id ? null : c))}
                onPointerDown={(e) => {
                  if (contextMenu) setContextMenu(null);
                  if (placingChimney || e.button === 1) return;
                  e.stopPropagation();
                  const alreadySel = isSelected('opening', op.id);
                  onSelect([{ kind: 'opening', id: op.id }]);
                  if (alreadySel && canEditOp && e.button === 0) {
                    snapHysteresisRef.current = {};
                    clearSnapTween();
                    setCursorHint(null);
                    elevDragMutatedRef.current = false;
                    setElevDrag({
                      kind: 'comp_move',
                      compId: op.id,
                      compKind: 'opening',
                      startClientX: e.clientX,
                      startClientY: e.clientY,
                      origCenterS: centerS,
                      origSillMm: op.sillHeightMm,
                      label: `Move ${op.name}`,
                    });
                  }
                }}
                className={selected && canEditOp ? 'cursor-move' : 'cursor-pointer'}
              >
                {/* Cutout backdrop */}
                {op.category === 'arch' && op.subtype === 'round_arch' ? (
                  <path
                    d={`M ${x1} ${yBottom} L ${x1} ${ySpring} A ${w / 2} ${springDrop} 0 0 1 ${x2} ${ySpring} L ${x2} ${yBottom} Z`}
                    fill={isBw ? 'none' : settings.darkMode ? '#090D16' : '#F8FAFC'}
                    stroke={strokeColor}
                    strokeWidth={strokeW}
                  />
                ) : op.category === 'arch' && op.subtype === 'pointed_arch' ? (
                  <path
                    d={`M ${x1} ${yBottom} L ${x1} ${ySpring} Q ${x1} ${yTop + springDrop * 0.18} ${(x1 + x2) / 2} ${yTop} Q ${x2} ${yTop + springDrop * 0.18} ${x2} ${ySpring} L ${x2} ${yBottom} Z`}
                    fill={isBw ? 'none' : settings.darkMode ? '#090D16' : '#F8FAFC'}
                    stroke={strokeColor}
                    strokeWidth={strokeW}
                  />
                ) : op.category === 'arch' && op.subtype === 'segmental_arch' ? (
                  <path
                    d={`M ${x1} ${yBottom} L ${x1} ${ySpring} Q ${(x1 + x2) / 2} ${yTop - springDrop * 0.7} ${x2} ${ySpring} L ${x2} ${yBottom} Z`}
                    fill={isBw ? 'none' : settings.darkMode ? '#090D16' : '#F8FAFC'}
                    stroke={strokeColor}
                    strokeWidth={strokeW}
                  />
                ) : (
                  <rect
                    x={x1}
                    y={yTop}
                    width={w}
                    height={h}
                    fill={
                      isBw
                        ? 'none'
                        : op.category === 'window'
                          ? skyBg
                          : op.category === 'door' && op.subtype === 'doorframe'
                            ? op.frameColor
                            : settings.darkMode
                              ? '#0B1220'
                              : '#F8FAFC'
                    }
                    stroke={strokeColor}
                    strokeWidth={strokeW}
                  />
                )}

                {/* Faint dotted non-physical vertical reference lines ONLY in Cut-Through for curved arches */}
                {isCurvedArch && (
                  <g className="pointer-events-none" opacity={0.42}>
                    <line
                      x1={x1}
                      y1={ySpring}
                      x2={x1}
                      y2={yTop}
                      stroke={guideColor}
                      strokeWidth={0.85 / pxPerMm}
                      strokeDasharray={`${3.5 / pxPerMm} ${4.5 / pxPerMm}`}
                    />
                    <line
                      x1={x2}
                      y1={ySpring}
                      x2={x2}
                      y2={yTop}
                      stroke={guideColor}
                      strokeWidth={0.85 / pxPerMm}
                      strokeDasharray={`${3.5 / pxPerMm} ${4.5 / pxPerMm}`}
                    />
                    {/* Horizontal apex reference ticks */}
                    <line
                      x1={x1 - 45}
                      y1={yTop}
                      x2={x2 + 45}
                      y2={yTop}
                      stroke={guideColor}
                      strokeWidth={0.75 / pxPerMm}
                      strokeDasharray={`${3 / pxPerMm} ${5 / pxPerMm}`}
                    />
                  </g>
                )}

                {op.category === 'window' && (
                  <>
                    <rect
                      x={x1 + fThick}
                      y={yTop + fThick}
                      width={Math.max(10, w - fThick * 2)}
                      height={Math.max(10, h - fThick * 2)}
                      fill={isBw ? 'none' : op.glassColor}
                      fillOpacity={isBw ? 0 : 0.48}
                      stroke={isBw ? '#0F172A' : op.frameColor}
                      strokeWidth={1.1 / pxPerMm}
                    />
                    <line
                      x1={x1 + w * 0.25}
                      y1={yTop + h * 0.72}
                      x2={x1 + w * 0.42}
                      y2={yTop + h * 0.35}
                      stroke={isBw ? '#475569' : '#FFFFFF'}
                      strokeOpacity={0.75}
                      strokeWidth={2 / pxPerMm}
                    />
                    {(op.subtype === 'double' ||
                      op.subtype === 'triple' ||
                      op.subtype === 'bay' ||
                      op.subtype === 'euro_double' ||
                      op.subtype === 'euro_terrace') && (
                      <line
                        x1={x1 + w / 2}
                        y1={yTop + fThick}
                        x2={x1 + w / 2}
                        y2={yBottom - fThick}
                        stroke={isBw ? '#0F172A' : op.frameColor}
                        strokeWidth={1.6 / pxPerMm}
                      />
                    )}
                    {(op.subtype === 'triple' || op.subtype === 'euro_triple') && (
                      <>
                        <line
                          x1={x1 + w / 3}
                          y1={yTop + fThick}
                          x2={x1 + w / 3}
                          y2={yBottom - fThick}
                          stroke={isBw ? '#0F172A' : op.frameColor}
                          strokeWidth={1.4 / pxPerMm}
                        />
                        <line
                          x1={x1 + (2 * w) / 3}
                          y1={yTop + fThick}
                          x2={x1 + (2 * w) / 3}
                          y2={yBottom - fThick}
                          stroke={isBw ? '#0F172A' : op.frameColor}
                          strokeWidth={1.4 / pxPerMm}
                        />
                      </>
                    )}
                    {(op.subtype === 'euro_single' ||
                      op.subtype === 'euro_double' ||
                      op.subtype === 'euro_triple' ||
                      op.subtype === 'euro_terrace') && (
                      <polyline
                        points={`${x1 + fThick},${yTop + fThick} ${x1 + w / 2},${yBottom - fThick} ${x2 - fThick},${yTop + fThick}`}
                        fill="none"
                        stroke="#64748B"
                        strokeDasharray="45 35"
                        strokeWidth={0.9 / pxPerMm}
                      />
                    )}
                    <rect x={x1 - 35} y={yBottom - 25} width={w + 70} height={45} fill={isBw ? 'none' : op.frameColor} stroke={isBw ? '#0F172A' : '#94A3B8'} strokeWidth={isBw ? 0.9 / pxPerMm : 0.6 / pxPerMm} />
                  </>
                )}

                {op.category === 'door' && op.subtype === 'doorframe' && (
                  <rect
                    x={x1 + fThick}
                    y={yTop + fThick}
                    width={Math.max(20, w - fThick * 2)}
                    height={Math.max(20, h - fThick)}
                    fill={isBw ? 'none' : settings.darkMode ? '#0B1220' : '#F8FAFC'}
                    stroke={isBw ? '#0F172A' : strokeColor}
                    strokeWidth={1.1 / pxPerMm}
                  />
                )}

                {op.category === 'door' && op.subtype !== 'doorframe' && (
                  <>
                    {(op.subtype === 'balcony_single' || op.subtype === 'balcony_double') ? (
                      <>
                        <rect
                          x={x1 + fThick}
                          y={yTop + fThick}
                          width={Math.max(20, w - fThick * 2)}
                          height={Math.max(20, h - fThick)}
                          fill={isBw ? 'none' : op.frameColor}
                          stroke={isBw ? '#0F172A' : '#94A3B8'}
                          strokeWidth={1.2 / pxPerMm}
                        />
                        {op.subtype === 'balcony_double' ? (
                          <>
                            <rect
                              x={x1 + fThick + 55}
                              y={yTop + fThick + 65}
                              width={Math.max(15, w / 2 - fThick - 85)}
                              height={Math.max(20, h * 0.72)}
                              fill={isBw ? 'none' : op.glassColor}
                              fillOpacity={isBw ? 0 : 0.5}
                              stroke={isBw ? '#0F172A' : '#94A3B8'}
                              strokeWidth={0.9 / pxPerMm}
                            />
                            <rect
                              x={x1 + w / 2 + 30}
                              y={yTop + fThick + 65}
                              width={Math.max(15, w / 2 - fThick - 85)}
                              height={Math.max(20, h * 0.72)}
                              fill={isBw ? 'none' : op.glassColor}
                              fillOpacity={isBw ? 0 : 0.5}
                              stroke={isBw ? '#0F172A' : '#94A3B8'}
                              strokeWidth={0.9 / pxPerMm}
                            />
                            <line
                              x1={x1 + w / 2}
                              y1={yTop + fThick}
                              x2={x1 + w / 2}
                              y2={yBottom}
                              stroke={isBw ? '#0F172A' : op.frameColor}
                              strokeWidth={1.6 / pxPerMm}
                            />
                          </>
                        ) : (
                          <rect
                            x={x1 + fThick + 65}
                            y={yTop + fThick + 65}
                            width={Math.max(20, w - fThick * 2 - 130)}
                            height={Math.max(20, h * 0.74)}
                            fill={isBw ? 'none' : op.glassColor}
                            fillOpacity={isBw ? 0 : 0.5}
                            stroke={isBw ? '#0F172A' : '#94A3B8'}
                            strokeWidth={0.9 / pxPerMm}
                          />
                        )}
                      </>
                    ) : (
                      <>
                        <rect
                          x={x1 + fThick}
                          y={yTop + fThick}
                          width={Math.max(20, w - fThick * 2)}
                          height={Math.max(20, h - fThick)}
                          fill={isBw ? 'none' : op.panelColor}
                          stroke={isBw ? '#0F172A' : op.frameColor}
                          strokeWidth={1.2 / pxPerMm}
                        />
                        {(op.subtype === 'double' || op.subtype === 'french') && (
                          <line
                            x1={x1 + w / 2}
                            y1={yTop + fThick}
                            x2={x1 + w / 2}
                            y2={yBottom}
                            stroke={isBw ? '#0F172A' : op.frameColor}
                            strokeWidth={1.5 / pxPerMm}
                          />
                        )}
                      </>
                    )}
                    {op.subtype !== 'double' && op.subtype !== 'french' && op.subtype !== 'balcony_double' && (
                      <polyline
                        points={
                          op.swingSide === 'left'
                            ? `${x1 + fThick},${yTop + fThick} ${x2 - fThick},${(yTop + yBottom) / 2} ${
                                x1 + fThick
                              },${yBottom}`
                            : `${x2 - fThick},${yTop + fThick} ${x1 + fThick},${(yTop + yBottom) / 2} ${
                                x2 - fThick
                              },${yBottom}`
                        }
                        fill="none"
                        stroke={isBw ? '#475569' : '#64748B'}
                        strokeDasharray="50 40"
                        strokeWidth={1.1 / pxPerMm}
                      />
                    )}
                    <circle
                      cx={op.swingSide === 'left' ? x2 - fThick - 75 : x1 + fThick + 75}
                      cy={-1050}
                      r={24}
                      fill={isBw ? 'none' : op.subtype.startsWith('balcony_') ? '#64748B' : op.frameColor}
                      stroke={isBw ? '#0F172A' : 'none'}
                      strokeWidth={isBw ? 1.1 / pxPerMm : 0}
                    />
                  </>
                )}

                {/* Direct Left/Right & Top/Bottom Edge-Drag Handles for Selected Unlocked Opening */}
                {selected && canEditOp && (
                  <>
                    {(['left', 'right'] as const).map((edge) => {
                      const hx = edge === 'left' ? x1 : x2;
                      const gw = 8 / pxPerMm;
                      const gh = 22 / pxPerMm;
                      const cy = (yTop + yBottom) / 2;
                      const hitW = 24 / pxPerMm;
                      const hitH = Math.max(h, 26 / pxPerMm);
                      return (
                        <g
                          key={edge}
                          onPointerDown={(e) => {
                            if (e.button !== 0) return;
                            e.stopPropagation();
                            elevDragMutatedRef.current = false;
                            setElevDrag({
                              kind: 'comp_edge',
                              compId: op.id,
                              compKind: 'opening',
                              visualEdge: edge,
                              startClientX: e.clientX,
                              startClientY: e.clientY,
                              label: `Resize ${op.name}`,
                            });
                          }}
                          style={{ cursor: 'ew-resize' }}
                        >
                          <rect x={hx - hitW / 2} y={cy - hitH / 2} width={hitW} height={hitH} fill="transparent" />
                          <rect
                            x={hx - gw / 2}
                            y={cy - gh / 2}
                            width={gw}
                            height={gh}
                            rx={3 / pxPerMm}
                            fill="#FFFFFF"
                            stroke="#2563EB"
                            strokeWidth={1.8 / pxPerMm}
                          />
                        </g>
                      );
                    })}
                    {(['top', 'bottom'] as const).map((vh) => {
                      if (vh === 'bottom' && op.category === 'door' && op.sillHeightMm === 0) return null;
                      const hy = vh === 'top' ? yTop : yBottom;
                      const cx = (x1 + x2) / 2;
                      const hwBar = 24 / pxPerMm;
                      const hhBar = 8 / pxPerMm;
                      const hitW = Math.max(w, 28 / pxPerMm);
                      const hitH = 24 / pxPerMm;
                      return (
                        <g
                          key={vh}
                          onPointerDown={(e) => {
                            if (e.button !== 0) return;
                            e.stopPropagation();
                            elevDragMutatedRef.current = false;
                            setElevDrag({
                              kind: 'comp_v',
                              compId: op.id,
                              compKind: 'opening',
                              handle: vh,
                              startClientX: e.clientX,
                              startClientY: e.clientY,
                              origSillMm: op.sillHeightMm,
                              origHeightMm: h,
                              label: `Resize ${op.name} Height`,
                            });
                          }}
                          style={{ cursor: 'ns-resize' }}
                        >
                          <rect x={cx - hitW / 2} y={hy - hitH / 2} width={hitW} height={hitH} fill="transparent" />
                          <rect
                            x={cx - hwBar / 2}
                            y={hy - hhBar / 2}
                            width={hwBar}
                            height={hhBar}
                            rx={3 / pxPerMm}
                            fill="#FFFFFF"
                            stroke="#2563EB"
                            strokeWidth={1.8 / pxPerMm}
                          />
                        </g>
                      );
                    })}
                  </>
                )}

                {/* Vertical Dimensions (Top to Ceiling, Height, Sill to Floor) */}
                {showRoomWallDims && (selected || wallSelected) && (
                  <>
                    {/* Top of Door/Window/Arch to Ceiling */}
                    {hostWallH - (op.sillHeightMm + h) >= 5 &&
                      renderElevDim({
                        dimKey: `v_top_${op.id}`,
                        x1: (x1 + x2) / 2,
                        y1: -hostWallH,
                        x2: (x1 + x2) / 2,
                        y2: yTop,
                        valueMm: hostWallH - (op.sillHeightMm + h),
                        locked: op.locked || hostWall.locked,
                        vertical: true,
                        hoverId: op.id,
                        onEdit: () => {
                          if (op.locked || hostWall.locked) {
                            onConstraintError?.('Opening or wall is locked.');
                            return;
                          }
                          openElevEditor({
                            key: `v_top_${op.id}`,
                            kind: 'obj_top_gap',
                            wallId: hostWall.id,
                            compId: op.id,
                            compKind: 'opening',
                            label: `${op.name} Top to Ceiling`,
                            valueStr: String(
                              Math.round(((hostWallH - (op.sillHeightMm + h)) / 10) * 10) / 10
                            ),
                            worldX: (x1 + x2) / 2,
                            worldY: (-hostWallH + yTop) / 2,
                          });
                        },
                      })}
                    {/* Window Sill / Bottom to Floor */}
                    {op.sillHeightMm >= 5 &&
                      renderElevDim({
                        dimKey: `v_sill_${op.id}`,
                        x1: (x1 + x2) / 2,
                        y1: yBottom,
                        x2: (x1 + x2) / 2,
                        y2: 0,
                        valueMm: op.sillHeightMm,
                        locked: op.locked || hostWall.locked,
                        vertical: true,
                        hoverId: op.id,
                        onEdit: () => {
                          if (op.locked || hostWall.locked) {
                            onConstraintError?.('Opening or wall is locked.');
                            return;
                          }
                          openElevEditor({
                            key: `v_sill_${op.id}`,
                            kind: 'obj_sill',
                            wallId: hostWall.id,
                            compId: op.id,
                            compKind: 'opening',
                            label: `${op.name} Sill to Floor`,
                            valueStr: String(Math.round((op.sillHeightMm / 10) * 10) / 10),
                            worldX: (x1 + x2) / 2,
                            worldY: yBottom / 2,
                          });
                        },
                      })}
                    {/* Opening Height (when selected) */}
                    {selected &&
                      renderElevDim({
                        dimKey: `v_h_${op.id}`,
                        x1: x2 + 115,
                        y1: yTop,
                        x2: x2 + 115,
                        y2: yBottom,
                        ext1x: x2,
                        ext1y: yTop,
                        ext2x: x2,
                        ext2y: yBottom,
                        valueMm: h,
                        locked: op.locked || hostWall.locked,
                        vertical: true,
                        hoverId: op.id,
                        onEdit: () => {
                          if (op.locked || hostWall.locked) {
                            onConstraintError?.('Opening or wall is locked.');
                            return;
                          }
                          openElevEditor({
                            key: `v_h_${op.id}`,
                            kind: 'obj_height',
                            wallId: hostWall.id,
                            compId: op.id,
                            compKind: 'opening',
                            label: `${op.name} Height`,
                            valueStr: String(Math.round((h / 10) * 10) / 10),
                            worldX: x2 + 115,
                            worldY: (yTop + yBottom) / 2,
                          });
                        },
                      })}
                  </>
                )}
              </g>
            );
          })}

          {/* 6. Projected Nearby Furniture & Objects (real wall-end occlusion only; 360-deg cached SVG projections) */}
          {showObjects && (
            <g data-testid="cutthrough-context-objects">
              {(() => {
                const depthFilterFor = (perpDistMm: number): string | undefined => {
                  if (isBw || !showDepthEffect) return undefined;
                  const ratio = Math.min(1, perpDistMm / Math.max(100, wallMetrics.maxContextDistMm));
                  const bucket = Math.min(4, Math.floor(ratio * 4.99));
                  return `url(#ct_depth_${bucket})`;
                };

                const clipPathFor = (perpDistMm: number): string | undefined => {
                  const occL =
                    wallMetrics.endOcclusion.leftClipX !== null &&
                    perpDistMm < wallMetrics.endOcclusion.leftBlockingOutMm;
                  const occR =
                    wallMetrics.endOcclusion.rightClipX !== null &&
                    perpDistMm < wallMetrics.endOcclusion.rightBlockingOutMm;
                  if (occL && occR) return 'url(#cutthrough_occ_both)';
                  if (occL) return 'url(#cutthrough_occ_left)';
                  if (occR) return 'url(#cutthrough_occ_right)';
                  return undefined;
                };

                type CombinedCtx =
                  | { kind: 'furn'; perpDistMm: number; entry: (typeof wallMetrics.wallFurniture)[number] }
                  | { kind: 'arch'; perpDistMm: number; entry: (typeof wallMetrics.wallContextArch)[number] }
                  | { kind: 'curtain'; perpDistMm: number; entry: (typeof wallMetrics.wallCurtains)[number] }
                  | { kind: 'person'; perpDistMm: number; entry: (typeof wallMetrics.wallPeople)[number] };

                const combined: CombinedCtx[] = [
                  ...wallMetrics.wallFurniture.map((entry) => ({ kind: 'furn' as const, perpDistMm: entry.perpDistMm, entry })),
                  ...wallMetrics.wallContextArch.map((entry) => ({ kind: 'arch' as const, perpDistMm: entry.perpDistMm, entry })),
                  ...wallMetrics.wallCurtains.map((entry) => ({ kind: 'curtain' as const, perpDistMm: entry.perpDistMm, entry })),
                  ...wallMetrics.wallPeople.map((entry) => ({ kind: 'person' as const, perpDistMm: entry.perpDistMm, entry })),
                ].sort((a, b) => a.perpDistMm - b.perpDistMm);

                return combined.map((node) => {
                  const filterAttr = depthFilterFor(node.perpDistMm);
                  const clipAttr = clipPathFor(node.perpDistMm);
                  const ctxOpacity = isBw ? 1 : showDepthEffect ? 0.94 : 0.98;

                  if (node.kind === 'furn') {
                    const { item: f, visibleParts, projection } = node.entry;
                    const sw = 1 / pxPerMm;
                    const isInteractive = Boolean(wallElevFurnitureMeta?.interactiveIds.has(f.id));
                    const furnSelected = isInteractive && isSelected('furniture', f.id);
                    const furnHovered = isInteractive && hoveredCompId === f.id;
                    const furnTween =
                      snapTweenOffset &&
                      (snapTweenOffset.targetKey === `furniture:${f.id}` ||
                        (snapTweenOffset.targetKey === 'furniture_group' && furnSelected))
                        ? snapTweenOffset
                        : null;

                    const handleFurnPointerDown = (e: React.PointerEvent<SVGGElement>) => {
                      if (!isInteractive || !projection || !wallElevFurnitureMeta) return;
                      if (contextMenu) setContextMenu(null);
                      if (placingChimney || e.button !== 0 || spacePressed) return;
                      e.stopPropagation();

                      const isCtrlModifier = e.ctrlKey && !e.metaKey;
                      const alreadySel = isSelected('furniture', f.id);

                      if (e.metaKey || (isCtrlModifier && !alreadySel)) {
                        const nextSel = alreadySel
                          ? selection.filter((s) => !(s.kind === 'furniture' && s.id === f.id))
                          : [...selection, { kind: 'furniture' as const, id: f.id }];
                        onSelect(nextSel);
                        return;
                      }

                      if (!alreadySel && !e.shiftKey) {
                        onSelect([{ kind: 'furniture', id: f.id }]);
                        return;
                      }

                      if (f.locked || (f.attachedWallId === targetWall.id && targetWall.locked)) {
                        if (!alreadySel) {
                          onSelect([{ kind: 'furniture', id: f.id }]);
                        } else if (isCtrlModifier) {
                          onSelect(selection.filter((s) => !(s.kind === 'furniture' && s.id === f.id)));
                        }
                        return;
                      }

                      const selectedFurnIds = new Set(
                        selection.filter((s) => s.kind === 'furniture').map((s) => s.id)
                      );
                      const groupIds =
                        alreadySel && selectedFurnIds.has(f.id)
                          ? selectedFurnIds
                          : new Set([f.id]);

                      const origItemsMap = new Map<string, WallViewGroupOrigItem>();
                      for (const gid of groupIds) {
                        const gf = level.furniture.find((item) => item.id === gid);
                        const grect = wallElevFurnitureMeta.furnRectById.get(gid);
                        if (!gf || gf.locked || !grect) continue;
                        origItemsMap.set(gid, {
                          id: gf.id,
                          origXMm: gf.xMm,
                          origYMm: gf.yMm,
                          origElevationMm: gf.elevationMm ?? 0,
                          origRotDeg: gf.rotationDeg,
                          origAttachedWallId: gf.attachedWallId,
                          origAttachedFace: gf.attachedFace,
                          origAttachedT: gf.attachedT,
                          origCenterX: grect.centerX,
                          origZBottom: grect.zBottom,
                          elevW: grect.elevW,
                          elevH: grect.elevH,
                        });
                      }

                      if (!alreadySel && e.shiftKey) {
                        onSelect([{ kind: 'furniture', id: f.id }]);
                      }

                      snapHysteresisRef.current = {};
                      clearSnapTween();
                      setCursorHint(null);
                      elevDragMutatedRef.current = false;
                      furnPrevSettledRef.current = {
                        centerX: projection.viewXCenter,
                        zBottom: projection.zBottom,
                      };
                      setElevDrag({
                        kind: 'furn_move',
                        furnId: f.id,
                        startClientX: e.clientX,
                        startClientY: e.clientY,
                        origCenterX: projection.viewXCenter,
                        origZBottom: projection.zBottom,
                        origCenterS: isLeftView
                          ? projection.viewXCenter
                          : wallMetrics.lenMm - projection.viewXCenter,
                        ctrlToggleOnClick: isCtrlModifier && alreadySel,
                        origItemsMap,
                        label:
                          origItemsMap.size > 1
                            ? `Move ${origItemsMap.size} items`
                            : `Move ${f.name}`,
                      });
                    };

                    const wrapInteractive = (content: React.ReactNode) => {
                      const boxX = projection ? projection.viewXCenter - projection.elevW / 2 : 0;
                      const boxY = projection ? -(projection.zBottom + projection.elevH) : 0;
                      const boxW = projection?.elevW ?? 0;
                      const boxH = projection?.elevH ?? 0;
                      return (
                        <g
                          key={f.id}
                          clipPath={clipAttr}
                          data-wallview-furn-id={f.id}
                          data-wallview-interactive={isInteractive ? 'true' : undefined}
                          data-ctx-kind={isInteractive ? 'furniture' : undefined}
                          data-ctx-id={isInteractive ? f.id : undefined}
                          className={
                            isInteractive
                              ? furnSelected && !f.locked
                                ? 'cursor-move'
                                : 'cursor-pointer'
                              : 'pointer-events-none'
                          }
                          transform={
                            furnTween
                              ? `translate(${furnTween.dx}, ${furnTween.dy})`
                              : undefined
                          }
                          onPointerEnter={
                            isInteractive ? () => setHoveredCompId(f.id) : undefined
                          }
                          onPointerLeave={
                            isInteractive
                              ? () => setHoveredCompId((c) => (c === f.id ? null : c))
                              : undefined
                          }
                          onPointerDown={isInteractive ? handleFurnPointerDown : undefined}
                        >
                          {isInteractive && projection && (
                            <rect
                              x={boxX}
                              y={boxY}
                              width={boxW}
                              height={boxH}
                              fill="transparent"
                            />
                          )}
                          {content}
                          {isInteractive && projection && (furnSelected || furnHovered) && (
                            <rect
                              x={boxX}
                              y={boxY}
                              width={boxW}
                              height={boxH}
                              fill={furnSelected ? 'rgba(37,99,235,0.06)' : 'rgba(14,165,233,0.04)'}
                              stroke={furnSelected ? '#2563EB' : '#0EA5E9'}
                              strokeWidth={(furnSelected ? 2 : 1.3) / pxPerMm}
                              strokeDasharray={
                                furnSelected ? undefined : `${6 / pxPerMm} ${4 / pxPerMm}`
                              }
                              className="pointer-events-none"
                            />
                          )}
                        </g>
                      );
                    };

                    if (projection) {
                      void glbCacheRev;
                      const activeMode = resolveEffectiveRepresentationMode(f);
                      const isCustomElev = hasCustomView(f.representation, projection.viewId);
                      const hasExplicitDefaultElev = Boolean(
                        f.representation?.defaultViews?.[projection.viewId]?.elements?.length
                      );
                      const yawInfo = computeWallCameraRelativeYawDeg(
                        wallMetrics.viewWall,
                        viewedPhysicalSide,
                        f
                      );
                      const isGlbItem = Boolean(f.glbAssetId || f.glbDataUrl);
                      const useCustomVectorSvg = isCustomElev || hasExplicitDefaultElev;
                      const shouldUseAngledProjection =
                        !useCustomVectorSvg &&
                        f.parts.length > 0 &&
                        (activeMode !== 'default' || !yawInfo.isCardinal || projection.hasTilt);

                      const projMode = activeMode === 'default' ? 'silhouette' : activeMode;
                      const angledView = shouldUseAngledProjection
                        ? getCachedWallAngleProjection(f, yawInfo.bucketYawDeg, projMode, 12)
                        : null;

                      if (angledView && angledView.elements.length > 0) {
                        const angledRep = {
                          ...(f.representation ?? { mode: projMode }),
                          mode: projMode,
                          customViews: undefined,
                          defaultViews: undefined,
                          autoViews: { front: angledView },
                        };
                        const baseW = angledView.baseWidthMm || projection.elevW;
                        const baseH = angledView.baseHeightMm || projection.elevH;
                        const sx = isGlbItem ? 1 : baseW > 0 ? projection.elevW / baseW : 1;
                        const sy = isGlbItem ? 1 : baseH > 0 ? projection.elevH / baseH : 1;
                        return wrapInteractive(
                          <g
                            data-wallview-yaw-bucket={yawInfo.bucketYawDeg}
                            filter={filterAttr}
                            opacity={ctxOpacity}
                            transform={`translate(${projection.viewXCenter}, ${-projection.zBottom}) scale(${sx}, ${sy})`}
                          >
                            {renderFurnitureRepresentationView(angledRep, 'front', {
                              baseStrokeMm: Math.max(isBw ? 5 : 4, sw),
                              selected: furnSelected,
                              useMaterialFill: Boolean(
                                !isBw &&
                                  (activeMode === 'default' || f.representation?.useMaterialFill)
                              ),
                              blackAndWhite: isBw,
                            })}
                          </g>
                        );
                      }

                      if (useCustomVectorSvg || activeMode !== 'default' || isGlbItem) {
                        const fallbackViewId =
                          getEffectiveViewElements(f.representation, projection.viewId).elements
                            ?.length
                            ? projection.viewId
                            : f.representation?.autoViews?.front?.elements?.length
                              ? 'front'
                              : projection.viewId;
                        const resolved = getEffectiveViewElements(
                          f.representation,
                          fallbackViewId
                        );
                        if (resolved.elements && resolved.elements.length > 0) {
                          const xf = computeCustomSvgWallViewTransform(
                            resolved.elements,
                            resolved.autoView?.viewBox,
                            projection,
                            yawInfo.relYawDeg,
                            { preserveAspectOnFlat: !projection.hasTilt }
                          );
                          return wrapInteractive(
                            <g
                              filter={filterAttr}
                              opacity={ctxOpacity}
                              transform={`translate(${xf.translateX}, ${xf.translateY}) scale(${xf.scaleX}, ${xf.scaleY}) translate(${-xf.srcCenterX}, ${-xf.srcBottomY})`}
                            >
                              {renderFurnitureRepresentationView(
                                f.representation,
                                fallbackViewId,
                                {
                                  baseStrokeMm: Math.max(isBw ? 5 : 4, sw),
                                  selected: furnSelected,
                                  useMaterialFill: Boolean(f.representation?.useMaterialFill && !isBw),
                                  blackAndWhite: isBw,
                                }
                              )}
                            </g>
                          );
                        }
                      }
                    }

                    const wallElements = generateWallCutThroughElevationElements(
                      visibleParts,
                      f,
                      isBw
                    );
                    return wrapInteractive(
                      <g filter={filterAttr} opacity={ctxOpacity}>
                        {wallElements.map((el) =>
                          renderSingleSvgVectorElement(el, {
                            baseStrokeMm: Math.max(isBw ? 5 : 4, sw),
                            minStrokeMm: isBw ? Math.max(2.2, sw * 0.52) : undefined,
                          })
                        )}
                      </g>
                    );
                  }

                  if (node.kind === 'arch') {
                    const { item: el, sCenter, projW } = node.entry;
                    const ex = mapX(sCenter);
                    const h = el.connectToCeiling ? wallMetrics.heightMm - el.elevationMm : el.heightMm;
                    return (
                      <rect
                        key={`ctx_arch_${el.id}`}
                        className="pointer-events-none"
                        clipPath={clipAttr}
                        x={ex - projW / 2}
                        y={-(el.elevationMm + h)}
                        width={projW}
                        height={h}
                        fill={isBw ? 'none' : el.color}
                        fillOpacity={isBw ? 0 : 0.88}
                        stroke={isBw ? '#0F172A' : '#475569'}
                        strokeWidth={1 / pxPerMm}
                        filter={filterAttr}
                        opacity={ctxOpacity}
                      />
                    );
                  }

                  if (node.kind === 'curtain') {
                    const { item: c, sCenter } = node.entry;
                    const cx = mapX(sCenter);
                    const closedFrac = 1 - c.openPercent / 100;
                    const wingW = Math.max(120, (c.widthMm / 2) * closedFrac);
                    const topY = -(c.elevationMm + c.heightMm);
                    return (
                      <g
                        key={c.id}
                        className="pointer-events-none"
                        clipPath={clipAttr}
                        filter={filterAttr}
                        opacity={ctxOpacity}
                      >
                        <line
                          x1={cx - c.widthMm / 2 - 60}
                          y1={topY}
                          x2={cx + c.widthMm / 2 + 60}
                          y2={topY}
                          stroke={isBw ? '#0F172A' : c.rodColor}
                          strokeWidth={2.5 / pxPerMm}
                        />
                        <rect
                          x={cx - c.widthMm / 2}
                          y={topY}
                          width={wingW}
                          height={c.heightMm}
                          fill={isBw ? 'none' : c.color}
                          fillOpacity={isBw ? 0 : c.style === 'drapes' || c.style === 'curtains' ? 0.35 : 0.8}
                          stroke={isBw ? '#0F172A' : '#475569'}
                          strokeWidth={1 / pxPerMm}
                        />
                        <rect
                          x={cx + c.widthMm / 2 - wingW}
                          y={topY}
                          width={wingW}
                          height={c.heightMm}
                          fill={isBw ? 'none' : c.color}
                          fillOpacity={isBw ? 0 : c.style === 'drapes' || c.style === 'curtains' ? 0.35 : 0.8}
                          stroke={isBw ? '#0F172A' : '#475569'}
                          strokeWidth={1 / pxPerMm}
                        />
                      </g>
                    );
                  }

                  const { item: person, sCenter } = node.entry;
                  const px = mapX(sCenter);
                  const h = person.heightMm;
                  return (
                    <g
                      key={person.id}
                      className="pointer-events-none"
                      clipPath={clipAttr}
                      transform={`translate(${px}, ${-person.elevationMm})`}
                      filter={filterAttr}
                      opacity={ctxOpacity}
                    >
                      <rect
                        x={-140}
                        y={-h * 0.85}
                        width={280}
                        height={h * 0.85}
                        rx={110}
                        fill={isBw ? 'none' : person.color}
                        fillOpacity={isBw ? 0 : 0.82}
                        stroke={isBw ? '#0F172A' : '#475569'}
                        strokeWidth={1.1 / pxPerMm}
                      />
                      <circle
                        cx={0}
                        cy={-h * 0.92}
                        r={h * 0.075}
                        fill={isBw ? 'none' : person.color}
                        stroke={isBw ? '#0F172A' : '#475569'}
                        strokeWidth={1.1 / pxPerMm}
                      />
                    </g>
                  );
                });
              })()}
            </g>
          )}

          {/* 6b. 4-Cardinal Clearances + Automatic Non-Overlapping Furniture & Corner Dimensions */}
          {showObjects &&
            showWallFurnitureDims &&
            wallElevFurnitureMeta &&
            (() => {
              const activeFurnId =
                elevDrag?.kind === 'furn_move'
                  ? elevDrag.furnId
                  : selection.find(
                      (s) => s.kind === 'furniture' && wallElevFurnitureMeta.interactiveIds.has(s.id)
                    )?.id;
              const targetRect = activeFurnId
                ? wallElevFurnitureMeta.furnRectById.get(activeFurnId)
                : undefined;
              const activeFurn = activeFurnId
                ? level.furniture.find((f) => f.id === activeFurnId)
                : undefined;

              const excludeGroupIds =
                elevDrag?.kind === 'furn_move'
                  ? new Set(elevDrag.origItemsMap.keys())
                  : activeFurnId
                    ? new Set([activeFurnId])
                    : new Set<string>();
              const otherFurnRects = wallElevFurnitureMeta.furnRects.filter(
                (r) => !excludeGroupIds.has(r.id)
              );
              const clearances =
                targetRect && activeFurn
                  ? computeWallViewFurnitureClearances(
                      targetRect,
                      otherFurnRects,
                      wallElevFurnitureMeta.solidArchObstacles,
                      wallElevFurnitureMeta.wallEdgeObstacles,
                      wallElevFurnitureMeta.dragBounds
                    )
                  : null;
              const isLockedTarget = Boolean(
                activeFurn &&
                  (activeFurn.locked ||
                    (activeFurn.attachedWallId === targetWall.id && targetWall.locked))
              );

              const items = clearances
                ? [
                    clearances.left,
                    clearances.right,
                    clearances.bottom,
                    clearances.top,
                  ].filter((c): c is NonNullable<typeof c> => Boolean(c))
                : [];

              const rawFurnDims = computeWallViewFurnitureDimensions({
                activeFurnId: targetRect && activeFurn ? activeFurnId : undefined,
                furnRects: wallElevFurnitureMeta.furnRects,
                furnRectById: wallElevFurnitureMeta.furnRectById,
                allFurniture: level.furniture,
                clearances,
                dragBounds: wallElevFurnitureMeta.dragBounds,
                targetWallId: targetWall.id,
              });
              const layoutObstacles = [
                ...wallElevFurnitureMeta.furnRects.map((r) => ({
                  minX: r.leftX,
                  maxX: r.rightX,
                  minZ: r.zBottom,
                  maxZ: r.zTop,
                })),
                ...wallElevFurnitureMeta.wallEdgeObstacles.map((o) => ({
                  minX: o.leftX,
                  maxX: o.rightX,
                  minZ: o.zBottom,
                  maxZ: o.zTop,
                })),
              ];
              const laidFurnDims = layoutWallViewDimensions(rawFurnDims, layoutObstacles, pxPerMm);

              return (
                <g data-testid="wallview-furniture-clearances">
                  {laidFurnDims.map((fd) =>
                    renderElevDim({
                      dimKey: fd.dimKey,
                      x1: fd.x1,
                      y1: -fd.z1,
                      x2: fd.x2,
                      y2: -fd.z2,
                      ext1x: fd.ext1x,
                      ext1y: fd.ext1z !== undefined ? -fd.ext1z : undefined,
                      ext2x: fd.ext2x,
                      ext2y: fd.ext2z !== undefined ? -fd.ext2z : undefined,
                      valueMm: fd.valueMm,
                      locked: false,
                      vertical: fd.vertical,
                      hoverId: fd.hoverId,
                      subtle: fd.subtle ?? true,
                      prefix: fd.prefix,
                      labelOffsetPerpMm: fd.labelOffsetPerpMm,
                    })
                  )}
                  {targetRect &&
                    activeFurn &&
                    items.map((c) => {
                      const isVert = c.side === 'bottom' || c.side === 'top';
                      const kindMap = {
                        left: 'furn_clear_left',
                        right: 'furn_clear_right',
                        bottom: 'furn_clear_bottom',
                        top: 'furn_clear_top',
                      } as const;
                      const labelMap = {
                        left: `Gap to ${c.boundaryLabel}`,
                        right: `Gap to ${c.boundaryLabel}`,
                        bottom: `Gap above ${c.boundaryLabel}`,
                        top: `Gap below ${c.boundaryLabel}`,
                      } as const;
                      return renderElevDim({
                        dimKey: `furn_clear_${c.side}:${activeFurn.id}`,
                        x1: c.x1,
                        y1: -c.z1,
                        x2: c.x2,
                        y2: -c.z2,
                        valueMm: c.gapMm,
                        locked: isLockedTarget,
                        vertical: isVert,
                        hoverId: activeFurn.id,
                        onEdit: () => {
                          if (isLockedTarget) {
                            onConstraintError?.('Furniture or wall is locked.');
                            return;
                          }
                          openElevEditor({
                            key: `furn_clear_${c.side}:${activeFurn.id}`,
                            kind: kindMap[c.side],
                            wallId: targetWall.id,
                            compId: activeFurn.id,
                            compKind: 'furniture',
                            boundaryMm: c.boundaryMm,
                            label: labelMap[c.side],
                            valueStr: String(Math.round((c.gapMm / 10) * 10) / 10),
                            worldX: (c.x1 + c.x2) / 2,
                            worldY: -(c.z1 + c.z2) / 2,
                          });
                        },
                      });
                    })}
                </g>
              );
            })()}

          {/* 7. Interactive Architectural Room, Wall & Opening Dimensions */}
          {showRoomWallDims && wallChain && (
            <g>
              {wallViewRoomDims && Math.abs(wallViewRoomDims.widthMm - wallMetrics.lenMm) > 10 &&
                renderElevDim({
                  dimKey: `room_w:${wallViewRoomDims.roomId}`,
                  x1: wallViewRoomDims.leftX,
                  y1: 750,
                  x2: wallViewRoomDims.rightX,
                  y2: 750,
                  ext1x: wallViewRoomDims.leftX,
                  ext1y: 180,
                  ext2x: wallViewRoomDims.rightX,
                  ext2y: 180,
                  valueMm: wallViewRoomDims.widthMm,
                  locked: false,
                  subtle: true,
                  prefix: `${wallViewRoomDims.roomName} W`,
                })}
              {wallViewRoomDims && (
                <text
                  x={18}
                  y={-wallMetrics.heightMm - 230}
                  fontSize={Math.max(70, Math.min(110, 10 / pxPerMm))}
                  fontFamily="JetBrains Mono, monospace"
                  fontWeight={500}
                  fill={isBw ? '#334155' : settings.darkMode ? '#94A3B8' : '#64748B'}
                  className="pointer-events-none"
                >
                  {wallViewRoomDims.roomName}: {formatSmartMetric(wallViewRoomDims.widthMm)} ×{' '}
                  {formatSmartMetric(wallViewRoomDims.heightMm)}
                </text>
              )}
              {focusedWallComp?.target ? (
                <>
                  {/* Object Width Above Object */}
                  {renderElevDim({
                    dimKey: `width:${focusedWallComp.target.id}`,
                    x1: Math.min(mapX(focusedWallComp.target.leftS), mapX(focusedWallComp.target.rightS)),
                    y1: -wallMetrics.heightMm - 280,
                    x2: Math.max(mapX(focusedWallComp.target.leftS), mapX(focusedWallComp.target.rightS)),
                    y2: -wallMetrics.heightMm - 280,
                    ext1x: Math.min(mapX(focusedWallComp.target.leftS), mapX(focusedWallComp.target.rightS)),
                    ext1y: -wallMetrics.heightMm,
                    ext2x: Math.max(mapX(focusedWallComp.target.leftS), mapX(focusedWallComp.target.rightS)),
                    ext2y: -wallMetrics.heightMm,
                    valueMm: focusedWallComp.target.widthMm,
                    locked: targetWall.locked || focusedWallComp.target.locked,
                    hoverId: focusedWallComp.target.id,
                    onEdit: () => {
                      const t = focusedWallComp.target!;
                      if (targetWall.locked || t.locked) {
                        onConstraintError?.('Component or wall is locked.');
                        return;
                      }
                      const mx = (mapX(t.leftS) + mapX(t.rightS)) / 2;
                      openElevEditor({
                        key: `width:${t.id}`,
                        kind: 'component_width',
                        wallId: targetWall.id,
                        compId: t.id,
                        label: `${t.name} Width`,
                        valueStr: String(Math.round((t.widthMm / 10) * 10) / 10),
                        worldX: mx,
                        worldY: -wallMetrics.heightMm - 280,
                      });
                    },
                  })}

                  {/* Non-Crossing Left Clearance */}
                  {focusedWallComp.left && focusedWallComp.left.lengthMm >= 1 &&
                    renderElevDim({
                      dimKey: `clear_left:${focusedWallComp.target.id}`,
                      x1: Math.min(mapX(focusedWallComp.left.startS), mapX(focusedWallComp.left.endS)),
                      y1: 295,
                      x2: Math.max(mapX(focusedWallComp.left.startS), mapX(focusedWallComp.left.endS)),
                      y2: 295,
                      ext1x: Math.min(mapX(focusedWallComp.left.startS), mapX(focusedWallComp.left.endS)),
                      ext1y: 0,
                      ext2x: Math.max(mapX(focusedWallComp.left.startS), mapX(focusedWallComp.left.endS)),
                      ext2y: 0,
                      valueMm: focusedWallComp.left.lengthMm,
                      locked: focusedWallComp.left.locked,
                      hoverId: focusedWallComp.left.neighborId,
                      onEdit: () => {
                        const t = focusedWallComp.target!;
                        const c = focusedWallComp.left!;
                        if (c.locked) {
                          onConstraintError?.('Component or wall is locked.');
                          return;
                        }
                        const mx = (mapX(c.startS) + mapX(c.endS)) / 2;
                        openElevEditor({
                          key: `clear_left:${t.id}`,
                          kind: 'clearance_left',
                          wallId: targetWall.id,
                          compId: t.id,
                          label:
                            c.stopsAt === 'component'
                              ? `Gap to ${c.neighborName}`
                              : 'Distance to Left Corner',
                          valueStr: String(Math.round((c.lengthMm / 10) * 10) / 10),
                          worldX: mx,
                          worldY: 295,
                        });
                      },
                    })}

                  {/* Non-Crossing Right Clearance */}
                  {focusedWallComp.right && focusedWallComp.right.lengthMm >= 1 &&
                    renderElevDim({
                      dimKey: `clear_right:${focusedWallComp.target.id}`,
                      x1: Math.min(mapX(focusedWallComp.right.startS), mapX(focusedWallComp.right.endS)),
                      y1: 295,
                      x2: Math.max(mapX(focusedWallComp.right.startS), mapX(focusedWallComp.right.endS)),
                      y2: 295,
                      ext1x: Math.min(mapX(focusedWallComp.right.startS), mapX(focusedWallComp.right.endS)),
                      ext1y: 0,
                      ext2x: Math.max(mapX(focusedWallComp.right.startS), mapX(focusedWallComp.right.endS)),
                      ext2y: 0,
                      valueMm: focusedWallComp.right.lengthMm,
                      locked: focusedWallComp.right.locked,
                      hoverId: focusedWallComp.right.neighborId,
                      onEdit: () => {
                        const t = focusedWallComp.target!;
                        const c = focusedWallComp.right!;
                        if (c.locked) {
                          onConstraintError?.('Component or wall is locked.');
                          return;
                        }
                        const mx = (mapX(c.startS) + mapX(c.endS)) / 2;
                        openElevEditor({
                          key: `clear_right:${t.id}`,
                          kind: 'clearance_right',
                          wallId: targetWall.id,
                          compId: t.id,
                          label:
                            c.stopsAt === 'component'
                              ? `Gap to ${c.neighborName}`
                              : 'Distance to Right Corner',
                          valueStr: String(Math.round((c.lengthMm / 10) * 10) / 10),
                          worldX: mx,
                          worldY: 295,
                        });
                      },
                    })}
                </>
              ) : (
                <>
                  {/* All Segments along selected wall */}
                  {wallChain.segments.map((seg) => {
                    const xA = Math.min(mapX(seg.startS), mapX(seg.endS));
                    const xB = Math.max(mapX(seg.startS), mapX(seg.endS));
                    return renderElevDim({
                      dimKey: seg.key,
                      x1: xA,
                      y1: 295,
                      x2: xB,
                      y2: 295,
                      ext1x: xA,
                      ext1y: 0,
                      ext2x: xB,
                      ext2y: 0,
                      valueMm: seg.lengthMm,
                      locked: seg.locked,
                      hoverId: seg.componentId,
                      onEdit: () => {
                        if (seg.locked) {
                          onConstraintError?.('Segment is locked.');
                          return;
                        }
                        if (seg.kind === 'component' && seg.componentId) {
                          openElevEditor({
                            key: seg.key,
                            kind: 'component_width',
                            wallId: targetWall.id,
                            compId: seg.componentId,
                            label: `${seg.label} Width`,
                            valueStr: String(Math.round((seg.lengthMm / 10) * 10) / 10),
                            worldX: (xA + xB) / 2,
                            worldY: 295,
                          });
                        } else if (wallChain.components.length > 0) {
                          const nextComp = wallChain.components.find((c) => c.leftS >= seg.endS - 2);
                          const prevComp = [...wallChain.components]
                            .reverse()
                            .find((c) => c.rightS <= seg.startS + 2);
                          const adj = nextComp ?? prevComp;
                          if (!adj) return;
                          if (adj.locked) {
                            onConstraintError?.(`"${adj.name}" is locked.`);
                            return;
                          }
                          openElevEditor({
                            key: seg.key,
                            kind: nextComp ? 'clearance_left' : 'clearance_right',
                            wallId: targetWall.id,
                            compId: adj.id,
                            label: `${adj.name} ${nextComp ? 'Left' : 'Right'} Wall Gap`,
                            valueStr: String(Math.round((seg.lengthMm / 10) * 10) / 10),
                            worldX: (xA + xB) / 2,
                            worldY: 295,
                          });
                        }
                      },
                    });
                  })}

                  {/* Subtle segment & doorway gap spans for consolidated runs */}
                  {wallMetrics.consolidatedRun &&
                    wallMetrics.consolidatedRun.segments.map((seg, sIdx) => {
                      const sxA = Math.min(mapX(seg.startRunS), mapX(seg.endRunS));
                      const sxB = Math.max(mapX(seg.startRunS), mapX(seg.endRunS));
                      return renderElevDim({
                        dimKey: `cseg_len:${seg.wall.id}`,
                        x1: sxA,
                        y1: 410,
                        x2: sxB,
                        y2: 410,
                        ext1x: sxA,
                        ext1y: 180,
                        ext2x: sxB,
                        ext2y: 180,
                        valueMm: seg.lengthMm,
                        locked: false,
                        subtle: true,
                        prefix: `Seg ${sIdx + 1}`,
                      });
                    })}
                  {wallMetrics.consolidatedRun &&
                    wallMetrics.consolidatedRun.gaps.map((gap, gIdx) => {
                      const gxA = Math.min(mapX(gap.startRunS), mapX(gap.endRunS));
                      const gxB = Math.max(mapX(gap.startRunS), mapX(gap.endRunS));
                      return renderElevDim({
                        dimKey: `cgap_len:${gIdx}`,
                        x1: gxA,
                        y1: 410,
                        x2: gxB,
                        y2: 410,
                        ext1x: gxA,
                        ext1y: 0,
                        ext2x: gxB,
                        ext2y: 0,
                        valueMm: gap.widthMm,
                        locked: false,
                        subtle: true,
                        prefix: 'Opening',
                      });
                    })}

                  {/* Overall Bottom Wall Length */}
                  {renderElevDim({
                    dimKey: `wall_total:${targetWallGroupKey ?? targetWall.id}`,
                    x1: 0,
                    y1: 520,
                    x2: wallMetrics.lenMm,
                    y2: 520,
                    ext1x: 0,
                    ext1y: 180,
                    ext2x: wallMetrics.lenMm,
                    ext2y: 180,
                    valueMm: wallMetrics.lenMm,
                    locked:
                      Boolean(wallMetrics.consolidatedRun) ||
                      targetWall.locked ||
                      targetWall.anchorMode === 'fixed_length',
                    subtle: Boolean(wallMetrics.consolidatedRun),
                    prefix: wallMetrics.consolidatedRun ? 'Run Total' : undefined,
                    onEdit: wallMetrics.consolidatedRun
                      ? undefined
                      : () => {
                          if (targetWall.locked || targetWall.anchorMode === 'fixed_length') {
                            onConstraintError?.(
                              targetWall.locked
                                ? 'Wall is locked.'
                                : 'Wall length is anchored as Fixed Total Length.'
                            );
                            return;
                          }
                          openElevEditor({
                            key: `wall_total:${targetWall.id}`,
                            kind: 'wall_length',
                            wallId: targetWall.id,
                            label: 'Wall Total Length',
                            valueStr: String(Math.round((wallMetrics.lenMm / 10) * 10) / 10),
                            worldX: wallMetrics.lenMm / 2,
                            worldY: 520,
                          });
                        },
                  })}
                </>
              )}

              {/* Left Overall Wall Height */}
              {renderElevDim({
                dimKey: `wall_h:${targetWall.id}`,
                x1: -leftCapW - 150,
                y1: 0,
                x2: -leftCapW - 150,
                y2: -wallMetrics.heightMm,
                ext1x: -leftCapW,
                ext1y: 0,
                ext2x: -leftCapW,
                ext2y: -wallMetrics.heightMm,
                valueMm: wallMetrics.heightMm,
                locked: targetWall.locked,
                vertical: true,
                onEdit: () => {
                  if (targetWall.locked) {
                    onConstraintError?.('Wall is locked.');
                    return;
                  }
                  openElevEditor({
                    key: `wall_h:${targetWall.id}`,
                    kind: 'wall_height',
                    wallId: targetWall.id,
                    label: 'Wall Height',
                    valueStr: String(Math.round((wallMetrics.heightMm / 10) * 10) / 10),
                    worldX: -leftCapW - 150,
                    worldY: -wallMetrics.heightMm / 2,
                  });
                },
              })}
            </g>
          )}
          {/* 8. Interactive Wall View Measurement Tool Layer */}
          {(measureActive || measureResult || measureDraftStart) && (
            <g data-testid="wallview-measure-overlay" className="pointer-events-none">
              {(() => {
                const activeLine =
                  measureDraftStart && measureHoverSnap
                    ? { start: measureDraftStart, end: measureHoverSnap.point, live: true }
                    : measureResult
                      ? { start: measureResult.start, end: measureResult.end, live: false }
                      : null;
                if (!activeLine) return null;
                const x1 = activeLine.start.xMm;
                const y1 = -activeLine.start.zMm;
                const x2 = activeLine.end.xMm;
                const y2 = -activeLine.end.zMm;
                const totalMm = Math.hypot(x2 - x1, y2 - y1);
                const dxMm = Math.abs(x2 - x1);
                const dzMm = Math.abs(y2 - y1);
                const midX = (x1 + x2) / 2;
                const midY = (y1 + y2) / 2;
                const fontSize = Math.max(76, Math.min(130, 11 / pxPerMm));
                const showComponents = dxMm > 15 && dzMm > 15;
                const labelText = showComponents
                  ? `${formatSmartMetric(totalMm)} (ΔX ${formatSmartMetric(dxMm)} · ΔZ ${formatSmartMetric(dzMm)})`
                  : formatSmartMetric(totalMm);
                const pillW = Math.max(fontSize * 3.2, labelText.length * fontSize * 0.61 + 48);
                const pillH = fontSize * 1.45;
                return (
                  <g>
                    {showComponents && (
                      <>
                        <line
                          x1={x1}
                          y1={y1}
                          x2={x2}
                          y2={y1}
                          stroke="#2563EB"
                          strokeOpacity={0.35}
                          strokeWidth={0.9 / pxPerMm}
                          strokeDasharray={`${4 / pxPerMm} ${3 / pxPerMm}`}
                        />
                        <line
                          x1={x2}
                          y1={y1}
                          x2={x2}
                          y2={y2}
                          stroke="#2563EB"
                          strokeOpacity={0.35}
                          strokeWidth={0.9 / pxPerMm}
                          strokeDasharray={`${4 / pxPerMm} ${3 / pxPerMm}`}
                        />
                      </>
                    )}
                    <line
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                      stroke="#2563EB"
                      strokeWidth={1.8 / pxPerMm}
                      strokeDasharray={activeLine.live ? `${6 / pxPerMm} ${4 / pxPerMm}` : undefined}
                    />
                    <circle cx={x1} cy={y1} r={4 / pxPerMm} fill="#2563EB" stroke="#FFFFFF" strokeWidth={1.2 / pxPerMm} />
                    <circle cx={x2} cy={y2} r={4 / pxPerMm} fill="#2563EB" stroke="#FFFFFF" strokeWidth={1.2 / pxPerMm} />
                    <g transform={`translate(${midX}, ${midY - 12 / pxPerMm})`}>
                      <rect
                        x={-pillW / 2}
                        y={-pillH / 2}
                        width={pillW}
                        height={pillH}
                        rx={pillH * 0.25}
                        fill="#2563EB"
                      />
                      <text
                        x={0}
                        y={fontSize * 0.35}
                        textAnchor="middle"
                        fontSize={fontSize}
                        fontFamily="JetBrains Mono, monospace"
                        fontWeight={600}
                        fill="#FFFFFF"
                      >
                        {labelText}
                      </text>
                    </g>
                  </g>
                );
              })()}
              {measureActive && measureHoverSnap && (
                <g transform={`translate(${measureHoverSnap.point.xMm}, ${-measureHoverSnap.point.zMm})`}>
                  <circle
                    r={6.5 / pxPerMm}
                    fill={measureHoverSnap.snappedKind === 'free' ? 'rgba(37,99,235,0.15)' : 'rgba(16,185,129,0.22)'}
                    stroke={measureHoverSnap.snappedKind === 'free' ? '#2563EB' : '#10B981'}
                    strokeWidth={1.8 / pxPerMm}
                  />
                  {measureHoverSnap.label && (
                    <text
                      x={10 / pxPerMm}
                      y={-10 / pxPerMm}
                      fontSize={Math.max(66, Math.min(110, 9.5 / pxPerMm))}
                      fontFamily="Inter, system-ui, sans-serif"
                      fontWeight={600}
                      fill="#059669"
                    >
                      {measureHoverSnap.label}
                    </text>
                  )}
                </g>
              )}
            </g>
          )}
        </g>
      </svg>

      {measureActive && (
        <div
          data-testid="wallview-measure-banner"
          className="absolute top-14 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 px-3 py-1 rounded bg-white/95 dark:bg-slate-900/95 border border-slate-200 dark:border-slate-700 shadow-sm text-[11px] text-slate-700 dark:text-slate-200"
        >
          <span>
            {measureDraftStart
              ? 'Measure: Click end point · Hold Shift for free angle · Esc to clear'
              : 'Measure: Click start point (snaps to walls, corners & furniture) · Hold Shift for free · Esc to exit'}
          </span>
          <button
            type="button"
            onClick={() => {
              setMeasureActive(false);
              setMeasureDraftStart(null);
              setMeasureHoverSnap(null);
              setMeasureResult(null);
            }}
            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-[10px] font-medium text-slate-600 dark:text-slate-300 cursor-pointer"
          >
            <X className="w-2.5 h-2.5" />
            <span>Done</span>
          </button>
        </div>
      )}

      {/* Top-Right Floating Room-Scoped Wall Selection Mini-Viewer */}
      <div
        data-testid="cutthrough-floating-wall-selector"
        className="absolute top-14 right-3 z-20 w-[228px] bg-white/95 dark:bg-slate-900/95 backdrop-blur-sm border border-slate-200 dark:border-slate-700 rounded-xl shadow-lg overflow-hidden text-xs"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => setWallMapOpen((o) => !o)}
          className="w-full px-2.5 py-1.5 flex items-center justify-between gap-2 bg-slate-50/90 dark:bg-slate-800/70 hover:bg-slate-100 dark:hover:bg-slate-800 border-b border-slate-200 dark:border-slate-700 cursor-pointer"
        >
          <span className="flex items-center gap-1.5 font-semibold text-slate-800 dark:text-slate-100 min-w-0">
            <MapIcon className="w-3.5 h-3.5 text-blue-600 shrink-0" />
            <span className="truncate">{activeSelectorRoom?.name ?? 'Room Walls'}</span>
          </span>
          <span className="flex items-center gap-1 text-[10px] font-mono-nums text-slate-500 dark:text-slate-400 shrink-0">
            <span>
              {Math.max(
                1,
                activeRoomWallEntries.findIndex((entry) => entry.memberWallIds.includes(targetWall.id)) + 1
              )}
              /{Math.max(1, activeRoomWallEntries.length)}
            </span>
            {wallMapOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </span>
        </button>
        {wallMapOpen && (
          <div className="p-2">
            <div className="h-[145px] w-full rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200/80 dark:border-slate-800 overflow-hidden">
              <WallMiniSelectorMap
                entries={activeRoomWallEntries}
                polygonContextWalls={visibleWallsList}
                activeWallId={targetWall.id}
                compact
                onSelectWall={selectRoomWall}
              />
            </div>
            <div className="mt-1.5 flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400 px-0.5">
              <span>{activeSelectorRoom ? `${activeSelectorRoom.name} walls` : 'Click wall dot to switch'}</span>
              <span className="font-mono-nums font-semibold text-blue-600 dark:text-blue-400">
                {formatSmartMetric(wallMetrics.lenMm)}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Compact single-line cursor hint chip */}
      <CursorHintChip
        hint={cursorHint}
        clientPos={cursorClientPos}
        containerRef={containerRef}
      />

      {/* Inline Cut-Through Dimension Editor */}
      {editingDim && (
        <div
          style={{
            left: `${Math.max(12, Math.min(size.width - 230, editingDim.screenX - 105))}px`,
            top: `${Math.max(52, Math.min(size.height - 96, editingDim.screenY - 24))}px`,
          }}
          className="absolute z-40 w-[216px] bg-white dark:bg-slate-900 border border-blue-500 rounded-lg shadow-xl p-2 text-xs"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400 mb-1 font-medium">
            <span className="truncate">{editingDim.label}</span>
            <span>Enter · Esc</span>
          </div>
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              type="number"
              step="0.5"
              value={editingDim.valueStr}
              onChange={(e) =>
                setEditingDim((d) => (d ? { ...d, valueStr: e.target.value, error: null } : null))
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.stopPropagation();
                  commitElevDimEdit();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  setEditingDim(null);
                }
              }}
              className="w-full px-2 py-1 font-mono-nums text-xs bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <span className="text-[11px] font-mono-nums text-slate-500 shrink-0">cm</span>
            <button
              type="button"
              onClick={commitElevDimEdit}
              className="px-2 py-1 rounded bg-blue-600 text-white text-[11px] font-medium hover:bg-blue-700 cursor-pointer shrink-0"
            >
              OK
            </button>
          </div>
          {editingDim.error && (
            <p className="mt-1 text-[10px] text-red-600 dark:text-red-400 leading-tight">
              {editingDim.error}
            </p>
          )}
        </div>
      )}
      <CanvasContextMenu
        menu={contextMenu}
        onClose={() => setContextMenu(null)}
        onDuplicate={onDuplicateSelected}
        onDelete={onDeleteSelected}
        onToggleLock={() => {
          if (!onUpdateLevel || !ctxMetaRef.current || selection.length === 0) return;
          const nextLocked = ctxMetaRef.current.nextLock;
          const wIds = new Set(selection.filter((s) => s.kind === 'wall').map((s) => s.id));
          const oIds = new Set(selection.filter((s) => s.kind === 'opening').map((s) => s.id));
          const aIds = new Set(selection.filter((s) => s.kind === 'arch').map((s) => s.id));
          const fIds = new Set(selection.filter((s) => s.kind === 'furniture').map((s) => s.id));
          onUpdateLevel(
            (lvl) => ({
              ...lvl,
              walls: lvl.walls.map((w) => (wIds.has(w.id) ? { ...w, locked: nextLocked } : w)),
              openings: lvl.openings.map((o) => (oIds.has(o.id) ? { ...o, locked: nextLocked } : o)),
              archElements: lvl.archElements.map((a) => (aIds.has(a.id) ? { ...a, locked: nextLocked } : a)),
              furniture: lvl.furniture.map((f) => (fIds.has(f.id) ? { ...f, locked: nextLocked } : f)),
            }),
            false,
            true,
            nextLocked ? 'Lock Selection' : 'Unlock Selection'
          );
        }}
        onMirror={() => {
          if (!onUpdateLevel || selection.length === 0) return;
          const oIds = new Set(selection.filter((s) => s.kind === 'opening').map((s) => s.id));
          const aIds = new Set(selection.filter((s) => s.kind === 'arch').map((s) => s.id));
          onUpdateLevel(
            (lvl) => ({
              ...lvl,
              openings: lvl.openings.map((o) =>
                oIds.has(o.id) && !o.locked
                  ? { ...o, swingSide: o.swingSide === 'left' ? 'right' : 'left' }
                  : o
              ),
              archElements: lvl.archElements.map((a) =>
                aIds.has(a.id) && !a.locked
                  ? { ...a, attachedFace: a.attachedFace === 'left' ? 'right' : 'left' }
                  : a
              ),
            }),
            false,
            true,
            'Mirror Selection'
          );
        }}
        onRotate90={() => {
          if (!onUpdateLevel || selection.length === 0) return;
          const aIds = new Set(selection.filter((s) => s.kind === 'arch').map((s) => s.id));
          onUpdateLevel(
            (lvl) => ({
              ...lvl,
              archElements: lvl.archElements.map((a) =>
                aIds.has(a.id) && !a.locked
                  ? { ...a, rotationDeg: (a.rotationDeg + 90) % 360 }
                  : a
              ),
            }),
            false,
            true,
            'Rotate Selection 90°'
          );
        }}
        onConsolidateWalls={() => {
          const ids = ctxMetaRef.current?.consolidateIds;
          if (!onUpdateLevel || !ids || ids.length < 2) return;
          const gid = uid('wgrp');
          onUpdateLevel(
            (lvl) => ({
              ...lvl,
              walls: applyWallConsolidation(lvl.walls, ids, gid),
            }),
            false,
            true,
            'Consolidate Wall Representation'
          );
        }}
        onSeparateWalls={() => {
          const ids = ctxMetaRef.current?.separateIds;
          if (!onUpdateLevel || !ids || ids.length === 0) return;
          onUpdateLevel(
            (lvl) => ({
              ...lvl,
              walls: clearWallConsolidation(lvl.walls, ids),
            }),
            false,
            true,
            'Separate Wall Representation'
          );
        }}
        onPaste={onPasteClipboard}
        onFitToScreen={() => {
          setZoomScale(1);
          setPanOffsetPx({ x: 0, y: 0 });
        }}
      />
    </div>
  );
};
