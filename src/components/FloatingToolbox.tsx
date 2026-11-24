import React, { useEffect, useRef, useState } from 'react';
import {
  AppWindow,
  ArchiveRestore,
  Armchair,
  Box,
  ChevronUp,
  DoorOpen,
  Hand,
  Hexagon,
  MousePointer,
  MoveUpRight,
  PenTool,
  Ruler,
  Scissors,
  SlidersHorizontal,
  Spline,
  Type,
} from 'lucide-react';
import { DoorSubtype, EditorTool, Opening, RailingStyleId, WindowSubtype } from '../types/plan';
import { formatKeyLabel, KeybindMap } from '../utils/keybinds';
import { RAILING_STYLES } from '../utils/railings';

interface FloatingToolboxProps {
  activeTool: EditorTool;
  pendingOpeningSpec: { category: Opening['category']; subtype: Opening['subtype'] };
  activeRailingStyle: RailingStyleId;
  keybinds: KeybindMap;
  onSelectTool: (tool: EditorTool) => void;
  onSelectOpeningSpec: (spec: { category: Opening['category']; subtype: Opening['subtype'] }) => void;
  onSelectRailingStyle: (style: RailingStyleId) => void;
  onOpenLibrary?: () => void;
}

const DOOR_SUBTYPES: Array<{ id: DoorSubtype; label: string }> = [
  { id: 'single', label: 'Single Swing' },
  { id: 'double', label: 'Double Swing' },
  { id: 'french', label: 'French Double' },
  { id: 'balcony_single', label: 'Balcony Single (PVC)' },
  { id: 'balcony_double', label: 'Balcony Double (PVC)' },
  { id: 'pivot', label: 'Pivot Door' },
  { id: 'sliding', label: 'Sliding' },
  { id: 'pocket', label: 'Pocket' },
  { id: 'bifold', label: 'Bifold' },
  { id: 'entrance', label: 'Entrance' },
  { id: 'garage', label: 'Garage' },
  { id: 'doorframe', label: 'Doorframe Only' },
];

const WINDOW_SUBTYPES: Array<{ id: WindowSubtype; label: string }> = [
  { id: 'single', label: 'Single' },
  { id: 'double', label: 'Double' },
  { id: 'triple', label: 'Triple' },
  { id: 'euro_single', label: 'Euro Tilt & Turn' },
  { id: 'euro_double', label: 'Euro Double (PVC)' },
  { id: 'euro_triple', label: 'Euro Panoramic 3' },
  { id: 'euro_terrace', label: 'Euro Terrace (PVC)' },
  { id: 'casement', label: 'Casement' },
  { id: 'awning', label: 'Awning' },
  { id: 'clerestory', label: 'Clerestory' },
  { id: 'fixed', label: 'Fixed' },
  { id: 'sliding', label: 'Sliding' },
  { id: 'bay', label: 'Bay' },
  { id: 'corner', label: 'Corner' },
  { id: 'floor_to_ceiling', label: 'Full Height' },
  { id: 'round', label: 'Round' },
];

const ARCH_SUBTYPES: Array<{ id: Opening['subtype']; label: string }> = [
  { id: 'round_arch', label: 'Round Arch' },
  { id: 'pointed_arch', label: 'Pointed Arch' },
  { id: 'segmental_arch', label: 'Segmental Arch' },
  { id: 'plain_opening', label: 'Plain Opening' },
  { id: 'frame_only', label: 'Cased Frame' },
  { id: 'passthrough', label: 'Passthrough' },
];

type PopoverGroup = 'wall' | 'door' | 'window' | 'arch' | 'railing' | 'measure' | 'annotate' | null;

interface HoverHintState {
  label: string;
  shortcut?: string;
  anchorX: number;
}

const RailingToolIcon: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="w-3.5 h-3.5 shrink-0"
    aria-hidden="true"
  >
    <path d="M3 7h18" />
    <path d="M3 19h18" />
    <path d="M5 7v12" />
    <path d="M12 7v12" />
    <path d="M19 7v12" />
  </svg>
);

