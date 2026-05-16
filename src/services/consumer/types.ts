export interface PublicModifier {
  id: string
  name: string
  price: number
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
