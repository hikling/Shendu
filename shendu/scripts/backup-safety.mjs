import { openSync, closeSync, writeFileSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, createDecipheriv } from 'node:crypto';

export function validBase64(value, bytes) {
  if (typeof value !== 'string' || !value.length || (bytes !== undefined && value.length !== Math.ceil(bytes / 3) * 4) || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  return (bytes === undefined || decoded.length === bytes) && decoded.toString('base64') === value;
}

// Write beside the destination so a failed/interrupted write cannot truncate its previous contents.
export function atomicWriteFile(file, contents) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, contents); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, file);
    const directory = openSync(dirname(file), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

// A syntactically valid key is not enough: authenticate every encrypted field in the snapshot.
export function validateSnapshotDatabase(db, keyHex) {
  if (!/^[a-f0-9]{64}$/i.test(keyHex)) throw new Error('快照缺少有效的内部数据加密密钥');
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('快照数据库完整性校验失败');
  const key = Buffer.from(keyHex, 'hex');
  const encrypted = db.prepare("SELECT value FROM schema_meta WHERE key='data_encryption'").get()?.value === 'AES-256-GCM';
  const content = (value, scope) => {
    if (!String(value).startsWith('sd1.')) {
      if (encrypted) throw new Error('快照中的加密字段缺失');
      if (!scope.endsWith(':title')) JSON.parse(value);
      return;
    }
    const parts = value.split('.'); if (parts.length !== 4) throw new Error('快照中的加密字段格式无效');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64url'), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(`shendu:data:v1:${scope}`)); decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8'));
  };
  const credential = value => {
    const x = JSON.parse(value), decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(x.iv, 'base64'), { authTagLength: 16 });
    decipher.setAuthTag(Buffer.from(x.tag, 'base64'));
    JSON.parse(Buffer.concat([decipher.update(Buffer.from(x.data, 'base64')), decipher.final()]).toString('utf8'));
  };
  try {
    for (const row of db.prepare('SELECT id,user_id,title,data,verification FROM records').all()) {
      for (const field of ['title', 'data', 'verification']) if (field !== 'verification' || row[field] !== null) content(row[field], `record:${row.user_id}:${row.id}:${field}`);
    }
    for (const row of db.prepare('SELECT user_id,key,value FROM user_settings').all()) {
      if (row.key === 'backup_secret') { const wrapped = JSON.parse(row.value); if (wrapped) credential(wrapped); }
      else content(row.value, `setting:${row.user_id}:${row.key}`);
    }
    for (const row of db.prepare('SELECT encrypted_config FROM backup_targets').all()) credential(row.encrypted_config);
  } catch {
    throw new Error('内部密钥与快照数据库不匹配，或加密数据损坏；操作已停止');
  }
}
