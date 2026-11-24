import React, { useEffect, useRef } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ClipboardPaste,
  Copy,
  FlipHorizontal2,
  Link2,
  Lock,
  Maximize2,
  RotateCw,
  Trash2,
  Unlink,
  Unlock,
} from 'lucide-react';

export type ContextMenuState =
  | {
      kind: 'object';
      clientX: number;
      clientY: number;
      isLocked: boolean;
      canDuplicate: boolean;
      canMirror: boolean;
      canRotate: boolean;
      canSelectAbove: boolean;
      canSelectBelow: boolean;
      aboveName?: string;
      belowName?: string;
      canConsolidateWalls?: boolean;
      canSeparateWalls?: boolean;
    }
  | {
      kind: 'empty';
      clientX: number;
      clientY: number;
      canPaste: boolean;
    };

interface CanvasContextMenuProps {
  menu: ContextMenuState | null;
  onClose: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
  onToggleLock?: () => void;
  onMirror?: () => void;
  onRotate90?: () => void;
  onSelectLayerAbove?: () => void;
  onSelectLayerBelow?: () => void;
  onConsolidateWalls?: () => void;
  onSeparateWalls?: () => void;
  onPaste?: () => void;
  onFitToScreen?: () => void;
}

export const CanvasContextMenu: React.FC<CanvasContextMenuProps> = ({
  menu,
  onClose,
  onDuplicate,
  onDelete,
  onToggleLock,
  onMirror,
  onRotate90,
  onSelectLayerAbove,
  onSelectLayerBelow,
  onConsolidateWalls,
  onSeparateWalls,
  onPaste,
  onFitToScreen,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  const estW = 208;
  const estH = menu.kind === 'object' ? 270 : 96;
  const left = Math.max(8, Math.min(menu.clientX, (typeof window !== 'undefined' ? window.innerWidth : 1200) - estW - 8));
  const top = Math.max(8, Math.min(menu.clientY, (typeof window !== 'undefined' ? window.innerHeight : 800) - estH - 8));

  const itemCls =
    'w-full px-2.5 py-1.5 text-left text-xs flex items-center gap-2 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 disabled:pointer-events-none cursor-pointer transition-colors';

  return (
    <div
      ref={menuRef}
      role="menu"
      data-testid="canvas-context-menu"
      style={{ left: `${left}px`, top: `${top}px` }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className="fixed z-50 w-[204px] py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl select-none"
    >
      {menu.kind === 'object' ? (
        <>
          <button
            type="button"
            role="menuitem"
            data-testid="ctx-duplicate"
            disabled={!menu.canDuplicate}
            onClick={() => {
              onDuplicate?.();
              onClose();
            }}
            className={itemCls}
          >
            <Copy className="w-3.5 h-3.5 shrink-0 text-slate-500 dark:text-slate-400" />
            <span>Duplicate</span>
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="ctx-delete"
            onClick={() => {
              onDelete?.();
              onClose();
            }}
            className={`${itemCls} text-red-600 dark:text-red-400`}
          >
            <Trash2 className="w-3.5 h-3.5 shrink-0" />
            <span>Delete</span>
          </button>
          <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
          <button
            type="button"
            role="menuitem"
            data-testid="ctx-lock"
            onClick={() => {
              onToggleLock?.();
              onClose();
            }}
            className={itemCls}
          >
            {menu.isLocked ? (
              <Unlock className="w-3.5 h-3.5 shrink-0 text-amber-500" />
            ) : (
              <Lock className="w-3.5 h-3.5 shrink-0 text-slate-500 dark:text-slate-400" />
            )}
            <span>{menu.isLocked ? 'Unlock' : 'Lock'}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="ctx-mirror"
            disabled={!menu.canMirror || menu.isLocked}
            onClick={() => {
              onMirror?.();
              onClose();
            }}
            className={itemCls}
          >
            <FlipHorizontal2 className="w-3.5 h-3.5 shrink-0 text-slate-500 dark:text-slate-400" />
            <span>Mirror</span>
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="ctx-rotate90"
            disabled={!menu.canRotate || menu.isLocked}
            onClick={() => {
              onRotate90?.();
              onClose();
            }}
            className={itemCls}
          >
            <RotateCw className="w-3.5 h-3.5 shrink-0 text-slate-500 dark:text-slate-400" />
            <span>Rotate 90°</span>
          </button>
          <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
          <button
            type="button"
            role="menuitem"
            data-testid="ctx-layer-above"
            disabled={!menu.canSelectAbove}
            onClick={() => {
              onSelectLayerAbove?.();
              onClose();
            }}
            className={itemCls}
          >
            <ArrowUp className="w-3.5 h-3.5 shrink-0 text-slate-500 dark:text-slate-400" />
            <span className="truncate">
              {menu.aboveName ? `Select layer above (${menu.aboveName})` : 'Select layer above'}
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="ctx-layer-below"
            disabled={!menu.canSelectBelow}
            onClick={() => {
              onSelectLayerBelow?.();
              onClose();
            }}
            className={itemCls}
          >
            <ArrowDown className="w-3.5 h-3.5 shrink-0 text-slate-500 dark:text-slate-400" />
            <span className="truncate">
              {menu.belowName ? `Select layer below (${menu.belowName})` : 'Select layer below'}
            </span>
          </button>
          {(menu.canConsolidateWalls || menu.canSeparateWalls) && (
            <>
              <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
              {menu.canConsolidateWalls && (
                <button
                  type="button"
                  role="menuitem"
                  data-testid="ctx-consolidate-walls"
                  onClick={() => {
                    onConsolidateWalls?.();
                    onClose();
                  }}
                  className={itemCls}
                >
                  <Link2 className="w-3.5 h-3.5 shrink-0 text-blue-600 dark:text-blue-400" />
                  <span>Consolidate wall run</span>
                </button>
              )}
              {menu.canSeparateWalls && (
                <button
                  type="button"
                  role="menuitem"
                  data-testid="ctx-separate-walls"
                  onClick={() => {
                    onSeparateWalls?.();
                    onClose();
                  }}
                  className={itemCls}
                >
                  <Unlink className="w-3.5 h-3.5 shrink-0 text-slate-500 dark:text-slate-400" />
                  <span>Separate wall run</span>
                </button>
              )}
            </>
          )}
        </>
      ) : (
        <>
          <button
            type="button"
            role="menuitem"
            data-testid="ctx-paste"
            disabled={!menu.canPaste}
            onClick={() => {
              onPaste?.();
              onClose();
            }}
            className={itemCls}
          >
            <ClipboardPaste className="w-3.5 h-3.5 shrink-0 text-slate-500 dark:text-slate-400" />
            <span>Paste</span>
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="ctx-fit"
            onClick={() => {
              onFitToScreen?.();
              onClose();
            }}
            className={itemCls}
          >
            <Maximize2 className="w-3.5 h-3.5 shrink-0 text-slate-500 dark:text-slate-400" />
            <span>Fit to screen</span>
          </button>
        </>
      )}
    </div>
  );
};
