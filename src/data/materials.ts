import type { MaterialPreset } from '../types/plan';

export type MaterialCategory =
  | 'Paint & Wall'
  | 'Wood & Timber'
  | 'Stone & Brick'
  | 'Tile & Terrazzo'
  | 'Textiles & Leather'
  | 'Metals & Plastics';

export interface MaterialCapabilities {
  supportsSecondaryColor?: boolean;
  secondaryColorLabel?: string;
  supportsPatternScale?: boolean;
  supportsRotation?: boolean;
  supportsDimensions?: boolean;
  defaultWidthMm?: number;
  defaultLengthMm?: number;
  dimWidthLabel?: string;
  dimLengthLabel?: string;
  cellsX?: number;
  cellsY?: number;
  supportsGrout?: boolean;
  defaultGroutMm?: number;
  supportsStagger?: boolean;
  defaultStaggerPct?: number;
  supportsRoughness?: boolean;
  supportsReflectivity?: boolean;
  defaultReflectivity?: number;
  recommendedForBacksplash?: boolean;
}

export interface MaterialPresetMeta {
  id: MaterialPreset;
  label: string;
  category: MaterialCategory;
  finishLabel: string;
  roughness: number;
  metalness: number;
  previewBase: string;
  previewAccent: string;
  previewSecondary?: string;
  capabilities?: MaterialCapabilities;
}

export const MATERIAL_CATEGORIES: MaterialCategory[] = [
  'Paint & Wall',
  'Wood & Timber',
  'Stone & Brick',
  'Tile & Terrazzo',
  'Textiles & Leather',
  'Metals & Plastics',
];

