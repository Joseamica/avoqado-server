const fs=require('node:fs');const {createRequire}=require('node:module');
const repo='/Users/amieva/Documents/Programming/Avoqado/avoqado-server';const req=createRequire(repo+'/package.json');
const env=req('dotenv').parse(fs.readFileSync(repo+'/.env'));const url=new URL(env.DATABASE_URL);
if(!['localhost','127.0.0.1'].includes(url.hostname)) throw Error('Local PostgreSQL required');url.pathname='/postgres';
const {Client}=req('pg');const db=new Client({connectionString:url.toString()});const marker='Codex Testarudo isolated hardware lab 2026-09-09';
(async()=>{await db.connect();try{
 const old=await db.query("SELECT shobj_description(oid,'pg_database') AS owner FROM pg_database WHERE datname=$1",['codex_testarudo_lab_20260909']);
 if(old.rowCount){if(old.rows[0].owner!==marker)throw Error('Existing DB has no matching owner marker');console.log('Owned lab database already exists');return;}
 await db.query('CREATE DATABASE codex_testarudo_lab_20260909 TEMPLATE codex_testarudo_test_20260909');
 await db.query("COMMENT ON DATABASE codex_testarudo_lab_20260909 IS 'Codex Testarudo isolated hardware lab 2026-09-09'");
 console.log('Created owned isolated hardware lab database; source unchanged');
}finally{await db.end();}})().catch(e=>{console.error(e.message);process.exitCode=1;});
