import React, { useMemo, useState } from 'react';
import {
  Armchair,
  Building2,
  Calculator,
  ChevronRight,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Layers,
  Lock,
  Plus,
  Ruler,
  Search,
  Trash2,
  Unlock,
  Upload,
  Users,
} from 'lucide-react';
import {
  ArchElementType,
  CatalogTemplate,
  EditorTool,
  FurnitureCategory,
  Level,
  PersonPose,
  Project,
  RailingStyleId,
  SelectionTarget,
} from '../types/plan';
import { BUILTIN_CATALOG } from '../data/catalog';
import { RAILING_STYLES } from '../utils/railings';
import { RailingStyleThumb } from './RailingInspectorSection';
import { computeFurnitureBoundsMm, computeWallSurfaceAreaM2 } from '../utils/geometry';
import { resolveFurnitureMountingType } from '../utils/mounting';
import {
  generateDefaultTopViewFromParts,
  isValidSvgSource,
  parseSvgSourceToProjectedView,
  resolveEffectiveRepresentationMode,
} from '../utils/svgImport';
import {
  getEffectiveViewElements,
  renderFurnitureRepresentationView,
} from '../utils/svgRepresentationRenderer';
import { formatAreaM2, formatSmartMetric } from '../utils/units';

export type LeftPanelSection =
  | 'furniture'
  | 'architecture'
  | 'people'
  | 'structure'
  | 'schedules'
  | 'tracing';

interface LeftSidebarProps {
  project: Project;
  activeLevel: Level;
  selection: SelectionTarget[];
  activeSection?: LeftPanelSection;
  onSectionChange?: (section: LeftPanelSection) => void;
  onSelect: (targets: SelectionTarget[]) => void;
  onPlaceFurniture: (tpl: CatalogTemplate) => void;
  onPlacePerson: (pose: PersonPose, name: string, heightMm: number) => void;
  onPlaceArchElement: (type: ArchElementType, name: string) => void;
  onPlaceRailingPreset?: (styleId: RailingStyleId) => void;
  onUpdateLevel: (
    updater: (lvl: Level) => Level,
    recomputeRooms?: boolean,
    recordHistory?: boolean,
    label?: string,
    coalesceKey?: string
  ) => void;
  onOpenCustomBuilder: () => void;
  onOpenImporter: () => void;
  onRemoveCustomTemplate?: (tplId: string) => void;
  onToolChange: (tool: EditorTool) => void;
  onAddLevel: () => void;
  onSwitchLevel: (id: string) => void;
  onDeleteLevel: (id: string) => void;
}

interface ArchCatalogItem {
  type: ArchElementType;
  label: string;
  desc: string;
}

const ARCH_CATALOG_ITEMS: ArchCatalogItem[] = [
  { type: 'chimney', label: 'Chimney / Block', desc: 'Solid masonry shaft or chase' },
  { type: 'stairs_straight', label: 'Straight Stairs', desc: 'Linear stair flight with treads' },
  { type: 'stairs_l', label: 'L-Shape Stairs', desc: 'Quarter-turn landing stair' },
  { type: 'stairs_u', label: 'U-Turn Stairs', desc: '180° return landing stair' },
  { type: 'stairs_spiral', label: 'Spiral Stairs', desc: 'Compact helical winder stair' },
  { type: 'column_round', label: 'Round Column', desc: 'Cylindrical structural pillar' },
  { type: 'column_square', label: 'Square Column', desc: 'Square structural pillar' },
  { type: 'beam', label: 'Ceiling Beam', desc: 'Overhead structural beam' },
  { type: 'fireplace', label: 'Fireplace', desc: 'Hearth & firebox surround' },
  { type: 'platform', label: 'Podium / Platform', desc: 'Raised floor stage or plinth' },
  { type: 'balcony', label: 'Balcony Slab', desc: 'Cantilevered slab with railing' },
];

interface PeopleCatalogItem {
  pose: PersonPose;
  label: string;
  detail: string;
  h: number;
}

const PEOPLE_CATALOG_ITEMS: PeopleCatalogItem[] = [
  { pose: 'standing_man', label: 'Adult Man', detail: '178 cm · Standing', h: 1780 },
  { pose: 'standing_woman', label: 'Adult Woman', detail: '166 cm · Standing', h: 1660 },
  { pose: 'child', label: 'Child', detail: '122 cm · Standing', h: 1220 },
  { pose: 'seated', label: 'Seated Person', detail: '132 cm · Chair / Sofa', h: 1320 },
  { pose: 'walking', label: 'Walking Figure', detail: '174 cm · In Stride', h: 1740 },
  { pose: 'lying_back', label: 'Lying Down (Back)', detail: '175 cm · Bed / Lounge', h: 1750 },
  { pose: 'lying_side', label: 'Lying Down (Side)', detail: '172 cm · Bed / Sofa', h: 1720 },
];

const BUILTIN_CATEGORIES: Array<'All' | FurnitureCategory> = [
  'All',
  'Sofas & Seating',
  'Tables & Desks',
  'Beds & Bedroom',
  'Storage & Media',
  'Kitchen',
  'Bathroom',
  'Lighting',
  'Decor & Plants',
  'Outdoor',
];

const MOUNTING_SHORT: Record<string, string> = {
  floor: 'Floor',
  freestanding: 'Floor',
  wall: 'Wall',
  ceiling: 'Ceiling',
  surface: 'Surface',
};

