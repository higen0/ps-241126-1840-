import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronUp,
  EyeOff,
  Grid,
  Magnet,
  Maximize2,
  RotateCcw,
  RotateCw,
  Ruler,
  Scissors,
  SlidersHorizontal,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { CardinalRotationDeg } from '../utils/viewRotation2d';
import {
  AngleSnapDeg,
  GridSizeMm,
  Point2D,
  ProjectSettings,
  ScalePreset,
  UnitDisplay,
  ViewMode,
} from '../types/plan';

interface BottomToolbarProps {
  settings: ProjectSettings;
  viewMode: ViewMode;
  zoomMultiplier: number;
  viewRotationDeg?: CardinalRotationDeg;
  cursorCoordsMm: Point2D;
  onUpdateSettings: (partial: Partial<ProjectSettings>) => void;
  onZoomChange: (nextMult: number) => void;
  onRotateViewStep?: (deltaDeg: -90 | 90) => void;
  onResetViewRotation?: () => void;
  onFitToScreen: () => void;
}

const SCALES: ScalePreset[] = ['1:10', '1:20', '1:25', '1:50', '1:100', '1:200'];
const GRID_SIZES: Array<{ mm: GridSizeMm; label: string }> = [
  { mm: 10, label: '1 cm' },
  { mm: 50, label: '5 cm' },
  { mm: 100, label: '10 cm' },
  { mm: 500, label: '50 cm' },
];
const ANGLE_SNAPS: Array<{ deg: AngleSnapDeg; label: string }> = [
  { deg: 15, label: '15°' },
  { deg: 45, label: '45°' },
  { deg: 90, label: '90°' },
  { deg: 0, label: 'Free' },
];
const UNITS: UnitDisplay[] = ['mm', 'cm', 'm'];

