import http from 'node:http';
import https from 'node:https';
import { readFileSync, existsSync, mkdirSync, statSync, createReadStream, writeFileSync, appendFileSync, unlinkSync, readdirSync, chmodSync } from 'node:fs';
import { join, extname, resolve, dirname, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash, createHmac, createCipheriv, createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { lookup } from 'node:dns/promises';
import net from 'node:net';

process.umask(0o077);
const PORT = Number(process.env.SHENDU_PORT || 3000);
const DATA_DIR = resolve(process.env.SHENDU_DATA_DIR || './data');
const TMP_DIR = resolve(process.env.SHENDU_TMP_DIR || './tmp');
const PUBLIC_DIR = resolve('./public');
const COOKIE_SECURE = process.env.SHENDU_SECURE_COOKIE === 'true';
const MASTER_KEY_PATH = resolve(process.env.SHENDU_MASTER_KEY_PATH || join(DATA_DIR, 'backup-master.key'));
const DATABASE_PATH = join(DATA_DIR, 'shendu.db');
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(TMP_DIR, { recursive: true });
let masterKey = null;
let masterKeyError = null;

const db = new DatabaseSync(DATABASE_PATH);
for (const file of [DATABASE_PATH,`${DATABASE_PATH}-wal`,`${DATABASE_PATH}-shm`]) try { if(existsSync(file))chmodSync(file,0o600); } catch {}
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA foreign_keys=ON;
  PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('superadmin','admin','member')),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
    session_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_version INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(user_id,key)
  );
  CREATE TABLE IF NOT EXISTS records (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    period TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','completed','verified')),
    version INTEGER NOT NULL DEFAULT 1,
    verification TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    verified_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_records_user_period ON records(user_id,type,period);
  CREATE INDEX IF NOT EXISTS idx_records_user_status ON records(user_id,status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_records_unique_period ON records(user_id,type,period) WHERE type!='decision';
  CREATE TABLE IF NOT EXISTS backup_targets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('webdav','s3')),
    encrypted_config TEXT NOT NULL,
    schedule TEXT NOT NULL DEFAULT 'manual' CHECK(schedule IN ('manual','daily','weekly')),
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT,
    last_success_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS backup_runs (
    id TEXT PRIMARY KEY,
    target_id TEXT NOT NULL REFERENCES backup_targets(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_backup_runs_user ON backup_runs(user_id,created_at DESC);
  INSERT OR IGNORE INTO schema_meta(key,value) VALUES ('schema_version','6');
  INSERT OR IGNORE INTO schema_meta(key,value) VALUES ('public_registration','true');
`);

const DATA_ENVELOPE_PREFIX = 'sd1.';
const dataScope = (...parts) => parts.join(':');
const isEncryptedData = value => typeof value === 'string' && value.startsWith(DATA_ENVELOPE_PREFIX);
const encryptDataWithKey = (value, key, scope) => {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`shendu:data:v1:${scope}`));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return `${DATA_ENVELOPE_PREFIX}${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
};
const decryptDataWithKey = (value, key, scope) => {
  const parts = String(value || '').split('.');
  if (parts.length !== 4 || `${parts[0]}.` !== DATA_ENVELOPE_PREFIX) throw new Error('加密数据格式不正确');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64url'));
  decipher.setAAD(Buffer.from(`shendu:data:v1:${scope}`));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8'));
};
const parseMasterKey = value => /^[a-f0-9]{64}$/i.test(String(value || '').trim()) ? Buffer.from(String(value).trim(), 'hex') : null;
const decryptSecretWithKey = (value, key) => {
  const x = JSON.parse(value);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(x.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(x.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(x.data, 'base64')), decipher.final()]).toString('utf8'));
};
const encryptedCredentialRows = () => {
  const rows = [];
  for (const row of db.prepare(`SELECT value FROM user_settings WHERE key='backup_secret'`).all()) {
    try {
      const wrapped = JSON.parse(row.value);
      if (typeof wrapped === 'string' && wrapped) rows.push(wrapped);
    } catch { rows.push(row.value); }
  }
  for (const row of db.prepare(`SELECT encrypted_config FROM backup_targets`).all()) if (row.encrypted_config) rows.push(row.encrypted_config);
  return rows;
};
const encryptedContentRows = () => {
  const rows = [];
  for (const row of db.prepare(`SELECT user_id,key,value FROM user_settings WHERE key!='backup_secret'`).all()) {
    if (isEncryptedData(row.value)) rows.push({ value: row.value, scope: dataScope('setting', row.user_id, row.key) });
  }
  for (const row of db.prepare(`SELECT id,user_id,title,data,verification FROM records`).all()) {
    if (isEncryptedData(row.title)) rows.push({ value: row.title, scope: dataScope('record', row.user_id, row.id, 'title') });
    if (isEncryptedData(row.data)) rows.push({ value: row.data, scope: dataScope('record', row.user_id, row.id, 'data') });
    if (isEncryptedData(row.verification)) rows.push({ value: row.verification, scope: dataScope('record', row.user_id, row.id, 'verification') });
  }
  return rows;
};
const persistMasterKey = key => {
  mkdirSync(dirname(MASTER_KEY_PATH), { recursive: true });
  writeFileSync(MASTER_KEY_PATH, `${key.toString('hex')}\n`, { mode: 0o600 });
  try { chmodSync(MASTER_KEY_PATH, 0o600); } catch {}
};
const initialiseMasterKey = () => {
  const configured = parseMasterKey(process.env.SHENDU_MASTER_KEY);
  let persisted = null;
  if (existsSync(MASTER_KEY_PATH)) {
    try { persisted = parseMasterKey(readFileSync(MASTER_KEY_PATH, 'utf8')); } catch {}
  }
  const encryptedRows = encryptedCredentialRows();
  const encryptedContent = encryptedContentRows();
  const candidates = [configured, persisted]
    .filter(Boolean)
    .filter((key, index, all) => all.findIndex(candidate => candidate.equals(key)) === index);
  if (encryptedRows.length || encryptedContent.length) {
    masterKey = candidates.find(key => encryptedRows.every(value => {
      try { decryptSecretWithKey(value, key); return true; } catch { return false; }
    }) && encryptedContent.every(item => {
      try { decryptDataWithKey(item.value, key, item.scope); return true; } catch { return false; }
    })) || null;
    if (!masterKey) {
      masterKeyError = '服务器数据加密密钥与现有数据库不匹配。请恢复正确的 backup-master.key；个人 .shendu 文件仍可使用原备份密码恢复。';
      console.error(masterKeyError);
      return;
    }
  } else {
    masterKey = persisted || configured || randomBytes(32);
  }
  try { persistMasterKey(masterKey); }
  catch (e) {
    masterKeyError = '内部备份密钥无法写入数据目录，请检查 data 目录权限。';
    if (!configured && !persisted) masterKey = null;
    console.error(masterKeyError, e);
  }
};
initialiseMasterKey();

const now = () => new Date().toISOString();
const BEIJING_TIME_ZONE = 'Asia/Shanghai';
const beijingParts = (value = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BEIJING_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(value);
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
};
const todayDate = () => {
  const p = beijingParts();
  return `${p.year}-${p.month}-${p.day}`;
};
const isoWeekValue = value => {
  const [year, month, day] = String(value).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1, 12));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
};
const currentPeriodFor = type => {
  const current = todayDate();
  if (type === 'weekly') return isoWeekValue(current);
  if (type === 'monthly') return current.slice(0, 7);
  if (type === 'yearly') return current.slice(0, 4);
  return current;
};
const currentPeriodMessage = type => ({
  daily: '只能填写今天的每日复盘', weekly: '只能填写本周的每周复盘', monthly: '只能填写本月的每月复盘',
  quarterly: '只能填写今天的 90 天复盘', yearly: '只能填写本年的年度复盘', decision: '只能填写今天的重大决策'
}[type] || '只能填写当前周期的复盘');
const shiftCalendarDate = (value, days) => {
  const [year, month, day] = String(value).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12));
  return date.toISOString().slice(0, 10);
};
const beijingFileStamp = () => {
  const p = beijingParts();
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`;
};
const accountBackupFilename = () => `shendu-${beijingFileStamp()}-${randomBytes(3).toString('hex')}.shendu`;
const json = (res, status, data, headers = {}) => {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
};
const error = (res, status, message, code = 'request_error') => json(res, status, { error: code, message });
const parseCookies = req => {
  const cookies=Object.create(null);
  for(const part of String(req.headers.cookie||'').split(';')){
    const index=part.indexOf('=');if(index<1)continue;
    try{cookies[decodeURIComponent(part.slice(0,index).trim())]=decodeURIComponent(part.slice(index+1).trim())}catch{}
  }
  return cookies;
};
const setSessionCookie = (res, token, maxAge = 2592000) => {
  const secure = COOKIE_SECURE ? '; Secure' : '';
  res.setHeader('Set-Cookie', `shendu_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
};
const readBody = (req, limit = 2 * 1024 * 1024) => new Promise((resolveBody, reject) => {
  const chunks = []; let size = 0, rejected=false;
  req.on('data', chunk => { size += chunk.length; if (size > limit) { if(!rejected){rejected=true;reject(Object.assign(new Error('请求内容过大'),{status:413,code:'payload_too_large'}))} } else if(!rejected)chunks.push(chunk); });
  req.on('end', () => {if(!rejected)resolveBody(Buffer.concat(chunks))});
  req.on('error', reject);
});
const readJson = async (req, limit) => {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(String(req.headers['content-type'] || ''))) {
    throw Object.assign(new Error('请求必须使用 application/json 格式'), { status: 415, code: 'unsupported_media_type' });
  }
  const raw = await readBody(req, limit);
  if(req.authUser&&sessionUser(req)?.id!==req.authUser.id)throw Object.assign(new Error('登录已失效，请重新登录'),{status:401,code:'unauthorized'});
  if (!raw.length) return {};
  let value;try { value=JSON.parse(raw.toString('utf8')); } catch { throw Object.assign(new Error('请求格式不正确'), { status: 400 }); }
  if(!value||typeof value!=='object'||Array.isArray(value))throw Object.assign(new Error('请求必须是 JSON 对象'),{status:400});
  return value;
};
const hashPassword = (password) => {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$32768$${salt.toString('base64')}$${hash.toString('base64')}`;
};
const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(32).toString('base64url'));
const verifyPassword = (password, stored) => {
  try {
    const [, n, salt64, hash64] = stored.split('$');
    const expected = Buffer.from(hash64, 'base64');
    const actual = scryptSync(password, Buffer.from(salt64, 'base64'), expected.length, { N: Number(n), r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return timingSafeEqual(expected, actual);
  } catch { return false; }
};
const requireMasterKey = () => {
  if (masterKey) return masterKey;
  throw Object.assign(new Error(masterKeyError || '服务器数据加密密钥暂不可用；上传个人加密备份恢复不受影响。'), { status: 503, code: 'data_key_unavailable' });
};
const encryptData = (value, scope) => encryptDataWithKey(value, requireMasterKey(), scope);
const decryptData = (value, scope) => {
  try { return decryptDataWithKey(value, requireMasterKey(), scope); }
  catch (error) {
    if (error?.code === 'data_key_unavailable') throw error;
    throw Object.assign(new Error('服务器无法解密现有数据，请恢复正确的 backup-master.key。'), { status: 503, code: 'data_key_mismatch' });
  }
};
const encryptSecret = (value) => {
  const key = requireMasterKey(); const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
};
const decryptSecret = (value) => {
  const key = requireMasterKey();
  try { return decryptSecretWithKey(value, key); }
  catch { throw Object.assign(new Error('服务器无法读取旧的备份配置，请恢复原 backup-master.key 或重新设置备份密码。'), { status: 503, code: 'backup_key_mismatch' }); }
};
const cleanUser = (u) => u && ({ id: u.id, username: u.username, displayName: u.display_name, role: u.role, status: u.status, createdAt: u.created_at });
const sessionUser = (req) => {
  const token = parseCookies(req).shendu_session;
  if (!token) return null;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const row = db.prepare(`SELECT u.*,s.expires_at,s.session_version AS sv FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(tokenHash);
  const expires=row?Date.parse(row.expires_at):NaN;
  if (!row || row.status !== 'active' || row.session_version !== row.sv || !Number.isFinite(expires) || expires <= Date.now()) return null;
  return row;
};
const requireUser = (req, res) => { const u = sessionUser(req); if (!u) error(res, 401, '登录已失效，请重新登录', 'unauthorized'); return u; };
const createSession = (res, user) => {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const expires = new Date(Date.now() + 30 * 86400000).toISOString();
  db.prepare(`INSERT INTO sessions(token_hash,user_id,session_version,expires_at,created_at) VALUES(?,?,?,?,?)`).run(tokenHash, user.id, user.session_version, expires, now());
  db.prepare(`DELETE FROM sessions WHERE user_id=? AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 20)`).run(user.id,user.id);
  setSessionCookie(res, token);
};
const checkPasswordShape = p => typeof p === 'string' && p.length >= 15 && p.length <= 128;
const checkUsername = s => typeof s === 'string' && /^[\p{L}\p{N}_.-]{3,32}$/u.test(s);
const setting = (userId, key, fallback = null) => {
  const row = db.prepare(`SELECT value FROM user_settings WHERE user_id=? AND key=?`).get(userId, key);
  if (!row) return fallback;
  if (key !== 'backup_secret' && isEncryptedData(row.value)) return decryptData(row.value, dataScope('setting', userId, key));
  try { return JSON.parse(row.value); } catch { return fallback; }
};
const putSetting = (userId, key, value) => {
  const stored = key === 'backup_secret' ? JSON.stringify(value) : encryptData(value, dataScope('setting', userId, key));
  return db.prepare(`INSERT INTO user_settings(user_id,key,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(userId, key, stored, now());
};
const REVIEW_TEMPLATE_DEFAULTS = {
  daily:{today:'今天，哪件事最值得记下来？',cause:'是什么让它发生？',actionTitle:'明天最重要的一件事',obstacleTitle:'如果遇到阻碍，那么我就……',verifyDateTitle:'预期何时验证？'},
  weekly:{plan:'这周原本要完成什么？实际呢？',progress:'本周最有价值的三个进展',patterns:'反复出现的成功条件与阻碍',keepStop:'下周保留一件事，停止一件事',nextThree:'下周最重要的三件事',actionTitle:'接下来，具体要做什么？',obstacleTitle:'如果遇到阻碍，那么我就……',verifyDateTitle:'预期什么时候验证？'},
  monthly:{goalResult:'月初的目标与现在的结果',change:'哪个变化真正改善了生活？',want:'这些目标，仍然是我想要的吗？',bottleneck:'下个月只主攻哪一个瓶颈？',experiment:'一个小实验：假设、做法、成功标准',actionTitle:'接下来，具体要做什么？',obstacleTitle:'如果遇到阻碍，那么我就……',verifyDateTitle:'预期什么时候验证？'},
  quarterly:{hope:'这一阶段原本希望生活发生什么变化？',evidence:'90 天后，哪些变化有证据？',worth:'目标值得继续吗？付出的代价能接受吗？',choices:'继续、调整、停止：分别是什么？',nextGoals:'下一阶段最多三个目标',actionTitle:'接下来，具体要做什么？',obstacleTitle:'如果遇到阻碍，那么我就……',verifyDateTitle:'预期什么时候验证？'},
  yearly:{coordinates:'用五件事，留下这一年的坐标',expectations:'年初的期待，哪些成为了现实？',areas:'人生几个重要领域，分别发生了什么？',decisions:'最重要的决定，现在怎么看？',keepRelease:'我想保留什么，又该放下什么？',nextYear:'明年的主题与最多三个目标',actionTitle:'接下来，具体要做什么？',obstacleTitle:'如果遇到阻碍，那么我就……',verifyDateTitle:'预期什么时候验证？'},
  decision:{recordTitle:'决定的名字',decision:'我正在做什么决定？为什么现在要做？',options:'有哪些选项？包括维持现状',facts:'我现在掌握哪些事实？哪些仍未知？',expectation:'预期结果、概率与出现的时间',failure:'如果决定失败，最可能因为什么？',choice:'最终选择与理由',firstStep:'决定后的第一步行动',actionTitle:'接下来，具体要做什么？',obstacleTitle:'如果遇到阻碍，那么我就……',verifyDateTitle:'预期什么时候验证？'}
};
const ACTION_TEMPLATE_DEFAULTS = {
  pageTitle:'行动验证',pageIntro:'预期验证日期和实际提交时间会同时保留，提前、按期或延后完成一眼可见。',historyButton:'查看全部历史',
  pendingTitle:'等待验证',pendingIntro:'按预期日期排列，实际验证时间将在提交时自动记录。',pendingEmptyTitle:'没有等待验证的行动',pendingEmptyText:'完成一份复盘后，约定的行动会出现在这里。',
  verifiedTitle:'已经验证',verifiedIntro:'保留预期与实际时间，便于以后判断是否提前完成。',verifiedEmptyTitle:'还没有已验证行动',verifiedEmptyText:'提交第一条验证结果后会显示在这里。',
  waitingStatus:'等待验证',overdueStatus:'已过约定日期',todayStatus:'今天验证',verifiedStatus:'已验证',countUnit:'项',earlyTimingText:'提前 {days} 天完成',lateTimingText:'晚于预期 {days} 天完成',onTimeText:'按预期日期完成',
  expectedDateLabel:'预期验证日期',actualDateLabel:'实际验证时间',expectedMissingText:'未设置',actualMissingText:'尚未验证',
  agreementEyebrow:'行动约定',agreementTitle:'复盘时锁定的计划',agreementNote:'原始记录',originalActionTitle:'原定行动',planTitle:'如果—那么预案',
  reviewEyebrow:'验证回看',reviewTitle:'实际结果与后续调整',reviewNote:'已永久锁定',resultTitle:'实际结果',adjustmentTitle:'保留或调整',
  ifLabel:'如果',thenLabel:'那么',responseLabel:'应对',missingActionText:'未填写行动',missingPlanText:'未填写预案',missingResponseText:'未填写应对动作',missingResultText:'未填写',
  submitActionButton:'提交验证结果',decisionActionButton:'进入结果后回看',viewRecordButton:'查看原复盘与验证结果',
  modalTitle:'提交行动验证',decisionModalTitle:'结果后回看',modalIntro:'提交后，验证结果与实际提交时间都会永久锁定。',originalActionLabel:'原定行动',actualAutoText:'提交时自动记录（北京时间）',
  resultPrompt:'实际发生了什么？与预期差在哪里？',outcomePrompt:'结果如何？',processPrompt:'当时的决策过程？',adjustmentPrompt:'我会保留、修正什么判断？',cancelButton:'取消',submitButton:'提交并锁定结果',
  decisionOutcomeLabel:'结果',decisionProcessLabel:'过程',lockedTitle:'行动验证结果',lockedIntro:'结果、预期日期与实际提交时间均已锁定。',
  lockedPendingTitle:'结果还没有验证',lockedPendingIntro:'无需等到当天；提前完成也可以直接提交，系统会记录实际验证时间。',lockedPendingButton:'填写行动验证'
};
const freshReviewTemplates = () => Object.fromEntries(Object.entries(REVIEW_TEMPLATE_DEFAULTS).map(([type,template])=>[type,{...template}]));
const defaultStage = () => ({
  name: '稳住底盘', focus: '建立稳定的身体、行动与财务节奏', startDate: todayDate(), days: 90,
  sleepTarget: 7, energyTarget: 70, showQuarter: false,
  metrics: [
    { name: '健身与身体执行', target: '训练日完成计划；休息日安排恢复' },
    { name: '收入能力行动', target: '专注 60 分钟，形成一个具体输出' },
    { name: '财务秩序', target: '完成记账；不新增非必要债务' }
  ],
  reviewTemplates: freshReviewTemplates(), actionTemplate: {...ACTION_TEMPLATE_DEFAULTS}
});
const defaultTheme = () => ({ preset: '潮汐青', primary: '#176B67', secondary: '#A86436', tertiary: '#536C9C', reduceMotion: false });
const normalizeTheme = value => {
  const defaults=defaultTheme(),source=isPlainObject(value)?value:{},color=(key)=>/^#[0-9a-f]{6}$/i.test(String(source[key]||''))?String(source[key]).toUpperCase():defaults[key];
  return {preset:templateText(source.preset,defaults.preset,40),primary:color('primary'),secondary:color('secondary'),tertiary:color('tertiary'),reduceMotion:source.reduceMotion===true};
};
const recordOut = r => {
  const titleScope=dataScope('record',r.user_id,r.id,'title'),dataValueScope=dataScope('record',r.user_id,r.id,'data'),verificationScope=dataScope('record',r.user_id,r.id,'verification');
  const title=isEncryptedData(r.title)?decryptData(r.title,titleScope):r.title;
  const data=isEncryptedData(r.data)?decryptData(r.data,dataValueScope):JSON.parse(r.data||'{}');
  const verification=!r.verification?null:isEncryptedData(r.verification)?decryptData(r.verification,verificationScope):JSON.parse(r.verification);
  return { ...r, title, data, verification, version: Number(r.version) };
};
const safeText = (v, max = 6000) => typeof v === 'string' ? v.slice(0, max) : '';
const MAX_USERS=10000;
const MAX_RECORDS_PER_USER=10000;
const MAX_RECORD_DATA_BYTES=1024*1024;
const MAX_ACCOUNT_CONTENT_BYTES=32*1024*1024;
const accountRecordBytes = userId => db.prepare(`SELECT COALESCE(SUM(length(CAST(title AS BLOB))+length(CAST(data AS BLOB))+COALESCE(length(CAST(verification AS BLOB)),0)),0) AS n FROM records WHERE user_id=?`).get(userId).n;
const recordStoredBytes = record => record ? Buffer.byteLength(record.title||'')+Buffer.byteLength(record.data||'')+Buffer.byteLength(record.verification||'') : 0;
const validRecordType = t => ['daily','weekly','monthly','quarterly','yearly','decision'].includes(t);
const isPlainObject = value => Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const templateText = (value,fallback,max=240) => safeText(value,max).trim()||fallback;
const normalizeReviewTemplate = (type,value) => {
  const defaults=REVIEW_TEMPLATE_DEFAULTS[type],source=isPlainObject(value)?value:{};
  return Object.fromEntries(Object.entries(defaults).map(([key,fallback])=>[key,templateText(source[key],fallback,160)]));
};
const normalizeReviewTemplates = value => Object.fromEntries(Object.keys(REVIEW_TEMPLATE_DEFAULTS).map(type=>[type,normalizeReviewTemplate(type,isPlainObject(value)?value[type]:null)]));
const normalizeActionTemplate = value => {
  const source=isPlainObject(value)?value:{};
  return Object.fromEntries(Object.entries(ACTION_TEMPLATE_DEFAULTS).map(([key,fallback])=>[key,templateText(source[key],fallback,240)]));
};
const normalizeStage = value => {
  const defaults=defaultStage(),source=isPlainObject(value)?value:{},days=Number(source.days),sleep=Number(source.sleepTarget),energy=Number(source.energyTarget),metrics=Array.isArray(source.metrics)&&source.metrics.length===3?source.metrics:defaults.metrics;
  return {
    name:templateText(source.name,defaults.name,50),focus:templateText(source.focus,defaults.focus,300),
    startDate:validIsoDate(String(source.startDate||''))?source.startDate:defaults.startDate,
    days:Number.isFinite(days)?Math.min(366,Math.max(7,Math.round(days))):defaults.days,
    sleepTarget:Number.isFinite(sleep)?Math.min(24,Math.max(0,sleep)):defaults.sleepTarget,
    energyTarget:Number.isFinite(energy)?Math.min(100,Math.max(0,energy)):defaults.energyTarget,
    showQuarter:source.showQuarter===true,
    metrics:metrics.map((metric,index)=>({name:templateText(metric?.name,defaults.metrics[index].name,80),target:templateText(metric?.target,defaults.metrics[index].target,240)})),
    reviewTemplates:normalizeReviewTemplates(source.reviewTemplates),actionTemplate:normalizeActionTemplate(source.actionTemplate)
  };
};
const normalizeTemplateSnapshot = (value,type) => {
  if(!validRecordType(type)||!isPlainObject(value)||!isPlainObject(value.review)||!isPlainObject(value.action))return null;
  return {version:1,review:normalizeReviewTemplate(type,value.review),action:normalizeActionTemplate(value.action)};
};
const validIsoDate = value => {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(value||'')))return false;
  const date=new Date(`${value}T00:00:00Z`);return Number.isFinite(date.valueOf())&&date.toISOString().slice(0,10)===value;
};
const validEntityId = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value||''));
const validRecordPeriod = (type,value) => {
  const period=String(value||'');
  if(type==='weekly')return /^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(period);
  if(type==='monthly')return /^\d{4}-(?:0[1-9]|1[0-2])$/.test(period);
  if(type==='yearly')return /^\d{4}$/.test(period);
  return validIsoDate(period);
};

function migrateSensitiveData() {
  if (!masterKey) return;
  const records=db.prepare(`SELECT id,user_id,title,data,verification FROM records`).all();
  const settings=db.prepare(`SELECT user_id,key,value FROM user_settings WHERE key!='backup_secret'`).all();
  let migrated=false;
  db.exec('BEGIN IMMEDIATE');
  try {
    const updateRecord=db.prepare(`UPDATE records SET title=?,data=?,verification=? WHERE id=?`);
    for (const row of records) {
      const title=isEncryptedData(row.title)?row.title:encryptData(safeText(row.title,200),dataScope('record',row.user_id,row.id,'title'));
      const data=isEncryptedData(row.data)?row.data:encryptData(JSON.parse(row.data||'{}'),dataScope('record',row.user_id,row.id,'data'));
      const verification=!row.verification?null:isEncryptedData(row.verification)?row.verification:encryptData(JSON.parse(row.verification),dataScope('record',row.user_id,row.id,'verification'));
      if(title!==row.title||data!==row.data||verification!==row.verification){updateRecord.run(title,data,verification,row.id);migrated=true}
    }
    const updateSetting=db.prepare(`UPDATE user_settings SET value=? WHERE user_id=? AND key=?`);
    for (const row of settings) {
      if(isEncryptedData(row.value))continue;
      updateSetting.run(encryptData(JSON.parse(row.value),dataScope('setting',row.user_id,row.key)),row.user_id,row.key);migrated=true;
    }
    db.prepare(`INSERT INTO schema_meta(key,value) VALUES('schema_version','6') ON CONFLICT(key) DO UPDATE SET value='6'`).run();
    db.prepare(`INSERT INTO schema_meta(key,value) VALUES('data_encryption','AES-256-GCM') ON CONFLICT(key) DO UPDATE SET value='AES-256-GCM'`).run();
    db.exec('COMMIT');
    if(migrated){db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.exec('VACUUM');db.exec('PRAGMA wal_checkpoint(TRUNCATE)');try{chmodSync(DATABASE_PATH,0o600)}catch{}}
  } catch (error) {
    try{db.exec('ROLLBACK')}catch{}
    throw new Error(`敏感数据加密迁移失败：${error.message}`);
  }
}
migrateSensitiveData();

const rateMap = new Map();
const clientAddress = req => {
  const forwarded=String(req.headers['x-forwarded-for']||'').split(',').map(value=>value.trim()).filter(Boolean);
  const candidate=forwarded.at(-1)||String(req.socket.remoteAddress||'').replace(/^::ffff:/,'');
  return net.isIP(candidate)?candidate:'unknown';
};
const limited = (req, bucket, max, windowMs) => {
  const key = `${bucket}:${clientAddress(req)}`; const t = Date.now(); let x = rateMap.get(key);
  if (!x || x.until < t) x = { count: 0, until: t + windowMs };
  x.count += 1; rateMap.set(key, x);
  if(rateMap.size>10000){for(const [entryKey,entry] of rateMap)if(entry.until<t)rateMap.delete(entryKey);while(rateMap.size>8000)rateMap.delete(rateMap.keys().next().value)}
  return x.count > max;
};

function exportPayload(userId) {
  db.exec('BEGIN');
  try{
    const user=db.prepare(`SELECT username,display_name FROM users WHERE id=?`).get(userId);
    if(!user)throw new Error('账户不存在');
    const records=db.prepare(`SELECT * FROM records WHERE user_id=? ORDER BY updated_at`).all(userId).map(recordOut);
    const payload={profile:{username:user.username,displayName:user.display_name},records,stage:normalizeStage(setting(userId,'stage',defaultStage())),theme:normalizeTheme(setting(userId,'theme',defaultTheme())),exportedAt:now()};
    db.exec('COMMIT');return payload;
  }catch(error){try{db.exec('ROLLBACK')}catch{}throw error}
}

function createBackupBuffer(userId, password) {
  const payload = exportPayload(userId);
  const entries = [
    { kind: 'profile', value: payload.profile }, { kind: 'stage', value: payload.stage },
    { kind: 'theme', value: payload.theme }, ...payload.records.map(value => ({ kind: 'record', value }))
  ];
  const salt=randomBytes(16),iv=randomBytes(12),key=pbkdf2Sync(password,salt,600000,32,'sha256');
  const header={format:'shendu-v4',version:4,kind:'account',kdf:{name:'PBKDF2-HMAC-SHA-256',iterations:600000,salt:salt.toString('base64')},cipher:{name:'AES-256-GCM',iv:iv.toString('base64')},compression:'gzip'};
  const clear=gzipSync(Buffer.from(JSON.stringify({format:'shendu-account-data',version:4,owner:payload.profile,exportedAt:payload.exportedAt,entries})),{level:9});
  const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(JSON.stringify(header)));
  const encrypted=Buffer.concat([cipher.update(clear),cipher.final()]);
  return Buffer.from(JSON.stringify({...header,tag:cipher.getAuthTag().toString('base64'),data:encrypted.toString('base64')}));
}

const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
function isoWeek(dateValue) {
  const x = new Date(`${dateValue}T12:00:00Z`); const day=x.getUTCDay()||7; x.setUTCDate(x.getUTCDate()+4-day);
  const first=new Date(Date.UTC(x.getUTCFullYear(),0,1)); return `${x.getUTCFullYear()}-W${String(Math.ceil((((x-first)/86400000)+1)/7)).padStart(2,'0')}`;
}
function legacyPeriod(type, period) {
  if (type === 'weekly' && /^\d{4}-\d{2}-\d{2}$/.test(period || '')) return isoWeek(period);
  if (type === 'monthly' && /^\d{4}-\d{2}/.test(period || '')) return period.slice(0,7);
  if (type === 'yearly' && /^\d{4}/.test(period || '')) return period.slice(0,4);
  return period;
}
function legacyReviewToRecord(review) {
  if (!review || !validRecordType(review.type) || typeof review.period !== 'string') throw new Error('旧备份包含无法识别的复盘记录');
  const source=review.data&&typeof review.data==='object'&&!Array.isArray(review.data)?review.data:{};
  const aliases={
    daily:{fact:'today',cause:'cause'}, weekly:{expected:'plan',fact:'progress',pattern:'patterns',stop:'keepStop',priorities:'nextThree'},
    monthly:{expected:'goalResult',fact:'change',ownership:'want',bottleneck:'bottleneck',experiment:'experiment'},
    quarterly:{expected:'hope',fact:'evidence',ownership:'worth',direction:'choices',priorities:'nextGoals'},
    yearly:{fact:'coordinates',expected:'expectations',balance:'areas',decisions:'decisions',ownership:'keepRelease',priorities:'nextYear'},
    decision:{expected:'decision',options:'options',fact:'facts',prediction:'expectation',risk:'failure',choice:'choice'}
  }[review.type]||{};
  const answers={};
  for (const [oldKey,newKey] of Object.entries(aliases)) {
    const values=[]; if(typeof source[oldKey]==='string')values.push(source[oldKey]);
    try { const extra=JSON.parse(source[`entries:${oldKey}`]||'[]'); if(Array.isArray(extra))values.push(...extra.filter(x=>typeof x==='string')); } catch {}
    if(values.length)answers[newKey]=values.slice(0,5);
  }
  if(review.type==='decision'&&source.firstStep&&!answers.firstStep)answers.firstStep=[String(source.firstStep)];
  const statusMap={done:'已达标',partial:'部分达标',missed:'未达标',rest:'计划休息'};
  const metrics=[0,1,2].map(i=>({name:String(source[`metricName${i}`]||`指标 ${i+1}`),target:String(source[`metricTarget${i}`]||''),action:String(source[`metric${i}`]||''),status:statusMap[source[`metricStatus${i}`]]||String(source[`metricStatus${i}`]||'')}));
  const verified=review.verified===true, stamp=validTime(review.updatedAt)?new Date(review.updatedAt).toISOString():now();
  return {id:safeText(review.id,100)||randomUUID(),type:review.type,period:legacyPeriod(review.type,review.period),title:safeText(review.title,200),status:verified?'verified':review.status==='completed'?'completed':'draft',version:Math.max(1,Number(review.revision)||1),created_at:stamp,updated_at:stamp,completed_at:review.status==='completed'?stamp:null,verified_at:verified?stamp:null,verification:verified?{result:safeText(source.outcome,6000),adjustment:safeText(source.lesson,6000),outcome:source.resultQuality==='good'?'好':source.resultQuality==='poor'?'差':null,process:source.processQuality==='good'?'好':source.processQuality==='poor'?'差':null}:null,data:{answers,action:String(source.action||''),ifThen:String(source.ifThen||''),verifyDate:String(review.verificationDate||''),journal:String(source.journal||''),sleep:String(source.sleep||''),energy:String(source.energy||''),risk:String(source.risk||''),metrics}};
}
function legacySettingsEntries(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return [];
  const sleep=Number.parseFloat(settings.sleep), energy=Number.parseFloat(settings.energy);
  return [{kind:'stage',value:{name:safeText(settings.stage||'稳住底盘',50),focus:safeText(settings.focus||'建立稳定的身体、行动与财务节奏',300),startDate:/^\d{4}-\d{2}-\d{2}$/.test(settings.start||'')?settings.start:todayDate(),days:Math.min(366,Math.max(7,Number(settings.days)||90)),sleepTarget:Number.isFinite(sleep)?sleep:7,energyTarget:Number.isFinite(energy)?energy:70,metrics:Array.isArray(settings.metrics)&&settings.metrics.length===3?settings.metrics.map(x=>({name:safeText(x.name,40),target:safeText(x.target,200)})):defaultStage().metrics,showQuarter:settings.showQuarterly===true}}];
}
function openLegacyCredential(stored, key, scope) {
  const parts=String(stored||'').split('.'); if(parts.length!==4||parts[0]!=='v1')throw new Error('旧备份加密条目无效');
  try { const iv=Buffer.from(parts[1],'base64url'),tag=Buffer.from(parts[2],'base64url'),ciphertext=Buffer.from(parts[3],'base64url'); const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(Buffer.from(`shendu:backup-credential:v1:${scope}`));decipher.setAuthTag(tag);return JSON.parse(Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString('utf8')); } catch { throw new Error('备份密码错误，或文件已经损坏'); }
}
function parseLegacyStream(lines,password) {
  let header; try{header=JSON.parse(lines[0])}catch{throw new Error('旧备份文件头无效')}
  if(header.format!=='shendu-stream-v2'||header.kind!=='account'||header.iterations!==600000||!/^[a-f0-9]{32}$/i.test(header.salt||''))throw new Error('不支持的备份格式');
  const key=pbkdf2Sync(password,Buffer.from(header.salt,'hex'),600000,32,'sha256'),scope=createHash('sha256').update(lines[0]).digest('hex');
  let metadata=null,ended=false,total=0;const records=[];
  for(let i=1;i<lines.length;i+=1){if(!lines[i])continue;if(ended)throw new Error('备份结束后出现额外数据');const value=openLegacyCredential(lines[i],key,`${scope}:${i-1}`);if(i===1&&value.kind==='metadata')metadata=value;else if(value.kind==='review'){records.push(legacyReviewToRecord(value.review));total+=1}else if(value.kind==='end'&&value.total===total)ended=true;else throw new Error('备份条目或数量校验失败')}
  if(!metadata||!ended)throw new Error('备份被截断或缺少结束校验');const entries=[{kind:'profile',value:metadata.source||{}},...legacySettingsEntries(metadata.settings),...records.map(value=>({kind:'record',value}))];return{header:{format:'shendu-stream-v2',exportedAt:metadata.exportedAt||'',count:entries.length},entries};
}
function parseLegacyEnvelope(buffer,password) {
  let envelope;try{envelope=JSON.parse(buffer.toString('utf8'))}catch{throw new Error('这不是有效的慎独加密备份文件')}
  if(envelope?.format!=='shendu-encrypted-backup'||envelope.version!==1||envelope.kind!=='account')throw new Error('不支持的备份格式');
  if(envelope.kdf?.iterations!==600000||typeof envelope.kdf?.salt!=='string'||envelope.kdf.salt.length>128||typeof envelope.cipher?.iv!=='string'||envelope.cipher.iv.length>128)throw new Error('旧备份密钥参数不正确');
  const header={format:envelope.format,version:envelope.version,kind:envelope.kind,createdAt:envelope.createdAt,kdf:envelope.kdf,cipher:envelope.cipher,payloadBytes:envelope.payloadBytes,...(typeof envelope.label==='string'?{label:envelope.label}:{})};
  try { const key=pbkdf2Sync(password,Buffer.from(envelope.kdf.salt,'base64url'),envelope.kdf.iterations,32,'sha256'),decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.cipher.iv,'base64url'));decipher.setAAD(Buffer.from(JSON.stringify(header)));decipher.setAuthTag(Buffer.from(envelope.tag,'base64url'));const payload=JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64url')),decipher.final()]).toString('utf8'));if(payload.format!=='shendu-user-backup'||payload.version!==1||!Array.isArray(payload.reviews))throw new Error('旧备份内容格式无效');const entries=[{kind:'profile',value:payload.source||{}},...legacySettingsEntries(payload.settings),...payload.reviews.map(value=>({kind:'record',value:legacyReviewToRecord(value)}))];return{header:{format:'shendu-encrypted-backup',exportedAt:payload.exportedAt||envelope.createdAt||'',count:entries.length},entries}; } catch(e){if(e.message==='旧备份内容格式无效')throw e;throw new Error('备份密码错误，或文件已经损坏')}
}
function parseCurrentEnvelope(envelope,password) {
  const isV3=envelope?.format==='shendu-v3'&&envelope.version===3;
  const isV4=envelope?.format==='shendu-v4'&&envelope.version===4&&envelope.kind==='account';
  if((!isV3&&!isV4)||envelope.kdf?.name!=='PBKDF2-HMAC-SHA-256'||envelope.kdf?.iterations!==600000||envelope.cipher?.name!=='AES-256-GCM'||envelope.compression!=='gzip')throw new Error('不支持的备份格式');
  if(!validBackupCipherFields(envelope))throw new Error('备份加密参数不正确');
  const header=isV4?{format:'shendu-v4',version:4,kind:'account',kdf:envelope.kdf,cipher:envelope.cipher,compression:'gzip'}:{format:'shendu-v3',version:3,kdf:envelope.kdf,cipher:envelope.cipher,compression:'gzip'};
  try {
    const key=pbkdf2Sync(password,Buffer.from(envelope.kdf.salt,'base64'),600000,32,'sha256'),decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.cipher.iv,'base64'));
    decipher.setAAD(Buffer.from(JSON.stringify(header)));decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
    const compressed=Buffer.concat([decipher.update(Buffer.from(envelope.data,'base64')),decipher.final()]);
    const payload=JSON.parse(gunzipSync(compressed,{maxOutputLength:MAX_BACKUP_REQUEST_BYTES}).toString('utf8'));
    if(payload?.format!=='shendu-account-data'||payload.version!==(isV4?4:3)||!Array.isArray(payload.entries))throw new Error('备份内容格式无效');
    if(isV4&&!checkUsername(payload.owner?.username))throw new Error('备份缺少有效的账户归属信息');
    return{header:{format:header.format,exportedAt:payload.exportedAt||'',count:payload.entries.length},owner:payload.owner||null,entries:payload.entries};
  } catch(error) {
    if(['备份内容格式无效','备份缺少有效的账户归属信息'].includes(error.message))throw error;
    throw new Error('备份密码错误，或文件已经损坏');
  }
}
function parseBackupBuffer(buffer, password) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || '');
  if (buffer.length > MAX_BACKUP_FILE_BYTES) throw new Error('备份文件超过 36 MB，无法导入');
  const raw=buffer.toString('utf8').trim(), lines=raw.split('\n');
  if(!raw)throw new Error('备份文件为空');
  let first;try{first=JSON.parse(lines[0])}catch{throw new Error('备份文件头无效')}
  if(first.format==='shendu-v4'||first.format==='shendu-v3')return parseCurrentEnvelope(first,password);
  if(first.format==='shendu-stream-v2')return parseLegacyStream(lines,password);
  if(first.format==='shendu-encrypted-backup')return parseLegacyEnvelope(buffer,password);
  if (lines.length < 3) throw new Error('备份文件不完整');
  const header = first;
  if (header.format !== 'shendu-v2' || header.iterations !== 600000) throw new Error('不支持的备份格式');
  const footer = JSON.parse(lines.at(-1));
  if (!footer.end || footer.count !== header.count || lines.length !== header.count + 2) throw new Error('备份条目缺失或顺序异常');
  const keyMaterial = pbkdf2Sync(password, Buffer.from(header.salt, 'base64'), 600000, 64, 'sha256');
  const expected = createHmac('sha256', keyMaterial.subarray(32)).update(lines.slice(0,-1).join('\n')).digest();
  const received = Buffer.from(footer.mac, 'base64');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new Error('密码错误或备份已被篡改');
  const entries = [];
  for (let i = 1; i < lines.length - 1; i += 1) {
    const x = JSON.parse(lines[i]); if (x.seq !== i - 1) throw new Error('备份条目顺序异常');
    const decipher = createDecipheriv('aes-256-gcm', keyMaterial.subarray(0,32), Buffer.from(x.iv,'base64'));
    decipher.setAAD(Buffer.from(`shendu-v2|${x.seq}|${header.count}`)); decipher.setAuthTag(Buffer.from(x.tag,'base64'));
    entries.push(JSON.parse(Buffer.concat([decipher.update(Buffer.from(x.data,'base64')), decipher.final()]).toString('utf8')));
  }
  return { header, entries };
}

const MAX_BACKUP_FILE_BYTES = 36 * 1024 * 1024;
const MAX_BACKUP_REQUEST_BYTES = 48 * 1024 * 1024;
function validBackupCipherFields(envelope) {
  const valid=(value,length)=>typeof value==='string'&&value.length<=64&&/^[A-Za-z0-9+/]+={0,2}$/.test(value)&&Buffer.from(value,'base64').length===length;
  return valid(envelope.kdf?.salt,16)&&valid(envelope.cipher?.iv,12)&&valid(envelope.tag,16)&&typeof envelope.data==='string';
}
function backupPasswordFrom(value) {
  const password = typeof value === 'string' ? value : '';
  if (!password || password.length > 256) throw new Error('请输入生成这份备份时使用的密码');
  return password;
}
function backupTextFrom(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请选择完整的 .shendu 加密备份文件');
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length > MAX_BACKUP_FILE_BYTES) throw new Error('备份文件超过 36 MB，无法导入');
  return buffer;
}
function backupOwner(parsed) {
  const profile=parsed.owner||parsed.entries.find(entry=>entry?.kind==='profile')?.value||null;
  const username=typeof profile?.username==='string'?profile.username.trim():'';
  return {username,displayName:typeof profile?.displayName==='string'?profile.displayName.trim():''};
}
function backupOwnerMatches(username,ownerUsername) {
  return Boolean(username&&ownerUsername&&username.localeCompare(ownerUsername,undefined,{sensitivity:'accent'})===0);
}
function assertBackupOwner(user,parsed,sourceUsername='') {
  const owner=backupOwner(parsed);
  if(!checkUsername(owner.username))throw Object.assign(new Error('这份备份没有可验证的所属用户名，无法恢复。请先在原账户恢复后重新导出新版备份。'),{status:400,code:'backup_owner_missing'});
  if(backupOwnerMatches(user.username,owner.username))return {owner,crossAccount:false};
  if(!backupOwnerMatches(String(sourceUsername||'').trim(),owner.username))throw Object.assign(new Error('这份备份属于其他账户，请准确输入备份所属用户名和生成时使用的备份密码。'),{status:403,code:'backup_owner_confirmation_required'});
  return {owner,crossAccount:true};
}
function backupPreview(parsed,currentUser=null) {
  const counts = parsed.entries.reduce((result, entry) => {
    result[entry.kind] = (result[entry.kind] || 0) + 1;
    return result;
  }, {});
  const owner=backupOwner(parsed);
  return {
    exportedAt: parsed.header.exportedAt || parsed.header.createdAt || '',
    count: parsed.entries.length,
    total: counts.record || 0,
    counts,
    settings: Boolean(counts.stage || counts.theme),
    ownerUsername: owner.username,
    ownerDisplayName: owner.displayName,
    ownerMatches:currentUser?backupOwnerMatches(currentUser.username,owner.username):null,
    requiresOwnerConfirmation:currentUser?!backupOwnerMatches(currentUser.username,owner.username):false
  };
}

function getBackupPassword(userId) {
  const wrapped = setting(userId, 'backup_secret');
  if (!wrapped) return null;
  return decryptSecret(wrapped).password;
}

function getBackupStatus(userId) {
  const wrapped = setting(userId, 'backup_secret');
  if (!wrapped) return { configured: false, available: Boolean(masterKey), error: masterKeyError };
  if (!masterKey) return { configured: false, available: false, error: masterKeyError || '服务器内部备份密钥暂不可用。' };
  try {
    return { configured: Boolean(decryptSecret(wrapped)?.password), available: true, error: masterKeyError };
  } catch {
    return { configured: false, available: true, error: '原备份密码配置无法读取，可重新设置；已有 .shendu 文件仍可用原密码直接恢复。' };
  }
}

function normalizeImportedRecord(value) {
  if(!isPlainObject(value)||!validRecordType(value.type)||!validRecordPeriod(value.type,value.period)||!isPlainObject(value.data))return null;
  if(Buffer.byteLength(JSON.stringify(value.data))>MAX_RECORD_DATA_BYTES)return null;
  const updatedAt=validTime(value.updated_at)?new Date(value.updated_at).toISOString():now();
  const createdAt=validTime(value.created_at)?new Date(value.created_at).toISOString():updatedAt;
  const verification=isPlainObject(value.verification)?value.verification:null;
  let status=['draft','completed','verified'].includes(value.status)?value.status:'draft';
  if(status==='verified'&&!verification)status='completed';
  return {
    id:validEntityId(value.id)?value.id:randomUUID(),type:value.type,period:String(value.period),title:safeText(value.title,200),data:value.data,
    status,version:Math.max(1,Math.min(1000000,Number(value.version)||1)),verification,created_at:createdAt,updated_at:updatedAt,
    completed_at:validTime(value.completed_at)?new Date(value.completed_at).toISOString():null,
    verified_at:status==='verified'&&validTime(value.verified_at)?new Date(value.verified_at).toISOString():null
  };
}

function applyBackup(userId, parsed, mode) {
  if(!Array.isArray(parsed.entries)||parsed.entries.length>MAX_RECORDS_PER_USER+10)throw new Error('备份条目数量不正确');
  const recordEntries=parsed.entries.filter(x=>x?.kind==='record'),records=recordEntries.map(x=>normalizeImportedRecord(x.value));
  if(recordEntries.length>MAX_RECORDS_PER_USER)throw new Error(`单个账户最多恢复 ${MAX_RECORDS_PER_USER} 条复盘记录`);
  if(records.some(record=>!record))throw new Error('备份中包含无效的复盘记录');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (mode === 'replace') {
      db.prepare(`DELETE FROM records WHERE user_id=?`).run(userId);
      db.prepare(`DELETE FROM user_settings WHERE user_id=? AND key IN ('stage','theme')`).run(userId);
    }
    for (const rec of records) {
      if (!validRecordType(rec.type)) continue;
      let recordId = rec.id;
      const natural = rec.type==='decision'?null:db.prepare(`SELECT id,updated_at FROM records WHERE user_id=? AND type=? AND period=?`).get(userId,rec.type,rec.period);
      if(natural)recordId=natural.id;
      const collision = db.prepare(`SELECT user_id FROM records WHERE id=?`).get(recordId);
      if (collision && collision.user_id !== userId) recordId = randomUUID();
      const existing = db.prepare(`SELECT updated_at FROM records WHERE id=? AND user_id=?`).get(recordId, userId);
      if (existing && Date.parse(existing.updated_at) >= Date.parse(rec.updated_at || 0)) continue;
      const title=encryptData(safeText(rec.title,200),dataScope('record',userId,recordId,'title'));
      const data=encryptData(rec.data||{},dataScope('record',userId,recordId,'data'));
      const verification=rec.verification?encryptData(rec.verification,dataScope('record',userId,recordId,'verification')):null;
      const status=rec.status,version=rec.version,updatedAt=rec.updated_at,createdAt=rec.created_at,completedAt=rec.completed_at,verifiedAt=rec.verified_at;
      if(existing)db.prepare(`UPDATE records SET type=?,period=?,title=?,data=?,status=?,version=?,verification=?,updated_at=?,completed_at=?,verified_at=? WHERE id=? AND user_id=?`).run(rec.type,rec.period,title,data,status,version,verification,updatedAt,completedAt,verifiedAt,recordId,userId);
      else db.prepare(`INSERT INTO records(id,user_id,type,period,title,data,status,version,verification,created_at,updated_at,completed_at,verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(recordId,userId,rec.type,rec.period,title,data,status,version,verification,createdAt,updatedAt,completedAt,verifiedAt);
    }
    for (const e of parsed.entries) {
      if (!['stage','theme'].includes(e?.kind)) continue;
      const exists=db.prepare(`SELECT 1 FROM user_settings WHERE user_id=? AND key=?`).get(userId,e.kind);
      if (mode==='replace'||!exists) putSetting(userId,e.kind,e.kind==='stage'?normalizeStage(e.value):normalizeTheme(e.value));
    }
    if(db.prepare(`SELECT COUNT(*) AS n FROM records WHERE user_id=?`).get(userId).n>MAX_RECORDS_PER_USER)throw new Error('恢复后的复盘记录数量超过账户上限');
    if(accountRecordBytes(userId)>MAX_ACCOUNT_CONTENT_BYTES)throw new Error('恢复后的复盘内容超过账户存储上限');
    db.exec('COMMIT');
    return records.length;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

const MAX_SITE_BACKUP_FILE_BYTES = 128 * 1024 * 1024;
const MAX_SITE_BACKUP_REQUEST_BYTES = 176 * 1024 * 1024;
function siteBackupPayload() {
  requireMasterKey();
  db.exec('BEGIN');
  try{
    const users=db.prepare(`SELECT id,username,display_name,password_hash,role,status,session_version,created_at FROM users ORDER BY created_at,id`).all();
    const settings=db.prepare(`SELECT user_id,key,value,updated_at FROM user_settings ORDER BY user_id,key`).all().map(row=>{
      if(row.key==='backup_secret'){
        const wrapped=setting(row.user_id,'backup_secret');
        return {user_id:row.user_id,key:row.key,value:wrapped?decryptSecret(wrapped):null,updated_at:row.updated_at};
      }
      return {user_id:row.user_id,key:row.key,value:setting(row.user_id,row.key),updated_at:row.updated_at};
    });
    const records=db.prepare(`SELECT * FROM records ORDER BY user_id,updated_at,id`).all().map(recordOut);
    const targets=db.prepare(`SELECT * FROM backup_targets ORDER BY user_id,created_at,id`).all().map(row=>({
      id:row.id,user_id:row.user_id,name:row.name,kind:row.kind,config:decryptSecret(row.encrypted_config),schedule:row.schedule,
      enabled:Number(row.enabled),last_run_at:row.last_run_at,last_success_at:row.last_success_at,last_error:row.last_error,created_at:row.created_at,updated_at:row.updated_at
    }));
    const runs=db.prepare(`SELECT id,target_id,user_id,status,message,created_at FROM backup_runs ORDER BY created_at,id`).all();
    const payload={
      format:'shendu-site-data',version:1,createdAt:now(),
      schemaVersion:Number(db.prepare(`SELECT value FROM schema_meta WHERE key='schema_version'`).get()?.value||6),
      publicRegistration:db.prepare(`SELECT value FROM schema_meta WHERE key='public_registration'`).get()?.value==='true',
      users,settings,records,targets,runs
    };
    db.exec('COMMIT');
    return payload;
  }catch(error){try{db.exec('ROLLBACK')}catch{}throw error}
}
function createSiteBackupBuffer(password) {
  const salt=randomBytes(16),iv=randomBytes(12),key=pbkdf2Sync(password,salt,600000,32,'sha256');
  const header={format:'shendu-site-v1',version:1,kind:'site',kdf:{name:'PBKDF2-HMAC-SHA-256',iterations:600000,salt:salt.toString('base64')},cipher:{name:'AES-256-GCM',iv:iv.toString('base64')},compression:'gzip'};
  const clear=gzipSync(Buffer.from(JSON.stringify(siteBackupPayload())),{level:9});
  const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(JSON.stringify(header)));
  const encrypted=Buffer.concat([cipher.update(clear),cipher.final()]);
  return Buffer.from(JSON.stringify({...header,tag:cipher.getAuthTag().toString('base64'),data:encrypted.toString('base64')}));
}
function siteBackupTextFrom(value) {
  if(typeof value!=='string'||!value.trim())throw new Error('请选择完整的 .shendu-site 整站加密备份文件');
  const buffer=Buffer.from(value,'utf8');
  if(buffer.length>MAX_SITE_BACKUP_FILE_BYTES)throw new Error('整站备份超过 128 MB，无法通过网页恢复');
  return buffer;
}
function parseSiteBackupBuffer(buffer,password) {
  if(!Buffer.isBuffer(buffer))buffer=Buffer.from(buffer||'');
  if(buffer.length>MAX_SITE_BACKUP_FILE_BYTES)throw new Error('整站备份超过 128 MB，无法通过网页恢复');
  let envelope;try{envelope=JSON.parse(buffer.toString('utf8'))}catch{throw new Error('这不是有效的慎独整站备份文件')}
  if(envelope?.format!=='shendu-site-v1'||envelope.version!==1||envelope.kind!=='site'||envelope.kdf?.name!=='PBKDF2-HMAC-SHA-256'||envelope.kdf?.iterations!==600000||envelope.cipher?.name!=='AES-256-GCM'||envelope.compression!=='gzip')throw new Error('不支持的整站备份格式');
  if(!validBackupCipherFields(envelope))throw new Error('整站备份加密参数不正确');
  const header={format:'shendu-site-v1',version:1,kind:'site',kdf:envelope.kdf,cipher:envelope.cipher,compression:'gzip'};
  try{
    const key=pbkdf2Sync(backupPasswordFrom(password),Buffer.from(envelope.kdf.salt,'base64'),600000,32,'sha256'),decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.cipher.iv,'base64'));
    decipher.setAAD(Buffer.from(JSON.stringify(header)));decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
    const compressed=Buffer.concat([decipher.update(Buffer.from(envelope.data,'base64')),decipher.final()]);
    const payload=JSON.parse(gunzipSync(compressed,{maxOutputLength:MAX_SITE_BACKUP_REQUEST_BYTES}).toString('utf8'));
    if(payload?.format!=='shendu-site-data'||payload.version!==1)throw new Error('整站备份内容格式无效');
    validateSiteBackupPayload(payload);
    return payload;
  }catch(error){
    if(['整站备份内容格式无效','整站备份数据结构无效','整站备份必须包含且只能包含一个超级管理员账户'].includes(error.message)||error.message.startsWith('整站备份中的'))throw error;
    throw new Error('整站备份密码错误，或文件已经损坏');
  }
}
function validPasswordHash(value) {
  const parts=String(value||'').split('$');if(parts.length!==4||parts[0]!=='scrypt')return false;
  const cost=Number(parts[1]);if(![16384,32768].includes(cost))return false;
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(parts[2])||!/^[A-Za-z0-9+/]+={0,2}$/.test(parts[3]))return false;
  try{return Buffer.from(parts[2],'base64').length===16&&Buffer.from(parts[3],'base64').length===64}catch{return false}
}
function validateSiteBackupPayload(payload) {
  const groups=['users','settings','records','targets','runs'];
  if(groups.some(key=>!Array.isArray(payload[key])))throw new Error('整站备份数据结构无效');
  if(!payload.users.length||payload.users.length>MAX_USERS||payload.settings.length>30000||payload.records.length>500000||payload.targets.length>80000||payload.runs.length>500000)throw new Error('整站备份数据结构无效');
  const userIds=new Set(),usernames=new Set();let superadmins=0;
  for(const user of payload.users){
    const usernameKey=String(user.username||'').toLocaleLowerCase();
    if(!validEntityId(user.id)||!checkUsername(user.username)||userIds.has(user.id)||usernames.has(usernameKey)||!validPasswordHash(user.password_hash)||!['superadmin','admin','member'].includes(user.role)||!['active','disabled'].includes(user.status)||!Number.isSafeInteger(Number(user.session_version))||Number(user.session_version)<1)throw new Error('整站备份中的账户数据无效');
    userIds.add(user.id);usernames.add(usernameKey);if(user.role==='superadmin')superadmins+=1;
  }
  if(superadmins!==1)throw new Error('整站备份必须包含且只能包含一个超级管理员账户');
  if(payload.users.find(user=>user.role==='superadmin')?.status!=='active')throw new Error('整站备份中的超级管理员必须处于正常状态');
  const settingKeys=new Set();
  for(const item of payload.settings){
    const identity=`${item.user_id}:${item.key}`;
    if(!userIds.has(item.user_id)||!['stage','theme','backup_secret'].includes(item.key)||settingKeys.has(identity))throw new Error('整站备份中的设置数据无效');
    if(['stage','theme'].includes(item.key)&&(typeof item.value!=='object'||item.value===null||Array.isArray(item.value)))throw new Error('整站备份中的设置数据无效');
    if(item.key==='backup_secret'&&item.value!==null&&(!item.value||!checkPasswordShape(item.value.password)))throw new Error('整站备份中的备份密码配置无效');
    settingKeys.add(identity);
  }
  const recordIds=new Set(),recordCounts=new Map();
  for(const record of payload.records){
    if(!userIds.has(record.user_id)||!validEntityId(record.id)||recordIds.has(record.id)||!validRecordType(record.type)||!validRecordPeriod(record.type,record.period)||!['draft','completed','verified'].includes(record.status)||typeof record.title!=='string'||!isPlainObject(record.data)||Buffer.byteLength(JSON.stringify(record.data))>MAX_RECORD_DATA_BYTES||(record.verification!==null&&record.verification!==undefined&&!isPlainObject(record.verification))||(record.status==='verified'&&!isPlainObject(record.verification)))throw new Error('整站备份中的复盘数据无效');
    recordIds.add(record.id);const count=(recordCounts.get(record.user_id)||0)+1;if(count>MAX_RECORDS_PER_USER)throw new Error(`整站备份中的单个账户不能超过 ${MAX_RECORDS_PER_USER} 条复盘记录`);recordCounts.set(record.user_id,count);
  }
  const targetIds=new Set();
  for(const target of payload.targets){
    if(!userIds.has(target.user_id)||!validEntityId(target.id)||targetIds.has(target.id)||!['webdav','s3'].includes(target.kind)||!['manual','daily','weekly'].includes(target.schedule)||!isPlainObject(target.config))throw new Error('整站备份中的外部备份配置无效');
    try{normalizeBackupConfig(target.kind,target.config)}catch{throw new Error('整站备份中的外部备份配置无效')}
    targetIds.add(target.id);
  }
  const runIds=new Set();
  for(const run of payload.runs){
    if(!userIds.has(run.user_id)||!targetIds.has(run.target_id)||!validEntityId(run.id)||runIds.has(run.id))throw new Error('整站备份中的运行记录无效');
    runIds.add(run.id);
  }
}
function siteBackupPreview(payload) {
  return {createdAt:payload.createdAt||'',schemaVersion:Number(payload.schemaVersion||0),users:payload.users.length,records:payload.records.length,settings:payload.settings.length,targets:payload.targets.length,runs:payload.runs.length};
}
function applySiteBackup(payload) {
  validateSiteBackupPayload(payload);requireMasterKey();
  db.exec('BEGIN IMMEDIATE');
  try{
    db.exec('DELETE FROM sessions; DELETE FROM backup_runs; DELETE FROM backup_targets; DELETE FROM records; DELETE FROM user_settings; DELETE FROM users;');
    const insertUser=db.prepare(`INSERT INTO users(id,username,display_name,password_hash,role,status,session_version,created_at) VALUES(?,?,?,?,?,?,?,?)`);
    for(const user of payload.users)insertUser.run(user.id,user.username,safeText(user.display_name||user.username,32),user.password_hash,user.role,user.status,Math.max(1,Number(user.session_version)||1),validTime(user.created_at)?user.created_at:now());
    for(const item of payload.settings){
      if(item.key==='backup_secret'){if(item.value)putSetting(item.user_id,item.key,encryptSecret(item.value));}
      else putSetting(item.user_id,item.key,item.key==='stage'?normalizeStage(item.value):normalizeTheme(item.value));
      if(validTime(item.updated_at))db.prepare(`UPDATE user_settings SET updated_at=? WHERE user_id=? AND key=?`).run(item.updated_at,item.user_id,item.key);
    }
    const insertRecord=db.prepare(`INSERT INTO records(id,user_id,type,period,title,data,status,version,verification,created_at,updated_at,completed_at,verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for(const record of payload.records){
      const createdAt=validTime(record.created_at)?record.created_at:now(),updatedAt=validTime(record.updated_at)?record.updated_at:createdAt;
      insertRecord.run(record.id,record.user_id,record.type,record.period,encryptData(safeText(record.title,200),dataScope('record',record.user_id,record.id,'title')),encryptData(record.data||{},dataScope('record',record.user_id,record.id,'data')),record.status,Math.max(1,Number(record.version)||1),record.verification?encryptData(record.verification,dataScope('record',record.user_id,record.id,'verification')):null,createdAt,updatedAt,validTime(record.completed_at)?record.completed_at:null,validTime(record.verified_at)?record.verified_at:null);
    }
    for(const user of payload.users)if(accountRecordBytes(user.id)>MAX_ACCOUNT_CONTENT_BYTES)throw new Error('整站备份中的单个账户内容超过存储上限');
    const insertTarget=db.prepare(`INSERT INTO backup_targets(id,user_id,name,kind,encrypted_config,schedule,enabled,last_run_at,last_success_at,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    for(const target of payload.targets)insertTarget.run(target.id,target.user_id,safeText(target.name,80),target.kind,encryptSecret(target.config),target.schedule,target.enabled===0?0:1,validTime(target.last_run_at)?target.last_run_at:null,validTime(target.last_success_at)?target.last_success_at:null,safeText(target.last_error,300)||null,validTime(target.created_at)?target.created_at:now(),validTime(target.updated_at)?target.updated_at:now());
    const insertRun=db.prepare(`INSERT INTO backup_runs(id,target_id,user_id,status,message,created_at) VALUES(?,?,?,?,?,?)`);
    for(const run of payload.runs)insertRun.run(run.id,run.target_id,run.user_id,safeText(run.status,40),safeText(run.message,300),validTime(run.created_at)?run.created_at:now());
    db.prepare(`INSERT INTO schema_meta(key,value) VALUES('public_registration',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(payload.publicRegistration?'true':'false');
    db.exec('COMMIT');
    return siteBackupPreview(payload);
  }catch(error){try{db.exec('ROLLBACK')}catch{}throw error}
}

const isPrivateIp = ip => {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 || p[0] >= 224 ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && (p[1] === 0 || p[1] === 168 || (p[1] === 88 && p[2] === 99))) ||
      (p[0] === 198 && (p[1] === 18 || p[1] === 19 || (p[1] === 51 && p[2] === 100))) ||
      (p[0] === 203 && p[1] === 0 && p[2] === 113);
  }
  const value=String(ip).toLowerCase();
  if(value.startsWith('::ffff:')){
    const mapped=value.slice(7);
    if(net.isIPv4(mapped))return isPrivateIp(mapped);
    const match=/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped);
    if(match){const first=parseInt(match[1],16),second=parseInt(match[2],16);return isPrivateIp(`${first>>8}.${first&255}.${second>>8}.${second&255}`)}
  }
  return value==='::1'||value==='::'||value.startsWith('fc')||value.startsWith('fd')||/^fe[89abcdef]/.test(value)||value.startsWith('ff')||value.startsWith('64:ff9b:')||value.startsWith('2001:0:')||value.startsWith('2001:db8:')||value.startsWith('2002:');
};
function endpointUrl(raw,label='地址') {
  let url;try{url=new URL(String(raw||''))}catch{throw new Error(`${label}格式不正确`)}
  if(url.protocol!=='https:')throw new Error(`${label}只允许 HTTPS`);
  if(url.username||url.password)throw new Error(`${label}不能包含账号或密码`);
  if(url.search||url.hash)throw new Error(`${label}不能包含查询参数或片段`);
  const hostname=url.hostname.toLowerCase(),literal=hostname.replace(/^\[|\]$/g,'');
  if(['localhost','localhost.localdomain'].includes(hostname)||(net.isIP(literal)&&isPrivateIp(literal)))throw new Error(`${label}不允许本机或内网地址`);
  return url;
}
function backupDirectory(value) {
  const directory=String(value||'shendu').trim().replace(/^\/+|\/+$/g,'');
  if(!directory||directory.length>300||/[\0\r\n\\%?#]/.test(directory)||directory.split('/').some(part=>!part||part==='.'||part==='..'))throw new Error('远端目录格式不正确');
  return directory;
}
function credentialText(value,label,max=1024) {
  const text=String(value||'');if(!text||text.length>max||/[\r\n\0]/.test(text))throw new Error(`${label}格式不正确`);return text;
}
function normalizeBackupConfig(kind,value) {
  if(!isPlainObject(value))throw new Error('外部备份配置不正确');
  const directory=backupDirectory(value.directory);
  if(kind==='webdav'){
    const url=endpointUrl(value.url,'WebDAV 地址');
    return {url:url.href.replace(/\/$/,''),username:credentialText(value.username,'WebDAV 账号',256),password:credentialText(value.password,'WebDAV 密码'),directory};
  }
  if(kind==='s3'){
    const endpoint=endpointUrl(value.endpoint,'S3 Endpoint'),pathStyle=value.pathStyle===true;
    const bucket=String(value.bucket||'').trim();
    const bucketPattern=pathStyle?/^[A-Za-z0-9][A-Za-z0-9._-]{1,61}[A-Za-z0-9]$/:/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
    if(!bucketPattern.test(bucket)||bucket.includes('..'))throw new Error('S3 Bucket 名称格式不正确');
    const region=String(value.region||'auto').trim();if(!/^[A-Za-z0-9-]{1,64}$/.test(region))throw new Error('S3 Region 格式不正确');
    return {endpoint:endpoint.href.replace(/\/$/,''),region,bucket,accessKey:credentialText(value.accessKey,'S3 Access Key',256),secretKey:credentialText(value.secretKey,'S3 Secret Key'),directory,pathStyle};
  }
  throw new Error('目标类型不正确');
}
async function assertPublicHttps(raw) {
  const u=endpointUrl(raw);
  const addresses = await lookup(u.hostname, { all: true });
  if (!addresses.length || addresses.some(a => isPrivateIp(a.address))) throw new Error('目标解析到了内网或保留地址');
  return {url:u,addresses};
}
function pinnedHttpsRequest(validated,target,{method='GET',headers={},body=Buffer.alloc(0),maxResponseBytes=1024*1024}={}) {
  return new Promise((resolveRequest,rejectRequest)=>{
    const targetUrl=target instanceof URL?target:new URL(target);
    const allowedHost=targetUrl.hostname===validated.url.hostname||targetUrl.hostname.endsWith(`.${validated.url.hostname}`);
    if(targetUrl.protocol!=='https:'||targetUrl.port!==validated.url.port||!allowedHost)return rejectRequest(new Error('外部备份目标地址校验失败'));
    const requestHeaders={...headers};if(body.length&&!Object.keys(requestHeaders).some(name=>name.toLowerCase()==='content-length'))requestHeaders['Content-Length']=String(body.length);
    const request=https.request({protocol:'https:',hostname:targetUrl.hostname,port:targetUrl.port||443,path:`${targetUrl.pathname}${targetUrl.search}`,method,headers:requestHeaders,servername:targetUrl.hostname,rejectUnauthorized:true,lookup(_hostname,options,callback){
      const candidates=options?.family?validated.addresses.filter(item=>item.family===options.family):validated.addresses;
      const available=candidates.length?candidates:validated.addresses;
      if(options?.all)return callback(null,available.map(item=>({address:item.address,family:item.family})));
      const selected=available[0];return callback(null,selected.address,selected.family);
    }},response=>{
      const chunks=[];let size=0;
      response.on('data',chunk=>{size+=chunk.length;if(size>maxResponseBytes){request.destroy(new Error('外部备份服务返回内容过大'));return}chunks.push(chunk)});
      response.on('end',()=>resolveRequest({ok:response.statusCode>=200&&response.statusCode<300,status:response.statusCode||0,body:Buffer.concat(chunks)}));
    });
    const deadline=setTimeout(()=>request.destroy(new Error('外部备份服务响应超时')),30000);
    request.once('close',()=>clearTimeout(deadline));request.once('error',rejectRequest);request.end(body);
  });
}
const awsDate = d => d.toISOString().replace(/[:-]|\.\d{3}/g, '');
async function s3Request(config, key, method, body = Buffer.alloc(0)) {
  const validated=await assertPublicHttps(config.endpoint),endpoint=validated.url,region=config.region||'auto';
  const objectPath = `${String(config.directory || 'shendu').replace(/^\/+|\/+$/g,'')}/${key}`;
  let hostname,pathname;
  if(config.pathStyle){hostname=endpoint.hostname;pathname=`${endpoint.pathname.replace(/\/$/,'')}/${config.bucket}/${objectPath}`}
  else{hostname=`${config.bucket}.${endpoint.hostname}`;pathname=`${endpoint.pathname.replace(/\/$/,'')}/${objectPath}`}
  pathname='/'+pathname.split('/').filter(Boolean).map(part=>{try{return encodeURIComponent(decodeURIComponent(part))}catch{return encodeURIComponent(part)}}).join('/');
  const host=`${hostname}${endpoint.port?`:${endpoint.port}`:''}`;
  const stamp = awsDate(new Date()), date = stamp.slice(0,8), payloadHash = createHash('sha256').update(body).digest('hex');
  const headers = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': stamp, 'content-type': 'application/octet-stream' };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map(k => `${k}:${headers[k].trim()}\n`).join('');
  const canonicalRequest = `${method}\n${pathname}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${createHash('sha256').update(canonicalRequest).digest('hex')}`;
  const hmac = (keyData, value) => createHmac('sha256', keyData).update(value).digest();
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretKey}`, date), region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const target=new URL(endpoint.href);target.hostname=hostname;target.pathname=pathname;target.search='';target.hash='';
  const response=await pinnedHttpsRequest(validated,target,{method,headers:{...headers,Authorization:authorization},body:['GET','HEAD'].includes(method)?Buffer.alloc(0):body});
  if (!response.ok) throw new Error(`S3 返回 ${response.status}`);
  return response;
}
async function uploadWebdav(config, key, body, test = false) {
  const validated=await assertPublicHttps(config.url),base=validated.url,dir=String(config.directory||'shendu').replace(/^\/+|\/+$/g,'');
  const target=new URL(base.href);target.pathname=`${base.pathname.replace(/\/$/,'')}/${dir.split('/').map(encodeURIComponent).join('/')}/${encodeURIComponent(key)}`;target.search='';target.hash='';
  const auth = 'Basic ' + Buffer.from(`${config.username}:${config.password}`).toString('base64');
  const response=await pinnedHttpsRequest(validated,target,{method:'PUT',headers:{Authorization:auth,'Content-Type':'application/octet-stream'},body});
  if (!response.ok) throw new Error(`WebDAV 返回 ${response.status}`);
  if (test) {
    let validationError=null;
    try{const check=await pinnedHttpsRequest(validated,target,{headers:{Authorization:auth}});if(!check.ok||!check.body.equals(body))throw new Error('WebDAV 读回校验失败')}catch(error){validationError=error}
    try{const removed=await pinnedHttpsRequest(validated,target,{method:'DELETE',headers:{Authorization:auth}});if(!removed.ok&&!validationError)throw new Error(`WebDAV 测试文件清理失败（${removed.status}）`)}catch(error){if(!validationError)throw error}
    if(validationError)throw validationError;
  }
}
async function runExternalBackup(target, test = false) {
  const config=normalizeBackupConfig(target.kind,decryptSecret(target.encrypted_config));const password=getBackupPassword(target.user_id);
  if (!password) throw new Error('请先设置个人备份密码');
  const body = test ? randomBytes(64) : createBackupBuffer(target.user_id, password);
  const key = test ? `connection-test-${randomUUID()}.bin` : accountBackupFilename();
  if (target.kind === 'webdav') await uploadWebdav(config, key, body, test);
  else {
    await s3Request(config, key, 'PUT', body);
    if (test) {
      let validationError=null;
      try{const check=await s3Request(config,key,'GET');if(!check.body.equals(body))throw new Error('S3 读回校验失败')}catch(error){validationError=error}
      try{await s3Request(config,key,'DELETE')}catch(error){if(!validationError)throw error}
      if(validationError)throw validationError;
    }
  }
}

function saveBackupOutcome(target,status,message) {
  const stamp=now(),cleanMessage=safeText(message,300);
  db.exec('BEGIN IMMEDIATE');
  try{
    const updated=status==='success'
      ?db.prepare(`UPDATE backup_targets SET last_run_at=?,last_success_at=?,last_error=NULL WHERE id=? AND user_id=?`).run(stamp,stamp,target.id,target.user_id)
      :db.prepare(`UPDATE backup_targets SET last_run_at=?,last_error=? WHERE id=? AND user_id=?`).run(stamp,cleanMessage,target.id,target.user_id);
    if(updated.changes!==1){db.exec('ROLLBACK');return false}
    db.prepare(`INSERT INTO backup_runs VALUES(?,?,?,?,?,?)`).run(randomUUID(),target.id,target.user_id,status,cleanMessage,stamp);
    db.prepare(`DELETE FROM backup_runs WHERE user_id=? AND id NOT IN (SELECT id FROM backup_runs WHERE user_id=? ORDER BY created_at DESC LIMIT 500)`).run(target.user_id,target.user_id);
    db.exec('COMMIT');return true;
  }catch(error){try{db.exec('ROLLBACK')}catch{}throw error}
}

function staticFile(req, res, pathname) {
  if(!['GET','HEAD'].includes(req.method||'GET'))return false;
  let relative;try{relative=pathname==='/'?'index.html':decodeURIComponent(pathname.slice(1))}catch{throw Object.assign(new Error('页面地址格式不正确'),{status:400})}
  const file = resolve(PUBLIC_DIR, relative);
  if (!file.startsWith(`${PUBLIC_DIR}${sep}`) || !existsSync(file) || statSync(file).isDirectory()) return false;
  const types = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.ttf':'font/ttf','.woff2':'font/woff2' };
  const isHtml = extname(file) === '.html';
  res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable' });
  if(req.method==='HEAD')res.end();else createReadStream(file).pipe(res);return true;
}

async function api(req, res, url) {
  const method = req.method || 'GET'; const path = url.pathname;
  const fetchSite=String(req.headers['sec-fetch-site']||'').toLowerCase();
  if(fetchSite&&!['same-origin','none'].includes(fetchSite))return error(res,403,'已阻止跨站接口请求','csrf');
  if (!['GET','HEAD','OPTIONS'].includes(method)) {
    const origin=String(req.headers.origin||'');
    if(origin){
      let originUrl;try{originUrl=new URL(origin)}catch{return error(res,403,'已阻止来源不明的写入','csrf')}
      const expectedHost=String(req.headers.host||'').toLowerCase(),expectedProtocol=String(req.headers['x-forwarded-proto']||'http').split(',')[0].trim().toLowerCase();
      if(originUrl.host.toLowerCase()!==expectedHost||originUrl.protocol!==`${expectedProtocol}:`)return error(res,403,'已阻止跨站写入','csrf');
    }
  }
  if (path === '/api/auth/state' && method === 'GET') {
    const user = sessionUser(req); const count = db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n;
    return json(res, 200, { user: cleanUser(user), firstRun: count === 0, registrationOpen: db.prepare(`SELECT value FROM schema_meta WHERE key='public_registration'`).get().value === 'true' });
  }
  if (path === '/api/auth/register' && method === 'POST') {
    if (limited(req,'register',8,3600000)) return error(res,429,'尝试次数过多，请稍后再试');
    const body = await readJson(req); const count = db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n;
    const open = db.prepare(`SELECT value FROM schema_meta WHERE key='public_registration'`).get().value === 'true';
    if (count > 0 && !open) return error(res,403,'公开注册已关闭');
    if(count>=MAX_USERS)return error(res,403,'本站账户数量已达上限');
    if (!checkUsername(body.username)) return error(res,400,'用户名需为 3–32 个汉字、字母、数字或 _ . -');
    if (!checkPasswordShape(body.password)) return error(res,400,'密码需为 15–128 个字符');
    if(!masterKey)return error(res,503,masterKeyError||'服务器数据加密密钥暂不可用','data_key_unavailable');
    if(db.prepare(`SELECT 1 FROM users WHERE username=? COLLATE NOCASE`).get(body.username.trim()))return error(res,409,'这个用户名已经存在');
    const user = { id: randomUUID(), username: body.username.trim(), display_name: safeText(body.displayName || body.username,32), role: count === 0 ? 'superadmin' : 'member', session_version: 1 };
    db.exec('BEGIN IMMEDIATE');
    try{
      db.prepare(`INSERT INTO users(id,username,display_name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)`).run(user.id,user.username,user.display_name,hashPassword(body.password),user.role,now());
      putSetting(user.id,'stage',defaultStage());putSetting(user.id,'theme',defaultTheme());
      if(count===0)db.prepare(`UPDATE schema_meta SET value='false' WHERE key='public_registration'`).run();
      db.exec('COMMIT');
    }catch(registerError){try{db.exec('ROLLBACK')}catch{}throw registerError}
    createSession(res,user);
    return json(res,201,{ user: cleanUser(user) });
  }
  if (path === '/api/auth/login' && method === 'POST') {
    const body=await readJson(req),loginName=String(body.username||'').trim(),loginBucket=createHash('sha256').update(loginName.toLocaleLowerCase()).digest('hex').slice(0,24);
    if (limited(req,'login-total',60,15*60000)||limited(req,`login:${loginBucket}`,12,15*60000)) return error(res,429,'登录尝试过多，请 15 分钟后再试');
    const user = db.prepare(`SELECT * FROM users WHERE username=? COLLATE NOCASE`).get(loginName);
    const passwordMatches=verifyPassword(body.password||'',user?.password_hash||DUMMY_PASSWORD_HASH);
    if (!user || !passwordMatches) return error(res,401,'用户名或密码不正确');
    if (user.status !== 'active') return error(res,403,'该账户已停用'); createSession(res,user); return json(res,200,{user:cleanUser(user)});
  }
  if (path === '/api/auth/logout' && method === 'POST') {
    const token = parseCookies(req).shendu_session; if (token) db.prepare(`DELETE FROM sessions WHERE token_hash=?`).run(createHash('sha256').update(token).digest('hex'));
    setSessionCookie(res,'',0); return json(res,200,{ok:true});
  }
  const user = requireUser(req,res); if (!user) return;req.authUser=user;
  if (path === '/api/me' && method === 'GET') return json(res,200,{ user:cleanUser(user), stage:normalizeStage(setting(user.id,'stage',defaultStage())), theme:normalizeTheme(setting(user.id,'theme',defaultTheme())) });
  if (path === '/api/me/password' && method === 'POST') {
    if (limited(req,`password:${user.id}`,6,3600000)) return error(res,429,'尝试次数过多');
    const body=await readJson(req); if (!verifyPassword(body.currentPassword || '',user.password_hash)) return error(res,400,'当前密码不正确');
    if (!checkPasswordShape(body.newPassword)) return error(res,400,'新密码需为 15–128 个字符');
    db.prepare(`UPDATE users SET password_hash=?,session_version=session_version+1 WHERE id=?`).run(hashPassword(body.newPassword),user.id);
    db.prepare(`DELETE FROM sessions WHERE user_id=?`).run(user.id); setSessionCookie(res,'',0); return json(res,200,{ok:true,relogin:true});
  }
  if (path === '/api/settings' && method === 'PUT') {
    const body=await readJson(req),response={ok:true};
    if(body.stage){response.stage=normalizeStage(body.stage);putSetting(user.id,'stage',response.stage)}
    if(body.theme){response.theme=normalizeTheme(body.theme);putSetting(user.id,'theme',response.theme)}
    return json(res,200,response);
  }
  if (path === '/api/stats' && method === 'GET') {
    const current = todayDate();
    const currentDate = new Date(`${current}T12:00:00Z`);
    const ws = shiftCalendarDate(current, -((currentDate.getUTCDay() + 6) % 7));
    const week = db.prepare(`SELECT COUNT(*) AS n FROM records WHERE user_id=? AND type='daily' AND period>=? AND status!='draft'`).get(user.id,ws).n;
    const pending = db.prepare(`SELECT COUNT(*) AS n FROM records WHERE user_id=? AND status='completed'`).get(user.id).n;
    const total = db.prepare(`SELECT COUNT(*) AS n FROM records WHERE user_id=? AND status IN ('completed','verified')`).get(user.id).n;
    return json(res,200,{week,pending,total});
  }
  if (path === '/api/records' && method === 'GET') {
    const type=url.searchParams.get('type'), status=url.searchParams.get('status'), q=url.searchParams.get('q'); const args=[user.id]; let where='user_id=?';
    if(type&&validRecordType(type)){where+=' AND type=?';args.push(type)} if(status){where+=' AND status=?';args.push(status)}
    let rows=db.prepare(`SELECT * FROM records WHERE ${where} ORDER BY period DESC,updated_at DESC LIMIT ${MAX_RECORDS_PER_USER}`).all(...args).map(recordOut);
    if(q){const needle=String(q).trim().toLowerCase();rows=rows.filter(row=>`${row.title} ${JSON.stringify(row.data)} ${JSON.stringify(row.verification||{})}`.toLowerCase().includes(needle))}
    return json(res,200,{records:rows});
  }
  if (path.startsWith('/api/records/') && method === 'GET') {
    const id=path.split('/')[3]; const row=db.prepare(`SELECT * FROM records WHERE id=? AND user_id=?`).get(id,user.id); if(!row)return error(res,404,'记录不存在'); return json(res,200,{record:recordOut(row)});
  }
  if (path === '/api/records' && method === 'PUT') {
    const body=await readJson(req); if(!validRecordType(body.type)||!body.period)return error(res,400,'记录类型或周期不正确');
    if(String(body.period)!==currentPeriodFor(body.type))return error(res,400,currentPeriodMessage(body.type),'period_locked');
    if(body.id&&!validEntityId(body.id))return error(res,400,'记录编号不正确');
    const id=body.id||randomUUID(), existing=db.prepare(`SELECT * FROM records WHERE id=? AND user_id=?`).get(id,user.id);
    if(existing&&existing.status!=='draft')return error(res,409,'已完成的记录不能修改','locked');
    if(existing&&Number(body.version)!==Number(existing.version))return error(res,409,'这条记录已在其他设备更新，请刷新后再继续','version_conflict');
    const stamp=now(), version=existing?existing.version+1:1,cleanData=isPlainObject(body.data)?body.data:{};
    if('templateSnapshot' in cleanData){const snapshot=normalizeTemplateSnapshot(cleanData.templateSnapshot,body.type);if(snapshot)cleanData.templateSnapshot=snapshot;else delete cleanData.templateSnapshot}
    if(Buffer.byteLength(JSON.stringify(cleanData))>MAX_RECORD_DATA_BYTES)return error(res,413,'单条复盘内容过大，请精简后再保存','record_too_large');
    if(!existing&&db.prepare(`SELECT COUNT(*) AS n FROM records WHERE user_id=?`).get(user.id).n>=MAX_RECORDS_PER_USER)return error(res,403,`每个账户最多保存 ${MAX_RECORDS_PER_USER} 条复盘记录`,'record_limit_reached');
    const data=encryptData(cleanData,dataScope('record',user.id,id,'data')),title=encryptData(safeText(body.title||'',200),dataScope('record',user.id,id,'title'));
    if(accountRecordBytes(user.id)-recordStoredBytes(existing)+Buffer.byteLength(data)+Buffer.byteLength(title)>MAX_ACCOUNT_CONTENT_BYTES)return error(res,413,'账户复盘内容已达到存储上限','account_storage_limit');
    if(existing)db.prepare(`UPDATE records SET type=?,period=?,title=?,data=?,version=?,updated_at=? WHERE id=? AND user_id=?`).run(body.type,body.period,title,data,version,stamp,id,user.id);
    else db.prepare(`INSERT INTO records(id,user_id,type,period,title,data,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?,'draft',1,?,?)`).run(id,user.id,body.type,body.period,title,data,stamp,stamp);
    return json(res,200,{record:recordOut(db.prepare(`SELECT * FROM records WHERE id=?`).get(id))});
  }
  if (/^\/api\/records\/[^/]+\/complete$/.test(path) && method === 'POST') {
    const id=path.split('/')[3], row=db.prepare(`SELECT * FROM records WHERE id=? AND user_id=?`).get(id,user.id); if(!row)return error(res,404,'记录不存在'); if(row.status!=='draft')return error(res,409,'记录已经完成');
    if(row.period!==currentPeriodFor(row.type))return error(res,400,currentPeriodMessage(row.type),'period_locked');
    const decoded=recordOut(row),data=decoded.data,required={daily:['today'],weekly:['plan','progress','nextThree'],monthly:['goalResult','change','bottleneck','experiment'],quarterly:['hope','evidence','choices','nextGoals'],yearly:['coordinates','expectations','keepRelease','nextYear'],decision:['decision','options','facts','expectation','failure','choice','firstStep']}[row.type]||[];
    const missing=required.some(k=>!(data.answers?.[k]||[]).some(v=>String(v).trim()))||!String(data.action||'').trim()||(row.type==='daily'&&!String(data.ifCondition||'').trim())||!String(data.ifThen||'').trim()||!validIsoDate(data.verifyDate)||data.verifyDate<todayDate()||(row.type==='decision'&&!decoded.title.trim()); if(missing)return error(res,400,'请先完成所有必填项，并确认预期验证日期不早于今天');
    const normalizedSnapshot=normalizeTemplateSnapshot(data.templateSnapshot,row.type);
    if(!normalizedSnapshot){const stage=normalizeStage(setting(user.id,'stage',defaultStage()));data.templateSnapshot={version:1,review:stage.reviewTemplates[row.type],action:stage.actionTemplate}}
    else data.templateSnapshot=normalizedSnapshot;
    const stamp=now(),storedData=encryptData(data,dataScope('record',user.id,id,'data'));
    if(accountRecordBytes(user.id)-Buffer.byteLength(row.data)+Buffer.byteLength(storedData)>MAX_ACCOUNT_CONTENT_BYTES)return error(res,413,'账户复盘内容已达到存储上限','account_storage_limit');
    db.prepare(`UPDATE records SET data=?,status='completed',version=version+1,completed_at=?,updated_at=? WHERE id=?`).run(storedData,stamp,stamp,id); return json(res,200,{record:recordOut(db.prepare(`SELECT * FROM records WHERE id=?`).get(id))});
  }
  if (/^\/api\/records\/[^/]+\/verify$/.test(path) && method === 'POST') {
    const id=path.split('/')[3],body=await readJson(req),row=db.prepare(`SELECT * FROM records WHERE id=? AND user_id=?`).get(id,user.id);if(!row)return error(res,404,'记录不存在');if(row.status!=='completed')return error(res,409,'只有待验证记录可以提交结果');
    if(!safeText(body.result).trim()||!safeText(body.adjustment).trim()||(row.type==='decision'&&(!['好','差'].includes(body.outcome)||!['好','差'].includes(body.process))))return error(res,400,'请完整填写验证结果');
    const stamp=now(),decoded=recordOut(row),verification=encryptData({result:safeText(body.result),adjustment:safeText(body.adjustment),outcome:body.outcome||null,process:body.process||null,expectedDate:decoded.data.verifyDate||null,actualAt:stamp},dataScope('record',user.id,id,'verification'));
    if(accountRecordBytes(user.id)-Buffer.byteLength(row.verification||'')+Buffer.byteLength(verification)>MAX_ACCOUNT_CONTENT_BYTES)return error(res,413,'账户复盘内容已达到存储上限','account_storage_limit');
    const updated=db.prepare(`UPDATE records SET status='verified',verification=?,verified_at=?,updated_at=?,version=version+1 WHERE id=? AND user_id=? AND status='completed'`).run(verification,stamp,stamp,id,user.id);
    if(updated.changes!==1)return error(res,409,'这条行动已经被其他请求验证，请刷新后查看','already_verified');
    return json(res,200,{record:recordOut(db.prepare(`SELECT * FROM records WHERE id=?`).get(id))});
  }
  if (path === '/api/backup/password' && method === 'POST') {
    const body=await readJson(req); if(!checkPasswordShape(body.password))return error(res,400,'备份密码需为 15–128 个字符'); putSetting(user.id,'backup_secret',encryptSecret({password:body.password,createdAt:now()})); return json(res,200,{ok:true});
  }
  if (path === '/api/backup/status' && method === 'GET') return json(res,200,getBackupStatus(user.id));
  if (path === '/api/backup/export' && method === 'POST') {
    if(limited(req,`backup-export:${user.id}`,12,3600000))return error(res,429,'备份导出次数过多，请稍后再试');
    await readJson(req);
    const password=getBackupPassword(user.id); if(!password)return error(res,400,'请先设置备份密码'); const body=createBackupBuffer(user.id,password);
    if(body.length>MAX_BACKUP_FILE_BYTES)return error(res,413,'个人备份超过 36 MB，无法生成可恢复的文件');
    const filename=accountBackupFilename();
    res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="shendu-account-${todayDate()}.shendu"; filename*=UTF-8''${encodeURIComponent(filename)}`,'Content-Length':body.length,'Cache-Control':'no-store'}); return res.end(body);
  }
  if (path === '/api/data/inspect' && method === 'POST') {
    if (limited(req,`backup-inspect:${user.id}`,20,3600000)) return error(res,429,'备份校验次数过多，请稍后再试');
    const body=await readJson(req,MAX_BACKUP_REQUEST_BYTES);
    try {
      const parsed=parseBackupBuffer(backupTextFrom(body.encryptedBackup),backupPasswordFrom(body.password));
      const preview=backupPreview(parsed,user);
      if(!checkUsername(preview.ownerUsername))return error(res,400,'这份备份没有可验证的所属用户名，无法恢复。请先在原账户恢复后重新导出新版备份。','backup_owner_missing');
      return json(res,200,preview);
    } catch(e) { return error(res,e.status||400,e.message||'无法校验这份备份',e.code||'backup_inspect_failed'); }
  }
  if (path === '/api/data/import' && method === 'POST') {
    if (limited(req,`backup-import:${user.id}`,10,3600000)) return error(res,429,'备份恢复次数过多，请稍后再试');
    const body=await readJson(req,MAX_BACKUP_REQUEST_BYTES);
    if (!['merge','replace'].includes(body.mode)) return error(res,400,'请选择安全合并或完整恢复');
    if (body.mode==='replace'&&body.confirmation!=='RESTORE') return error(res,400,'完整恢复需要再次确认');
    try {
      const parsed=parseBackupBuffer(backupTextFrom(body.encryptedBackup),backupPasswordFrom(body.password));
      assertBackupOwner(user,parsed,body.sourceUsername);
      const restored=applyBackup(user.id,parsed,body.mode);
      return json(res,200,{ok:true,mode:body.mode,...backupPreview(parsed,user),restored});
    } catch(e) { return error(res,e.status||400,e.message||'无法恢复这份备份',e.code||'backup_import_failed'); }
  }
  if (path === '/api/admin/site-backup/export' && method === 'POST') {
    if(user.role!=='superadmin')return error(res,403,'只有超级管理员可以导出整站备份','forbidden');
    if(limited(req,`site-backup-export:${user.id}`,4,3600000))return error(res,429,'整站备份导出次数过多，请稍后再试');
    const body=await readJson(req);
    if(!verifyPassword(body.currentPassword||'',user.password_hash))return error(res,400,'当前超级管理员登录密码不正确','current_password_invalid');
    if(!checkPasswordShape(body.backupPassword))return error(res,400,'整站备份密码需为 15–128 个字符');
    try{
      const backup=createSiteBackupBuffer(body.backupPassword);
      if(backup.length>MAX_SITE_BACKUP_FILE_BYTES)return error(res,413,'整站备份超过 128 MB，无法通过网页下载');
      const filename=`shendu-site-${beijingFileStamp()}.shendu-site`;
      res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="${filename}"`,'Content-Length':backup.length,'Cache-Control':'no-store'});return res.end(backup);
    }catch(e){return error(res,e.status||500,e.message||'整站备份生成失败',e.code||'site_backup_export_failed')}
  }
  if (path === '/api/admin/site-backup/inspect' && method === 'POST') {
    if(user.role!=='superadmin')return error(res,403,'只有超级管理员可以校验整站备份','forbidden');
    if(limited(req,`site-backup-inspect:${user.id}`,10,3600000))return error(res,429,'整站备份校验次数过多，请稍后再试');
    const body=await readJson(req,MAX_SITE_BACKUP_REQUEST_BYTES);
    try{return json(res,200,siteBackupPreview(parseSiteBackupBuffer(siteBackupTextFrom(body.encryptedBackup),body.backupPassword)))}
    catch(e){return error(res,e.status||400,e.message||'无法校验整站备份',e.code||'site_backup_inspect_failed')}
  }
  if (path === '/api/admin/site-backup/restore' && method === 'POST') {
    if(user.role!=='superadmin')return error(res,403,'只有超级管理员可以恢复整站备份','forbidden');
    if(limited(req,`site-backup-restore:${user.id}`,5,3600000))return error(res,429,'整站恢复尝试次数过多，请稍后再试');
    const body=await readJson(req,MAX_SITE_BACKUP_REQUEST_BYTES);
    if(!verifyPassword(body.currentPassword||'',user.password_hash))return error(res,400,'当前超级管理员登录密码不正确','current_password_invalid');
    if(body.confirmation!=='RESTORE_SITE')return error(res,400,'请确认将完整替换本站全部资料','site_restore_confirmation_required');
    try{
      const payload=parseSiteBackupBuffer(siteBackupTextFrom(body.encryptedBackup),body.backupPassword),restored=applySiteBackup(payload);
      setSessionCookie(res,'',0);return json(res,200,{ok:true,restored,relogin:true});
    }catch(e){return error(res,e.status||400,e.message||'无法恢复整站备份',e.code||'site_backup_restore_failed')}
  }
  if (path === '/api/backup/upload/start' && method === 'POST') {
    if(limited(req,`backup-upload:${user.id}`,12,3600000))return error(res,429,'备份上传任务创建过多，请稍后再试');
    const activeUploads=readdirSync(TMP_DIR).filter(name=>name.startsWith(`${user.id}-`)&&name.endsWith('.upload')).length;
    if(activeUploads>=3)return error(res,429,'最多同时保留 3 个备份上传任务，请完成或等待旧任务自动清理');
    const id=randomUUID(); writeFileSync(join(TMP_DIR,`${user.id}-${id}.upload`),''); return json(res,200,{uploadId:id,chunkSize:4194304});
  }
  if (/^\/api\/backup\/upload\/[^/]+\/chunk$/.test(path) && method === 'POST') {
    const id=path.split('/')[4];if(!validEntityId(id))return error(res,400,'上传任务编号不正确');
    if(limited(req,`backup-chunk:${user.id}`,180,3600000))return error(res,429,'备份上传请求过多，请稍后再试');
    const file=join(TMP_DIR,`${user.id}-${id}.upload`); if(!existsSync(file))return error(res,404,'上传任务已失效'); const chunk=await readBody(req,5*1024*1024);
    if(sessionUser(req)?.id!==user.id)return error(res,401,'登录已失效，请重新登录','unauthorized');
    if(statSync(file).size+chunk.length>MAX_BACKUP_FILE_BYTES){try{unlinkSync(file)}catch{}return error(res,413,'备份文件超过 36 MB，无法导入')}
    appendFileSync(file,chunk); return json(res,200,{received:chunk.length});
  }
  if (/^\/api\/backup\/upload\/[^/]+\/preview$/.test(path) && method === 'POST') {
    const id=path.split('/')[4];if(!validEntityId(id))return error(res,400,'上传任务编号不正确');
    if(limited(req,`backup-preview:${user.id}`,20,3600000))return error(res,429,'备份校验次数过多，请稍后再试');
    const file=join(TMP_DIR,`${user.id}-${id}.upload`), password=String(req.headers['x-backup-password']||getBackupPassword(user.id)||''); if(!existsSync(file))return error(res,404,'上传任务已失效'); if(!password)return error(res,400,'请输入这份备份的密码');
    try { const parsed=parseBackupBuffer(readFileSync(file),password),preview=backupPreview(parsed,user); if(!checkUsername(preview.ownerUsername))return error(res,400,'这份备份没有可验证的所属用户名，无法恢复。请先在原账户恢复后重新导出新版备份。','backup_owner_missing'); return json(res,200,preview); } catch(e){return error(res,e.status||400,e.message,e.code||'backup_inspect_failed')}
  }
  if (/^\/api\/backup\/upload\/[^/]+\/apply$/.test(path) && method === 'POST') {
    const id=path.split('/')[4];if(!validEntityId(id))return error(res,400,'上传任务编号不正确');
    if(limited(req,`backup-apply:${user.id}`,10,3600000))return error(res,429,'备份恢复次数过多，请稍后再试');
    const file=join(TMP_DIR,`${user.id}-${id}.upload`); if(!existsSync(file))return error(res,404,'上传任务已失效'); const body=await readJson(req); const password=String(body.password||getBackupPassword(user.id)||''); if(!password)return error(res,400,'请输入这份备份的密码');
    if(!['merge','replace'].includes(body.mode))return error(res,400,'请选择安全合并或完整恢复');
    if(body.mode==='replace'&&body.confirmation!=='RESTORE')return error(res,400,'完整恢复需要再次确认');
    try { const parsed=parseBackupBuffer(readFileSync(file),password); assertBackupOwner(user,parsed,body.sourceUsername); const count=applyBackup(user.id,parsed,body.mode==='replace'?'replace':'merge'); unlinkSync(file); return json(res,200,{ok:true,count}); } catch(e){return error(res,e.status||400,e.message,e.code||'backup_import_failed')}
  }
  if (path === '/api/backup/targets' && method === 'GET') {
    const targets=db.prepare(`SELECT id,name,kind,schedule,enabled,last_run_at,last_success_at,last_error,created_at FROM backup_targets WHERE user_id=? ORDER BY created_at DESC`).all(user.id); const runs=db.prepare(`SELECT * FROM backup_runs WHERE user_id=? AND message!='连接测试成功' ORDER BY created_at DESC LIMIT 10`).all(user.id); return json(res,200,{targets,runs});
  }
  if (path === '/api/backup/targets' && method === 'POST') {
    const body=await readJson(req); if(!['webdav','s3'].includes(body.kind))return error(res,400,'目标类型不正确'); if(db.prepare(`SELECT COUNT(*) AS n FROM backup_targets WHERE user_id=?`).get(user.id).n>=8)return error(res,400,'最多设置 8 个外部目标');
    const name=safeText(body.name,80).trim();if(!name)return error(res,400,'请填写备份目标名称');
    let config;try{config=normalizeBackupConfig(body.kind,body.config)}catch(validationError){return error(res,400,validationError.message,'backup_target_invalid')}
    const id=randomUUID(),stamp=now(); db.prepare(`INSERT INTO backup_targets(id,user_id,name,kind,encrypted_config,schedule,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(id,user.id,name,body.kind,encryptSecret(config),['manual','daily','weekly'].includes(body.schedule)?body.schedule:'manual',body.enabled===false?0:1,stamp,stamp); return json(res,201,{id});
  }
  if (/^\/api\/backup\/targets\/[^/]+$/.test(path) && method === 'PATCH') {
    const id=path.split('/')[4], body=await readJson(req), target=db.prepare(`SELECT * FROM backup_targets WHERE id=? AND user_id=?`).get(id,user.id); if(!target)return error(res,404,'备份目标不存在');
    const kind=['webdav','s3'].includes(body.kind)?body.kind:target.kind, schedule=['manual','daily','weekly'].includes(body.schedule)?body.schedule:target.schedule;
    const name=safeText(body.name||target.name,80).trim();if(!name)return error(res,400,'请填写备份目标名称');
    if(kind!==target.kind&&!body.config)return error(res,400,'切换目标类型时必须重新填写连接配置');
    let encryptedConfig=target.encrypted_config;
    if(body.config){try{encryptedConfig=encryptSecret(normalizeBackupConfig(kind,body.config))}catch(validationError){return error(res,400,validationError.message,'backup_target_invalid')}}
    db.prepare(`UPDATE backup_targets SET name=?,kind=?,encrypted_config=?,schedule=?,enabled=?,updated_at=? WHERE id=? AND user_id=?`).run(name,kind,encryptedConfig,schedule,body.enabled===false?0:1,now(),id,user.id); return json(res,200,{ok:true});
  }
  if (/^\/api\/backup\/targets\/[^/]+$/.test(path) && method === 'DELETE') { const id=path.split('/')[4]; db.prepare(`DELETE FROM backup_targets WHERE id=? AND user_id=?`).run(id,user.id); return json(res,200,{ok:true}); }
  if (/^\/api\/backup\/targets\/[^/]+\/(test|run)$/.test(path) && method === 'POST') {
    const [,,, ,id,action]=path.split('/'); const target=db.prepare(`SELECT * FROM backup_targets WHERE id=? AND user_id=?`).get(id,user.id); if(!target)return error(res,404,'备份目标不存在');
    try { await runExternalBackup(target,action==='test'); if(action==='run'&&!saveBackupOutcome(target,'success','备份成功'))return error(res,409,'备份目标已被删除'); return json(res,200,{ok:true}); }
    catch(e){if(action==='run')saveBackupOutcome(target,'error',e.message);return error(res,400,e.message)}
  }
  if (path === '/api/admin/users' && method === 'GET') {
    if(!['admin','superadmin'].includes(user.role))return error(res,403,'没有权限'); const q=safeText(url.searchParams.get('q')||'',100); return json(res,200,{users:db.prepare(`SELECT id,username,display_name,role,status,created_at FROM users WHERE username LIKE ? OR display_name LIKE ? ORDER BY created_at DESC`).all(`%${q}%`,`%${q}%`).map(cleanUser),registrationOpen:db.prepare(`SELECT value FROM schema_meta WHERE key='public_registration'`).get().value==='true'});
  }
  if (path === '/api/admin/users' && method === 'POST') {
    if(!['admin','superadmin'].includes(user.role))return error(res,403,'没有权限');if(limited(req,`user-create:${user.id}`,30,3600000))return error(res,429,'创建账户次数过多，请稍后再试');
    const body=await readJson(req),actor=db.prepare(`SELECT role,status FROM users WHERE id=?`).get(user.id);if(!actor||actor.status!=='active'||!['admin','superadmin'].includes(actor.role))return error(res,403,'权限已经变化，请重新登录');
    if(db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n>=MAX_USERS)return error(res,403,'本站账户数量已达上限');
    if(!checkUsername(body.username)||!checkPasswordShape(body.password))return error(res,400,'请检查用户名与密码'); const role=body.role==='admin'&&actor.role==='superadmin'?'admin':'member';
    if(db.prepare(`SELECT 1 FROM users WHERE username=? COLLATE NOCASE`).get(body.username))return error(res,409,'用户名已存在');
    const newUserId=randomUUID();db.exec('BEGIN IMMEDIATE');
    try{db.prepare(`INSERT INTO users(id,username,display_name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)`).run(newUserId,body.username,safeText(body.displayName||body.username,32),hashPassword(body.password),role,now());putSetting(newUserId,'stage',defaultStage());putSetting(newUserId,'theme',defaultTheme());db.exec('COMMIT');return json(res,201,{ok:true})}
    catch(createError){try{db.exec('ROLLBACK')}catch{}throw createError}
  }
  if (/^\/api\/admin\/users\/[^/]+$/.test(path) && method === 'PATCH') {
    if(!['admin','superadmin'].includes(user.role))return error(res,403,'没有权限'); const id=path.split('/')[4],body=await readJson(req),actor=db.prepare(`SELECT role,status FROM users WHERE id=?`).get(user.id),target=db.prepare(`SELECT * FROM users WHERE id=?`).get(id);
    if(!actor||actor.status!=='active'||!['admin','superadmin'].includes(actor.role))return error(res,403,'权限已经变化，请重新登录');
    if(!target||target.id===user.id||target.role==='superadmin'||(actor.role==='admin'&&target.role==='admin'))return error(res,403,'不能管理该账户');
    if(body.password&&!checkPasswordShape(body.password))return error(res,400,'密码需为 15–128 个字符');
    if(body.status&&['active','disabled'].includes(body.status))db.prepare(`UPDATE users SET status=?,session_version=session_version+1 WHERE id=?`).run(body.status,id);
    if(body.role&&actor.role==='superadmin'&&['admin','member'].includes(body.role))db.prepare(`UPDATE users SET role=?,session_version=session_version+1 WHERE id=?`).run(body.role,id);
    if(body.password)db.prepare(`UPDATE users SET password_hash=?,session_version=session_version+1 WHERE id=?`).run(hashPassword(body.password),id); db.prepare(`DELETE FROM sessions WHERE user_id=?`).run(id); return json(res,200,{ok:true});
  }
  if (/^\/api\/admin\/users\/[^/]+$/.test(path) && method === 'DELETE') {
    if(!['admin','superadmin'].includes(user.role))return error(res,403,'没有权限');
    if(limited(req,`user-delete:${user.id}`,6,3600000))return error(res,429,'删除验证次数过多，请稍后再试');
    const id=path.split('/')[4],body=await readJson(req),actor=db.prepare(`SELECT role,status,password_hash FROM users WHERE id=?`).get(user.id),target=db.prepare(`SELECT * FROM users WHERE id=?`).get(id);
    if(!actor||actor.status!=='active'||!['admin','superadmin'].includes(actor.role))return error(res,403,'权限已经变化，请重新登录');
    if(!target)return error(res,404,'账户不存在');
    if(target.id===user.id)return error(res,403,'不能删除当前登录账户');
    if(target.role==='superadmin')return error(res,403,'不能删除超级管理员账户');
    if(actor.role==='admin'&&target.role==='admin')return error(res,403,'管理员不能删除其他管理员');
    if(!verifyPassword(body.currentPassword||'',actor.password_hash))return error(res,400,'当前登录密码不正确','current_password_invalid');
    const confirmation=String(body.confirmationUsername||'').trim().normalize('NFKC').toLocaleLowerCase('zh-CN');
    const expected=String(target.username).trim().normalize('NFKC').toLocaleLowerCase('zh-CN');
    if(confirmation!==expected)return error(res,400,'确认用户名与待删除账户不一致','username_confirmation_invalid');
    db.exec('BEGIN IMMEDIATE');
    try {
      const result=db.prepare(`DELETE FROM users WHERE id=?`).run(id);
      if(result.changes!==1)throw new Error('账户删除失败');
      db.exec('COMMIT');
    } catch (deleteError) {
      try{db.exec('ROLLBACK')}catch{}
      throw deleteError;
    }
    for(const name of readdirSync(TMP_DIR))if(name.startsWith(`${id}-`)){try{unlinkSync(join(TMP_DIR,name))}catch{}}
    return json(res,200,{ok:true,deleted:{username:target.username,displayName:target.display_name}});
  }
  if (path === '/api/admin/registration' && method === 'PUT') {
    if(user.role!=='superadmin')return error(res,403,'只有超级管理员可以修改'); const body=await readJson(req); db.prepare(`UPDATE schema_meta SET value=? WHERE key='public_registration'`).run(body.open?'true':'false'); return json(res,200,{ok:true});
  }
  return error(res,404,'接口不存在','not_found');
}

const server = http.createServer(async (req,res) => {
  res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('X-Frame-Options','DENY'); res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Resource-Policy','same-origin');res.setHeader('X-Permitted-Cross-Domain-Policies','none');
  res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    const requestTarget=req.url||'/';if(!requestTarget.startsWith('/')||requestTarget.startsWith('//'))return error(res,400,'请求地址格式不正确');
    const url=new URL(requestTarget,'http://localhost');
    if (url.pathname === '/healthz') return masterKey?json(res,200,{ok:true,schema:6,dataEncryption:'AES-256-GCM'}):json(res,503,{ok:false,schema:6,error:'data_key_unavailable'});
    if (url.pathname.startsWith('/api/')) return await api(req,res,url);
    if (staticFile(req,res,url.pathname)) return;
    if (req.method === 'GET') return staticFile(req,res,'/');
    return error(res,404,'页面不存在');
  } catch (e) { if(!e.status||e.status>=500)console.error(e);if(!res.headersSent)error(res,e.status||500,e.status?e.message:'服务器暂时无法完成请求',e.code||'server_error');else res.end(); }
});

const cleanup = () => {
  db.prepare(`DELETE FROM sessions WHERE expires_at<?`).run(now());
  for (const name of readdirSync(TMP_DIR)) { const file=join(TMP_DIR,name); try{if(statSync(file).isFile()&&Date.now()-statSync(file).mtimeMs>3600000)unlinkSync(file)}catch{} }
  const stamp=Date.now();for(const [key,value] of rateMap)if(value.until<stamp)rateMap.delete(key);
};
const scheduledBackups = async () => {
  const targets=db.prepare(`SELECT * FROM backup_targets WHERE enabled=1 AND schedule!='manual'`).all();
  for(const t of targets){const last=t.last_run_at?Date.parse(t.last_run_at):0,interval=t.schedule==='daily'?86400000:7*86400000;if(Date.now()-last<interval)continue;try{await runExternalBackup(t,false);saveBackupOutcome(t,'success','定时备份成功')}catch(e){try{saveBackupOutcome(t,'error',e.message)}catch(saveError){console.error('定时备份状态写入失败',saveError)}}}
};
let scheduledBackupRunning=false;
const runScheduledBackups=async()=>{if(scheduledBackupRunning)return;scheduledBackupRunning=true;try{await scheduledBackups()}catch(error){console.error('定时备份任务失败',error)}finally{scheduledBackupRunning=false}};
setInterval(cleanup,15*60000).unref(); setInterval(runScheduledBackups,60*60000).unref(); cleanup();
server.listen(PORT,'0.0.0.0',()=>console.log(`慎独已启动：http://0.0.0.0:${PORT}`));
const shutdown=()=>server.close(()=>{db.close();process.exit(0)}); process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
