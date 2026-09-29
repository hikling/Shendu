import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync, createHmac, createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { runInNewContext } from 'node:vm';
import { atomicWriteFile } from '../scripts/backup-safety.mjs';

const appDir = fileURLToPath(new URL('../', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'shendu-security-'));
const dataDir = join(root, 'source');
const password = 'audit-login-' + randomBytes(16).toString('hex');
const backupPassword = 'audit-backup-' + randomBytes(16).toString('hex');
const secretText = 'PRIVATE-JOURNAL-' + randomBytes(16).toString('hex');
const passwordFile = join(root, 'password.txt');
writeFileSync(passwordFile, backupPassword + '\n', { mode: 0o600 });
let child, base, cookie, memberCookie, accountBackup, siteBackup, recordId, sourceId;
let logs = '';

async function api(path, { method = 'GET', body, auth = cookie, headers = {} } = {}) {
  const response = await fetch(base + path, {
    method, headers: { ...(auth ? { Cookie: auth } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let value; try { value = JSON.parse(text); } catch { value = text; }
  return { status: response.status, value, text, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
function envelopePayload(text, pass = backupPassword) {
  const x = JSON.parse(text);
  const { tag, data, ...header } = x;
  const key = pbkdf2Sync(pass, Buffer.from(x.kdf.salt, 'base64'), 600000, 32, 'sha256');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(x.cipher.iv, 'base64'), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(JSON.stringify(header))); decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(gunzipSync(Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()])));
}
function reseal(text, payload) {
  const { tag, data, ...header } = JSON.parse(text);
  header.kdf.salt = randomBytes(16).toString('base64'); header.cipher.iv = randomBytes(12).toString('base64');
  const key = pbkdf2Sync(backupPassword, Buffer.from(header.kdf.salt, 'base64'), 600000, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(header.cipher.iv, 'base64'));
  cipher.setAAD(Buffer.from(JSON.stringify(header)));
  const encrypted = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(payload)))), cipher.final()]);
  return JSON.stringify({ ...header, tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
}
function cli(command, file, directory = dataDir) {
  return spawnSync(process.execPath, ['scripts/admin-cli.mjs', command, file, '--password-file', passwordFile], {
    cwd: appDir, env: { ...process.env, SHENDU_DATA_DIR: directory, SHENDU_MASTER_KEY: '', SHENDU_MASTER_KEY_PATH: join(directory, 'backup-master.key') }, encoding: 'utf8'
  });
}
before(async () => {
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: appDir, env: { ...process.env, SHENDU_PORT: String(port), SHENDU_DATA_DIR: dataDir, SHENDU_TMP_DIR: join(root, 'uploads'), SHENDU_MASTER_KEY: '', SHENDU_MASTER_KEY_PATH: join(dataDir, 'backup-master.key') }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { logs += b; });
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    try { ready = (await fetch(base + '/healthz')).ok; } catch {}
    if (!ready) await new Promise(r => setTimeout(r, 20));
  }
  assert.ok(ready, logs);
  const registration = await api('/api/auth/register', { method: 'POST', auth: '', body: { username: 'audit_owner', password } });
  assert.equal(registration.status, 201, registration.text); cookie = registration.cookie; sourceId = registration.value.user.id;
  assert.equal((await api('/api/admin/users', { method: 'POST', body: { username: 'audit_member', password } })).status, 201);
  const member = await api('/api/auth/login', { method: 'POST', auth: '', body: { username: 'audit_member', password } }); memberCookie = member.cookie;
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const record = await api('/api/records', { method: 'PUT', body: { type: 'daily', period: today, title: secretText, data: { answers: { today: [secretText] }, journal: secretText, action: '行动', ifCondition: '阻碍', ifThen: '应对', verifyDate: today } } });
  assert.equal(record.status, 200, record.text); recordId = record.value.record.id;
  assert.equal((await api(`/api/records/${recordId}/complete`, { method: 'POST' })).status, 200);
  assert.equal((await api(`/api/records/${recordId}/verify`, { method: 'POST', body: { result: secretText, adjustment: '保留方法' } })).status, 200);
  assert.equal((await api('/api/backup/password', { method: 'POST', body: { password: backupPassword } })).status, 200);
  const exported = await api('/api/backup/export', { method: 'POST', body: {} }); assert.equal(exported.status, 200, exported.text); accountBackup = exported.text;
  const site = await api('/api/admin/site-backup/export', { method: 'POST', body: { currentPassword: password, backupPassword } }); assert.equal(site.status, 200, site.text); siteBackup = site.text;
});
after(async () => {
  if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; }
  rmSync(root, { recursive: true, force: true });
});

