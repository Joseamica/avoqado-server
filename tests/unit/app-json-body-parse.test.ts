import { isJsonBodyParseError } from '@/utils/httpErrors'

describe('isJsonBodyParseError', () => {
  it('detects malformed JSON errors emitted by express.json()', () => {
    const error = new SyntaxError('Unexpected end of JSON input') as SyntaxError & { status: number; type: string; body: string }
    error.status = 400
    error.type = 'entity.parse.failed'
    error.body = '{"message":'

    expect(isJsonBodyParseError(error)).toBe(true)
  })

  it('does not classify unrelated syntax errors as request body parse failures', () => {
    const error = new SyntaxError('Unexpected token')

    expect(isJsonBodyParseError(error)).toBe(false)
  })
})
