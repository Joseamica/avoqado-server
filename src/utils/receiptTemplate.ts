/**
 * HTML template generator for digital receipts
 */

interface ReceiptData {
  payment: {
    id: string
    amount: number
    tipAmount: number
    method: string
    status: string
    splitType: string
    cardBrand?: string
    maskedPan?: string
    entryMode?: string
    authorizationNumber?: string
    referenceNumber?: string
    createdAt: string
  }
  venue: {
    id: string
    name: string
    address: string
    city: string
    state: string
    phone: string
    email: string
    logo?: string
    primaryColor?: string
  }
  order: {
    id: string
    orderNumber: string
    type: string
    source: string
    subtotal: number
    taxAmount: number
    tipAmount: number
    total: number
    table?: {
      number: string
      area?: string
    }
  }
  items: Array<{
    id: string
    productName: string
    quantity: number
    unitPrice: number
    total: number
    modifiers?: Array<{
      name: string
      quantity: number
      price: number
    }>
  }>
  processedBy?: {
    firstName: string
    lastName: string
  }
  receiptInfo: {
    generatedAt: string
    currency: string
    taxRate: number
  }
}

/**
 * Generate formatted currency string
 */
function formatCurrency(amount: number, currency: string = 'MXN'): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: currency,
  }).format(amount)
}

/**
 * Format date for display
 */
function formatDate(dateString: string): string {
  const date = new Date(dateString)
  return date.toLocaleString('es-MX', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })
}

/**
 * Generate payment method display text
 */
function formatPaymentMethod(method: string, cardBrand?: string, maskedPan?: string): string {
  if (method === 'CASH') {
    return 'Efectivo'
  }

  let methodText = ''
  switch (method) {
    case 'CREDIT_CARD':
      methodText = 'Tarjeta de Crédito'
      break
    case 'DEBIT_CARD':
      methodText = 'Tarjeta de Débito'
      break
    case 'DIGITAL_WALLET':
      methodText = 'Cartera Digital'
      break
    default:
      methodText = method
  }

  if (cardBrand || maskedPan) {
    const parts = []
    if (cardBrand) parts.push(cardBrand)
    if (maskedPan) parts.push(maskedPan)
    methodText += ` (${parts.join(' ')})`
  }

  return methodText
}

/**
 * Generate entry mode display text
 */
function formatEntryMode(entryMode?: string): string {
  if (!entryMode) return ''

  switch (entryMode.toUpperCase()) {
    case 'CONTACTLESS':
      return 'Sin contacto (NFC)'
    case 'CONTACT':
    case 'CHIP':
      return 'Chip'
    case 'SWIPE':
    case 'MAGSTRIPE':
      return 'Banda magnética'
    case 'MANUAL':
      return 'Captura manual'
    default:
      return entryMode
  }
}

/**
 * Generate complete HTML template for digital receipt
 */
