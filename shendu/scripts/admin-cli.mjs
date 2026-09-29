import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, unlinkSync, renameSync, chmodSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { randomBytes, randomUUID, pbkdf2Sync, createCipheriv, createDecipheriv } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { atomicWriteFile, validBase64, validateSnapshotDatabase } from './backup-safety.mjs';

process.umask(0o077);
const [command, output, passwordArgument, passwordFileArgument] = process.argv.slice(2);
const dataDir = resolve(process.env.SHENDU_DATA_DIR || './data');
const database = join(dataDir, 'shendu.db');
const masterKeyPath = resolve(process.env.SHENDU_MASTER_KEY_PATH || join(dataDir, 'backup-master.key'));
if(database===masterKeyPath)throw new Error('数据库与内部密钥不能使用同一个文件路径');
const password=passwordArgument==='--password-file'&&passwordFileArgument?readFileSync(resolve(passwordFileArgument),'utf8').replace(/\r?\n$/,''):passwordArgument;

function usage() {
  console.log('创建整站加密快照：node scripts/admin-cli.mjs snapshot ./backups/site.shendu-db --password-file ./password.txt');
  console.log('创建迁移包：      node scripts/admin-cli.mjs migration ./backups/site.shendu-migration --password-file ./password.txt');
  console.log('恢复：            node scripts/admin-cli.mjs restore ./backups/site.shendu-db --password-file ./password.txt');
  process.exit(1);
}
if (!['snapshot','migration','restore'].includes(command) || !output || !password || password.length < 15) usage();

function seal(payload, kind) {
  const clear=Buffer.from(JSON.stringify(payload));
  if(clear.length>1024*1024*1024)throw new Error('快照内容超过 1 GiB 解压上限，已停止生成不可恢复的备份');
  const salt=randomBytes(16),iv=randomBytes(12),key=pbkdf2Sync(password,salt,600000,32,'sha256');
  const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(`shendu-${kind}-v1`));
  const encrypted=Buffer.concat([cipher.update(gzipSync(clear)),cipher.final()]);
  return Buffer.from(JSON.stringify({format:`shendu-${kind}-v1`,salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:encrypted.toString('base64')}));
}
function open(buffer) {
  const x=JSON.parse(buffer.toString('utf8'));if(!/^shendu-(snapshot|migration)-v1$/.test(x.format))throw new Error('不支持的整站备份格式');
  if(!validBase64(x.salt,16)||!validBase64(x.iv,12)||!validBase64(x.tag,16)||!validBase64(x.data))throw new Error('快照加密参数不正确');
  const key=pbkdf2Sync(password,Buffer.from(x.salt,'base64'),600000,32,'sha256'),decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(x.iv,'base64'),{authTagLength:16});
  decipher.setAAD(Buffer.from(x.format));decipher.setAuthTag(Buffer.from(x.tag,'base64'));
  return JSON.parse(gunzipSync(Buffer.concat([decipher.update(Buffer.from(x.data,'base64')),decipher.final()]),{maxOutputLength:1024*1024*1024}).toString('utf8'));
}