export const MATERIAL_PRESETS: MaterialPresetMeta[] = [
  // Paint & Wall Finishes
  {
    id: 'paint',
    label: 'Matte Paint',
    category: 'Paint & Wall',
    finishLabel: 'Matte',
    roughness: 0.86,
    metalness: 0.0,
    previewBase: '#F1F5F9',
    previewAccent: '#CBD5E1',
    capabilities: { supportsRoughness: true, supportsReflectivity: true, defaultReflectivity: 0.12 },
  },
  {
    id: 'satin_paint',
    label: 'Satin Lacquer',
    category: 'Paint & Wall',
    finishLabel: 'Satin',
    roughness: 0.36,
    metalness: 0.0,
    previewBase: '#F8FAFC',
    previewAccent: '#94A3B8',
    capabilities: { supportsRoughness: true, supportsReflectivity: true, defaultReflectivity: 0.55 },
  },
  {
    id: 'plaster',
    label: 'Limewash Plaster',
    category: 'Paint & Wall',
    finishLabel: 'Troweled',
    roughness: 0.84,
    metalness: 0.0,
    previewBase: '#E9E4DC',
    previewAccent: '#C8BFB2',
    capabilities: {
      supportsPatternScale: true,
      supportsRotation: true,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.2,
    },
  },
  {
    id: 'stucco',
    label: 'Textured Stucco',
    category: 'Paint & Wall',
    finishLabel: 'Mineral',
    roughness: 0.92,
    metalness: 0.0,
    previewBase: '#EDE8DF',
    previewAccent: '#BFB6A7',
    capabilities: {
      supportsPatternScale: true,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.1,
    },
  },
  {
    id: 'microcement',
    label: 'Smooth Microcement',
    category: 'Paint & Wall',
    finishLabel: 'Honed',
    roughness: 0.58,
    metalness: 0.0,
    previewBase: '#D5D2CB',
    previewAccent: '#9E9A92',
    capabilities: {
      supportsSecondaryColor: true,
      secondaryColorLabel: 'Trowel undertone',
      supportsPatternScale: true,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.34,
      recommendedForBacksplash: true,
    },
  },
  {
    id: 'wallpaper',
    label: 'Linen Wallpaper',
    category: 'Paint & Wall',
    finishLabel: 'Woven',
    roughness: 0.80,
    metalness: 0.0,
    previewBase: '#ECEAE4',
    previewAccent: '#B8B2A6',
    capabilities: {
      supportsPatternScale: true,
      supportsRotation: true,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.16,
    },
  },
  {
    id: 'striped_wallpaper',
    label: 'Striped Wallpaper',
    category: 'Paint & Wall',
    finishLabel: 'Architectural',
    roughness: 0.72,
    metalness: 0.0,
    previewBase: '#F4F1EA',
    previewAccent: '#CBD5E1',
    previewSecondary: '#CBD5E1',
    capabilities: {
      supportsSecondaryColor: true,
      secondaryColorLabel: 'Stripe accent color',
      supportsPatternScale: true,
      supportsRotation: true,
      supportsDimensions: true,
      defaultWidthMm: 120,
      defaultLengthMm: 600,
      dimWidthLabel: 'Stripe pitch',
      dimLengthLabel: 'Repeat height',
      cellsX: 2,
      cellsY: 1,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.22,
    },
  },
  {
    id: 'paneling',
    label: 'Fluted Timber Paneling',
    category: 'Paint & Wall',
    finishLabel: 'Slatted',
    roughness: 0.56,
    metalness: 0.02,
    previewBase: '#D9C3A5',
    previewAccent: '#7C5A3A',
    capabilities: {
      supportsPatternScale: true,
      supportsRotation: true,
      supportsDimensions: true,
      defaultWidthMm: 48,
      defaultLengthMm: 1000,
      dimWidthLabel: 'Slat width',
      dimLengthLabel: 'Panel height',
      cellsX: 6,
      cellsY: 1,
      supportsGrout: true,
      defaultGroutMm: 6,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.32,
    },
  },
  {
    id: 'ribbed_paneling',
    label: 'Wainscot Wall Panel',
    category: 'Paint & Wall',
    finishLabel: 'Beadboard',
    roughness: 0.48,
    metalness: 0.0,
    previewBase: '#F1F5F9',
    previewAccent: '#94A3B8',
    capabilities: {
      supportsSecondaryColor: true,
      secondaryColorLabel: 'Groove shadow tint',
      supportsPatternScale: true,
      supportsRotation: true,
      supportsDimensions: true,
      defaultWidthMm: 90,
      defaultLengthMm: 1200,
      dimWidthLabel: 'Bead width',
      dimLengthLabel: 'Panel height',
      cellsX: 4,
      cellsY: 1,
      supportsGrout: true,
      defaultGroutMm: 4,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.4,
    },
  },

  // Wood & Timber
  {
    id: 'wood',
    label: 'Whitewashed Ash',
    category: 'Wood & Timber',
    finishLabel: 'Natural Plank',
    roughness: 0.62,
    metalness: 0.0,
    previewBase: '#EDE5D8',
    previewAccent: '#B59E82',
    capabilities: {
      supportsPatternScale: true,
      supportsRotation: true,
      supportsDimensions: true,
      defaultWidthMm: 180,
      defaultLengthMm: 1200,
      dimWidthLabel: 'Plank width',
      dimLengthLabel: 'Plank length',
      cellsX: 4,
      cellsY: 1,
      supportsGrout: true,
      defaultGroutMm: 2,
      supportsStagger: true,
      defaultStaggerPct: 50,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.3,
    },
  },
  {
    id: 'oak',
    label: 'European White Oak',
    category: 'Wood & Timber',
    finishLabel: 'Oiled Plank',
    roughness: 0.58,
    metalness: 0.0,
    previewBase: '#D6B992',
    previewAccent: '#9A744B',
    capabilities: {
      supportsPatternScale: true,
      supportsRotation: true,
      supportsDimensions: true,
      defaultWidthMm: 190,
      defaultLengthMm: 1400,
      dimWidthLabel: 'Plank width',
      dimLengthLabel: 'Plank length',
      cellsX: 4,
      cellsY: 1,
      supportsGrout: true,
      defaultGroutMm: 2,
      supportsStagger: true,
      defaultStaggerPct: 50,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.34,
    },
  },
  {
    id: 'oak_wide',
    label: 'Wide-Plank White Oak',
    category: 'Wood & Timber',
    finishLabel: 'Architectural',
    roughness: 0.54,
    metalness: 0.0,
    previewBase: '#DCC29E',
    previewAccent: '#8F6A42',
    capabilities: {
      supportsPatternScale: true,
      supportsRotation: true,
      supportsDimensions: true,
      defaultWidthMm: 260,
      defaultLengthMm: 1800,
      dimWidthLabel: 'Plank width',
      dimLengthLabel: 'Plank length',
      cellsX: 3,
      cellsY: 1,
      supportsGrout: true,
      defaultGroutMm: 2,
      supportsStagger: true,
      defaultStaggerPct: 35,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.36,
    },
  },
  {
    id: 'walnut',
    label: 'American Walnut',
    category: 'Wood & Timber',
    finishLabel: 'Satin Plank',
    roughness: 0.48,
    metalness: 0.0,
    previewBase: '#6B462B',
    previewAccent: '#3D2414',
    capabilities: {
      supportsPatternScale: true,
      supportsRotation: true,
      supportsDimensions: true,
      defaultWidthMm: 180,
      defaultLengthMm: 1250,
      dimWidthLabel: 'Plank width',
      dimLengthLabel: 'Plank length',
      cellsX: 4,
      cellsY: 1,
      supportsGrout: true,
      defaultGroutMm: 2,
      supportsStagger: true,
      defaultStaggerPct: 50,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.44,
    },
  },
  {
    id: 'teak',
    label: 'Warm Golden Teak',
    category: 'Wood & Timber',
    finishLabel: 'Oiled Plank',
    roughness: 0.52,
    metalness: 0.0,
    previewBase: '#A96E3B',
    previewAccent: '#693E1B',
    capabilities: {
      supportsPatternScale: true,
      supportsRotation: true,
      supportsDimensions: true,
      defaultWidthMm: 160,
      defaultLengthMm: 1100,
      dimWidthLabel: 'Plank width',
      dimLengthLabel: 'Plank length',
      cellsX: 4,
      cellsY: 1,
      supportsGrout: true,
      defaultGroutMm: 2,
      supportsStagger: true,
      defaultStaggerPct: 50,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.4,
    },
  },
  {
    id: 'smoked_oak',
    label: 'Smoked Dark Oak',
    category: 'Wood & Timber',
    finishLabel: 'Brushed Plank',
    roughness: 0.60,
    metalness: 0.0,
    previewBase: '#4A3B31',
    previewAccent: '#271E18',
    capabilities: {
      supportsPatternScale: true,
      supportsRotation: true,
      supportsDimensions: true,
      defaultWidthMm: 190,
      defaultLengthMm: 1400,
      dimWidthLabel: 'Plank width',
      dimLengthLabel: 'Plank length',
      cellsX: 4,
      cellsY: 1,
      supportsGrout: true,
      defaultGroutMm: 2,
      supportsStagger: true,
      defaultStaggerPct: 45,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.3,
    },
  },
  {
    id: 'wood_strip',
    label: 'Linear Timber Strips',
    category: 'Wood & Timber',
    finishLabel: 'Narrow Strip',
    roughness: 0.54,
    metalness: 0.0,
    previewBase: '#C9A579',
    previewAccent: '#7F5C36',
    capabilities: {
      supportsPatternScale: true,
      supportsRotation: true,
      supportsDimensions: true,
      defaultWidthMm: 95,
      defaultLengthMm: 950,
      dimWidthLabel: 'Strip width',
      dimLengthLabel: 'Strip length',
      cellsX: 6,
      cellsY: 1,
      supportsGrout: true,
      defaultGroutMm: 2,
      supportsStagger: true,
      defaultStaggerPct: 50,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.38,
    },
  },
  {
    id: 'parquet',
    label: 'Oak Parquet',
    category: 'Wood & Timber',
    finishLabel: 'Satin',
    roughness: 0.46,
    metalness: 0.0,
    previewBase: '#CFA97A',
    previewAccent: '#7D5832',
    capabilities: {
      supportsPatternScale: true,
      supportsRotation: true,
      supportsDimensions: true,
      defaultWidthMm: 169,
      defaultLengthMm: 675,
      dimWidthLabel: 'Block width',
      dimLengthLabel: 'Block length',
      cellsX: 4,
      cellsY: 2,
      supportsGrout: true,
      defaultGroutMm: 2,
      supportsStagger: true,
      defaultStaggerPct: 50,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.48,
    },
  },
  {
    id: 'herringbone',
    label: 'Herringbone Oak',
    category: 'Wood & Timber',
    finishLabel: 'Satin',
    roughness: 0.44,
    metalness: 0.0,
    previewBase: '#D7B78E',
    previewAccent: '#865F38',
    capabilities: {
      supportsPatternScale: true,
      supportsRotation: true,
      supportsDimensions: true,
      defaultWidthMm: 120,
      defaultLengthMm: 480,
      dimWidthLabel: 'Block width',
      dimLengthLabel: 'Block length',
      cellsX: 4,
      cellsY: 2,
      supportsGrout: true,
      defaultGroutMm: 2,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.5,
      recommendedForBacksplash: true,
    },
  },
  {
    id: 'chevron',
    label: 'French Chevron',
    category: 'Wood & Timber',
    finishLabel: 'Satin',
    roughness: 0.44,
    metalness: 0.0,
    previewBase: '#D3B084',
    previewAccent: '#7C5630',
    capabilities: {
      supportsPatternScale: true,
      supportsRotation: true,
      supportsDimensions: true,
      defaultWidthMm: 120,
      defaultLengthMm: 520,
      dimWidthLabel: 'Plank width',
      dimLengthLabel: 'Chevron pitch',
      cellsX: 4,
      cellsY: 2,
      supportsGrout: true,
      defaultGroutMm: 2,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.5,
    },
  },
  {
    id: 'basketweave',
    label: 'Basketweave Parquet',
    category: 'Wood & Timber',
    finishLabel: 'Inlaid',
    roughness: 0.46,
    metalness: 0.0,
    previewBase: '#C8A06F',
    previewAccent: '#6F4B27',
    capabilities: {
      supportsPatternScale: true,
      supportsRotation: true,
      supportsDimensions: true,
      defaultWidthMm: 240,
      defaultLengthMm: 240,
      dimWidthLabel: 'Tile width',
      dimLengthLabel: 'Tile height',
      cellsX: 2,
      cellsY: 2,
      supportsGrout: true,
      defaultGroutMm: 2,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.46,
    },
  },

  // Stone & Brick
  {
    id: 'marble',
    label: 'Carrara Marble',
    category: 'Stone & Brick',
    finishLabel: 'Polished',
    roughness: 0.18,
    metalness: 0.02,
    previewBase: '#F7F7F6',
    previewAccent: '#8F969E',
    capabilities: {
      supportsSecondaryColor: true,
      secondaryColorLabel: 'Vein tone',
      supportsPatternScale: true,
      supportsRotation: true,
      supportsDimensions: true,
      defaultWidthMm: 800,
      defaultLengthMm: 800,
      dimWidthLabel: 'Slab width',
      dimLengthLabel: 'Slab length',
      cellsX: 2,
      cellsY: 2,
      supportsGrout: true,
      defaultGroutMm: 2,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.85,
      recommendedForBacksplash: true,
    },
  },
  {
    id: 'calacatta_gold',
    label: 'Calacatta Gold',
    category: 'Stone & Brick',
    finishLabel: 'Polished',
    roughness: 0.18,
    metalness: 0.02,
    previewBase: '#FBF8F3',
    previewAccent: '#B89558',
    previewSecondary: '#8A8680',
    capabilities: {
      supportsSecondaryColor: true,
      secondaryColorLabel: 'Gold vein tone',
      supportsPatternScale: true,
      supportsRotation: true,
      supportsDimensions: true,
      defaultWidthMm: 800,
      defaultLengthMm: 800,
      dimWidthLabel: 'Slab width',
      dimLengthLabel: 'Slab length',
      cellsX: 2,
      cellsY: 2,
      supportsGrout: true,
      defaultGroutMm: 2,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.85,
      recommendedForBacksplash: true,
    },
  },
  {
    id: 'nero_marble',
    label: 'Nero Marquina',
    category: 'Stone & Brick',
    finishLabel: 'Polished',
    roughness: 0.16,
    metalness: 0.02,
    previewBase: '#1C1F24',
    previewAccent: '#E2E8F0',
    capabilities: {
      supportsSecondaryColor: true,
      secondaryColorLabel: 'White vein tone',
      supportsPatternScale: true,
      supportsRotation: true,
      supportsDimensions: true,
      defaultWidthMm: 800,
      defaultLengthMm: 800,
      dimWidthLabel: 'Slab width',
      dimLengthLabel: 'Slab length',
      cellsX: 2,
      cellsY: 2,
      supportsGrout: true,
      defaultGroutMm: 2,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.88,
      recommendedForBacksplash: true,
    },
  },
  {
    id: 'travertine',
    label: 'Roman Travertine',
    category: 'Stone & Brick',
    finishLabel: 'Honed',
    roughness: 0.64,
    metalness: 0.0,
    previewBase: '#E5D8C3',
    previewAccent: '#B59F82',
    capabilities: {
      supportsPatternScale: true,
      supportsRotation: true,
      supportsDimensions: true,
      defaultWidthMm: 600,
      defaultLengthMm: 400,
      dimWidthLabel: 'Stone width',
      dimLengthLabel: 'Stone height',
      cellsX: 2,
      cellsY: 2,
      supportsGrout: true,
      defaultGroutMm: 3,
      supportsStagger: true,
      defaultStaggerPct: 50,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.28,
      recommendedForBacksplash: true,
    },
  },
  {
    id: 'limestone',
    label: 'Honed Limestone',
    category: 'Stone & Brick',
    finishLabel: 'Matte Slab',
    roughness: 0.70,
    metalness: 0.0,
    previewBase: '#E4DFD3',
    previewAccent: '#B7B0A1',
    capabilities: {
      supportsSecondaryColor: true,
      secondaryColorLabel: 'Joint / tone',
      supportsPatternScale: true,
      supportsRotation: true,
      supportsDimensions: true,
      defaultWidthMm: 600,
      defaultLengthMm: 600,
      dimWidthLabel: 'Tile width',
      dimLengthLabel: 'Tile length',
      cellsX: 2,
      cellsY: 2,
      supportsGrout: true,
      defaultGroutMm: 3,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.24,
    },
  },
  {
    id: 'slate',
    label: 'Charcoal Slate',
    category: 'Stone & Brick',
    finishLabel: 'Cleft',
    roughness: 0.72,
    metalness: 0.02,
    previewBase: '#3A3F45',
    previewAccent: '#1E2226',
    capabilities: {
      supportsPatternScale: true,
      supportsRotation: true,
      supportsDimensions: true,
      defaultWidthMm: 600,
      defaultLengthMm: 300,
      dimWidthLabel: 'Tile width',
      dimLengthLabel: 'Tile height',
      cellsX: 2,
      cellsY: 2,
      supportsGrout: true,
      defaultGroutMm: 4,
      supportsStagger: true,
      defaultStaggerPct: 50,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.22,
    },
  },
  {
    id: 'concrete',
    label: 'Architectural Concrete',
    category: 'Stone & Brick',
    finishLabel: 'Raw',
    roughness: 0.86,
    metalness: 0.0,
    previewBase: '#9FA4AA',
    previewAccent: '#6C7279',
    capabilities: {
      supportsPatternScale: true,
      supportsRotation: true,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.16,
    },
  },
  {
    id: 'brick',
    label: 'Exposed Clay Brick',
    category: 'Stone & Brick',
    finishLabel: 'Masonry',
    roughness: 0.90,
    metalness: 0.0,
    previewBase: '#A64B33',
    previewAccent: '#D1CBC3',
    previewSecondary: '#73301E',
    capabilities: {
      supportsSecondaryColor: true,
      secondaryColorLabel: 'Mortar joint color',
      supportsPatternScale: true,
      supportsRotation: true,
      supportsDimensions: true,
      defaultWidthMm: 215,
      defaultLengthMm: 75,
      dimWidthLabel: 'Brick length',
      dimLengthLabel: 'Course height',
      cellsX: 2,
      cellsY: 2,
      supportsGrout: true,
      defaultGroutMm: 10,
      supportsStagger: true,
      defaultStaggerPct: 50,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.08,
      recommendedForBacksplash: true,
    },
  },

  // Tile & Terrazzo
  {
    id: 'tile',
    label: 'Square Ceramic Tile',
    category: 'Tile & Terrazzo',
    finishLabel: 'Glazed',
    roughness: 0.24,
    metalness: 0.03,
    previewBase: '#F3F5F7',
    previewAccent: '#94A3B8',
    capabilities: {
      supportsSecondaryColor: true,
      secondaryColorLabel: 'Grout line color',
      supportsPatternScale: true,
      supportsRotation: true,
      supportsDimensions: true,
      defaultWidthMm: 300,
      defaultLengthMm: 300,
      dimWidthLabel: 'Tile width',
      dimLengthLabel: 'Tile height',
      cellsX: 2,
      cellsY: 2,
      supportsGrout: true,
      defaultGroutMm: 4,
      supportsStagger: true,
      defaultStaggerPct: 0,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.72,
      recommendedForBacksplash: true,
    },
  },
  {
    id: 'subway_tile',
    label: 'Subway Ceramic Tile',
    category: 'Tile & Terrazzo',
    finishLabel: 'Running Bond',
    roughness: 0.20,
    metalness: 0.03,
    previewBase: '#F8FAFC',
    previewAccent: '#94A3B8',
    capabilities: {
      supportsSecondaryColor: true,
      secondaryColorLabel: 'Grout line color',
      supportsPatternScale: true,
      supportsRotation: true,
      supportsDimensions: true,
      defaultWidthMm: 200,
      defaultLengthMm: 100,
      dimWidthLabel: 'Tile length',
      dimLengthLabel: 'Tile height',
      cellsX: 2,
      cellsY: 2,
      supportsGrout: true,
      defaultGroutMm: 3,
      supportsStagger: true,
      defaultStaggerPct: 50,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.78,
      recommendedForBacksplash: true,
    },
  },
  {
    id: 'porcelain_slab',
    label: 'Large Porcelain Tile',
    category: 'Tile & Terrazzo',
    finishLabel: 'Rectified',
    roughness: 0.30,
    metalness: 0.02,
    previewBase: '#EFECE6',
    previewAccent: '#A1A1AA',
    capabilities: {
      supportsSecondaryColor: true,
      secondaryColorLabel: 'Grout line color',
      supportsPatternScale: true,
      supportsRotation: true,
      supportsDimensions: true,
      defaultWidthMm: 600,
      defaultLengthMm: 600,
      dimWidthLabel: 'Slab width',
      dimLengthLabel: 'Slab length',
      cellsX: 2,
      cellsY: 2,
      supportsGrout: true,
      defaultGroutMm: 2,
      supportsStagger: true,
      defaultStaggerPct: 0,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.62,
      recommendedForBacksplash: true,
    },
  },
  {
    id: 'hex_tile',
    label: 'Hex Mosaic Tile',
    category: 'Tile & Terrazzo',
    finishLabel: 'Satin',
    roughness: 0.28,
    metalness: 0.03,
    previewBase: '#ECEFF2',
    previewAccent: '#7E8A98',
    capabilities: {
      supportsSecondaryColor: true,
      secondaryColorLabel: 'Grout line color',
      supportsPatternScale: true,
      supportsRotation: true,
      supportsDimensions: true,
      defaultWidthMm: 120,
      defaultLengthMm: 104,
      dimWidthLabel: 'Hex width',
      dimLengthLabel: 'Hex height',
      cellsX: 4,
      cellsY: 4,
      supportsGrout: true,
      defaultGroutMm: 3,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.65,
      recommendedForBacksplash: true,
    },
  },
  {
    id: 'penny_tile',
    label: 'Penny Round Mosaic',
    category: 'Tile & Terrazzo',
    finishLabel: 'Glazed Mosaic',
    roughness: 0.22,
    metalness: 0.03,
    previewBase: '#F8FAFC',
    previewAccent: '#64748B',
    capabilities: {
      supportsSecondaryColor: true,
      secondaryColorLabel: 'Grout background',
      supportsPatternScale: true,
      supportsRotation: true,
      supportsDimensions: true,
      defaultWidthMm: 36,
      defaultLengthMm: 36,
      dimWidthLabel: 'Mosaic pitch',
      dimLengthLabel: 'Row pitch',
      cellsX: 6,
      cellsY: 6,
      supportsGrout: true,
      defaultGroutMm: 4,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.72,
      recommendedForBacksplash: true,
    },
  },
  {
    id: 'checker',
    label: 'Checkerboard Stone',
    category: 'Tile & Terrazzo',
    finishLabel: 'Honed',
    roughness: 0.30,
    metalness: 0.02,
    previewBase: '#F8FAFC',
    previewAccent: '#334155',
    capabilities: {
      supportsSecondaryColor: true,
      secondaryColorLabel: 'Tile 2 color (Dark / Alternate)',
      supportsPatternScale: true,
      supportsRotation: true,
      supportsDimensions: true,
      defaultWidthMm: 300,
      defaultLengthMm: 300,
      dimWidthLabel: 'Square width',
      dimLengthLabel: 'Square length',
      cellsX: 2,
      cellsY: 2,
      supportsGrout: true,
      defaultGroutMm: 3,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.58,
      recommendedForBacksplash: true,
    },
  },
  {
    id: 'harlequin',
    label: 'Harlequin Diamond Tile',
    category: 'Tile & Terrazzo',
    finishLabel: 'Geometric',
    roughness: 0.26,
    metalness: 0.02,
    previewBase: '#F8FAFC',
    previewAccent: '#1E293B',
    capabilities: {
      supportsSecondaryColor: true,
      secondaryColorLabel: 'Tile 2 color (Diamond)',
      supportsPatternScale: true,
      supportsRotation: true,
      supportsDimensions: true,
      defaultWidthMm: 280,
      defaultLengthMm: 280,
      dimWidthLabel: 'Diamond width',
      dimLengthLabel: 'Diamond height',
      cellsX: 2,
      cellsY: 2,
      supportsGrout: true,
      defaultGroutMm: 3,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.65,
      recommendedForBacksplash: true,
    },
  },
  {
    id: 'encaustic_tile',
    label: 'Encaustic Star Tile',
    category: 'Tile & Terrazzo',
    finishLabel: 'Artisan Cement',
    roughness: 0.50,
    metalness: 0.0,
    previewBase: '#F8FAFC',
    previewAccent: '#334155',
    previewSecondary: '#64748B',
    capabilities: {
      supportsSecondaryColor: true,
      secondaryColorLabel: 'Motif accent color',
      supportsPatternScale: true,
      supportsRotation: true,
      supportsDimensions: true,
      defaultWidthMm: 200,
      defaultLengthMm: 200,
      dimWidthLabel: 'Tile width',
      dimLengthLabel: 'Tile height',
      cellsX: 2,
      cellsY: 2,
      supportsGrout: true,
      defaultGroutMm: 3,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.36,
      recommendedForBacksplash: true,
    },
  },
  {
    id: 'pinwheel_tile',
    label: 'Pinwheel Mosaic Tile',
    category: 'Tile & Terrazzo',
    finishLabel: 'Geometric',
    roughness: 0.28,
    metalness: 0.02,
    previewBase: '#F1F5F9',
    previewAccent: '#475569',
    capabilities: {
      supportsSecondaryColor: true,
      secondaryColorLabel: 'Center cabochon color',
      supportsPatternScale: true,
      supportsRotation: true,
      supportsDimensions: true,
      defaultWidthMm: 220,
      defaultLengthMm: 220,
      dimWidthLabel: 'Module width',
      dimLengthLabel: 'Module height',
      cellsX: 2,
      cellsY: 2,
      supportsGrout: true,
      defaultGroutMm: 3,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.62,
      recommendedForBacksplash: true,
    },
  },
  {
    id: 'terrazzo',
    label: 'Venetian Terrazzo',
    category: 'Tile & Terrazzo',
    finishLabel: 'Honed',
    roughness: 0.34,
    metalness: 0.02,
    previewBase: '#E8E2D7',
    previewAccent: '#5C5852',
    previewSecondary: '#A88C6D',
    capabilities: {
      supportsSecondaryColor: true,
      secondaryColorLabel: 'Aggregate chip color',
      supportsPatternScale: true,
      supportsRotation: true,
      supportsRoughness: true,
      supportsReflectivity: true,
      defaultReflectivity: 0.56,
      recommendedForBacksplash: true,
    },
  },

  // Textiles & Leather
  {
    id: 'fabric',
    label: 'Woven Linen',
    category: 'Textiles & Leather',
    finishLabel: 'Textile',
    roughness: 0.88,
    metalness: 0.0,
    previewBase: '#EFECE6',
    previewAccent: '#A9A295',
    capabilities: { supportsPatternScale: true, supportsRotation: true, supportsRoughness: true },
  },
  {
    id: 'boucle',
    label: 'Cream Bouclé',
    category: 'Textiles & Leather',
    finishLabel: 'Looped Wool',
    roughness: 0.94,
    metalness: 0.0,
    previewBase: '#F3EFE6',
    previewAccent: '#C5BBA8',
    capabilities: { supportsPatternScale: true, supportsRoughness: true },
  },
  {
    id: 'velvet',
    label: 'Plush Velvet',
    category: 'Textiles & Leather',
    finishLabel: 'Soft Nap',
    roughness: 0.78,
    metalness: 0.0,
    previewBase: '#CBD5E1',
    previewAccent: '#64748B',
    capabilities: { supportsRoughness: true, supportsReflectivity: true, defaultReflectivity: 0.4 },
  },
  {
    id: 'leather_cognac',
    label: 'Cognac Leather',
    category: 'Textiles & Leather',
    finishLabel: 'Aniline',
    roughness: 0.44,
    metalness: 0.0,
    previewBase: '#A65E2E',
    previewAccent: '#6B3817',
    capabilities: { supportsRoughness: true, supportsReflectivity: true, defaultReflectivity: 0.35 },
  },
  {
    id: 'leather_black',
    label: 'Black Grain Leather',
    category: 'Textiles & Leather',
    finishLabel: 'Semi-Matte',
    roughness: 0.46,
    metalness: 0.0,
    previewBase: '#26292E',
    previewAccent: '#111316',
    capabilities: { supportsRoughness: true, supportsReflectivity: true, defaultReflectivity: 0.35 },
  },
  {
    id: 'leather_cream',
    label: 'Ivory Saddle Leather',
    category: 'Textiles & Leather',
    finishLabel: 'Supple',
    roughness: 0.44,
    metalness: 0.0,
    previewBase: '#F2ECE1',
    previewAccent: '#C9BCA6',
    capabilities: { supportsRoughness: true, supportsReflectivity: true, defaultReflectivity: 0.35 },
  },

  // Metals & Plastics
  {
    id: 'metal',
    label: 'Brushed Steel',
    category: 'Metals & Plastics',
    finishLabel: 'Metallic',
    roughness: 0.30,
    metalness: 0.90,
    previewBase: '#CBD5E1',
    previewAccent: '#64748B',
    capabilities: { supportsRoughness: true, supportsReflectivity: true, defaultReflectivity: 0.9, recommendedForBacksplash: true },
  },
  {
    id: 'brass',
    label: 'Brushed Brass',
    category: 'Metals & Plastics',
    finishLabel: 'Metallic',
    roughness: 0.32,
    metalness: 0.92,
    previewBase: '#D4AE5E',
    previewAccent: '#8C6A24',
    capabilities: { supportsRoughness: true, supportsReflectivity: true, defaultReflectivity: 0.9, recommendedForBacksplash: true },
  },
  {
    id: 'bronze',
    label: 'Oil-Rubbed Bronze',
    category: 'Metals & Plastics',
    finishLabel: 'Metallic',
    roughness: 0.38,
    metalness: 0.88,
    previewBase: '#5A4636',
    previewAccent: '#2C2118',
    capabilities: { supportsRoughness: true, supportsReflectivity: true, defaultReflectivity: 0.85 },
  },
  {
    id: 'chrome',
    label: 'Polished Chrome',
    category: 'Metals & Plastics',
    finishLabel: 'Mirror Metal',
    roughness: 0.08,
    metalness: 0.98,
    previewBase: '#E2E8F0',
    previewAccent: '#475569',
    capabilities: { supportsRoughness: true, supportsReflectivity: true, defaultReflectivity: 1.0 },
  },
  {
    id: 'matte_black_metal',
    label: 'Matte Black Steel',
    category: 'Metals & Plastics',
    finishLabel: 'Powder Coat',
    roughness: 0.50,
    metalness: 0.72,
    previewBase: '#272B30',
    previewAccent: '#0F1215',
    capabilities: { supportsRoughness: true, supportsReflectivity: true, defaultReflectivity: 0.55 },
  },
  {
    id: 'plastic_matte',
    label: 'Matte Polymer ABS',
    category: 'Metals & Plastics',
    finishLabel: 'Matte',
    roughness: 0.58,
    metalness: 0.0,
    previewBase: '#E2E8F0',
    previewAccent: '#94A3B8',
    capabilities: { supportsRoughness: true, supportsReflectivity: true, defaultReflectivity: 0.2 },
  },
  {
    id: 'plastic_gloss',
    label: 'Gloss Acrylic',
    category: 'Metals & Plastics',
    finishLabel: 'High Gloss',
    roughness: 0.14,
    metalness: 0.02,
    previewBase: '#F8FAFC',
    previewAccent: '#CBD5E1',
    capabilities: { supportsRoughness: true, supportsReflectivity: true, defaultReflectivity: 0.88 },
  },
  {
    id: 'glass',
    label: 'Clear Glass',
    category: 'Metals & Plastics',
    finishLabel: 'Transparent',
    roughness: 0.06,
    metalness: 0.08,
    previewBase: '#E0F2FE',
    previewAccent: '#7DD3FC',
    capabilities: { supportsRoughness: true, supportsReflectivity: true, defaultReflectivity: 0.95 },
  },
];