export function generateReceiptHTML(data: ReceiptData): string {
  const primaryColor = data.venue.primaryColor || '#2563eb'
  const currency = data.receiptInfo.currency || 'MXN'

  return `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Recibo Digital - ${data.venue.name}</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%);
            min-height: 100vh;
            padding: 15px;
            color: #1a202c;
            line-height: 1.5;
        }
        
        .receipt-container {
            max-width: 580px;
            margin: 0 auto;
            background: white;
            border-radius: 20px;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(255, 255, 255, 0.8);
            overflow: hidden;
            position: relative;
        }
        
        .header {
            background: linear-gradient(135deg, ${primaryColor} 0%, ${primaryColor}dd 100%);
            color: white;
            padding: 35px 30px;
            text-align: center;
            position: relative;
            border-bottom: 2px solid rgba(255, 255, 255, 0.1);
        }
        
        .header::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><pattern id="grain" width="100" height="100" patternUnits="userSpaceOnUse"><circle cx="50" cy="50" r="1" fill="white" fill-opacity="0.1"/></pattern></defs><rect width="100" height="100" fill="url(%23grain)"/></svg>');
            opacity: 0.1;
        }
        
        .venue-logo {
            width: 80px;
            height: 80px;
            border-radius: 50%;
            margin: 0 auto 15px;
            background: white;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 32px;
            font-weight: bold;
            color: ${primaryColor};
            position: relative;
            z-index: 1;
        }
        
        .venue-name {
            font-size: 28px;
            font-weight: bold;
            margin-bottom: 8px;
            position: relative;
            z-index: 1;
        }
        
        .venue-address {
            font-size: 14px;
            opacity: 0.9;
            position: relative;
            z-index: 1;
        }
        
        .content {
            padding: 30px;
        }
        
        .receipt-info {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
            margin-bottom: 30px;
            padding: 20px;
            background: #f8fafc;
            border-radius: 12px;
            border-left: 4px solid ${primaryColor};
        }
        
        .info-group h3 {
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 5px;
            color: #6b7280;
        }
        
        .info-group p {
            font-size: 16px;
            font-weight: 500;
            color: #1f2937;
        }
        
        .order-items {
            margin: 30px 0;
        }
        
        .section-title {
            font-size: 18px;
            font-weight: bold;
            margin-bottom: 15px;
            color: #1f2937;
            border-bottom: 2px solid #e5e7eb;
            padding-bottom: 8px;
        }
        
        .item {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            padding: 15px 0;
            border-bottom: 1px solid #f3f4f6;
        }
        
        .item:last-child {
            border-bottom: none;
        }
        
        .item-details {
            flex: 1;
        }
        
        .item-name {
            font-weight: 600;
            font-size: 16px;
            margin-bottom: 4px;
            color: #1f2937;
        }
        
        .item-modifiers {
            font-size: 14px;
            color: #6b7280;
            margin-left: 10px;
        }
        
        .item-quantity {
            font-size: 14px;
            color: #6b7280;
        }
        
        .item-price {
            font-weight: 600;
            font-size: 16px;
            color: #1f2937;
            text-align: right;
        }
        
        .totals {
            background: #f8fafc;
            padding: 25px;
            border-radius: 12px;
            margin-top: 20px;
        }
        
        .total-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 10px;
            font-size: 16px;
        }
        
        .total-row.final {
            border-top: 2px solid ${primaryColor};
            padding-top: 15px;
            margin-top: 15px;
            font-size: 20px;
            font-weight: bold;
            color: ${primaryColor};
        }
        
        .payment-info {
            background: white;
            border: 2px solid #e5e7eb;
            border-radius: 12px;
            padding: 20px;
            margin-top: 25px;
        }
        
        .payment-method {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 15px;
        }
        
        .payment-icon {
            width: 40px;
            height: 40px;
            background: ${primaryColor};
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: bold;
        }
        
        .payment-details {
            font-size: 14px;
            color: #6b7280;
            line-height: 1.6;
        }
        
        .footer {
            text-align: center;
            padding: 25px;
            background: #f8fafc;
            border-top: 1px solid #e5e7eb;
        }
        
        .thank-you {
            font-size: 18px;
            font-weight: bold;
            color: ${primaryColor};
            margin-bottom: 10px;
        }
        
        .support-info {
            font-size: 14px;
            color: #6b7280;
            line-height: 1.6;
        }
        
        .powered-by {
            margin-top: 20px;
            font-size: 12px;
            color: #9ca3af;
        }
        
        .action-buttons {
            display: flex;
            gap: 15px;
            margin: 25px 0;
            flex-wrap: wrap;
        }
        
        .action-btn {
            flex: 1;
            min-width: 140px;
            padding: 12px 20px;
            border: none;
            border-radius: 12px;
            font-weight: 600;
            font-size: 14px;
            cursor: pointer;
            transition: all 0.3s ease;
            text-decoration: none;
            text-align: center;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
        }
        
        .btn-review {
            background: linear-gradient(135deg, ${primaryColor} 0%, ${primaryColor}dd 100%);
            color: white;
            box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3);
        }
        
        .btn-review:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(37, 99, 235, 0.4);
        }
        
        .btn-share {
            background: #10b981;
            color: white;
            box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
        }
        
        .btn-share:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(16, 185, 129, 0.4);
        }
        
        .btn-whatsapp {
            background: #25d366;
            color: white;
            box-shadow: 0 4px 12px rgba(37, 211, 102, 0.3);
        }
        
        .btn-whatsapp:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(37, 211, 102, 0.4);
        }
        
        .review-section {
            background: #f8fafc;
            border-radius: 12px;
            padding: 25px;
            margin: 25px 0;
            border-left: 4px solid ${primaryColor};
        }
        
        .review-form {
            display: none;
        }
        
        .review-form.active {
            display: block;
        }
        
        .rating-container {
            display: flex;
            gap: 5px;
            margin: 10px 0;
        }
        
        .star {
            font-size: 30px;
            color: #d1d5db;
            cursor: pointer;
            transition: color 0.2s;
        }
        
        .star.active {
            color: #fbbf24;
        }
        
        .star:hover {
            color: #fbbf24;
        }
        
        .form-group {
            margin: 15px 0;
        }
        
        .form-group label {
            display: block;
            margin-bottom: 5px;
            font-weight: 600;
            color: #374151;
        }
        
        .form-group input,
        .form-group textarea {
            width: 100%;
            padding: 10px;
            border: 2px solid #e5e7eb;
            border-radius: 8px;
            font-size: 14px;
            transition: border-color 0.2s;
        }
        
        .form-group input:focus,
        .form-group textarea:focus {
            outline: none;
            border-color: ${primaryColor};
        }
        
        .form-group textarea {
            min-height: 100px;
            resize: vertical;
        }
        
        .submit-btn {
            background: ${primaryColor};
            color: white;
            padding: 12px 24px;
            border: none;
            border-radius: 8px;
            font-weight: 600;
            cursor: pointer;
            width: 100%;
            margin-top: 15px;
        }
        
        .submit-btn:hover {
            background: ${primaryColor}dd;
        }
        
        .review-success {
            display: none;
            text-align: center;
            color: #10b981;
            font-weight: 600;
            margin: 20px 0;
        }
        
        .modal {
            display: none;
            position: fixed;
            z-index: 1000;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0,0,0,0.5);
        }
        
        .modal-content {
            background-color: white;
            margin: 10% auto;
            padding: 30px;
            border-radius: 16px;
            width: 90%;
            max-width: 500px;
            position: relative;
        }
        
        .close {
            position: absolute;
            right: 15px;
            top: 15px;
            font-size: 28px;
            font-weight: bold;
            cursor: pointer;
            color: #9ca3af;
        }
        
        .close:hover {
            color: #374151;
        }
        
        @media (max-width: 600px) {
            body {
                padding: 10px;
            }
            
            .receipt-info {
                grid-template-columns: 1fr;
                gap: 15px;
            }
            
            .content {
                padding: 20px;
            }
            
            .header {
                padding: 20px;
            }
            
            .venue-name {
                font-size: 24px;
            }
        }
        
        @media print {
            body {
                background: white;
                padding: 0;
            }
            
            .receipt-container {
                box-shadow: none;
                border-radius: 0;
            }
        }
    </style>
</head>
<body>
    <div class="receipt-container">
        <div class="header">
            <div class="venue-logo">
                ${data.venue.logo ? `<img src="${data.venue.logo}" alt="${data.venue.name}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;">` : data.venue.name.charAt(0)}
            </div>
            <div class="venue-name">${data.venue.name}</div>
            <div class="venue-address">
                ${data.venue.address}<br>
                ${data.venue.city}, ${data.venue.state}<br>
                Tel: ${data.venue.phone}
            </div>
        </div>
        
        <div class="content">
            <div class="receipt-info">
                <div class="info-group">
                    <h3>Número de Orden</h3>
                    <p>${data.order.orderNumber}</p>
                </div>
                <div class="info-group">
                    <h3>Fecha y Hora</h3>
                    <p>${formatDate(data.payment.createdAt)}</p>
                </div>
                ${
                  data.order.table
                    ? `
                <div class="info-group">
                    <h3>Mesa</h3>
                    <p>${data.order.table.number}${data.order.table.area ? ` - ${data.order.table.area}` : ''}</p>
                </div>`
                    : ''
                }
                ${
                  data.processedBy
                    ? `
                <div class="info-group">
                    <h3>Atendido por</h3>
                    <p>${data.processedBy.firstName} ${data.processedBy.lastName}</p>
                </div>`
                    : ''
                }
            </div>
            
            <div class="order-items">
                <h2 class="section-title">Productos</h2>
                ${data.items && data.items.length > 0
                  ? data.items
                      .map(
                        item => `
                        <div class="item">
                            <div class="item-details">
                                <div class="item-name">${item.productName}</div>
                                <div class="item-quantity">Cantidad: ${item.quantity}</div>
                                ${
                                  item.modifiers && item.modifiers.length > 0
                                    ? `
                                    <div class="item-modifiers">
                                        ${item.modifiers.map(mod => `+ ${mod.name} (${formatCurrency(mod.price, currency)})`).join('<br>')}
                                    </div>
                                `
                                    : ''
                                }
                            </div>
                            <div class="item-price">
                                ${formatCurrency(item.total, currency)}
                            </div>
                        </div>
                    `,
                      )
                      .join('')
                  : `
                    <div class="no-items">
                        <div style="text-align: center; padding: 30px; color: #6b7280; font-style: italic;">
                            <div style="font-size: 24px; margin-bottom: 10px;">🛒</div>
                            <p>No se registraron productos individuales para esta orden</p>
                            <p style="font-size: 14px; margin-top: 8px;">Total de la orden: ${formatCurrency(data.order?.total || 0, currency)}</p>
                        </div>
                    </div>
                `}
            </div>
            
            <div class="totals">
                <div class="total-row">
                    <span>Subtotal:</span>
                    <span>${formatCurrency(data.order.subtotal, currency)}</span>
                </div>
                <div class="total-row">
                    <span>IVA (${(data.receiptInfo.taxRate * 100).toFixed(0)}%):</span>
                    <span>${formatCurrency(data.order.taxAmount, currency)}</span>
                </div>
                ${
                  data.payment.tipAmount > 0
                    ? `
                <div class="total-row">
                    <span>Propina:</span>
                    <span>${formatCurrency(data.payment.tipAmount, currency)}</span>
                </div>`
                    : ''
                }
                <div class="total-row final">
                    <span>Total:</span>
                    <span>${formatCurrency(data.payment.amount + data.payment.tipAmount, currency)}</span>
                </div>
            </div>
            
            <div class="payment-info">
                <h3 class="section-title">Información de Pago</h3>
                <div class="payment-method">
                    <div class="payment-icon">
                        ${data.payment.method === 'CASH' ? '💵' : '💳'}
                    </div>
                    <div>
                        <div style="font-weight: 600; margin-bottom: 5px;">
                            ${formatPaymentMethod(data.payment.method, data.payment.cardBrand, data.payment.maskedPan)}
                        </div>
                        <div class="payment-details">
                            ${data.payment.entryMode ? `Modo: ${formatEntryMode(data.payment.entryMode)}<br>` : ''}
                            ${data.payment.authorizationNumber ? `Autorización: ${data.payment.authorizationNumber}<br>` : ''}
                            ${data.payment.referenceNumber ? `Referencia: ${data.payment.referenceNumber}<br>` : ''}
                            Estado: ${data.payment.status === 'COMPLETED' ? 'Completado' : data.payment.status}
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <div class="footer">
            <!-- Action Buttons -->
            <div class="action-buttons">
                <button class="action-btn btn-review" onclick="openReviewModal()">
                    ⭐ Calificar experiencia
                </button>
                <button class="action-btn btn-whatsapp" onclick="shareWhatsApp()">
                    📱 Compartir por WhatsApp
                </button>
                <button class="action-btn btn-share" onclick="shareReceipt()">
                    📤 Compartir recibo
                </button>
            </div>
            
            <div class="thank-you">¡Gracias por su preferencia!</div>
            <div class="support-info">
                Para cualquier duda o aclaración, contacte a:<br>
                ${data.venue.email} | ${data.venue.phone}
            </div>
            <div class="powered-by">
                Recibo digital generado por Avoqado<br>
                ${formatDate(data.receiptInfo.generatedAt)}
            </div>
        </div>
        
        <!-- Review Modal -->
        <div id="reviewModal" class="modal">
            <div class="modal-content">
                <span class="close" onclick="closeReviewModal()">&times;</span>
                <h2 style="margin-bottom: 20px; color: ${primaryColor};">Califica tu experiencia</h2>
                
                <div id="reviewForm" class="review-form active">
                    <div class="form-group">
                        <label>Calificación general *</label>
                        <div class="rating-container" data-rating="overall">
                            <span class="star" data-value="1">★</span>
                            <span class="star" data-value="2">★</span>
                            <span class="star" data-value="3">★</span>
                            <span class="star" data-value="4">★</span>
                            <span class="star" data-value="5">★</span>
                        </div>
                    </div>
                    
                    <div class="form-group">
                        <label>Calidad de la comida</label>
                        <div class="rating-container" data-rating="food">
                            <span class="star" data-value="1">★</span>
                            <span class="star" data-value="2">★</span>
                            <span class="star" data-value="3">★</span>
                            <span class="star" data-value="4">★</span>
                            <span class="star" data-value="5">★</span>
                        </div>
                    </div>
                    
                    <div class="form-group">
                        <label>Servicio</label>
                        <div class="rating-container" data-rating="service">
                            <span class="star" data-value="1">★</span>
                            <span class="star" data-value="2">★</span>
                            <span class="star" data-value="3">★</span>
                            <span class="star" data-value="4">★</span>
                            <span class="star" data-value="5">★</span>
                        </div>
                    </div>
                    
                    <div class="form-group">
                        <label>Ambiente</label>
                        <div class="rating-container" data-rating="ambience">
                            <span class="star" data-value="1">★</span>
                            <span class="star" data-value="2">★</span>
                            <span class="star" data-value="3">★</span>
                            <span class="star" data-value="4">★</span>
                            <span class="star" data-value="5">★</span>
                        </div>
                    </div>
                    
                    <div class="form-group">
                        <label>Comentarios (opcional)</label>
                        <textarea id="comment" placeholder="Cuéntanos sobre tu experiencia..."></textarea>
                    </div>
                    
                    <div class="form-group">
                        <label>Tu nombre (opcional)</label>
                        <input type="text" id="customerName" placeholder="Nombre">
                    </div>
                    
                    <div class="form-group">
                        <label>Email (opcional)</label>
                        <input type="email" id="customerEmail" placeholder="email@ejemplo.com">
                    </div>
                    
                    <button class="submit-btn" onclick="submitReview()">Enviar calificación</button>
                </div>
                
                <div id="reviewSuccess" class="review-success">
                    <h3>¡Gracias por tu calificación!</h3>
                    <p>Tu opinión nos ayuda a mejorar</p>
                </div>
            </div>
        </div>
    </div>
    
    <script>
        // Get access key from URL
        const accessKey = window.location.pathname.split('/').pop();
        const baseUrl = window.location.origin;
        
        // Rating system
        let ratings = {
            overall: 0,
            food: 0,
            service: 0,
            ambience: 0
        };
        
        // Initialize rating stars
        document.addEventListener('DOMContentLoaded', function() {
            setupRatingStars();
            checkReviewStatus();
        });
        
        function setupRatingStars() {
            document.querySelectorAll('.rating-container').forEach(container => {
                const ratingType = container.getAttribute('data-rating');
                const stars = container.querySelectorAll('.star');
                
                stars.forEach(star => {
                    star.addEventListener('click', function() {
                        const value = parseInt(this.getAttribute('data-value'));
                        ratings[ratingType] = value;
                        updateStars(container, value);
                    });
                    
                    star.addEventListener('mouseenter', function() {
                        const value = parseInt(this.getAttribute('data-value'));
                        highlightStars(container, value);
                    });
                });
                
                container.addEventListener('mouseleave', function() {
                    updateStars(container, ratings[ratingType]);
                });
            });
        }
        
        function updateStars(container, rating) {
            const stars = container.querySelectorAll('.star');
            stars.forEach((star, index) => {
                if (index < rating) {
                    star.classList.add('active');
                } else {
                    star.classList.remove('active');
                }
            });
        }
        
        function highlightStars(container, rating) {
            const stars = container.querySelectorAll('.star');
            stars.forEach((star, index) => {
                if (index < rating) {
                    star.style.color = '#fbbf24';
                } else {
                    star.style.color = '#d1d5db';
                }
            });
        }
        
        // Modal functions
        function openReviewModal() {
            document.getElementById('reviewModal').style.display = 'block';
        }
        
        function closeReviewModal() {
            document.getElementById('reviewModal').style.display = 'none';
        }
        
        // Close modal when clicking outside
        window.onclick = function(event) {
            const modal = document.getElementById('reviewModal');
            if (event.target === modal) {
                modal.style.display = 'none';
            }
        }
        
        // Check if review can be submitted
        async function checkReviewStatus() {
            try {
                const response = await fetch(baseUrl + '/api/v1/public/receipt/' + accessKey + '/review/status');
                const data = await response.json();
                
                if (!data.data.canSubmit) {
                    const reviewBtn = document.querySelector('.btn-review');
                    if (data.data.reason === 'Review already submitted') {
                        reviewBtn.textContent = '✅ Ya calificado';
                        reviewBtn.disabled = true;
                        reviewBtn.style.opacity = '0.6';
                        reviewBtn.onclick = null;
                    } else {
                        reviewBtn.style.display = 'none';
                    }
                }
            } catch (error) {
                console.error('Error checking review status:', error);
            }
        }
        
        // Submit review
        async function submitReview() {
            if (ratings.overall === 0) {
                alert('Por favor, proporciona una calificación general');
                return;
            }
            
            const reviewData = {
                overallRating: ratings.overall,
                foodRating: ratings.food || null,
                serviceRating: ratings.service || null,
                ambienceRating: ratings.ambience || null,
                comment: document.getElementById('comment').value || null,
                customerName: document.getElementById('customerName').value || null,
                customerEmail: document.getElementById('customerEmail').value || null
            };
            
            try {
                const response = await fetch(baseUrl + '/api/v1/public/receipt/' + accessKey + '/review', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(reviewData)
                });
                
                const data = await response.json();
                
                if (data.success) {
                    document.getElementById('reviewForm').style.display = 'none';
                    document.getElementById('reviewSuccess').style.display = 'block';
                    
                    // Update review button
                    const reviewBtn = document.querySelector('.btn-review');
                    reviewBtn.textContent = '✅ Calificación enviada';
                    reviewBtn.disabled = true;
                    reviewBtn.style.opacity = '0.6';
                    
                    // Close modal after 2 seconds
                    setTimeout(() => {
                        closeReviewModal();
                    }, 2000);
                } else {
                    alert('Error al enviar la calificación: ' + (data.message || 'Error desconocido'));
                }
            } catch (error) {
                console.error('Error submitting review:', error);
                alert('Error al enviar la calificación. Inténtalo de nuevo.');
            }
        }
        
        // Share functions
        function shareWhatsApp() {
            const text = encodeURIComponent(
                '¡Mira mi recibo de ' + '${data.venue.name}' + '! ' + 
                'Total: ' + '${formatCurrency(data.payment.amount + data.payment.tipAmount, currency)}' + ' ' +
                window.location.href
            );
            window.open('https://wa.me/?text=' + text, '_blank');
        }
        
        function shareReceipt() {
            if (navigator.share) {
                navigator.share({
                    title: 'Recibo de ' + '${data.venue.name}',
                    text: 'Mira mi recibo digital',
                    url: window.location.href
                }).catch(console.error);
            } else {
                // Fallback: copy to clipboard
                navigator.clipboard.writeText(window.location.href).then(() => {
                    alert('¡Enlace copiado al portapapeles!');
                }).catch(() => {
                    // Manual fallback
                    prompt('Copia este enlace:', window.location.href);
                });
            }
        }
        
        // Print function
        function printReceipt() {
            window.print();
        }
    </script>
</body>
</html>
  `.trim()
}
