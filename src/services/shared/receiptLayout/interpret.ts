import { renderItems, renderOrderInfo, renderStaff } from './blocks/body'
import {
  renderAmountInWords,
  renderAreaDelivery,
  renderFiscalNotice,
  renderPayment,
  renderQr,
  renderReference,
  renderSignature,
  renderTotals,
} from './blocks/footer'
import { renderAddress, renderBusinessName, renderFiscal, renderLogo, renderPhone, renderSeparator, renderText } from './blocks/header'
import type { Block } from './schema'
import type { LogicalLine, PaperWidth, ReceiptInput } from './types'

/**
 * El intérprete de referencia (spec § 6): receta + venta + ancho → líneas lógicas. PURO.
 * Android, iOS y la PAX implementan esta misma función; los casos dorados son la prueba de
 * que las cuatro coinciden. Bloque a bloque, en el orden de la receta, sin excepciones.
 */
export function interpret(blocks: Block[], input: ReceiptInput, width: PaperWidth): LogicalLine[] {
  return blocks.flatMap(block => renderBlock(block, input, width))
}

function renderBlock(block: Block, input: ReceiptInput, width: PaperWidth): LogicalLine[] {
  switch (block.type) {
    case 'logo':
      return renderLogo(block, input, width)
    case 'businessName':
      return renderBusinessName(block, input, width)
    case 'fiscal':
      return renderFiscal(block, input, width)
    case 'address':
      return renderAddress(block, input, width)
    case 'phone':
      return renderPhone(block, input, width)
    case 'text':
      return renderText(block, input, width)
    case 'separator':
      return renderSeparator(block, input, width)
    case 'orderInfo':
      return renderOrderInfo(block, input, width)
    case 'staff':
      return renderStaff(block, input, width)
    case 'items':
      return renderItems(block, input, width)
    case 'totals':
      return renderTotals(block, input, width)
    case 'payment':
      return renderPayment(block, input, width)
    case 'amountInWords':
      return renderAmountInWords(block, input, width)
    case 'areaDelivery':
      return renderAreaDelivery(block, input, width)
    case 'qr':
      return renderQr(block, input, width)
    case 'fiscalNotice':
      return renderFiscalNotice(block, input, width)
    case 'reference':
      return renderReference(block, input, width)
    case 'signature':
      return renderSignature(block, input, width)
    default: {
      // Un tipo nuevo en el catálogo sin renderer no compila: el `never` lo obliga a aparecer aquí.
      const nunca: never = block
      return nunca
    }
  }
}