test('个人与整站备份不暴露正文或用户名；数据库正文和验证结果使用密文', () => {
  for (const text of [accountBackup, siteBackup]) { assert.ok(!text.includes(secretText)); assert.ok(!text.includes('audit_owner')); }
  const db = new DatabaseSync(join(dataDir, 'shendu.db'), { readOnly: true });
  try { const r = db.prepare('SELECT title,data,verification FROM records WHERE id=?').get(recordId); for (const v of Object.values(r)) assert.ok(v.startsWith('sd1.') && !v.includes(secretText)); }
  finally { db.close(); }
  assert.equal(statSync(join(dataDir, 'backup-master.key')).mode & 0o777, 0o600);
});
test('个人备份可解密，保留标题、日记、验证内容、状态和模板快照', () => {
  const record = envelopePayload(accountBackup).entries.find(e => e.kind === 'record').value;
  assert.equal(record.title, secretText); assert.equal(record.data.journal, secretText); assert.equal(record.verification.result, secretText); assert.equal(record.status, 'verified'); assert.ok(record.data.templateSnapshot);
});
test('错误密码与篡改的密文、标签、AAD 均不能通过校验', async () => {
  assert.equal((await api('/api/data/inspect', { method: 'POST', body: { encryptedBackup: accountBackup, password: 'wrong-backup-password' } })).status, 400);
  for (const key of ['data', 'tag', 'cipher']) {
    const x = JSON.parse(accountBackup);
    if (key === 'cipher') x.cipher.iv = randomBytes(12).toString('base64'); else { const b = Buffer.from(x[key], 'base64'); b[0] ^= 1; x[key] = b.toString('base64'); }
    assert.equal((await api('/api/data/inspect', { method: 'POST', body: { encryptedBackup: JSON.stringify(x), password: backupPassword } })).status, 400, key);
  }
});
test('非法 Base64 和整包后附加的数据必须被拒绝', async () => {
  const x = JSON.parse(accountBackup); x.data += '!';
  for (const text of [JSON.stringify(x), accountBackup + '\n{"injected":true}']) {
    assert.equal((await api('/api/data/inspect', { method: 'POST', body: { encryptedBackup: text, password: backupPassword } })).status, 400);
  }
});
test('账户隔离与跨账户恢复确认', async () => {
  assert.equal((await api(`/api/records/${recordId}`, { auth: memberCookie })).status, 404);
  assert.equal((await api('/api/admin/site-backup/export', { auth: memberCookie, method: 'POST', body: { currentPassword: password, backupPassword } })).status, 403);
  const body = { encryptedBackup: accountBackup, password: backupPassword, mode: 'merge' };
  assert.equal((await api('/api/data/import', { auth: memberCookie, method: 'POST', body })).status, 403);
  assert.equal((await api('/api/data/import', { auth: memberCookie, method: 'POST', body: { ...body, sourceUsername: 'audit_owner' } })).status, 200);
  const rows = (await api('/api/records', { auth: memberCookie })).value.records;
  assert.equal(rows.length, 1); assert.notEqual(rows[0].id, recordId); assert.equal(rows[0].data.journal, secretText);
});
test('安全合并不能用较新草稿覆盖已锁定记录', async () => {
  const payload = envelopePayload(accountBackup), record = payload.entries.find(e => e.kind === 'record').value;
  record.updated_at = '2099-01-01T00:00:00.000Z'; record.status = 'draft'; record.data.journal = 'overwritten'; record.verification = null;
  const result = await api('/api/data/import', { method: 'POST', body: { encryptedBackup: reseal(accountBackup, payload), password: backupPassword, mode: 'merge' } });
  assert.equal(result.status, 200, result.text);
  const restored = (await api(`/api/records/${recordId}`)).value.record;
  assert.equal(restored.status, 'verified'); assert.equal(restored.data.journal, secretText);
});
test('无效个人恢复不删除旧数据', async () => {
  const before = (await api('/api/records')).text;
  const payload = envelopePayload(accountBackup); payload.entries.find(e => e.kind === 'record').value.type = 'invalid';
  assert.equal((await api('/api/data/import', { method: 'POST', body: { encryptedBackup: reseal(accountBackup, payload), password: backupPassword, mode: 'replace', confirmation: 'RESTORE' } })).status, 400);
  assert.equal((await api('/api/records')).text, before);
});
test('整站恢复数据库约束失败时回滚账户、记录和会话', async () => {
  const before = (await api('/api/records')).text, payload = envelopePayload(siteBackup);
  payload.records.push({ ...payload.records[0], id: '11111111-1111-4111-8111-111111111111' });
  const result = await api('/api/admin/site-backup/restore', { method: 'POST', body: { encryptedBackup: reseal(siteBackup, payload), currentPassword: password, backupPassword, confirmation: 'RESTORE_SITE' } });
  assert.equal(result.status, 400); assert.equal((await api('/api/records')).text, before);
});
test('网页整站恢复能恢复原账户、加密记录并注销旧会话', async () => {
  assert.equal((await api('/api/admin/site-backup/restore', { method: 'POST', body: { encryptedBackup: siteBackup, currentPassword: password, backupPassword, confirmation: 'RESTORE_SITE' } })).status, 200);
  assert.equal((await api('/api/records')).status, 401);
  const login = await api('/api/auth/login', { method: 'POST', auth: '', body: { username: 'audit_owner', password } }); cookie = login.cookie;
  const record = (await api(`/api/records/${recordId}`)).value.record; assert.equal(record.status, 'verified'); assert.equal(record.data.journal, secretText);
});
test('服务器快照往返恢复可解密；数据库与密钥匹配', () => {
  const file = join(root, 'snapshot.shendu-db'); assert.equal(cli('snapshot', file).status, 0);
  const dest = join(root, 'restored'); assert.equal(cli('restore', file, dest).status, 0);
  const restoredKey = readFileSync(join(dest, 'backup-master.key')); assert.deepEqual(restoredKey, readFileSync(join(dataDir, 'backup-master.key')));
  const db = new DatabaseSync(join(dest, 'shendu.db'), { readOnly: true });
  try {
    const record = db.prepare('SELECT * FROM records WHERE id=?').get(recordId);
    const [, iv, tag, data] = record.data.split('.'), key = Buffer.from(restoredKey.toString().trim(), 'hex');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(`shendu:data:v1:record:${sourceId}:${recordId}:data`)); decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    assert.equal(JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()])).journal, secretText);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  } finally { db.close(); }
});
test('快照拒绝截短认证标签和错误密码', () => {
  const x = JSON.parse(readFileSync(join(root, 'snapshot.shendu-db'), 'utf8')); x.tag = Buffer.from(x.tag, 'base64').subarray(0, 4).toString('base64');
  const file = join(root, 'truncated.shendu-db'); writeFileSync(file, JSON.stringify(x));
  assert.notEqual(cli('restore', file, join(root, 'truncated-target')).status, 0);
  const original = readFileSync(passwordFile); writeFileSync(passwordFile, 'a-different-backup-password');
  try { assert.notEqual(cli('restore', join(root, 'snapshot.shendu-db'), join(root, 'wrong-password')).status, 0); }
  finally { writeFileSync(passwordFile, original); }
});
test('快照必须拒绝与现有密文不匹配的主密钥', () => {
  const keyFile = join(dataDir, 'backup-master.key'), original = readFileSync(keyFile), file = join(root, 'bad-key.shendu-db');
  writeFileSync(keyFile, randomBytes(32).toString('hex') + '\n');
  try { assert.notEqual(cli('snapshot', file).status, 0); assert.ok(!existsSync(file)); }
  finally { writeFileSync(keyFile, original); }
});

