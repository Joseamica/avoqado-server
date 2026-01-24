/**
 * Label Templates for PDF Generation
 * Defines physical dimensions and layout for various label types (Avery, DYMO, Zebra)
 */

export interface LabelTemplate {
  pageSize: [number, number] // Width, Height in points (1 inch = 72 points)
  width: number // Label width in points
  height: number // Label height in points
  rows: number // Number of label rows per page
  cols: number // Number of label columns per page
  marginX: number // Left margin in points
  marginY: number // Top margin in points
  gapX: number // Horizontal gap between labels in points
  gapY: number // Vertical gap between labels in points
  labelsPerPage: number // Total labels per page
}

/**
 * Convert inches to points (1 inch = 72 points)
 */
function inch(inches: number): number {
  return inches * 72
}

/**
 * Avery label templates
 */
export const AVERY_TEMPLATES: Record<string, LabelTemplate> = {
  'avery-5160': {
    pageSize: [612, 792], // Letter: 8.5" x 11"
    width: inch(2.625), // 2 5/8"
    height: inch(1),
    rows: 10,
    cols: 3,
    marginX: inch(0.1875), // 3/16"
    marginY: inch(0.5),
    gapX: inch(0.125), // 1/8"
    gapY: 0,
    labelsPerPage: 30,
  },
  'avery-5161': {
    pageSize: [612, 792],
    width: inch(4),
    height: inch(1),
    rows: 10,
    cols: 2,
    marginX: inch(0.15625), // 5/32"
    marginY: inch(0.5),
    gapX: inch(0.1875), // 3/16"
    gapY: 0,
    labelsPerPage: 20,
  },
  'avery-5167': {
    pageSize: [612, 792],
    width: inch(1.75), // 1 3/4"
    height: inch(0.5),
    rows: 20,
    cols: 4,
    marginX: inch(0.28125), // 9/32"
    marginY: inch(0.5),
    gapX: inch(0.21875), // 7/32"
    gapY: 0,
    labelsPerPage: 80,
  },
  'avery-5195': {
    pageSize: [612, 792],
    width: inch(1.75), // 1 3/4"
    height: inch(0.666), // 2/3"
    rows: 15,
    cols: 4,
    marginX: inch(0.28125), // 9/32"
    marginY: inch(0.4375), // 7/16"
    gapX: inch(0.21875), // 7/32"
    gapY: 0,
    labelsPerPage: 60,
  },
}

/**
 * DYMO label templates (thermal printers - single label sheets)
 */
export const DYMO_TEMPLATES: Record<string, LabelTemplate> = {
  'dymo-1738595': {
    pageSize: [inch(2.5), inch(0.75)], // 2 1/2" x 3/4"
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
  'dymo-30330': {
    pageSize: [inch(2), inch(0.75)], // 2" x 3/4"
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
  'dymo-30332': {
    pageSize: [inch(1), inch(1)], // 1" x 1"
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
  'dymo-30334': {
    pageSize: [inch(2.25), inch(1.25)], // 2 1/4" x 1 1/4"
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
  'dymo-30336': {
    pageSize: [inch(2.125), inch(1)], // 2 1/8" x 1"
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
 * Zebra label templates (thermal printers - single label sheets)
 */
export const ZEBRA_TEMPLATES: Record<string, LabelTemplate> = {
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
 * Get label template by type identifier
 */
export function getLabelTemplate(labelType: string): LabelTemplate {
  const allTemplates = {
    ...AVERY_TEMPLATES,
    ...DYMO_TEMPLATES,
    ...ZEBRA_TEMPLATES,
  }

  return allTemplates[labelType] || AVERY_TEMPLATES['avery-5160'] // Default to Avery 5160
}

/**
 * Calculate position for a label at given index
 */
export function calculateLabelPosition(index: number, template: LabelTemplate): { x: number; y: number } {
  const row = Math.floor(index / template.cols)
  const col = index % template.cols

  return {
    x: template.marginX + col * (template.width + template.gapX),
    y: template.marginY + row * (template.height + template.gapY),
  }
}