export const FloatingToolbox: React.FC<FloatingToolboxProps> = ({
  activeTool,
  pendingOpeningSpec,
  activeRailingStyle,
  keybinds,
  onSelectTool,
  onSelectOpeningSpec,
  onSelectRailingStyle,
  onOpenLibrary,
}) => {
  const [openMenu, setOpenMenu] = useState<PopoverGroup>(null);
  const [hoverHint, setHoverHint] = useState<HoverHintState | null>(null);
  const dockRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (dockRef.current && !dockRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpenMenu(null);
        setHoverHint(null);
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const showHintFor = (el: HTMLElement, label: string, shortcut?: string) => {
    const dockEl = dockRef.current;
    if (!dockEl) return;
    const dockRect = dockEl.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    setHoverHint({
      label,
      shortcut,
      anchorX: elRect.left - dockRect.left + elRect.width / 2,
    });
  };

  const clearHint = () => setHoverHint(null);

  const isWallGroup =
    activeTool === 'wall' || activeTool === 'wall_arc' || activeTool === 'split_wall';
  const isMeasureGroup =
    activeTool === 'measure_distance' || activeTool === 'measure_area';
  const isAnnotateGroup =
    activeTool === 'text' || activeTool === 'arrow' || activeTool === 'section_line';

  const wallGroupKey =
    activeTool === 'wall_arc'
      ? formatKeyLabel(keybinds.wall_arc)
      : activeTool === 'split_wall'
        ? formatKeyLabel(keybinds.split_wall)
        : formatKeyLabel(keybinds.wall);

  const wallGroupLabel =
    activeTool === 'wall_arc'
      ? 'Curved Arc Wall'
      : activeTool === 'split_wall'
        ? 'Split Wall'
        : 'Draw Wall';

  const measureGroupKey =
    activeTool === 'measure_area'
      ? formatKeyLabel(keybinds.measure_area)
      : formatKeyLabel(keybinds.measure_distance);

  const measureGroupLabel =
    activeTool === 'measure_area' ? 'Area Finder' : 'Measure Distance';

  const annotateGroupKey =
    activeTool === 'arrow'
      ? formatKeyLabel(keybinds.arrow)
      : activeTool === 'section_line'
        ? formatKeyLabel(keybinds.section_line)
        : formatKeyLabel(keybinds.text);

  const annotateGroupLabel =
    activeTool === 'arrow'
      ? 'Arrow Callout'
      : activeTool === 'section_line'
        ? 'Section Cut'
        : 'Text Note';

  const iconButtonClass = (active: boolean) =>
    `h-7 w-[26px] rounded flex items-center justify-center transition-colors cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
      active
        ? 'bg-blue-600 text-white shadow-xs'
        : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
    }`;

  const splitIconClass = (active: boolean) =>
    `h-7 w-[24px] rounded-l flex items-center justify-center transition-colors cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
      active
        ? 'bg-blue-600 text-white shadow-xs'
        : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
    }`;

  const chevronButtonClass = (active: boolean) =>
    `h-7 w-3 rounded-r flex items-center justify-center transition-colors cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
      active
        ? 'bg-blue-700 text-white'
        : 'text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-200'
    }`;

  return (
    <div
      ref={dockRef}
      data-testid="floating-toolbox"
      role="toolbar"
      aria-label="Drawing and measurement tools"
      onMouseLeave={clearHint}
      className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 max-w-[calc(100%-24px)] flex flex-nowrap items-center gap-0.5 px-1.5 py-1 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg shadow-slate-900/10 dark:shadow-black/50 select-none"
    >
      {/* Non-shifting hover hint positioned out-of-flow directly above hovered icon */}
      {hoverHint && !openMenu && (
        <div
          role="tooltip"
          data-testid="toolbox-hover-hint"
          style={{ left: `${hoverHint.anchorX}px` }}
          className="pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 px-2 py-1 rounded bg-slate-900 dark:bg-slate-800 text-white text-[11px] font-medium whitespace-nowrap shadow-md flex items-center gap-1.5 z-50 transition-opacity duration-75"
        >
          <span>{hoverHint.label}</span>
          {hoverHint.shortcut && (
            <kbd className="px-1 py-0.5 rounded bg-white/15 text-[9.5px] font-mono-nums text-slate-200 leading-none">
              {hoverHint.shortcut}
            </kbd>
          )}
        </div>
      )}

      {/* Group 1: Select & Navigate */}
      <button
        type="button"
        aria-label={`Select (${formatKeyLabel(keybinds.select)})`}
        aria-pressed={activeTool === 'select'}
        onMouseEnter={(e) => showHintFor(e.currentTarget, 'Select', formatKeyLabel(keybinds.select))}
        onFocus={(e) => showHintFor(e.currentTarget, 'Select', formatKeyLabel(keybinds.select))}
        onBlur={clearHint}
        onClick={() => {
          onSelectTool('select');
          setOpenMenu(null);
        }}
        className={iconButtonClass(activeTool === 'select')}
      >
        <MousePointer className="w-3.5 h-3.5 shrink-0" />
      </button>

      <button
        type="button"
        aria-label={`Pan (${formatKeyLabel(keybinds.pan)})`}
        aria-pressed={activeTool === 'pan'}
        onMouseEnter={(e) => showHintFor(e.currentTarget, 'Pan View', formatKeyLabel(keybinds.pan))}
        onFocus={(e) => showHintFor(e.currentTarget, 'Pan View', formatKeyLabel(keybinds.pan))}
        onBlur={clearHint}
        onClick={() => {
          onSelectTool('pan');
          setOpenMenu(null);
        }}
        className={iconButtonClass(activeTool === 'pan')}
      >
        <Hand className="w-3.5 h-3.5 shrink-0" />
      </button>

      <div className="h-4 w-px bg-slate-200 dark:bg-slate-700 mx-0.5 shrink-0" />

      {/* Group 2: Walls & Openings */}
      <div className="relative flex items-center shrink-0">
        <button
          type="button"
          aria-label={`${wallGroupLabel} (${wallGroupKey})`}
          aria-pressed={isWallGroup}
          onMouseEnter={(e) => showHintFor(e.currentTarget, wallGroupLabel, wallGroupKey)}
          onFocus={(e) => showHintFor(e.currentTarget, wallGroupLabel, wallGroupKey)}
          onBlur={clearHint}
          onClick={() => {
            onSelectTool(isWallGroup ? activeTool : 'wall');
            setOpenMenu(null);
          }}
          className={splitIconClass(isWallGroup)}
        >
          {activeTool === 'wall_arc' ? (
            <Spline className="w-3.5 h-3.5 shrink-0" />
          ) : activeTool === 'split_wall' ? (
            <Scissors className="w-3.5 h-3.5 shrink-0" />
          ) : (
            <PenTool className="w-3.5 h-3.5 shrink-0" />
          )}
        </button>
        <button
          type="button"
          aria-label="Wall options"
          aria-haspopup="menu"
          aria-expanded={openMenu === 'wall'}
          onMouseEnter={(e) => showHintFor(e.currentTarget, 'Wall Options')}
          onFocus={(e) => showHintFor(e.currentTarget, 'Wall Options')}
          onBlur={clearHint}
          onClick={() => {
            clearHint();
            setOpenMenu((m) => (m === 'wall' ? null : 'wall'));
          }}
          className={chevronButtonClass(isWallGroup)}
        >
          <ChevronUp className="w-2.5 h-2.5" />
        </button>

        {openMenu === 'wall' && (
          <div
            role="menu"
            className="absolute bottom-full left-0 mb-2 w-48 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl py-1 text-xs z-40"
          >
            {[
              { id: 'wall' as const, label: 'Straight Wall', key: keybinds.wall, Icon: PenTool },
              { id: 'wall_arc' as const, label: 'Curved Arc Wall', key: keybinds.wall_arc, Icon: Spline },
              { id: 'split_wall' as const, label: 'Split Wall Point', key: keybinds.split_wall, Icon: Scissors },
            ].map(({ id, label, key, Icon }) => (
              <button
                key={id}
                type="button"
                role="menuitemradio"
                aria-checked={activeTool === id}
                onClick={() => {
                  onSelectTool(id);
                  setOpenMenu(null);
                }}
                className={`w-full px-3 py-1.5 text-left flex items-center justify-between gap-2 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer ${
                  activeTool === id ? 'font-semibold text-blue-600 dark:text-blue-400' : ''
                }`}
              >
                <span className="flex items-center gap-2">
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  <span>{label}</span>
                </span>
                <kbd className="text-[10px] font-mono-nums text-slate-400">{formatKeyLabel(key)}</kbd>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="relative flex items-center shrink-0">
        <button
          type="button"
          aria-label={`Door (${formatKeyLabel(keybinds.door)})`}
          aria-pressed={activeTool === 'door'}
          onMouseEnter={(e) => showHintFor(e.currentTarget, 'Door', formatKeyLabel(keybinds.door))}
          onFocus={(e) => showHintFor(e.currentTarget, 'Door', formatKeyLabel(keybinds.door))}
          onBlur={clearHint}
          onClick={() => {
            if (pendingOpeningSpec.category !== 'door') {
              onSelectOpeningSpec({ category: 'door', subtype: 'single' });
            }
            onSelectTool('door');
            setOpenMenu(null);
          }}
          className={splitIconClass(activeTool === 'door')}
        >
          <DoorOpen className="w-3.5 h-3.5 shrink-0" />
        </button>
        <button
          type="button"
          aria-label="Door type options"
          aria-haspopup="menu"
          aria-expanded={openMenu === 'door'}
          onMouseEnter={(e) => showHintFor(e.currentTarget, 'Door Types')}
          onFocus={(e) => showHintFor(e.currentTarget, 'Door Types')}
          onBlur={clearHint}
          onClick={() => {
            clearHint();
            setOpenMenu((m) => (m === 'door' ? null : 'door'));
          }}
          className={chevronButtonClass(activeTool === 'door')}
        >
          <ChevronUp className="w-2.5 h-2.5" />
        </button>

        {openMenu === 'door' && (
          <div
            role="menu"
            className="absolute bottom-full left-0 mb-2 w-44 max-h-72 overflow-y-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl py-1 text-xs z-40"
          >
            {DOOR_SUBTYPES.map((d) => {
              const selected =
                activeTool === 'door' &&
                pendingOpeningSpec.category === 'door' &&
                pendingOpeningSpec.subtype === d.id;
              return (
                <button
                  key={d.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => {
                    onSelectOpeningSpec({ category: 'door', subtype: d.id });
                    onSelectTool('door');
                    setOpenMenu(null);
                  }}
                  className={`w-full px-3 py-1.5 text-left hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer ${
                    selected ? 'font-semibold text-blue-600 dark:text-blue-400' : ''
                  }`}
                >
                  {d.label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="relative flex items-center shrink-0">
        <button
          type="button"
          aria-label={`Window (${formatKeyLabel(keybinds.window)})`}
          aria-pressed={activeTool === 'window'}
          onMouseEnter={(e) => showHintFor(e.currentTarget, 'Window', formatKeyLabel(keybinds.window))}
          onFocus={(e) => showHintFor(e.currentTarget, 'Window', formatKeyLabel(keybinds.window))}
          onBlur={clearHint}
          onClick={() => {
            if (pendingOpeningSpec.category !== 'window') {
              onSelectOpeningSpec({ category: 'window', subtype: 'double' });
            }
            onSelectTool('window');
            setOpenMenu(null);
          }}
          className={splitIconClass(activeTool === 'window')}
        >
          <AppWindow className="w-3.5 h-3.5 shrink-0" />
        </button>
        <button
          type="button"
          aria-label="Window type options"
          aria-haspopup="menu"
          aria-expanded={openMenu === 'window'}
          onMouseEnter={(e) => showHintFor(e.currentTarget, 'Window Types')}
          onFocus={(e) => showHintFor(e.currentTarget, 'Window Types')}
          onBlur={clearHint}
          onClick={() => {
            clearHint();
            setOpenMenu((m) => (m === 'window' ? null : 'window'));
          }}
          className={chevronButtonClass(activeTool === 'window')}
        >
          <ChevronUp className="w-2.5 h-2.5" />
        </button>

        {openMenu === 'window' && (
          <div
            role="menu"
            className="absolute bottom-full left-0 mb-2 w-44 max-h-72 overflow-y-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl py-1 text-xs z-40"
          >
            {WINDOW_SUBTYPES.map((w) => {
              const selected =
                activeTool === 'window' &&
                pendingOpeningSpec.category === 'window' &&
                pendingOpeningSpec.subtype === w.id;
              return (
                <button
                  key={w.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => {
                    onSelectOpeningSpec({ category: 'window', subtype: w.id });
                    onSelectTool('window');
                    setOpenMenu(null);
                  }}
                  className={`w-full px-3 py-1.5 text-left hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer ${
                    selected ? 'font-semibold text-blue-600 dark:text-blue-400' : ''
                  }`}
                >
                  {w.label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="relative flex items-center shrink-0">
        <button
          type="button"
          aria-label={`Arch (${formatKeyLabel(keybinds.arch)})`}
          aria-pressed={activeTool === 'arch'}
          onMouseEnter={(e) => showHintFor(e.currentTarget, 'Arch / Opening', formatKeyLabel(keybinds.arch))}
          onFocus={(e) => showHintFor(e.currentTarget, 'Arch / Opening', formatKeyLabel(keybinds.arch))}
          onBlur={clearHint}
          onClick={() => {
            if (pendingOpeningSpec.category !== 'arch') {
              onSelectOpeningSpec({ category: 'arch', subtype: 'round_arch' });
            }
            onSelectTool('arch');
            setOpenMenu(null);
          }}
          className={splitIconClass(activeTool === 'arch')}
        >
          <ArchiveRestore className="w-3.5 h-3.5 shrink-0" />
        </button>
        <button
          type="button"
          aria-label="Arch type options"
          aria-haspopup="menu"
          aria-expanded={openMenu === 'arch'}
          onMouseEnter={(e) => showHintFor(e.currentTarget, 'Arch Types')}
          onFocus={(e) => showHintFor(e.currentTarget, 'Arch Types')}
          onBlur={clearHint}
          onClick={() => {
            clearHint();
            setOpenMenu((m) => (m === 'arch' ? null : 'arch'));
          }}
          className={chevronButtonClass(activeTool === 'arch')}
        >
          <ChevronUp className="w-2.5 h-2.5" />
        </button>

        {openMenu === 'arch' && (
          <div
            role="menu"
            className="absolute bottom-full left-0 mb-2 w-40 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl py-1 text-xs z-40"
          >
            {ARCH_SUBTYPES.map((a) => {
              const selected =
                activeTool === 'arch' &&
                pendingOpeningSpec.category === 'arch' &&
                pendingOpeningSpec.subtype === a.id;
              return (
                <button
                  key={a.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => {
                    onSelectOpeningSpec({ category: 'arch', subtype: a.id });
                    onSelectTool('arch');
                    setOpenMenu(null);
                  }}
                  className={`w-full px-3 py-1.5 text-left hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer ${
                    selected ? 'font-semibold text-blue-600 dark:text-blue-400' : ''
                  }`}
                >
                  {a.label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="h-4 w-px bg-slate-200 dark:bg-slate-700 mx-0.5 shrink-0" />

      {/* Group 3: Architecture & Furniture Library */}
      <button
        type="button"
        aria-label={`Chimney (${formatKeyLabel(keybinds.chimney)})`}
        aria-pressed={activeTool === 'chimney'}
        onMouseEnter={(e) => showHintFor(e.currentTarget, 'Chimney / Box', formatKeyLabel(keybinds.chimney))}
        onFocus={(e) => showHintFor(e.currentTarget, 'Chimney / Box', formatKeyLabel(keybinds.chimney))}
        onBlur={clearHint}
        onClick={() => {
          onSelectTool('chimney');
          setOpenMenu(null);
        }}
        className={iconButtonClass(activeTool === 'chimney')}
      >
        <Box className="w-3.5 h-3.5 shrink-0" />
      </button>

      <div className="relative flex items-center shrink-0">
        <button
          type="button"
          data-testid="toolbox-railing-btn"
          aria-label={`Railing (${formatKeyLabel(keybinds.railing)})`}
          aria-pressed={activeTool === 'railing'}
          onMouseEnter={(e) => showHintFor(e.currentTarget, 'Draw Railing', formatKeyLabel(keybinds.railing))}
          onFocus={(e) => showHintFor(e.currentTarget, 'Draw Railing', formatKeyLabel(keybinds.railing))}
          onBlur={clearHint}
          onClick={() => {
            onSelectTool('railing');
            setOpenMenu(null);
          }}
          className={splitIconClass(activeTool === 'railing')}
        >
          <RailingToolIcon />
        </button>
        <button
          type="button"
          aria-label="Railing style options"
          aria-haspopup="menu"
          aria-expanded={openMenu === 'railing'}
          onMouseEnter={(e) => showHintFor(e.currentTarget, 'Railing Styles')}
          onFocus={(e) => showHintFor(e.currentTarget, 'Railing Styles')}
          onBlur={clearHint}
          onClick={() => {
            clearHint();
            setOpenMenu((m) => (m === 'railing' ? null : 'railing'));
          }}
          className={chevronButtonClass(activeTool === 'railing')}
        >
          <ChevronUp className="w-2.5 h-2.5" />
        </button>

        {openMenu === 'railing' && (
          <div
            role="menu"
            className="absolute bottom-full left-0 mb-2 w-52 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl py-1 text-xs z-40"
          >
            <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              Railing Drawing Style
            </div>
            {RAILING_STYLES.map((st) => {
              const selected = activeRailingStyle === st.id;
              return (
                <button
                  key={st.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => {
                    onSelectRailingStyle(st.id);
                    onSelectTool('railing');
                    setOpenMenu(null);
                  }}
                  className={`w-full px-3 py-1.5 text-left hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer flex items-center justify-between gap-2 ${
                    selected ? 'font-semibold text-blue-600 dark:text-blue-400' : ''
                  }`}
                >
                  <span className="truncate">{st.label}</span>
                  {st.id === 'glass_panel' && (
                    <span className="text-[9px] text-slate-400 shrink-0">Default</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {onOpenLibrary && (
        <button
          type="button"
          onMouseEnter={(e) => showHintFor(e.currentTarget, 'Furniture Library')}
          onFocus={(e) => showHintFor(e.currentTarget, 'Furniture Library')}
          onBlur={clearHint}
          onClick={() => {
            onOpenLibrary();
            setOpenMenu(null);
          }}
          aria-label="Open Furniture Library"
          className={iconButtonClass(false)}
        >
          <Armchair className="w-3.5 h-3.5 shrink-0" />
        </button>
      )}

      <div className="h-4 w-px bg-slate-200 dark:bg-slate-700 mx-0.5 shrink-0" />

      {/* Group 4: Measure & Annotate */}
      <div className="relative flex items-center shrink-0">
        <button
          type="button"
          aria-label={`${measureGroupLabel} (${measureGroupKey})`}
          aria-pressed={isMeasureGroup}
          onMouseEnter={(e) => showHintFor(e.currentTarget, measureGroupLabel, measureGroupKey)}
          onFocus={(e) => showHintFor(e.currentTarget, measureGroupLabel, measureGroupKey)}
          onBlur={clearHint}
          onClick={() => {
            onSelectTool(isMeasureGroup ? activeTool : 'measure_distance');
            setOpenMenu(null);
          }}
          className={splitIconClass(isMeasureGroup)}
        >
          {activeTool === 'measure_area' ? (
            <Hexagon className="w-3.5 h-3.5 shrink-0" />
          ) : (
            <Ruler className="w-3.5 h-3.5 shrink-0" />
          )}
        </button>
        <button
          type="button"
          aria-label="Measurement options"
          aria-haspopup="menu"
          aria-expanded={openMenu === 'measure'}
          onMouseEnter={(e) => showHintFor(e.currentTarget, 'Measure Options')}
          onFocus={(e) => showHintFor(e.currentTarget, 'Measure Options')}
          onBlur={clearHint}
          onClick={() => {
            clearHint();
            setOpenMenu((m) => (m === 'measure' ? null : 'measure'));
          }}
          className={chevronButtonClass(isMeasureGroup)}
        >
          <ChevronUp className="w-2.5 h-2.5" />
        </button>

        {openMenu === 'measure' && (
          <div
            role="menu"
            className="absolute bottom-full right-0 mb-2 w-48 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl py-1 text-xs z-40"
          >
            {[
              { id: 'measure_distance' as const, label: 'Measure Distance', key: keybinds.measure_distance, Icon: Ruler },
              { id: 'measure_area' as const, label: 'Area Finder', key: keybinds.measure_area, Icon: Hexagon },
            ].map(({ id, label, key, Icon }) => (
              <button
                key={id}
                type="button"
                role="menuitemradio"
                aria-checked={activeTool === id}
                onClick={() => {
                  onSelectTool(id);
                  setOpenMenu(null);
                }}
                className={`w-full px-3 py-1.5 text-left flex items-center justify-between gap-2 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer ${
                  activeTool === id ? 'font-semibold text-blue-600 dark:text-blue-400' : ''
                }`}
              >
                <span className="flex items-center gap-2">
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  <span>{label}</span>
                </span>
                <kbd className="text-[10px] font-mono-nums text-slate-400">{formatKeyLabel(key)}</kbd>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="relative flex items-center shrink-0">
        <button
          type="button"
          aria-label={`${annotateGroupLabel} (${annotateGroupKey})`}
          aria-pressed={isAnnotateGroup}
          onMouseEnter={(e) => showHintFor(e.currentTarget, annotateGroupLabel, annotateGroupKey)}
          onFocus={(e) => showHintFor(e.currentTarget, annotateGroupLabel, annotateGroupKey)}
          onBlur={clearHint}
          onClick={() => {
            onSelectTool(isAnnotateGroup ? activeTool : 'text');
            setOpenMenu(null);
          }}
          className={splitIconClass(isAnnotateGroup)}
        >
          {activeTool === 'arrow' ? (
            <MoveUpRight className="w-3.5 h-3.5 shrink-0" />
          ) : activeTool === 'section_line' ? (
            <SlidersHorizontal className="w-3.5 h-3.5 shrink-0" />
          ) : (
            <Type className="w-3.5 h-3.5 shrink-0" />
          )}
        </button>
        <button
          type="button"
          aria-label="Annotation options"
          aria-haspopup="menu"
          aria-expanded={openMenu === 'annotate'}
          onMouseEnter={(e) => showHintFor(e.currentTarget, 'Annotation Options')}
          onFocus={(e) => showHintFor(e.currentTarget, 'Annotation Options')}
          onBlur={clearHint}
          onClick={() => {
            clearHint();
            setOpenMenu((m) => (m === 'annotate' ? null : 'annotate'));
          }}
          className={chevronButtonClass(isAnnotateGroup)}
        >
          <ChevronUp className="w-2.5 h-2.5" />
        </button>

        {openMenu === 'annotate' && (
          <div
            role="menu"
            className="absolute bottom-full right-0 mb-2 w-48 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl py-1 text-xs z-40"
          >
            {[
              { id: 'text' as const, label: 'Text Note', key: keybinds.text, Icon: Type },
              { id: 'arrow' as const, label: 'Arrow Callout', key: keybinds.arrow, Icon: MoveUpRight },
              { id: 'section_line' as const, label: 'Section Cut', key: keybinds.section_line, Icon: SlidersHorizontal },
            ].map(({ id, label, key, Icon }) => (
              <button
                key={id}
                type="button"
                role="menuitemradio"
                aria-checked={activeTool === id}
                onClick={() => {
                  onSelectTool(id);
                  setOpenMenu(null);
                }}
                className={`w-full px-3 py-1.5 text-left flex items-center justify-between gap-2 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer ${
                  activeTool === id ? 'font-semibold text-blue-600 dark:text-blue-400' : ''
                }`}
              >
                <span className="flex items-center gap-2">
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  <span>{label}</span>
                </span>
                <kbd className="text-[10px] font-mono-nums text-slate-400">{formatKeyLabel(key)}</kbd>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