if (command === 'snapshot' || command === 'migration') {
  if([database,masterKeyPath,passwordArgument==='--password-file'?resolve(passwordFileArgument):null].includes(resolve(output)))throw new Error('备份输出不能覆盖正在使用的数据库、内部密钥或密码文件');
  if (!existsSync(database)) throw new Error('找不到数据库，请先启动慎独');
  const temp=join(dataDir,`.snapshot-${process.pid}.db`);let snapshotDb;
  try {
    snapshotDb=new DatabaseSync(database);snapshotDb.exec(`VACUUM INTO '${temp.replaceAll("'","''")}'`);snapshotDb.close();snapshotDb=null;
    const persistedMasterKey=existsSync(masterKeyPath)?readFileSync(masterKeyPath,'utf8').trim():String(process.env.SHENDU_MASTER_KEY||'').trim();
    if(!/^[a-f0-9]{64}$/i.test(persistedMasterKey))throw new Error('找不到有效的 64 位内部数据加密密钥，已停止创建快照');
    const check=new DatabaseSync(temp);try{validateSnapshotDatabase(check,persistedMasterKey)}finally{check.close()}
    const payload={createdAt:new Date().toISOString(),schemaVersion:6,masterKey:persistedMasterKey,database:readFileSync(temp).toString('base64')};
    mkdirSync(dirname(resolve(output)),{recursive:true});atomicWriteFile(resolve(output),seal(payload,command));
    console.log(resolve(output));
  } finally {
    try{snapshotDb?.close()}catch{}try{if(existsSync(temp))unlinkSync(temp)}catch{}
  }
} else {
  const payload=open(readFileSync(resolve(output)));mkdirSync(dataDir,{recursive:true});
  if(!/^[a-f0-9]{64}$/i.test(payload.masterKey||'')||typeof payload.database!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(payload.database))throw new Error('快照内容缺少有效的数据库或内部加密密钥');
  const incomingDatabase=Buffer.from(payload.database,'base64');if(!incomingDatabase.subarray(0,16).equals(Buffer.from('SQLite format 3\0')))throw new Error('快照中的数据库文件头无效');
  const hadDatabase=existsSync(database),hadKey=existsSync(masterKeyPath);
  const token=randomUUID(),temp=`${database}.${token}.incoming`,tempKey=`${masterKeyPath}.${token}.incoming`;
  let databaseReplaced=false,keyReplaced=false;
  try{
    writeFileSync(temp,incomingDatabase,{mode:0o600,flag:'wx'});
    const check=new DatabaseSync(temp);try{validateSnapshotDatabase(check,payload.masterKey);check.exec('DELETE FROM sessions');check.exec('UPDATE users SET session_version=session_version+1');check.exec('PRAGMA wal_checkpoint(TRUNCATE)')}finally{check.close()}
    mkdirSync(dirname(masterKeyPath),{recursive:true});atomicWriteFile(tempKey,`${payload.masterKey}\n`);
    if(hadDatabase){const current=new DatabaseSync(database);try{const result=current.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();if(result.busy)throw new Error('数据库仍被占用，请先停止应用再恢复')}finally{current.close()}copyFileSync(database,`${database}.before-restore`);chmodSync(`${database}.before-restore`,0o600)}
    if(hadKey){copyFileSync(masterKeyPath,`${masterKeyPath}.before-restore`);chmodSync(`${masterKeyPath}.before-restore`,0o600)}
    for(const suffix of ['-wal','-shm'])try{unlinkSync(`${database}${suffix}`)}catch(e){if(e.code!=='ENOENT')throw e}
    renameSync(temp,database);databaseReplaced=true;renameSync(tempKey,masterKeyPath);keyReplaced=true;chmodSync(database,0o600);chmodSync(masterKeyPath,0o600);
  }catch(error){
    try{if(existsSync(temp))unlinkSync(temp)}catch{}try{if(existsSync(tempKey))unlinkSync(tempKey)}catch{}
    const rollbackErrors=[];
    try{if(databaseReplaced){if(hadDatabase)copyFileSync(`${database}.before-restore`,database);else unlinkSync(database)}}catch(e){rollbackErrors.push(e)}
    try{if(keyReplaced){if(hadKey)copyFileSync(`${masterKeyPath}.before-restore`,masterKeyPath);else unlinkSync(masterKeyPath)}}catch(e){rollbackErrors.push(e)}
    if(rollbackErrors.length)throw new AggregateError([error,...rollbackErrors],'恢复失败且回滚未完成；请保持应用停止，使用 .before-restore 数据库和密钥恢复');
    throw error
  }
  console.log('数据库与内部备份密钥已恢复。');
  if(hadDatabase)console.log(`旧数据库保留在：${database}.before-restore`);
}
