// Owned laboratory bootstrap. No business jobs or server.ts startup integrations.
const { createRequire }=require('node:module');
const http=require('node:http');
const req=createRequire(process.cwd()+'/package.json');
const u=new URL(process.env.DATABASE_URL);
if (!['localhost','127.0.0.1'].includes(u.hostname) || u.pathname!='/codex_testarudo_lab_20260909') throw Error('Owned lab database required');
require('./lab-network-guard.cjs').installNetworkGuard();
// Prevent all imported config modules from filling absent values using the shared .env.
const dotenv=req('dotenv');
dotenv.config=()=>({parsed:{}});
dotenv.configDotenv=()=>({parsed:{}});
req('tsx/cjs');
req('tsconfig-paths/register');
const app=req(process.cwd()+'/src/app.ts').default;
const {initializeSocketServer,shutdownSocketServer}=req(process.cwd()+'/src/communication/sockets/index.ts');
const server=http.createServer(app);
initializeSocketServer(server);
server.listen(Number(process.env.PORT),'127.0.0.1',()=>process.stdout.write('LAB_LISTENING_LOOPBACK\n'));
async function stop(){
 await shutdownSocketServer();
 server.closeAllConnections();
 await new Promise(resolve=>server.close(resolve));
 await req(process.cwd()+'/src/utils/prismaClient.ts').default.$disconnect();
 process.exit(0);
}
process.once('SIGTERM',()=>void stop());
process.once('SIGINT',()=>void stop());