test('已认证但内含错误主密钥的快照不能替换现有数据库', () => {
  const x = JSON.parse(readFileSync(join(root, 'snapshot.shendu-db'), 'utf8'));
  const key = pbkdf2Sync(backupPassword, Buffer.from(x.salt, 'base64'), 600000, 32, 'sha256');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(x.iv, 'base64'), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(x.format)); decipher.setAuthTag(Buffer.from(x.tag, 'base64'));
  const payload = JSON.parse(gunzipSync(Buffer.concat([decipher.update(Buffer.from(x.data, 'base64')), decipher.final()])));
  payload.masterKey = randomBytes(32).toString('hex'); x.iv = randomBytes(12).toString('base64');
  const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(x.iv, 'base64')); cipher.setAAD(Buffer.from(x.format));
  x.data = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(payload)))), cipher.final()]).toString('base64'); x.tag = cipher.getAuthTag().toString('base64');
  const file = join(root, 'wrong-internal-key.shendu-db'); writeFileSync(file, JSON.stringify(x));
  const dest = join(root, 'restored'), dbFile = join(dest, 'shendu.db'), keyFile = join(dest, 'backup-master.key');
  const beforeDb = readFileSync(dbFile), beforeKey = readFileSync(keyFile);
  assert.notEqual(cli('restore', file, dest).status, 0); assert.deepEqual(readFileSync(dbFile), beforeDb); assert.deepEqual(readFileSync(keyFile), beforeKey);
});
test('主密钥及快照写入失败保留旧文件；输出不能覆盖数据库或密钥', () => {
  const file = join(root, 'atomic.txt'); writeFileSync(file, 'previous');
  assert.throws(() => atomicWriteFile(file, Symbol('invalid data'))); assert.equal(readFileSync(file, 'utf8'), 'previous');
  for (const output of [join(dataDir, 'shendu.db'), join(dataDir, 'backup-master.key'), passwordFile]) assert.notEqual(cli('snapshot', output).status, 0);
});
test('网页整站导出检查解压上限，避免生成无法导入的高压缩率文件', () => {
  const source = readFileSync(join(appDir, 'server.mjs'), 'utf8');
  const implementation = source.slice(source.indexOf('function createSiteBackupBuffer('), source.indexOf('function siteBackupTextFrom('));
  const context = { Buffer, randomBytes, pbkdf2Sync, createCipheriv, gzipSync, MAX_SITE_BACKUP_REQUEST_BYTES: 1024, siteBackupPayload: () => ({ journal: 'x'.repeat(1024) }), validateSiteBackupPayload: () => {} };
  assert.throws(() => runInNewContext(implementation + ';createSiteBackupBuffer("test-password-for-export")', context), e => e.status === 413);
});
test('旧 v3 与 v2 个人加密备份保持兼容', async () => {
  const payload = envelopePayload(accountBackup), { tag, data, kind, ...header } = JSON.parse(accountBackup);
  header.format = 'shendu-v3'; header.version = 3; payload.version = 3;
  const v3 = reseal(JSON.stringify({ ...header, tag, data }), payload);
  const entries = payload.entries, salt = randomBytes(16), key = pbkdf2Sync(backupPassword, salt, 600000, 64, 'sha256');
  const lines = [JSON.stringify({ format: 'shendu-v2', iterations: 600000, salt: salt.toString('base64'), count: entries.length })];
  for (let i = 0; i < entries.length; i++) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key.subarray(0, 32), iv);
    cipher.setAAD(Buffer.from(`shendu-v2|${i}|${entries.length}`));
    const data = Buffer.concat([cipher.update(JSON.stringify(entries[i])), cipher.final()]);
    lines.push(JSON.stringify({ seq: i, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }));
  }
  lines.push(JSON.stringify({ end: true, count: entries.length, mac: createHmac('sha256', key.subarray(32)).update(lines.join('\n')).digest('base64') }));
  for (const backup of [v3, lines.join('\n')]) assert.equal((await api('/api/data/inspect', { method: 'POST', body: { encryptedBackup: backup, password: backupPassword } })).status, 200);
});
test('旧流式备份保持兼容，并拒绝截断或重排条目', async () => {
  const salt = randomBytes(16), key = pbkdf2Sync(backupPassword, salt, 600000, 32, 'sha256');
  const header = JSON.stringify({ format: 'shendu-stream-v2', kind: 'account', iterations: 600000, salt: salt.toString('hex') });
  const scope = createHash('sha256').update(header).digest('hex');
  const entries = [{ kind: 'metadata', source: { username: 'audit_owner' } }, { kind: 'review', review: { type: 'daily', period: '2026-09-28', data: { journal: secretText } } }, { kind: 'end', total: 1 }];
  const lines = [header, ...entries.map((value, i) => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(`shendu:backup-credential:v1:${scope}:${i}`));
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
  })];
  const inspect = text => api('/api/data/inspect', { method: 'POST', body: { encryptedBackup: text, password: backupPassword } });
  assert.equal((await inspect(lines.join('\n'))).status, 200);
  assert.equal((await inspect(lines.slice(0, -1).join('\n'))).status, 400);
  assert.equal((await inspect([lines[0], lines[2], lines[1], lines[3]].join('\n'))).status, 400);
});
test('跨站写入、非当前周期、修改已锁定记录被拒绝', async () => {
  assert.equal((await api('/api/backup/password', { method: 'POST', headers: { Origin: 'https://attacker.invalid' }, body: { password: backupPassword } })).status, 403);
  assert.equal((await api('/api/records', { method: 'PUT', body: { type: 'daily', period: '2099-01-01', data: {} } })).status, 400);
  const record = (await api(`/api/records/${recordId}`)).value.record;
  assert.equal((await api('/api/records', { method: 'PUT', body: record })).status, 409);
});
test('外部备份拒绝本机、内网、非 HTTPS 和包含 URL 凭据的地址', async () => {
  for (const url of ['https://127.0.0.1', 'https://0x7f000001', 'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://169.254.169.254', 'http://example.com', 'https://user:pass@example.com']) {
    const result = await api('/api/backup/targets', { method: 'POST', body: { name: 'rejected', kind: 'webdav', config: { url, username: 'user', password: 'secret', directory: 'backups' } } });
    assert.equal(result.status, 400, url);
  }
});
test('已认证的整站备份仍须核对运行记录与备份目标的账户归属', async () => {
  const payload = envelopePayload(siteBackup), owner = payload.users.find(x => x.username === 'audit_owner'), member = payload.users.find(x => x.username === 'audit_member');
  const targetId = '22222222-2222-4222-8222-222222222222';
  payload.targets.push({ id: targetId, user_id: owner.id, name: 'test', kind: 'webdav', schedule: 'manual', config: { url: 'https://example.com/dav', username: 'user', password: 'secret', directory: 'backup' } });
  payload.runs.push({ id: '33333333-3333-4333-8333-333333333333', target_id: targetId, user_id: member.id, status: 'success', message: 'wrong owner' });
  assert.equal((await api('/api/admin/site-backup/inspect', { method: 'POST', body: { encryptedBackup: reseal(siteBackup, payload), backupPassword } })).status, 400);
});
test('密码文件保留首尾空格，不静默改变用户的备份密码', () => {
  const original = readFileSync(passwordFile), withSpaces = ` ${backupPassword} `, file = join(root, 'spaces.shendu-db');
  writeFileSync(passwordFile, withSpaces + '\n');
  try {
    assert.equal(cli('snapshot', file).status, 0);
    const x = JSON.parse(readFileSync(file, 'utf8')), key = pbkdf2Sync(withSpaces, Buffer.from(x.salt, 'base64'), 600000, 32, 'sha256');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(x.iv, 'base64'), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(x.format)); decipher.setAuthTag(Buffer.from(x.tag, 'base64'));
    const clear = gunzipSync(Buffer.concat([decipher.update(Buffer.from(x.data, 'base64')), decipher.final()]));
    assert.equal(JSON.parse(clear).masterKey, readFileSync(join(dataDir, 'backup-master.key'), 'utf8').trim());
  } finally { writeFileSync(passwordFile, original); }
});
