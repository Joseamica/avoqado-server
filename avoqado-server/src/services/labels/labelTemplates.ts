/**
 * Label Templates for Purchase Order Label Printing
 * Supports Avery, DYMO, and Zebra label formats
 */

export interface LabelTemplate {
  pageSize: [number, number] // Width, Height in points (1 point = 1/72 inch)
  width: number // Label width in points
  height: number // Label height in points
  rows: number // Number of labels per column
  cols: number // Number of labels per row
  marginX: number // Left margin in points
  marginY: number // Top margin in points
  gapX: number // Horizontal gap between labels in points
  gapY: number // Vertical gap between labels in points
  labelsPerPage: number // Total labels per page
}

// Convert inches to points (1 inch = 72 points)
const inch = (inches: number) => inches * 72

/**
 * Avery Label Templates
 * Based on Avery Easy Peel Address Labels
 */
export const AVERY_TEMPLATES: Record<string, LabelTemplate> = {
  // Avery 5160/8160 - Easy Peel Address Labels 1" x 2 5/8"
  'avery-5160': {
    pageSize: [612, 792], // Letter: 8.5" x 11"
    width: inch(2.625), // 2 5/8"
    height: inch(1),
    rows: 10,
    cols: 3,
    marginX: inch(0.1875), // ~13.5 points
    marginY: inch(0.5),
    gapX: inch(0.125),
    gapY: 0,
    labelsPerPage: 30,
  },

  // Avery 5161/8161 - Easy Peel Address Labels 1" x 4"
  'avery-5161': {
    pageSize: [612, 792],
    width: inch(4),
    height: inch(1),
    rows: 10,
    cols: 2,
    marginX: inch(0.15625),
    marginY: inch(0.5),
    gapX: inch(0.1875),
    gapY: 0,
    labelsPerPage: 20,
  },

  // Avery 5167/8167 - Easy Peel Return Address Labels 1/2" x 1 3/4"
  'avery-5167': {
    pageSize: [612, 792],
    width: inch(1.75),
    height: inch(0.5),
    rows: 20,
    cols: 4,
    marginX: inch(0.28125),
    marginY: inch(0.5),
    gapX: inch(0.28125),
    gapY: 0,
    labelsPerPage: 80,
  },

  // Avery 5195/8195 - Easy Peel Return Address Labels 2/3" x 1 3/4"
  'avery-5195': {
    pageSize: [612, 792],
    width: inch(1.75),
    height: inch(0.667),
    rows: 15,
    cols: 4,
    marginX: inch(0.28125),
    marginY: inch(0.5),
    gapX: inch(0.28125),
    gapY: 0,
    labelsPerPage: 60,
  },
}

/**
 * DYMO Label Templates
 * For DYMO LabelWriter thermal printers
 */
export const DYMO_TEMPLATES: Record<string, LabelTemplate> = {
  // DYMO 1738595 - LW Barcode Labels 3/4" x 2 1/2"
  'dymo-1738595': {
    pageSize: [inch(2.5), inch(0.75)],
    width: inch(2.5),
    height: inch(0.75),
    rows: 1,
    cols: 1,
    marginX: 0,
    marginY: 0,
    gapX: 0,
    gapY: 0,
    labelsPerPage: 1,
  },

  // DYMO 30330 - LW Address Labels 3/4" x 2"
  'dymo-30330': {
    pageSize: [inch(2), inch(0.75)],
    width: inch(2),
    height: inch(0.75),
    rows: 1,
    cols: 1,
    marginX: 0,
    marginY: 0,
    gapX: 0,
    gapY: 0,
    labelsPerPage: 1,
  },

  // DYMO 30332 - LW Multi-Purpose Labels 1" x 1"
  'dymo-30332': {
    pageSize: [inch(1), inch(1)],
    width: inch(1),
    height: inch(1),
    rows: 1,
    cols: 1,
    marginX: 0,
    marginY: 0,
    gapX: 0,
    gapY: 0,
    labelsPerPage: 1,
  },

  // DYMO 30334 - LW Multi-Purpose Labels 1 1/4" x 2 1/4"
  'dymo-30334': {
    pageSize: [inch(2.25), inch(1.25)],
    width: inch(2.25),
    height: inch(1.25),
    rows: 1,
    cols: 1,
    marginX: 0,
    marginY: 0,
    gapX: 0,
    gapY: 0,
    labelsPerPage: 1,
  },

  // DYMO 30336 - LW Multi-Purpose Labels 1" x 2 1/8"
  'dymo-30336': {
    pageSize: [inch(2.125), inch(1)],
    width: inch(2.125),
    height: inch(1),
    rows: 1,
    cols: 1,
    marginX: 0,
    marginY: 0,
    gapX: 0,
    gapY: 0,
    labelsPerPage: 1,
  },
}

