export interface PublicModifier {
  id: string
  name: string
  price: number
  /** Minutes this modifier extends the booked service when picked. Null = no
   *  duration impact. Server multiplies by selected quantity. */
  durationMin: number | null
  active: boolean
}

export interface PublicModifierGroup {
  id: string
  name: string
  description: string | null
  required: boolean
  allowMultiple: boolean
  minSelections: number
  maxSelections: number | null
  displayOrder: number
  modifiers: PublicModifier[]
}