export function getMaterialPresetMeta(id: MaterialPreset): MaterialPresetMeta {
  return MATERIAL_PRESETS.find((m) => m.id === id) ?? MATERIAL_PRESETS[0];
}

export function getMaterialCapabilities(id: MaterialPreset): MaterialCapabilities {
  return getMaterialPresetMeta(id).capabilities ?? {};
}

export function isPresetPreTinted(preset: MaterialPreset): boolean {
  switch (preset) {
    case 'oak':
    case 'oak_wide':
    case 'walnut':
    case 'teak':
    case 'smoked_oak':
    case 'wood_strip':
    case 'parquet':
    case 'herringbone':
    case 'chevron':
    case 'basketweave':
    case 'calacatta_gold':
    case 'nero_marble':
    case 'travertine':
    case 'limestone':
    case 'slate':
    case 'concrete':
    case 'microcement':
    case 'brick':
    case 'terrazzo':
    case 'leather_cognac':
    case 'leather_black':
    case 'brass':
    case 'bronze':
    case 'matte_black_metal':
      return true;
    default:
      return false;
  }
}

export function getDefaultTileMeters(preset: MaterialPreset): number {
  switch (preset) {
    case 'wood':
    case 'oak':
    case 'oak_wide':
    case 'walnut':
    case 'teak':
    case 'smoked_oak':
    case 'wood_strip':
      return 1.1;
    case 'parquet':
    case 'herringbone':
    case 'chevron':
    case 'basketweave':
      return 1.35;
    case 'marble':
    case 'calacatta_gold':
    case 'nero_marble':
    case 'travertine':
    case 'limestone':
    case 'slate':
      return 1.6;
    case 'concrete':
    case 'microcement':
    case 'plaster':
    case 'stucco':
      return 2.0;
    case 'brick':
      return 1.4;
    case 'tile':
    case 'subway_tile':
    case 'porcelain_slab':
    case 'hex_tile':
    case 'penny_tile':
    case 'checker':
    case 'harlequin':
    case 'encaustic_tile':
    case 'pinwheel_tile':
      return 0.95;
    case 'terrazzo':
      return 1.15;
    case 'fabric':
    case 'boucle':
    case 'velvet':
    case 'wallpaper':
    case 'striped_wallpaper':
      return 0.48;
    case 'leather_cognac':
    case 'leather_black':
    case 'leather_cream':
      return 0.65;
    case 'paneling':
    case 'ribbed_paneling':
      return 1.0;
    case 'metal':
    case 'brass':
    case 'bronze':
    case 'chrome':
    case 'matte_black_metal':
      return 0.65;
    default:
      return 1.0;
  }
}

