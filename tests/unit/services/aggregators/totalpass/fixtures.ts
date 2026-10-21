/** Payloads literales de docs/aggregators/totalpass-api-contract.md §4.1 y §5.2 (el endpoint, con un host de producción plausible). */
export const BOOKING_ACTIVE = {
  event: { id: '40dc2acc-f418-4447-9d78-7b1c76fc8399', title: 'Yoga' },
  place: { place: '9c83d967-d783-4e74-9e11-4ebe462ab7d9', name: 'TUDO JEANS' },
  user: {
    name: 'Pedro Santos',
    email: 'pedrosantos@outlook.com',
    phone: '(11) 98222-4623',
    document_number: '23312388894',
    document_type: 'cpf',
    code: 'S2MXBABC',
  },
  slot: {
    id: '677fc3d14bc7797787a4e8c7',
    status: 'active',
    date: '2025-01-10T20:30:00.000Z',
    seat: null,
    confirmation_url: 'https://booking-api.totalpass.com/partner/slot/confirmSlot/677fc3d14bc7797787a4e8c7',
  },
}
export const CHECKIN_CREATED = {
  type: 'CHECK_IN_CREATED',
  endpoint: 'https://admin.totalpass.com/api/v1/webhook_confirmations/TXIefq1R0-w59n6XLaMhR425lS0olXdTSnQ0qJUNZpnF2GGyUWcjrw==',
  check_in: { started_at: '2024-08-07T17:54:16.271-03:00', plan_code: '59TADO9F', expires_at: '2024-08-07T19:24:16.271-03:00' },
  place: { place: '5e701467-4d80-40a4-b78a-00490a6feb9b', name: 'Batatinha', code: '59TADO9F' },
  user: {
    name: 'Cleveland Wolf',
    email: 'tarra.cruickshank@yahoo.com',
    phone: '6399907-8947',
    document_number: '66844563680',
    document_type: 'cpf',
    code: 'EQ2B3FBK',
  },
}