const ArchThumb: React.FC<{ type: ArchElementType }> = ({ type }) => {
  return (
    <svg viewBox="0 0 120 56" className="w-full h-11 text-slate-700 dark:text-slate-200">
      {type === 'doorframe' && (
        <g>
          <line x1="8" y1="28" x2="26" y2="28" stroke="#94A3B8" strokeWidth="3" />
          <line x1="94" y1="28" x2="112" y2="28" stroke="#94A3B8" strokeWidth="3" />
          <rect x="26" y="16" width="10" height="24" rx="1" fill="currentColor" />
          <rect x="84" y="16" width="10" height="24" rx="1" fill="currentColor" />
          <line x1="36" y1="18" x2="84" y2="18" stroke="currentColor" strokeWidth="1.8" strokeDasharray="4 3" />
          <line x1="36" y1="38" x2="84" y2="38" stroke="currentColor" strokeWidth="1.8" strokeDasharray="4 3" />
          <line x1="36" y1="28" x2="84" y2="28" stroke="#64748B" strokeWidth="1" />
        </g>
      )}
      {type === 'chimney' && (
        <g>
          <rect x="34" y="12" width="52" height="32" fill="#E2E8F0" stroke="currentColor" strokeWidth="2.5" />
          <line x1="34" y1="12" x2="86" y2="44" stroke="#64748B" strokeWidth="1.2" />
          <line x1="86" y1="12" x2="34" y2="44" stroke="#64748B" strokeWidth="1.2" />
        </g>
      )}
      {type === 'stairs_straight' && (
        <g>
          <rect x="18" y="14" width="84" height="28" fill="#F8FAFC" stroke="currentColor" strokeWidth="2" />
          {[30, 42, 54, 66, 78, 90].map((x) => (
            <line key={x} x1={x} y1="14" x2={x} y2="42" stroke="currentColor" strokeWidth="1.4" />
          ))}
          <path d="M26 28 H94 M87 23 L94 28 L87 33" fill="none" stroke="#2563EB" strokeWidth="2" />
        </g>
      )}
      {type === 'stairs_l' && (
        <g>
          <path d="M20 10 H62 V28 H98 V46 H20 Z" fill="#F8FAFC" stroke="currentColor" strokeWidth="2" />
          <line x1="20" y1="22" x2="62" y2="22" stroke="currentColor" strokeWidth="1.2" />
          <line x1="74" y1="28" x2="74" y2="46" stroke="currentColor" strokeWidth="1.2" />
          <line x1="86" y1="28" x2="86" y2="46" stroke="currentColor" strokeWidth="1.2" />
        </g>
      )}
      {type === 'stairs_u' && (
        <g>
          <rect x="20" y="10" width="80" height="36" fill="#F8FAFC" stroke="currentColor" strokeWidth="2" />
          <line x1="20" y1="28" x2="72" y2="28" stroke="currentColor" strokeWidth="1.8" />
          <line x1="72" y1="10" x2="72" y2="46" stroke="currentColor" strokeWidth="1.2" />
          {[32, 46, 60].map((x) => (
            <g key={x}>
              <line x1={x} y1="10" x2={x} y2="28" stroke="currentColor" strokeWidth="1.2" />
              <line x1={x} y1="28" x2={x} y2="46" stroke="currentColor" strokeWidth="1.2" />
            </g>
          ))}
        </g>
      )}
      {type === 'stairs_spiral' && (
        <g>
          <circle cx="60" cy="28" r="20" fill="#F8FAFC" stroke="currentColor" strokeWidth="2" />
          <circle cx="60" cy="28" r="4" fill="currentColor" />
          {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
            const rad = (a * Math.PI) / 180;
            return (
              <line
                key={a}
                x1={60 + Math.cos(rad) * 4}
                y1={28 + Math.sin(rad) * 4}
                x2={60 + Math.cos(rad) * 20}
                y2={28 + Math.sin(rad) * 20}
                stroke="currentColor"
                strokeWidth="1.2"
              />
            );
          })}
        </g>
      )}
      {type === 'column_round' && (
        <circle cx="60" cy="28" r="16" fill="#E2E8F0" stroke="currentColor" strokeWidth="2.5" />
      )}
      {type === 'column_square' && (
        <rect x="44" y="12" width="32" height="32" fill="#E2E8F0" stroke="currentColor" strokeWidth="2.5" />
      )}
      {type === 'beam' && (
        <rect x="14" y="20" width="92" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="5 3" />
      )}
      {type === 'fireplace' && (
        <g>
          <rect x="24" y="12" width="72" height="32" fill="#CBD5E1" stroke="currentColor" strokeWidth="2.2" />
          <rect x="38" y="22" width="44" height="22" fill="#475569" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="60" cy="33" r="5" fill="#F97316" />
        </g>
      )}
      {type === 'platform' && (
        <g>
          <rect x="18" y="12" width="84" height="32" fill="#F1F5F9" stroke="currentColor" strokeWidth="2" />
          <rect x="24" y="17" width="72" height="22" fill="none" stroke="#64748B" strokeWidth="1.2" strokeDasharray="4 2" />
        </g>
      )}
      {type === 'balcony' && (
        <g>
          <rect x="18" y="12" width="84" height="32" fill="#F1F5F9" stroke="currentColor" strokeWidth="1.8" />
          <path d="M18 12 V44 H102 V12" fill="none" stroke="#2563EB" strokeWidth="2.8" />
        </g>
      )}
    </svg>
  );
};

