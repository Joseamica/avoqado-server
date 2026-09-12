const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { isLoopbackConnect, installNetworkGuard } = require('./lab-network-guard.cjs');
test('accepts only explicit loopback endpoints and normal localhost defaults', () => {
  for (const args of [[5432,'127.0.0.1'],[{port:5432,host:'::1'}],[5432],[{port:5432,host:'localhost'}]]) assert.equal(isLoopbackConnect(args),true);
});
test('rejects external addresses, lookalike hosts and socket paths', () => {
  for (const args of [[443,'api.avoqado.io'],[{port:443,host:'127.0.0.1.attacker.test'}],[443,'192.168.1.1'],[{path:'/tmp/other-session.sock'}],['/tmp/other.sock']]) assert.equal(isLoopbackConnect(args),false);
});
test('guard refuses before initiating an external socket', () => {
  const original=net.Socket.prototype.connect;
  let called=0;
  net.Socket.prototype.connect=function(){ called++; throw Object.assign(new Error('stub reached'),{code:'STUB_REACHED'}); };
  const undo=installNetworkGuard();
  try { assert.throws(()=>net.connect(443,'api.avoqado.io'),{code:'LAB_EGRESS_BLOCKED'}); assert.equal(called,0); }
  finally { undo(); net.Socket.prototype.connect=original; }
});
test('guard permits a real owned loopback connection', async () => {
  const server=net.createServer(socket=>socket.end('ok'));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const undo=installNetworkGuard();
  try {
    const reply=await new Promise((resolve,reject)=>{
      const client=net.connect(server.address().port,'127.0.0.1');
      let text='';client.on('data',x=>text+=x);client.on('end',()=>resolve(text));client.on('error',reject);
    });
    assert.equal(reply,'ok');
  } finally { undo(); await new Promise(resolve=>server.close(resolve)); }
});
