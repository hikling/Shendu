// Synthetic, deterministic compatibility fixtures. This serializer is intentionally
// independent of the production parser; regenerate only when adding a historical format.
import { createCipheriv, createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const directory = dirname(fileURLToPath(import.meta.url));
const password = 'fixture-password-2026';
const exportedAt = '2026-09-29T04:31:16.000Z';
const owner = { username: 'fixture_owner', displayName: '测试用户' };
const stage = { name: '深度工作', focus: '保持清醒', startDate: '2026-09-01', days: 60, sleepTarget: 8, energyTarget: 82, showQuarter: true, metrics: [{ name: '阅读', target: '每日三十分钟' }, { name: '运动', target: '每周三次' }, { name: '复盘', target: '每晚' }], reviewTemplates: { daily: { today: '自己的日课' } }, actionTemplate: { pageTitle: '自己的行动' } };
const theme = { preset: '自定义', primary: '#123456', secondary: '#AABBCC', tertiary: '#778899', reduceMotion: true };
const types = [
  ['daily', '2026-09-28'], ['weekly', '2026-W40'], ['monthly', '2026-09'],
  ['quarterly', '2026-09-30'], ['yearly', '2026'], ['decision', '2026-09-27']
];
const records = types.map(([type, period], index) => ({
  id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
  type, period, title: `${type} 中文标题`, status: index === 0 ? 'verified' : index === 1 ? 'completed' : 'draft',
  version: index + 1, created_at: exportedAt, updated_at: exportedAt,
  completed_at: index < 2 ? exportedAt : null, verified_at: index === 0 ? exportedAt : null,
  verification: index === 0 ? { result: '已完成，中文验证', adjustment: '保持节奏' } : null,
  data: { answers: { today: ['认真执行'] }, journal: `${type} 的日记`, action: '写作', ifCondition: '疲劳', ifThen: '休息后继续', verifyDate: '2026-10-01', templateSnapshot: { version: 1, review: { pageTitle: '旧模板' }, action: { pageTitle: '旧行动模板' } } }
}));
const entries = [{ kind: 'profile', value: owner }, { kind: 'stage', value: stage }, { kind: 'theme', value: theme }, ...records.map(value => ({ kind: 'record', value }))];
const write = (name, content) => writeFileSync(join(directory, `${name}.shendu`), content + '\n');
const sealEnvelope = version => {
  const salt = Buffer.alloc(16, version), iv = Buffer.alloc(12, version);
  const header = { format: `shendu-v${version}`, version, ...(version === 4 ? { kind: 'account' } : {}), kdf: { name: 'PBKDF2-HMAC-SHA-256', iterations: 600000, salt: salt.toString('base64') }, cipher: { name: 'AES-256-GCM', iv: iv.toString('base64') }, compression: 'gzip' };
  const clear = { format: 'shendu-account-data', version, ...(version === 4 ? { owner } : {}), exportedAt, entries };
  const key = pbkdf2Sync(password, salt, 600000, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(JSON.stringify(header)));
  const data = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(clear)))), cipher.final()]);
  write(`v${version}`, JSON.stringify({ ...header, tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }));
};
sealEnvelope(4); sealEnvelope(3);

{
  const salt = Buffer.alloc(16, 2), key = pbkdf2Sync(password, salt, 600000, 64, 'sha256');
  const lines = [JSON.stringify({ format: 'shendu-v2', iterations: 600000, salt: salt.toString('base64'), count: entries.length })];
  entries.forEach((entry, seq) => {
    const iv = Buffer.alloc(12, seq + 1), cipher = createCipheriv('aes-256-gcm', key.subarray(0, 32), iv);
    cipher.setAAD(Buffer.from(`shendu-v2|${seq}|${entries.length}`));
    const data = Buffer.concat([cipher.update(JSON.stringify(entry)), cipher.final()]);
    lines.push(JSON.stringify({ seq, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }));
  });
  lines.push(JSON.stringify({ end: true, count: entries.length, mac: createHmac('sha256', key.subarray(32)).update(lines.join('\n')).digest('base64') }));
  write('v2', lines.join('\n'));
}

const oldSettings = { stage: '深度工作', focus: '保持清醒', start: '2026-09-01', days: 60, sleep: 8, energy: 82, showQuarterly: true, metrics: stage.metrics, legacyColor: 'old-only' };
const oldReviews = types.map(([type], index) => ({
  id: index === 5 ? undefined : records[index].id, type, period: records[index].period, title: records[index].title,
  status: index < 2 ? 'completed' : 'draft', verified: index === 0, revision: index + 1,
  updatedAt: exportedAt, verificationDate: '2026-10-01',
  data: { today: '认真执行', journal: `${type} 的日记`, action: '写作', ifThen: '休息后继续', outcome: '已完成，中文验证', lesson: '保持节奏', oldCustomField: '旧版未知字段' }
}));
{
  const salt = Buffer.alloc(16, 5), key = pbkdf2Sync(password, salt, 600000, 32, 'sha256');
  const header = JSON.stringify({ format: 'shendu-stream-v2', kind: 'account', iterations: 600000, salt: salt.toString('hex') });
  const scope = createHash('sha256').update(header).digest('hex');
  const items = [{ kind: 'metadata', source: owner, settings: oldSettings, exportedAt }, ...oldReviews.map(review => ({ kind: 'review', review })), { kind: 'end', total: oldReviews.length }];
  const lines = [header, ...items.map((value, i) => {
    const iv = Buffer.alloc(12, i + 1), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(`shendu:backup-credential:v1:${scope}:${i}`));
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
  })];
  write('stream-v2', lines.join('\n'));
}
{
  const salt = Buffer.alloc(16, 1), iv = Buffer.alloc(12, 1);
  const header = { format: 'shendu-encrypted-backup', version: 1, kind: 'account', createdAt: exportedAt, kdf: { name: 'PBKDF2-HMAC-SHA-256', iterations: 600000, salt: salt.toString('base64url') }, cipher: { name: 'AES-256-GCM', iv: iv.toString('base64url') }, payloadBytes: 0 };
  const clear = Buffer.from(JSON.stringify({ format: 'shendu-user-backup', version: 1, source: owner, settings: oldSettings, exportedAt, reviews: oldReviews }));
  header.payloadBytes = clear.length;
  const key = pbkdf2Sync(password, salt, 600000, 32, 'sha256'), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(header)));
  const ciphertext = Buffer.concat([cipher.update(clear), cipher.final()]);
  write('encrypted-v1', JSON.stringify({ ...header, tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') }));
}
