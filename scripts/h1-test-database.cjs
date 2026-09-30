// The legacy H1 database and per-run timestamp/PID databases share one strict
// allowlist. Never accept a dev database, remote host or SQL in an identifier.
function isDisposableH1Url(url) {
  return (
    ['postgres:', 'postgresql:'].includes(url.protocol) &&
    ['localhost', '127.0.0.1'].includes(url.hostname) &&
    /^\/avoqado_h1a_test_[0-9]+(?:_[0-9]+)?$/.test(url.pathname)
  )
}

module.exports = { isDisposableH1Url }