const PersonThumb: React.FC<{ pose: PersonPose }> = ({ pose }) => {
  const isLying = pose === 'lying_back' || pose === 'lying_side';
  return (
    <svg viewBox="0 0 120 56" className="w-full h-11 text-slate-700 dark:text-slate-200">
      {isLying ? (
        <g>
          <rect
            x="22"
            y="14"
            width="76"
            height="28"
            rx="12"
            fill="#E2E8F0"
            stroke="currentColor"
            strokeWidth="2"
          />
          <circle cx="34" cy="28" r="8" fill="#F8FAFC" stroke="currentColor" strokeWidth="2" />
          {pose === 'lying_side' ? (
            <path d="M46 21 C60 19, 72 24, 90 22 M50 32 C64 35, 76 30, 88 33" stroke="#475569" strokeWidth="2" fill="none" />
          ) : (
            <line x1="46" y1="28" x2="90" y2="28" stroke="#64748B" strokeWidth="1.6" strokeDasharray="4 3" />
          )}
        </g>
      ) : (
        <g>
          <ellipse
            cx="60"
            cy="28"
            rx={pose === 'child' ? 14 : 20}
            ry={pose === 'seated' ? 14 : 11}
            fill="#E2E8F0"
            stroke="currentColor"
            strokeWidth="2"
          />
          {pose === 'walking' && (
            <>
              <circle cx="52" cy="17" r="4.5" fill="currentColor" />
              <circle cx="68" cy="39" r="4.5" fill="currentColor" />
            </>
          )}
          <circle cx="60" cy="28" r={pose === 'child' ? 6.5 : 8} fill="#F8FAFC" stroke="currentColor" strokeWidth="2" />
          <path d="M56 22 Q60 19 64 22" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </g>
      )}
    </svg>
  );
};

const CatalogThumb: React.FC<{ tpl: CatalogTemplate }> = ({ tpl }) => {
  const b = computeFurnitureBoundsMm(tpl.parts);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const spanW = Math.max(b.widthMm, 320);
  const spanD = Math.max(b.depthMm, 320);
  const pad = Math.max(spanW, spanD) * 0.16;
  const vb = `${cx - spanW / 2 - pad} ${cy - spanD / 2 - pad} ${spanW + pad * 2} ${spanD + pad * 2}`;
  const sw = Math.max(12, Math.max(spanW, spanD) * 0.014);
  const activeMode = resolveEffectiveRepresentationMode(tpl);
  let rep = tpl.representation;
  if (
    activeMode === 'default' &&
    !rep?.defaultViews?.top?.elements?.length &&
    typeof tpl.svgSource === 'string' &&
    isValidSvgSource(tpl.svgSource)
  ) {
    const parsed = parseSvgSourceToProjectedView(tpl.svgSource, b.widthMm, b.depthMm);
    if (parsed) {
      rep = {
        ...(rep ?? { mode: 'default' }),
        mode: 'default',
        defaultViews: { ...(rep?.defaultViews ?? {}), top: parsed.view },
      };
    }
  }
  const effectiveRep = rep && rep.mode !== activeMode ? { ...rep, mode: activeMode } : rep;
  const effective = getEffectiveViewElements(effectiveRep, 'top');
  if (effective.elements && effective.elements.length > 0 && effectiveRep) {
    const tvb = effective.autoView?.viewBox;
    const rcx = tvb ? tvb.minX + tvb.width / 2 : 0;
    const rcy = tvb ? tvb.minY + tvb.height / 2 : 0;
    const rSpanW = Math.max(tvb?.width ?? b.widthMm, 320);
    const rSpanH = Math.max(tvb?.height ?? b.depthMm, 320);
    const rPad = Math.max(rSpanW, rSpanH) * 0.16;
    const rViewBox = `${rcx - rSpanW / 2 - rPad} ${rcy - rSpanH / 2 - rPad} ${rSpanW + rPad * 2} ${rSpanH + rPad * 2}`;
    return (
      <svg viewBox={rViewBox} className="w-full h-16">
        {renderFurnitureRepresentationView(effectiveRep, 'top')}
      </svg>
    );
  }
  const generatedTop = generateDefaultTopViewFromParts(tpl.parts, { templateId: tpl.id });
  if (generatedTop) {
    const derivedRep = { mode: 'default' as const, defaultViews: { top: generatedTop } };
    return (
      <svg viewBox={vb} className="w-full h-16">
        <g transform={`translate(${cx}, ${cy})`}>
          {renderFurnitureRepresentationView(derivedRep, 'top', { baseStrokeMm: sw })}
        </g>
      </svg>
    );
  }
  return (
    <svg viewBox={vb} className="w-full h-16">
      <rect
        x={b.minX}
        y={b.minY}
        width={b.widthMm}
        height={b.depthMm}
        fill="#E2E8F0"
        stroke="#1E293B"
        strokeWidth={sw}
      />
    </svg>
  );
};