export const BottomToolbar: React.FC<BottomToolbarProps> = ({
  settings,
  viewMode,
  zoomMultiplier,
  viewRotationDeg = 0,
  cursorCoordsMm,
  onUpdateSettings,
  onZoomChange,
  onRotateViewStep,
  onResetViewRotation,
  onFitToScreen,
}) => {
  const show3dControls = viewMode === '3d';
  const zoomPct = Math.round(zoomMultiplier * 100);
  const [zoomDraft, setZoomDraft] = useState(String(zoomPct));
  const [zoomFocused, setZoomFocused] = useState(false);
  const [draftOpen, setDraftOpen] = useState(false);
  const draftWrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!zoomFocused) {
      setZoomDraft(String(zoomPct));
    }
  }, [zoomPct, zoomFocused]);

  useEffect(() => {
    if (!draftOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (draftWrapRef.current && !draftWrapRef.current.contains(e.target as Node)) {
        setDraftOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDraftOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [draftOpen]);

  const commitZoomDraft = () => {
    const parsed = Number(zoomDraft);
    if (Number.isFinite(parsed) && parsed > 0) {
      const clamped = Math.max(15, Math.min(600, Math.round(parsed)));
      onZoomChange(clamped / 100);
      setZoomDraft(String(clamped));
    } else {
      setZoomDraft(String(zoomPct));
    }
    setZoomFocused(false);
  };

  return (
    <footer className="h-9 shrink-0 px-2.5 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 text-[11px] select-none relative z-20">
      {/* Left: Scale, Zoom, Grid, Snap, Units, Drafting Popover */}
      <div className="flex items-center gap-1.5 shrink-0">
        <div className="flex items-center gap-1">
          <span className="text-slate-400 hidden sm:inline">Scale</span>
          <select
            value={settings.scale}
            onChange={(e) => onUpdateSettings({ scale: e.target.value as ScalePreset })}
            aria-label="Drawing scale"
            className="h-6 px-1.5 font-mono-nums bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            {SCALES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center h-6 border border-slate-200 dark:border-slate-700 rounded overflow-hidden bg-white dark:bg-slate-950">
          <button
            type="button"
            onClick={() => onZoomChange(Math.max(0.15, zoomMultiplier * 0.85))}
            title="Zoom out (-)"
            aria-label="Zoom out"
            className="h-full px-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <ZoomOut className="w-3 h-3" />
          </button>
          <label className="h-full flex items-center px-1 border-x border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/70 cursor-text">
            <input
              type="number"
              min={15}
              max={600}
              step={5}
              value={zoomDraft}
              aria-label="Zoom percentage"
              title="Click to type zoom percentage (15–600%)"
              onFocus={(e) => {
                setZoomFocused(true);
                e.currentTarget.select();
              }}
              onChange={(e) => setZoomDraft(e.target.value)}
              onBlur={commitZoomDraft}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitZoomDraft();
                  (e.currentTarget as HTMLInputElement).blur();
                } else if (e.key === 'Escape') {
                  setZoomDraft(String(zoomPct));
                  setZoomFocused(false);
                  (e.currentTarget as HTMLInputElement).blur();
                }
              }}
              className="w-9 text-center font-mono-nums text-slate-700 dark:text-slate-200 bg-transparent focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
            <span className="text-slate-400 font-mono-nums pr-0.5 select-none">%</span>
          </label>
          <button
            type="button"
            onClick={() => onZoomChange(Math.min(6, zoomMultiplier * 1.15))}
            title="Zoom in (+)"
            aria-label="Zoom in"
            className="h-full px-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <ZoomIn className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={onFitToScreen}
            title="Fit plan to screen (0)"
            aria-label="Fit to screen"
            className="h-full px-1.5 border-l border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <Maximize2 className="w-3 h-3" />
          </button>
        </div>

        {viewMode === '2d' && onRotateViewStep && (
          <div
            className="flex items-center h-6 border border-slate-200 dark:border-slate-700 rounded overflow-hidden bg-white dark:bg-slate-950"
            role="group"
            aria-label="Rotate 2D plan view"
          >
            <button
              type="button"
              data-testid="rotate-2d-ccw"
              onClick={() => onRotateViewStep(-90)}
              title="Rotate 2D view 90° counter-clockwise (view only)"
              aria-label="Rotate 2D view 90 degrees counter-clockwise"
              className="h-full px-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              <RotateCcw className="w-3 h-3" />
            </button>
            {viewRotationDeg !== 0 && onResetViewRotation && (
              <button
                type="button"
                data-testid="rotate-2d-reset"
                onClick={onResetViewRotation}
                title="Reset 2D view orientation to 0°"
                aria-label={`Reset 2D view from ${viewRotationDeg} degrees to 0 degrees`}
                className="h-full px-1.5 border-l border-slate-200 dark:border-slate-800 bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-mono-nums font-semibold hover:bg-blue-100 dark:hover:bg-blue-900 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                {viewRotationDeg}°
              </button>
            )}
            <button
              type="button"
              data-testid="rotate-2d-cw"
              onClick={() => onRotateViewStep(90)}
              title="Rotate 2D view 90° clockwise (view only)"
              aria-label="Rotate 2D view 90 degrees clockwise"
              className="h-full px-1.5 border-l border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              <RotateCw className="w-3 h-3" />
            </button>
          </div>
        )}

        <div className="h-3.5 w-px bg-slate-200 dark:bg-slate-700 hidden sm:block" />

        <button
          type="button"
          onClick={() => onUpdateSettings({ showGrid: !settings.showGrid })}
          title="Toggle Grid (G)"
          aria-pressed={settings.showGrid}
          className={`h-6 px-2 rounded border flex items-center gap-1 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
            settings.showGrid
              ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
              : 'border-slate-200 dark:border-slate-700 text-slate-500 hover:text-slate-700 dark:hover:text-slate-200'
          }`}
        >
          <Grid className="w-3 h-3" />
          <span>Grid</span>
        </button>

        <button
          type="button"
          onClick={() => onUpdateSettings({ snapEnabled: !settings.snapEnabled })}
          title="Toggle Snap (K)"
          aria-pressed={settings.snapEnabled}
          className={`h-6 px-2 rounded border flex items-center gap-1 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
            settings.snapEnabled
              ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
              : 'border-slate-200 dark:border-slate-700 text-slate-500 hover:text-slate-700 dark:hover:text-slate-200'
          }`}
        >
          <Magnet className="w-3 h-3" />
          <span>Snap</span>
        </button>

        <div
          className="flex items-center h-6 border border-slate-200 dark:border-slate-700 rounded overflow-hidden"
          role="group"
          aria-label="Preferred display unit"
        >
          {UNITS.map((u) => (
            <button
              key={u}
              type="button"
              onClick={() => onUpdateSettings({ preferredUnit: u })}
              aria-pressed={settings.preferredUnit === u}
              className={`h-full px-1.5 font-mono-nums cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                settings.preferredUnit === u
                  ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 font-semibold'
                  : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              {u}
            </button>
          ))}
        </div>

        {/* Drafting Options Popover (Grid spacing, Angle snap, Ortho, Auto-Dims) */}
        <div ref={draftWrapRef} className="relative">
          <button
            type="button"
            onClick={() => setDraftOpen((o) => !o)}
            aria-expanded={draftOpen}
            title="Drafting Precision & Snap Settings"
            className={`h-6 px-2 rounded border flex items-center gap-1 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
              draftOpen
                ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            <SlidersHorizontal className="w-3 h-3" />
            <span className="hidden md:inline">Drafting</span>
            <ChevronUp className="w-3 h-3" />
          </button>

          {draftOpen && (
            <div className="absolute bottom-full left-0 mb-2 w-60 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl p-2.5 space-y-2.5 z-50 text-xs">
              <div className="font-semibold text-[11px] text-slate-600 dark:text-slate-300">
                Drafting &amp; Precision
              </div>

              <label className="flex items-center justify-between gap-2">
                <span className="text-slate-500">Grid Spacing</span>
                <select
                  value={settings.gridSizeMm}
                  onChange={(e) => onUpdateSettings({ gridSizeMm: Number(e.target.value) as GridSizeMm })}
                  aria-label="Grid spacing"
                  className="px-2 py-1 font-mono-nums bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded cursor-pointer"
                >
                  {GRID_SIZES.map((g) => (
                    <option key={g.mm} value={g.mm}>
                      {g.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex items-center justify-between gap-2">
                <span className="text-slate-500">Angle Snap</span>
                <select
                  value={settings.angleSnapDeg}
                  onChange={(e) => onUpdateSettings({ angleSnapDeg: Number(e.target.value) as AngleSnapDeg })}
                  aria-label="Angle snap"
                  className="px-2 py-1 font-mono-nums bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded cursor-pointer"
                >
                  {ANGLE_SNAPS.map((a) => (
                    <option key={a.deg} value={a.deg}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex items-center justify-between gap-2 cursor-pointer">
                <span className="text-slate-600 dark:text-slate-300">Ortho 90° Mode</span>
                <input
                  type="checkbox"
                  checked={settings.orthoMode}
                  onChange={(e) => onUpdateSettings({ orthoMode: e.target.checked })}
                  className="accent-blue-600"
                />
              </label>

              <label className="flex items-center justify-between gap-2 cursor-pointer">
                <span className="text-slate-600 dark:text-slate-300 flex items-center gap-1">
                  <Ruler className="w-3 h-3 text-slate-400" />
                  Automatic Dimensions
                </span>
                <input
                  type="checkbox"
                  checked={settings.autoDimensions}
                  onChange={(e) => onUpdateSettings({ autoDimensions: e.target.checked })}
                  className="accent-blue-600"
                />
              </label>
            </div>
          )}
        </div>
      </div>

      {/* Right: 3D Cutaway controls (when 3D active) + Metric Cursor Coordinates */}
      <div className="flex items-center gap-1.5 shrink-0">
        {show3dControls && (
          <div className="flex items-center gap-1.5 border-r border-slate-200 dark:border-slate-700 pr-2">
            <button
              type="button"
              onClick={() => onUpdateSettings({ cutawayEnabled: !settings.cutawayEnabled })}
              aria-pressed={settings.cutawayEnabled}
              className={`h-6 px-2 rounded border flex items-center gap-1 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                settings.cutawayEnabled
                  ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                  : 'border-slate-200 dark:border-slate-700 text-slate-500'
              }`}
            >
              <Scissors className="w-3 h-3" />
              <span>Cutaway</span>
            </button>
            {settings.cutawayEnabled && (
              <div className="flex items-center gap-1">
                <input
                  type="range"
                  min={300}
                  max={2800}
                  step={50}
                  value={settings.cutawayHeightMm}
                  onChange={(e) => onUpdateSettings({ cutawayHeightMm: Number(e.target.value) })}
                  aria-label="Cutaway height"
                  className="w-16 accent-blue-600"
                />
                <span className="font-mono-nums text-slate-600 dark:text-slate-300 w-11">
                  {(settings.cutawayHeightMm / 1000).toFixed(2)} m
                </span>
              </div>
            )}
            <button
              type="button"
              onClick={() => onUpdateSettings({ hideFrontWalls: !settings.hideFrontWalls })}
              aria-pressed={settings.hideFrontWalls}
              className={`h-6 px-2 rounded border flex items-center gap-1 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                settings.hideFrontWalls
                  ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                  : 'border-slate-200 dark:border-slate-700 text-slate-500'
              }`}
            >
              <EyeOff className="w-3 h-3" />
              <span className="hidden md:inline">Auto-Hide Walls</span>
            </button>
          </div>
        )}

        <div
          className="h-6 flex items-center font-mono-nums text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-2 min-w-[136px] justify-center"
          aria-label="Cursor coordinates"
        >
          X {(cursorCoordsMm.x / 1000).toFixed(2)} m · Y {(cursorCoordsMm.y / 1000).toFixed(2)} m
        </div>
      </div>
    </footer>
  );
};