/**
 * Zebra Label Templates
 * For Zebra thermal printers
 */
export const ZEBRA_TEMPLATES: Record<string, LabelTemplate> = {
  // Zebra 1 1/2" x 1"
  'zebra-1.5x1': {
    pageSize: [inch(1.5), inch(1)],
    width: inch(1.5),
    height: inch(1),
    rows: 1,
    cols: 1,
    marginX: 0,
    marginY: 0,
    gapX: 0,
    gapY: 0,
    labelsPerPage: 1,
  },

  // Zebra 1 1/2" x 1/2"
  'zebra-1.5x0.5': {
    pageSize: [inch(1.5), inch(0.5)],
    width: inch(1.5),
    height: inch(0.5),
    rows: 1,
    cols: 1,
    marginX: 0,
    marginY: 0,
    gapX: 0,
    gapY: 0,
    labelsPerPage: 1,
  },

  // Zebra 1" x 1"
  'zebra-1x1': {
    pageSize: [inch(1), inch(1)],
    width: inch(1),
    height: inch(1),
    rows: 1,
    cols: 1,
    marginX: 0,
    marginY: 0,
    gapX: 0,
    gapY: 0,
    labelsPerPage: 1,
  },

  // Zebra 1.2" x 0.85"
  'zebra-1.2x0.85': {
    pageSize: [inch(1.2), inch(0.85)],
    width: inch(1.2),
    height: inch(0.85),
    rows: 1,
    cols: 1,
    marginX: 0,
    marginY: 0,
    gapX: 0,
    gapY: 0,
    labelsPerPage: 1,
  },
}

/**
 * All Templates Combined
 */
export const ALL_TEMPLATES = {
  ...AVERY_TEMPLATES,
  ...DYMO_TEMPLATES,
  ...ZEBRA_TEMPLATES,
}

/**
 * Get label template by ID
 */
export function getLabelTemplate(templateId: string): LabelTemplate {
  const template = ALL_TEMPLATES[templateId]
  if (!template) {
    // Default to Avery 5160 if template not found
    return AVERY_TEMPLATES['avery-5160']
  }
  return template
}

/**
 * Calculate position of a label on the page
 */
export function calculateLabelPosition(index: number, template: LabelTemplate): { x: number; y: number } {
  const row = Math.floor(index / template.cols)
  const col = index % template.cols

  return {
    x: template.marginX + col * (template.width + template.gapX),
    y: template.marginY + row * (template.height + template.gapY),
  }
}

/**
 * List of available label types for UI dropdown
 */
export const LABEL_TYPE_OPTIONS = [
  // Avery
  {
    value: 'avery-5160',
    label: 'Avery 5160/8160 - Easy Peel Address Labels 1 x 2 5/8',
    category: 'Avery',
  },
  {
    value: 'avery-5161',
    label: 'Avery 5161/8161 - Easy Peel Address Labels 1 x 4',
    category: 'Avery',
  },
  {
    value: 'avery-5167',
    label: 'Avery 5167/8167 - Easy Peel Return Address Labels 1/2 x 1 3/4',
    category: 'Avery',
  },
  {
    value: 'avery-5195',
    label: 'Avery 5195/8195 - Easy Peel Return Address Labels 2/3 x 1 3/4',
    category: 'Avery',
  },
  // DYMO
  {
    value: 'dymo-1738595',
    label: 'DYMO 1738595 - LW Barcode Labels 3/4 x 2 1/2',
    category: 'DYMO',
  },
  {
    value: 'dymo-30330',
    label: 'DYMO 30330 - LW Address Labels 3/4 x 2',
    category: 'DYMO',
  },
  {
    value: 'dymo-30332',
    label: 'DYMO 30332 - LW Multi-Purpose Labels 1 x 1',
    category: 'DYMO',
  },
  {
    value: 'dymo-30334',
    label: 'DYMO 30334 - LW Multi-Purpose Labels 1 1/4 x 2 1/4',
    category: 'DYMO',
  },
  {
    value: 'dymo-30336',
    label: 'DYMO 30336 - LW Multi-Purpose Labels 1 x 2 1/8',
    category: 'DYMO',
  },
  // Zebra
  {
    value: 'zebra-1.5x1',
    label: 'Zebra - 1 1/2 x 1',
    category: 'Zebra',
  },
  {
    value: 'zebra-1.5x0.5',
    label: 'Zebra - 1 1/2 x 1/2',
    category: 'Zebra',
  },
  {
    value: 'zebra-1x1',
    label: 'Zebra - 1 x 1',
    category: 'Zebra',
  },
  {
    value: 'zebra-1.2x0.85',
    label: 'Zebra - 1.2 x 0.85',
    category: 'Zebra',
  },
]