export const LeftSidebar: React.FC<LeftSidebarProps> = ({
  project,
  activeLevel,
  selection,
  activeSection,
  onSectionChange,
  onSelect,
  onPlaceFurniture,
  onPlacePerson,
  onPlaceArchElement,
  onPlaceRailingPreset,
  onUpdateLevel,
  onOpenCustomBuilder,
  onOpenImporter,
  onRemoveCustomTemplate,
  onToolChange,
  onAddLevel,
  onSwitchLevel,
  onDeleteLevel,
}) => {
  const [internalSection, setInternalSection] = useState<LeftPanelSection>('furniture');
  const section = activeSection ?? internalSection;
  const setSection = (next: LeftPanelSection) => {
    setInternalSection(next);
    onSectionChange?.(next);
  };

  const [libraryScope, setLibraryScope] = useState<'builtin' | 'custom'>('builtin');
  const [search, setSearch] = useState('');
  const [cat, setCat] = useState<'All' | FurnitureCategory>('All');
  const [levelsCollapsed, setLevelsCollapsed] = useState(false);

  const filteredCatalog = useMemo(() => {
    const q = search.trim().toLowerCase();
    const source = libraryScope === 'custom' ? project.customLibrary : BUILTIN_CATALOG;
    return source.filter((item) => {
      if (libraryScope === 'builtin' && cat !== 'All' && item.category !== cat) return false;
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q) ||
        (item.description?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [libraryScope, project.customLibrary, cat, search]);

  const filteredArch = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return ARCH_CATALOG_ITEMS;
    return ARCH_CATALOG_ITEMS.filter(
      (a) => a.label.toLowerCase().includes(q) || a.desc.toLowerCase().includes(q)
    );
  }, [search]);

  const filteredRailingStyles = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return RAILING_STYLES;
    return RAILING_STYLES.filter(
      (r) =>
        r.label.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q) ||
        'railing balustrade handrail'.includes(q)
    );
  }, [search]);

  const filteredPeople = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return PEOPLE_CATALOG_ITEMS;
    return PEOPLE_CATALOG_ITEMS.filter(
      (p) => p.label.toLowerCase().includes(q) || p.detail.toLowerCase().includes(q)
    );
  }, [search]);

  const scheduleData = useMemo(() => {
    const totalRoomM2 = activeLevel.rooms.reduce((s, r) => s + r.areaM2, 0);
    const totalPaintM2 = activeLevel.walls.reduce(
      (s, w) => s + computeWallSurfaceAreaM2(w, activeLevel.openings).netAreaM2 * 2,
      0
    );
    const furnGroups = new Map<
      string,
      {
        key: string;
        name: string;
        category: FurnitureCategory;
        count: number;
        widthMm: number;
        depthMm: number;
        heightMm: number;
      }
    >();
    for (const f of activeLevel.furniture) {
      const b = computeFurnitureBoundsMm(f.parts);
      const widthMm = Math.round(b.widthMm);
      const depthMm = Math.round(b.depthMm);
      const heightMm = Math.round(b.heightMm);
      const key = `${f.name}::${widthMm}x${depthMm}x${heightMm}`;
      const existing = furnGroups.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        furnGroups.set(key, {
          key,
          name: f.name,
          category: f.category,
          count: 1,
          widthMm,
          depthMm,
          heightMm,
        });
      }
    }
    const items = Array.from(furnGroups.values());
    const totalFurnitureCount = activeLevel.furniture.length;
    const doorCount = activeLevel.openings.filter((o) => o.category === 'door').length;
    const windowCount = activeLevel.openings.filter((o) => o.category === 'window').length;
    return {
      totalRoomM2,
      totalPaintM2,
      items,
      totalFurnitureCount,
      doorCount,
      windowCount,
    };
  }, [activeLevel]);

  const handleTraceUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const img = new Image();
      img.onload = () => {
        const aspect = img.width / Math.max(1, img.height);
        const widthMm = 12000;
        const heightMm = Math.round(widthMm / aspect);
        onUpdateLevel(
          (lvl) => ({
            ...lvl,
            backgroundTrace: {
              imageDataUrl: dataUrl,
              xMm: 0,
              yMm: 0,
              widthMm,
              heightMm,
              opacity: 0.45,
              visible: true,
              rotationDeg: 0,
            },
          }),
          false,
          true,
          'Upload Trace Image'
        );
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  };

  const NAV_ITEMS: ReadonlyArray<{
    id: LeftPanelSection;
    label: string;
    Icon: React.ComponentType<{ className?: string }>;
  }> = [
    { id: 'furniture', label: 'Furniture', Icon: Armchair },
    { id: 'architecture', label: 'Arch', Icon: Building2 },
    { id: 'people', label: 'People', Icon: Users },
    { id: 'structure', label: 'Structure', Icon: Layers },
    { id: 'schedules', label: 'Schedules', Icon: Calculator },
    { id: 'tracing', label: 'Tracing', Icon: ImageIcon },
  ];

  return (
    <div className="flex flex-col h-full bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 text-xs select-none">
      {/* Primary 6-Section CAD Navigation Strip */}
      <nav
        aria-label="Project library and navigation"
        className="grid grid-cols-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 shrink-0"
      >
        {NAV_ITEMS.map(({ id, label, Icon }) => {
          const active = section === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setSection(id)}
              aria-current={active ? 'page' : undefined}
              className={`py-2 px-1 flex items-center justify-center gap-1.5 text-[11px] font-medium border-b-2 transition-colors cursor-pointer ${
                active
                  ? 'border-blue-600 text-blue-600 dark:text-blue-400 bg-white dark:bg-slate-900'
                  : 'border-transparent text-slate-500 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-100/60 dark:hover:bg-slate-900/50'
              }`}
            >
              <Icon className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          );
        })}
      </nav>

      {/* SECTION 1: FURNITURE LIBRARY */}
      {section === 'furniture' && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="p-2.5 space-y-2 border-b border-slate-200 dark:border-slate-800 shrink-0">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search furniture, lighting, fixtures..."
                aria-label="Search furniture library"
                className="w-full pl-8 pr-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded focus:outline-none focus:border-blue-500"
              />
            </div>

            {/* Built-in vs My Library segmented switch */}
            <div className="grid grid-cols-2 p-0.5 rounded bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setLibraryScope('builtin')}
                className={`py-1 rounded-xs text-[11px] font-medium transition-colors cursor-pointer ${
                  libraryScope === 'builtin'
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                Built-in
              </button>
              <button
                type="button"
                onClick={() => setLibraryScope('custom')}
                className={`py-1 rounded-xs text-[11px] font-medium transition-colors cursor-pointer flex items-center justify-center gap-1 ${
                  libraryScope === 'custom'
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                <span>My Library</span>
                {project.customLibrary.length > 0 && (
                  <span className="font-mono-nums text-[10px] opacity-70">
                    ({project.customLibrary.length})
                  </span>
                )}
              </button>
            </div>

            {libraryScope === 'builtin' && (
              <select
                value={cat}
                onChange={(e) => setCat(e.target.value as 'All' | FurnitureCategory)}
                aria-label="Filter catalog category"
                className="w-full px-2 py-1 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded focus:outline-none focus:border-blue-500 cursor-pointer"
              >
                {BUILTIN_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c === 'All' ? 'All Categories' : c}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-2.5">
            {filteredCatalog.length === 0 ? (
              <div className="py-10 px-3 text-center text-slate-500 space-y-2">
                <p className="text-[11px]">
                  {libraryScope === 'custom'
                    ? 'No custom items saved yet. Build or import SVG / GLB geometry below.'
                    : 'No furniture items match your filter.'}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-1.5">
                {filteredCatalog.map((tpl) => {
                  const b = computeFurnitureBoundsMm(tpl.parts);
                  const mType =
                    tpl.defaultMountingType ??
                    resolveFurnitureMountingType({
                      templateId: tpl.id,
                      category: tpl.category,
                      parts: tpl.parts,
                      elevationMm: tpl.defaultElevationMm ?? 0,
                    });
                  const mountLabel = MOUNTING_SHORT[mType] ?? 'Floor';
                  return (
                    <div
                      key={tpl.id}
                      className="group relative rounded border border-slate-200 dark:border-slate-800 hover:border-blue-500 hover:bg-blue-50/40 dark:hover:bg-blue-950/20 transition-colors"
                    >
                      <button
                        type="button"
                        onClick={() => onPlaceFurniture(tpl)}
                        title={`Place ${tpl.name} (${Math.round(b.widthMm / 10)}x${Math.round(b.depthMm / 10)} cm)`}
                        className="w-full text-left p-2 cursor-pointer"
                      >
                        <div className="rounded bg-slate-50/80 dark:bg-slate-950/60 p-1">
                          <CatalogThumb tpl={tpl} />
                        </div>
                        <div className="mt-1.5 font-medium text-[11px] text-slate-800 dark:text-slate-100 truncate">
                          {tpl.name}
                        </div>
                        <div className="flex items-center justify-between gap-1 text-[10px] font-mono-nums text-slate-400">
                          <span className="truncate">
                            {Math.round(b.widthMm / 10)}x{Math.round(b.depthMm / 10)}cm
                          </span>
                          <span className="text-slate-500 dark:text-slate-400 shrink-0">
                            {mountLabel}
                          </span>
                        </div>
                      </button>
                      {libraryScope === 'custom' && onRemoveCustomTemplate && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemoveCustomTemplate(tpl.id);
                          }}
                          title={`Remove ${tpl.name} from My Library`}
                          aria-label={`Remove ${tpl.name}`}
                          className="absolute top-1.5 right-1.5 p-1 rounded bg-white/90 dark:bg-slate-900/90 border border-slate-200 dark:border-slate-700 text-slate-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Sticky Creation / Import Footer */}
          <div className="p-2 border-t border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-950/80 grid grid-cols-2 gap-1.5 shrink-0">
            <button
              type="button"
              onClick={onOpenCustomBuilder}
              className="py-1.5 px-2 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 rounded text-[11px] font-medium hover:opacity-90 cursor-pointer flex items-center justify-center gap-1"
            >
              <Plus className="w-3 h-3" /> Build
            </button>
            <button
              type="button"
              onClick={onOpenImporter}
              className="py-1.5 px-2 border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 rounded text-[11px] font-medium hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer flex items-center justify-center gap-1"
            >
              <Upload className="w-3 h-3" /> Import
            </button>
          </div>
        </div>
      )}

      {/* SECTION 2: ARCHITECTURE & RAILINGS */}
      {section === 'architecture' && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="p-2.5 border-b border-slate-200 dark:border-slate-800 shrink-0">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search stairs, railings, columns..."
                aria-label="Search architectural elements"
                className="w-full pl-8 pr-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-2.5 space-y-4">
            {filteredRailingStyles.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                    Railings &amp; Balustrades
                  </span>
                  <button
                    type="button"
                    data-testid="sidebar-draw-railing-btn"
                    onClick={() => onToolChange('railing')}
                    className="px-2 py-0.5 rounded bg-blue-600 hover:bg-blue-700 text-white text-[10px] font-medium cursor-pointer"
                  >
                    Draw Path
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {filteredRailingStyles.map((st) => (
                    <button
                      key={st.id}
                      type="button"
                      data-testid={`catalog-railing-${st.id}`}
                      onClick={() => {
                        if (onPlaceRailingPreset) {
                          onPlaceRailingPreset(st.id);
                        } else {
                          onPlaceArchElement('railing', `${st.label} Railing`);
                        }
                      }}
                      className="text-left p-2 rounded border border-slate-200 dark:border-slate-800 hover:border-blue-500 hover:bg-blue-50/40 dark:hover:bg-blue-950/20 transition-colors cursor-pointer"
                    >
                      <RailingStyleThumb styleId={st.id} className="w-full h-10 text-slate-700 dark:text-slate-200" />
                      <div className="mt-1 font-medium text-[11px] text-slate-800 dark:text-slate-100 truncate">
                        {st.shortLabel}
                      </div>
                      <div className="text-[10px] text-slate-400 truncate">{st.description}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {filteredArch.length > 0 && (
              <div className="space-y-2">
                <div className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                  Structural Elements
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {filteredArch.map((a) => (
                    <button
                      key={a.type}
                      type="button"
                      onClick={() => onPlaceArchElement(a.type, a.label)}
                      className="text-left p-2 rounded border border-slate-200 dark:border-slate-800 hover:border-blue-500 hover:bg-blue-50/40 dark:hover:bg-blue-950/20 transition-colors cursor-pointer"
                    >
                      <ArchThumb type={a.type} />
                      <div className="mt-1 font-medium text-[11px] text-slate-800 dark:text-slate-100 truncate">
                        {a.label}
                      </div>
                      <div className="text-[10px] text-slate-400 truncate">{a.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* SECTION 3: PEOPLE */}
      {section === 'people' && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="p-2.5 border-b border-slate-200 dark:border-slate-800 shrink-0">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search standing, seated, child..."
                aria-label="Search scale figures"
                className="w-full pl-8 pr-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-2.5 space-y-2">
            <div className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">
              Human Scale Figures
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {filteredPeople.map((p) => (
                <button
                  key={p.pose}
                  type="button"
                  onClick={() => onPlacePerson(p.pose, p.label, p.h)}
                  className="text-left p-2 rounded border border-slate-200 dark:border-slate-800 hover:border-blue-500 hover:bg-blue-50/40 dark:hover:bg-blue-950/20 transition-colors cursor-pointer"
                >
                  <PersonThumb pose={p.pose} />
                  <div className="mt-1 font-medium text-[11px] text-slate-800 dark:text-slate-100 truncate">
                    {p.label}
                  </div>
                  <div className="text-[10px] font-mono-nums text-slate-400 truncate">
                    {p.detail}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* SECTION 4: PROJECT STRUCTURE (Levels + Layers + Scene Outline) */}
      {section === 'structure' && (
        <div className="flex-1 overflow-y-auto divide-y divide-slate-200 dark:divide-slate-800">
          {/* Floors / Levels */}
          <div className="p-3 space-y-2">
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setLevelsCollapsed((c) => !c)}
                className="flex items-center gap-1 font-semibold text-[11px] text-slate-600 dark:text-slate-300 cursor-pointer"
              >
                <ChevronRight
                  className={`w-3.5 h-3.5 text-slate-400 transition-transform ${
                    levelsCollapsed ? '' : 'rotate-90'
                  }`}
                />
                <span>Floors &amp; Levels ({project.levels.length})</span>
              </button>
              <button
                type="button"
                onClick={onAddLevel}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
              >
                <Plus className="w-3 h-3" /> Add Floor
              </button>
            </div>

            {!levelsCollapsed && (
              <div className="space-y-1">
                {project.levels.map((lvl) => (
                  <div
                    key={lvl.id}
                    className={`flex items-center justify-between px-2 py-1.5 rounded border ${
                      lvl.id === activeLevel.id
                        ? 'border-blue-600 bg-blue-50/70 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300'
                        : 'border-slate-200 dark:border-slate-800'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onSwitchLevel(lvl.id)}
                      className="flex-1 text-left font-medium truncate cursor-pointer"
                    >
                      {lvl.name}
                    </button>
                    {project.levels.length > 1 && (
                      <button
                        type="button"
                        onClick={() => onDeleteLevel(lvl.id)}
                        aria-label={`Delete ${lvl.name}`}
                        className="p-1 text-slate-400 hover:text-red-600 rounded cursor-pointer"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Layer Visibility */}
          <div className="p-3 space-y-1">
            <div className="font-semibold text-[11px] text-slate-500 mb-1.5">Layer Visibility</div>
            {(
              [
                ['walls', 'Walls'],
                ['rooms', 'Rooms & Floors'],
                ['openings', 'Doors, Windows & Arches'],
                ['furniture', 'Furniture'],
                ['curtains', 'Curtains & Blinds'],
                ['people', 'People Figures'],
                ['archElements', 'Stairs, Columns & Beams'],
                ['measurements', 'Measurements'],
                ['annotations', 'Annotations'],
              ] as const
            ).map(([key, label]) => (
              <label
                key={key}
                className="flex items-center justify-between px-1.5 py-1 rounded hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer"
              >
                <span className="text-slate-700 dark:text-slate-300">{label}</span>
                <input
                  type="checkbox"
                  checked={activeLevel.layers[key]}
                  onChange={(e) =>
                    onUpdateLevel(
                      (lvl) => ({
                        ...lvl,
                        layers: { ...lvl.layers, [key]: e.target.checked },
                      }),
                      false,
                      true,
                      `Toggle ${label} Layer`
                    )
                  }
                  className="accent-blue-600"
                />
              </label>
            ))}
          </div>

          {/* Objects Outline */}
          <div className="p-3 space-y-1.5">
            <div className="font-semibold text-[11px] text-slate-500">
              Objects ({activeLevel.rooms.length} rooms · {activeLevel.walls.length} walls ·{' '}
              {activeLevel.furniture.length} items)
            </div>

            {activeLevel.rooms.map((r) => (
              <div
                key={r.id}
                className={`flex items-center justify-between px-2 py-1 rounded ${
                  selection.some((s) => s.kind === 'room' && s.id === r.id)
                    ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-800/60'
                }`}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    const target = { kind: 'room' as const, id: r.id };
                    if (e.ctrlKey || e.metaKey || e.shiftKey) {
                      const exists = selection.some((s) => s.kind === 'room' && s.id === r.id);
                      onSelect(
                        exists
                          ? selection.filter((s) => !(s.kind === 'room' && s.id === r.id))
                          : [...selection, target]
                      );
                    } else {
                      onSelect([target]);
                    }
                  }}
                  className="flex-1 text-left truncate cursor-pointer flex items-center justify-between gap-2"
                >
                  <span className="truncate">{r.name}</span>
                  <span className="font-mono-nums text-[10px] text-slate-400 shrink-0">
                    {formatAreaM2(r.areaM2)}
                  </span>
                </button>
              </div>
            ))}

            {activeLevel.furniture.map((f) => {
              const sel = selection.some((s) => s.kind === 'furniture' && s.id === f.id);
              return (
                <div key={f.id} className="space-y-0.5">
                  <div
                    className={`flex items-center justify-between px-2 py-1 rounded ${
                      sel
                        ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                        : 'hover:bg-slate-50 dark:hover:bg-slate-800/60'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        const target = { kind: 'furniture' as const, id: f.id };
                        if (e.ctrlKey || e.metaKey || e.shiftKey) {
                          const exists = selection.some(
                            (s) => s.kind === 'furniture' && s.id === f.id
                          );
                          onSelect(
                            exists
                              ? selection.filter((s) => !(s.kind === 'furniture' && s.id === f.id))
                              : [...selection, target]
                          );
                        } else {
                          onSelect([target]);
                        }
                      }}
                      className="flex-1 text-left truncate font-medium cursor-pointer"
                    >
                      {f.name}
                    </button>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        aria-label={`Toggle visibility for ${f.name}`}
                        onClick={() =>
                          onUpdateLevel(
                            (lvl) => ({
                              ...lvl,
                              furniture: lvl.furniture.map((x) =>
                                x.id === f.id ? { ...x, visible: !x.visible } : x
                              ),
                            }),
                            false,
                            true,
                            `Toggle ${f.name} Visibility`
                          )
                        }
                        className="p-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
                      >
                        {f.visible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                      </button>
                      <button
                        type="button"
                        aria-label={`Toggle lock for ${f.name}`}
                        onClick={() =>
                          onUpdateLevel(
                            (lvl) => ({
                              ...lvl,
                              furniture: lvl.furniture.map((x) =>
                                x.id === f.id ? { ...x, locked: !x.locked } : x
                              ),
                            }),
                            false,
                            true,
                            `${f.locked ? 'Unlock' : 'Lock'} ${f.name}`
                          )
                        }
                        className="p-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
                      >
                        {f.locked ? (
                          <Lock className="w-3 h-3 text-amber-500" />
                        ) : (
                          <Unlock className="w-3 h-3" />
                        )}
                      </button>
                    </div>
                  </div>
                  {sel && f.parts.length > 1 && (
                    <div className="pl-4 space-y-0.5">
                      {f.parts.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={(e) => {
                            const target = { kind: 'furniture' as const, id: f.id, partId: p.id };
                            if (e.ctrlKey || e.metaKey || e.shiftKey) {
                              const exists = selection.some(
                                (s) =>
                                  s.kind === 'furniture' && s.id === f.id && s.partId === p.id
                              );
                              onSelect(
                                exists
                                  ? selection.filter(
                                      (s) =>
                                        !(
                                          s.kind === 'furniture' &&
                                          s.id === f.id &&
                                          s.partId === p.id
                                        )
                                    )
                                  : [...selection, target]
                              );
                            } else {
                              onSelect([target]);
                            }
                          }}
                          className={`w-full flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] text-left cursor-pointer ${
                            selection.some((s) => s.kind === 'furniture' && s.partId === p.id)
                              ? 'bg-blue-600 text-white'
                              : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
                          }`}
                        >
                          <span
                            className="w-2 h-2 rounded-xs shrink-0"
                            style={{ backgroundColor: p.color }}
                          />
                          <span className="truncate">{p.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* SECTION 5: SCHEDULES & BOM */}
      {section === 'schedules' && (
        <div className="flex-1 overflow-y-auto p-3 space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <div className="p-2.5 rounded bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
              <div className="text-[10px] text-slate-500">Total Floor Area</div>
              <div className="font-mono-nums font-semibold text-sm mt-0.5">
                {formatAreaM2(scheduleData.totalRoomM2)}
              </div>
            </div>
            <div className="p-2.5 rounded bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
              <div className="text-[10px] text-slate-500">Wall Surface</div>
              <div className="font-mono-nums font-semibold text-sm mt-0.5">
                {scheduleData.totalPaintM2.toFixed(1)} m²
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="font-semibold text-[11px] text-slate-600 dark:text-slate-300">
              Rooms Breakdown
            </div>
            {activeLevel.rooms.length === 0 ? (
              <div className="text-[11px] text-slate-400">No enclosed rooms detected.</div>
            ) : (
              activeLevel.rooms.map((r) => (
                <div
                  key={r.id}
                  className="flex justify-between py-1 border-b border-slate-100 dark:border-slate-800"
                >
                  <span className="truncate">
                    {r.name} · {r.floorMaterial}
                  </span>
                  <span className="font-mono-nums font-medium">{formatAreaM2(r.areaM2)}</span>
                </div>
              ))
            )}
          </div>

          <div className="space-y-1.5" data-testid="schedule-furniture-section">
            <div className="flex items-center justify-between font-semibold text-[11px] text-slate-600 dark:text-slate-300">
              <span>Furniture &amp; Equipment Schedule</span>
              <span className="font-mono-nums text-[10px] font-medium text-slate-400">
                {scheduleData.totalFurnitureCount} {scheduleData.totalFurnitureCount === 1 ? 'item' : 'items'}
              </span>
            </div>
            {scheduleData.items.length === 0 ? (
              <div className="text-[11px] text-slate-400">No furniture placed on this level.</div>
            ) : (
              scheduleData.items.map((it) => (
                <div
                  key={it.key}
                  className="flex items-baseline justify-between gap-2 py-1 border-b border-slate-100 dark:border-slate-800"
                >
                  <span className="truncate flex-1" title={`${it.name} (${it.category})`}>
                    <span className="font-mono-nums font-semibold mr-1">{it.count}x</span>
                    {it.name}
                  </span>
                  <span className="font-mono-nums text-[10px] text-slate-500 dark:text-slate-400 shrink-0">
                    {formatSmartMetric(it.widthMm, project.settings.preferredUnit)} ×{' '}
                    {formatSmartMetric(it.depthMm, project.settings.preferredUnit)} ×{' '}
                    {formatSmartMetric(it.heightMm, project.settings.preferredUnit)}
                  </span>
                </div>
              ))
            )}
            {(scheduleData.doorCount > 0 || scheduleData.windowCount > 0) && (
              <div className="flex items-center justify-between pt-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                <span>Openings</span>
                <span className="font-mono-nums">
                  {scheduleData.doorCount} {scheduleData.doorCount === 1 ? 'door' : 'doors'} ·{' '}
                  {scheduleData.windowCount} {scheduleData.windowCount === 1 ? 'window' : 'windows'}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* SECTION 6: REFERENCE IMAGES / TRACING */}
      {section === 'tracing' && (
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          <div className="font-semibold text-[11px] text-slate-600 dark:text-slate-300">
            Background Floorplan Trace
          </div>
          <p className="text-[11px] text-slate-500">
            Import a raster architectural drawing or sketch and calibrate two real-world points to trace over it accurately.
          </p>

          <label className="block w-full py-2.5 px-3 text-center border border-dashed border-slate-300 dark:border-slate-700 rounded hover:border-blue-500 cursor-pointer font-medium text-slate-700 dark:text-slate-200">
            {activeLevel.backgroundTrace ? 'Replace Trace Image' : 'Upload Floorplan Image'}
            <input type="file" accept="image/*" onChange={handleTraceUpload} className="hidden" />
          </label>

          {activeLevel.backgroundTrace && (
            <div className="space-y-2.5 pt-2 border-t border-slate-200 dark:border-slate-800">
              <label className="flex justify-between text-[11px] text-slate-500">
                <span>Trace Opacity</span>
                <span className="font-mono-nums">
                  {Math.round(activeLevel.backgroundTrace.opacity * 100)}%
                </span>
              </label>
              <input
                type="range"
                min={0.1}
                max={1}
                step={0.05}
                value={activeLevel.backgroundTrace.opacity}
                onChange={(e) =>
                  onUpdateLevel(
                    (lvl) =>
                      lvl.backgroundTrace
                        ? {
                            ...lvl,
                            backgroundTrace: {
                              ...lvl.backgroundTrace,
                              opacity: Number(e.target.value),
                            },
                          }
                        : lvl,
                    false,
                    true,
                    'Change Trace Opacity',
                    'trace-opacity'
                  )
                }
                className="w-full accent-blue-600"
              />

              <button
                type="button"
                onClick={() => onToolChange('calibrate_trace')}
                className="w-full py-1.5 px-2.5 bg-blue-600 text-white rounded font-medium flex items-center justify-center gap-1.5 hover:bg-blue-700 cursor-pointer"
              >
                <Ruler className="w-3.5 h-3.5" />
                Calibrate Scale (Click 2 Points)
              </button>

              <button
                type="button"
                onClick={() =>
                  onUpdateLevel(
                    (lvl) => ({ ...lvl, backgroundTrace: null }),
                    false,
                    true,
                    'Remove Trace Image'
                  )
                }
                className="w-full py-1.5 px-2.5 border border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-400 rounded font-medium hover:bg-red-50 dark:hover:bg-red-950/30 cursor-pointer"
              >
                Remove Trace Image
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
