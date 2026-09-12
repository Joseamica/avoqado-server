// Lab-only guard installed before importing application dependencies.
const net = require('node:net');
function isLoopbackConnect(input) {
  const args = Array.isArray(input[0]) ? input[0] : input;
  const first = args[0];
  const options = first && typeof first === 'object' ? first : { port:first, host: typeof args[1]==='string' ? args[1] : 'localhost' };
  if (options.path || !Number.isInteger(Number(options.port)) || Number(options.port)<1 || Number(options.port)>65535) return false;
  return ['localhost','127.0.0.1','::1','::ffff:127.0.0.1'].includes(options.host || 'localhost');
}
function installNetworkGuard() {
  const original=net.Socket.prototype.connect;
  net.Socket.prototype.connect=function(...args) {
    if (!isLoopbackConnect(args)) throw Object.assign(new Error('Lab backend permits loopback TCP only'),{code:'LAB_EGRESS_BLOCKED'});
    return original.apply(this,args);
  };
  return ()=>{net.Socket.prototype.connect=original;};
}
module.exports={isLoopbackConnect,installNetworkGuard};
