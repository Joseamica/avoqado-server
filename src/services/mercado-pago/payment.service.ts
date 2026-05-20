/**
 * Mercado Pago Payment service — wraps MP's /v1/payments endpoint for the
 * Bricks marketplace flow.
 *
 * Flow:
 *   1. Frontend Brick tokenizes the card and returns a {token, paymentMethodId,
 *      installments, ...} payload.
 *   2. Frontend POSTs that to our public endpoint (Phase 7 — Task 22).
 *   3. The controller loads the seller's access_token, computes the
 *      `application_fee` in MXN (caller converts cents→MXN at the boundary),
 *      and calls `createPayment` here.
 *   4. MP responds with {id, status, status_detail, [three_ds_redirect_url]}.
 *   5. The controller writes mpPaymentId to the CheckoutSession and returns
 *      the result to the frontend.
 *
 * Money: this service receives **MAJOR units (MXN decimal)**, NOT centavos.
 * The IEcommerceProvider interface uses centavos by convention; the
 * MercadoPagoProvider (Phase 6 — Task 18) divides by 100 before invoking us.
 *
 * 3DS: if MP issues a 3DS challenge, `status='pending'` and
 * `three_ds_redirect_url` is set. Frontend redirects the customer there;
 * after they complete the bank's auth challenge, MP fires a webhook with
 * the final status (approved / rejected).
 *
 * Why raw axios instead of the official mercadopago SDK:
 *   - The SDK's `Payment.create` doesn't expose application_fee cleanly
 *     in the marketplace context (the type definitions lag the docs)
 *   - We already do raw axios for OAuth; consistency
 *   - Easier to test with nock
 */
import axios, { AxiosError } from 'axios'

const API_BASE = process.env.MP_API_BASE_URL || 'https://api.mercadopago.com'

export interface CreatePaymentParams {
  /** Seller's access_token from OAuth (decrypted by connection.service). */
  accessToken: string

  /** Card token from the MP Brick frontend (one-time use, tokenized in-iframe). */
  token: string
  /** Payment method id from Brick (e.g. 'visa', 'master', 'amex'). */
  paymentMethodId: string
  /** Installments selected by buyer in the Brick UI. */
  installments: number
  /** Issuer id from Brick — optional, MP infers from the BIN if absent. */
  issuerId?: string

  /** Our internal CheckoutSession.sessionId — used as MP `external_reference`. */
  orderId: string
  /** Amount in MAJOR units (decimal MXN). Caller converts from cents. */
  amountMxn: number
  /** Platform fee in MAJOR units (decimal MXN). */
  applicationFeeMxn: number
  /** Free-form description shown on the buyer's MP receipt. */
  description: string

  /** Buyer's email — required by MP. */
  payerEmail: string
  payerFirstName?: string
  payerLastName?: string
  payerIdentificationType?: string
  payerIdentificationNumber?: string

  /** Idempotency key — pass session id or random uuid. */
  idempotencyKey: string

  /** Where MP posts IPN for this specific payment. Optional — MP uses the
   *  panel-configured URL if omitted. Useful for per-environment routing
   *  (dev vs staging vs prod). */
  notificationUrl?: string
}

export interface PaymentResult {
  id: number
  status: 'pending' | 'approved' | 'authorized' | 'in_process' | 'in_mediation' | 'rejected' | 'cancelled' | 'refunded' | 'charged_back'
  status_detail: string
  /** Present when 3DS challenge is required. */
  three_ds_redirect_url?: string
}

/**
 * Subset of the MP payment object returned by GET /v1/payments/:id.
 * MP returns more fields; we type only what we read in the codebase.
 */
export interface MercadoPagoPayment {
  id: number
  status: PaymentResult['status']
  status_detail: string
  external_reference: string | null
  transaction_amount: number
  currency_id: string
  date_approved: string | null
  date_created: string
  fee_details: Array<{ type: string; amount: number; fee_payer: string }>
  /** Platform fee deducted from the seller in MAJOR units (MXN). */
  application_fee?: number
  /** MP-internal marketplace fee — for Checkout Pro flows only. v3 uses application_fee. */
  marketplace_fee?: number
  /** Merchant order this payment belongs to (preferences group payments). */
  order?: { id: number | null } | null
}