/**
 * Resolves the unified base hex color displayed across both 2D and 3D views:
 * pre-tinted presets keep their characteristic wood/stone base tone unless a custom
 * tint is chosen, while paint/fabric/default white uses the assigned color directly.
 */
export function getEffectiveMaterialHex(preset: MaterialPreset, colorHex?: string): string {
  const norm = (colorHex || '#FFFFFF').toUpperCase();
  const meta = getMaterialPresetMeta(preset);
  if (norm !== '#FFFFFF') {
    return norm;
  }
  if (isPresetPreTinted(preset)) {
    return meta.previewBase.toUpperCase();
  }
  return norm;
}

export const SWATCH_PALETTE: string[] = [
  '#FFFFFF',
  '#F8FAFC',
  '#E2E8F0',
  '#CBD5E1',
  '#94A3B8',
  '#475569',
  '#1E293B',
  '#0F172A',
  '#F5F0E6',
  '#E6D5B8',
  '#C8A97E',
  '#9C6B3F',
  '#7C4D2B',
  '#5C3A21',
  '#D97706',
  '#B45309',
  '#DBEAFE',
  '#93C5FD',
  '#3B82F6',
  '#1D4ED8',
  '#D1FAE5',
  '#6EE7B7',
  '#10B981',
  '#047857',
];
