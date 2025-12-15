/**
 * HTML template generator for digital receipts
 * Matches the ModernReceiptDesign component from avoqado-web-dashboard
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
    accessKey: string
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
function formatDate(dateString: string): { date: string; time: string } {
  const date = new Date(dateString)
  return {
    date: date.toLocaleDateString('es-MX', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }),
    time: date.toLocaleTimeString('es-MX', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }),
  }
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
 * Generate complete HTML template for digital receipt
 * Design matches ModernReceiptDesign.tsx from avoqado-web-dashboard
 */
export function generateReceiptHTML(data: ReceiptData): string {
  const currency = data.receiptInfo.currency || 'MXN'
  const datetime = formatDate(data.payment.createdAt)
  const receiptNumber = data.receiptInfo.accessKey?.slice(-4).toUpperCase() || 'N/A'

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
            background: #0a0a0a;
            min-height: 100vh;
            padding: 20px;
            color: #fafafa;
            line-height: 1.5;
        }

        .receipt-container {
            max-width: 500px;
            margin: 0 auto;
        }

        /* Header Card */
        .header-card {
            background: linear-gradient(to bottom right, #18181b, #09090b);
            border: 1px solid #27272a;
            border-radius: 16px;
            padding: 32px;
            text-align: center;
            margin-bottom: 16px;
            position: relative;
            overflow: hidden;
        }

        .status-badge {
            position: absolute;
            top: 16px;
            right: 16px;
            background: #22c55e20;
            color: #4ade80;
            font-size: 12px;
            font-weight: 500;
            padding: 4px 12px;
            border-radius: 9999px;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .status-badge::before {
            content: '✓';
            font-size: 10px;
        }

        .venue-logo {
            width: 80px;
            height: 80px;
            border-radius: 50%;
            margin: 0 auto 16px;
            background: #f87171;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 32px;
            font-weight: bold;
            color: white;
            overflow: hidden;
        }

        .venue-logo img {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }

        .venue-name {
            font-size: 28px;
            font-weight: 600;
            margin-bottom: 12px;
            color: #fafafa;
        }

        .venue-info {
            color: #a1a1aa;
            font-size: 14px;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 4px;
        }

        .venue-info-item {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        /* Details Card */
        .details-card {
            background: #18181b;
            border: 1px solid #27272a;
            border-radius: 16px;
            overflow: hidden;
        }

        .card-content {
            padding: 24px;
        }

        /* Receipt Metadata Grid */
        .metadata-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 16px;
            padding: 16px;
            background: #27272a50;
            border-radius: 12px;
            margin-bottom: 24px;
        }

        .metadata-column {
            display: flex;
            flex-direction: column;
            gap: 16px;
        }

        .metadata-item {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .metadata-icon {
            width: 32px;
            height: 32px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            flex-shrink: 0;
        }

        .metadata-icon.receipt { background: #3b82f620; }
        .metadata-icon.user { background: #3b82f620; }
        .metadata-icon.calendar { background: #22c55e20; }
        .metadata-icon.clock { background: #a855f720; }

        .metadata-label {
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: #71717a;
            margin-bottom: 2px;
        }

        .metadata-value {
            font-size: 14px;
            font-weight: 500;
            color: #fafafa;
        }

        .metadata-value.mono {
            font-family: ui-monospace, monospace;
        }

        .metadata-value.capitalize {
            text-transform: capitalize;
        }

        /* Order Items */
        .section-title {
            font-size: 18px;
            font-weight: 600;
            margin-bottom: 16px;
            display: flex;
            align-items: center;
            gap: 8px;
            color: #fafafa;
        }

        .section-title .icon {
            color: #f59e0b;
        }

        .items-list {
            display: flex;
            flex-direction: column;
            gap: 12px;
            margin-bottom: 24px;
        }

        .item-card {
            background: #0a0a0a;
            border: 1px solid #27272a50;
            border-radius: 12px;
            padding: 16px;
        }

        .item-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 8px;
        }

        .item-name {
            font-weight: 500;
            color: #fafafa;
        }

        .item-price {
            font-weight: 700;
            font-size: 18px;
            color: #fafafa;
        }

        .item-unit-price {
            font-size: 12px;
            color: #71717a;
        }

        .item-quantity {
            display: inline-block;
            background: #27272a;
            color: #a1a1aa;
            font-size: 12px;
            padding: 2px 8px;
            border-radius: 9999px;
            margin-top: 4px;
        }

        .item-modifiers {
            margin-top: 8px;
            padding-left: 12px;
            border-left: 2px solid #27272a;
        }

        .modifier-row {
            display: flex;
            justify-content: space-between;
            font-size: 14px;
            color: #a1a1aa;
            padding: 2px 0;
        }

        /* Separator */
        .separator {
            height: 1px;
            background: #27272a;
            margin: 24px 0;
        }

        /* Totals */
        .totals-section {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .total-row {
            display: flex;
            justify-content: space-between;
            font-size: 16px;
        }

        .total-row .label {
            color: #a1a1aa;
        }

        .total-row .value {
            font-weight: 500;
            color: #fafafa;
        }

        .total-row.tip .value {
            color: #22c55e;
        }

        .total-row.final {
            background: linear-gradient(to right, #3b82f620, #3b82f610);
            padding: 16px;
            border-radius: 12px;
            font-size: 20px;
            font-weight: 700;
            margin-top: 8px;
        }

        .total-row.final .value {
            color: #3b82f6;
        }

        /* Payment Method */
        .payment-section {
            background: #27272a50;
            border-radius: 12px;
            padding: 16px;
            margin-top: 24px;
        }

        .payment-header {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 12px;
        }

        .payment-icon {
            width: 40px;
            height: 40px;
            background: #22c55e20;
            border-radius: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 20px;
        }

        .payment-method-name {
            font-weight: 600;
            color: #fafafa;
        }

        .payment-status {
            font-size: 14px;
            color: #22c55e;
        }

        /* Footer */
        .footer {
            text-align: center;
            padding: 24px;
            border-top: 1px solid #27272a;
            margin-top: 24px;
        }

        .thank-you {
            font-size: 16px;
            color: #a1a1aa;
            margin-bottom: 16px;
        }

        .powered-by {
            font-size: 12px;
            color: #52525b;
            margin-top: 16px;
        }

        /* Action Buttons */
        .action-buttons {
            display: flex;
            gap: 12px;
            margin: 16px 0;
            flex-wrap: wrap;
        }

        .action-btn {
            flex: 1;
            min-width: 120px;
            padding: 12px 16px;
            border: none;
            border-radius: 12px;
            font-weight: 600;
            font-size: 14px;
            cursor: pointer;
            text-decoration: none;
            text-align: center;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            transition: opacity 0.2s;
        }

        .action-btn:hover {
            opacity: 0.9;
        }

        .btn-review {
            background: #3b82f6;
            color: white;
        }

        .btn-whatsapp {
            background: #22c55e;
            color: white;
        }

        .btn-share {
            background: #27272a;
            color: #fafafa;
            border: 1px solid #3f3f46;
        }

        /* Modal */
        .modal {
            display: none;
            position: fixed;
            z-index: 1000;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0,0,0,0.8);
        }

        .modal-content {
            background: #18181b;
            border: 1px solid #27272a;
            margin: 5% auto;
            padding: 24px;
            border-radius: 16px;
            width: 90%;
            max-width: 450px;
            position: relative;
        }

        .modal-title {
            font-size: 20px;
            font-weight: 600;
            margin-bottom: 20px;
            color: #fafafa;
        }

        .close {
            position: absolute;
            right: 16px;
            top: 16px;
            font-size: 24px;
            cursor: pointer;
            color: #71717a;
        }

        .close:hover {
            color: #fafafa;
        }

        .form-group {
            margin-bottom: 16px;
        }

        .form-group label {
            display: block;
            margin-bottom: 6px;
            font-weight: 500;
            font-size: 14px;
            color: #a1a1aa;
        }

        .form-group input,
        .form-group textarea {
            width: 100%;
            padding: 12px;
            border: 1px solid #3f3f46;
            border-radius: 8px;
            font-size: 14px;
            background: #0a0a0a;
            color: #fafafa;
        }

        .form-group input:focus,
        .form-group textarea:focus {
            outline: none;
            border-color: #3b82f6;
        }

        .form-group textarea {
            min-height: 80px;
            resize: vertical;
        }

        .rating-container {
            display: flex;
            gap: 4px;
            margin-top: 6px;
        }

        .star {
            font-size: 28px;
            color: #3f3f46;
            cursor: pointer;
            transition: color 0.15s;
        }

        .star.active,
        .star:hover {
            color: #fbbf24;
        }

        .submit-btn {
            width: 100%;
            padding: 12px;
            background: #3b82f6;
            color: white;
            border: none;
            border-radius: 8px;
            font-weight: 600;
            font-size: 14px;
            cursor: pointer;
            margin-top: 8px;
        }

        .submit-btn:hover {
            background: #2563eb;
        }

        .review-success {
            display: none;
            text-align: center;
            padding: 24px;
        }

        .review-success h3 {
            color: #22c55e;
            margin-bottom: 8px;
        }

        .review-success p {
            color: #a1a1aa;
        }

        @media (max-width: 500px) {
            body {
                padding: 12px;
            }

            .metadata-grid {
                grid-template-columns: 1fr;
            }

            .header-card {
                padding: 24px;
            }

            .venue-name {
                font-size: 24px;
            }

            .action-buttons {
                flex-direction: column;
            }

            .action-btn {
                width: 100%;
            }
        }

        @media print {
            body {
                background: white;
                color: black;
            }

            .header-card,
            .details-card,
            .metadata-grid,
            .item-card,
            .payment-section,
            .total-row.final {
                background: white;
                border-color: #e5e7eb;
            }

            .action-buttons,
            .modal {
                display: none !important;
            }
        }
    </style>
</head>
<body>
    <div class="receipt-container">
        <!-- Header Card -->
        <div class="header-card">
            <div class="status-badge">Visto</div>
            <div class="venue-logo">
                ${data.venue.logo ? `<img src="${data.venue.logo}" alt="${data.venue.name}">` : data.venue.name.charAt(0)}
            </div>
            <div class="venue-name">${data.venue.name}</div>
            <div class="venue-info">
                <div class="venue-info-item">
                    <span>📍</span>
                    <span>${data.venue.address}</span>
                </div>
                <div class="venue-info-item">
                    <span>${data.venue.city}, ${data.venue.state}</span>
                </div>
                <div class="venue-info-item">
                    <span>📞</span>
                    <span>${data.venue.phone}</span>
                </div>
            </div>
        </div>

        <!-- Details Card -->
        <div class="details-card">
            <div class="card-content">
                <!-- Receipt Metadata -->
                <div class="metadata-grid">
                    <div class="metadata-column">
                        <div class="metadata-item">
                            <div class="metadata-icon receipt">🧾</div>
                            <div>
                                <div class="metadata-label">Recibo</div>
                                <div class="metadata-value mono">#${receiptNumber}</div>
                            </div>
                        </div>
                        ${
                          data.processedBy
                            ? `
                        <div class="metadata-item">
                            <div class="metadata-icon user">👤</div>
                            <div>
                                <div class="metadata-label">Atendido por</div>
                                <div class="metadata-value">${data.processedBy.firstName} ${data.processedBy.lastName}</div>
                            </div>
                        </div>
                        `
                            : ''
                        }
                    </div>
                    <div class="metadata-column">
                        <div class="metadata-item">
                            <div class="metadata-icon calendar">📅</div>
                            <div>
                                <div class="metadata-label">Fecha</div>
                                <div class="metadata-value capitalize">${datetime.date}</div>
                            </div>
                        </div>
                        <div class="metadata-item">
                            <div class="metadata-icon clock">🕐</div>
                            <div>
                                <div class="metadata-label">Hora</div>
                                <div class="metadata-value">${datetime.time}</div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Order Items -->
                ${
                  data.items && data.items.length > 0
                    ? `
                <div class="section-title">
                    <span class="icon">✨</span>
                    Productos ordenados
                </div>
                <div class="items-list">
                    ${data.items
                      .map(
                        item => `
                        <div class="item-card">
                            <div class="item-header">
                                <div>
                                    <div class="item-name">${item.productName}</div>
                                    <span class="item-quantity">Cantidad: ${item.quantity}</span>
                                </div>
                                <div style="text-align: right;">
                                    <div class="item-price">${formatCurrency(item.total, currency)}</div>
                                    <div class="item-unit-price">${item.quantity} × ${formatCurrency(item.unitPrice, currency)}</div>
                                </div>
                            </div>
                            ${
                              item.modifiers && item.modifiers.length > 0
                                ? `
                                <div class="item-modifiers">
                                    ${item.modifiers.map(mod => `<div class="modifier-row"><span>+ ${mod.name}</span><span>${formatCurrency(mod.price, currency)}</span></div>`).join('')}
                                </div>
                            `
                                : ''
                            }
                        </div>
                    `,
                      )
                      .join('')}
                </div>
                `
                    : ''
                }

                <div class="separator"></div>

                <!-- Totals -->
                <div class="totals-section">
                    <div class="total-row">
                        <span class="label">Subtotal</span>
                        <span class="value">${formatCurrency(data.order.subtotal, currency)}</span>
                    </div>
                    <div class="total-row">
                        <span class="label">Impuestos</span>
                        <span class="value">${formatCurrency(data.order.taxAmount, currency)}</span>
                    </div>
                    ${
                      data.payment.tipAmount > 0
                        ? `
                    <div class="total-row tip">
                        <span class="label">Propina</span>
                        <span class="value">${formatCurrency(data.payment.tipAmount, currency)}</span>
                    </div>
                    `
                        : ''
                    }
                    <div class="total-row final">
                        <span class="label">Total pagado</span>
                        <span class="value">${formatCurrency(data.payment.amount + data.payment.tipAmount, currency)}</span>
                    </div>
                </div>

                <!-- Payment Method -->
                <div class="payment-section">
                    <div class="payment-header">
                        <div class="payment-icon">${data.payment.method === 'CASH' ? '💵' : '💳'}</div>
                        <div>
                            <div class="payment-method-name">${formatPaymentMethod(data.payment.method, data.payment.cardBrand, data.payment.maskedPan)}</div>
                            <div class="payment-status">✓ ${data.payment.status === 'COMPLETED' ? 'Completado' : data.payment.status}</div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Footer -->
            <div class="footer">
                <div class="action-buttons">
                    <button class="action-btn btn-review" onclick="openReviewModal()">
                        ⭐ Calificar
                    </button>
                    <button class="action-btn btn-whatsapp" onclick="shareWhatsApp()">
                        📱 WhatsApp
                    </button>
                    <button class="action-btn btn-share" onclick="shareReceipt()">
                        📤 Compartir
                    </button>
                </div>

                <div class="thank-you">¡Gracias por tu visita a ${data.venue.name}!</div>

                <div class="powered-by">
                    Recibo digital generado por Avoqado<br>
                    ${datetime.date} • ${datetime.time}
                </div>
            </div>
        </div>

        <!-- Review Modal -->
        <div id="reviewModal" class="modal">
            <div class="modal-content">
                <span class="close" onclick="closeReviewModal()">&times;</span>
                <div class="modal-title">Califica tu experiencia</div>

                <div id="reviewForm">
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
                        <label>Comentarios (opcional)</label>
                        <textarea id="comment" placeholder="Cuéntanos sobre tu experiencia..."></textarea>
                    </div>

                    <div class="form-group">
                        <label>Tu nombre (opcional)</label>
                        <input type="text" id="customerName" placeholder="Nombre">
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
        const accessKey = window.location.pathname.split('/').pop();
        const baseUrl = window.location.origin;

        let ratings = { overall: 0, food: 0, service: 0 };

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
            container.querySelectorAll('.star').forEach((star, index) => {
                star.classList.toggle('active', index < rating);
            });
        }

        function highlightStars(container, rating) {
            container.querySelectorAll('.star').forEach((star, index) => {
                star.style.color = index < rating ? '#fbbf24' : '#3f3f46';
            });
        }

        function openReviewModal() {
            document.getElementById('reviewModal').style.display = 'block';
        }

        function closeReviewModal() {
            document.getElementById('reviewModal').style.display = 'none';
        }

        window.onclick = function(event) {
            const modal = document.getElementById('reviewModal');
            if (event.target === modal) modal.style.display = 'none';
        }

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
                console.error('Error:', error);
            }
        }

        async function submitReview() {
            if (ratings.overall === 0) {
                alert('Por favor, proporciona una calificación general');
                return;
            }

            try {
                const response = await fetch(baseUrl + '/api/v1/public/receipt/' + accessKey + '/review', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        overallRating: ratings.overall,
                        foodRating: ratings.food || null,
                        serviceRating: ratings.service || null,
                        comment: document.getElementById('comment').value || null,
                        customerName: document.getElementById('customerName').value || null
                    })
                });

                const data = await response.json();

                if (data.success) {
                    document.getElementById('reviewForm').style.display = 'none';
                    document.getElementById('reviewSuccess').style.display = 'block';

                    const reviewBtn = document.querySelector('.btn-review');
                    reviewBtn.textContent = '✅ Calificación enviada';
                    reviewBtn.disabled = true;
                    reviewBtn.style.opacity = '0.6';

                    setTimeout(closeReviewModal, 2000);
                } else {
                    alert('Error: ' + (data.message || 'Error desconocido'));
                }
            } catch (error) {
                alert('Error al enviar. Inténtalo de nuevo.');
            }
        }

        function shareWhatsApp() {
            const text = encodeURIComponent('¡Mira mi recibo de ${data.venue.name}! ' + window.location.href);
            window.open('https://wa.me/?text=' + text, '_blank');
        }

        function shareReceipt() {
            if (navigator.share) {
                navigator.share({
                    title: 'Recibo de ${data.venue.name}',
                    url: window.location.href
                }).catch(() => {});
            } else {
                navigator.clipboard.writeText(window.location.href).then(() => {
                    alert('¡Enlace copiado!');
                });
            }
        }
    </script>
</body>
</html>
  `.trim()
}
