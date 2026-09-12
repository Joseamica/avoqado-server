// Launch explicitly; this file itself has not started the lab during preparation.
const fs=require('node:fs');
const {spawn}=require('node:child_process');
const {randomBytes}=require('node:crypto');
const {createRequire}=require('node:module');
const repo='/Users/amieva/Documents/Programming/Avoqado/avoqado-server';
const req=createRequire(repo+'/package.json');
const local=req('dotenv').parse(fs.readFileSync(repo+'/.env'));
const url=new URL(local.DATABASE_URL);
if (!['localhost','127.0.0.1'].includes(url.hostname)) throw Error('Local source URL required');
url.pathname='/codex_testarudo_lab_20260909';
const secretFile=__dirname+'/lab-private-secrets.json';
if(!fs.existsSync(secretFile)) fs.writeFileSync(secretFile,JSON.stringify(Object.fromEntries(['ACCESS_TOKEN_SECRET','REFRESH_TOKEN_SECRET','SESSION_SECRET','COOKIE_SECRET','OTP_PEPPER','SESSION_SUCCESSOR_ENC_KEY','ENCRYPTION_KEY'].map(key=>[key,randomBytes(32).toString('hex')]))),{mode:0o600,flag:'wx'});
const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,...JSON.parse(fs.readFileSync(secretFile)),
 NODE_ENV:'development',PORT:'18800',BASE_URL:'http://127.0.0.1:18800',FRONTEND_URL:'http://127.0.0.1:18800',
 DATABASE_URL:url.toString(),DATABASE_CONNECTION_LIMIT:'5',RABBITMQ_URL:'amqp://127.0.0.1:5672',DISABLE_RABBITMQ:'true',
 USE_BLUMON_MOCK:'true',MARKETING_KILL_SWITCH:'true',STRIPE_SECRET_KEY:'sk_test_lab_nonfunctional',OPENAI_API_KEY:'lab-nonfunctional',
 LOG_DIR:__dirname+'/lab-logs',LOG_LEVEL:'info',NODE_OPTIONS:'--max-old-space-size=3072'};
const child=spawn(process.execPath,[__dirname+'/lab-bootstrap.cjs'],{cwd:repo,env,stdio:'inherit'});
for(const sig of ['SIGINT','SIGTERM'])process.once(sig,()=>child.kill(sig));
child.once('exit',code=>process.exitCode=code??1);