export interface RefundParams {
  /** Seller's access_token (the same one used to create the payment). */
  accessToken: string
  /** MP payment.id (from CheckoutSession.mpPaymentId). */
  paymentId: string
  /**
   * Optional partial refund amount in MAJOR units (decimal MXN).
   * If omitted, MP issues a full refund.
   */
  amount?: number
  /** Idempotency key — pass a stable string so retries don't double-refund. */
  idempotencyKey: string
}

export interface RefundResult {
  /** MP refund id. */
  id: number
  payment_id: number
  /** Refunded amount in MAJOR units (MXN). */
  amount: number
  /** "approved" | "rejected" | "in_process" per MP docs. */
  status: string
}

export async function createPayment(p: CreatePaymentParams): Promise<PaymentResult> {
  try {
    const { data } = await axios.post<PaymentResult>(
      `${API_BASE}/v1/payments`,
      {
        token: p.token,
        payment_method_id: p.paymentMethodId,
        installments: p.installments,
        issuer_id: p.issuerId,
        transaction_amount: p.amountMxn,
        application_fee: p.applicationFeeMxn,
        external_reference: p.orderId,
        description: p.description,
        payer: {
          email: p.payerEmail,
          first_name: p.payerFirstName,
          last_name: p.payerLastName,
          identification:
            p.payerIdentificationType && p.payerIdentificationNumber
              ? { type: p.payerIdentificationType, number: p.payerIdentificationNumber }
              : undefined,
        },
        notification_url: p.notificationUrl,
        // false = allow async approval flows (3DS, OXXO ficha generation, SPEI)
        binary_mode: false,
      },
      {
        headers: {
          Authorization: `Bearer ${p.accessToken}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': p.idempotencyKey,
        },
        timeout: 30000,
      },
    )
    return data
  } catch (err) {
    if (err instanceof AxiosError && err.response) {
      throw new Error(`MP createPayment failed: ${err.response.status} ${JSON.stringify(err.response.data)}`)
    }
    throw err
  }
}

/**
 * Fetch the current state of a payment. Called from:
 *   - Webhook handler (Phase 5) — after an IPN arrives, we GET the payment
 *     for the authoritative status (the IPN body is just a notification).
 *   - Provider's `getPaymentStatus` (Phase 6) — for status queries from
 *     dashboards / customer-facing receipt pages.
 *
 * Note: `paymentId` is the MP payment.id (NOT the preference.id, NOT our
 * CheckoutSession.id). Callers must lookup `mpPaymentId` from CheckoutSession
 * first; it gets populated via IPN.
 */
export async function getPayment(accessToken: string, paymentId: string): Promise<MercadoPagoPayment> {
  try {
    const { data } = await axios.get<MercadoPagoPayment>(`${API_BASE}/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 15000,
    })
    return data
  } catch (err) {
    if (err instanceof AxiosError && err.response) {
      throw new Error(`MP getPayment failed: ${err.response.status} ${JSON.stringify(err.response.data)}`)
    }
    throw err
  }
}

/**
 * Refund a payment. Partial refunds supported via `amount` (in MXN major units).
 * Omit `amount` for a full refund.
 *
 * MP marketplace behavior: when a refund happens, the seller's account is
 * debited the full refund amount AND Avoqado's application_fee is reversed
 * proportionally. If the seller's balance is insufficient, MP defers the
 * refund (status: 'in_process') until balance is available.
 *
 * Idempotency: every refund attempt should pass a unique-per-intent key. If
 * MP sees the same key twice, it returns the same refund result (doesn't
 * double-refund).
 */
export async function refundPayment(p: RefundParams): Promise<RefundResult> {
  try {
    const body = p.amount !== undefined ? { amount: p.amount } : {}
    const { data } = await axios.post<RefundResult>(`${API_BASE}/v1/payments/${p.paymentId}/refunds`, body, {
      headers: {
        Authorization: `Bearer ${p.accessToken}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': p.idempotencyKey,
      },
      timeout: 15000,
    })
    return data
  } catch (err) {
    if (err instanceof AxiosError && err.response) {
      throw new Error(`MP refundPayment failed: ${err.response.status} ${JSON.stringify(err.response.data)}`)
    }
    throw err
  }
}
