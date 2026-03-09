const os = require('os');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const { Telegraf } = require('telegraf');
const app = express();
const axios = require('axios');
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const resselFilePath = path.join(__dirname, 'ressel.db');
const resellerTermsPath = path.join(__dirname, 'reseller_terms.json');
const defaultResellerTerms = { min_accounts: 0, min_topup: 30000 };
const topupManualPath = path.join(__dirname, 'topup_manual.json');
const defaultTopupManual = { enabled: true };
const topupAutoPath = path.join(__dirname, 'topup_auto.json');
const defaultTopupAuto = { enabled: true };
const topupBonusPath = path.join(__dirname, 'topup_bonus.json');
const defaultTopupBonus = { enabled: true, range_10_40: 0, range_50_70: 0, range_70_100: 0 };

function loadResellerTerms() {
  try {
    const raw = fs.readFileSync(resellerTermsPath, 'utf8');
    const parsed = JSON.parse(raw);
    const minAccounts = Number(parsed.min_accounts);
    const minTopup = Number(parsed.min_topup);
    if (!Number.isFinite(minAccounts) || !Number.isFinite(minTopup)) {
      return { ...defaultResellerTerms };
    }
    return {
      min_accounts: Math.max(0, Math.floor(minAccounts)),
      min_topup: Math.max(0, Math.floor(minTopup))
    };
  } catch (err) {
    return { ...defaultResellerTerms };
  }
}

function saveResellerTerms(terms) {
  const payload = {
    min_accounts: Math.max(0, Math.floor(Number(terms.min_accounts) || 0)),
    min_topup: Math.max(0, Math.floor(Number(terms.min_topup) || 0))
  };
  fs.writeFileSync(resellerTermsPath, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function loadTopupManualSetting() {
  try {
    const raw = fs.readFileSync(topupManualPath, 'utf8');
    const parsed = JSON.parse(raw);
    return !!parsed.enabled;
  } catch (err) {
    return defaultTopupManual.enabled;
  }
}

function saveTopupManualSetting(enabled) {
  const payload = { enabled: !!enabled };
  fs.writeFileSync(topupManualPath, JSON.stringify(payload, null, 2), 'utf8');
  return payload.enabled;
}

function loadTopupAutoSetting() {
  try {
    const raw = fs.readFileSync(topupAutoPath, 'utf8');
    const parsed = JSON.parse(raw);
    return !!parsed.enabled;
  } catch (err) {
    return defaultTopupAuto.enabled;
  }
}

function saveTopupAutoSetting(enabled) {
  const payload = { enabled: !!enabled };
  fs.writeFileSync(topupAutoPath, JSON.stringify(payload, null, 2), 'utf8');
  return payload.enabled;
}

function loadTopupBonusSetting() {
  try {
    const raw = fs.readFileSync(topupBonusPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      enabled: parsed.enabled !== false,
      range_10_40: Number(parsed.range_10_40) || 0,
      range_50_70: Number(parsed.range_50_70) || 0,
      range_70_100: Number(parsed.range_70_100) || 0
    };
  } catch (err) {
    return { ...defaultTopupBonus };
  }
}

function saveTopupBonusSetting(next) {
  const payload = {
    enabled: next.enabled !== false,
    range_10_40: Math.max(0, Math.min(100, Number(next.range_10_40) || 0)),
    range_50_70: Math.max(0, Math.min(100, Number(next.range_50_70) || 0)),
    range_70_100: Math.max(0, Math.min(100, Number(next.range_70_100) || 0))
  };
  fs.writeFileSync(topupBonusPath, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function formatRupiah(amount) {
  return `Rp ${Number(amount || 0).toLocaleString('id-ID')}`;
}

function getDayRange(dayOffset = 0) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset + 1, 0, 0, 0, 0);
  return { start: start.getTime(), end: end.getTime() };
}

function getIncomeStatsByRange(startTs, endTs) {
  const accountTypes = ['ssh', 'vmess', 'vless', 'trojan', 'shadowsocks', 'zivpn', 'udp_http'];
  const placeholders = accountTypes.map(() => '?').join(',');
  const accountParams = [startTs, endTs, ...accountTypes];
  const topupParams = [startTs, endTs];

  return new Promise((resolve, reject) => {
    db.get(
      `SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total
       FROM transactions
       WHERE timestamp >= ? AND timestamp < ?
         AND type IN (${placeholders})
         AND (reference_id IS NULL OR reference_id NOT LIKE 'account-trial-%')`,
      accountParams,
      (accountErr, accountRow) => {
        if (accountErr) return reject(accountErr);
        db.get(
          `SELECT COALESCE(SUM(amount), 0) as total
           FROM transactions
           WHERE timestamp >= ? AND timestamp < ?
             AND type = 'deposit'`,
          topupParams,
          (topupErr, topupRow) => {
            if (topupErr) return reject(topupErr);
            resolve({
              accountCount: Number(accountRow?.count || 0),
              accountIncome: Number(accountRow?.total || 0),
              topupIncome: Number(topupRow?.total || 0)
            });
          }
        );
      }
    );
  });
}

function escapeHtmlLocal(text) {
  if (!text && text !== 0) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const { buildPayload, headers, API_URL } = require('./api-cekpayment-orkut');
const { isUserReseller, addReseller, removeReseller, listResellersSync } = require('./modules/reseller');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [
    new winston.transports.File({ filename: 'bot-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'bot-combined.log' }),
  ],
});
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple(),
  }));
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const { createzivpn } = require('./modules/createzivpn');
const { trialzivpn } = require('./modules/trialzivpn');

const { 
  createssh, 
  createudphttp,
  createvmess, 
  createvless, 
  createtrojan, 
  createshadowsocks 
} = require('./modules/create');

const { 
  trialssh, 
  trialudphttp,
  trialvmess, 
  trialvless, 
  trialtrojan, 
  trialshadowsocks 
} = require('./modules/trial');

const { 
  renewssh, 
  renewudphttp,
  renewvmess, 
  renewvless, 
  renewtrojan, 
  renewshadowsocks,
  renewzivpn
} = require('./modules/renew');

const { 
  delssh, 
  delvmess, 
  delvless, 
  deltrojan, 
  delzivpn,
  deludphttp
} = require('./modules/del');

const { 
  lockssh, 
  lockvmess, 
  lockvless, 
  locktrojan, 
  lockshadowsocks 
} = require('./modules/lock');

const { 
  unlockssh, 
  unlockvmess, 
  unlockvless, 
  unlocktrojan, 
  unlockshadowsocks 
} = require('./modules/unlock');

const trialFile = path.join(__dirname, 'trial.db');

// Mengecek apakah user sudah pakai trial hari ini
async function checkTrialAccess(userId) {
  try {
    const data = await fsPromises.readFile(trialFile, 'utf8');
    const trialData = JSON.parse(data);
    const lastAccess = trialData[userId];

    const today = new Date().toISOString().slice(0, 10); // format YYYY-MM-DD
    return lastAccess === today;
  } catch (err) {
    return false; // anggap belum pernah pakai kalau file belum ada
  }
}
/////////
async function checkServerAccess(serverId, userId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT is_reseller_only FROM Server WHERE id = ?', [serverId], async (err, row) => {
      if (err) return reject(err);
      // jika server tidak ada => tolak (caller menangani pesan)
      if (!row) return resolve({ ok: false, reason: 'not_found' });
      const flag = row.is_reseller_only === 1 || row.is_reseller_only === '1';
      if (!flag) return resolve({ ok: true }); // publik
      // jika reseller-only, cek apakah user terdaftar reseller
      try {
        const isR = await isUserReseller(userId);
        if (isR) return resolve({ ok: true });
        return resolve({ ok: false, reason: 'reseller_only' });
      } catch (e) {
        // fallback: tolak akses
        return resolve({ ok: false, reason: 'reseller_only' });
      }
    });
  });
}

// Menyimpan bahwa user sudah pakai trial hari ini
async function saveTrialAccess(userId) {
  let trialData = {};
  try {
    const data = await fsPromises.readFile(trialFile, 'utf8');
    trialData = JSON.parse(data);
  } catch (err) {
    // file belum ada, lanjut
  }

  const today = new Date().toISOString().slice(0, 10);
  trialData[userId] = today;
  await fsPromises.writeFile(trialFile, JSON.stringify(trialData, null, 2));
}

function loadVars() {
  try {
    return JSON.parse(fs.readFileSync('./.vars.json', 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveVars(next) {
  fs.writeFileSync('./.vars.json', JSON.stringify(next, null, 2), 'utf8');
}

const vars = loadVars();

const BOT_TOKEN = vars.BOT_TOKEN;
const port = vars.PORT || 6969;
const ADMIN = vars.USER_ID; 
const NAMA_STORE = vars.NAMA_STORE || '@ARI_VPN_STORE';
const DATA_QRIS = vars.DATA_QRIS;
const MERCHANT_ID = vars.MERCHANT_ID;
const API_KEY = vars.API_KEY;
const RAJASERVER_API_KEY = vars.RAJASERVER_API_KEY;
const GROUP_ID = vars.GROUP_ID;
let NOTIF_BOT_TOKEN = vars.NOTIF_BOT_TOKEN || '';
let NOTIF_CHAT_ID = vars.NOTIF_CHAT_ID || '';
let ADMIN_WHATSAPP = String(vars.ADMIN_WHATSAPP || vars.CONTACT_WA || '').replace(/\D/g, '');
let ADMIN_TELEGRAM = String(vars.ADMIN_TELEGRAM || vars.CONTACT_TELEGRAM || '').trim().replace(/^@+/, '');

function formatDateId(date) {
  try {
    return date.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' });
  } catch (e) {
    return date.toISOString().slice(0, 10);
  }
}

function getAdminWhatsappNumber() {
  return String(ADMIN_WHATSAPP || '').replace(/\D/g, '');
}

function getAdminWhatsappUrl() {
  const number = getAdminWhatsappNumber();
  return number ? `https://wa.me/${number}` : null;
}

function getAdminTelegramUsername() {
  const normalized = String(ADMIN_TELEGRAM || '').trim().replace(/^@+/, '');
  if (normalized) return `@${normalized}`;
  return ADMIN_USERNAME || 'Admin';
}

function upsertAccountRecord(payload) {
  const now = Date.now();
  db.get(
    `SELECT id FROM accounts
      WHERE user_id = ?
        AND type = ?
        AND username = ?
        AND (
          server_id = ?
          OR (
            ? <> ''
            AND LOWER(TRIM(COALESCE(domain, ''))) = LOWER(TRIM(?))
          )
        )
      ORDER BY id DESC
      LIMIT 1`,
    [
      payload.userId,
      payload.type,
      payload.username,
      payload.serverId,
      String(payload.domain || '').trim(),
      String(payload.domain || '').trim()
    ],
    (err, row) => {
      if (err) {
        logger.error('Gagal cek akun:', err.message);
        return;
      }
      if (row) {
        db.run(
          'UPDATE accounts SET password = ?, server_id = ?, server_name = ?, domain = ?, link_tls = ?, link_none = ?, link_grpc = ?, link_uptls = ?, link_upntls = ?, expires_at = ? WHERE id = ?',
          [
            payload.password || null,
            payload.serverId,
            payload.serverName || null,
            payload.domain || null,
            payload.link_tls || null,
            payload.link_none || null,
            payload.link_grpc || null,
            payload.link_uptls || null,
            payload.link_upntls || null,
            payload.expiresAt,
            row.id
          ]
        );
      } else {
        db.run(
          'INSERT INTO accounts (user_id, type, username, password, server_id, server_name, domain, link_tls, link_none, link_grpc, link_uptls, link_upntls, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            payload.userId,
            payload.type,
            payload.username,
            payload.password || null,
            payload.serverId,
            payload.serverName || null,
            payload.domain || null,
            payload.link_tls || null,
            payload.link_none || null,
            payload.link_grpc || null,
            payload.link_uptls || null,
            payload.link_upntls || null,
            now,
            payload.expiresAt
          ]
        );
      }
    }
  );
}

function getAccountExistingExpiry(userId, type, username, serverId, domain = '') {
  return new Promise((resolve) => {
    db.get(
      `SELECT expires_at FROM accounts
        WHERE user_id = ?
          AND type = ?
          AND username = ?
          AND (
            server_id = ?
            OR (
              ? <> ''
              AND LOWER(TRIM(COALESCE(domain, ''))) = LOWER(TRIM(?))
            )
          )
        ORDER BY expires_at DESC
        LIMIT 1`,
      [userId, type, username, serverId, String(domain || '').trim(), String(domain || '').trim()],
      (err, row) => {
        if (err) {
          logger.error('Gagal ambil expires_at akun:', err.message);
          return resolve(null);
        }
        const exp = Number(row?.expires_at || 0);
        resolve(Number.isFinite(exp) && exp > 0 ? exp : null);
      }
    );
  });
}

function cleanupExpiredAccounts() {
  const now = Date.now();
  const cutoff = now - (3 * 24 * 60 * 60 * 1000);
  db.run('DELETE FROM accounts WHERE expires_at IS NOT NULL AND expires_at < ?', [cutoff], (err) => {
    if (err) {
      logger.error('Gagal cleanup accounts expired:', err.message);
    }
  });
}

function migrateAccountServerByDomain() {
  return new Promise((resolve) => {
    db.all(
      `SELECT a.id, a.domain
       FROM accounts a
       WHERE (a.server_id IS NULL OR a.server_id = 0)
         AND a.domain IS NOT NULL
         AND TRIM(a.domain) <> ''`,
      [],
      (err, rows) => {
        if (err) {
          logger.error('Gagal membaca accounts untuk migrasi server_id:', err.message);
          return resolve({ updated: 0, total: 0 });
        }

        if (!rows || rows.length === 0) {
          return resolve({ updated: 0, total: 0 });
        }

        let updated = 0;
        let processed = 0;

        const done = () => {
          if (processed >= rows.length) {
            return resolve({ updated, total: rows.length });
          }
        };

        rows.forEach((row) => {
          const domain = String(row.domain || '').trim();
          db.get(
            `SELECT id, COALESCE(NULLIF(nama_server, ''), domain) AS server_label
             FROM Server
             WHERE LOWER(TRIM(COALESCE(domain, ''))) = LOWER(TRIM(?))
             ORDER BY id DESC
             LIMIT 1`,
            [domain],
            (mapErr, serverRow) => {
              if (mapErr) {
                logger.error('Gagal mapping domain ke server saat migrasi:', mapErr.message);
                processed += 1;
                return done();
              }

              if (!serverRow) {
                processed += 1;
                return done();
              }

              db.run(
                'UPDATE accounts SET server_id = ?, server_name = COALESCE(server_name, ?), domain = ? WHERE id = ?',
                [serverRow.id, serverRow.server_label || domain, domain, row.id],
                function(updateErr) {
                  if (updateErr) {
                    logger.error('Gagal update accounts saat migrasi server_id:', updateErr.message);
                  } else if (this && this.changes > 0) {
                    updated += this.changes;
                  }
                  processed += 1;
                  done();
                }
              );
            }
          );
        });
      }
    );
  });
}

function extractAccountLinksFromMessage(message) {
  const text = String(message || '');
  const getLine = (label) => {
    const re = new RegExp(`${label}\\s*:\\s*([^\\n]+)`, 'i');
    const m = text.match(re);
    return m ? m[1].replace(/[`]/g, '').trim() : null;
  };

  const linkTls = getLine('link TLS') || getLine('TLS');
  const linkNone = getLine('link none TLS') || getLine('Non-TLS');
  const linkGrpc = getLine('link GRPC') || getLine('gRPC');
  const linkUpTls = getLine('link Upgrade TLS') || getLine('Up TLS');
  const linkUpNone = getLine('link Upgrade nTLS') || getLine('Up Non-TLS');

  return {
    link_tls: linkTls,
    link_none: linkNone,
    link_grpc: linkGrpc,
    link_uptls: linkUpTls,
    link_upntls: linkUpNone
  };
}

setInterval(cleanupExpiredAccounts, 6 * 60 * 60 * 1000);

async function sendNonResellerCreateNotification(payload) {
  if (!NOTIF_BOT_TOKEN || !NOTIF_CHAT_ID) return;
  try {
    const text =
      `🔔 NOTIFIKASI AKUN BARU (NON-RESELLER)\n\n` +
      `Layanan: ${payload.service}\n` +
      `Server: ${payload.serverName || '-'}\n` +
      `Domain: ${payload.domain || '-'}\n` +
      `Username: ${payload.accountUsername}\n` +
      `Password: ${payload.accountPassword || '-'}\n` +
      `Masa Aktif: ${payload.expDays} hari\n` +
      `Expired: ${payload.expiredDate}\n\n` +
      `Pembuat: ${payload.creatorLabel}\n` +
      `User ID: ${payload.creatorId}`;

    await axios.post(
      `https://api.telegram.org/bot${NOTIF_BOT_TOKEN}/sendMessage`,
      { chat_id: NOTIF_CHAT_ID, text }
    );
  } catch (err) {
    logger.error('❌ Gagal kirim notif create non-reseller:', err.message);
  }
}

// =================== PERBAIKAN GROUP_ID ===================
let GROUP_ID_NUM = null;

try {
  // Debug: log asli dari config
  logger.info(`🔍 GROUP_ID dari .vars.json: "${GROUP_ID}" (type: ${typeof GROUP_ID})`);
  
  // Konversi ke number dengan handle berbagai format
  if (GROUP_ID === undefined || GROUP_ID === null || GROUP_ID === "") {
    logger.error('❌ GROUP_ID tidak ditemukan di config!');
  } else {
    // Handle string atau number
    let groupIdStr = String(GROUP_ID).trim();
    
    // Jika ada tanda kutip di string, hapus
    groupIdStr = groupIdStr.replace(/['"]/g, '');
    
    // Konversi ke number
    const converted = Number(groupIdStr);
    
    if (!isNaN(converted)) {
      GROUP_ID_NUM = converted;
      logger.info(`✅ GROUP_ID valid: ${GROUP_ID_NUM}`);
      
      // Cek apakah ID negatif (semua grup Telegram punya ID negatif)
      if (GROUP_ID_NUM > 0) {
        logger.warn(`⚠️ GROUP_ID positif (${GROUP_ID_NUM}), biasanya grup Telegram ID-nya negatif`);
        logger.warn(`⚠️ Jika notifikasi gagal, coba ubah ke negatif di .vars.json`);
      }
    } else {
      logger.error(`❌ GROUP_ID tidak valid: "${GROUP_ID}" - harus berupa angka`);
    }
  }
} catch (e) {
  logger.error(`❌ Error processing GROUP_ID:`, e.message);
}

const bot = new Telegraf(BOT_TOKEN);
let ADMIN_USERNAME = '';
const adminIds = ADMIN;
logger.info('Bot initialized');

async function notifyGroupAccountDeleted(payload) {
  if (!GROUP_ID_NUM) return;

  try {
    const actorName = payload.actorUsername ? '@' + String(payload.actorUsername).replace(/^@/, '') : '-';
    const deletedName = payload.deletedUsername ? '@' + String(payload.deletedUsername).replace(/^@/, '') : '-';
    const text =
      'NOTIFIKASI HAPUS AKUN\n\n' +
      'Aksi: ' + (payload.action || 'delete') + '\n' +
      'Pelaku ID: ' + String(payload.actorId || '-') + '\n' +
      'Pelaku Username: ' + actorName + '\n' +
      'Target User ID: ' + String(payload.targetUserId || '-') + '\n' +
      'Username Akun: ' + String(payload.accountUsername || '-') + '\n' +
      'Layanan: ' + String(payload.service || '-') + '\n' +
      'Server: ' + String(payload.serverName || '-') + '\n' +
      'Refund Saldo: Rp ' + Number(payload.refund || 0).toLocaleString('id-ID') + '\n' +
      'Sisa Hari: ' + Number(payload.remainingDays || 0) + ' hari\n' +
      'Waktu: ' + new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + '\n' +
      'Keterangan: ' + String(payload.note || '-');

    await bot.telegram.sendMessage(GROUP_ID_NUM, text);
  } catch (err) {
    logger.warn('Gagal kirim notif hapus akun ke grup: ' + err.message);
  }
}


(async () => {
  try {
    const adminId = Array.isArray(adminIds) ? adminIds[0] : adminIds;
    const chat = await bot.telegram.getChat(adminId);
    ADMIN_USERNAME = chat.username ? `@${chat.username}` : 'Admin';
    logger.info(`Admin username detected: ${ADMIN_USERNAME}`);
  } catch (e) {
    ADMIN_USERNAME = 'Admin';
    logger.warn('Tidak bisa ambil username admin otomatis.');
  }
})();
/////
const dbPath = path.join(__dirname, 'sellvpn.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    logger.error('Kesalahan koneksi SQLite3:', err.message);
  } else {
    logger.info('Terhubung ke SQLite3');
  }
});

db.run(`CREATE TABLE IF NOT EXISTS pending_deposits (
  unique_code TEXT PRIMARY KEY,
  user_id INTEGER,
  amount INTEGER,
  original_amount INTEGER,
  timestamp INTEGER,
  status TEXT,
  qr_message_id INTEGER
)`, (err) => {
  if (err) {
    logger.error('Kesalahan membuat tabel pending_deposits:', err.message);
  }
});

db.run(`CREATE TABLE IF NOT EXISTS Server (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT,
  auth TEXT,
  harga INTEGER,
  harga_reseller INTEGER,
  nama_server TEXT,
  quota INTEGER,
  iplimit INTEGER,
  batas_create_akun INTEGER,
  total_create_akun INTEGER,
  is_reseller_only INTEGER DEFAULT 0,
  support_zivpn INTEGER DEFAULT 0,
  support_udp_http INTEGER DEFAULT 0,
  service TEXT DEFAULT 'ssh'
)`, (err) => {
  if (err) {
    logger.error('Kesalahan membuat tabel Server:', err.message);
  } else {
    logger.info('Server table created or already exists');
  }
});

db.run("UPDATE Server SET total_create_akun = 0 WHERE total_create_akun IS NULL", function(err) {
  if (err) {
    logger.error('Error fixing NULL total_create_akun:', err.message);
  } else {
    if (this.changes > 0) {
      logger.info(`✅ Fixed ${this.changes} servers with NULL total_create_akun`);
    }
  }
});

db.all("PRAGMA table_info(Server)", (err, rows) => {
  if (err) {
    logger.error('Error checking Server schema:', err.message);
    return;
  }

  const cols = rows.map(r => r.name);

  db.serialize(() => {
    if (!cols.includes('support_zivpn')) {
      db.run("ALTER TABLE Server ADD COLUMN support_zivpn INTEGER DEFAULT 0");
    }
    if (!cols.includes('support_udp_http')) {
      db.run("ALTER TABLE Server ADD COLUMN support_udp_http INTEGER DEFAULT 0");
    }
    if (!cols.includes('harga_reseller')) {
      db.run("ALTER TABLE Server ADD COLUMN harga_reseller INTEGER");
    }
    if (!cols.includes('sync_host')) {
      db.run("ALTER TABLE Server ADD COLUMN sync_host TEXT");
    }
    if (!cols.includes('sync_port')) {
      db.run("ALTER TABLE Server ADD COLUMN sync_port INTEGER DEFAULT 8789");
    }
    if (!cols.includes('sync_endpoint')) {
      db.run("ALTER TABLE Server ADD COLUMN sync_endpoint TEXT DEFAULT '/internal/account-summary'");
    }
    if (!cols.includes('sync_enabled')) {
      db.run("ALTER TABLE Server ADD COLUMN sync_enabled INTEGER DEFAULT 1");
    }

    // Jalankan normalisasi setelah migrasi kolom ter-queue
    db.run("UPDATE Server SET support_zivpn = 0 WHERE support_zivpn IS NULL");
    db.run("UPDATE Server SET support_udp_http = 0 WHERE support_udp_http IS NULL");
    db.run("UPDATE Server SET support_zivpn = 1 WHERE service = 'zivpn' AND support_zivpn = 0");
    db.run("UPDATE Server SET sync_port = 8789 WHERE sync_port IS NULL OR sync_port = 0");
    db.run("UPDATE Server SET sync_endpoint = '/internal/account-summary' WHERE sync_endpoint IS NULL OR TRIM(sync_endpoint) = ''");
    db.run("UPDATE Server SET sync_enabled = 1 WHERE sync_enabled IS NULL");
  });
});
db.run(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE,
  saldo INTEGER DEFAULT 0,
  CONSTRAINT unique_user_id UNIQUE (user_id)
)`, (err) => {
  if (err) {
    logger.error('Kesalahan membuat tabel users:', err.message);
  } else {
    logger.info('Users table created or already exists');
  }
});

db.run(`CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  amount INTEGER,
  type TEXT,
  reference_id TEXT,
  timestamp INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
)`, (err) => {
  if (err) {
    logger.error('Kesalahan membuat tabel transactions:', err.message);
  } else {
    logger.info('Transactions table created or already exists');
    
    // Add reference_id column if it doesn't exist
    db.get("PRAGMA table_info(transactions)", (err, rows) => {
      if (err) {
        logger.error('Kesalahan memeriksa struktur tabel:', err.message);
        return;
      }
      
      db.get("SELECT * FROM transactions WHERE reference_id IS NULL LIMIT 1", (err, row) => {
        if (err && err.message.includes('no such column')) {
          // Column doesn't exist, add it
          db.run("ALTER TABLE transactions ADD COLUMN reference_id TEXT", (err) => {
            if (err) {
              logger.error('Kesalahan menambahkan kolom reference_id:', err.message);
            } else {
              logger.info('Kolom reference_id berhasil ditambahkan ke tabel transactions');
            }
          });
        } else if (row) {
          // Update existing transactions with reference_id
          db.all("SELECT id, user_id, type, timestamp FROM transactions WHERE reference_id IS NULL", [], (err, rows) => {
            if (err) {
              logger.error('Kesalahan mengambil transaksi tanpa reference_id:', err.message);
              return;
            }
            
            rows.forEach(row => {
              const referenceId = `account-${row.type}-${row.user_id}-${row.timestamp}`;
              db.run("UPDATE transactions SET reference_id = ? WHERE id = ?", [referenceId, row.id], (err) => {
                if (err) {
                  logger.error(`Kesalahan mengupdate reference_id untuk transaksi ${row.id}:`, err.message);
                } else {
                  logger.info(`Berhasil mengupdate reference_id untuk transaksi ${row.id}`);
                }
              });
            });
          });
        }
      });
    });
  }
});

db.run(`CREATE TABLE IF NOT EXISTS broadcast_polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  options_json TEXT NOT NULL,
  created_by INTEGER,
  created_at INTEGER,
  is_active INTEGER DEFAULT 1
)`, (err) => {
  if (err) {
    logger.error('Kesalahan membuat tabel broadcast_polls:', err.message);
  }
});

db.run(`CREATE TABLE IF NOT EXISTS broadcast_poll_votes (
  poll_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  option_index INTEGER NOT NULL,
  voted_at INTEGER,
  PRIMARY KEY (poll_id, user_id)
)`, (err) => {
  if (err) {
    logger.error('Kesalahan membuat tabel broadcast_poll_votes:', err.message);
  }
});

const userState = {};
const lastMenuMessageId = new Map();
logger.info('User state initialized');

const dbAllAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
});

const dbRunAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function onRun(err) {
    if (err) return reject(err);
    resolve(this);
  });
});

async function chargeAccountTransactionAtomic(userId, amount, type, action = 'other') {
  const referenceId = `account-${action}-${type}-${userId}-${Date.now()}`;

  try {
    await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');

    const updateResult = await dbRunAsync(
      'UPDATE users SET saldo = saldo - ? WHERE user_id = ? AND saldo >= ?',
      [amount, userId, amount]
    );

    if (!updateResult || Number(updateResult.changes || 0) === 0) {
      throw new Error('SALDO_NOT_ENOUGH_OR_USER_NOT_FOUND');
    }

    await dbRunAsync(
      'INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, ?, ?, ?)',
      [userId, amount, type, referenceId, Date.now()]
    );

    await dbRunAsync('COMMIT');
    return { ok: true, referenceId };
  } catch (error) {
    try {
      await dbRunAsync('ROLLBACK');
    } catch (_) {}
    return { ok: false, error: error?.message || 'UNKNOWN' };
  }
}

function normalizeSyncHost(rawHost) {
  const value = String(rawHost || '').trim();
  if (!value) return '';
  const cleaned = value.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  return cleaned.split('/')[0].trim();
}

function normalizeSyncEndpoint(rawEndpoint) {
  const value = String(rawEndpoint || '').trim();
  if (!value) return '/internal/account-summary';
  return value.startsWith('/') ? value : `/${value}`;
}

async function fetchTunnelAccountSummary(server) {
  const req = buildTunnelSyncRequest(server);

  let response;
  try {
    response = await axios.get(req.url, {
      timeout: 15000,
      headers: { 'x-sync-token': req.token }
    });
  } catch (error) {
    if (error.response?.data?.message) {
      throw new Error(`API summary gagal: ${error.response.data.message}`);
    }
    throw new Error(error.message || 'request gagal');
  }

  const data = response?.data || {};
  if (!data.ok) {
    throw new Error(`API summary gagal: ${data.message || 'unknown error'}`);
  }

  const ssh = Number(data.ssh || 0);
  const vmess = Number(data.vmess || 0);
  const vless = Number(data.vless || 0);
  const trojan = Number(data.trojan || 0);
  const total = Number(data.total || (ssh + vmess + vless + trojan));

  return { ssh, vmess, vless, trojan, total };
}
function buildTunnelSyncRequest(server, endpointOverride = null) {
  const host = normalizeSyncHost(server.sync_host || server.domain);
  if (!host) throw new Error('domain/sync_host server belum diisi');

  const token = String(server.auth || '').trim();
  if (!token) throw new Error('auth token server kosong');

  const port = Number(server.sync_port) || 8789;
  const summaryEndpoint = normalizeSyncEndpoint(server.sync_endpoint);
  const endpoint = endpointOverride
    ? normalizeSyncEndpoint(endpointOverride)
    : summaryEndpoint;

  return {
    host,
    token,
    port,
    summaryEndpoint,
    endpoint,
    url: `http://${host}:${port}${endpoint}`
  };
}

function parseDateExpToTimestamp(dateExp) {
  const value = String(dateExp || '').trim();
  if (!value) return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  return new Date(y, mo, d, 23, 59, 59, 999).getTime();
}

function calcRemainingDaysFromDateExp(dateExp) {
  const value = String(dateExp || '').trim();
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return 0;

  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const expDay = new Date(y, mo, d);
  const msPerDay = 24 * 60 * 60 * 1000;

  const diffDays = Math.floor((expDay.getTime() - todayStart.getTime()) / msPerDay);
  return Math.max(0, diffDays);
}

async function fetchTunnelAccountExpiryByUsername(server, username) {
  try {
    const req = buildTunnelSyncRequest(server);
    const expiryEndpoint = req.summaryEndpoint.endsWith('/account-summary')
      ? req.summaryEndpoint.replace(/account-summary$/, 'account-expiry')
      : '/internal/account-expiry';

    const response = await axios.get(`http://${req.host}:${req.port}${expiryEndpoint}`, {
      timeout: 15000,
      headers: { 'x-sync-token': req.token },
      params: { username }
    });

    const data = response?.data || {};
    if (!data.ok || !data.found) {
      return { found: false };
    }

    return {
      found: true,
      service: String(data.service || '').toLowerCase(),
      dateExp: String(data.date_exp || '').trim(),
      expiresAt: parseDateExpToTimestamp(data.date_exp)
    };
  } catch (error) {
    const msg = error?.response?.data?.message || error.message || 'request gagal';
    logger.warn(`fetchTunnelAccountExpiryByUsername gagal: ${msg}`);
    return { found: false };
  }
}

function formatDateYmdLocal(dateObj = new Date()) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function fetchTunnelExpirySummaryByDate(server, dateYmd) {
  const req = buildTunnelSyncRequest(server);
  const expirySummaryEndpoint = req.summaryEndpoint.endsWith('/account-summary')
    ? req.summaryEndpoint.replace(/account-summary$/, 'expiry-summary')
    : '/internal/expiry-summary';

  let response;
  try {
    response = await axios.get(`http://${req.host}:${req.port}${expirySummaryEndpoint}`, {
      timeout: 15000,
      headers: { 'x-sync-token': req.token },
      params: { date: dateYmd }
    });
  } catch (error) {
    if (error.response?.data?.message) {
      throw new Error(`API expiry-summary gagal: ${error.response.data.message}`);
    }
    throw new Error(error.message || 'request gagal');
  }

  const data = response?.data || {};
  if (!data.ok) {
    throw new Error(`API expiry-summary gagal: ${data.message || 'unknown error'}`);
  }

  const ssh = Number(data.ssh || 0);
  const vmess = Number(data.vmess || 0);
  const vless = Number(data.vless || 0);
  const trojan = Number(data.trojan || 0);
  const totalExpired = Number(
    data.total_expired ??
    data.total ??
    data.expired_total ??
    (ssh + vmess + vless + trojan)
  );

  return { date: dateYmd, ssh, vmess, vless, trojan, totalExpired };
}

async function syncServerUsageFromTunnel(trigger = 'manual', options = {}) {
  const targetServerId = options.serverId ? Number(options.serverId) : null;
  const force = options.force === true;
  const whereParts = ['1=1'];
  const params = [];

  if (Number.isFinite(targetServerId)) {
    whereParts.push('id = ?');
    params.push(targetServerId);
  }

  const servers = await dbAllAsync(
    `SELECT id, nama_server, domain, auth, batas_create_akun, total_create_akun,
            sync_host, sync_port, sync_endpoint, sync_enabled
     FROM Server
     WHERE ${whereParts.join(' AND ')}`,
    params
  );

  const result = {
    checked: 0,
    updated: 0,
    failed: 0,
    skipped: 0,
    errors: [],
    totals: { used: 0, remaining: 0, capacity: 0, unlimitedServers: 0, syncedServers: 0 }
  };

  const makeGroupKey = (server) => normalizeSyncHost(server.sync_host || server.domain) || (`id-${server.id}`);

  const groups = new Map();
  const skippedGroupKeys = new Set();

  for (const server of servers) {
    if (!force && !Number.isFinite(targetServerId) && Number(server.sync_enabled) === 0) {
      skippedGroupKeys.add(makeGroupKey(server));
      continue;
    }

    const key = makeGroupKey(server);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(server);
  }

  result.skipped = skippedGroupKeys.size;

  for (const groupServers of groups.values()) {
    const primary = groupServers[0];
    result.checked += 1;

    const syncAuth = String(groupServers.find((s) => String(s.auth || '').trim())?.auth || '').trim();
    const syncPort = Number(groupServers.find((s) => Number(s.sync_port) > 0)?.sync_port || primary.sync_port) || 8789;
    const syncEndpoint = normalizeSyncEndpoint(groupServers.find((s) => String(s.sync_endpoint || '').trim())?.sync_endpoint || primary.sync_endpoint);
    const summaryRequestServer = { ...primary, auth: syncAuth || primary.auth, sync_port: syncPort, sync_endpoint: syncEndpoint };

    try {
      const counts = await fetchTunnelAccountSummary(summaryRequestServer);

      for (const server of groupServers) {
        await dbRunAsync('UPDATE Server SET total_create_akun = ? WHERE id = ?', [counts.total, server.id]);
      }

      const positiveBatas = groupServers
        .map((s) => Number(s.batas_create_akun || 0))
        .filter((v) => Number.isFinite(v) && v > 0);

      const batas = positiveBatas.length > 0 ? Math.max(...positiveBatas) : 0;
      const remaining = batas > 0 ? Math.max(0, batas - counts.total) : null;

      result.updated += 1;
      result.totals.used += counts.total;
      result.totals.syncedServers += 1;

      if (remaining === null) {
        result.totals.unlimitedServers += 1;
      } else {
        result.totals.remaining += remaining;
        result.totals.capacity += batas;
      }

      logger.info(`[SyncServer:${trigger}] ${primary.nama_server} => ${counts.total}/${batas || '-'} (group ${groupServers.length} row)`);
    } catch (err) {
      result.failed += 1;
      result.errors.push({
        serverId: primary.id,
        serverName: primary.nama_server,
        message: err.message
      });
      logger.error(`[SyncServer:${trigger}] Gagal sync ${primary.nama_server}: ${err.message}`);
    }
  }

  return result;
}

// Tambah di section command, setelah command 'admin'
bot.command('edithargareseller', async (ctx) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) {
    return ctx.reply('Anda tidak memiliki izin untuk menggunakan perintah ini.');
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
    return ctx.reply('Format salah. Gunakan: /edithargareseller <domain> <harga>');
  }

  const [domain, hargaReseller] = args.slice(1);
  if (!/^\d+$/.test(hargaReseller)) {
    return ctx.reply('harga reseller harus berupa angka.');
  }

  db.run(
    'UPDATE Server SET harga_reseller = ? WHERE domain = ?',
    [parseInt(hargaReseller, 10), domain],
    function(err) {
      if (err) {
        logger.error('Error saat update harga reseller:', err.message);
        return ctx.reply('Terjadi kesalahan saat update harga reseller.');
      }
      if (this.changes === 0) {
        return ctx.reply('Server dengan domain tersebut tidak ditemukan.');
      }
      return ctx.reply(`Harga reseller untuk ${domain} berhasil diupdate ke Rp ${Number(hargaReseller).toLocaleString('id-ID')}`);
    }
  );
});

bot.command('checkpaymentconfig', async (ctx) => {
  const userId = ctx.message.from.id;
  
  // Hanya admin
  if (!adminIds.includes(userId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk menggunakan perintah ini.');
  }
  
  await ctx.reply('🔍 Memeriksa konfigurasi pembayaran...');
  
  try {
    const { buildPayload, API_URL } = require('./api-cekpayment-orkut');
    const qs = require('qs');
    const payload = buildPayload();
    const decoded = qs.parse(payload);
    
    let message = `🔧 *KONFIGURASI PEMBAYARAN*\n\n`;
    message += `📡 API URL: \`${API_URL}\`\n`;
    message += `👤 Username: \`${decoded.username}\`\n`;
    message += `🔑 Token: \`${decoded.token ? '••••••' + decoded.token.substring(decoded.token.length - 10) : 'empty'}\`\n\n`;
    
    const isDefault = decoded.username === 'yantoxxx' || 
                     (decoded.token && decoded.token.includes('xxxxx'));
    
    if (isDefault) {
      message += `❌ *STATUS: DEFAULT CREDENTIAL!*\n\n`;
      message += `⚠️ Sistem pembayaran TIDAK AKAN BEKERJA!\n\n`;
      message += `📺 *Tutorial Ambil Username & Token:*\n`;
      message += `[🎬 Klik di sini untuk lihat video tutorial](https://drive.google.com/file/d/1ugR_N5gEtcLx8TDsf7ecTFqYY3zrlHn-/view)\n\n`;
      message += `📝 *Langkah Perbaikan:*\n`;
      message += `1. Tonton video tutorial di atas\n`;
      message += `2. Login ke orderkuota.com\n`;
      message += `3. Ambil username & token API\n`;
      message += `4. Edit file: \`api-cekpayment-orkut.js\`\n`;
      message += `5. Restart bot: \`pm2 restart app\`\n\n`;
      message += `🔄 Setelah selesai, cek lagi dengan: /checkpaymentconfig`;
    } else {
      message += `✅ *STATUS: TERKONFIGURASI*\n`;
      message += `Sistem pembayaran siap digunakan.\n\n`;
      message += `📊 *Test API Connection...*\n`;
      
      try {
        const { headers } = require('./api-cekpayment-orkut');
        const response = await axios.post(API_URL, payload, { 
          headers, 
          timeout: 8000 
        });
        
        const blocks = response.data.split('------------------------').filter(Boolean);
        message += `✅ Berhasil: ${blocks.length} transaksi ditemukan\n`;
        message += `🎉 Sistem pembayaran AKTIF dan bekerja!`;
        
      } catch (apiError) {
        message += `❌ *Test GAGAL:* ${apiError.message}\n`;
        message += `Periksa koneksi atau credential.`;
      }
    }
    
    await ctx.reply(message, { parse_mode: 'Markdown', disable_web_page_preview: false });
    
  } catch (error) {
    await ctx.reply(
      `❌ *Gagal memeriksa:*\n\`${error.message}\``,
      { parse_mode: 'Markdown' }
    );
  }
});


bot.command('syncservernow', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
    return ctx.reply('Anda tidak memiliki izin untuk menggunakan perintah ini.');
  }

  try {
    await ctx.reply('Menjalankan sinkronisasi server...');
    const result = await syncServerUsageFromTunnel('manual_command', { force: true });

    const lines = [
      'Sync server selesai.',
      `Dicek: ${result.checked}`,
      `Berhasil: ${result.updated}`,
      `Gagal: ${result.failed}`,
      `Dilewati: ${result.skipped}`,
      '',
      `Total akun aktif: ${result.totals.used}`,
      `Total akun tersisa: ${result.totals.remaining}`,
      `Total kapasitas: ${result.totals.capacity}`
    ];

    if (result.errors.length > 0) {
      const preview = result.errors.slice(0, 5)
        .map((e) => `- ${e.serverName || e.serverId}: ${e.message}`)
        .join('\n');
      lines.push('', 'Detail gagal (maks 5):', preview);
    }

    await ctx.reply(lines.join('\n'));
  } catch (err) {
    logger.error('Gagal menjalankan sync server manual:', err.message);
    await ctx.reply('Gagal menjalankan sinkronisasi server.');
  }
});
// =================== COMMAND HAPUS SALDO ===================
bot.command('hapussaldo', async (ctx) => {
  try {
    const adminId = ctx.from.id;
    
    // Hanya admin
    if (!adminIds.includes(adminId)) {
      return ctx.reply('❌ *Hanya admin yang bisa menggunakan command ini!*', { parse_mode: 'Markdown' });
    }
    
    const args = ctx.message.text.trim().split(/\s+/);
    if (args.length !== 3) {
      return ctx.reply('❌ *Format salah!*\n\nGunakan:\n`/hapussaldo <user_id> <jumlah>`\n\nContoh:\n`/hapussaldo 123456789 50000`', { parse_mode: 'Markdown' });
    }
    
    const targetUserId = args[1].trim();
    const amount = parseInt(args[2], 10);
    
    if (isNaN(amount) || amount <= 0) {
      return ctx.reply('❌ *Jumlah harus angka positif lebih dari 0!*', { parse_mode: 'Markdown' });
    }
    
    // Cek apakah user ada
    db.get('SELECT user_id, saldo FROM users WHERE user_id = ?', [targetUserId], (err, user) => {
      if (err) {
        logger.error('❌ Error cek user:', err.message);
        return ctx.reply('❌ Terjadi kesalahan saat memeriksa user.');
      }
      
      if (!user) {
        return ctx.reply(`❌ *User dengan ID ${targetUserId} tidak ditemukan!*`, { parse_mode: 'Markdown' });
      }
      
      // Cek apakah saldo mencukupi
      if (user.saldo < amount) {
        return ctx.reply(`❌ *Saldo user tidak mencukupi!*\n\nSaldo user: Rp ${user.saldo.toLocaleString('id-ID')}\nJumlah hapus: Rp ${amount.toLocaleString('id-ID')}\nKekurangan: Rp ${(amount - user.saldo).toLocaleString('id-ID')}`, { 
          parse_mode: 'Markdown' 
        });
      }
      
      // Lakukan pengurangan saldo
      db.run('UPDATE users SET saldo = saldo - ? WHERE user_id = ?', [amount, targetUserId], function (err) {
        if (err) {
          logger.error('❌ Error hapus saldo:', err.message);
          return ctx.reply('❌ Gagal menghapus saldo.');
        }
        
        if (this.changes === 0) {
          return ctx.reply('⚠️ Tidak ada user yang diupdate. Pastikan ID benar.');
        }
        
        // Ambil saldo terbaru
        db.get('SELECT saldo FROM users WHERE user_id = ?', [targetUserId], (err2, updatedRow) => {
          if (err2) {
            ctx.reply(`✅ Saldo sebesar *Rp ${amount.toLocaleString('id-ID')}* berhasil dihapus dari user \`${targetUserId}\`.`);
          } else {
            ctx.reply(
              `✅ Saldo sebesar *Rp ${amount.toLocaleString('id-ID')}* berhasil dihapus dari user \`${targetUserId}\`.\n💰 Saldo user sekarang: *Rp ${updatedRow.saldo.toLocaleString('id-ID')}*`,
              { parse_mode: 'Markdown' }
            );
          }
          
          // Log ke transactions
          const referenceId = `remove_saldo_${targetUserId}_${Date.now()}`;
          db.run(
            'INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, ?, ?, ?)',
            [targetUserId, amount, 'saldo_removed', referenceId, Date.now()],
            (err3) => {
              if (err3) logger.error('Gagal log transaksi hapus saldo:', err3.message);
            }
          );
          
          // Log di filestat
          logger.info(`Admin ${adminId} menghapus saldo Rp${amount} dari user ${targetUserId}. Saldo akhir: Rp${updatedRow ? updatedRow.saldo : 'N/A'}`);
        });
      });
    });
    
  } catch (e) {
    logger.error('❌ Error in /hapussaldo:', e);
    return ctx.reply('❌ Terjadi kesalahan internal.');
  }
});

//resellerstat
bot.command('resellerstats', async (ctx) => {
  try {
    const userId = ctx.from.id;
    
    // Cek apakah user reseller
    const isReseller = await isUserReseller(userId);
    
    if (!isReseller) {
      return ctx.reply('❌ *Fitur ini hanya untuk reseller!*', { parse_mode: 'Markdown' });
    }
    
    // Ambil saldo user
    db.get('SELECT saldo FROM users WHERE user_id = ?', [userId], async (err, user) => {
      if (err) {
        logger.error('❌ Error ambil saldo:', err.message);
        return ctx.reply('❌ Terjadi kesalahan saat mengambil data.');
      }
      
      const saldo = user ? user.saldo : 0;
      
      // Hitung tanggal awal dan akhir bulan ini
      const now = new Date();
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      
      const startTimestamp = firstDay.getTime();
      const endTimestamp = lastDay.getTime();
      
      // Query transaksi bulan ini
      const query = `
        SELECT type, COUNT(*) as count, SUM(amount) as total 
        FROM transactions 
        WHERE user_id = ? 
          AND timestamp >= ? 
          AND timestamp <= ?
          AND type IN ('ssh', 'vmess', 'vless', 'trojan', 'shadowsocks', 'zivpn', 'udp_http')
          AND reference_id NOT LIKE 'account-trial-%'
        GROUP BY type
      `;
      
      db.all(query, [userId, startTimestamp, endTimestamp], async (err, rows) => {
        if (err) {
          logger.error('❌ Error ambil transaksi:', err.message);
          return ctx.reply('❌ Terjadi kesalahan saat mengambil transaksi.');
        }
        
        const totalTopup = await new Promise((resolve) => {
          db.get(
            `SELECT SUM(amount) as total FROM transactions
             WHERE user_id = ? AND timestamp >= ? AND timestamp <= ? AND type = 'deposit'`,
            [userId, startTimestamp, endTimestamp],
            (err2, row2) => resolve(!err2 && row2 && row2.total ? row2.total : 0)
          );
        });

        // Hitung total akun bulan ini
        let totalAccounts = 0;
        let totalRevenue = 0;
        const typeDetails = [];
        
        rows.forEach(row => {
          totalAccounts += row.count;
          totalRevenue += row.total || 0;
          const safeType = row.type.toUpperCase().replace(/_/g, '\\_');
          typeDetails.push(`• ${safeType}: ${row.count} akun`);
        });
        
        // Format pesan
        const monthNames = ["Januari", "Februari", "Maret", "April", "Mei", "Juni",
                          "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
        const currentMonth = monthNames[now.getMonth()];
        const currentYear = now.getFullYear();
        
        const message = 
          `📊 *STATISTIK RESELLER*\n` +
          `📅 Periode: ${currentMonth} ${currentYear}\n` +
          `👤 ID Reseller: ${userId}\n\n` +
          `💰 *Saldo Saat Ini:* Rp ${saldo.toLocaleString('id-ID')}\n` +
          `💳 *Top Up Bulan Ini:* Rp ${totalTopup.toLocaleString('id-ID')}\n\n` +
          `📈 *AKTIVITAS BULAN INI:*\n` +
          (typeDetails.length > 0 ? typeDetails.join('\n') : '• Belum ada transaksi') + `\n\n` +
          `📊 *TOTAL BULAN INI:*\n` +
          `• Jumlah Akun: ${totalAccounts} akun\n` +
          `• Total Pendapatan: Rp ${totalRevenue.toLocaleString('id-ID')}\n\n` +
          `📌 *Catatan:*\n` +
          `• Data diambil dari 1 ${currentMonth} ${currentYear}\n` +
          `• Hanya menampilkan transaksi pembuatan/perpanjangan akun\n` +
          `• Update real-time setiap transaksi`;
        
        await ctx.reply(message, { parse_mode: 'Markdown' });
        
        // Log
        logger.info(`📊 Stats reseller ditampilkan untuk ${userId}: ${totalAccounts} akun bulan ini`);
      });
    });
    
  } catch (error) {
    logger.error('❌ Error di /resellerstats:', error);
    await ctx.reply('❌ Terjadi kesalahan saat memproses permintaan.');
  }
});

//allreseller stat
bot.command('allresellerstats', async (ctx) => {
  try {
    const adminId = ctx.from.id;
    
    // Hanya admin
    if (!adminIds.includes(adminId)) {
      return ctx.reply('❌ Hanya admin yang bisa menggunakan command ini!');
    }
    
    // Ambil semua user yang reseller
    const resellers = listResellersSync();
    
    if (resellers.length === 0) {
      return ctx.reply('📭 Belum ada reseller terdaftar.');
    }
    
    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const startTimestamp = firstDay.getTime();
    const endTimestamp = lastDay.getTime();
    
    // Mulai buat pesan HTML
    let message = `<b>📊 STATISTIK SEMUA RESELLER</b>\n`;
    message += `<i>📅 Periode: ${escapeHtml(now.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' }))}</i>\n\n`;
    
    // Total semua
    let totalAllAccounts = 0;
    let totalAllRevenue = 0;
    let totalAllTopup = 0;
    
    const resellerStats = [];

    // Loop melalui setiap reseller
    for (const resellerId of resellers) {
      // Ambil saldo
      const user = await new Promise((resolve) => {
        db.get('SELECT saldo FROM users WHERE user_id = ?', [resellerId], (err, row) => {
          resolve(row || { saldo: 0 });
        });
      });
      
      // Ambil transaksi bulan ini
      const transactions = await new Promise((resolve) => {
        db.all(
          `SELECT COUNT(*) as count, SUM(amount) as total FROM transactions 
           WHERE user_id = ? AND timestamp >= ? AND timestamp <= ? 
           AND type IN ('ssh', 'vmess', 'vless', 'trojan', 'shadowsocks', 'zivpn', 'udp_http')
           AND reference_id NOT LIKE 'account-trial-%'`,
          [resellerId, startTimestamp, endTimestamp],
          (err, rows) => {
            resolve(rows[0] || { count: 0, total: 0 });
          }
        );
      });

      const topupTotal = await new Promise((resolve) => {
        db.get(
          `SELECT SUM(amount) as total FROM transactions
           WHERE user_id = ? AND timestamp >= ? AND timestamp <= ? AND type = 'deposit'`,
          [resellerId, startTimestamp, endTimestamp],
          (err, row) => resolve(!err && row && row.total ? row.total : 0)
        );
      });
      
      // Tambah ke total
      totalAllAccounts += transactions.count;
      totalAllRevenue += transactions.total || 0;
      totalAllTopup += topupTotal;

      resellerStats.push({
        resellerId,
        saldo: user.saldo || 0,
        count: transactions.count || 0,
        total: transactions.total || 0,
        topup: topupTotal || 0
      });
    }

    resellerStats.sort((a, b) => b.total - a.total);

    const parts = [];
    const header = message;
    let current = header;

    for (const stat of resellerStats) {
      let usernameText = '-';
      try {
        const username = await getUsernameById(stat.resellerId);
        usernameText = username ? `@${username.replace(/^@/, '')}` : '-';
      } catch (e) {
        usernameText = '-';
      }
      const displayId = `<code>${stat.resellerId}</code>`;
      const entry =
        `<b>👤 Username:</b> ${escapeHtml(usernameText)}\n` +
        `<b>🆔 ID:</b> ${displayId}\n` +
        `<code>💰 Saldo:</code> Rp ${stat.saldo.toLocaleString('id-ID')}\n` +
        `<code>📊 Akun Bulan Ini:</code> ${stat.count}\n` +
        `<code>💵 Pendapatan:</code> Rp ${stat.total.toLocaleString('id-ID')}\n` +
        `<code>💳 Top Up Bulan Ini:</code> Rp ${stat.topup.toLocaleString('id-ID')}\n` +
        `────────────────────\n`;

      if ((current + entry).length > 3900) {
        parts.push(current);
        current = `${header}\n<i>(lanjutan)</i>\n\n` + entry;
      } else {
        current += entry;
      }
    }
    
    // Tambahkan summary
    const totalResellers = resellers.length;
    const summary =
      `\n<b>📈 RINGKASAN:</b>\n` +
      `• <b>Total Reseller:</b> ${totalResellers} orang\n` +
      `• <b>Total Akun Bulan Ini:</b> ${totalAllAccounts} akun\n` +
      `• <b>Total Pendapatan:</b> Rp ${totalAllRevenue.toLocaleString('id-ID')}\n` +
      `• <b>Total Top Up:</b> Rp ${totalAllTopup.toLocaleString('id-ID')}\n` +
      `• <b>Periode:</b> ${escapeHtml(now.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' }))}\n` +
      `• <b>Update:</b> ${escapeHtml(now.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' }))}`;

    if ((current + summary).length > 3900) {
      parts.push(current);
      current = `${header}\n<i>(ringkasan)</i>\n\n` + summary;
    } else {
      current += summary;
    }

    if (current.trim().length > 0) {
      parts.push(current);
    }

    // Kirim semua part
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) await new Promise(resolve => setTimeout(resolve, 500));
      await ctx.reply(parts[i], { parse_mode: 'HTML' });
    }
    
    logger.info(`📊 Admin ${adminId} melihat statistik semua reseller`);
    
  } catch (error) {
    logger.error('❌ Error di /allresellerstats:', error);
    await ctx.reply('❌ Terjadi kesalahan saat memproses permintaan.');
  }
});

// ✅ FUNGSI UNTUK ESCAPE HTML (untuk aman)
function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function getResellerStatsForPeriod(userId, startTimestamp, endTimestamp) {
  return new Promise((resolve) => {
    db.get(
      `SELECT COUNT(*) as count
       FROM transactions
       WHERE user_id = ?
        AND timestamp >= ?
        AND timestamp <= ?
        AND type IN ('ssh', 'vmess', 'vless', 'trojan', 'shadowsocks', 'zivpn', 'udp_http')
        AND reference_id NOT LIKE 'account-trial-%'`,
      [userId, startTimestamp, endTimestamp],
      (err, row) => {
        const count = !err && row ? row.count : 0;
        db.get(
          `SELECT SUM(amount) as total
           FROM transactions
           WHERE user_id = ?
             AND timestamp >= ?
             AND timestamp <= ?
             AND type = 'deposit'`,
          [userId, startTimestamp, endTimestamp],
          (err2, row2) => {
            const total = !err2 && row2 && row2.total ? row2.total : 0;
            resolve({ count, topup: total });
          }
        );
      }
    );
  });
}

async function evaluateResellerTermsForPeriod(startTimestamp, endTimestamp, periodLabel) {
  const terms = loadResellerTerms();
  const resellers = listResellersSync();
  if (resellers.length === 0) return;

  for (const resellerId of resellers) {
    const stats = await getResellerStatsForPeriod(resellerId, startTimestamp, endTimestamp);
    const failedTopup = stats.topup < terms.min_topup;

    if (failedTopup) {
      removeReseller(resellerId);
      const message =
        `Syarat reseller bulan ${periodLabel} tidak terpenuhi.\n\n` +
        `Top up: ${formatRupiah(stats.topup)} (minimal ${formatRupiah(terms.min_topup)})\n\n` +
        'Status reseller dinonaktifkan. Untuk aktif kembali, hubungi admin.';
      try {
        await bot.telegram.sendMessage(resellerId, message);
      } catch (err) {
        logger.error('Gagal kirim notifikasi demote reseller:', err.message);
      }
      logger.info(`Reseller ${resellerId} diturunkan karena tidak memenuhi syarat bulan ${periodLabel}`);
    }
  }
}

////
bot.command('addserverzivpn_reseller', async (ctx) => {
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('⚠️ Tidak ada izin.');
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 8) {
    return ctx.reply(
      '⚠️ Format:\n`/addserverzivpn_reseller <domain> <auth> <harga> <nama_server> <quota> <iplimit> <batas_create_akun>`',
      { parse_mode: 'Markdown' }
    );
  }

  const [, domain, auth, harga, nama_server, quota, iplimit, batas] = args;

  if (![harga, quota, iplimit, batas].every(v => /^\d+$/.test(v))) {
    return ctx.reply('⚠️ harga, quota, iplimit, batas harus angka.');
  }

  db.run(
    `INSERT INTO Server
     (domain, auth, harga, nama_server, quota, iplimit, batas_create_akun, total_create_akun, is_reseller_only, support_zivpn, support_udp_http, service)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, 1, 0, 'ssh')`,
    [
      domain,
      auth,
      parseInt(harga),
      nama_server,
      parseInt(quota),
      parseInt(iplimit),
      parseInt(batas)
    ],
    (err) => {
      if (err) {
        logger.error(err.message);
        return ctx.reply('❌ Gagal menambahkan server ZIVPN reseller.');
      }

      ctx.reply(`✅ Server *ZIVPN Reseller* \`${nama_server}\` berhasil ditambahkan.`, {
        parse_mode: 'Markdown'
      });
    }
  );
});

//////
bot.command(['start', 'menu'], async (ctx) => {
  logger.info('Start or Menu command received');
  
  const userId = ctx.from.id;
  // hapus pesan /start atau /menu agar tidak menumpuk
  if (ctx.message && ctx.message.text && (ctx.message.text.startsWith('/start') || ctx.message.text.startsWith('/menu'))) {
    try {
      await ctx.deleteMessage();
    } catch (e) {
      // ignore jika tidak bisa dihapus
    }
  }
  ctx.state = ctx.state || {};
  ctx.state.forceNewMenu = true;
  db.get('SELECT * FROM users WHERE user_id = ?', [userId], (err, row) => {
    if (err) {
      logger.error('Kesalahan saat memeriksa user_id:', err.message);
      return;
    }

    if (row) {
      logger.info(`User ID ${userId} sudah ada di database`);
    } else {
      db.run('INSERT INTO users (user_id) VALUES (?)', [userId], (err) => {
        if (err) {
          logger.error('Kesalahan saat menyimpan user_id:', err.message);
        } else {
          logger.info(`User ID ${userId} berhasil disimpan`);
        }
      });
    }
  });

  await sendMainMenu(ctx);
});

cleanupExpiredAccounts();
////////////////
// Manual admin command: /addsaldo <user_id> <jumlah>
bot.command('addsaldo', async (ctx) => {
  try {
    const userId = ctx.message.from.id;

    // hanya admin
    if (!adminIds || !adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.');
    }

    const args = ctx.message.text.trim().split(/\s+/);
    if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah.\nGunakan:\n`/addsaldo <user_id> <jumlah>`', { parse_mode: 'Markdown' });
    }

    const targetUserId = args[1].trim();
    const amount = parseInt(args[2], 10);

    if (isNaN(amount) || amount <= 0) {
      return ctx.reply('⚠️ Jumlah saldo harus berupa angka dan lebih dari 0.');
    }

    // Cek apakah user ada
    db.get('SELECT saldo FROM users WHERE user_id = ?', [targetUserId], (err, row) => {
      if (err) {
        logger.error('❌ Gagal memeriksa user_id:', err.message);
        return ctx.reply('❌ Terjadi kesalahan saat memeriksa user.');
      }

      if (!row) {
        return ctx.reply(`⚠️ User dengan ID ${targetUserId} belum terdaftar di database.`);
      }

      // Lakukan update saldo
      db.run('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', [amount, targetUserId], function (err) {
        if (err) {
          logger.error('❌ Gagal menambah saldo:', err.message);
          return ctx.reply('❌ Gagal menambah saldo.');
        }

        // pastikan ada perubahan (this.changes tersedia karena function)
        if (this.changes === 0) {
          return ctx.reply('⚠️ Tidak ada user yang diupdate. Pastikan ID benar.');
        }

// Ambil saldo terbaru dan kirim ke Telegram + log
db.get('SELECT saldo FROM users WHERE user_id = ?', [targetId], (err2, updatedRow) => {
  if (err2 || !updatedRow) {
    logger.info(`Admin ${ctx.from.id} menambah saldo Rp${amount} ke user ${targetId}, namun gagal membaca saldo terbaru.`);
    return ctx.reply(`✅ Saldo sebesar Rp${amount.toLocaleString()} berhasil ditambahkan ke user ${targetId}.`);
  }

          // Kirim pesan ke Telegram dengan saldo akhir
          ctx.reply(
            `✅ Saldo sebesar *Rp${amount.toLocaleString()}* berhasil ditambahkan ke user \`${targetUserId}\`.\n💰 Saldo user sekarang: *Rp${updatedRow.saldo.toLocaleString()}*`,
            { parse_mode: 'Markdown' }
          );

          // Log di file
          logger.info(`Admin ${ctx.from.id} menambah saldo Rp${amount} ke user ${targetUserId}. Saldo user sekarang: Rp${updatedRow.saldo}`);
        });
      });
    });
  } catch (e) {
    logger.error('❌ Error in /addsaldo command:', e);
    return ctx.reply('❌ Terjadi kesalahan internal saat memproses perintah.');
  }
});

//////////////////
bot.command('admin', async (ctx) => {
  logger.info('Admin menu requested');
  
  if (!adminIds.includes(ctx.from.id)) {
    await ctx.reply('🚫 Anda tidak memiliki izin untuk mengakses menu admin.');
    return;
  }

  await sendAdminMenu(ctx);
});

async function sendMainMenu(ctx) {
  // Ambil data user
  const userId = ctx.from.id;
  const userName = ctx.from.first_name || '-';
  let saldo = 0;
  try {
    const row = await new Promise((resolve, reject) => {
      db.get('SELECT saldo FROM users WHERE user_id = ?', [userId], (err, row) => {
        if (err) reject(err); else resolve(row);
      });
    });
    saldo = row ? row.saldo : 0;
  } catch (e) { saldo = 0; }

  // Statistik user
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay()).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  let userToday = 0, userWeek = 0, userMonth = 0;
  let globalToday = 0, globalWeek = 0, globalMonth = 0;
  try {
    userToday = await new Promise((resolve) => {
      db.get(
        'SELECT COUNT(*) as count FROM transactions WHERE user_id = ? AND timestamp >= ? AND type IN ("ssh","vmess","vless","trojan","shadowsocks","udp_http","zivpn") AND reference_id NOT LIKE "account-trial-%"',
        [userId, todayStart],
        (err, row) => resolve(row ? row.count : 0)
      );
    });
    userWeek = await new Promise((resolve) => {
      db.get(
        'SELECT COUNT(*) as count FROM transactions WHERE user_id = ? AND timestamp >= ? AND type IN ("ssh","vmess","vless","trojan","shadowsocks","udp_http","zivpn") AND reference_id NOT LIKE "account-trial-%"',
        [userId, weekStart],
        (err, row) => resolve(row ? row.count : 0)
      );
    });
    userMonth = await new Promise((resolve) => {
      db.get(
        'SELECT COUNT(*) as count FROM transactions WHERE user_id = ? AND timestamp >= ? AND type IN ("ssh","vmess","vless","trojan","shadowsocks","udp_http","zivpn") AND reference_id NOT LIKE "account-trial-%"',
        [userId, monthStart],
        (err, row) => resolve(row ? row.count : 0)
      );
    });
    globalToday = await new Promise((resolve) => {
      db.get(
        'SELECT COUNT(*) as count FROM transactions WHERE timestamp >= ? AND type IN ("ssh","vmess","vless","trojan","shadowsocks","udp_http","zivpn") AND reference_id NOT LIKE "account-trial-%"',
        [todayStart],
        (err, row) => resolve(row ? row.count : 0)
      );
    });
    globalWeek = await new Promise((resolve) => {
      db.get(
        'SELECT COUNT(*) as count FROM transactions WHERE timestamp >= ? AND type IN ("ssh","vmess","vless","trojan","shadowsocks","udp_http","zivpn") AND reference_id NOT LIKE "account-trial-%"',
        [weekStart],
        (err, row) => resolve(row ? row.count : 0)
      );
    });
    globalMonth = await new Promise((resolve) => {
      db.get(
        'SELECT COUNT(*) as count FROM transactions WHERE timestamp >= ? AND type IN ("ssh","vmess","vless","trojan","shadowsocks","udp_http","zivpn") AND reference_id NOT LIKE "account-trial-%"',
        [monthStart],
        (err, row) => resolve(row ? row.count : 0)
      );
    });
  } catch (e) {}

  // Jumlah pengguna bot
  let jumlahPengguna = 0;
  
  // Cek status reseller - GUNAKAN VARIABLE YANG SUDAH ADA
  let isReseller = false;
  if (fs.existsSync(resselFilePath)) {
    const resellerList = fs.readFileSync(resselFilePath, 'utf8').split('\n').map(x => x.trim());
    isReseller = resellerList.includes(userId.toString());
  }
  const statusReseller = isReseller ? 'Reseller' : 'Bukan Reseller';
  
  try {
    const row = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) AS count FROM users', (err, row) => { if (err) reject(err); else resolve(row); });
    });
    jumlahPengguna = row.count;
  } catch (e) { jumlahPengguna = 0; }

  // Latency (dummy, bisa diubah sesuai kebutuhan)
  const latency = (Math.random() * 0.1 + 0.01).toFixed(2);

  const messageText = `
<code>╔═══════════════════════╗</code>
<b>  🤖 BOT VPN ${NAMA_STORE}</b>
<code>╚═══════════════════════╝</code>

<code>╔═══════════════════════╗</code>
<b>  👤 PROFIL PENGGUNA</b>
<code>╠═══════════════════════╣</code>
<b>  👤 Nama  :</b> ${userName}
<b>  🆔 ID    :</b> <code>${userId}</code>
<b>  💰 Saldo :</b> <code>Rp ${saldo.toLocaleString('id-ID')}</code>
<b>  🏷️ Status :</b> ${statusReseller}
<code>╚═══════════════════════╝</code>

<code>╔═══════════════════════╗</code>
<b>  📊 STATISTIK AKUN ANDA</b>
<code>╠═══════════════════════╣</code>
<b>  📅 Hari Ini   :</b> ${userToday} akun
<b>  📆 Minggu Ini :</b> ${userWeek} akun  
<b>  🗓️ Bulan Ini  :</b> ${userMonth} akun
<code>╚═══════════════════════╝</code>

<code>╔═══════════════════════╗</code>
<b>  🌍 STATISTIK GLOBAL</b>
<code>╠═══════════════════════╣</code>
<b>  📅 Hari Ini   :</b> ${globalToday} akun
<b>  📆 Minggu Ini :</b> ${globalWeek} akun
<b>  🗓️ Bulan Ini  :</b> ${globalMonth} akun
<code>╚═══════════════════════╝</code>

<code>╔═══════════════════════╗</code>
<b>  ⚙️ STATUS SISTEM</b>
<code>╠═══════════════════════╣</code>
<b>  👥 Users   :</b> ${jumlahPengguna}
<b>  ⏱️ Latency :</b> ${latency} ms
<b>  🛠️ Versi  :</b> v2.0 Fixed
<code>╚═══════════════════════╝</code>
`;

  // Buat keyboard dasar untuk semua user
  let keyboard = [
    [
      { text: '🛒 Buat Akun', callback_data: 'service_create' },
      { text: '🎁 Trial Gratis', callback_data: 'service_trial' }
    ],
    [
      { text: '🔄 Perpanjang Akun', callback_data: 'service_renew' },
      { text: '📋 Akun Saya', callback_data: 'view_accounts' }
    ],
    [
      { text: '🗑️ Hapus Akun', callback_data: 'delete_my_account_intro' },
      { text: '⏰ Cek Expired', callback_data: 'check_expiry_account' }
    ],
    [
      { text: '🧰 Tools & Utilitas', callback_data: 'menu_tools' },
      { text: '📞 Hubungi Admin', callback_data: 'hubungi_admin' }
    ],
    [
      { text: '🤝 Daftar Reseller - Harga Lebih Hemat!', callback_data: 'jadi_reseller' }
    ],
  ];

  if (loadTopupAutoSetting()) {
    const topupIndex = keyboard.findIndex(row =>
      row.some(btn => btn.callback_data === 'topup_saldo')
    );
    const autoRow = [{ text: '💰 TopUp Saldo Otomatis', callback_data: 'topup_saldo' }];
    if (topupIndex === -1) {
      keyboard.splice(4, 0, autoRow);
    }
  }

  if (loadTopupManualSetting()) {
    const topupIndex = keyboard.findIndex(row =>
      row.some(btn => btn.callback_data === 'topup_saldo')
    );
    const manualRow = [{ text: '💰 TopUp Saldo Manual via (QRIS)', callback_data: 'topup_manual' }];
    if (topupIndex === -1) {
      keyboard.push(manualRow);
    } else {
      keyboard.splice(topupIndex + 1, 0, manualRow);
    }
  }
  // Jika user adalah reseller, tambahkan tombol khusus
  if (isReseller) {
    // Letakkan menu reseller tepat di bawah baris Tools + Hubungi Admin
    keyboard.splice(3, 0, [
      { text: '🔓 Buka Kunci Akun', callback_data: 'service_unlock' },
      { text: '🔒 Kunci Akun', callback_data: 'service_lock' }
    ]);
    keyboard.splice(4, 0, [
      { text: '📊 Statistik Reseller Saya', callback_data: 'reseller_stats' }
    ]);

    logger.info('🛡️ Menu reseller ditampilkan untuk user: ' + userId);
  }

  try {
    if (ctx.updateType === 'callback_query') {
      try {
        await ctx.editMessageText(messageText, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: keyboard }
        });
        if (ctx.callbackQuery && ctx.callbackQuery.message) {
          lastMenuMessageId.set(userId, ctx.callbackQuery.message.message_id);
        }
      } catch (error) {
        if (error && error.response && error.response.error_code === 400 &&
            (error.response.description.includes('message is not modified') ||
             error.response.description.includes('message to edit not found') ||
             error.response.description.includes('message can\'t be edited'))
        ) {
          logger.info('Edit message diabaikan karena pesan sudah diedit/dihapus atau tidak berubah.');
        } else {
          logger.error('Error saat mengedit menu utama:', error);
        }
      }
    } else {
      try {
        const forceNewMenu = ctx.state && ctx.state.forceNewMenu;
        const isStartCommand = forceNewMenu || (ctx.message && typeof ctx.message.text === 'string' && (ctx.message.text.startsWith('/start') || ctx.message.text.startsWith('/menu')));
        if (isStartCommand) {
          if (lastMenuMessageId.has(userId)) {
            try {
              await ctx.telegram.deleteMessage(userId, lastMenuMessageId.get(userId));
            } catch (e) {
              // ignore if cannot delete
            }
          }
          const sent = await ctx.reply(messageText, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard }
          });
          if (sent && sent.message_id) {
            lastMenuMessageId.set(userId, sent.message_id);
          }
          logger.info('Main menu sent');
          return;
        }

        if (lastMenuMessageId.has(userId)) {
          try {
            await ctx.telegram.editMessageText(
              userId,
              lastMenuMessageId.get(userId),
              null,
              messageText,
              { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
            );
          } catch (e) {
            // fallback: hapus lama lalu kirim baru
            try {
              await ctx.telegram.deleteMessage(userId, lastMenuMessageId.get(userId));
            } catch (delErr) {
              // ignore jika tidak bisa dihapus
            }
            const sent = await ctx.reply(messageText, {
              parse_mode: 'HTML',
              reply_markup: { inline_keyboard: keyboard }
            });
            if (sent && sent.message_id) {
              lastMenuMessageId.set(userId, sent.message_id);
            }
          }
        } else {
          const sent = await ctx.reply(messageText, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard }
          });
          if (sent && sent.message_id) {
            lastMenuMessageId.set(userId, sent.message_id);
          }
        }
      } catch (error) {
        logger.error('Error saat mengirim menu utama:', error);
      }
    }
    logger.info('Main menu sent');
  } catch (error) {
    logger.error('Error umum saat mengirim menu utama:', error);
  }
}

bot.command('hapuslog', async (ctx) => {
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Tidak ada izin!');
  try {
    if (fs.existsSync('bot-combined.log')) fs.unlinkSync('bot-combined.log');
    if (fs.existsSync('bot-error.log')) fs.unlinkSync('bot-error.log');
    ctx.reply('Log berhasil dihapus.');
    logger.info('Log file dihapus oleh admin.');
  } catch (e) {
    ctx.reply('Gagal menghapus log: ' + e.message);
    logger.error('Gagal menghapus log: ' + e.message);
  }
});

bot.command('restartserver', async (ctx) => {
  const userId = ctx.from?.id;
  if (!adminIds.includes(userId)) {
    return ctx.reply('Tidak ada izin!');
  }

  const rawTarget = (ctx.message?.text || '').split(' ').slice(1).join(' ').trim();
  const defaultTarget = process.env.pm_id || process.env.name || 'all';
  const target = rawTarget || String(defaultTarget);

  if (!/^[a-zA-Z0-9_.-]+$/.test(target)) {
    return ctx.reply('Target restart tidak valid. Gunakan nama app PM2 atau id numerik.');
  }

  await ctx.reply('Menjalankan restart PM2: ' + target);

  exec('pm2 restart ' + target, (error, stdout, stderr) => {
    if (error) {
      logger.error('Gagal restart PM2 via Telegram: ' + error.message);
      return ctx.reply('Gagal restart PM2: ' + error.message);
    }

    const output = [stdout, stderr].filter(Boolean).join('\n').trim();
    const safeOutput = output ? output.slice(0, 1200) : 'OK';
    return ctx.reply('Restart PM2 berhasil.\n' + safeOutput);
  });
});

async function sendHelpAdmin(ctx) {
  const userId = ctx.from?.id;
  if (!adminIds.includes(userId)) {
    return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }
  
  const helpMessage = `
*📋 Daftar Perintah Admin:*

1. /addsaldo - Menambahkan saldo ke akun pengguna.
2. /hapussaldo - Menghapus saldo dari akun pengguna.
3. /addserver - Menambahkan server baru.
4. /addressel - Menambahkan Reseller baru.
5. /delressel - Menghapus id Reseller.
6. /broadcast - Mengirim pesan siaran ke semua pengguna.
7. /editharga - Mengedit harga layanan.
8. /editauth - Mengedit auth server.
9. /editdomain - Mengedit domain server.
10. /editlimitcreate - Mengedit batas pembuatan akun server.
11. /editlimitip - Mengedit batas IP server.
12. /editlimitquota - Mengedit batas quota server.
13. /editnama - Mengedit nama server.
14. /edittotalcreate - Mengedit total pembuatan akun server.
15. /hapuslog - Menghapus log bot.
16. /allresellerstats - Ambil data statistik pembuatan semua reseller
17. /resellerstats - Ambil data statistik saya
18. /checkpaymentconfig - Ngecek konfigurasi file api-payment-outkut.js\n19. /restartserver [target] - Restart app PM2 dari Telegram

Gunakan perintah ini dengan format yang benar untuk menghindari kesalahan.
`;
  ctx.reply(helpMessage, { parse_mode: 'Markdown' });
}

bot.command('helpadmin', async (ctx) => {
  await sendHelpAdmin(ctx);
});

//////////
bot.command('addserver_reseller', async (ctx) => {
  try {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 7) {
      return ctx.reply('⚠️ Format salah!\n\nGunakan:\n/addserver_reseller <domain> <auth> <harga> <nama_server> <quota> <iplimit> <batas_create_akun>');
    }

    const [domain, auth, harga, nama_server, quota, iplimit, batas_create_akun] = args;
    
    // ✅ TAMBAHKAN total_create_akun di VALUES
    db.run(`INSERT INTO Server (domain, auth, harga, nama_server, quota, iplimit, batas_create_akun, is_reseller_only, total_create_akun, support_zivpn, support_udp_http, service) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0, 0, 'ssh')`,
      [domain, auth, harga, nama_server, quota, iplimit, batas_create_akun],
      function (err) {
        if (err) {
          logger.error('❌ Gagal menambah server reseller:', err.message);
          return ctx.reply('❌ *Gagal menambah server reseller.*', { parse_mode: 'Markdown' });
        }
        ctx.reply('✅ *Server khusus reseller berhasil ditambahkan!*', { parse_mode: 'Markdown' });
      }
    );
  } catch (e) {
    logger.error('Error di /addserver_reseller:', e);
    ctx.reply('❌ *Terjadi kesalahan.*', { parse_mode: 'Markdown' });
  }
});
//////////
async function broadcastMessageToAllUsers(message) {
  return new Promise((resolve) => {
    db.all('SELECT user_id FROM users', [], async (err, rows) => {
      if (err) {
        logger.error('Kesalahan saat mengambil daftar pengguna:', err.message);
        return resolve({ ok: 0, fail: 0, error: err.message });
      }

      let ok = 0;
      let fail = 0;

      for (const row of rows || []) {
        try {
          await bot.telegram.sendMessage(row.user_id, message);
          ok++;
        } catch (e) {
          fail++;
          logger.warn('Gagal kirim broadcast ke ' + row.user_id + ': ' + (e.message || e));
        }
      }

      resolve({ ok, fail });
    });
  });
}

function buildBroadcastPollText(question, options, counts, totalVotes, userChoiceIndex = -1) {
  const lines = ['*Polling Broadcast*', '', question, ''];
  for (let i = 0; i < options.length; i++) {
    const count = Number(counts[i] || 0);
    const pct = totalVotes > 0 ? ((count / totalVotes) * 100).toFixed(1) : '0.0';
    const me = userChoiceIndex === i ? ' (pilihan kamu)' : '';
    lines.push((i + 1) + '. ' + options[i] + ' -> ' + count + ' vote (' + pct + '%)' + me);
  }
  lines.push('');
  lines.push('Total vote: ' + totalVotes);
  return lines.join('\n');
}

function buildBroadcastPollKeyboard(pollId, options) {
  const rows = options.map((opt, idx) => ([{ text: opt, callback_data: 'bpv_' + pollId + '_' + idx }]));
  rows.push([{ text: 'Refresh Hasil', callback_data: 'bpr_' + pollId }]);
  return { inline_keyboard: rows };
}

async function createBroadcastPoll(question, options, createdBy) {
  const now = Date.now();
  const result = await dbRunAsync(
    'INSERT INTO broadcast_polls (question, options_json, created_by, created_at, is_active) VALUES (?, ?, ?, ?, 1)',
    [question, JSON.stringify(options), Number(createdBy || 0), now]
  );
  return result.lastID;
}

async function getBroadcastPollById(pollId) {
  const rows = await dbAllAsync(
    'SELECT id, question, options_json, is_active FROM broadcast_polls WHERE id = ? LIMIT 1',
    [pollId]
  );
  const row = rows[0];
  if (!row) return null;
  let options = [];
  try {
    const parsed = JSON.parse(row.options_json || '[]');
    options = Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    options = [];
  }
  return {
    id: Number(row.id),
    question: String(row.question || ''),
    isActive: Number(row.is_active || 0) === 1,
    options
  };
}

async function getBroadcastPollStats(pollId, optionCount) {
  const rows = await dbAllAsync(
    'SELECT option_index, COUNT(*) as c FROM broadcast_poll_votes WHERE poll_id = ? GROUP BY option_index',
    [pollId]
  );
  const counts = new Array(optionCount).fill(0);
  let total = 0;
  for (const row of rows) {
    const idx = Number(row.option_index);
    const c = Number(row.c || 0);
    if (idx >= 0 && idx < optionCount) {
      counts[idx] = c;
      total += c;
    }
  }
  return { counts, total };
}

async function getUserBroadcastPollChoice(pollId, userId) {
  const rows = await dbAllAsync(
    'SELECT option_index FROM broadcast_poll_votes WHERE poll_id = ? AND user_id = ? LIMIT 1',
    [pollId, userId]
  );
  if (!rows[0]) return -1;
  return Number(rows[0].option_index);
}

async function upsertBroadcastPollVote(pollId, userId, optionIndex) {
  const now = Date.now();
  await dbRunAsync('DELETE FROM broadcast_poll_votes WHERE poll_id = ? AND user_id = ?', [pollId, userId]);
  await dbRunAsync(
    'INSERT INTO broadcast_poll_votes (poll_id, user_id, option_index, voted_at) VALUES (?, ?, ?, ?)',
    [pollId, userId, optionIndex, now]
  );
}

const BROADCAST_POLL_RETENTION_DAYS = 7;

async function cleanupOldBroadcastPolls(retentionDays = BROADCAST_POLL_RETENTION_DAYS) {
  try {
    const threshold = Date.now() - (Math.max(1, Number(retentionDays) || 7) * 24 * 60 * 60 * 1000);
    const oldRows = await dbAllAsync(
      'SELECT id FROM broadcast_polls WHERE COALESCE(created_at, 0) > 0 AND created_at < ?',
      [threshold]
    );
    if (!oldRows.length) return 0;

    const ids = oldRows.map(r => Number(r.id)).filter(Number.isFinite);
    if (!ids.length) return 0;

    await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
    for (const id of ids) {
      await dbRunAsync('DELETE FROM broadcast_poll_votes WHERE poll_id = ?', [id]);
      await dbRunAsync('DELETE FROM broadcast_polls WHERE id = ?', [id]);
    }
    await dbRunAsync('COMMIT');

    logger.info('Cleanup polling broadcast: ' + ids.length + ' polling lama dihapus');
    return ids.length;
  } catch (err) {
    try { await dbRunAsync('ROLLBACK'); } catch (_) {}
    logger.error('Gagal cleanup polling broadcast:', err.message);
    return 0;
  }
}

async function broadcastPollToAllUsers(question, options, createdBy = 0) {
  const pollId = await createBroadcastPoll(question, options, createdBy);
  const stats = await getBroadcastPollStats(pollId, options.length);
  const text = buildBroadcastPollText(question, options, stats.counts, stats.total, -1);
  const keyboard = buildBroadcastPollKeyboard(pollId, options);

  return new Promise((resolve) => {
    db.all('SELECT user_id FROM users', [], async (err, rows) => {
      if (err) {
        logger.error('Kesalahan saat mengambil daftar pengguna untuk polling:', err.message);
        return resolve({ ok: 0, fail: 0, pollId, error: err.message });
      }

      let ok = 0;
      let fail = 0;

      for (const row of rows || []) {
        try {
          await bot.telegram.sendMessage(row.user_id, text, { parse_mode: 'Markdown', reply_markup: keyboard });
          ok++;
        } catch (e) {
          fail++;
          logger.warn('Gagal kirim poll ke ' + row.user_id + ': ' + (e.message || e));
        }
      }

      resolve({ ok, fail, pollId });
    });
  });
}

//////////
bot.action(/bpv_(\d+)_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const pollId = Number(ctx.match[1]);
  const optionIndex = Number(ctx.match[2]);
  const userId = Number(ctx.from.id);

  try {
    const poll = await getBroadcastPollById(pollId);
    if (!poll || !poll.isActive) {
      return ctx.reply('Polling tidak ditemukan atau sudah ditutup.');
    }

    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= poll.options.length) {
      return ctx.reply('Opsi polling tidak valid.');
    }

    await upsertBroadcastPollVote(pollId, userId, optionIndex);
    const stats = await getBroadcastPollStats(pollId, poll.options.length);
    const myChoice = await getUserBroadcastPollChoice(pollId, userId);
    const text = buildBroadcastPollText(poll.question, poll.options, stats.counts, stats.total, myChoice);
    const keyboard = buildBroadcastPollKeyboard(pollId, poll.options);

    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
  } catch (e) {
    const errText = String(
      e?.response?.description ||
      e?.description ||
      e?.message ||
      e
    );

    if (/message is not modified/i.test(errText)) {
      return ctx.answerCbQuery('Belum ada perubahan hasil.', { show_alert: false }).catch(() => {});
    }

    logger.error('Error vote broadcast poll: ' + errText);
    await ctx.reply('Terjadi kesalahan saat menyimpan vote.');
  }
});

bot.action(/bpr_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const pollId = Number(ctx.match[1]);
  const userId = Number(ctx.from.id);

  try {
    const poll = await getBroadcastPollById(pollId);
    if (!poll || !poll.isActive) {
      return ctx.reply('Polling tidak ditemukan atau sudah ditutup.');
    }

    const stats = await getBroadcastPollStats(pollId, poll.options.length);
    const myChoice = await getUserBroadcastPollChoice(pollId, userId);
    const text = buildBroadcastPollText(poll.question, poll.options, stats.counts, stats.total, myChoice);
    const keyboard = buildBroadcastPollKeyboard(pollId, poll.options);

    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
  } catch (e) {
    const errText = String(
      e?.response?.description ||
      e?.description ||
      e?.message ||
      e
    );

    if (/message is not modified/i.test(errText)) {
      return ctx.answerCbQuery('Belum ada perubahan hasil.', { show_alert: false }).catch(() => {});
    }

    logger.error('Error refresh broadcast poll: ' + errText);
    await ctx.reply('Terjadi kesalahan saat refresh hasil polling.');
  }
});

bot.command('broadcast', async (ctx) => {
  const userId = ctx.message.from.id;
  logger.info(`Broadcast command received from user_id: ${userId}`);
  if (!adminIds.includes(userId)) {
      logger.info(`⚠️ User ${userId} tidak memiliki izin untuk menggunakan perintah ini.`);
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const rawText = ctx.message.text || '';
  const message = ctx.message.reply_to_message
    ? (ctx.message.reply_to_message.text || ctx.message.reply_to_message.caption || '')
    : rawText.replace(/^\/broadcast(?:@\w+)?\s*/i, '');
  if (!message) {
      logger.info('⚠️ Pesan untuk disiarkan tidak diberikan.');
      return ctx.reply('⚠️ Mohon berikan pesan untuk disiarkan.', { parse_mode: 'Markdown' });
  }

  db.all("SELECT user_id FROM users", [], (err, rows) => {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengambil daftar pengguna:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengambil daftar pengguna.', { parse_mode: 'Markdown' });
      }

      rows.forEach((row) => {
          const telegramUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
          axios.post(telegramUrl, {
              chat_id: row.user_id,
              text: message
          }).then(() => {
              logger.info(`✅ Pesan siaran berhasil dikirim ke ${row.user_id}`);
          }).catch((error) => {
              logger.error(`⚠️ Kesalahan saat mengirim pesan siaran ke ${row.user_id}`, error.message);
          });
      });

      ctx.reply('✅ Pesan siaran berhasil dikirim.', { parse_mode: 'Markdown' });
  });
});



bot.command('broadcastpoll', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
    return ctx.reply('Anda tidak memiliki izin untuk menggunakan perintah ini.');
  }

  const rawText = (ctx.message.text || '').replace(/^\/broadcastpoll(?:@\w+)?\s*/i, '').trim();
  const sourceText = ctx.message.reply_to_message
    ? ((ctx.message.reply_to_message.text || ctx.message.reply_to_message.caption || '').trim())
    : rawText;

  if (!sourceText) {
    return ctx.reply(
      'Format: /broadcastpoll Pertanyaan | Opsi A | Opsi B [| Opsi C ...]\n' +
      'Minimal 2 opsi, maksimal 10 opsi.'
    );
  }

  const parts = sourceText.split('|').map((x) => x.trim()).filter(Boolean);
  if (parts.length < 3) {
    return ctx.reply('Format salah. Minimal: Pertanyaan | Opsi A | Opsi B');
  }

  const question = parts[0];
  const options = parts.slice(1, 11);

  if (question.length < 5) {
    return ctx.reply('Pertanyaan terlalu pendek. Minimal 5 karakter.');
  }

  if (options.length < 2) {
    return ctx.reply('Opsi polling minimal 2 pilihan.');
  }

  const pollResult = await broadcastPollToAllUsers(question, options, userId);

  return ctx.reply(
    'Polling siaran selesai.\n' +
    '- Berhasil: ' + pollResult.ok + '\n' +
    '- Gagal: ' + pollResult.fail + '\n' +
    '- ID Polling: ' + pollResult.pollId + '\n\n' +
    'Hasil polling ini bersifat global (gabungan semua user).'
  );
});
//command addserver biasa potato//command addserver biasa potato
bot.command('addserver', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 8) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/addserver <domain> <auth> <harga> <nama_server> <quota> <iplimit> <batas_create_account>`', { parse_mode: 'Markdown' });
  }

  const [domain, auth, harga, nama_server, quota, iplimit, batas_create_akun] = args.slice(1);

  const numberOnlyRegex = /^\d+$/;
  if (!numberOnlyRegex.test(harga) || !numberOnlyRegex.test(quota) || !numberOnlyRegex.test(iplimit) || !numberOnlyRegex.test(batas_create_akun)) {
      return ctx.reply('⚠️ `harga`, `quota`, `iplimit`, dan `batas_create_akun` harus berupa angka.', { parse_mode: 'Markdown' });
  }

  // ✅ QUERY YANG BENAR
const service = userState[ctx.chat.id]?.service || 'ssh'; 
db.run(
  "INSERT INTO Server (domain, auth, harga, nama_server, quota, iplimit, batas_create_akun, total_create_akun, support_zivpn, support_udp_http, service) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)",
  [
    domain,
    auth,
    parseInt(harga),
    nama_server,
    parseInt(quota),
    parseInt(iplimit),
    parseInt(batas_create_akun),
    service
  ],
  function(err) {
    if (err) {
      logger.error('⚠️ Kesalahan saat menambahkan server:', err.message);
      return ctx.reply('⚠️ Kesalahan saat menambahkan server.', { parse_mode: 'Markdown' });
    }

    // 🧹 bersihkan state setelah sukses
    delete userState[ctx.chat.id];

    ctx.reply(`✅ Server \`${nama_server}\` berhasil ditambahkan.`, { parse_mode: 'Markdown' });
  }
);

});

//command addserver zivpn
bot.command('addserverzivpn', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
    return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.');
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 8) {
    return ctx.reply(
      '⚠️ Format salah.\nGunakan:\n`/addserverzivpn <domain> <auth> <harga> <nama_server> <quota> <iplimit> <batas_create_akun>`',
      { parse_mode: 'Markdown' }
    );
  }

  const [, domain, auth, harga, nama_server, quota, iplimit, batas_create_akun] = args;

  const numberOnlyRegex = /^\d+$/;
  if (
    !numberOnlyRegex.test(harga) ||
    !numberOnlyRegex.test(quota) ||
    !numberOnlyRegex.test(iplimit) ||
    !numberOnlyRegex.test(batas_create_akun)
  ) {
    return ctx.reply('⚠️ `harga`, `quota`, `iplimit`, dan `batas_create_akun` harus berupa angka.');
  }

  // 🔥 INI SATU-SATUNYA BEDANYA
  db.run(
    "INSERT INTO Server (domain, auth, harga, nama_server, quota, iplimit, batas_create_akun, total_create_akun, support_zivpn, support_udp_http, service) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, 0, 'ssh')",
    [
      domain,
      auth,
      parseInt(harga),
      nama_server,
      parseInt(quota),
      parseInt(iplimit),
      parseInt(batas_create_akun)
    ],
    function (err) {
      if (err) {
        logger.error('⚠️ Kesalahan saat menambahkan server ZIVPN:', err.message);
        return ctx.reply('⚠️ Kesalahan saat menambahkan server ZIVPN.');
      }

      ctx.reply(`✅ Server ZIVPN \`${nama_server}\` berhasil ditambahkan.`, {
        parse_mode: 'Markdown'
      });
    }
  );
});

//////
bot.command('editharga', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editharga <domain> <harga>`', { parse_mode: 'Markdown' });
  }

  const [domain, harga] = args.slice(1);

  if (!/^\d+$/.test(harga)) {
      return ctx.reply('⚠️ `harga` harus berupa angka.', { parse_mode: 'Markdown' });
  }

  db.run("INSERT INTO Server (domain, auth, harga, nama_server, quota, iplimit, batas_create_akun, total_create_akun, support_zivpn, support_udp_http, service) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 'ssh')", 
      [domain, auth, parseInt(harga), nama_server, parseInt(quota), parseInt(iplimit), parseInt(batas_create_akun)], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat menambahkan server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat menambahkan server.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Server \`${nama_server}\` berhasil ditambahkan.`, { parse_mode: 'Markdown' });
  });
});


bot.command('editnama', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editnama <domain> <nama_server>`', { parse_mode: 'Markdown' });
  }

  const [domain, nama_server] = args.slice(1);

  db.run("UPDATE Server SET nama_server = ? WHERE domain = ?", [nama_server, domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit nama server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit nama server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Nama server \`${domain}\` berhasil diubah menjadi \`${nama_server}\`.`, { parse_mode: 'Markdown' });
  });
});

bot.command('editdomain', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editdomain <old_domain> <new_domain>`', { parse_mode: 'Markdown' });
  }

  const [old_domain, new_domain] = args.slice(1);

  db.run("UPDATE Server SET domain = ? WHERE domain = ?", [new_domain, old_domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit domain server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit domain server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Domain server \`${old_domain}\` berhasil diubah menjadi \`${new_domain}\`.`, { parse_mode: 'Markdown' });
  });
});

bot.command('editauth', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editauth <domain> <auth>`', { parse_mode: 'Markdown' });
  }

  const [domain, auth] = args.slice(1);

  db.run("UPDATE Server SET auth = ? WHERE domain = ?", [auth, domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit auth server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit auth server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Auth server \`${domain}\` berhasil diubah menjadi \`${auth}\`.`, { parse_mode: 'Markdown' });
  });
});

bot.command('editlimitquota', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editlimitquota <domain> <quota>`', { parse_mode: 'Markdown' });
  }

  const [domain, quota] = args.slice(1);

  if (!/^\d+$/.test(quota)) {
      return ctx.reply('⚠️ `quota` harus berupa angka.', { parse_mode: 'Markdown' });
  }

  db.run("UPDATE Server SET quota = ? WHERE domain = ?", [parseInt(quota), domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit quota server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit quota server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Quota server \`${domain}\` berhasil diubah menjadi \`${quota}\`.`, { parse_mode: 'Markdown' });
  });
});

bot.command('editlimitip', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editlimitip <domain> <iplimit>`', { parse_mode: 'Markdown' });
  }

  const [domain, iplimit] = args.slice(1);

  if (!/^\d+$/.test(iplimit)) {
      return ctx.reply('⚠️ `iplimit` harus berupa angka.', { parse_mode: 'Markdown' });
  }

  db.run("UPDATE Server SET iplimit = ? WHERE domain = ?", [parseInt(iplimit), domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit iplimit server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit iplimit server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Iplimit server \`${domain}\` berhasil diubah menjadi \`${iplimit}\`.`, { parse_mode: 'Markdown' });
  });
});

bot.command('editlimitcreate', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editlimitcreate <domain> <batas_create_akun>`', { parse_mode: 'Markdown' });
  }

  const [domain, batas_create_akun] = args.slice(1);

  if (!/^\d+$/.test(batas_create_akun)) {
      return ctx.reply('⚠️ `batas_create_akun` harus berupa angka.', { parse_mode: 'Markdown' });
  }

  db.run("UPDATE Server SET batas_create_akun = ? WHERE domain = ?", [parseInt(batas_create_akun), domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit batas_create_akun server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit batas_create_akun server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Batas create akun server \`${domain}\` berhasil diubah menjadi \`${batas_create_akun}\`.`, { parse_mode: 'Markdown' });
  });
});
bot.command('edittotalcreate', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/edittotalcreate <domain> <total_create_akun>`', { parse_mode: 'Markdown' });
  }

  const [domain, total_create_akun] = args.slice(1);

  if (!/^\d+$/.test(total_create_akun)) {
      return ctx.reply('⚠️ `total_create_akun` harus berupa angka.', { parse_mode: 'Markdown' });
  }

  db.run("UPDATE Server SET total_create_akun = ? WHERE domain = ?", [parseInt(total_create_akun), domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit total_create_akun server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit total_create_akun server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Total create akun server \`${domain}\` berhasil diubah menjadi \`${total_create_akun}\`.`, { parse_mode: 'Markdown' });
  });
});
async function handleServiceAction(ctx, action) {
  let keyboard;
  if (action === 'create') {
    keyboard = [
      [{ text: '🌐 Buat SSH/OpenVPN', callback_data: 'create_ssh' }, { text: '🔗 Buat UDP HC', callback_data: 'create_udp_http' }],
      [{ text: '🚀 Buat Vmess', callback_data: 'create_vmess' }, { text: '⚡ Buat Vless', callback_data: 'create_vless' }],
      [{ text: '🛡️ Buat Trojan', callback_data: 'create_trojan' }, { text: '🌙 Buat UDP ZIVPN', callback_data: 'create_zivpn' }],
      [{ text: '🔙 Kembali ke Menu', callback_data: 'send_main_menu' }]
    ];
  } else if (action === 'trial') {
    keyboard = [
      [{ text: '🌐 Trial SSH/OpenVPN', callback_data: 'trial_ssh' }, { text: '🔗 Trial UDP HTTP', callback_data: 'trial_udp_http' }],
      [{ text: '🚀 Trial Vmess', callback_data: 'trial_vmess' }, { text: '⚡ Trial Vless', callback_data: 'trial_vless' }],
      [{ text: '🛡️ Trial Trojan', callback_data: 'trial_trojan' }, { text: '🌙 Trial UDP ZIVPN', callback_data: 'trial_zivpn' }],
      [{ text: '🔙 Kembali ke Menu', callback_data: 'send_main_menu' }]
    ];
  } else if (action === 'renew') {
    keyboard = [
      [{ text: '🌐 Perpanjang SSH/Ovpn', callback_data: 'renew_ssh' }, { text: '🔗 Perpanjang UDP HTTP', callback_data: 'renew_udp_http' }],
      [{ text: '🚀 Perpanjang Vmess', callback_data: 'renew_vmess' }, { text: '⚡ Perpanjang Vless', callback_data: 'renew_vless' }],
      [{ text: '🛡️ Perpanjang Trojan', callback_data: 'renew_trojan' }, { text: '🌙 Perpanjang ZIVPN', callback_data: 'renew_zivpn' }],
      [{ text: '🔙 Kembali ke Menu', callback_data: 'send_main_menu' }]
    ];
  } else if (action === 'del') {
    keyboard = [
      [{ text: '🌐 Hapus SSH/Ovpn', callback_data: 'del_ssh' }, { text: '🔗 Hapus UDP HTTP', callback_data: 'del_udp_http' }],
      [{ text: '🚀 Hapus Vmess', callback_data: 'del_vmess' }, { text: '⚡ Hapus Vless', callback_data: 'del_vless' }],
      [{ text: '🛡️ Hapus Trojan', callback_data: 'del_trojan' }, { text: '🌙 Hapus UDP ZIVPN', callback_data: 'del_zivpn' }],
      [{ text: '🔙 Kembali ke Menu', callback_data: 'send_main_menu' }]
    ];
  } else if (action === 'lock') {
    keyboard = [
      [{ text: '🌐 Lock SSH/Ovpn', callback_data: 'lock_ssh' }, { text: '🔗 Lock UDP HTTP', callback_data: 'lock_udp_http' }],
      [{ text: '🚀 Lock Vmess', callback_data: 'lock_vmess' }, { text: '⚡ Lock Vless', callback_data: 'lock_vless' }],
      [{ text: '🛡️ Lock Trojan', callback_data: 'lock_trojan' }, { text: '🔙 Kembali', callback_data: 'send_main_menu' }]
    ];
  } else if (action === 'unlock') {
    keyboard = [
      [{ text: '🌐 Unlock SSH/Ovpn', callback_data: 'unlock_ssh' }, { text: '🔗 Unlock UDP HTTP', callback_data: 'unlock_udp_http' }],
      [{ text: '🚀 Unlock Vmess', callback_data: 'unlock_vmess' }, { text: '⚡ Unlock Vless', callback_data: 'unlock_vless' }],
      [{ text: '🛡️ Unlock Trojan', callback_data: 'unlock_trojan' }, { text: '🔙 Kembali', callback_data: 'send_main_menu' }]
    ];
  }
  try {
    await ctx.editMessageReplyMarkup({
      inline_keyboard: keyboard
    });
    logger.info(`${action} service menu sent`);
  } catch (error) {
    if (error.response && error.response.error_code === 400) {
      await ctx.reply(`Pilih jenis layanan yang ingin Anda ${action}:`, {
        reply_markup: {
          inline_keyboard: keyboard
        }
      });
      logger.info(`${action} service menu sent as new message`);
    } else {
      logger.error(`Error saat mengirim menu ${action}:`, error);
    }
  }
}
async function sendAdminMenu(ctx) {
  const adminKeyboard = [
    [{ text: '🖥️ Server', callback_data: 'admin_menu_server' }],
    [{ text: '💳 Saldo', callback_data: 'admin_menu_saldo' }],
    [{ text: '🤝 Reseller', callback_data: 'admin_menu_reseller' }],
    [{ text: '🧰 Tools', callback_data: 'admin_menu_tools' }],
    [{ text: '🔙 Kembali', callback_data: 'send_main_menu' }]
  ];

  try {
    await ctx.editMessageText('*🛠️ MENU ADMIN*', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: adminKeyboard
      }
    });
    logger.info('Admin menu sent');
  } catch (error) {
    if (error.response && error.response.error_code === 400) {
      try {
        await ctx.reply('*🛠️ MENU ADMIN*', {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: adminKeyboard
          }
        });
        logger.info('Admin menu sent as new message');
      } catch (sendError) {
        logger.error('Error sending admin menu as new message:', sendError);
      }
    } else {
      logger.error('Error saat mengirim menu admin:', error);
    }
  }
}

bot.action('admin_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await sendAdminMenu(ctx);
});

async function sendAdminServerMenu(ctx) {
  const keyboard = [
    [{ text: '➕ Add Server', callback_data: 'addserver' }],
        [
      { text: '🛠️ Kelola Server', callback_data: 'admin_manage_server' }
    ],
    [
      { text: 'Edit Harga User', callback_data: 'editserver_harga' },
      { text: 'Edit Harga Reseller', callback_data: 'editserver_harga_reseller' }
    ],
    [
      { text: 'Edit Nama', callback_data: 'nama_server_edit' }
    ],
    [
      { text: '🌐 Edit Domain', callback_data: 'editserver_domain' },
      { text: '🔑 Edit Auth', callback_data: 'editserver_auth' }
    ],
    [
      { text: '📊 Edit Quota', callback_data: 'editserver_quota' },
      { text: '📶 Edit Limit IP', callback_data: 'editserver_limit_ip' }
    ],
    [
      { text: '📋 List Server', callback_data: 'listserver' },
      { text: 'ℹ️ Detail Server', callback_data: 'detailserver' }
    ],
    [
      { text: '❌ Hapus Server', callback_data: 'deleteserver' },
      { text: '♻️ Reset Server', callback_data: 'resetdb' }
    ],
    [{ text: '🔙 Kembali', callback_data: 'admin_menu' }]
  ];

  await ctx.editMessageText('*🖥️ MENU SERVER*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function sendAdminSaldoMenu(ctx) {
  const manualEnabled = loadTopupManualSetting();
  const manualLabel = manualEnabled ? '✅ TopUp Manual: Aktif' : '🚫 TopUp Manual: Nonaktif';
  const autoEnabled = loadTopupAutoSetting();
  const autoLabel = autoEnabled ? '✅ TopUp Otomatis: Aktif' : '🚫 TopUp Otomatis: Nonaktif';
  const keyboard = [
    [
      { text: '💵 Tambah Saldo', callback_data: 'tambah_saldo' },
      { text: '🗑️ Hapus Saldo', callback_data: 'hapus_saldo' }
    ],
    [
      { text: '💳 Lihat Saldo User', callback_data: 'cek_saldo_user' },
      { text: '🖼️ Upload QRIS', callback_data: 'upload_qris' }
    ],
    [{ text: '🎁 Bonus Topup', callback_data: 'bonus_topup_menu' }],
    [{ text: 'Pendapatan Hari Ini & Kemarin', callback_data: 'admin_income_summary' }],
    [{ text: autoLabel, callback_data: 'toggle_topup_auto' }],
    [{ text: manualLabel, callback_data: 'toggle_topup_manual' }],
    [{ text: '🔙 Kembali', callback_data: 'admin_menu' }]
  ];

  await ctx.editMessageText('*💳 MENU SALDO*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function sendAdminResellerMenu(ctx) {
  const keyboard = [
    [
      { text: '➕ Tambah Reseller', callback_data: 'add_reseller_menu' },
      { text: '🗑️ Hapus Reseller', callback_data: 'del_reseller_menu' }
    ],
    [{ text: '📜 Syarat Reseller', callback_data: 'reseller_terms_menu' }],
    [{ text: '⚡ Trigger Cek Syarat', callback_data: 'reseller_terms_trigger' }],
    [{ text: '♻️ Restore Reseller', callback_data: 'reseller_restore' }],
    [{ text: '🔙 Kembali', callback_data: 'admin_menu' }]
  ];

  await ctx.editMessageText('*🤝 MENU RESELLER*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

bot.action('add_reseller_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk melakukan tindakan ini.');
  }
  userState[ctx.chat.id] = { step: 'add_reseller_userid' };
  await ctx.reply('Masukkan ID Telegram user yang ingin dijadikan reseller:');
});

bot.action('del_reseller_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk melakukan tindakan ini.');
  }
  userState[ctx.chat.id] = { step: 'del_reseller_userid' };
  await ctx.reply('Masukkan ID Telegram reseller yang ingin dihapus:');
});

async function sendAdminToolsMenu(ctx) {
  const keyboard = [
    [{ text: '📋 Help Admin', callback_data: 'helpadmin_menu' }],
    [{ text: '📣 Broadcast Kirim Pesan', callback_data: 'admin_broadcast_menu' }],
    [{ text: 'Broadcast Polling', callback_data: 'admin_broadcast_poll_menu' }],
    [{ text: '💾 Restore Database', callback_data: 'restore_db_menu' }],
    [{ text: 'Backup Database Sekarang', callback_data: 'auto_backup_now' }],
    [{ text: 'Sync Server Sekarang', callback_data: 'admin_sync_server_now' }],
    [{ text: '🔔 Notif Create (Bot)', callback_data: 'notif_settings_menu' }],
    [{ text: '📞 Kontak Admin', callback_data: 'admin_contact_settings_menu' }],
    [{ text: '🔙 Kembali', callback_data: 'admin_menu' }]
  ];

  await ctx.editMessageText('*🧰 MENU TOOLS*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

bot.action('admin_menu_server', async (ctx) => {
  await ctx.answerCbQuery();
  await sendAdminServerMenu(ctx);
});

async function sendAdminManageServerMenu(ctx) {
  const keyboard = [
    [{ text: '🔢 Edit Total + Batas', callback_data: 'manage_edit_total_batas' }],
    [{ text: '🚫 Jadikan Server Penuh', callback_data: 'manage_server_full' }],
    [{ text: '✅ Jadikan Server Tersedia', callback_data: 'manage_server_activate' }],
    [{ text: '🔙 Kembali', callback_data: 'admin_menu_server' }]
  ];

  await ctx.editMessageText('*🛠️ KELOLA SERVER*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

bot.action('admin_manage_server', async (ctx) => {
  await ctx.answerCbQuery();
  await sendAdminManageServerMenu(ctx);
});

bot.action('manage_edit_total_batas', async (ctx) => {
  await ctx.answerCbQuery();
  db.all('SELECT id, nama_server FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], async (err, servers) => {
    if (err) {
      logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
      return ctx.reply('❌ Terjadi kesalahan saat mengambil daftar server.');
    }
    if (!servers || servers.length === 0) {
      return ctx.reply('⚠️ Tidak ada server yang tersedia.');
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_total_batas_${server.id}`
    }));
    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }
    inlineKeyboard.push([{ text: '🔙 Kembali', callback_data: 'admin_manage_server' }]);

    await ctx.reply('📊 Pilih server untuk edit total+batas:', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: inlineKeyboard }
    });
  });
});

bot.action('manage_server_full', async (ctx) => {
  await ctx.answerCbQuery();
  db.all('SELECT id, nama_server FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], async (err, servers) => {
    if (err) {
      logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
      return ctx.reply('❌ Terjadi kesalahan saat mengambil daftar server.');
    }
    if (!servers || servers.length === 0) {
      return ctx.reply('⚠️ Tidak ada server yang tersedia.');
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `set_server_full_${server.id}`
    }));
    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }
    inlineKeyboard.push([{ text: '🔙 Kembali', callback_data: 'admin_manage_server' }]);

    await ctx.reply('🚫 Pilih server yang akan dijadikan penuh:', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: inlineKeyboard }
    });
  });
});

bot.action('manage_server_activate', async (ctx) => {
  await ctx.answerCbQuery();
  db.all('SELECT id, nama_server FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], async (err, servers) => {
    if (err) {
      logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
      return ctx.reply('❌ Terjadi kesalahan saat mengambil daftar server.');
    }
    if (!servers || servers.length === 0) {
      return ctx.reply('⚠️ Tidak ada server yang tersedia.');
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `activate_server_${server.id}`
    }));
    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }
    inlineKeyboard.push([{ text: '🔙 Kembali', callback_data: 'admin_manage_server' }]);

    await ctx.reply('✅ Pilih server yang akan diaktifkan (isi ulang total & batas):', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: inlineKeyboard }
    });
  });
});

bot.action('admin_menu_saldo', async (ctx) => {
  await ctx.answerCbQuery();
  await sendAdminSaldoMenu(ctx);
});

bot.action('admin_income_summary', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('Anda tidak memiliki izin untuk mengakses menu ini.');
  }

  try {
    const todayRange = getDayRange(0);
    const yesterdayRange = getDayRange(-1);
    const [todayStats, yesterdayStats] = await Promise.all([
      getIncomeStatsByRange(todayRange.start, todayRange.end),
      getIncomeStatsByRange(yesterdayRange.start, yesterdayRange.end)
    ]);

    const message =
      '*INFORMASI PENDAPATAN*\n\n' +
      '*Hari Ini*\n' +
      '- Pendapatan akun: ' + formatRupiah(todayStats.accountIncome) + '\n' +
      '- Jumlah akun terjual: ' + todayStats.accountCount + '\n' +
      '- Topup masuk: ' + formatRupiah(todayStats.topupIncome) + '\n\n' +
      '*Kemarin*\n' +
      '- Pendapatan akun: ' + formatRupiah(yesterdayStats.accountIncome) + '\n' +
      '- Jumlah akun terjual: ' + yesterdayStats.accountCount + '\n' +
      '- Topup masuk: ' + formatRupiah(yesterdayStats.topupIncome);

    await ctx.reply(message, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('Gagal mengambil informasi pendapatan admin:', error.message);
    await ctx.reply('Gagal mengambil informasi pendapatan. Coba lagi.');
  }
});

bot.action('bonus_topup_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
  }
  const bonus = loadTopupBonusSetting();
  const statusLabel = bonus.enabled ? '✅ Aktif' : '🚫 Nonaktif';
  const message =
    '*🎁 BONUS TOPUP OTOMATIS*\n\n' +
    `Status: ${statusLabel}\n` +
    `• 10-40rb  : ${bonus.range_10_40}%\n` +
    `• 50-70rb  : ${bonus.range_50_70}%\n` +
    `• 70-100rb+: ${bonus.range_70_100}%\n\n` +
    'Pilih range untuk ubah persen bonus:';
  const keyboard = [
    [{ text: bonus.enabled ? '🚫 Nonaktifkan Bonus' : '✅ Aktifkan Bonus', callback_data: 'bonus_toggle' }],
    [{ text: 'Set 10-40rb', callback_data: 'bonus_set_10_40' }],
    [{ text: 'Set 50-70rb', callback_data: 'bonus_set_50_70' }],
    [{ text: 'Set 70-100rb+', callback_data: 'bonus_set_70_100' }],
    [{ text: '🔙 Kembali', callback_data: 'admin_menu_saldo' }]
  ];
  await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
});

bot.action('bonus_toggle', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
  }
  const current = loadTopupBonusSetting();
  current.enabled = !current.enabled;
  saveTopupBonusSetting(current);
  await ctx.reply(current.enabled ? '✅ Bonus topup diaktifkan.' : '🚫 Bonus topup dinonaktifkan.');
  return sendAdminSaldoMenu(ctx);
});

bot.action('bonus_set_10_40', async (ctx) => {
  await ctx.answerCbQuery();
  userState[ctx.chat.id] = { step: 'bonus_set_10_40' };
  await ctx.reply('Masukkan persen bonus untuk topup 10-40rb (contoh: 5):');
});

bot.action('bonus_set_50_70', async (ctx) => {
  await ctx.answerCbQuery();
  userState[ctx.chat.id] = { step: 'bonus_set_50_70' };
  await ctx.reply('Masukkan persen bonus untuk topup 50-70rb (contoh: 7):');
});

bot.action('bonus_set_70_100', async (ctx) => {
  await ctx.answerCbQuery();
  userState[ctx.chat.id] = { step: 'bonus_set_70_100' };
  await ctx.reply('Masukkan persen bonus untuk topup 70-100rb+ (contoh: 10):');
});

bot.action('notif_settings_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengakses menu ini.');
  }

  const tokenStatus = NOTIF_BOT_TOKEN ? '✅ Tersimpan' : '❌ Belum diisi';
  const chatStatus = NOTIF_CHAT_ID ? '✅ Tersimpan' : '❌ Belum diisi';
  const message =
    '*🔔 PENGATURAN NOTIF CREATE (BOT)*\n\n' +
    `Token Bot: ${tokenStatus}\n` +
    `Chat ID: ${chatStatus}\n\n` +
    'Gunakan tombol di bawah untuk mengatur Token dan Chat ID.';

  const keyboard = [
    [{ text: 'Set Token Bot', callback_data: 'notif_set_token' }],
    [{ text: 'Set Chat ID', callback_data: 'notif_set_chat' }],
    [{ text: 'Kembali', callback_data: 'admin_menu' }]
  ];

  await ctx.editMessageText(message, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
});

bot.action('notif_set_token', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
  }
  userState[ctx.chat.id] = { step: 'notif_bot_token' };
  await ctx.reply('Kirim *BOT TOKEN* untuk notifikasi create akun.\nKetik "batal" untuk membatalkan.', { parse_mode: 'Markdown' });
});

bot.action('notif_set_chat', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
  }
  userState[ctx.chat.id] = { step: 'notif_chat_id' };
  await ctx.reply('Kirim *CHAT ID* tujuan notifikasi.\nKetik "batal" untuk membatalkan.', { parse_mode: 'Markdown' });
});

bot.action('restore_db_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('Anda tidak memiliki izin untuk mengakses menu ini.');
  }

  const keyboard = [
    [{ text: 'Restore sellvpn.db', callback_data: 'restore_db_target_sellvpn' }],
    [{ text: 'Restore ressel.db', callback_data: 'restore_db_target_ressel' }],
    [{ text: 'Kembali', callback_data: 'admin_menu_tools' }]
  ];

  await ctx.reply('Pilih database yang ingin di-restore:', {
    reply_markup: { inline_keyboard: keyboard }
  });
});

bot.action(/restore_db_target_(sellvpn|ressel)/, async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('Anda tidak memiliki izin untuk melakukan aksi ini.');
  }

  const target = ctx.match[1];
  userState[ctx.chat.id] = { step: 'restore_db_upload', target };

  await ctx.reply(
    'Upload file backup untuk ' + target + '.db dalam format document.\n' +
    'Ketik "batal" untuk membatalkan.'
  );
});


bot.action('admin_contact_settings_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengakses menu ini.');
  }

  const wa = getAdminWhatsappNumber();
  const tg = getAdminTelegramUsername();
  const keyboard = [
    [{ text: 'Set Nomor WhatsApp', callback_data: 'admin_set_whatsapp' }],
    [{ text: 'Set Username Telegram', callback_data: 'admin_set_telegram' }],
    [{ text: '🔙 Kembali', callback_data: 'admin_menu_tools' }]
  ];

  await ctx.editMessageText(
    '*📞 PENGATURAN KONTAK ADMIN*\n\n' +
    'WhatsApp: ' + (wa || '-') + '\n' +
    'Telegram: `' + tg + '`',
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    }
  );
});

bot.action('admin_set_whatsapp', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
  }
  userState[ctx.chat.id] = { step: 'admin_contact_whatsapp' };
  await ctx.reply('Kirim nomor WhatsApp admin (format internasional, contoh: 6281234567890).\nKetik "batal" untuk membatalkan.');
});

bot.action('admin_set_telegram', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
  }
  userState[ctx.chat.id] = { step: 'admin_contact_telegram' };
  await ctx.reply('Kirim username Telegram admin (contoh: @myadmin atau myadmin).\nKetik "batal" untuk membatalkan.');
});
bot.action('toggle_topup_manual', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
  }

  const current = loadTopupManualSetting();
  const next = saveTopupManualSetting(!current);
  const statusText = next ? '✅ TopUp manual diaktifkan.' : '🚫 TopUp manual dinonaktifkan.';
  await ctx.reply(statusText);
  return sendAdminSaldoMenu(ctx);
});

bot.action('toggle_topup_auto', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah pengaturan ini.');
  }

  const current = loadTopupAutoSetting();
  const next = saveTopupAutoSetting(!current);
  const statusText = next ? '✅ TopUp otomatis diaktifkan.' : '🚫 TopUp otomatis dinonaktifkan.';
  await ctx.reply(statusText);
  return sendAdminSaldoMenu(ctx);
});

bot.action('admin_menu_reseller', async (ctx) => {
  await ctx.answerCbQuery();
  await sendAdminResellerMenu(ctx);
});

bot.action('admin_menu_tools', async (ctx) => {
  await ctx.answerCbQuery();
  delete userState[ctx.chat.id];
  await sendAdminToolsMenu(ctx);
});

bot.action('helpadmin_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await sendHelpAdmin(ctx);
});


bot.action('admin_broadcast_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('Anda tidak memiliki izin untuk menggunakan fitur ini.');
  }

  userState[ctx.chat.id] = { step: 'admin_broadcast_message' };
  return ctx.reply('Masukkan pesan yang ingin disiarkan.\n\nKetik "batal" untuk membatalkan.');
});

bot.action('admin_broadcast_poll_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('Anda tidak memiliki izin untuk menggunakan fitur ini.');
  }

  userState[ctx.chat.id] = { step: 'admin_broadcast_poll_only_input' };
  return ctx.reply(
    'Masukkan polling dengan format:\n' +
    'Pertanyaan | Opsi A | Opsi B [| Opsi C ...]\n\n' +
    'Contoh:\n' +
    'Server favorit minggu ini? | SG1 | SG2 | ID1\n\n' +
    'Ketik "batal" untuk membatalkan.'
  );
});

bot.action('admin_broadcast_add_poll_yes', async (ctx) => {
  await ctx.answerCbQuery();
  const state = userState[ctx.chat.id];
  if (!state || state.step !== 'admin_broadcast_choose_poll') {
    return ctx.reply('Sesi broadcast tidak ditemukan. Ulangi dari menu tools.');
  }

  state.step = 'admin_broadcast_poll_input';
  return ctx.reply(
    'Masukkan polling dengan format:\n' +
    'Pertanyaan | Opsi A | Opsi B [| Opsi C ...]\n\n' +
    'Contoh:\n' +
    'Server favorit minggu ini? | SG1 | SG2 | ID1\n\n' +
    'Ketik "batal" untuk membatalkan.'
  );
});

bot.action('admin_broadcast_add_poll_no', async (ctx) => {
  await ctx.answerCbQuery();
  const state = userState[ctx.chat.id];
  if (!state || state.step !== 'admin_broadcast_choose_poll') {
    return ctx.reply('Sesi broadcast tidak ditemukan. Ulangi dari menu tools.');
  }

  const msg = String(state.message || '').trim();
  if (!msg) {
    delete userState[ctx.chat.id];
    return ctx.reply('Pesan broadcast kosong. Ulangi dari menu tools.');
  }

  const result = await broadcastMessageToAllUsers(msg);
  delete userState[ctx.chat.id];

  await ctx.reply(
    'Broadcast selesai.\n' +
    '- Berhasil: ' + result.ok + '\n' +
    '- Gagal: ' + result.fail
  );

  return sendAdminToolsMenu(ctx);
});
bot.action('reseller_terms_trigger', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk menjalankan cek ini.');
  }

  try {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
    const end = new Date(year, month, 0, 23, 59, 59, 999);
    const periodLabel = start.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
    await evaluateResellerTermsForPeriod(start.getTime(), end.getTime(), periodLabel);
    await ctx.reply(`✅ Cek syarat reseller untuk periode ${periodLabel} selesai.`);
  } catch (err) {
    logger.error('Error trigger cek syarat reseller:', err.message);
    await ctx.reply('❌ Gagal menjalankan cek syarat reseller.');
  }
});

bot.action('reseller_restore', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengubah reseller.');
  }

  userState[ctx.chat.id] = { step: 'reseller_restore_input' };
  await ctx.reply('Kirim ID Telegram reseller yang ingin diaktifkan kembali:');
});

bot.action('auto_backup_now', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk menjalankan backup.');
  }

  const files = [
    path.join(__dirname, 'sellvpn.db'),
    path.join(__dirname, 'ressel.db')
  ];

  for (const filePath of files) {
    if (fs.existsSync(filePath)) {
      await sendAutoBackup(filePath, adminId);
    } else {
      logger.warn(`Backup manual dilewati, file tidak ditemukan: ${filePath}`);
    }
  }

  await ctx.reply('✅ Backup otomatis telah dikirim.');
});
bot.action('admin_sync_server_now', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('Anda tidak memiliki izin untuk menjalankan sinkronisasi server.');
  }

  try {
    await ctx.reply('Menjalankan sinkronisasi server...');
    const result = await syncServerUsageFromTunnel('manual_button', { force: true });

    const lines = [
      'Sync server selesai.',
      `Dicek: ${result.checked}`,
      `Berhasil: ${result.updated}`,
      `Gagal: ${result.failed}`,
      `Dilewati: ${result.skipped}`,
      '',
      `Total akun aktif: ${result.totals.used}`,
      `Total akun tersisa: ${result.totals.remaining}`,
      `Total kapasitas: ${result.totals.capacity}`
    ];

    if (result.errors.length > 0) {
      const preview = result.errors.slice(0, 5)
        .map((e) => `- ${e.serverName || e.serverId}: ${e.message}`)
        .join('\n');
      lines.push('', 'Detail gagal (maks 5):', preview);
    }

    await ctx.reply(lines.join('\n'));
  } catch (err) {
    logger.error('Gagal sync server dari tombol admin:', err.message);
    await ctx.reply('Gagal menjalankan sinkronisasi server.');
  }
});

bot.action('reseller_terms_menu', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const adminId = ctx.from.id;
    if (!adminIds.includes(adminId)) {
      return ctx.reply('Anda tidak memiliki izin untuk mengakses menu ini.');
    }

    const terms = loadResellerTerms();
    const message =
      '*SYARAT RESELLER*\n\n' +
      `Minimal top up per bulan: ${formatRupiah(terms.min_topup)}\n\n` +
      'Gunakan tombol di bawah untuk mengubah syarat.';

    const keyboard = [
      [{ text: 'Set Syarat', callback_data: 'reseller_terms_set' }],
      [{ text: 'Kembali', callback_data: 'admin_menu' }]
    ];

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  } catch (error) {
    if (error.response && error.response.error_code === 400) {
      await ctx.reply('Gagal membuka menu. Silakan coba lagi.');
    } else {
      logger.error('Error membuka menu syarat reseller:', error.message);
    }
  }
});

bot.action('reseller_terms_set', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('Anda tidak memiliki izin untuk mengubah syarat.');
  }

  userState[ctx.chat.id] = { step: 'reseller_terms_input' };
  await ctx.reply(
    'Kirim format: <min_topup>\n' +
    'Contoh: 30000\n' +
    'Ketik \"batal\" untuk membatalkan.'
  );
});

bot.command('addressel', async (ctx) => {
  try {
    const requesterId = ctx.from.id;

    // Hanya admin yang bisa menjalankan perintah ini
    if (!adminIds.includes(requesterId)) {
      return ctx.reply('🚫 Anda tidak memiliki izin untuk melakukan tindakan ini.');
    }

    // Ambil ID Telegram dari argumen
    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
      return ctx.reply('❌ Format salah. Gunakan perintah:\n/addressel <id_telegram_user>');
    }

    const targetId = args[1];

    // Baca file ressel.db jika ada, kalau tidak, buat file baru
    let resellerList = [];
    if (fs.existsSync(resselFilePath)) {
      const fileContent = fs.readFileSync(resselFilePath, 'utf8');
      resellerList = fileContent.split('\n').filter(line => line.trim() !== '');
    }

    // Cek apakah ID sudah ada
    if (resellerList.includes(targetId)) {
      return ctx.reply(`⚠️ User dengan ID ${targetId} sudah menjadi reseller.`);
    }

    // Tambahkan ID ke file
    fs.appendFileSync(resselFilePath, `${targetId}\n`);
    ctx.reply(`✅ User dengan ID ${targetId} berhasil dijadikan reseller.`);

  } catch (e) {
    logger.error('❌ Error di command /addressel:', e.message);
    ctx.reply('❌ Terjadi kesalahan saat menjalankan perintah.');
  }
});

bot.command('delressel', async (ctx) => {
  try {
    const requesterId = ctx.from.id;

    // Hanya admin yang bisa menjalankan perintah ini
    if (!adminIds.includes(requesterId)) {
      return ctx.reply('🚫 Anda tidak memiliki izin untuk melakukan tindakan ini.');
    }

    // Ambil ID Telegram dari argumen
    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
      return ctx.reply('❌ Format salah. Gunakan perintah:\n/delressel <id_telegram_user>');
    }

    const targetId = args[1];

    // Cek apakah file ressel.db ada
    if (!fs.existsSync(resselFilePath)) {
      return ctx.reply('📁 File reseller belum dibuat.');
    }

    // Baca file dan filter ulang tanpa targetId
    const fileContent = fs.readFileSync(resselFilePath, 'utf8');
    const resellerList = fileContent.split('\n').filter(line => line.trim() !== '' && line.trim() !== targetId);

    // Tulis ulang file dengan data yang sudah difilter
    fs.writeFileSync(resselFilePath, resellerList.join('\n') + (resellerList.length ? '\n' : ''));

    ctx.reply(`✅ User dengan ID ${targetId} berhasil dihapus dari daftar reseller.`);

  } catch (e) {
    logger.error('❌ Error di command /delressel:', e.message);
    ctx.reply('❌ Terjadi kesalahan saat menjalankan perintah.');
  }
});

///////
// Saat admin mengirim foto QRIS
bot.on('photo', async (ctx) => {
  const adminId = ctx.from.id;
  const state = userState[adminId];
  if (!state || state.step !== 'upload_qris') return;

  const fileId = ctx.message.photo.pop().file_id;
  const fileLink = await ctx.telegram.getFileLink(fileId);
  const filePath = path.join(__dirname, 'qris.jpg');

  const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
  fs.writeFileSync(filePath, Buffer.from(response.data));

  await ctx.reply('✅ Gambar QRIS berhasil diunggah!');
  logger.info('🖼️ QRIS image uploaded by admin');
  delete userState[adminId];
});

bot.on('document', async (ctx) => {
  const adminId = ctx.from.id;
  const state = userState[adminId];
  if (!state || state.step !== 'restore_db_upload') return;

  if (!adminIds.includes(adminId)) {
    return ctx.reply('Anda tidak memiliki izin untuk restore database.');
  }

  const target = state.target === 'sellvpn' ? 'sellvpn' : 'ressel';
  const doc = ctx.message.document;
  const originalName = String(doc.file_name || (target + '.db'));

  try {
    const uploadDir = path.join(__dirname, 'backup', 'restore_uploads');
    fs.mkdirSync(uploadDir, { recursive: true });

    const tempName = Date.now() + '_' + originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const tempPath = path.join(uploadDir, tempName);
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
    fs.writeFileSync(tempPath, Buffer.from(response.data));

    const livePath = target === 'sellvpn'
      ? path.join(__dirname, 'sellvpn.db')
      : path.join(__dirname, 'ressel.db');

    const backupDir = path.join(__dirname, 'backup');
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, target + '.before_restore.' + Date.now() + '.db');

    if (fs.existsSync(livePath)) {
      fs.copyFileSync(livePath, backupPath);
    }

    if (target === 'sellvpn') {
      await new Promise((resolve) => {
        db.close(() => resolve());
      });
    }

    fs.copyFileSync(tempPath, livePath);
    fs.unlinkSync(tempPath);

    delete userState[adminId];

    if (target === 'sellvpn') {
      await ctx.reply('Restore sellvpn.db berhasil. Bot akan restart otomatis untuk memuat database baru.');
      setTimeout(() => process.exit(0), 1200);
      return;
    }

    return ctx.reply('Restore ressel.db berhasil.');
  } catch (err) {
    logger.error('Gagal restore database:', err.message);
    return ctx.reply('Gagal restore database. Pastikan file backup valid.');
  }
});

// ✅ BUAT INI SATU SAJA (tempat yang sama dengan action lainnya)
bot.action('topup_saldo', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    if (!loadTopupAutoSetting()) {
      await ctx.reply(
        '❌ *TOP-UP OTOMATIS SEDANG NONAKTIF*\n\n' +
        'Silakan gunakan menu *TopUp Manual* untuk sementara.',
        { parse_mode: 'Markdown' }
      );
      return;
    }
    
    // Cek credential OrderKuota REAL-TIME
    const { buildPayload } = require('./api-cekpayment-orkut');
    const qs = require('qs');
    const payload = buildPayload();
    const decoded = qs.parse(payload);
    
    // Cek apakah masih pakai credential default
    const isDefaultCredential = 
      decoded.username === 'yantoxxx' || 
      (decoded.token && (
        decoded.token.includes('xxxxx') ||
        decoded.token.includes('TOKEN_DEFAULT') ||
        decoded.token.includes('contoh')
      ));
    
// Di dalam topup_saldo handler - bagian if (isDefaultCredential):
if (isDefaultCredential) {
  // ❌ MODE DISABLED - Credential masih default
  await ctx.reply(
    '❌ *TOP-UP OTOMATIS SEMENTARA TIDAK TERSEDIA*\n\n' +
    'Admin belum mengkonfigurasi sistem pembayaran.\n' +
    'Sistem tidak dapat memverifikasi pembayaran Anda.\n\n' +
    `📞 Hubungi admin: ${ADMIN_USERNAME}\n\n` +
    '🔧 *Admin bisa cek konfigurasi dengan:*\n' +
    '`/checkpaymentconfig`\n\n' +
    '_Admin sudah mendapatkan notifikasi untuk segera memperbaiki sistem._',
    { parse_mode: 'Markdown' }
  );
  
  // Log warning
  logger.warn(`User ${ctx.from.id} mencoba topup tapi credential masih default`);
  return;
}      
    
    // ✅ MODE ENABLED - Credential sudah benar
    const userId = ctx.from.id;
    
    if (!global.depositState) {
      global.depositState = {};
    }
    global.depositState[userId] = { action: 'request_amount', amount: '' };
    
    const keyboard = keyboard_nomor();
    
    const bonusCfg = loadTopupBonusSetting();
    const bonusInfo = bonusCfg.enabled
      ? (
        `🎁 *BONUS TOPUP OTOMATIS:*\n` +
        `• 10-49rb: ${bonusCfg.range_10_40}%\n` +
        `• 50-79rb: ${bonusCfg.range_50_70}%\n` +
        `• 80rb+: ${bonusCfg.range_70_100}%\n\n`
      )
      : '';

    await ctx.editMessageText(
      '💰 *TOP UP SALDO OTOMATIS*\n\n' +
      '💳 *Minimal:* Rp 2.000\n\n' +
      bonusInfo +
      '🎲 *SISTEM KEAMANAN BARU:*\n' +
      '• Biaya admin **RANDOM 100-200**\n' +
      '• Setiap transaksi punya **nominal unik**\n' +
      '• Mencegah duplikasi pembayaran\n\n' +
      '⚠️ *PERHATIAN:*\n' +
      'Transfer harus **TEPAT** sesuai nominal unik yang diberikan!\n\n' +
      'Silakan masukkan jumlah top-up:',
      {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
      }
    );
    
    logger.info(`User ${userId} memulai topup (credential valid)`);
    
  } catch (error) {
    logger.error('❌ Error in topup_saldo handler:', error);
    await ctx.reply(
      '❌ Terjadi kesalahan sistem.\nSilakan coba lagi atau hubungi admin.',
      { parse_mode: 'Markdown' }
    );
  }
});

// === 📞 HUBUNGI ADMIN (WHATSAPP) ===
bot.action('hubungi_admin', async (ctx) => {
  try {
    await ctx.answerCbQuery();

    const userId = ctx.from.id;
    const userName = ctx.from.first_name || ctx.from.username || `User ${userId}`;

    const adminWhatsApp = getAdminWhatsappNumber();
    const adminWhatsappUrl = getAdminWhatsappUrl();
    if (!adminWhatsApp || !adminWhatsappUrl) {
      return ctx.reply(`⚠️ Kontak WhatsApp admin belum diset. Silakan hubungi ${getAdminTelegramUsername()} terlebih dahulu.`);
    }

    const autoMessage = encodeURIComponent(
      `Hallo min aku dari bot mau menyampaikan sesuatu\n\n` +
      `ID Telegram: ${userId}\n` +
      `Nama: ${userName}`
    );

    const whatsappUrl = `${adminWhatsappUrl}?text=${autoMessage}`;

    await ctx.reply(
      `📞 *HUBUNGI ADMIN*\n\n` +
      `Klik tombol di bawah untuk menghubungi admin via WhatsApp:\n\n` +
      `👤 Nama Anda: *${userName}*\n` +
      `🆔 ID Telegram: *${userId}*\n\n` +
      `ℹ️ *ID Telegram Anda sudah disertakan dalam pesan otomatis*\n\n` +
      `Pesan otomatis sudah disiapkan. Anda bisa mengeditnya sebelum mengirim.`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📱 Buka WhatsApp (Pesan Otomatis)', url: whatsappUrl }],
            [{ text: '📝 Kirim Pesan Manual', url: adminWhatsappUrl }],
            [{ text: '🔙 Kembali', callback_data: 'send_main_menu' }]
          ]
        }
      }
    );

    logger.info(`User ${userId} membuka menu hubungi admin`);
  } catch (error) {
    logger.error('❌ Error di tombol hubungi_admin:', error.message);
    await ctx.reply('⚠️ Terjadi kesalahan saat membuka WhatsApp. Silakan coba lagi.');
  }
});


bot.action('check_expiry_account', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;

  let isReseller = false;
  try {
    isReseller = await isUserReseller(userId);
  } catch (e) {
    logger.error('Error cek role reseller untuk cek masa aktif:', e.message);
  }

  db.all(
    `SELECT MIN(id) AS id,
            host AS server_name
     FROM (
       SELECT id,
              LOWER(TRIM(COALESCE(NULLIF(sync_host, ''), NULLIF(domain, ''), ''))) AS host
       FROM Server
       WHERE (COALESCE(is_reseller_only, 0) = 0 OR ? = 1)
     ) grouped
     WHERE host <> ''
     GROUP BY host
     ORDER BY host COLLATE NOCASE ASC`,
    [isReseller ? 1 : 0],
    async (err, rows) => {
      if (err) {
        logger.error('Error ambil daftar server cek masa aktif:', err.message);
        return ctx.reply('Terjadi kesalahan saat memuat daftar server.');
      }

      if (!rows || rows.length === 0) {
        return ctx.reply('Belum ada server tersedia untuk role akun kamu.');
      }

      const keyboard = rows.map((row) => ([{
        text: row.server_name,
        callback_data: `check_expiry_server_${row.id}`
      }]));

      keyboard.push([{ text: 'Kembali', callback_data: 'send_main_menu' }]);

      await ctx.reply(
        'Akun kamu ada di server mana? untuk melihatnya kamu bisa cek di informasi akun kamu\n\n'+
        'Pilih server untuk cek masa aktif akun:',
         {
        reply_markup: { inline_keyboard: keyboard }
      });
    }
  );
});

bot.action(/check_expiry_server_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const serverId = Number(ctx.match[1]);

  db.get('SELECT id, nama_server, domain FROM Server WHERE id = ?', [serverId], async (err, row) => {
    if (err) {
      logger.error('Error ambil server cek masa aktif:', err.message);
      return ctx.reply('Terjadi kesalahan saat mengambil data server.');
    }

    if (!row) {
      return ctx.reply('Server tidak ditemukan.');
    }

    userState[ctx.chat.id] = {
      step: 'check_expiry_username',
      serverId,
      serverName: row.nama_server || row.domain || ('ID ' + serverId)
    };

    await ctx.reply(
      'Masukkan username akun yang ingin dicek masa aktifnya.\n' +
      'Ketik "batal" untuk membatalkan.'
    );
  });
});

db.run(`CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  type TEXT,
  username TEXT,
  password TEXT,
  server_id INTEGER,
  server_name TEXT,
  domain TEXT,
  link_tls TEXT,
  link_none TEXT,
  link_grpc TEXT,
  link_uptls TEXT,
  link_upntls TEXT,
  created_at INTEGER,
  expires_at INTEGER
)`, (err) => {
  if (err) {
    logger.error('Kesalahan membuat tabel accounts:', err.message);
  } else {
    logger.info('Accounts table created or already exists');
    migrateAccountServerByDomain()
      .then((res) => {
        if (res && res.updated > 0) {
          logger.info('Migrasi accounts server_id selesai: ' + res.updated + '/' + res.total + ' data diperbarui');
        }
      })
      .catch((e) => logger.error('Error migrasi accounts server_id:', e.message));
  }
});

db.all("PRAGMA table_info(accounts)", (err, rows) => {
  if (err) {
    logger.error('Error checking accounts schema:', err.message);
    return;
  }
  const cols = rows.map(r => r.name);
  if (!cols.includes('link_tls')) db.run("ALTER TABLE accounts ADD COLUMN link_tls TEXT");
  if (!cols.includes('link_none')) db.run("ALTER TABLE accounts ADD COLUMN link_none TEXT");
  if (!cols.includes('link_grpc')) db.run("ALTER TABLE accounts ADD COLUMN link_grpc TEXT");
  if (!cols.includes('link_uptls')) db.run("ALTER TABLE accounts ADD COLUMN link_uptls TEXT");
  if (!cols.includes('link_upntls')) db.run("ALTER TABLE accounts ADD COLUMN link_upntls TEXT");
});

bot.action('view_accounts', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const now = Date.now();

  db.get(
    'SELECT COUNT(*) as count FROM accounts WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)',
    [userId, now],
    async (err, row) => {
      if (err) {
        logger.error('❌ Error hitung akun aktif:', err.message);
        return ctx.reply('❌ Terjadi kesalahan saat memuat akun.');
      }
      const total = row ? row.count : 0;
      const keyboard = [
        [{ text: '✅ Lihat Akun Aktif Saya', callback_data: 'view_accounts_active' }]
      ];
      if (total > 10) {
        keyboard.push([{ text: '📂 Lihat Semua Akun Saya', callback_data: 'view_accounts_active_all' }]);
      }
      keyboard.push([{ text: '⌛ Lihat Akun Expired', callback_data: 'view_accounts_expired' }]);
      keyboard.push([{ text: '🔙 Kembali', callback_data: 'send_main_menu' }]);

      await ctx.reply('📂 *Lihat Akun Saya*', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
    }
  );
});


const SELF_DELETE_TYPE_HANDLERS = {
  ssh: delssh,
  vmess: delvmess,
  vless: delvless,
  trojan: deltrojan,
  udp_http: deludphttp,
  zivpn: delzivpn
};

function calcRemainingDays(expiresAt) {
  if (!expiresAt) return 0;
  const diff = Number(expiresAt) - Date.now();
  if (!Number.isFinite(diff) || diff <= 0) return 0;
  return Math.ceil(diff / (24 * 60 * 60 * 1000));
}

function getEffectiveServerPrice(serverRow, isReseller) {
  const hargaUser = Number(serverRow?.harga || 0);
  const hargaReseller = Number(serverRow?.harga_reseller || 0);
  if (isReseller && hargaReseller > 0) return hargaReseller;
  return hargaUser;
}

function isStrongCreateUsername(username) {
  const letterCount = (username.match(/[a-z]/g) || []).length;
  const digitCount = (username.match(/[0-9]/g) || []).length;
  return letterCount >= 4 && digitCount >= 4;
}

bot.action('delete_my_account_intro', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply(
    '⚠️ *Hapus Akun Saya*\n\n' +
    'Penghapusan hanya bisa jika sisa masa aktif minimal 2 hari.\n' +
    'Akun baru bisa dihapus setelah aktif minimal 24 jam.\n' +
    'Konversi saldo dihitung full sesuai sisa hari.\n\n' +
    'Lanjut pilih server akun yang ingin dihapus.',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🗂️ Pilih Server', callback_data: 'delete_my_account_select_server' }],
          [{ text: '🔙 Kembali', callback_data: 'send_main_menu' }]
        ]
      }
    }
  );
});

bot.action('delete_my_account_select_server', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const now = Date.now();

  let isReseller = false;
  try {
    isReseller = await isUserReseller(userId);
  } catch (e) {
    logger.error('Error cek role reseller:', e.message);
  }

  db.all(
    `SELECT s.id AS server_id,
            COALESCE(NULLIF(s.nama_server, ''), s.domain, 'Server') AS server_name,
            (
              SELECT COUNT(*)
              FROM accounts a
              WHERE a.user_id = ?
                AND (a.expires_at IS NULL OR a.expires_at > ?)
                AND (
                  a.server_id = s.id
                  OR (
                    TRIM(COALESCE(s.domain, '')) <> ''
                    AND LOWER(TRIM(COALESCE(a.domain, ''))) = LOWER(TRIM(COALESCE(s.domain, '')))
                    AND (
                      (UPPER(COALESCE(s.nama_server, '')) LIKE '%1IP%' AND UPPER(COALESCE(a.server_name, '')) LIKE '%1IP%')
                      OR (UPPER(COALESCE(s.nama_server, '')) LIKE '%2IP%' AND UPPER(COALESCE(a.server_name, '')) LIKE '%2IP%')
                      OR (
                        UPPER(COALESCE(s.nama_server, '')) NOT LIKE '%1IP%'
                        AND UPPER(COALESCE(s.nama_server, '')) NOT LIKE '%2IP%'
                        AND UPPER(COALESCE(a.server_name, '')) NOT LIKE '%1IP%'
                        AND UPPER(COALESCE(a.server_name, '')) NOT LIKE '%2IP%'
                      )
                    )
                  )
                )
            ) AS total_accounts
     FROM Server s
     WHERE (COALESCE(s.is_reseller_only, 0) = 0 OR ? = 1)
     ORDER BY server_name COLLATE NOCASE ASC`,
    [userId, now, isReseller ? 1 : 0],
    async (err, rows) => {
      if (err) {
        logger.error('Error ambil server akun user:', err.message);
        return ctx.reply('Terjadi kesalahan saat memuat daftar server akun.');
      }

      if (!rows || rows.length === 0) {
        return ctx.reply('Tidak ada akun aktif di server ini.', {
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Pilih Server Lain', callback_data: 'delete_my_account_select_server' }],
              [{ text: 'Kembali', callback_data: 'send_main_menu' }]
            ]
          }
        });
      }

      const keyboard = rows.map((row) => ([{
        text: `${row.server_name} (${row.total_accounts} akun)`,
        callback_data: `delete_my_account_server_${row.server_id}`
      }]));
      keyboard.push([{ text: 'Kembali', callback_data: 'delete_my_account_intro' }]);

      await ctx.reply('Pilih server akun yang ingin dihapus:', {
        reply_markup: { inline_keyboard: keyboard }
      });
    }
  );
});
bot.action(/delete_my_account_server_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const now = Date.now();
  const serverId = Number(ctx.match[1]);

  db.all(
    `SELECT a.id, a.type, a.username, a.server_name, a.domain, a.expires_at,
            COALESCE(s.harga, 0) AS harga
     FROM accounts a
     LEFT JOIN Server s ON s.id = a.server_id
     LEFT JOIN Server ss ON ss.id = ?
     WHERE a.user_id = ?
       AND (
         a.server_id = ?
         OR (
           TRIM(COALESCE(ss.domain, '')) <> ''
           AND LOWER(TRIM(COALESCE(a.domain, ''))) = LOWER(TRIM(COALESCE(ss.domain, '')))
           AND (
             (UPPER(COALESCE(ss.nama_server, '')) LIKE '%1IP%' AND UPPER(COALESCE(a.server_name, '')) LIKE '%1IP%')
             OR (UPPER(COALESCE(ss.nama_server, '')) LIKE '%2IP%' AND UPPER(COALESCE(a.server_name, '')) LIKE '%2IP%')
             OR (
               UPPER(COALESCE(ss.nama_server, '')) NOT LIKE '%1IP%'
               AND UPPER(COALESCE(ss.nama_server, '')) NOT LIKE '%2IP%'
               AND UPPER(COALESCE(a.server_name, '')) NOT LIKE '%1IP%'
               AND UPPER(COALESCE(a.server_name, '')) NOT LIKE '%2IP%'
             )
           )
         )
       )
       AND (a.expires_at IS NULL OR a.expires_at > ?)
     ORDER BY a.expires_at ASC, a.id ASC`,
    [serverId, userId, serverId, now],
    async (err, rows) => {
      if (err) {
        logger.error('Error ambil akun berdasarkan server:', err.message);
        return ctx.reply('Terjadi kesalahan saat memuat akun server.');
      }

      if (!rows || rows.length === 0) {
        return ctx.reply('Tidak ada akun aktif yang terhubung ke server ini di data bot.', {
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Pilih Server Lain', callback_data: 'delete_my_account_select_server' }],
              [{ text: 'Kembali', callback_data: 'send_main_menu' }]
            ]
          }
        });
      }

      const keyboard = rows.map((row) => {
        const remainingDays = calcRemainingDays(row.expires_at);
        return [{
          text: `${row.username} (${String(row.type || '-').toUpperCase()}, ${remainingDays} hari)`,
          callback_data: `delete_my_account_pick_${row.id}`
        }];
      });
      keyboard.push([{ text: 'Pilih Server', callback_data: 'delete_my_account_select_server' }]);

      await ctx.reply('Pilih akun yang ingin dihapus:', {
        reply_markup: { inline_keyboard: keyboard }
      });
    }
  );
});
bot.action(/delete_my_account_pick_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const accountId = Number(ctx.match[1]);
  const isReseller = await isUserReseller(userId).catch(() => false);

  db.get(
    `SELECT a.*, COALESCE(s.harga, 0) AS harga, COALESCE(s.harga_reseller, 0) AS harga_reseller
     FROM accounts a
     LEFT JOIN Server s ON s.id = a.server_id
     WHERE a.id = ? AND a.user_id = ?`,
    [accountId, userId],
    async (err, row) => {
      if (err) {
        logger.error('❌ Error ambil detail akun untuk hapus mandiri:', err.message);
        return ctx.reply('❌ Terjadi kesalahan saat memuat detail akun.');
      }
      if (!row) {
        return ctx.reply('❌ Akun tidak ditemukan atau bukan milik kamu.');
      }

      const remainingDays = calcRemainingDays(row.expires_at);
      const accountAgeMs = Date.now() - Number(row.created_at || 0);
      const lockDelete24h = !Number.isFinite(accountAgeMs) || accountAgeMs < (24 * 60 * 60 * 1000);
      const refund = Math.max(0, remainingDays * getEffectiveServerPrice(row, isReseller));
      const serverLabel = row.server_name || row.domain || '-';

      await ctx.reply(
        'Konfirmasi Hapus Akun\n\n' +
        `- <b>Username:</b> ${escapeHtml(row.username || '-')}\n` +
        `- <b>Layanan:</b> ${escapeHtml(String(row.type || '-').toUpperCase())}\n` +
        `- <b>Server:</b> ${escapeHtml(serverLabel)}\n` +
        `- <b>Sisa hari:</b> ${remainingDays} hari\n` +
        `- <b>Konversi saldo:</b> Rp ${Number(refund).toLocaleString('id-ID')}\n\n` +
        ((remainingDays < 2 || lockDelete24h)
          ? `Akun ini belum bisa dihapus.${remainingDays < 2 ? ' Minimal sisa masa aktif 2 hari.' : ''}${lockDelete24h ? ' Akun harus aktif minimal 24 jam.' : ''}`
          : 'Akun akan dihapus permanen dari server.'),
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              ...((remainingDays >= 2 && !lockDelete24h) ? [[{ text: 'Ya, Hapus Akun Ini', callback_data: `delete_my_account_confirm_${row.id}` }]] : []),
              [{ text: 'Batal', callback_data: 'delete_my_account_select_server' }]
            ]
          }
        }
      );
    }
  );
});

bot.action(/delete_my_account_confirm_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const accountId = Number(ctx.match[1]);
  const isReseller = await isUserReseller(userId).catch(() => false);

  const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
  const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });

  try {
    const row = await dbGet(
      `SELECT a.*, COALESCE(s.harga, 0) AS harga, COALESCE(s.harga_reseller, 0) AS harga_reseller
       FROM accounts a
       LEFT JOIN Server s ON s.id = a.server_id
       WHERE a.id = ? AND a.user_id = ?`,
      [accountId, userId]
    );

    if (!row) {
      return ctx.reply('❌ Akun tidak ditemukan atau sudah terhapus.');
    }

    const deleteFn = SELF_DELETE_TYPE_HANDLERS[row.type];
    if (!deleteFn) {
      return ctx.reply(`❌ Layanan ${row.type} belum didukung untuk hapus mandiri.`);
    }

    const result = await deleteFn(row.username, 'none', 'none', 'none', row.server_id);
    const resultText = typeof result === 'string' ? result : JSON.stringify(result || {});
    if (/gagal|error|failed|tidak\s+ditemukan|not\s+found/i.test(resultText)) {
      logger.error(`❌ Gagal hapus akun mandiri ${row.username} (${row.type}): ${resultText}`);
      return ctx.reply(`❌ Gagal hapus akun dari server.\n\n${resultText}`);
    }

    const remainingDays = calcRemainingDays(row.expires_at);
    if (remainingDays < 2) {
      return ctx.reply('Akun belum bisa dihapus. Minimal sisa masa aktif 2 hari.');
    }
    const accountAgeMs = Date.now() - Number(row.created_at || 0);
    if (!Number.isFinite(accountAgeMs) || accountAgeMs < (24 * 60 * 60 * 1000)) {
      return ctx.reply('Akun belum bisa dihapus. Akun harus aktif minimal 24 jam.');
    }
    const refund = Math.max(0, remainingDays * getEffectiveServerPrice(row, isReseller));

    await dbRun('DELETE FROM accounts WHERE id = ? AND user_id = ?', [accountId, userId]);

    if (refund > 0) {
      await dbRun('INSERT OR IGNORE INTO users (user_id, saldo) VALUES (?, 0)', [userId]);
      await dbRun('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', [refund, userId]);
      await dbRun(
        'INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, ?, ?, ?)',
        [userId, refund, 'delete_refund', `delete_refund_${accountId}_${Date.now()}`, Date.now()]
      );
    }

    await notifyGroupAccountDeleted({
      action: 'self_delete',
      actorId: ctx.from.id,
      actorUsername: ctx.from.username || '',
      targetUserId: userId,
      accountUsername: row.username,
      service: String(row.type || '-').toUpperCase(),
      serverName: row.server_name || row.domain || '-',
      refund,
      remainingDays,
      note: 'User hapus akun sendiri'
    });

    await ctx.reply(
      `✅ Akun berhasil dihapus.\n` +
      `• Username: ${row.username}\n` +
      `• Layanan: ${String(row.type || '-').toUpperCase()}\n` +
      `• Server: ${row.server_name || row.domain || '-'}\n` +
      `• Konversi ke saldo: Rp ${Number(refund).toLocaleString('id-ID')}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🗂️ Hapus Akun Lain', callback_data: 'delete_my_account_select_server' }],
            [{ text: '🔙 Menu Utama', callback_data: 'send_main_menu' }]
          ]
        }
      }
    );
  } catch (e) {
    logger.error('❌ Error konfirmasi hapus akun mandiri:', e.message);
    await ctx.reply('❌ Terjadi kesalahan saat menghapus akun.');
  }
});
async function sendAccountList(ctx, isExpired, limit = 10) {
  const userId = ctx.from.id;
  const now = Date.now();
  const cutoff = now - (3 * 24 * 60 * 60 * 1000);
  if (isExpired) {
    cleanupExpiredAccounts();
    limit = 0;
  }

  const query = isExpired
    ? `SELECT * FROM accounts WHERE user_id = ? AND expires_at <= ? AND expires_at >= ? ORDER BY expires_at DESC${limit ? ' LIMIT ' + limit : ''}`
    : `SELECT * FROM accounts WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC${limit ? ' LIMIT ' + limit : ''}`;
  const params = isExpired ? [userId, now, cutoff] : [userId, now];

  db.all(query, params, async (err, rows) => {
    if (err) {
      const errMsg = err && err.message ? err.message : String(err);
      logger.error('❌ Error ambil akun:', errMsg);
      if (errMsg.includes('no such table')) {
        return ctx.reply('📭 Belum ada data akun. Silakan buat akun dulu.');
      }
      return ctx.reply('❌ Terjadi kesalahan saat mengambil data akun.');
    }
    if (!rows || rows.length === 0) {
      return ctx.reply(isExpired ? '📭 Tidak ada akun expired.' : '📭 Tidak ada akun aktif.');
    }

    const escapeHtmlLocal = (text) => {
      if (!text && text !== 0) return '';
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    };

    const items = rows.map((row, idx) => {
      const expText = row.expires_at ? formatDateId(new Date(row.expires_at)) : '-';
      const linkLines = [];
      if (row.link_tls) linkLines.push(`- <b>Link TLS</b>: <code>${escapeHtmlLocal(row.link_tls)}</code>`);
      if (row.link_none) linkLines.push(`- <b>Link NTLS</b>: <code>${escapeHtmlLocal(row.link_none)}</code>`);
      if (row.link_grpc) linkLines.push(`- <b>Link GRPC</b>: <code>${escapeHtmlLocal(row.link_grpc)}</code>`);

      const isZivpn = String(row.type || '').toLowerCase() === 'zivpn';
      const accountLabel = isZivpn ? 'UDP Password' : 'Username';
      const passwordLine = (!isZivpn && row.password)
        ? `- <b>Password:</b> ${escapeHtmlLocal(row.password)}\n`
        : '';

      return (
        `#${idx + 1}\n` +
        `- <b>Layanan:</b> ${escapeHtmlLocal(row.type).toUpperCase()}\n` +
        `- <b>${accountLabel}:</b> ${escapeHtmlLocal(row.username)}\n` +
        passwordLine +
        `- <b>Server:</b> ${escapeHtmlLocal(row.server_name || row.domain || '-')}\n` +
        `- <b>Domain:</b> ${escapeHtmlLocal(row.domain || '-')}\n` +
        `- <b>Expired:</b> ${escapeHtmlLocal(expText)}` +
        (linkLines.length ? `\n${linkLines.join('\n')}` : '')
      );
    }).join('\n\n');

    await ctx.reply(`<b>${isExpired ? 'Akun Expired' : 'Akun Aktif'}</b>\n\n${items}`, { parse_mode: 'HTML' });
  });
}

bot.action('view_accounts_active', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await sendAccountList(ctx, false, 10);
});

bot.action('view_accounts_active_all', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await sendAccountList(ctx, false, 0);
});

bot.action('view_accounts_expired', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await sendAccountList(ctx, true, 0);
});

async function sendToolsMenu(ctx) {
  const keyboard = [
    [
      { text: '♻️ Perpanjang Akun', callback_data: 'service_renew' },
      { text: '📶 Cek Server', callback_data: 'cek_server' }
    ],
    [
      { text: '🧩 Rubah Link Vmess, Vless dan Trojan To JSON', callback_data: 'hc_v2ray' }
    ],
    [
      { text: '💳 Riwayat TopUp', callback_data: 'topup_history' }
    ],
    [{ text: '🔙 Kembali', callback_data: 'send_main_menu' }]
  ];

  try {
    if (ctx.updateType === 'callback_query') {
      await ctx.editMessageText('*🧰 MENU TOOLS*', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
    } else {
      await ctx.reply('*🧰 MENU TOOLS*', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
    }
  } catch (error) {
    logger.error('Error saat mengirim menu tools:', error);
  }
}

bot.action('menu_tools', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await sendToolsMenu(ctx);
});

bot.action('topup_history', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  db.all(
    `SELECT amount, type, timestamp
     FROM transactions
     WHERE user_id = ? AND type IN ('deposit','deposit_bonus')
     ORDER BY timestamp DESC
     LIMIT 10`,
    [userId],
    async (err, rows) => {
      if (err) {
        logger.error('❌ Error ambil riwayat topup:', err.message);
        return ctx.reply('❌ Terjadi kesalahan saat mengambil riwayat topup.');
      }
      if (!rows || rows.length === 0) {
        return ctx.reply('📭 Belum ada riwayat topup.');
      }

      const items = rows.map((row, idx) => {
        const dateText = row.timestamp ? new Date(row.timestamp).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) : '-';
        const label = row.type === 'deposit_bonus' ? 'Bonus' : 'TopUp';
        return (
          `#${idx + 1}\n` +
          `• <b>Tipe:</b> ${escapeHtmlLocal(label)}\n` +
          `• <b>Nominal:</b> ${escapeHtmlLocal(formatRupiah(row.amount))}\n` +
          `• <b>Waktu:</b> ${escapeHtmlLocal(dateText)}`
        );
      }).join('\n\n');

      return ctx.reply(`💳 <b>Riwayat TopUp (10 terakhir)</b>\n\n${items}`, { parse_mode: 'HTML' });
    }
  );
});

function parseVmessLink(link) {
  const raw = link.replace(/^vmess:\/\//i, '').trim();
  const padded = raw.padEnd(Math.ceil(raw.length / 4) * 4, '=');
  const decoded = Buffer.from(padded, 'base64').toString('utf8');
  const data = JSON.parse(decoded);
  return {
    protocol: 'vmess',
    address: data.add || '',
    port: Number(data.port || 0),
    id: data.id || '',
    alterId: Number(data.aid || 0),
    security: data.scy || data.security || 'auto',
    network: data.net || 'ws',
    path: data.path || '/',
    host: data.host || data.sni || data.add || '',
    tls: data.tls || '',
    sni: data.sni || data.host || ''
  };
}

function parseVlessLink(link) {
  const url = new URL(link);
  return {
    protocol: 'vless',
    address: url.hostname,
    port: Number(url.port || 0),
    id: decodeURIComponent(url.username || ''),
    security: url.searchParams.get('security') || 'none',
    network: url.searchParams.get('type') || 'ws',
    path: url.searchParams.get('path') || '/',
    host: url.searchParams.get('host') || url.searchParams.get('sni') || url.hostname,
    sni: url.searchParams.get('sni') || ''
  };
}

function parseTrojanLink(link) {
  const url = new URL(link);
  return {
    protocol: 'trojan',
    address: url.hostname,
    port: Number(url.port || 0),
    password: decodeURIComponent(url.username || ''),
    security: url.searchParams.get('security') || 'none',
    network: url.searchParams.get('type') || 'ws',
    path: url.searchParams.get('path') || '/',
    host: url.searchParams.get('host') || url.searchParams.get('sni') || url.hostname,
    sni: url.searchParams.get('sni') || ''
  };
}

function buildHcJson(parsed, bugHost) {
  const address = bugHost;
  const isTls = parsed.security === 'tls' || parsed.tls === 'tls';
  const port = parsed.port || (isTls ? 443 : 80);
  const outbound = {
    mux: { enabled: false },
    protocol: parsed.protocol,
    settings: {},
    streamSettings: {
      network: parsed.network || 'ws',
      security: isTls ? 'tls' : 'none'
    },
    tag: parsed.protocol.toUpperCase()
  };

  if (parsed.protocol === 'vmess') {
    outbound.settings.vnext = [{
      address,
      port,
      users: [{
        alterId: parsed.alterId || 0,
        id: parsed.id || '',
        level: 8,
        security: parsed.security === 'tls' ? 'auto' : (parsed.security || 'auto')
      }]
    }];
  } else if (parsed.protocol === 'vless') {
    outbound.settings.vnext = [{
      address,
      port,
      users: [{
        id: parsed.id || '',
        encryption: 'none',
        level: 8
      }]
    }];
  } else if (parsed.protocol === 'trojan') {
    outbound.settings.servers = [{
      address,
      port,
      password: parsed.password || '',
      level: 8
    }];
  }

  if (parsed.network === 'grpc') {
    outbound.streamSettings.grpcSettings = {
      serviceName: (parsed.path || '').replace(/^\//, '') || parsed.protocol
    };
  } else if (parsed.network === 'httpupgrade') {
    outbound.streamSettings.httpupgradeSettings = {
      path: parsed.path || '/',
      host: parsed.host || parsed.sni || ''
    };
  } else {
    outbound.streamSettings.wsSettings = {
      headers: { Host: parsed.host || parsed.sni || '' },
      path: parsed.path || '/'
    };
  }

  if (isTls) {
    const serverName = parsed.sni || parsed.host || '';
    outbound.streamSettings.tlsSettings = { allowInsecure: true, serverName };
  }

  return {
    inbounds: [],
    outbounds: [outbound],
    policy: {
      levels: {
        8: {
          connIdle: 300,
          downlinkOnly: 1,
          handshake: 4,
          uplinkOnly: 1
        }
      }
    }
  };
}

bot.action('hc_v2ray', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  userState[ctx.chat.id] = { step: 'hc_link' };
  await ctx.reply(
    'Kirim link *VMESS/VLESS/TROJAN* (TLS/NTLS).\n' +
    'Contoh: `vmess://...`',
    { parse_mode: 'Markdown' }
  );
});

// =================== HANDLER CONFIRM HAPUS SALDO ===================
bot.action('confirm_hapus_saldo', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const adminId = ctx.from.id;
    const state = userState[adminId];
    
    if (!state || state.step !== 'hapus_saldo_confirm') {
      return ctx.reply('❌ Sesi sudah berakhir. Silakan ulangi dari awal.');
    }
    
    const targetUserId = state.targetUserId;
    const amount = state.amountToRemove;
    
    // Lakukan pengurangan saldo
    db.run('UPDATE users SET saldo = saldo - ? WHERE user_id = ?', [amount, targetUserId], function (err) {
      if (err) {
        logger.error('❌ Error hapus saldo via menu:', err.message);
        return ctx.reply('❌ Gagal menghapus saldo.');
      }
      
      // Ambil saldo terbaru
      db.get('SELECT saldo FROM users WHERE user_id = ?', [targetUserId], (err2, updatedRow) => {
        delete userState[adminId];
        
        if (err2) {
          ctx.reply(`✅ Saldo sebesar *Rp ${amount.toLocaleString('id-ID')}* berhasil dihapus dari user \`${targetUserId}\`.`);
        } else {
          ctx.reply(
            `✅ *SALDO BERHASIL DIHAPUS!*\n\n` +
            `👤 User ID: \`${targetUserId}\`\n` +
            `🗑️ Jumlah dihapus: *Rp ${amount.toLocaleString('id-ID')}*\n` +
            `💰 Saldo sekarang: *Rp ${updatedRow.saldo.toLocaleString('id-ID')}*`,
            { parse_mode: 'Markdown' }
          );
        }
        
        // Log ke transactions
        const referenceId = `remove_saldo_${targetUserId}_${Date.now()}`;
        db.run(
          'INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, ?, ?, ?)',
          [targetUserId, amount, 'saldo_removed', referenceId, Date.now()],
          (err3) => {
            if (err3) logger.error('Gagal log transaksi hapus saldo:', err3.message);
          }
        );
        
        // Log ke file
        logger.info(`Admin ${adminId} menghapus saldo Rp${amount} dari user ${targetUserId}. Saldo akhir: Rp${updatedRow ? updatedRow.saldo : 'N/A'}`);
        
        // Kirim notifikasi ke user yang saldonya dihapus
        try {
          bot.telegram.sendMessage(
            targetUserId,
            `⚠️ *PEMBERITAHUAN SALDO*\n\n` +
            `Saldo Anda dikurangi sebesar *Rp ${amount.toLocaleString('id-ID')}* oleh admin.\n` +
            `💰 Saldo sekarang: *Rp ${updatedRow ? updatedRow.saldo.toLocaleString('id-ID') : '0'}*\n\n` +
            `📅 ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`,
            { parse_mode: 'Markdown' }
          ).catch(() => {
            // User mungkin memblokir bot, tidak apa-apa
          });
        } catch (notifErr) {
          logger.error('Gagal kirim notifikasi ke user:', notifErr.message);
        }
      });
    });
    
  } catch (error) {
    logger.error('❌ Error in confirm_hapus_saldo:', error);
    await ctx.reply('❌ Terjadi kesalahan saat menghapus saldo.');
  }
});

bot.action('cancel_hapus_saldo', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  delete userState[adminId];
  await ctx.reply('❌ Proses penghapusan saldo dibatalkan.');
});

// =================== HANDLER HAPUS SALDO ===================
bot.action('hapus_saldo', async (ctx) => {
  const adminId = ctx.from.id;
  
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin.');
  }
  
  await ctx.answerCbQuery();
  userState[adminId] = { step: 'hapus_saldo_userid' };
  await ctx.reply('🗑️ *Masukkan ID Telegram user yang saldonya akan dihapus:*', { parse_mode: 'Markdown' });
});

//callback handller statistik reseller
bot.action('reseller_stats', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    
    // Cek reseller
    const isReseller = await isUserReseller(userId);
    if (!isReseller) {
      return ctx.reply('❌ Fitur ini hanya untuk reseller!');
    }
    
    // ✅ KIRIM PESAN LOADING DAN SIMPAN ID-NYA
    const loadingMsg = await ctx.reply('⏳ Mengambil data statistik...');
    const loadingMsgId = loadingMsg.message_id;
    
    // Ambil data
    db.get('SELECT saldo FROM users WHERE user_id = ?', [userId], async (err, user) => {
      if (err) {
        // ❌ HAPUS PESAN LOADING JIKA ERROR
        try {
          await ctx.deleteMessage(loadingMsgId);
        } catch (e) {}
        await ctx.reply('❌ Terjadi kesalahan saat mengambil data.');
        return;
      }
      
      const saldo = user ? user.saldo : 0;
      const now = new Date();
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      
      db.all(
        `SELECT type, COUNT(*) as count FROM transactions 
         WHERE user_id = ? AND timestamp >= ? AND timestamp <= ?
         AND type IN ('ssh', 'vmess', 'vless', 'trojan', 'shadowsocks', 'zivpn', 'udp_http')
         AND reference_id NOT LIKE 'account-trial-%'
         GROUP BY type`,
        [userId, firstDay.getTime(), lastDay.getTime()],
        async (err, rows) => {
          // ✅ HAPUS PESAN LOADING SETELAH DATA SIAP
          try {
            await ctx.deleteMessage(loadingMsgId);
          } catch (e) {
            logger.error('Gagal hapus pesan loading:', e.message);
          }
          
          if (err) {
            await ctx.reply('❌ Terjadi kesalahan saat mengambil data transaksi.');
            return;
          }

          const totalTopup = await new Promise((resolve) => {
            db.get(
              `SELECT SUM(amount) as total FROM transactions
               WHERE user_id = ? AND timestamp >= ? AND timestamp <= ? AND type = 'deposit'`,
              [userId, firstDay.getTime(), lastDay.getTime()],
              (err2, row2) => resolve(!err2 && row2 && row2.total ? row2.total : 0)
            );
          });
          
          let totalAccounts = 0;
          const details = [];
          
          rows.forEach(row => {
            totalAccounts += row.count;
            const safeType = row.type.toUpperCase().replace(/_/g, '\\_');
            details.push(`• ${safeType}: ${row.count} akun`);
          });
          
          const monthNames = ["Januari", "Februari", "Maret", "April", "Mei", "Juni",
                            "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
          
          const statsMessage = 
            `📊 *STATISTIK RESELLER ANDA*\n\n` +
            `💰 Saldo: Rp ${saldo.toLocaleString('id-ID')}\n` +
            `💳 Top Up Bulan Ini: Rp ${totalTopup.toLocaleString('id-ID')}\n` +
            `📅 Periode: ${monthNames[now.getMonth()]} ${now.getFullYear()}\n\n` +
            `📈 *Aktivitas Bulan Ini:*\n` +
            (details.length > 0 ? details.join('\n') : '• Belum ada transaksi') + `\n\n` +
            `📊 Total: *${totalAccounts} akun*\n\n` +
            `🔄 Update terakhir: ${now.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' })}`;
          
          // ✅ KIRIM PESAN BARU DENGAN DATA
          await ctx.reply(statsMessage, { 
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔄 Refresh', callback_data: 'reseller_stats_refresh' }],
                [{ text: '🔙 Kembali', callback_data: 'send_main_menu' }]
              ]
            }
          });
        }
      );
    });
    
  } catch (error) {
    logger.error('Error di reseller_stats:', error);
    await ctx.reply('❌ Terjadi kesalahan.');
  }
});

// Handler untuk refresh
bot.action('reseller_stats_refresh', async (ctx) => {
  await ctx.answerCbQuery();
  await bot.action['reseller_stats'](ctx); // Panggil ulang handler
});

//handler untuk add server reseller
bot.action('add_server_zivpn_reseller_cmd', async (ctx) => {
  await ctx.reply(
    'Silakan gunakan command berikut untuk menambahkan server ZIVPN reseller:\n\n' +
    '`/addserverzivpn_reseller <domain> <auth> <harga> <nama_server> <quota> <iplimit> <batas_create_akun>`\n\n' +
    'Contoh:\n' +
    '`/addserverzivpn_reseller sg-udp-01.example.com myauth123 500 SG-ZIVPN-RS-01 50 2 100`',
    { parse_mode: 'Markdown' }
  );
});

//handler addserver zivpn
bot.action('add_server_zivpn', async (ctx) => {
  userState[ctx.chat.id] = {
    step: 'add_server_domain',
    service: 'zivpn',
    data: {}
  };
  await ctx.reply('🌐 Masukkan domain server ZIVPN:', { parse_mode: 'Markdown' });
});

// Handler untuk info tools reseller
bot.action('reseller_tools_info', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
        '🛡️ *TOOLS RESELLER*\n\n' +
        'Fitur khusus untuk reseller:\n' +
        '• ❌ Hapus Akun - Hapus akun pelanggan\n' +
        '• 🗝️ Kunci Akun - Nonaktifkan akun sementara\n' +
        '• 🔐 Buka Kunci Akun - Aktifkan kembali akun\n\n' +
        'Fitur ini membantu Anda mengelola akun pelanggan dengan lebih baik.',
        { parse_mode: 'Markdown' }
    );
});

// CEK SERVER - LIST SERVER
bot.action('cek_server', async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});

    db.all('SELECT * FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], async (err, rows) => {
      if (err) {
        logger.error('Gagal mengambil data server:', err.message);
        return ctx.reply('Terjadi kesalahan saat mengambil data server.');
      }

      if (!rows || rows.length === 0) {
        return ctx.reply('Belum ada server yang ditambahkan.');
      }

      const todayYmd = formatDateYmdLocal(new Date());
      const tomorrowDate = new Date();
      tomorrowDate.setDate(tomorrowDate.getDate() + 1);
      const tomorrowYmd = formatDateYmdLocal(tomorrowDate);

      const groupMap = new Map();
      for (const srv of rows) {
        const key = normalizeSyncHost(srv.sync_host || srv.domain) || ('id-' + srv.id);
        if (!groupMap.has(key)) groupMap.set(key, []);
        groupMap.get(key).push(srv);
      }

      const forecastByGroup = new Map();
      for (const [key, groupServers] of groupMap.entries()) {
        const primary = groupServers[0];
        const syncAuth = String(groupServers.find((s) => String(s.auth || '').trim())?.auth || '').trim();
        const syncPort = Number(groupServers.find((s) => Number(s.sync_port) > 0)?.sync_port || primary.sync_port) || 8789;
        const syncEndpoint = normalizeSyncEndpoint(groupServers.find((s) => String(s.sync_endpoint || '').trim())?.sync_endpoint || primary.sync_endpoint);
        const requestServer = { ...primary, auth: syncAuth || primary.auth, sync_port: syncPort, sync_endpoint: syncEndpoint };

        try {
          const expiry = await fetchTunnelExpirySummaryByDate(requestServer, todayYmd);
          forecastByGroup.set(key, { ok: true, releaseTomorrow: Number(expiry.totalExpired || 0) });
        } catch (syncErr) {
          forecastByGroup.set(key, { ok: false, message: syncErr.message });
        }
      }

      let totalSisaSekarang = 0;
      let totalPrediksiBesok = 0;
      let totalKapasitas = 0;
      let totalTerpakai = 0;
      let serverUnlimited = 0;
      let serverPrediksiGagal = 0;

      const lines = [];
      const grouped = Array.from(groupMap.entries()).map(([groupKey, groupServers]) => ({
        groupKey,
        primary: groupServers[0],
        groupServers
      }));

      grouped.forEach((item, idx) => {
        const { groupKey, primary, groupServers } = item;
        const total = Number(primary.total_create_akun || 0);
        const positiveBatas = groupServers
          .map((s) => Number(s.batas_create_akun || 0))
          .filter((v) => Number.isFinite(v) && v > 0);
        const batas = positiveBatas.length > 0 ? Math.max(...positiveBatas) : 0;
        const sisa = batas > 0 ? Math.max(0, batas - total) : 0;
        const status = batas > 0 && sisa <= 0 ? 'Penuh' : 'Tersedia';
        const forecast = forecastByGroup.get(groupKey);

        let prediksiBesok = '-';
        let prediksiBesokNum = null;

        if (batas <= 0) {
          prediksiBesok = 'Unlimited';
          serverUnlimited += 1;
        } else if (forecast?.ok) {
          prediksiBesokNum = Math.max(0, sisa + Number(forecast.releaseTomorrow || 0));
          prediksiBesok = String(prediksiBesokNum);
        } else {
          prediksiBesok = '- (gagal ambil data expiry)';
          serverPrediksiGagal += 1;
        }

        if (batas > 0) {
          totalSisaSekarang += sisa;
          totalKapasitas += batas;
          totalTerpakai += total;
          if (prediksiBesokNum !== null) totalPrediksiBesok += prediksiBesokNum;
        }

        lines.push(
          `${idx + 1}. ${primary.nama_server || '-'}`,
          `- Domain: ${normalizeSyncHost(primary.sync_host || primary.domain) || '-'}`,
          `- Akun Terpakai: ${total}/${batas > 0 ? batas : 'Unlimited'}`,
          `- Sisa Akun Saat Ini: ${batas > 0 ? sisa : 'Unlimited'}`,
          `- Prediksi Tersedia Besok: ${prediksiBesok}`,
          `- Status: ${status}`,
          `- Group Server: ${groupServers.length} baris server`,
          ''
        );
      });

      let message =
        `DAFTAR SERVER TERSEDIA\n\n` +
        `Prediksi slot besok (${tomorrowYmd}) dihitung dari akun yang expired hari ini (${todayYmd}).\n\n` +
        `RINGKASAN TOTAL\n` +
        `- Total akun terpakai saat ini: ${totalTerpakai}/${totalKapasitas}\n` +
        `- Total sisa akun saat ini: ${totalSisaSekarang}\n` +
        `- Total prediksi tersedia besok: ${totalPrediksiBesok}` +
        `${serverUnlimited > 0 ? ` (+ ${serverUnlimited} server unlimited)` : ''}` +
        `\n` +
        `${serverPrediksiGagal > 0 ? `- Catatan: ${serverPrediksiGagal} server gagal ambil data expiry\n` : ''}` +
        `\n` +
        lines.join('\n');
      await ctx.reply(message.trim());
    });
  } catch (error) {
    logger.error('Error di cek_server:', error.message);
    return ctx.reply('Terjadi kesalahan.');
  }
});

// === TUTORIAL PENGGUNAAN BOT ===
bot.action('tutorial_bot', async (ctx) => {
  try {
    await ctx.reply(
      '📘 *Panduan Penggunaan Bot*\n\n' +
      'Tonton video tutorial lengkap cara menggunakan bot ini di YouTube:\n\n' +
      '[👉 Klik di sini untuk menonton](https://youtu.be/gUVoAuZqyxo)',
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    logger.error('❌ Error di tombol tutorial_bot:', err.message);
    await ctx.reply('⚠️ Terjadi kesalahan saat membuka tutorial.');
  }
});

// === 🖼️ UPLOAD GAMBAR QRIS ===
bot.action('upload_qris', async (ctx) => {
  const adminId = ctx.from.id;
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Kamu tidak punya izin untuk ini.');
  }

  await ctx.reply('📸 Kirim gambar QRIS yang ingin digunakan:');
  userState[adminId] = { step: 'upload_qris' };
});

// Saat admin mengirim foto QRIS
bot.on('photo', async (ctx) => {
  const adminId = ctx.from.id;
  const state = userState[adminId];
  if (!state || state.step !== 'upload_qris') return;

  const fileId = ctx.message.photo.pop().file_id;
  const fileLink = await ctx.telegram.getFileLink(fileId);
  const filePath = path.join(__dirname, 'qris.jpg');

  const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
  fs.writeFileSync(filePath, Buffer.from(response.data));

  await ctx.reply('✅ Gambar QRIS berhasil diunggah!');
  logger.info('🖼️ QRIS image uploaded by admin');
  delete userState[adminId];
});
///////////////////////
bot.action('topup_manual', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const qrisPath = path.join(__dirname, 'qris.jpg');

    const captionText =
      `📲 *Top Up Saldo Manual via QRIS*\n\n` +
      `💬 Silakan transfer menggunakan QRIS di atas.\n\n` +
      `Setelah transfer, kirim bukti pembayaran ke admin:\n` +
      `hubungi via WhatsApp: [Klik di sini](${getAdminWhatsappUrl() || '#'})\n` +
      `atau Telegram: \`${getAdminTelegramUsername()}\`\n\n` +
      `📝 *Kirim bukti pembayaran dan sertakan format pesan seperti ini:*\n` +
      `\`\`\`\nSaya sudah top up via QRIS min dan ini ID Telegram saya ${ctx.from.id}\n\`\`\`\n\n` +
      `_Pastikan nominal sesuai dengan saldo yang ingin ditambahkan._`;

    if (fs.existsSync(qrisPath)) {
      await ctx.replyWithPhoto(
        { source: qrisPath },
        {
          caption: captionText,
          parse_mode: 'Markdown',
        }
      );
    } else {
      await ctx.reply(`⚠️ QRIS belum diunggah oleh admin. Silakan hubungi ${getAdminTelegramUsername()}.`);
    }
  } catch (err) {
    logger.error('❌ Error di topup_manual:', err.message);
    ctx.reply('❌ Terjadi kesalahan saat menampilkan QRIS.');
  }
});

/////

// === 🗂️ BACKUP DATABASE DAN KIRIM KE ADMIN ===
bot.action('backup_db', async (ctx) => {
  try {
    const adminId = ctx.from.id;

    // Hanya admin yang bisa pakai
    if (!adminIds.includes(adminId)) {
      return ctx.reply('🚫 Kamu tidak memiliki izin untuk melakukan tindakan ini.');
    }

    const dbPath = path.join(__dirname, 'sellvpn.db');
    if (!fs.existsSync(dbPath)) {
      return ctx.reply('⚠️ File database tidak ditemukan.');
    }

    // Kirim file sellvpn.db ke admin
    await ctx.replyWithDocument({ source: dbPath, filename: 'sellvpn.db' }, { 
      caption: '📦 Backup database berhasil dikirim!',
    });

    logger.info(`📤 Backup database dikirim ke admin ${adminId}`);
  } catch (error) {
    logger.error('❌ Gagal mengirim file backup ke admin:', error);
    ctx.reply('❌ Terjadi kesalahan saat mengirim file backup.');
  }
});

// === 💳 CEK SALDO USER ===
bot.action('cek_saldo_user', async (ctx) => {
  const adminId = ctx.from.id;

  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk menggunakan fitur ini.');
  }

  await ctx.answerCbQuery();
  await ctx.reply('🔍 Masukkan ID Telegram user yang ingin dicek saldonya:');
  userState[adminId] = { step: 'cek_saldo_userid' };
});
///////////////

bot.action('jadi_reseller', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  const userId = ctx.from.id;
  const terms = loadResellerTerms();
  const waUrl = getAdminWhatsappUrl();
  const telegramAdmin = getAdminTelegramUsername();
  const username = ctx.from.username ? '@' + ctx.from.username : '-';
  const fullName = (ctx.from.first_name || '') + (ctx.from.last_name ? ' ' + ctx.from.last_name : '');

  const autoMessage = encodeURIComponent(
    'Halo Admin, saya ingin daftar reseller VPN.\n\n' +
    'ID Telegram: ' + userId + '\n' +
    'Username: ' + username + '\n' +
    'Nama: ' + (fullName || '-') + '\n' +
    'Siap top up awal: Rp 18.000\n\n' +
    'Mohon info langkah lanjutnya.'
  );

  const waAutoUrl = waUrl ? (waUrl + '?text=' + autoMessage) : null;

  const message =
    '*PROGRAM RESELLER VPN*\n\n' +
    'Naik level jadi reseller dan dapat harga akun lebih hemat untuk jual ulang.\n\n' +
    '*Benefit Reseller:*\n' +
    '- Harga akun lebih murah\n' +
    '- Bisa buat akun kapan saja\n' +
    '- Dukungan langsung dari admin\n' +
    '- Akses promo dan bonus reseller\n\n' +
    '*Syarat Bergabung:*\n' +
    '> Top up awal: *Rp 18.000* (langsung masuk saldo)\n' +
    '> Minimal top up bulanan: *' + formatRupiah(terms.min_topup) + '*\n\n' +
    '*Data Anda:*\n' +
    '- ID: ' + userId + '\n' +
    '- Username: ' + username + '\n\n' +
    (waUrl
      ? 'Klik tombol di bawah untuk kirim format pendaftaran otomatis ke admin via WhatsApp.'
      : 'Nomor WhatsApp admin belum diset. Silakan hubungi admin via Telegram: ' + telegramAdmin + '.');

  const inlineKeyboard = [];
  if (waAutoUrl) {
    inlineKeyboard.push([{ text: 'Daftar Reseller (Otomatis)', url: waAutoUrl }]);
    inlineKeyboard.push([{ text: 'Chat WhatsApp Admin', url: waUrl }]);
  }
  inlineKeyboard.push([{ text: 'Kontak Telegram Admin', url: 'https://t.me/' + telegramAdmin.replace(/^@/, '') }]);

  await ctx.reply(message, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: inlineKeyboard }
  });
});

///////
bot.action('tambah_saldo', async (ctx) => {
  const adminId = ctx.from.id;

  // Pastikan hanya admin
  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Kamu tidak memiliki izin untuk menggunakan menu ini.');
  }

  userState[adminId] = { step: 'addsaldo_userid' };
  await ctx.reply('🆔 Masukkan ID Telegram user yang ingin ditambah saldonya:');
});

////////

bot.action('sendMainMenu', async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    await sendMainMenu(ctx);
  } catch (error) {
    console.error('❌ Error saat kembali ke menu utama:', error);
    await ctx.reply('⚠️ Terjadi kesalahan saat membuka menu utama.');
  }
});

bot.action('addserver_reseller', async (ctx) => {
  await ctx.answerCbQuery().catch(()=>{});
  userState[ctx.chat.id] = { step: 'addserver_reseller' };
  await ctx.reply(
    '🪄 Silakan kirim data server reseller dengan format:\n\n' +
    '/addserver_reseller <domain> <auth> <harga> <nama_server> <quota> <iplimit> <batas_create_akun>'
  );
});

bot.action('service_trial', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await handleServiceAction(ctx, 'trial');
});

bot.action('service_create', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await handleServiceAction(ctx, 'create');
});

bot.action('service_renew', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await handleServiceAction(ctx, 'renew');
});

bot.action('service_del', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await handleServiceAction(ctx, 'del');
});

bot.action('service_lock', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await handleServiceAction(ctx, 'lock');
});

bot.action('service_unlock', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  } 
  await handleServiceAction(ctx, 'unlock');
});

const { exec } = require('child_process');

bot.action('cek_service', async (ctx) => {
  try {
    const resselDbPath = './ressel.db';
    const idUser = ctx.from.id.toString().trim();

    // 🔍 Cek apakah user termasuk reseller
    fs.readFile(resselDbPath, 'utf8', async (err, data) => {
      if (err) {
        console.error('❌ Gagal membaca file ressel.db:', err.message);
        return ctx.reply('❌ *Terjadi kesalahan saat membaca data reseller.*', { parse_mode: 'Markdown' });
      }

      const resselList = data.split('\n').map(line => line.trim()).filter(Boolean);
      const isRessel = resselList.includes(idUser);

      if (!isRessel) {
        return ctx.reply('❌ *Fitur ini hanya untuk Ressel VPN.*', { parse_mode: 'Markdown' });
      }

      // ✅ Jika reseller, lanjut jalankan cek service
      const message = await ctx.reply('⏳ Sedang mengecek status server...');

      exec('chmod +x cek-port.sh && bash cek-port.sh', (error, stdout, stderr) => {
        if (error) {
          console.error(`Gagal menjalankan skrip: ${error.message}`);
          return ctx.reply('❌ Terjadi kesalahan saat menjalankan pengecekan.');
        }

        if (stderr) {
          console.error(`Error dari skrip: ${stderr}`);
          return ctx.reply('❌ Ada output error dari skrip pengecekan.');
        }

        // Bersihkan kode warna ANSI agar output rapi
        const cleanOutput = stdout.replace(/\x1b\[[0-9;]*m/g, '');

        ctx.reply(`📡 *Hasil Cek Port:*\n\n\`\`\`\n${cleanOutput}\n\`\`\``, {
          parse_mode: 'Markdown'
        });
      });
    });
  } catch (err) {
    console.error(err);
    ctx.reply('❌ Gagal menjalankan pengecekan server.');
  }
});

bot.action('send_main_menu', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await sendMainMenu(ctx);
});

bot.action('trial_vmess', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'trial', 'vmess');
});

bot.action('trial_vless', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'trial', 'vless');
});

bot.action('trial_trojan', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'trial', 'trojan');
});

bot.action('trial_shadowsocks', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'trial', 'shadowsocks');
});

bot.action('trial_ssh', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'trial', 'ssh');
});

bot.action('trial_udp_http', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'trial', 'udp_http');
});


bot.action('create_vmess', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'create', 'vmess');
});

bot.action('create_vless', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'create', 'vless');
});

bot.action('create_trojan', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'create', 'trojan');
});

bot.action('create_shadowsocks', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'create', 'shadowsocks');
});

bot.action('create_ssh', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'create', 'ssh');
});

bot.action('create_udp_http', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'create', 'udp_http');
});

////
bot.action('create_zivpn', async (ctx) => {
  await startSelectServer(ctx, 'create', 'zivpn');
});
///
bot.action('trial_zivpn', async (ctx) => {
  await startSelectServer(ctx, 'trial', 'zivpn');
});
////
//DELETE SSH
bot.action('del_ssh', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'del', 'ssh');
});

bot.action('del_udp_http', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'del', 'udp_http');
});

bot.action('del_zivpn', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'del', 'zivpn');
});

bot.action('del_vmess', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'del', 'vmess');
});

bot.action('del_vless', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'del', 'vless');
});

bot.action('del_trojan', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'del', 'trojan');
});
//DELETE BREAK

//LOCK
bot.action('lock_ssh', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'lock', 'ssh');
});

bot.action('lock_udp_http', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'lock', 'udp_http');
});

bot.action('lock_vmess', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'lock', 'vmess');
});

bot.action('lock_vless', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'lock', 'vless');
});

bot.action('lock_trojan', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'lock', 'trojan');
});
//LOCK BREAK
//UNLOCK
bot.action('unlock_ssh', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'unlock', 'ssh');
});

bot.action('unlock_udp_http', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'unlock', 'udp_http');
});

bot.action('unlock_vmess', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'unlock', 'vmess');
});

bot.action('unlock_vless', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'unlock', 'vless');
});

bot.action('unlock_trojan', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'unlock', 'trojan');
});
//UNLOCK BREAK

bot.action('renew_vmess', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'renew', 'vmess');
});

bot.action('renew_vless', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'renew', 'vless');
});

bot.action('renew_trojan', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'renew', 'trojan');
});

bot.action('renew_shadowsocks', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'renew', 'shadowsocks');
});

bot.action('renew_ssh', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'renew', 'ssh');
});

bot.action('renew_udp_http', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'renew', 'udp_http');
});

bot.action('renew_zivpn', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'renew', 'zivpn');
});
async function startSelectServer(ctx, action, type, page = 0) {

try {
  const isR = await isUserReseller(ctx.from.id);
  const filters = [];
  const params = [];

  if (type === 'zivpn') {
    filters.push('support_zivpn = 1');
  }
  if (type === 'udp_http') {
    filters.push('support_udp_http = 1');
  }
  if (!isR) {
    // user biasa hanya bisa lihat server publik/non-reseller
    filters.push('(is_reseller_only = 0 OR is_reseller_only IS NULL)');
  }

 
  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const query = `SELECT * FROM Server ${whereClause} ORDER BY nama_server COLLATE NOCASE ASC`;

db.all(query, params, (err, servers) => {
  if (err) {
    logger.error('⚠️ Error fetching servers:', err.message);
    return ctx.reply('⚠️ Tidak ada server yang tersedia saat ini.', { parse_mode: 'HTML' });
  }
    // ==== mulai logika pagination di bawah ini ====
    const serversPerPage = 6;
    const totalPages = Math.ceil(servers.length / serversPerPage);
    const currentPage = Math.min(Math.max(page, 0), totalPages - 1);
    const start = currentPage * serversPerPage;
    const end = start + serversPerPage;
    const currentServers = servers.slice(start, end);

    const keyboard = [];
    for (let i = 0; i < currentServers.length; i += 2) {
      const row = [];
      const server1 = currentServers[i];
      const server2 = currentServers[i + 1];
      row.push({ text: server1.nama_server, callback_data: `${action}_username_${type}_${server1.id}` });
      if (server2) {
        row.push({ text: server2.nama_server, callback_data: `${action}_username_${type}_${server2.id}` });
      }
      keyboard.push(row);
    }

    const navButtons = [];
    if (totalPages > 1) {
      if (currentPage > 0) {
        navButtons.push({ text: '⬅️ Back', callback_data: `navigate_${action}_${type}_${currentPage - 1}` });
      }
      if (currentPage < totalPages - 1) {
        navButtons.push({ text: 'Lihat server selanjutnya ➡️ Next', callback_data: `navigate_${action}_${type}_${currentPage + 1}` });
      }
    }
    if (navButtons.length > 0) keyboard.push(navButtons);
    keyboard.push([{ text: '🔙 Kembali ke Menu Utama', callback_data: 'sendMainMenu' }]);

const serverList = currentServers.map(server => {
  const hargaPerHari = getEffectiveServerPrice(server, isR);
  const hargaPer30Hari = hargaPerHari * 30;
  const isFull = server.total_create_akun >= server.batas_create_akun;

  return (
`╔══════════════════════╗
  🟦 *${server.nama_server.toUpperCase()}*
╚══════════════════════╝
🛜 *Domain:* \`${server.domain}\`
💳 *Harga/Hari:* Rp${hargaPerHari.toLocaleString()}
📆 *Harga/Bulan:* Rp${hargaPer30Hari.toLocaleString()}
📡 *Quota:* ${server.quota} GB
🔐 *IP Limit:* ${server.iplimit} IP
👥 *Akun Terpakai:* ${server.total_create_akun}/${server.batas_create_akun}
📌 *Status:* ${isFull ? "❌ Server Penuh" : "✅ Tersedia"}
`
  );
}).join('\n\n');
    if (ctx.updateType === 'callback_query') {
      ctx.editMessageText(`📋 *List Server (Halaman ${currentPage + 1} dari ${totalPages})*\n\n${serverList}`, {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
      });
    } else {
      ctx.reply(`📋 *List Server (Halaman ${currentPage + 1} dari ${totalPages})*\n\n${serverList}`, {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
      });
    }

    userState[ctx.chat.id] = { step: `${action}_username_${type}`, page: currentPage };
  });
} catch (error) {
  logger.error(`❌ Error saat memulai proses ${action} untuk ${type}:`, error);
  await ctx.reply(`❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan.`, { parse_mode: 'Markdown' });
}
}

bot.action(/navigate_([^_]+)_(.+)_(\d+)/, async (ctx) => {
  const [, action, type, page] = ctx.match;
  await startSelectServer(ctx, action, type, parseInt(page, 10));
});


bot.action(/(create|renew)_username_(vmess|vless|trojan|shadowsocks|ssh|zivpn|udp_http)_(.+)/, async (ctx) => {
  const action = ctx.match[1];
  const type = ctx.match[2];
  const serverId = ctx.match[3];
  userState[ctx.chat.id] = { step: `username_${action}_${type}`, serverId, type, action };

  db.get('SELECT batas_create_akun, total_create_akun FROM Server WHERE id = ?', [serverId], async (err, server) => {
    if (err) {
      logger.error('⚠️ Error fetching server details:', err.message);
      return ctx.reply('❌ *Terjadi kesalahan saat mengambil detail server.*', { parse_mode: 'Markdown' });
    }

    if (!server) {
      return ctx.reply('❌ *Server tidak ditemukan.*', { parse_mode: 'Markdown' });
    }

    const batasCreateAkun = server.batas_create_akun;
    const totalCreateAkun = server.total_create_akun;

    if (totalCreateAkun >= batasCreateAkun) {
      return ctx.reply('❌ *Server penuh. Tidak dapat membuat akun baru di server ini.*', { parse_mode: 'Markdown' });
    }

    await ctx.reply('👤 *Masukkan username:*', { parse_mode: 'Markdown' });
  });
});

// === ⚡️ KONFIRMASI TRIAL (semua tipe) ===
bot.action(/(trial)_username_(vmess|vless|trojan|shadowsocks|ssh|zivpn|udp_http)_(\d+)/, async (ctx) => {
  const [action, type, serverId] = [ctx.match[1], ctx.match[2], ctx.match[3]];

  // Ambil nama server dari database
  db.get('SELECT * FROM Server WHERE id = ?', [serverId], async (err, server) => {
    if (err) {
      logger.error('❌ Gagal mengambil data server:', err.message);
      return ctx.reply('⚠️ Terjadi kesalahan saat mengambil data server.');
    }

    if (!server) {
      return ctx.reply('⚠️ Server tidak ditemukan di database.');
    }

    // Simpan state seperti semula
    userState[ctx.chat.id] = {
      step: `username_${action}_${type}`,
      serverId, type, action,
      serverName: server.nama_server || server.domain
    };

    // Pesan konfirmasi seperti versi lama, tapi pakai nama server
    await ctx.reply(
      `⚠️ *PERHATIAN*\n\n` +
      `Anda sedang membuat akun *TRIAL ${type.toUpperCase()}* di server *${server.nama_server || server.domain}*.\n\n` +
      `Layanan trial hanya berlaku *1x per hari* dan akan aktif selama *1 Jam*.\n\n` +
      `Kecuali User *RESSELLER VPN*.\n\n` +
      `Lanjutkan hanya jika Anda sudah yakin.`,
      { parse_mode: 'Markdown' }
    );

    await ctx.reply(' *Konfirmasi (yes) hurufnya kecil semua:*', { parse_mode: 'Markdown' });
  });
});

bot.action(/(del)_username_(vmess|vless|trojan|ssh|udp_http|zivpn)_(.+)/, async (ctx) => {
  const [action, type, serverId] = [ctx.match[1], ctx.match[2], ctx.match[3]];

  userState[ctx.chat.id] = {
    step: `username_${action}_${type}`,
    serverId, type, action
  };
  await ctx.reply('👤 *Masukkan username yang ingin dihapus:*', { parse_mode: 'Markdown' });
});
bot.action(/(unlock)_username_(vmess|vless|trojan|shadowsocks|ssh|udp_http)_(.+)/, async (ctx) => {
  const [action, type, serverId] = [ctx.match[1], ctx.match[2], ctx.match[3]];

  userState[ctx.chat.id] = {
    step: `username_${action}_${type}`,
    serverId, type, action
  };
  await ctx.reply('👤 *Masukkan username yang ingin dibuka:*', { parse_mode: 'Markdown' });
});
bot.action(/(lock)_username_(vmess|vless|trojan|shadowsocks|ssh|udp_http)_(.+)/, async (ctx) => {
  const [action, type, serverId] = [ctx.match[1], ctx.match[2], ctx.match[3]];

  userState[ctx.chat.id] = {
    step: `username_${action}_${type}`,
    serverId, type, action
  };
  await ctx.reply('👤 *Masukkan username yang ingin dikunci:*', { parse_mode: 'Markdown' });
});

bot.on('text', async (ctx) => {
  const state = userState[ctx.chat.id];
if (!state || !state.step) return;

  if (state.step === 'edit_domain_pick_server') {
    const text = (ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Edit domain dibatalkan.');
    }

    const serverId = Number(text);
    if (!Number.isFinite(serverId) || serverId <= 0) {
      return ctx.reply('ID server tidak valid. Masukkan angka ID server yang benar.');
    }

    return db.get('SELECT id, nama_server, domain FROM Server WHERE id = ?', [serverId], async (err, row) => {
      if (err) {
        logger.error('Error ambil server untuk edit domain:', err.message);
        return ctx.reply('Terjadi kesalahan saat membaca data server.');
      }
      if (!row) {
        return ctx.reply('Server dengan ID tersebut tidak ditemukan. Coba lagi.');
      }

      userState[ctx.chat.id] = {
        step: 'edit_domain_input_value',
        serverId: row.id
      };

      return ctx.reply(
        'Server terpilih: ' + (row.nama_server || '-') + '\n' +
        'Domain saat ini: ' + (row.domain || '-') + '\n\n' +
        'Ketik domain baru untuk server ini.\n' +
        'Ketik batal untuk membatalkan.'
      );
    });
  }

  if (state.step === 'edit_domain_input_value') {
    const text = (ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Edit domain dibatalkan.');
    }

    if (!/^[a-zA-Z0-9.-]+$/.test(text)) {
      return ctx.reply('Domain tidak valid. Gunakan hanya huruf, angka, titik, dan tanda minus.');
    }

    return db.run('UPDATE Server SET domain = ? WHERE id = ?', [text, state.serverId], function(err) {
      if (err) {
        logger.error('Error update domain server:', err.message);
        return ctx.reply('Terjadi kesalahan saat mengubah domain server.');
      }

      if (this.changes === 0) {
        return ctx.reply('Server tidak ditemukan atau domain tidak berubah.');
      }

      delete userState[ctx.chat.id];
      return ctx.reply('Domain server berhasil diubah menjadi: ' + text);
    });
  }

  if (state.step === 'admin_broadcast_poll_only_input') {
    const text = (ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      await ctx.reply('Broadcast polling dibatalkan.');
      return ctx.reply('Selesai.', { reply_markup: { inline_keyboard: [[{ text: 'Kembali ke menu tools', callback_data: 'admin_menu_tools' }]] } });
    }

    const parts = text.split('|').map((x) => x.trim()).filter(Boolean);
    if (parts.length < 3) {
      return ctx.reply('Format salah. Gunakan: Pertanyaan | Opsi A | Opsi B');
    }

    const question = parts[0];
    const options = parts.slice(1, 11);

    if (question.length < 5) {
      return ctx.reply('Pertanyaan polling terlalu pendek. Minimal 5 karakter.');
    }

    if (options.length < 2) {
      return ctx.reply('Polling minimal punya 2 opsi.');
    }

    const pollResult = await broadcastPollToAllUsers(question, options, Number(ctx.from.id || 0));

    delete userState[ctx.chat.id];

    await ctx.reply(
      'Broadcast polling selesai.\n\n' +
      '- Berhasil: ' + pollResult.ok + '\n' +
      '- Gagal: ' + pollResult.fail + '\n' +
      '- ID Polling: ' + pollResult.pollId + '\n\n' +
      'Hasil polling bersifat global (gabungan semua user).'
    );

    return ctx.reply('Selesai.', { reply_markup: { inline_keyboard: [[{ text: 'Kembali ke menu tools', callback_data: 'admin_menu_tools' }]] } });
  }

  if (state.step === 'admin_broadcast_message') {
    const text = (ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      await ctx.reply('Broadcast dibatalkan.');
      return ctx.reply('Selesai.', { reply_markup: { inline_keyboard: [[{ text: 'Kembali ke menu tools', callback_data: 'admin_menu_tools' }]] } });
    }

    if (text.length < 3) {
      return ctx.reply('Pesan terlalu pendek. Minimal 3 karakter.');
    }

    const result = await broadcastMessageToAllUsers(text);
    delete userState[ctx.chat.id];

    await ctx.reply(
      'Broadcast selesai.\n' +
      '- Berhasil: ' + result.ok + '\n' +
      '- Gagal: ' + result.fail
    );

    return ctx.reply('Selesai.', { reply_markup: { inline_keyboard: [[{ text: 'Kembali ke menu tools', callback_data: 'admin_menu_tools' }]] } });
  }

  if (state.step === 'admin_broadcast_poll_input') {
    const text = (ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      await ctx.reply('Broadcast dibatalkan.');
      return ctx.reply('Selesai.', { reply_markup: { inline_keyboard: [[{ text: 'Kembali ke menu tools', callback_data: 'admin_menu_tools' }]] } });
    }

    const parts = text.split('|').map((s) => s.trim()).filter(Boolean);
    if (parts.length < 3) {
      return ctx.reply('Format salah. Gunakan: Pertanyaan | Opsi A | Opsi B');
    }

    const question = parts[0];
    const options = parts.slice(1, 11);

    if (question.length < 5) {
      return ctx.reply('Pertanyaan polling terlalu pendek. Minimal 5 karakter.');
    }

    if (options.length < 2) {
      return ctx.reply('Polling minimal punya 2 opsi.');
    }

    const message = String(state.message || '').trim();
    const msgResult = await broadcastMessageToAllUsers(message);
    const pollResult = await broadcastPollToAllUsers(question, options, Number(ctx.from.id || 0));

    delete userState[ctx.chat.id];

    await ctx.reply(
      'Broadcast + polling selesai.\n\n' +
      'Pesan:\n' +
      '- Berhasil: ' + msgResult.ok + '\n' +
      '- Gagal: ' + msgResult.fail + '\n\n' +
      'Polling:\n' +
      '- Berhasil: ' + pollResult.ok + '\n' +
      '- Gagal: ' + pollResult.fail + '\n' +
      '- ID Polling: ' + pollResult.pollId + '\n\n' +
      'Hasil polling bersifat global (gabungan semua user).'
    );

    return ctx.reply('Selesai.', { reply_markup: { inline_keyboard: [[{ text: 'Kembali ke menu tools', callback_data: 'admin_menu_tools' }]] } });
  }

  if (state.step === 'restore_db_upload') {
    const text = (ctx.message.text || '').trim().toLowerCase();
    if (text === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Restore database dibatalkan.');
    }
    return ctx.reply('Silakan kirim file backup sebagai document, atau ketik "batal".');
  }

  if (
    state.step === 'bonus_set_10_40' ||
    state.step === 'bonus_set_50_70' ||
    state.step === 'bonus_set_70_100'
  ) {
    const text = (ctx.message.text || '').trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan bonus dibatalkan.');
    }

    const percent = Number(text.replace(',', '.'));
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      return ctx.reply('Persen tidak valid. Masukkan angka 0 sampai 100.');
    }

    const current = loadTopupBonusSetting();
    if (state.step === 'bonus_set_10_40') {
      current.range_10_40 = percent;
    } else if (state.step === 'bonus_set_50_70') {
      current.range_50_70 = percent;
    } else {
      current.range_70_100 = percent;
    }
    const saved = saveTopupBonusSetting(current);

    delete userState[ctx.chat.id];
    return ctx.reply(
      'Bonus topup berhasil diperbarui.\n\n' +
      '10-40rb: ' + saved.range_10_40 + '%\n' +
      '50-70rb: ' + saved.range_50_70 + '%\n' +
      '70-100rb+: ' + saved.range_70_100 + '%'
    );
  }

  if (state.step === 'check_expiry_username') {
    const input = ctx.message.text.trim();
    if (input.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Cek masa aktif dibatalkan.');
    }

    const username = input;
    const serverId = Number(state.serverId);

    db.get(
      'SELECT id, domain, auth, sync_host, sync_port, sync_endpoint, nama_server FROM Server WHERE id = ?',
      [serverId],
      async (err, serverRow) => {
        if (err) {
          logger.error('Error cek masa aktif ambil server:', err.message);
          return ctx.reply('Terjadi kesalahan saat mengambil server.');
        }
        if (!serverRow) {
          return ctx.reply('Server tidak ditemukan.');
        }

        const info = await fetchTunnelAccountExpiryByUsername(serverRow, username);
        if (!info.found) {
          return ctx.reply('Akun tidak ditemukan di server ini atau API tidak merespons.');
        }

        const remainingDays = calcRemainingDaysFromDateExp(info.dateExp);
        delete userState[ctx.chat.id];

        await ctx.reply(
          'HASIL CEK MASA AKTIF\n\n' +
          'Server: ' + (state.serverName || serverRow.nama_server || serverRow.domain || '-') + '\n' +
          'Username: ' + username + '\n' +
          'Layanan: ' + String(info.service || '-').toUpperCase() + '\n' +
          'Expired: ' + (info.dateExp || '-') + '\n' +
          'Sisa Masa Aktif: ' + remainingDays + ' hari',
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: 'Cek Lagi', callback_data: 'check_expiry_account' }],
                [{ text: 'Menu Utama', callback_data: 'send_main_menu' }]
              ]
            }
          }
        );
      }
    );
    return;
  }

  if (state.step === 'notif_bot_token') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan token dibatalkan.');
    }
    NOTIF_BOT_TOKEN = text;
    const nextVars = loadVars();
    nextVars.NOTIF_BOT_TOKEN = NOTIF_BOT_TOKEN;
    saveVars(nextVars);
    delete userState[ctx.chat.id];
    await ctx.reply('✅ Token notifikasi tersimpan.');
    return sendAdminMenu(ctx);
  }

  if (state.step === 'notif_chat_id') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan chat id dibatalkan.');
    }
    NOTIF_CHAT_ID = text;
    const nextVars = loadVars();
    nextVars.NOTIF_CHAT_ID = NOTIF_CHAT_ID;
    saveVars(nextVars);
    delete userState[ctx.chat.id];
    await ctx.reply('✅ Chat ID notifikasi tersimpan.');
    return sendAdminMenu(ctx);
  }

  if (state.step === 'admin_contact_whatsapp') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan nomor WhatsApp dibatalkan.');
    }

    const normalized = text.replace(/\D/g, '');
    if (!/^\d{10,16}$/.test(normalized)) {
      return ctx.reply('Nomor tidak valid. Gunakan 10-16 digit angka, contoh: 6281234567890');
    }

    ADMIN_WHATSAPP = normalized;
    const nextVars = loadVars();
    nextVars.ADMIN_WHATSAPP = ADMIN_WHATSAPP;
    saveVars(nextVars);

    delete userState[ctx.chat.id];
    await ctx.reply('✅ Nomor WhatsApp admin tersimpan: ' + ADMIN_WHATSAPP);
    return sendAdminToolsMenu(ctx);
  }

  if (state.step === 'admin_contact_telegram') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan username Telegram dibatalkan.');
    }

    const normalized = text.replace(/^@+/, '').trim();
    if (!/^[a-zA-Z0-9_]{5,32}$/.test(normalized)) {
      return ctx.reply('Username Telegram tidak valid. Gunakan 5-32 karakter (huruf, angka, underscore).');
    }

    ADMIN_TELEGRAM = normalized;
    const nextVars = loadVars();
    nextVars.ADMIN_TELEGRAM = ADMIN_TELEGRAM;
    saveVars(nextVars);

    delete userState[ctx.chat.id];
    await ctx.reply('✅ Username Telegram admin tersimpan: @' + ADMIN_TELEGRAM);
    return sendAdminToolsMenu(ctx);
  }
  if (state.step === 'reseller_terms_input') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Pengaturan syarat reseller dibatalkan.');
    }

    const parts = text.split(/\s+/);
    if (parts.length !== 1 || !/^\d+$/.test(parts[0])) {
      return ctx.reply('Format salah. Contoh: 30000');
    }

    const minTopup = parseInt(parts[0], 10);
    if (minTopup < 0) {
      return ctx.reply('Nilai tidak boleh negatif.');
    }

    const saved = saveResellerTerms({ min_accounts: 0, min_topup: minTopup });
    delete userState[ctx.chat.id];
    await ctx.reply(
      'Syarat reseller berhasil diperbarui:\n' +
      `Minimal top up per bulan: ${formatRupiah(saved.min_topup)}`
    );
    try {
      const resellers = listResellersSync();
      const notice =
        `📢 *INFO SYARAT RESELLER DIUBAH*\n\n` +
        `Minimal top up per bulan sekarang: ${formatRupiah(saved.min_topup)}\n\n` +
        `Cek total top up bulan ini via menu *📊 Statistik Saya* atau command /resellerstats.\n` +
        `Harap penuhi syarat agar status reseller tetap aktif.`;
      for (const resellerId of resellers) {
        await bot.telegram.sendMessage(resellerId, notice, { parse_mode: 'Markdown' });
      }
    } catch (e) {
      logger.error('Gagal kirim notifikasi perubahan syarat reseller:', e.message);
    }
    return sendAdminMenu(ctx);
  }

  if (state.step === 'edit_auth_by_text') {
    const input = ctx.message.text.trim();
    if (input.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Edit auth dibatalkan.');
    }

    const parts = input.split(/\s+/);
    if (parts.length < 2 || !/^\d+$/.test(parts[0])) {
      return ctx.reply('Format salah. Gunakan: <id_server> <auth_baru>. Contoh: 12 myNewAuth123');
    }

    const serverId = parseInt(parts[0], 10);
    const authBaru = parts.slice(1).join(' ').trim();
    if (!authBaru) {
      return ctx.reply('Auth baru tidak boleh kosong.');
    }

    db.run('UPDATE Server SET auth = ? WHERE id = ?', [authBaru, serverId], function (err) {
      if (err) {
        logger.error('? Gagal update auth via text:', err.message);
        return ctx.reply('? Gagal mengupdate auth server.');
      }
      if (this.changes === 0) {
        return ctx.reply('Server tidak ditemukan. Cek lagi ID server.');
      }

      delete userState[ctx.chat.id];
      ctx.reply('? Auth server ID ' + serverId + ' berhasil diubah menjadi: ' + authBaru);
    });
    return;
  }

  if (state.step === 'edit_total_batas_input') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'batal') {
      delete userState[ctx.chat.id];
      return ctx.reply('Edit total+batas dibatalkan.');
    }

    const parts = text.split(/\s+/);
    if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) {
      return ctx.reply('Format salah. Contoh: 10 50');
    }

    const total = parseInt(parts[0], 10);
    const batas = parseInt(parts[1], 10);
    if (total < 0 || batas < 0) {
      return ctx.reply('Nilai tidak boleh negatif.');
    }
    if (total > batas) {
      return ctx.reply('Total tidak boleh lebih besar dari batas.');
    }

    const serverId = state.serverId;
    db.run(
      'UPDATE Server SET total_create_akun = ?, batas_create_akun = ? WHERE id = ?',
      [total, batas, serverId],
      function (err) {
        if (err) {
          logger.error('❌ Gagal update total+batas:', err.message);
          return ctx.reply('❌ Gagal mengupdate total+batas.');
        }
        delete userState[ctx.chat.id];
        ctx.reply(`✅ Total & batas berhasil diupdate.\nTotal: ${total}\nBatas: ${batas}`);
      }
    );
    return;
  }

  if (state.step === 'add_reseller_userid') {
    const targetId = ctx.message.text.trim();
    if (!/^\d+$/.test(targetId)) {
      return ctx.reply('ID harus angka. Masukkan ulang:');
    }

    let resellerList = [];
    if (fs.existsSync(resselFilePath)) {
      const fileContent = fs.readFileSync(resselFilePath, 'utf8');
      resellerList = fileContent.split('\n').filter(line => line.trim() !== '');
    }

    if (resellerList.includes(targetId)) {
      delete userState[ctx.chat.id];
      await ctx.reply(`User dengan ID ${targetId} sudah menjadi reseller.`);
      return sendAdminResellerMenu(ctx);
    }

    fs.appendFileSync(resselFilePath, `${targetId}\n`);
    delete userState[ctx.chat.id];
    await ctx.reply(`✅ User dengan ID ${targetId} berhasil dijadikan reseller.`);
    return sendAdminResellerMenu(ctx);
  }

  if (state.step === 'del_reseller_userid') {
    const targetId = ctx.message.text.trim();
    if (!/^\d+$/.test(targetId)) {
      return ctx.reply('ID harus angka. Masukkan ulang:');
    }

    if (!fs.existsSync(resselFilePath)) {
      delete userState[ctx.chat.id];
      await ctx.reply('📁 File reseller belum dibuat.');
      return sendAdminResellerMenu(ctx);
    }

    const fileContent = fs.readFileSync(resselFilePath, 'utf8');
    const resellerList = fileContent.split('\n').filter(line => line.trim() !== '' && line.trim() !== targetId);
    fs.writeFileSync(resselFilePath, resellerList.join('\n') + (resellerList.length ? '\n' : ''));

    delete userState[ctx.chat.id];
    await ctx.reply(`✅ User dengan ID ${targetId} berhasil dihapus dari daftar reseller.`);
    return sendAdminResellerMenu(ctx);
  }

  if (state.step === 'reseller_restore_input') {
    const targetId = ctx.message.text.trim();
    if (!/^\d+$/.test(targetId)) {
      return ctx.reply('❌ ID Telegram harus angka. Coba lagi.');
    }

    addReseller(targetId);
    delete userState[ctx.chat.id];
    await ctx.reply(`✅ Reseller ${targetId} berhasil diaktifkan kembali.`);

    try {
      await bot.telegram.sendMessage(
        targetId,
        '✅ Status reseller Anda telah diaktifkan kembali oleh admin.'
      );
    } catch (e) {
      logger.warn(`Gagal kirim notif restore reseller ke ${targetId}:`, e.message);
    }

    return;
  }

  if (state.step === 'add_server_domain') {
  state.data.domain = ctx.message.text.trim();
  state.step = 'add_server_auth';
  return ctx.reply('🔑 Masukkan auth server:', { parse_mode: 'Markdown' });
}

if (state.step === 'add_server_auth') {
  state.data.auth = ctx.message.text.trim();
  state.step = 'add_server_harga';
  return ctx.reply('💰 Masukkan harga server (angka):', { parse_mode: 'Markdown' });
}

if (state.step === 'add_server_harga') {
  if (!/^\d+$/.test(ctx.message.text)) {
    return ctx.reply('⚠️ Harga harus angka. Masukkan ulang:');
  }
  state.data.harga = parseInt(ctx.message.text);
  state.step = 'add_server_nama';
  return ctx.reply('📝 Masukkan nama server:', { parse_mode: 'Markdown' });
}

if (state.step === 'add_server_nama') {
  state.data.nama_server = ctx.message.text.trim();
  state.step = 'add_server_quota';
  return ctx.reply('📊 Masukkan quota (GB):', { parse_mode: 'Markdown' });
}

if (state.step === 'add_server_quota') {
  if (!/^\d+$/.test(ctx.message.text)) {
    return ctx.reply('⚠️ Quota harus angka. Masukkan ulang:');
  }
  state.data.quota = parseInt(ctx.message.text);
  state.step = 'add_server_iplimit';
  return ctx.reply('📶 Masukkan IP limit:', { parse_mode: 'Markdown' });
}

if (state.step === 'add_server_iplimit') {
  if (!/^\d+$/.test(ctx.message.text)) {
    return ctx.reply('⚠️ IP limit harus angka. Masukkan ulang:');
  }
  state.data.iplimit = parseInt(ctx.message.text);
  state.step = 'add_server_batas';
  return ctx.reply('🔢 Masukkan batas create akun:', { parse_mode: 'Markdown' });
}

if (state.step === 'add_server_batas') {
  if (!/^\d+$/.test(ctx.message.text)) {
    return ctx.reply('⚠️ Batas create akun harus angka. Masukkan ulang:');
  }
  state.data.batas_create_akun = parseInt(ctx.message.text);

  // 🔥 INSERT DB (SATU-SATUNYA TEMPAT SIMPAN)
  const d = state.data;
  const service = state.service || 'ssh';

  db.run(
    "INSERT INTO Server (domain, auth, harga, nama_server, quota, iplimit, batas_create_akun, total_create_akun, support_zivpn, support_udp_http, service) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?)",
    [
      d.domain,
      d.auth,
      d.harga,
      d.nama_server,
      d.quota,
      d.iplimit,
      d.batas_create_akun,
      service === 'zivpn' ? 1 : 0,
      'ssh'
    ],
    (err) => {
      if (err) {
        ctx.reply('❌ Gagal menyimpan server.');
      } else {
        ctx.reply(`✅ Server *${d.nama_server}* berhasil ditambahkan.`, {
          parse_mode: 'Markdown'
        });
      }
    }
  );

  delete userState[ctx.chat.id];
  return;
}

  if (!state) return; 
    const text = ctx.message.text.trim();

  // =================== HAPUS SALDO ===================
  if (state && state.step === 'hapus_saldo_userid') {
    const targetUserId = text;
    
    // Validasi input
    if (!/^\d+$/.test(targetUserId)) {
      return ctx.reply('❌ *ID Telegram harus angka!*\n\nMasukkan ulang ID user:', { parse_mode: 'Markdown' });
    }
    
    // Cek apakah user ada
    db.get('SELECT user_id, saldo FROM users WHERE user_id = ?', [targetUserId], (err, user) => {
      if (err) {
        logger.error('❌ Error cek user untuk hapus saldo:', err.message);
        return ctx.reply('❌ Terjadi kesalahan saat memeriksa user.');
      }
      
      if (!user) {
        return ctx.reply(`❌ *User dengan ID ${targetUserId} tidak ditemukan!*\n\nMasukkan ID user lain atau ketik "batal" untuk membatalkan.`, { 
          parse_mode: 'Markdown' 
        });
      }
      
      // Simpan ke state dan lanjut ke input jumlah
      state.targetUserId = targetUserId;
      state.currentSaldo = user.saldo;
      state.step = 'hapus_saldo_amount';
      
      ctx.reply(
        `👤 *User ditemukan:*\n` +
        `• ID: \`${targetUserId}\`\n` +
        `• Saldo saat ini: *Rp ${user.saldo.toLocaleString('id-ID')}*\n\n` +
        `💰 *Masukkan jumlah saldo yang akan dihapus:*\n` +
        `(atau ketik "semua" untuk hapus semua saldo)`,
        { parse_mode: 'Markdown' }
      );
    });
    return;
  }
  
  if (state && state.step === 'hapus_saldo_amount') {
    const adminId = ctx.from.id;
    const targetUserId = state.targetUserId;
    const currentSaldo = state.currentSaldo;
    let amount;
    
    // Cek jika input "semua" atau "all"
    if (text.toLowerCase() === 'semua' || text.toLowerCase() === 'all') {
      amount = currentSaldo;
    } else {
      // Validasi angka
      amount = parseInt(text, 10);
      if (isNaN(amount) || amount <= 0) {
        return ctx.reply('❌ *Jumlah harus angka positif lebih dari 0!*\n\nMasukkan ulang jumlah:');
      }
      
      // Cek apakah saldo mencukupi
      if (amount > currentSaldo) {
        return ctx.reply(
          `❌ *Jumlah melebihi saldo user!*\n\n` +
          `Saldo user: Rp ${currentSaldo.toLocaleString('id-ID')}\n` +
          `Jumlah hapus: Rp ${amount.toLocaleString('id-ID')}\n` +
          `Kekurangan: Rp ${(amount - currentSaldo).toLocaleString('id-ID')}\n\n` +
          `Masukkan jumlah yang lebih kecil atau ketik "semua" untuk hapus semua saldo.`,
          { parse_mode: 'Markdown' }
        );
      }
    }
    
    // Konfirmasi
    state.amountToRemove = amount;
    state.step = 'hapus_saldo_confirm';
    
    await ctx.reply(
      `⚠️ *KONFIRMASI HAPUS SALDO*\n\n` +
      `👤 User ID: \`${targetUserId}\`\n` +
      `💰 Saldo saat ini: Rp ${currentSaldo.toLocaleString('id-ID')}\n` +
      `🗑️ Jumlah hapus: Rp ${amount.toLocaleString('id-ID')}\n` +
      `📉 Saldo setelahnya: Rp ${(currentSaldo - amount).toLocaleString('id-ID')}\n\n` +
      `Apakah Anda yakin ingin menghapus saldo ini?`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Ya, Hapus Saldo', callback_data: 'confirm_hapus_saldo' }],
            [{ text: '❌ Batal', callback_data: 'cancel_hapus_saldo' }]
          ]
        }
      }
    );
    return;
  }
//////
  if (state && state.step === "edit_nama_input") {
    const serverId = state.serverId;
    const namaBaru = ctx.message.text.trim();

    db.run(
      "UPDATE Server SET nama_server = ? WHERE id = ?",
      [namaBaru, serverId],
      (err) => {
        if (err) {
          logger.error("❌ Gagal update nama server:", err.message);
          return ctx.reply("⚠️ Gagal mengupdate nama server.");
        }

        ctx.reply(
          `✅ *Nama server berhasil diperbarui!*\n\n` +
          `🆔 ID Server: ${serverId}\n` +
          `🏷️ Nama Baru: *${namaBaru}*`,
          { parse_mode: "Markdown" }
        );

        logger.info(`Nama server ID ${serverId} diubah menjadi ${namaBaru}`);

        delete userState[ctx.chat.id];
      }
    );

    return;
  }
//////
  if (state.step === 'cek_saldo_userid') {
    const targetId = ctx.message.text.trim();
    db.get('SELECT saldo FROM users WHERE user_id = ?', [targetId], (err, row) => {
      if (err) {
        logger.error('❌ Gagal mengambil saldo:', err.message);
        return ctx.reply('❌ Terjadi kesalahan saat mengambil data saldo.');
      }

      if (!row) {
        return ctx.reply(`⚠️ User dengan ID ${targetId} belum terdaftar di database.`);
      }

      ctx.reply(`💰 Saldo user ${targetId}: Rp${row.saldo.toLocaleString()}`);
      logger.info(`Admin ${ctx.from.id} mengecek saldo user ${targetId}: Rp${row.saldo}`);
      delete userState[ctx.from.id];
    });
  }
///////
    if (state.step.startsWith('username_trial_')) {
  const username = text;

  // Validasi username
  if (!/^[a-z0-9]{3,20}$/.test(username)) {
    return ctx.reply('❌ *Username tidak valid. Gunakan huruf kecil dan angka (3–20 karakter).*', { parse_mode: 'Markdown' });
  }
/////////

 const resselDbPath = './ressel.db';
const idUser = ctx.from.id.toString().trim();

// Baca file reseller
fs.readFile(resselDbPath, 'utf8', async (err, data) => {
  if (err) {
    logger.error('❌ Gagal membaca file ressel.db:', err.message);
    return ctx.reply('❌ *Terjadi kesalahan saat membaca data reseller.*', { parse_mode: 'Markdown' });
  }

  const resselList = data.split('\n').map(line => line.trim()).filter(Boolean);
  const isRessel = resselList.includes(idUser);

  // Cek jika bukan reseller, maka periksa apakah sudah pernah trial hari ini
  if (!isRessel) {
    const sudahPakai = await checkTrialAccess(ctx.from.id);
    if (sudahPakai) {
      return ctx.reply('❌ *Anda sudah menggunakan fitur trial hari ini. Silakan coba lagi besok.*', { parse_mode: 'Markdown' });
    }
  }

    // Lanjut buat trial
// ===== EKSEKUSI SETELAH PILIH SERVER =====
const { action, type, serverId } = state;
delete userState[ctx.chat.id];

let msg;

// ===== TRIAL AKUN =====
if (action === 'trial') {

  // 🔹 generate data trial
  const username = `trial${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
  const exp = '1';       // 1 hari
  const quota = '500';    // 1 GB (sesuaikan)
  const iplimit = '1';  // 1 IP

  let msg;

  if (type === 'ssh') {
    const password = '1';
    msg = await trialssh(username, password, exp, iplimit, serverId);

  } else if (type === 'vmess') {
    msg = await trialvmess(username, exp, quota, iplimit, serverId);

  } else if (type === 'vless') {
    msg = await trialvless(username, exp, quota, iplimit, serverId);

  } else if (type === 'trojan') {
    msg = await trialtrojan(username, exp, quota, iplimit, serverId);

  } else if (type === 'zivpn') {
    msg = await trialzivpn(serverId);
  } else if (type === 'udp_http') {
    const password = '1';
    msg = await trialudphttp(username, password, exp, iplimit, serverId);
  }

  await saveTrialAccess(ctx.from.id);
  await ctx.reply(msg, { parse_mode: 'Markdown' });
  return;
}

  });
  return;
}

    if (state.step.startsWith('username_unlock_')) {
    const username = text;
    // Validasi username (hanya huruf kecil dan angka, 3-20 karakter)
    if (!/^[a-z0-9]{3,20}$/.test(username)) {
      return ctx.reply('❌ *Username tidak valid. Gunakan huruf kecil dan angka (3–20 karakter).*', { parse_mode: 'Markdown' });
    }
       //izin ressel saja
    const resselDbPath = './ressel.db';
    fs.readFile(resselDbPath, 'utf8', async (err, data) => {
      if (err) {
        logger.error('❌ Gagal membaca file ressel.db:', err.message);
        return ctx.reply('❌ *Terjadi kesalahan saat membaca data reseller.*', { parse_mode: 'Markdown' });
      }

      const idUser = ctx.from.id.toString().trim();
      const resselList = data.split('\n').map(line => line.trim()).filter(Boolean);

      console.log('🧪 ID Pengguna:', idUser);
      console.log('📂 Daftar Ressel:', resselList);

      const isRessel = resselList.includes(idUser);

      if (!isRessel) {
        return ctx.reply('❌ *Fitur ini hanya untuk Ressel VPN.*', { parse_mode: 'Markdown' });
      }
  //izin ressel saja
    const { type, serverId } = state;
    delete userState[ctx.chat.id];

    let msg = 'none';
    try {
      const password = 'none', exp = 'none', iplimit = 'none';

      const delFunctions = {
        vmess: unlockvmess,
        vless: unlockvless,
        trojan: unlocktrojan,
        shadowsocks: unlockshadowsocks,
        ssh: unlockssh,
        udp_http: unlockssh
      };

      if (delFunctions[type]) {
        msg = await delFunctions[type](username, password, exp, iplimit, serverId);
      }

      await ctx.reply(msg, { parse_mode: 'Markdown' });
      logger.info(`✅ Akun ${type} berhasil unlock oleh ${ctx.from.id}`);
    } catch (err) {
      logger.error('❌ Gagal hapus akun:', err.message);
      await ctx.reply('❌ *Terjadi kesalahan saat menghapus akun.*', { parse_mode: 'Markdown' });
    }});
    return; // Penting! Jangan lanjut ke case lain
  }
    if (state.step.startsWith('username_lock_')) {
    const username = text;
    // Validasi username (hanya huruf kecil dan angka, 3-20 karakter)
    if (!/^[a-z0-9]{3,20}$/.test(username)) {
      return ctx.reply('❌ *Username tidak valid. Gunakan huruf kecil dan angka (3–20 karakter).*', { parse_mode: 'Markdown' });
    }
       //izin ressel saja
    const resselDbPath = './ressel.db';
    fs.readFile(resselDbPath, 'utf8', async (err, data) => {
      if (err) {
        logger.error('❌ Gagal membaca file ressel.db:', err.message);
        return ctx.reply('❌ *Terjadi kesalahan saat membaca data reseller.*', { parse_mode: 'Markdown' });
      }

      const idUser = ctx.from.id.toString().trim();
      const resselList = data.split('\n').map(line => line.trim()).filter(Boolean);

      console.log('🧪 ID Pengguna:', idUser);
      console.log('📂 Daftar Ressel:', resselList);

      const isRessel = resselList.includes(idUser);

      if (!isRessel) {
        return ctx.reply('❌ *Fitur ini hanya untuk Ressel VPN.*', { parse_mode: 'Markdown' });
      }
  //izin ressel saja
    const { type, serverId } = state;
    delete userState[ctx.chat.id];

    let msg = 'none';
    try {
      const password = 'none', exp = 'none', iplimit = 'none';

      const delFunctions = {
        vmess: lockvmess,
        vless: lockvless,
        trojan: locktrojan,
        shadowsocks: lockshadowsocks,
        ssh: lockssh,
        udp_http: lockssh
      };

      if (delFunctions[type]) {
        msg = await delFunctions[type](username, password, exp, iplimit, serverId);
      }

      await ctx.reply(msg, { parse_mode: 'Markdown' });
      logger.info(`✅ Akun ${type} berhasil di kunci oleh ${ctx.from.id}`);
    } catch (err) {
      logger.error('❌ Gagal hapus akun:', err.message);
      await ctx.reply('❌ *Terjadi kesalahan saat menghapus akun.*', { parse_mode: 'Markdown' });
    }});
    return; // Penting! Jangan lanjut ke case lain
  }
  if (state.step.startsWith('username_del_')) {
    const username = text;
    // Validasi username (hanya huruf kecil dan angka, 3-20 karakter)
    if (!/^[a-z0-9]{3,20}$/.test(username)) {
      return ctx.reply('❌ *Username tidak valid. Gunakan huruf kecil dan angka (3–20 karakter).*', { parse_mode: 'Markdown' });
    }
       //izin ressel saja
    const resselDbPath = './ressel.db';
    fs.readFile(resselDbPath, 'utf8', async (err, data) => {
      if (err) {
        logger.error('❌ Gagal membaca file ressel.db:', err.message);
        return ctx.reply('❌ *Terjadi kesalahan saat membaca data reseller.*', { parse_mode: 'Markdown' });
      }

      const idUser = ctx.from.id.toString().trim();
      const resselList = data.split('\n').map(line => line.trim()).filter(Boolean);

      console.log('🧪 ID Pengguna:', idUser);
      console.log('📂 Daftar Ressel:', resselList);

      const isRessel = resselList.includes(idUser);

      if (!isRessel) {
        return ctx.reply('❌ *Fitur ini hanya untuk Ressel VPN.*', { parse_mode: 'Markdown' });
      }
  //izin ressel saja
    const { type, serverId } = state;
    delete userState[ctx.chat.id];

    let msg = 'none';
    try {
      const password = 'none', exp = 'none', iplimit = 'none';

      const delFunctions = {
        vmess: delvmess,
        vless: delvless,
        trojan: deltrojan,
        ssh: delssh,
        udp_http: deludphttp,
        zivpn: delzivpn
      };

      if (delFunctions[type]) {
        msg = await delFunctions[type](username, password, exp, iplimit, serverId);
      }

      await ctx.reply(msg, { parse_mode: 'Markdown' });

      const delResultText = String(msg || '').toLowerCase();
      const deleteFailed = /gagal|error|failed|tidak\s+ditemukan|not\s+found/.test(delResultText);
      if (!deleteFailed) {
        const serverRow = await new Promise((resolve) => {
          db.get('SELECT nama_server, domain FROM Server WHERE id = ?', [serverId], (e, r) => {
            if (e) return resolve(null);
            resolve(r || null);
          });
        });

        await notifyGroupAccountDeleted({
          action: 'admin_or_reseller_delete',
          actorId: ctx.from.id,
          actorUsername: ctx.from.username || '',
          targetUserId: '-',
          accountUsername: username,
          service: String(type || '-').toUpperCase(),
          serverName: (serverRow && (serverRow.nama_server || serverRow.domain)) || ('ID ' + serverId),
          refund: 0,
          remainingDays: 0,
          note: 'Hapus akun via menu del reseller/admin'
        });
      }

      logger.info(`? Akun ${type} berhasil dihapus oleh ${ctx.from.id}`);
    } catch (err) {
      logger.error('❌ Gagal hapus akun:', err.message);
      await ctx.reply('❌ *Terjadi kesalahan saat menghapus akun.*', { parse_mode: 'Markdown' });
    }});
    return; // Penting! Jangan lanjut ke case lain
  }
  if (state.step.startsWith('username_')) {
    state.username = text;

    if (!state.username) {
      return ctx.reply('❌ *Username tidak valid. Masukkan username yang valid| Masukan Ulang Username: *', { parse_mode: 'Markdown' });
    }
    if (state.username.length < 4 || state.username.length > 20) {
      return ctx.reply('❌ *Username harus terdiri dari 4 hingga 20 karakter| Masukan Ulang Username: *', { parse_mode: 'Markdown' });
    }
    if (/[A-Z]/.test(state.username)) {
      return ctx.reply('❌ *Username tidak boleh menggunakan huruf kapital. Gunakan huruf kecil saja| Masukan Ulang Username: *', { parse_mode: 'Markdown' });
    }
    if (/[^a-z0-9]/.test(state.username)) {
      return ctx.reply('❌ *Username tidak boleh mengandung karakter khusus atau spasi. Gunakan huruf kecil dan angka saja| Masukan Ulang Username: *', { parse_mode: 'Markdown' });
    }
    const { type, action } = state;
    if (action === 'create') {
      if (!isStrongCreateUsername(state.username)) {
        return ctx.reply(' *Username harus mengandung minimal 4 huruf dan 4 angka dengan huruf kecil semua.*', { parse_mode: 'Markdown' });
      }
      if (type === 'ssh' || type === 'udp_http') {
        state.step = `password_${state.action}_${state.type}`;
        await ctx.reply('🔑 *Masukkan password:*', { parse_mode: 'Markdown' });
      } else {
        state.step = `exp_${state.action}_${state.type}`;
        await ctx.reply('⏳ *Masukkan masa aktif (hari):*', { parse_mode: 'Markdown' });
      }
    } else if (action === 'renew') {
      state.step = `exp_${state.action}_${state.type}`;
      await ctx.reply('⏳ *Masukkan masa aktif (hari):*', { parse_mode: 'Markdown' });
    }
  } else if (state.step.startsWith('password_')) {
    state.password = ctx.message.text.trim();
    if (!state.password) {
      return ctx.reply('❌ *Password tidak valid. Masukkan password yang valid| Masukan Ulang Password: *', { parse_mode: 'Markdown' });
    }
    if (state.password.length < 3) {
      return ctx.reply('❌ *Password harus terdiri dari minimal 3 karakter| Masukan Ulang Password: *', { parse_mode: 'Markdown' });
    }
    if (/[^a-zA-Z0-9]/.test(state.password)) {
      return ctx.reply('❌ *Password tidak boleh mengandung karakter khusus atau spasi| Masukan Ulang Password: *', { parse_mode: 'Markdown' });
    }
    state.step = `exp_${state.action}_${state.type}`;
    await ctx.reply('⏳ *Masukkan masa aktif (hari):*', { parse_mode: 'Markdown' });
  } else if (state.step.startsWith('exp_')) {
    const expInput = ctx.message.text.trim();
    if (!/^\d+$/.test(expInput)) {
      return ctx.reply('❌ *Masa aktif tidak valid. Masukkan angka yang valid.*', { parse_mode: 'Markdown' });
    }
// Cek hanya angka
if (!/^\d+$/.test(expInput)) {
  return ctx.reply('❌ *Masa aktif hanya boleh angka, contoh: 30*', { parse_mode: 'Markdown' });
}

const exp = parseInt(expInput, 10);

if (isNaN(exp) || exp <= 0) {
  return ctx.reply('❌ *Masa aktif tidak valid. Masukkan angka yang valid.*', { parse_mode: 'Markdown' });
}

if (exp > 365) {
  return ctx.reply('❌ *Masa aktif tidak boleh lebih dari 365 hari.*', { parse_mode: 'Markdown' });
}
    state.exp = exp;

    db.get('SELECT quota, iplimit, domain, nama_server FROM Server WHERE id = ?', [state.serverId], async (err, server) => {
      if (err) {
        logger.error('⚠️ Error fetching server details:', err.message);
        return ctx.reply('❌ *Terjadi kesalahan saat mengambil detail server.*', { parse_mode: 'Markdown' });
      }

      if (!server) {
        return ctx.reply('❌ *Server tidak ditemukan.*', { parse_mode: 'Markdown' });
      }

      state.quota = server.quota;
      state.iplimit = server.iplimit;
      state.serverDomain = server.domain || '';
      state.serverName = server.nama_server || server.domain || '';

      const { username, password, exp, quota, iplimit, serverId, type, action } = state;
      let usedPassword = password || '';
      let msg;

      db.get('SELECT harga, harga_reseller FROM Server WHERE id = ?', [serverId], async (err, server) => {
        if (err) {
          logger.error('⚠️ Error fetching server price:', err.message);
          return ctx.reply('❌ *Terjadi kesalahan saat mengambil harga server.*', { parse_mode: 'Markdown' });
        }

        if (!server) {
          return ctx.reply('❌ *Server tidak ditemukan.*', { parse_mode: 'Markdown' });
        }

        const isResellerUser = await isUserReseller(ctx.from.id).catch(() => false);
        const harga = getEffectiveServerPrice(server, isResellerUser);
        const totalHarga = harga * state.exp; 
        db.get('SELECT saldo FROM users WHERE user_id = ?', [ctx.from.id], async (err, user) => {
          if (err) {
            logger.error('⚠️ Kesalahan saat mengambil saldo pengguna:', err.message);
            return ctx.reply('❌ *Terjadi kesalahan saat mengambil saldo pengguna.*', { parse_mode: 'Markdown' });
          }

          if (!user) {
            return ctx.reply('❌ *Pengguna tidak ditemukan.*', { parse_mode: 'Markdown' });
          }

          const saldo = user.saldo;
          if (saldo < totalHarga) {
            return ctx.reply('❌ *Saldo Anda tidak mencukupi untuk melakukan transaksi ini.*', { parse_mode: 'Markdown' });
          }
          if (action === 'create') {
            if (type === 'vmess') {
              msg = await createvmess(username, exp, quota, iplimit, serverId);
            } else if (type === 'vless') {
              msg = await createvless(username, exp, quota, iplimit, serverId);
            } else if (type === 'trojan') {
              msg = await createtrojan(username, exp, quota, iplimit, serverId);
            } else if (type === 'shadowsocks') {
              msg = await createshadowsocks(username, exp, quota, iplimit, serverId);
            } else if (type === 'ssh') {
              msg = await createssh(username, password, exp, iplimit, serverId);
            } else if (type === 'zivpn') {
              const randomPassword = Math.random().toString(36).slice(-8);
              usedPassword = randomPassword;
              msg = await createzivpn(username, randomPassword, exp, iplimit, serverId);
            } else if (type === 'udp_http') {
              msg = await createudphttp(username, password, exp, iplimit, serverId);
            }

            logger.info(`Account created for user ${ctx.from.id}, type: ${type}`);
          } else if (action === 'renew') {
            if (type === 'vmess') {
              msg = await renewvmess(username, exp, quota, iplimit, serverId);
            } else if (type === 'vless') {
              msg = await renewvless(username, exp, quota, iplimit, serverId);
            } else if (type === 'trojan') {
              msg = await renewtrojan(username, exp, quota, iplimit, serverId);
            } else if (type === 'shadowsocks') {
              msg = await renewshadowsocks(username, exp, quota, iplimit, serverId);
            } else if (type === 'ssh') {
              msg = await renewssh(username, exp, iplimit, serverId);
            }
            else if (type === 'udp_http') {
              msg = await renewudphttp(username, exp, iplimit, serverId);
            }
            else if (type === 'zivpn') {
              msg = await renewzivpn(username, exp, iplimit, serverId);
            }
            logger.info(`Account renewed for user ${ctx.from.id}, type: ${type}`);
          }
//SALDO DATABES
// setelah bikin akun (create/renew), kita cek hasilnya
const msgLower = String(msg).toLowerCase();
const isDuplicateUsername =
  action === 'create' &&
  (
    msgLower.includes('username sudah ada') ||
    msgLower.includes('username already exists') ||
    msgLower.includes('username exists') ||
    msgLower.includes('duplicate username') ||
    msgLower.includes('exists, try another name') ||
    (msgLower.includes('exists') && msgLower.includes('try another name'))
  );

if (isDuplicateUsername) {
  state.step = `username_${action}_${type}`;
  delete state.username;
  delete state.exp;
  await ctx.reply(
    'Username yang kamu masukkan sudah dipakai di server.\n' +
    'Silakan gunakan username lain yang unik.\n\n' +
    'Masukkan username baru:',
    { parse_mode: 'Markdown' }
  );
  return;
}
// Fix: jangan pakai '?' sebagai penanda error karena bisa muncul di pesan sukses vless/trojan
const isErrorMsg = msg.includes('❌') || msgLower.includes('sudah ada') || msgLower.includes('exists') || msgLower.includes('already exists') || msgLower.includes('error') || msgLower.includes('tidak valid') || msgLower.includes('tidak ditemukan') || msgLower.includes('respons error');
if (isErrorMsg) {
  logger.error(`🔄 Rollback saldo user ${ctx.from.id}, type: ${type}, server: ${serverId}, respon: ${msg}`);
  return ctx.reply(msg, { parse_mode: 'Markdown' });
}
// kalau sampai sini artinya tidak ada error, lanjut finalisasi saldo + transaksi (atomic)
const chargeResult = await chargeAccountTransactionAtomic(ctx.from.id, totalHarga, type, action);
if (!chargeResult.ok) {
  logger.error(`Finalisasi transaksi gagal untuk user ${ctx.from.id}, type: ${type}, server: ${serverId}, err: ${chargeResult.error}`);
  if (chargeResult.error === 'SALDO_NOT_ENOUGH_OR_USER_NOT_FOUND') {
    return ctx.reply('❌ Saldo tidak cukup (kemungkinan sudah terpakai transaksi lain). Silakan cek saldo Anda lalu coba lagi.', { parse_mode: 'Markdown' });
  }
  return ctx.reply('❌ Terjadi kesalahan saat finalisasi transaksi. Silakan coba lagi.', { parse_mode: 'Markdown' });
}

logger.info(`✅ Transaksi sukses untuk user ${ctx.from.id}, type: ${type}, server: ${serverId}, ref: ${chargeResult.referenceId}`);

if (action === 'create') {
  db.run('UPDATE Server SET total_create_akun = total_create_akun + 1 WHERE id = ?', [serverId], (err) => {
    if (err) {
      logger.error('Kesalahan saat menambahkan total_create_akun:', err.message);
    }
  });
}

const expDays = Number(exp) || 0;
let expiresAt = expDays > 0 ? (Date.now() + expDays * 24 * 60 * 60 * 1000) : null;

if (action === 'renew' && expDays > 0) {
  const existingExpiry = await getAccountExistingExpiry(ctx.from.id, type, username, serverId, state.serverDomain);
  const baseTs = Math.max(Date.now(), Number(existingExpiry || 0));
  expiresAt = baseTs + expDays * 24 * 60 * 60 * 1000;
}
const passwordToStore = (type === 'zivpn') ? usedPassword : password;
const linkPayload = (type === 'vmess' || type === 'vless' || type === 'trojan')
  ? extractAccountLinksFromMessage(msg)
  : {};
upsertAccountRecord({
  userId: ctx.from.id,
  type,
  username,
  password: passwordToStore,
  serverId,
  serverName: state.serverName,
  domain: state.serverDomain,
  expiresAt,
  ...linkPayload
});

if (action === 'create') {
  try {
    const isReseller = await isUserReseller(ctx.from.id);
    if (!isReseller) {
      const expDate = new Date(Date.now() + exp * 24 * 60 * 60 * 1000);
      const creatorLabel = ctx.from.username
        ? `@${ctx.from.username}`
        : (ctx.from.first_name || 'User');
      await sendNonResellerCreateNotification({
        service: type.toUpperCase(),
        serverName: state.serverName,
        domain: state.serverDomain,
        accountUsername: username,
        accountPassword: usedPassword,
        expDays: exp,
        expiredDate: formatDateId(expDate),
        creatorLabel,
        creatorId: ctx.from.id
      });
    }
  } catch (e) {
    logger.error('❌ Gagal kirim notif create non-reseller:', e.message);
  }
}

await ctx.reply(msg, { parse_mode: 'Markdown' });
delete userState[ctx.chat.id];
//SALDO DATABES
          });
        });
      });
    } 
  else if (state.step === 'addserver') {
    const domain = ctx.message.text.trim();
    if (!domain) {
      await ctx.reply('⚠️ *Domain tidak boleh kosong.* Silakan masukkan domain server yang valid.', { parse_mode: 'Markdown' });
      return;
    }

    state.step = 'addserver_auth';
    state.domain = domain;
    await ctx.reply('🔑 *Silakan masukkan auth server:*', { parse_mode: 'Markdown' });
  } else if (state.step === 'addserver_auth') {
    const auth = ctx.message.text.trim();
    if (!auth) {
      await ctx.reply('⚠️ *Auth tidak boleh kosong.* Silakan masukkan auth server yang valid.', { parse_mode: 'Markdown' });
      return;
    }

    state.step = 'addserver_nama_server';
    state.auth = auth;
    await ctx.reply('🏷️ *Silakan masukkan nama server:*', { parse_mode: 'Markdown' });
  } else if (state.step === 'addserver_nama_server') {
    const nama_server = ctx.message.text.trim();
    if (!nama_server) {
      await ctx.reply('⚠️ *Nama server tidak boleh kosong.* Silakan masukkan nama server yang valid.', { parse_mode: 'Markdown' });
      return;
    }

    state.step = 'addserver_quota';
    state.nama_server = nama_server;
    await ctx.reply('📊 *Silakan masukkan quota server:*', { parse_mode: 'Markdown' });
  } else if (state.step === 'addserver_quota') {
    const quota = parseInt(ctx.message.text.trim(), 10);
    if (isNaN(quota)) {
      await ctx.reply('⚠️ *Quota tidak valid.* Silakan masukkan quota server yang valid.', { parse_mode: 'Markdown' });
      return;
    }

    state.step = 'addserver_iplimit';
    state.quota = quota;
    await ctx.reply('🔢 *Silakan masukkan limit IP server:*', { parse_mode: 'Markdown' });
  } else if (state.step === 'addserver_iplimit') {
    const iplimit = parseInt(ctx.message.text.trim(), 10);
    if (isNaN(iplimit)) {
      await ctx.reply('⚠️ *Limit IP tidak valid.* Silakan masukkan limit IP server yang valid.', { parse_mode: 'Markdown' });
      return;
    }

    state.step = 'addserver_batas_create_akun';
    state.iplimit = iplimit;
    await ctx.reply('🔢 *Silakan masukkan batas create akun server:*', { parse_mode: 'Markdown' });
  } else if (state.step === 'addserver_batas_create_akun') {
    const batas_create_akun = parseInt(ctx.message.text.trim(), 10);
    if (isNaN(batas_create_akun)) {
      await ctx.reply('⚠️ *Batas create akun tidak valid.* Silakan masukkan batas create akun server yang valid.', { parse_mode: 'Markdown' });
      return;
    }

    state.step = 'addserver_harga';
    state.batas_create_akun = batas_create_akun;
    await ctx.reply('💰 *Silakan masukkan harga server:*', { parse_mode: 'Markdown' });
  } else if (state.step === 'addserver_harga') {
    const harga = parseFloat(ctx.message.text.trim());
    if (isNaN(harga) || harga <= 0) {
      await ctx.reply('⚠️ *Harga tidak valid.* Silakan masukkan harga server yang valid.', { parse_mode: 'Markdown' });
      return;
    }
    const { domain, auth, nama_server, quota, iplimit, batas_create_akun } = state;

  try {
    const isResellerOnly = state.is_reseller_only ? 1 : 0;
    const supportZivpn = state.support_zivpn ? 1 : 0;
    const supportUdpHttp = state.support_udp_http ? 1 : 0;
    db.run(
      'INSERT INTO Server (domain, auth, nama_server, quota, iplimit, batas_create_akun, harga, total_create_akun, is_reseller_only, support_zivpn, support_udp_http, service) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [domain, auth, nama_server, quota, iplimit, batas_create_akun, harga, 0, isResellerOnly, supportZivpn, supportUdpHttp, 'ssh'],
      function(err) {
        if (err) {
          logger.error('Error saat menambahkan server:', err.message);
          ctx.reply('❌ *Terjadi kesalahan saat menambahkan server baru.*', { parse_mode: 'Markdown' });
        } else {
          ctx.reply(`✅ *Server baru dengan domain ${domain} telah berhasil ditambahkan.*\n\n📄 *Detail Server:*\n- Domain: ${domain}\n- Auth: ${auth}\n- Nama Server: ${nama_server}\n- Quota: ${quota}\n- Limit IP: ${iplimit}\n- Batas Create Akun: ${batas_create_akun}\n- Harga: Rp ${harga}`, { parse_mode: 'Markdown' });
        }
      }
    );
  } catch (error) {
    logger.error('Error saat menambahkan server:', error);
    await ctx.reply('❌ *Terjadi kesalahan saat menambahkan server baru.*', { parse_mode: 'Markdown' });
  }
    delete userState[ctx.chat.id];
  }
// === 🏷️ TAMBAH SERVER UNTUK RESELLER ===
if (state && state.step === 'reseller_domain') {
  state.domain = text;
  state.step = 'reseller_auth';
  return ctx.reply('🔑 Masukkan auth server:');
}

if (state && state.step === 'reseller_auth') {
  state.auth = text;
  state.step = 'reseller_harga';
  return ctx.reply('💰 Masukkan harga server (angka):');
}

if (state && state.step === 'reseller_harga') {
  state.harga = text;
  state.step = 'reseller_nama';
  return ctx.reply('📝 Masukkan nama server:');
}

if (state && state.step === 'reseller_nama') {
  state.nama_server = text;
  state.step = 'reseller_quota';
  return ctx.reply('📊 Masukkan quota (GB):');
}

if (state && state.step === 'reseller_quota') {
  state.quota = text;
  state.step = 'reseller_iplimit';
  return ctx.reply('📶 Masukkan IP limit:');
}

if (state && state.step === 'reseller_iplimit') {
  state.iplimit = text;
  state.step = 'reseller_batas';
  return ctx.reply('🔢 Masukkan batas create akun:');
}

if (state && state.step === 'reseller_batas') {
  state.batas_create_akun = text;

  db.run(
    `INSERT INTO Server (domain, auth, harga, nama_server, quota, iplimit, batas_create_akun, total_create_akun, is_reseller_only, support_zivpn, support_udp_http, service)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, 0, 0, 'ssh')`,
    [
      state.domain,
      state.auth,
      parseInt(state.harga),
      state.nama_server,
      parseInt(state.quota),
      parseInt(state.iplimit),
      parseInt(state.batas_create_akun),
    ],
    (err) => {
      if (err) {
        logger.error('❌ Gagal menambah server reseller:', err.message);
        ctx.reply('❌ Gagal menambah server reseller.');
      } else {
        ctx.reply(
          `✅ Server reseller *${state.nama_server}* berhasil ditambahkan!`,
          { parse_mode: 'Markdown' }
        );
      }
      delete userState[ctx.chat.id];
    }
  );
  return;
}
// === 💰 TAMBAH SALDO (LANGKAH 1: INPUT USER ID) ===
if (state && state.step === 'addsaldo_userid') {
  state.targetId = text.trim();
  state.step = 'addsaldo_amount';
  return ctx.reply('💰 Masukkan jumlah saldo yang ingin ditambahkan:');
}

// === 💰 TAMBAH SALDO (LANGKAH 1: INPUT USER ID) ===
if (state && state.step === 'addsaldo_userid') {
  state.targetId = text.trim();
  state.step = 'addsaldo_amount';
  return ctx.reply('💰 Masukkan jumlah saldo yang ingin ditambahkan:');
}

// === 💰 TAMBAH SALDO (LANGKAH 2: INPUT JUMLAH SALDO) ===
if (state && state.step === 'addsaldo_amount') {
  const amount = parseInt(text.trim());
  if (isNaN(amount) || amount <= 0) {
    return ctx.reply('⚠️ Jumlah saldo harus berupa angka dan lebih dari 0.');
  }

  const targetId = state.targetId;

// Tambahkan saldo
db.run('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', [amount, targetId], (err) => {
  if (err) {
    logger.error('❌ Gagal menambah saldo:', err.message);
    return ctx.reply('❌ Gagal menambah saldo ke user.');
  }

  // Ambil saldo terbaru
  db.get('SELECT saldo FROM users WHERE user_id = ?', [targetId], (err2, updated) => {
    if (err2 || !updated) {
      ctx.reply(`✅ Saldo sebesar Rp${amount} berhasil ditambahkan ke user ${targetId}.`);
      logger.info(`Admin ${ctx.from.id} menambah saldo Rp${amount} ke user ${targetId}.`);
    } else {
      ctx.reply(`✅ Saldo sebesar Rp${amount} berhasil ditambahkan ke user ${targetId}.\n💳 Saldo sekarang: Rp${updated.saldo}`);
      logger.info(`Admin ${ctx.from.id} menambah saldo Rp${amount} ke user ${targetId} (Saldo akhir: Rp${updated.saldo}).`);
    }
  });

  delete userState[ctx.from.id];
});

  return;
}
});
////////
bot.action('addserver', async (ctx) => {
  try {
    logger.info('📥 Proses tambah server dimulai');
    await ctx.answerCbQuery();
    userState[ctx.chat.id] = { step: 'addserver_role', data: {} };
    await ctx.reply('Pilih tipe server:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Server Reseller', callback_data: 'addserver_role_reseller' }],
          [{ text: 'Server User Biasa', callback_data: 'addserver_role_user' }],
          [{ text: 'Batal', callback_data: 'admin_menu' }]
        ]
      }
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses tambah server:', error);
    await ctx.reply('❌ *GAGAL! Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.*', { parse_mode: 'Markdown' });
  }
});

bot.action('addserver_role_reseller', async (ctx) => {
  await ctx.answerCbQuery();
  const state = userState[ctx.chat.id] || { data: {} };
  state.is_reseller_only = 1;
  state.step = 'addserver_support';
  userState[ctx.chat.id] = state;
  await ctx.reply('Pilih support server:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Support ZIVPN', callback_data: 'addserver_support_zivpn' }],
        [{ text: 'Support UDP HTTP', callback_data: 'addserver_support_udp_http' }],
        [{ text: 'Tanpa Support', callback_data: 'addserver_support_none' }]
      ]
    }
  });
});

bot.action('addserver_role_user', async (ctx) => {
  await ctx.answerCbQuery();
  const state = userState[ctx.chat.id] || { data: {} };
  state.is_reseller_only = 0;
  state.step = 'addserver_support';
  userState[ctx.chat.id] = state;
  await ctx.reply('Pilih support server:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Support ZIVPN', callback_data: 'addserver_support_zivpn' }],
        [{ text: 'Support UDP HTTP', callback_data: 'addserver_support_udp_http' }],
        [{ text: 'Tanpa Support', callback_data: 'addserver_support_none' }]
      ]
    }
  });
});

bot.action('addserver_support_zivpn', async (ctx) => {
  await ctx.answerCbQuery();
  const state = userState[ctx.chat.id] || { data: {} };
  state.support_zivpn = 1;
  state.support_udp_http = 0;
  state.step = 'addserver';
  userState[ctx.chat.id] = state;
  await ctx.reply('🌐 *Silakan masukkan domain/ip server:*', { parse_mode: 'Markdown' });
});

bot.action('addserver_support_udp_http', async (ctx) => {
  await ctx.answerCbQuery();
  const state = userState[ctx.chat.id] || { data: {} };
  state.support_zivpn = 0;
  state.support_udp_http = 1;
  state.step = 'addserver';
  userState[ctx.chat.id] = state;
  await ctx.reply('🌐 *Silakan masukkan domain/ip server:*', { parse_mode: 'Markdown' });
});

bot.action('addserver_support_none', async (ctx) => {
  await ctx.answerCbQuery();
  const state = userState[ctx.chat.id] || { data: {} };
  state.support_zivpn = 0;
  state.support_udp_http = 0;
  state.step = 'addserver';
  userState[ctx.chat.id] = state;
  await ctx.reply('🌐 *Silakan masukkan domain/ip server:*', { parse_mode: 'Markdown' });
});
bot.action('detailserver', async (ctx) => {
  try {
    logger.info('📋 Proses detail server dimulai');
    await ctx.answerCbQuery();
    
    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], (err, servers) => {
        if (err) {
          logger.error('⚠️ Kesalahan saat mengambil detail server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil detail server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      logger.info('⚠️ Tidak ada server yang tersedia');
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia saat ini.*', { parse_mode: 'Markdown' });
    }

    const buttons = [];
    for (let i = 0; i < servers.length; i += 2) {
      const row = [];
      row.push({
        text: `${servers[i].nama_server}`,
        callback_data: `server_detail_${servers[i].id}`
      });
      if (i + 1 < servers.length) {
        row.push({
          text: `${servers[i + 1].nama_server}`,
          callback_data: `server_detail_${servers[i + 1].id}`
        });
      }
      buttons.push(row);
    }

    await ctx.reply('📋 *Silakan pilih server untuk melihat detail:*', {
      reply_markup: { inline_keyboard: buttons },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('⚠️ Kesalahan saat mengambil detail server:', error);
    await ctx.reply('⚠️ *Terjadi kesalahan saat mengambil detail server.*', { parse_mode: 'Markdown' });
  }
});

bot.action('listserver', async (ctx) => {
  try {
    logger.info('📜 Proses daftar server dimulai');
    await ctx.answerCbQuery();
    
    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], (err, servers) => {
        if (err) {
          logger.error('⚠️ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      logger.info('⚠️ Tidak ada server yang tersedia');
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia saat ini.*', { parse_mode: 'Markdown' });
    }

    let serverList = '📜 *Daftar Server* 📜\n\n';
    servers.forEach((server, index) => {
      serverList += `🔹 ${index + 1}. ${server.domain}\n`;
    });

    serverList += `\nTotal Jumlah Server: ${servers.length}`;

    await ctx.reply(serverList, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('⚠️ Kesalahan saat mengambil daftar server:', error);
    await ctx.reply('⚠️ *Terjadi kesalahan saat mengambil daftar server.*', { parse_mode: 'Markdown' });
  }
});
bot.action('resetdb', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.reply('🚨 *PERHATIAN! Anda akan menghapus semua server yang tersedia. Apakah Anda yakin?*', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Ya', callback_data: 'confirm_resetdb' }],
          [{ text: '❌ Tidak', callback_data: 'cancel_resetdb' }]
        ]
      },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Error saat memulai proses reset database:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});

bot.action('confirm_resetdb', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM Server', (err) => {
        if (err) {
          logger.error('❌ Error saat mereset tabel Server:', err.message);
          return reject('❗️ *PERHATIAN! Terjadi KESALAHAN SERIUS saat mereset database. Harap segera hubungi administrator!*');
        }
        resolve();
      });
    });
    await ctx.reply('🚨 *PERHATIAN! Database telah DIRESET SEPENUHNYA. Semua server telah DIHAPUS TOTAL.*', { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('❌ Error saat mereset database:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});

bot.action('cancel_resetdb', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.reply('❌ *Proses reset database dibatalkan.*', { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('❌ Error saat membatalkan reset database:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});
bot.action('deleteserver', async (ctx) => {
  try {
    logger.info('🗑️ Proses hapus server dimulai');
    await ctx.answerCbQuery();
    
    db.all('SELECT * FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], (err, servers) => {
      if (err) {
        logger.error('⚠️ Kesalahan saat mengambil daftar server:', err.message);
        return ctx.reply('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*', { parse_mode: 'Markdown' });
      }

      if (servers.length === 0) {
        logger.info('⚠️ Tidak ada server yang tersedia');
        return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia saat ini.*', { parse_mode: 'Markdown' });
      }

      const keyboard = servers.map(server => {
        return [{ text: server.nama_server, callback_data: `confirm_delete_server_${server.id}` }];
      });
      keyboard.push([{ text: '🔙 Kembali ke Menu Utama', callback_data: 'kembali_ke_menu' }]);

      ctx.reply('🗑️ *Pilih server yang ingin dihapus:*', {
        reply_markup: {
          inline_keyboard: keyboard
        },
        parse_mode: 'Markdown'
      });
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses hapus server:', error);
    await ctx.reply('❌ *GAGAL! Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.*', { parse_mode: 'Markdown' });
  }
});


const getUsernameById = async (userId) => {
  try {
    const telegramUser = await bot.telegram.getChat(userId);
    return telegramUser.username || telegramUser.first_name;
  } catch (err) {
    logger.error('❌ Kesalahan saat mengambil username dari Telegram:', err.message);
    throw new Error('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil username dari Telegram.*');
  }
};
/////////////
bot.action('tambah_saldo', async (ctx) => {
  await ctx.answerCbQuery();
  const adminId = ctx.from.id;
  userState[adminId] = { step: 'addsaldo_userid' };
  await ctx.reply('🔢 Masukkan ID Telegram user yang ingin ditambahkan saldo:');
});
//////
bot.action(/next_users_(\d+)/, async (ctx) => {
  const currentPage = parseInt(ctx.match[1]);
  const offset = currentPage * 20;

  try {
    logger.info(`Next users process started for page ${currentPage + 1}`);
    await ctx.answerCbQuery();

    const users = await new Promise((resolve, reject) => {
      db.all(`SELECT user_id FROM users LIMIT 20 OFFSET ${offset}`, [], (err, users) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar user:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar user.*');
        }
        resolve(users);
      });
    });

    const totalUsers = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM users', [], (err, row) => {
        if (err) {
          logger.error('❌ Kesalahan saat menghitung total user:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat menghitung total user.*');
        }
        resolve(row.count);
      });
    });

    const keyboard = [];
    for (let i = 0; i < users.length; i += 2) {
      const row = [];
      const username1 = await getUsernameById(users[i].user_id);
      row.push({
        text: username1 || users[i].user_id,
        callback_data: `add_saldo_${users[i].user_id}`
      });
      if (i + 1 < users.length) {
        const username2 = await getUsernameById(users[i + 1].user_id);
        row.push({
          text: username2 || users[i + 1].user_id,
          callback_data: `add_saldo_${users[i + 1].user_id}`
        });
      }
      keyboard.push(row);
    }

    const replyMarkup = {
      inline_keyboard: [...keyboard]
    };

    const navigationButtons = [];
    if (currentPage > 0) {
      navigationButtons.push([{
        text: '⬅️ Back',
        callback_data: `prev_users_${currentPage - 1}`
      }]);
    }
    if (offset + 20 < totalUsers) {
      navigationButtons.push([{
        text: '➡️ Next',
        callback_data: `next_users_${currentPage + 1}`
      }]);
    }

    replyMarkup.inline_keyboard.push(...navigationButtons);

    await ctx.editMessageReplyMarkup(replyMarkup);
  } catch (error) {
    logger.error('❌ Kesalahan saat memproses next users:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});

bot.action(/prev_users_(\d+)/, async (ctx) => {
  const currentPage = parseInt(ctx.match[1]);
  const offset = (currentPage - 1) * 20; 

  try {
    logger.info(`Previous users process started for page ${currentPage}`);
    await ctx.answerCbQuery();

    const users = await new Promise((resolve, reject) => {
      db.all(`SELECT user_id FROM users LIMIT 20 OFFSET ${offset}`, [], (err, users) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar user:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar user.*');
        }
        resolve(users);
      });
    });

    const totalUsers = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM users', [], (err, row) => {
        if (err) {
          logger.error('❌ Kesalahan saat menghitung total user:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat menghitung total user.*');
        }
        resolve(row.count);
      });
    });

    const keyboard = [];
    for (let i = 0; i < users.length; i += 2) {
      const row = [];
      const username1 = await getUsernameById(users[i].user_id);
      row.push({
        text: username1 || users[i].user_id,
        callback_data: `add_saldo_${users[i].user_id}`
      });
      if (i + 1 < users.length) {
        const username2 = await getUsernameById(users[i + 1].user_id);
        row.push({
          text: username2 || users[i + 1].user_id,
          callback_data: `add_saldo_${users[i + 1].user_id}`
        });
      }
      keyboard.push(row);
    }

    const replyMarkup = {
      inline_keyboard: [...keyboard]
    };

    const navigationButtons = [];
    if (currentPage > 0) {
      navigationButtons.push([{
        text: '⬅️ Back',
        callback_data: `prev_users_${currentPage - 1}`
      }]);
    }
    if (offset + 20 < totalUsers) {
      navigationButtons.push([{
        text: '➡️ Next',
        callback_data: `next_users_${currentPage}`
      }]);
    }

    replyMarkup.inline_keyboard.push(...navigationButtons);

    await ctx.editMessageReplyMarkup(replyMarkup);
  } catch (error) {
    logger.error('❌ Kesalahan saat memproses previous users:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});
bot.action('editserver_limit_ip', async (ctx) => {
  try {
    logger.info('Edit server limit IP process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_limit_ip_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('📊 *Silakan pilih server untuk mengedit limit IP:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit limit IP server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});
bot.action('editserver_batas_create_akun', async (ctx) => {
  try {
    logger.info('Edit server batas create akun process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_batas_create_akun_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('📊 *Silakan pilih server untuk mengedit batas create akun:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit batas create akun server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});
bot.action('editserver_total_create_akun', async (ctx) => {
  try {
    logger.info('Edit server total create akun process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_total_create_akun_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('📊 *Silakan pilih server untuk mengedit total create akun:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit total create akun server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});
bot.action('editserver_quota', async (ctx) => {
  try {
    logger.info('Edit server quota process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_quota_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('📊 *Silakan pilih server untuk mengedit quota:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit quota server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});
bot.action('editserver_auth', async (ctx) => {
  try {
    logger.info('Edit server auth process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server, domain, auth FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], (err, servers) => {
        if (err) {
          logger.error('? Kesalahan saat mengambil daftar server:', err.message);
          return reject('*PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('*PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const listText = servers
      .map((server) => `? ID ${server.id} - ${server.nama_server} (${server.domain}) | auth saat ini: ${server.auth || '-'}`)
      .join('\n');

    userState[ctx.chat.id] = { step: 'edit_auth_by_text' };

    await ctx.reply(
      `*Edit Auth via Ketik Pesan*\n\n` +
      `${listText}\n\n` +
      `Kirim format:\n` +
      `\`<id_server> <auth_baru>\`\n` +
      `Contoh: \`12 myNewAuth123\`\n\n` +
      `Ketik *batal* untuk membatalkan.`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    logger.error('? Kesalahan saat memulai proses edit auth server:', error);
    await ctx.reply(`? *${error}*`, { parse_mode: 'Markdown' });
  }
});

bot.action('editserver_harga', async (ctx) => {
  try {
    logger.info('Edit server harga process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_harga_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('💰 *Silakan pilih server untuk mengedit harga:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit harga server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});


bot.action('editserver_harga_reseller', async (ctx) => {
  try {
    logger.info('Edit server harga reseller process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], (err, servers) => {
        if (err) {
          logger.error('Kesalahan saat mengambil daftar server:', err.message);
          return reject('PERHATIAN! Terjadi kesalahan saat mengambil daftar server.');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('PERHATIAN! Tidak ada server yang tersedia untuk diedit.', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: 'edit_harga_reseller_' + server.id
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('Silakan pilih server untuk mengedit harga reseller:', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('Kesalahan saat memulai proses edit harga reseller server:', error);
    await ctx.reply(String(error), { parse_mode: 'Markdown' });
  }
});

bot.action('editserver_domain', async (ctx) => {
  try {
    logger.info('Edit server domain process started');
    await ctx.answerCbQuery();

    db.all('SELECT id, nama_server, domain FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], async (err, servers) => {
      if (err) {
        logger.error('Kesalahan saat mengambil daftar server:', err.message);
        return ctx.reply('Terjadi kesalahan saat mengambil daftar server.');
      }

      if (!servers || servers.length === 0) {
        return ctx.reply('Tidak ada server yang tersedia untuk diedit.');
      }

      userState[ctx.chat.id] = {
        step: 'edit_domain_pick_server'
      };

      const listText = servers
        .map((server) => '- ID ' + server.id + ': ' + (server.nama_server || '-') + ' (' + (server.domain || '-') + ')')
        .join('\n');

      await ctx.reply(
        'Edit domain server.\n\n' +
        'Daftar server:\n' + listText + '\n\n' +
        'Ketik ID server yang ingin diedit.\n' +
        'Ketik batal untuk membatalkan.'
      );
    });
  } catch (error) {
    logger.error('Kesalahan saat memulai proses edit domain server:', error);
    await ctx.reply('Terjadi kesalahan saat memulai edit domain server.');
  }
});

bot.action('nama_server_edit', async (ctx) => {
  try {
    logger.info('Edit server nama process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server ORDER BY nama_server COLLATE NOCASE ASC', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_nama_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('🏷️ *Silakan pilih server untuk mengedit nama:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit nama server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});

bot.action(/edit_harga_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit harga server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_harga', serverId: serverId };

  await ctx.reply('💰 *Silakan masukkan harga server baru:*', {
    reply_markup: { inline_keyboard: keyboard_nomor_simple() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_harga_reseller_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info('User ' + ctx.from.id + ' memilih untuk mengedit harga reseller server dengan ID: ' + serverId);
  userState[ctx.chat.id] = { step: 'edit_harga_reseller', serverId: serverId };

  await ctx.reply('Silakan masukkan harga reseller server baru:', {
    reply_markup: { inline_keyboard: keyboard_nomor_simple() },
    parse_mode: 'Markdown'
  });
});

bot.action(/add_saldo_(\d+)/, async (ctx) => {
  const userId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk menambahkan saldo user dengan ID: ${userId}`);
  userState[ctx.chat.id] = { step: 'add_saldo', userId: userId };

  await ctx.reply('📊 *Silakan masukkan jumlah saldo yang ingin ditambahkan:*', {
    reply_markup: { inline_keyboard: keyboard_nomor_simple() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_batas_create_akun_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit batas create akun server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_batas_create_akun', serverId: serverId };

  await ctx.reply('📊 *Silakan masukkan batas create akun server baru:*', {
    reply_markup: { inline_keyboard: keyboard_nomor_simple() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_total_create_akun_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit total create akun server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_total_create_akun', serverId: serverId };

  await ctx.reply('📊 *Silakan masukkan total create akun server baru:*', {
    reply_markup: { inline_keyboard: keyboard_nomor_simple() },
    parse_mode: 'Markdown'
  });
});

bot.action(/edit_total_batas_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const serverId = ctx.match[1];
  userState[ctx.chat.id] = { step: 'edit_total_batas_input', serverId };
  await ctx.reply(
    'Kirim format: <total_create_akun> <batas_create_akun>\nContoh: 10 50',
    { parse_mode: 'Markdown' }
  );
});

bot.action(/set_server_full_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const serverId = ctx.match[1];
  db.get('SELECT batas_create_akun FROM Server WHERE id = ?', [serverId], (err, row) => {
    if (err || !row) {
      return ctx.reply('❌ Gagal mengambil data server.');
    }
    db.run(
      'UPDATE Server SET total_create_akun = ? WHERE id = ?',
      [row.batas_create_akun, serverId],
      function (err2) {
        if (err2) {
          logger.error('❌ Gagal set server penuh:', err2.message);
          return ctx.reply('❌ Gagal menjadikan server penuh.');
        }
        ctx.reply(`✅ Server berhasil dijadikan penuh (total = ${row.batas_create_akun}).`);
      }
    );
  });
});

bot.action(/activate_server_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const serverId = ctx.match[1];
  userState[ctx.chat.id] = { step: 'edit_total_batas_input', serverId };
  await ctx.reply(
    'Kirim format: <total_create_akun> <batas_create_akun>\nContoh: 10 50',
    { parse_mode: 'Markdown' }
  );
});
bot.action(/edit_limit_ip_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit limit IP server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_limit_ip', serverId: serverId };

  await ctx.reply('📊 *Silakan masukkan limit IP server baru:*', {
    reply_markup: { inline_keyboard: keyboard_nomor_simple() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_quota_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit quota server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_quota', serverId: serverId };

  await ctx.reply('📊 *Silakan masukkan quota server baru:*', {
    reply_markup: { inline_keyboard: keyboard_nomor_simple() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_auth_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit auth server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_auth', serverId: serverId };

  await ctx.reply('🌐 *Silakan masukkan auth server baru:*', {
    reply_markup: { inline_keyboard: keyboard_full() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_domain_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit domain server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_domain', serverId: serverId };

  await ctx.reply('🌐 *Silakan masukkan domain server baru:*', {
    reply_markup: { inline_keyboard: keyboard_full() },
    parse_mode: 'Markdown'
  });
});

bot.action(/edit_nama_(\d+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const serverId = ctx.match[1];

    // Simpan state agar menunggu input nama baru
    userState[ctx.chat.id] = {
      step: "edit_nama_input",
      serverId: serverId
    };

    logger.info(`Admin ${ctx.chat.id} memilih server ID ${serverId} untuk edit nama`);

    await ctx.reply(
      `✏️ *Silakan ketik nama baru untuk server ID ${serverId}:*`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    logger.error("❌ Error edit nama:", err);
    ctx.reply("⚠️ Terjadi kesalahan saat memproses permintaan.");
  }
});

bot.action(/confirm_delete_server_(\d+)/, async (ctx) => {
  try {
    db.run('DELETE FROM Server WHERE id = ?', [ctx.match[1]], function(err) {
      if (err) {
        logger.error('Error deleting server:', err.message);
        return ctx.reply('⚠️ *PERHATIAN! Terjadi kesalahan saat menghapus server.*', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
        logger.info('Server tidak ditemukan');
        return ctx.reply('⚠️ *PERHATIAN! Server tidak ditemukan.*', { parse_mode: 'Markdown' });
      }

      logger.info(`Server dengan ID ${ctx.match[1]} berhasil dihapus`);
      ctx.reply('✅ *Server berhasil dihapus.*', { parse_mode: 'Markdown' });
    });
  } catch (error) {
    logger.error('Kesalahan saat menghapus server:', error);
    await ctx.reply('❌ *GAGAL! Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.*', { parse_mode: 'Markdown' });
  }
});

bot.action(/server_detail_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  try {
    const server = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
        if (err) {
          logger.error('⚠️ Kesalahan saat mengambil detail server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil detail server.*');
        }
        resolve(server);
      });
    });

    if (!server) {
      logger.info('⚠️ Server tidak ditemukan');
      return ctx.reply('⚠️ *PERHATIAN! Server tidak ditemukan.*', { parse_mode: 'Markdown' });
    }

    const serverDetails = `📋 *Detail Server* 📋\n\n` +
      `🌐 *Domain:* \`${server.domain}\`\n` +
      `🔑 *Auth:* \`${server.auth}\`\n` +
      `🏷️ *Nama Server:* \`${server.nama_server}\`\n` +
      `📊 *Quota:* \`${server.quota}\`\n` +
      `📶 *Limit IP:* \`${server.iplimit}\`\n` +
      `🔢 *Batas Create Akun:* \`${server.batas_create_akun}\`\n` +
      `📋 *Total Create Akun:* \`${server.total_create_akun}\`\n` +
      `💵 *Harga:* \`Rp ${server.harga}\`\n\n`;

    await ctx.reply(serverDetails, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('⚠️ Kesalahan saat mengambil detail server:', error);
    await ctx.reply('⚠️ *Terjadi kesalahan saat mengambil detail server.*', { parse_mode: 'Markdown' });
  }
});

bot.on('callback_query', async (ctx) => {
  const userId = ctx.from.id;
  const data = ctx.callbackQuery.data;
  const userStateData = userState[ctx.chat.id];

  if (global.depositState && global.depositState[userId] && global.depositState[userId].action === 'request_amount') {
    await handleDepositState(ctx, userId, data);
  } 
  // ✅ TAMBAHKAN HANDLER UNTUK confirm_final
  else if (data === 'confirm_final') {
    try {
      await ctx.answerCbQuery();
      
      if (global.depositState && global.depositState[userId]) {
        const amount = global.depositState[userId].amount;
        await processDeposit(ctx, amount);
      } else {
        await ctx.reply('❌ Sesi top-up sudah expired. Silakan mulai lagi.');
      }
    } catch (error) {
      logger.error('Error confirm_final:', error);
      await ctx.reply('❌ Terjadi kesalahan. Silakan coba lagi.');
    }
    return;
  }
  else if (userStateData) {
    switch (userStateData.step) {
      // ❌ HAPUS/MODIFIKASI bagian addsaldo_userid dan addsaldo_amount 
      // karena itu seharusnya di text handler, tapi kalau sudah berjalan biarin saja
      
      // ✅ TAMBAHKAN CASE UNTUK CONFIRM FINAL DI STATE LAINNYA
      case 'confirm_final_topup':
        if (global.depositState && global.depositState[userId]) {
          const amount = global.depositState[userId].amount;
          await processDeposit(ctx, amount);
        }
        break;
        
      case 'edit_batas_create_akun':
        await handleEditBatasCreateAkun(ctx, userStateData, data);
        break;
      case 'edit_limit_ip':
        await handleEditiplimit(ctx, userStateData, data);
        break;
      case 'edit_quota':
        await handleEditQuota(ctx, userStateData, data);
        break;
      case 'edit_auth':
        await handleEditAuth(ctx, userStateData, data);
        break;
      case 'edit_domain':
        await handleEditDomain(ctx, userStateData, data);
        break;
      case 'edit_harga':
        await handleEditHarga(ctx, userStateData, data);
        break;
      case 'edit_harga_reseller':
        await handleEditHargaReseller(ctx, userStateData, data);
        break;
      case 'edit_nama':
        await handleEditNama(ctx, userStateData, data);
        break;
      case 'edit_total_create_akun':
        await handleEditTotalCreateAkun(ctx, userStateData, data);
        break;
      default:
        await ctx.answerCbQuery();
        break;
    }
  } else {
    await ctx.answerCbQuery();
  }
});


async function handleDepositState(ctx, userId, data) {
  let currentAmount = global.depositState[userId].amount;

  if (data === 'delete') {
    currentAmount = currentAmount.slice(0, -1);
  } else if (data === 'confirm') {
    if (currentAmount.length === 0) {
      return await ctx.answerCbQuery('⚠️ Jumlah tidak boleh kosong!', { show_alert: true });
    }
    
    const amountNum = parseInt(currentAmount);
    
    if (amountNum < 2000) {
      return await ctx.answerCbQuery('⚠️ Jumlah minimal adalah 2.000!', { show_alert: true });
    }
    
    // Hitung admin fee FIXED
    const adminFee = amountNum < 5000 ? 200 : 150;
    const totalAmount = amountNum + adminFee;
    
    const bonusCfg = loadTopupBonusSetting();
    let bonusInfo = '';
    if (bonusCfg.enabled && amountNum >= 10000) {
      let bonusPercent = 0;
      if (amountNum <= 49000) bonusPercent = bonusCfg.range_10_40;
      else if (amountNum <= 79000) bonusPercent = bonusCfg.range_50_70;
      else bonusPercent = bonusCfg.range_70_100;
      bonusInfo = `\n🎁 *Bonus:* ${bonusPercent}% (akan ditambah ke saldo jika pembayaran sukses)\n`;
    }

    // TAMPILAN BARU YANG PROFESIONAL
    const confirmMessage = 
`💳 *KONFIRMASI TOP-UP*

┏━━━━━━━━━━━━━━━━━━━┓
📋 PERKIRAAN BIAYA
┗━━━━━━━━━━━━━━━━━━━┛

💰 *Nominal Top-up:* Rp ${amountNum.toLocaleString('id-ID')}
${bonusInfo}💸 *Biaya Admin:* Rp 100 - Rp 200 (random)
🎯 *Perkiraan Total:* Rp ${(amountNum + 100).toLocaleString('id-ID')} - Rp ${(amountNum + 200).toLocaleString('id-ID')}

┏━━━━━━━━━━━━━━━━━━━┓
🎲 SISTEM KEAMANAN
┗━━━━━━━━━━━━━━━━━━━┛

• Admin fee RANDOM 100-200
• Setiap transaksi unik
• Mencegah duplikasi pembayaran

┏━━━━━━━━━━━━━━━━━━━┓
⚠️ PENTING
┗━━━━━━━━━━━━━━━━━━━┛

• Total final akan ada di QRIS
• Transfer HARUS sesuai nominal di QRIS
• Sistem otomatis verifikasi

_Lanjutkan untuk melihat QRIS dengan nominal final?_`;

    await ctx.editMessageText(confirmMessage, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ LANJUT BAYAR', callback_data: 'confirm_final' }],
          [{ text: '❌ BATAL', callback_data: 'send_main_menu' }]
        ]
      }
    });
    
    global.depositState[userId].amount = currentAmount;
    global.depositState[userId].action = 'confirm_final';
    return await ctx.answerCbQuery();
    
  } else {
    if (currentAmount.length < 12) {
      currentAmount += data;
    } else {
      return await ctx.answerCbQuery('⚠️ Jumlah maksimal adalah 12 digit!', { show_alert: true });
    }
  }

  global.depositState[userId].amount = currentAmount;
  const newMessage = `💰 *Masukkan jumlah saldo yang ingin ditambahkan:*\n\nJumlah: *Rp ${currentAmount || '0'}*`;
  
  try {
    if (newMessage !== ctx.callbackQuery.message.text) {
      await ctx.editMessageText(newMessage, {
        reply_markup: { inline_keyboard: keyboard_nomor() },
        parse_mode: 'Markdown'
      });
    } else {
      await ctx.answerCbQuery();
    }
  } catch (error) {
    await ctx.answerCbQuery();
    logger.error('Error editing message:', error.message);
  }
}

async function handleAddSaldo(ctx, userStateData, data) {
  let currentSaldo = userStateData.saldo || '';

  if (data === 'backspace') {
    currentSaldo = currentSaldo.slice(0, -1);
  } else if (data === 'confirm') {
    if (currentSaldo.length === 0) {
      return await ctx.answerCbQuery('⚠️ *Jumlah saldo tidak boleh kosong!*', { show_alert: true });
    }

    try {
      await updateUserBalance(userStateData.userId, currentSaldo);
      ctx.reply(`✅ *Saldo user berhasil ditambahkan.*\n\n📄 *Detail Saldo:*\n- Jumlah Saldo: *Rp ${currentSaldo}*`, { parse_mode: 'Markdown' });
    } catch (error) {
      ctx.reply('❌ *Terjadi kesalahan saat menambahkan saldo user.*', { parse_mode: 'Markdown' });
    }
    delete userState[ctx.chat.id];
    return;
  } else if (data === 'cancel') {
    delete userState[ctx.chat.id];
      return await ctx.answerCbQuery('⚠️ *Jumlah saldo tidak valid!*', { show_alert: true });
  } else {
    if (currentSaldo.length < 10) {
      currentSaldo += data;
    } else {
      return await ctx.answerCbQuery('⚠️ *Jumlah saldo maksimal adalah 10 karakter!*', { show_alert: true });
    }
  }

  userStateData.saldo = currentSaldo;
  const newMessage = `📊 *Silakan masukkan jumlah saldo yang ingin ditambahkan:*\n\nJumlah saldo saat ini: *${currentSaldo}*`;
    await ctx.editMessageText(newMessage, {
      reply_markup: { inline_keyboard: keyboard_nomor_simple() },
      parse_mode: 'Markdown'
    });
}

async function handleEditBatasCreateAkun(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'batasCreateAkun', 'batas create akun', 'UPDATE Server SET batas_create_akun = ? WHERE id = ?');
}

async function handleEditTotalCreateAkun(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'totalCreateAkun', 'total create akun', 'UPDATE Server SET total_create_akun = ? WHERE id = ?');
}

async function handleEditiplimit(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'iplimit', 'limit IP', 'UPDATE Server SET limit_ip = ? WHERE id = ?');
}

async function handleEditQuota(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'quota', 'quota', 'UPDATE Server SET quota = ? WHERE id = ?');
}

async function handleEditAuth(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'auth', 'auth', 'UPDATE Server SET auth = ? WHERE id = ?', keyboard_full);
}

async function handleEditDomain(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'domain', 'domain', 'UPDATE Server SET domain = ? WHERE id = ?', keyboard_full);
}

async function handleEditHarga(ctx, userStateData, data) {
  let currentAmount = userStateData.amount || '';

  if (data === 'delete') {
    currentAmount = currentAmount.slice(0, -1);
  } else if (data === 'confirm') {
    if (currentAmount.length === 0) {
      return await ctx.answerCbQuery('⚠️ *Jumlah tidak boleh kosong!*', { show_alert: true });
    }
    const hargaBaru = parseFloat(currentAmount);
    if (isNaN(hargaBaru) || hargaBaru <= 0) {
      return ctx.reply('❌ *Harga tidak valid. Masukkan angka yang valid.*', { parse_mode: 'Markdown' });
    }
    try {
      await updateServerField(userStateData.serverId, hargaBaru, 'UPDATE Server SET harga = ? WHERE id = ?');
      ctx.reply(`✅ *Harga server berhasil diupdate.*\n\n📄 *Detail Server:*\n- Harga Baru: *Rp ${hargaBaru}*`, { parse_mode: 'Markdown' });
    } catch (err) {
      ctx.reply('❌ *Terjadi kesalahan saat mengupdate harga server.*', { parse_mode: 'Markdown' });
    }
    delete userState[ctx.chat.id];
    return;
  } else {
    if (!/^\d+$/.test(data)) {
      return await ctx.answerCbQuery('⚠️ *Hanya angka yang diperbolehkan!*', { show_alert: true });
    }
    if (currentAmount.length < 12) {
      currentAmount += data;
    } else {
      return await ctx.answerCbQuery('⚠️ *Jumlah maksimal adalah 12 digit!*', { show_alert: true });
    }
  }

  userStateData.amount = currentAmount;
  const newMessage = `💰 *Silakan masukkan harga server baru:*\n\nJumlah saat ini: *Rp ${currentAmount}*`;
  if (newMessage !== ctx.callbackQuery.message.text) {
    await ctx.editMessageText(newMessage, {
      reply_markup: { inline_keyboard: keyboard_nomor_simple() },
      parse_mode: 'Markdown'
    });
  }
}

async function handleEditHargaReseller(ctx, userStateData, data) {
  let currentAmount = userStateData.amount || '';

  if (data === 'delete') {
    currentAmount = currentAmount.slice(0, -1);
  } else if (data === 'confirm') {
    if (currentAmount.length === 0) {
      return await ctx.answerCbQuery('Jumlah tidak boleh kosong.', { show_alert: true });
    }
    const hargaBaru = parseFloat(currentAmount);
    if (isNaN(hargaBaru) || hargaBaru <= 0) {
      return ctx.reply('Harga reseller tidak valid. Masukkan angka yang valid.', { parse_mode: 'Markdown' });
    }
    try {
      await updateServerField(userStateData.serverId, hargaBaru, 'UPDATE Server SET harga_reseller = ? WHERE id = ?');
      ctx.reply('Harga reseller server berhasil diupdate.\n\nDetail Server:\n- Harga Reseller Baru: Rp ' + hargaBaru, { parse_mode: 'Markdown' });
    } catch (err) {
      ctx.reply('Terjadi kesalahan saat mengupdate harga reseller server.', { parse_mode: 'Markdown' });
    }
    delete userState[ctx.chat.id];
    return;
  } else {
    if (!/^\d+$/.test(data)) {
      return await ctx.answerCbQuery('Hanya angka yang diperbolehkan.', { show_alert: true });
    }
    if (currentAmount.length < 12) {
      currentAmount += data;
    } else {
      return await ctx.answerCbQuery('Jumlah maksimal adalah 12 digit.', { show_alert: true });
    }
  }

  userStateData.amount = currentAmount;
  const newMessage = 'Silakan masukkan harga reseller server baru:\n\nJumlah saat ini: Rp ' + currentAmount;
  if (newMessage !== ctx.callbackQuery.message.text) {
    await ctx.editMessageText(newMessage, {
      reply_markup: { inline_keyboard: keyboard_nomor_simple() },
      parse_mode: 'Markdown'
    });
  }
}

async function handleEditNama(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'name', 'nama server', 'UPDATE Server SET nama_server = ? WHERE id = ?', keyboard_full);
}

async function handleEditField(ctx, userStateData, data, field, fieldName, query, keyboardBuilder) {
  let currentValue = userStateData[field] || '';

  if (data === 'delete') {
    currentValue = currentValue.slice(0, -1);
  } else if (data === 'confirm') {
    if (currentValue.length === 0) {
      return await ctx.answerCbQuery(`⚠️ *${fieldName} tidak boleh kosong!*`, { show_alert: true });
    }
    try {
      await updateServerField(userStateData.serverId, currentValue, query);
      ctx.reply(`✅ *${fieldName} server berhasil diupdate.*\n\n📄 *Detail Server:*\n- ${fieldName.charAt(0).toUpperCase() + fieldName.slice(1)}: *${currentValue}*`, { parse_mode: 'Markdown' });
    } catch (err) {
      ctx.reply(`❌ *Terjadi kesalahan saat mengupdate ${fieldName} server.*`, { parse_mode: 'Markdown' });
    }
    delete userState[ctx.chat.id];
    return;
  } else {
    if (!/^[a-zA-Z0-9.-]+$/.test(data)) {
      return await ctx.answerCbQuery(`⚠️ *${fieldName} tidak valid!*`, { show_alert: true });
    }
    if (currentValue.length < 253) {
      currentValue += data;
    } else {
      return await ctx.answerCbQuery(`⚠️ *${fieldName} maksimal adalah 253 karakter!*`, { show_alert: true });
    }
  }

  userStateData[field] = currentValue;
  const newMessage = `📊 *Silakan masukkan ${fieldName} server baru:*\n\n${fieldName.charAt(0).toUpperCase() + fieldName.slice(1)} saat ini: *${currentValue}*`;
  if (newMessage !== ctx.callbackQuery.message.text) {
    await ctx.editMessageText(newMessage, {
      reply_markup: { inline_keyboard: (keyboardBuilder ? keyboardBuilder() : keyboard_nomor_simple()) },
      parse_mode: 'Markdown'
    });
  }
}
async function updateUserSaldo(userId, saldo) {
  return new Promise((resolve, reject) => {
    db.run('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', [saldo, userId], function (err) {
      if (err) {
        logger.error('⚠️ Kesalahan saat menambahkan saldo user:', err.message);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

async function updateServerField(serverId, value, query) {
  return new Promise((resolve, reject) => {
    db.run(query, [value, serverId], function (err) {
      if (err) {
        logger.error(`⚠️ Kesalahan saat mengupdate ${fieldName} server:`, err.message);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

global.depositState = {};
global.pendingDeposits = {};
let lastRequestTime = 0;
const requestInterval = 1000; 

db.all('SELECT * FROM pending_deposits WHERE status = "pending"', [], (err, rows) => {
  if (err) {
    logger.error('Gagal load pending_deposits:', err.message);
    return;
  }
  rows.forEach(row => {
    const createdAt = row.timestamp || Date.now();
    global.pendingDeposits[row.unique_code] = {
      amount: row.amount,
      originalAmount: row.original_amount,
      userId: row.user_id,
      timestamp: row.timestamp,
      status: row.status || 'pending',
      qrMessageId: row.qr_message_id,
      createdAt,
      expiresAt: createdAt + (5 * 60 * 1000)
    };
  });
  logger.info('Pending deposit loaded:', Object.keys(global.pendingDeposits).length);
});

/*
    const qris = new QRISPayment({
    merchantId: MERCHANT_ID,
    apiKey: API_KEY,
    baseQrString: DATA_QRIS,
    logoPath: 'logo.png'
});
*/
function generateRandomNumber(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Ganti fungsi processDeposit dengan versi yang lebih sederhana
async function processDeposit(ctx, amount) {
  const currentTime = Date.now();
  
  if (currentTime - lastRequestTime < requestInterval) {
    await ctx.editMessageText('⚠️ *Terlalu banyak permintaan. Silakan tunggu sebentar sebelum mencoba lagi.*', { parse_mode: 'Markdown' });
    return;
  }

  lastRequestTime = currentTime;
  const userId = ctx.from.id;
  
  // CEK BATAS TRANSAKSI PENDING
  const userPendingCount = Object.values(global.pendingDeposits)
    .filter(d => d.userId === userId && d.status === 'pending').length;
  
  if (userPendingCount >= 2) {
    await ctx.editMessageText(
      '⚠️ *Anda memiliki 2 transaksi pending yang belum dibayar.*\n\n' +
      'Silakan selesaikan pembayaran yang ada terlebih dahulu.',
      { 
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali ke Menu', callback_data: 'send_main_menu' }]] }
      }
    );
    delete global.depositState[userId];
    return;
  }

  const amountNum = Number(amount);
  
  if (amountNum < 2000) {
    await ctx.editMessageText(
      '❌ *Minimal top-up Rp 2.000!*\n\nSilakan masukkan nominal yang valid.',
      { 
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🔄 Coba Lagi', callback_data: 'topup_saldo' }]] }
      }
    );
    delete global.depositState[userId];
    return;
  }
  
  try {
    // GENERATE NOMINAL UNIK
    const feeResult = await generateUniqueFee(amountNum, userId);
    const finalAmount = feeResult.finalAmount;
    const adminFee = feeResult.adminFee;
    
    // GENERATE REFERENCE
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const uniqueCode = `TOPUP-${userId}-${timestamp}-${randomSuffix}`;
    const referenceId = `REF-${timestamp}-${randomSuffix}`;

    // BUAT QRIS
    const urlQr = DATA_QRIS;
    if (!RAJASERVER_API_KEY) {
      throw new Error('RAJASERVER_API_KEY belum diisi di .vars.json');
    }
    const bayar = await axios.get(
      `https://api.rajaserverpremium.web.id/orderkuota/createpayment?apikey=${encodeURIComponent(RAJASERVER_API_KEY)}&amount=${finalAmount}&codeqr=${urlQr}&reference=${referenceId}`,
      { timeout: 15000 }
    );
    
    if (bayar.data.status !== 'success') {
      throw new Error('QRIS failed: ' + JSON.stringify(bayar.data));
    }

    const qrImageUrl = bayar.data.result.imageqris?.url;
    if (!qrImageUrl || qrImageUrl.includes('undefined')) {
      throw new Error('Invalid QR URL');
    }

    // DOWNLOAD QR
    const qrResponse = await axios.get(qrImageUrl, { responseType: 'arraybuffer', timeout: 15000 });
    const qrBuffer = Buffer.from(qrResponse.data);

    // KIRIM KE USER DENGAN INSTRUKSI SIMPLE
    const caption = 
`💳 *INSTRUKSI PEMBAYARAN*

💰 *TOP-UP:* Rp ${amountNum.toLocaleString('id-ID')}
🎲 *ADMIN FEE:* Rp ${adminFee.toLocaleString('id-ID')}
💵 *TOTAL BAYAR:* Rp ${finalAmount.toLocaleString('id-ID')}

📌 *CARA BAYAR:*
1. Scan QR Code di atas
2. Transfer TEPAT Rp ${finalAmount.toLocaleString('id-ID')}
3. Jangan kurang atau lebih!
4. Sistem otomatis verifikasi dalam 1-2 menit

⚠️ *PERHATIAN:*
• QR Code berlaku 5 menit
• Transfer harus sesuai nominal di atas
• Saldo otomatis bertambah setelah terdeteksi

🆔 *Referensi:* \`${referenceId}\`
👤 *User ID:* \`${userId}\``;
    
    const qrMessage = await ctx.replyWithPhoto({ source: qrBuffer }, { caption: caption, parse_mode: 'Markdown' });

    // HAPUS PESAN SEBELUMNYA
    try { await ctx.deleteMessage(); } catch (e) { /* ignore */ }

    // SIMPAN KE MEMORY - SIMPLE STRUCTURE
    global.pendingDeposits[uniqueCode] = {
      amount: finalAmount,           // Nominal yang harus ditransfer
      originalAmount: amountNum,     // Nominal top-up (tanpa admin fee)
      adminFee: adminFee,
      userId: userId,
      timestamp: Date.now(),         // Waktu pembuatan QR
      referenceId: referenceId,
      status: 'pending',
      qrMessageId: qrMessage.message_id,
      createdAt: Date.now(),         // Untuk expired check
      expiresAt: Date.now() + (5 * 60 * 1000) // 5 menit dari sekarang
    };
    db.run(
  `INSERT INTO pending_deposits 
   (unique_code, user_id, amount, original_amount, timestamp, status, qr_message_id)
   VALUES (?, ?, ?, ?, ?, ?, ?)`, // 👈 7 PARAMS
  [
    uniqueCode, 
    userId, 
    finalAmount, 
    amountNum, 
    Date.now(),     // timestamp
    'pending',      // status
    qrMessage.message_id  // qr_message_id
  ],
  (err) => { 
    if (err) logger.error('❌ Save error:', err.message);
    else logger.info(`✅ Saved: ${uniqueCode}`);
  }
);

    delete global.depositState[userId];
    logger.info(`✅ QR sent to ${userId}, amount: ${finalAmount}, ref: ${referenceId}`);

  } catch (error) {
    logger.error('❌ Deposit error:', error.message);
    
    await ctx.editMessageText(
      '❌ *GAGAL MEMBUAT PEMBAYARAN*\n\n' + error.message.substring(0, 100) + '...\n\nSilakan coba lagi.',
      { 
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Coba Lagi', callback_data: 'topup_saldo' }],
            [{ text: '🔙 Kembali', callback_data: 'send_main_menu' }]
          ]
        }
      }
    );
    
    delete global.depositState[userId];
  }
}

// =================== POLLING MUTASI BANK ===================
let lastPollTime = 0;
let lastPollErrorTime = 0;
const POLL_INTERVAL = 10000; // Poll setiap 10 detik
const POLL_ERROR_INTERVAL = 60000; // log error maksimal 1 menit sekali

async function pollBankMutations() {
  const now = Date.now();
  
  if (!loadTopupAutoSetting()) {
    return;
  }

  // Rate limiting polling
  if (now - lastPollTime < POLL_INTERVAL) {
    return;
  }
  
  lastPollTime = now;
  
  try {
    // Ambil semua deposit yang masih pending
    const pendingDeposits = Object.entries(global.pendingDeposits)
      .filter(([_, deposit]) => deposit.status === 'pending');
    
    if (pendingDeposits.length === 0) {
      return;
    }
    
    logger.info(`🔍 Polling ${pendingDeposits.length} pending deposits`);
    
    // Ambil mutasi dari API
    const data = buildPayload();
    const resultcek = await axios.post(API_URL, data, { 
      headers, 
      timeout: 10000 
    });
    
    const responseText = resultcek.data;
    const blocks = responseText.split('------------------------').filter(Boolean);
    
    // Parse mutasi dengan cara sederhana
    const mutations = [];
    for (const block of blocks) {
      try {
        const kreditMatch = block.match(/Kredit\s*:\s*([\d.,]+)/);
        if (kreditMatch) {
          const kreditStr = kreditMatch[1].replace(/\./g, '');
          const kredit = parseInt(kreditStr);
          
          if (!isNaN(kredit)) {
            mutations.push({
              amount: kredit,
              raw: block.substring(0, 200) // Simpan sedikit untuk debug
            });
          }
        }
      } catch (e) {
        // Skip block yang error
      }
    }
    
    logger.info(`📊 Found ${mutations.length} mutations in bank statement`);
    
    // PROSES SETIAP DEPOSIT PENDING
    for (const [uniqueCode, deposit] of pendingDeposits) {
      try {
        // CEK EXPIRED
        const expiresAt = deposit.expiresAt || (deposit.timestamp ? deposit.timestamp + (5 * 60 * 1000) : 0);
        if (expiresAt && now > expiresAt) {
          logger.info(`⏰ Deposit expired: ${uniqueCode}`);
          await handleExpiredDeposit(deposit, uniqueCode);
          continue;
        }
        
        // CARI MUTASI YANG COCOK NOMINALNYA
        const matchingMutation = mutations.find(m => m.amount === deposit.amount);
        
        if (matchingMutation) {
          logger.info(`✅ Found matching mutation for ${uniqueCode}: ${deposit.amount}`);
          await processSuccessfulPayment(deposit, uniqueCode);
        } else {
          // Tidak ada mutasi yang cocok, lanjut polling berikutnya
          if (Math.random() < 0.1) { // Log 10% dari waktu untuk mengurangi spam
            logger.debug(`⏳ Still waiting for payment: ${uniqueCode}, Amount: ${deposit.amount}`);
          }
        }
        
      } catch (error) {
        logger.error(`❌ Error processing deposit ${uniqueCode}:`, error.message);
      }
    }
    
  } catch (error) {
    const errMsg = error && error.message ? error.message : String(error);
    const nowErr = Date.now();
    if (nowErr - lastPollErrorTime > POLL_ERROR_INTERVAL) {
      logger.error('❌ Polling error:', errMsg);
      lastPollErrorTime = nowErr;
    }
    // Tidak perlu throw error, polling akan coba lagi nanti
  }
}

// =================== FUNGSI BANTUAN ===================

async function processSuccessfulPayment(deposit, uniqueCode) {
  logger.info(`💰 Processing successful payment: ${uniqueCode}`);
  
  try {
    const bonusConfig = loadTopupBonusSetting();
    const amountBase = deposit.originalAmount;
    let bonusPercent = 0;
    if (bonusConfig.enabled) {
      if (amountBase >= 10000 && amountBase <= 49000) {
        bonusPercent = bonusConfig.range_10_40;
      } else if (amountBase >= 50000 && amountBase <= 79000) {
        bonusPercent = bonusConfig.range_50_70;
      } else if (amountBase >= 80000) {
        bonusPercent = bonusConfig.range_70_100;
      }
    }
    const bonusAmount = Math.floor((amountBase * bonusPercent) / 100);
    const totalCredit = amountBase + bonusAmount;

    // 1. UPDATE SALDO USER (HANYA NOMINAL ASLI + BONUS)
    db.run('UPDATE users SET saldo = saldo + ? WHERE user_id = ?',
      [totalCredit, deposit.userId],
      async (err) => {
        if (err) {
          logger.error('❌ Error update saldo:', err.message);
          return;
        }
        
        logger.info(`✅ Saldo updated: +${totalCredit} for user ${deposit.userId} (bonus ${bonusAmount})`);
        
        // 2. SIMPAN TRANSAKSI
        db.run(
          'INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, ?, ?, ?)',
          [deposit.userId, deposit.originalAmount, 'deposit', deposit.referenceId, Date.now()],
          (err) => {
            if (err) {
              logger.error('❌ Error save transaction:', err.message);
            } else {
              logger.info(`✅ Transaction saved: ${deposit.referenceId}`);
            }
          }
        );
        if (bonusAmount > 0) {
          const bonusRef = `${deposit.referenceId}-bonus`;
          db.run(
            'INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, ?, ?, ?)',
            [deposit.userId, bonusAmount, 'deposit_bonus', bonusRef, Date.now()],
            (err) => {
              if (err) logger.error('❌ Error save bonus transaction:', err.message);
            }
          );
        }
        
        // 3. HAPUS DARI PENDING
        delete global.pendingDeposits[uniqueCode];
        db.run('DELETE FROM pending_deposits WHERE unique_code = ?', [uniqueCode]);
        
        // 4. AMBIL SALDO TERBARU
        db.get('SELECT saldo FROM users WHERE user_id = ?', [deposit.userId], async (err, row) => {
          const currentBalance = row ? row.saldo : totalCredit;
          
          // 5. KIRIM NOTIFIKASI KE USER
          try {
            await bot.telegram.sendMessage(
              deposit.userId,
              `🎉 *PEMBAYARAN BERHASIL!*\n\n` +
              `💰 Top-up: Rp ${deposit.originalAmount.toLocaleString('id-ID')}\n` +
              (bonusAmount > 0 ? `🎁 Bonus: Rp ${bonusAmount.toLocaleString('id-ID')}\n` : '') +
              `💵 Total bayar: Rp ${deposit.amount.toLocaleString('id-ID')}\n` +
              `🏦 Saldo sekarang: Rp ${currentBalance.toLocaleString('id-ID')}\n\n` +
              `🆔 Referensi: \`${deposit.referenceId}\`\n` +
              `⏰ ${new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' })}`,
              { parse_mode: 'Markdown' }
            );
            
            // 6. HAPUS QR MESSAGE
            if (deposit.qrMessageId) {
              try {
                await bot.telegram.deleteMessage(deposit.userId, deposit.qrMessageId);
              } catch (e) {
                // Pesan mungkin sudah dihapus
              }
            }
            
            // 7. NOTIFIKASI KE GRUP ADMIN
            if (GROUP_ID_NUM) {
              try {
                await bot.telegram.sendMessage(
                  GROUP_ID_NUM,
                  `💰 *TOP-UP BERHASIL*\n\n` +
                  `👤 User: \`${deposit.userId}\`\n` +
                  `💸 Amount: Rp ${deposit.originalAmount.toLocaleString('id-ID')}\n` +
                  (bonusAmount > 0 ? `🎁 Bonus: Rp ${bonusAmount.toLocaleString('id-ID')}\n` : '') +
                  `🏦 New Balance: Rp ${currentBalance.toLocaleString('id-ID')}\n` +
                  `🆔 Ref: ${deposit.referenceId.substring(0, 12)}...`,
                  { parse_mode: 'Markdown' }
                );
              } catch (e) {
                // Ignore group notification errors
              }
            }
            
            logger.info(`✅ Payment completed for ${uniqueCode}`);
            
          } catch (notifyError) {
            logger.error('❌ Notification error:', notifyError.message);
          }
        });
      }
    );
    
  } catch (error) {
    logger.error(`❌ Payment processing error for ${uniqueCode}:`, error.message);
  }
}

// 🔧 SIMPLIFIKASI:
async function handleExpiredDeposit(deposit, uniqueCode) {
  try {
    // 1. HAPUS QR DARI CHAT
    if (deposit.qrMessageId) {
      try {
        await bot.telegram.deleteMessage(deposit.userId, deposit.qrMessageId);
      } catch (e) {}
    }
    
    // 2. KIRIM NOTIF EXPIRED
    await bot.telegram.sendMessage(
      deposit.userId,
      '❌ *QR CODE EXPIRED*\n\n' +
      `QR Code sudah tidak berlaku (5 menit).\n` +
      `💰 Nominal: Rp ${deposit.originalAmount.toLocaleString('id-ID')}\n` +
      `💵 Total: Rp ${deposit.amount.toLocaleString('id-ID')}\n\n` +
      `Silakan buat permintaan top-up baru.`+
      `Jika sudah terlanjur bayar diatas 5 menit dan saldo ga masuk hubungi admin lewat WA: ${getAdminWhatsappNumber() || '-'} atau Telegram: ${getAdminTelegramUsername()}`,
      { parse_mode: 'Markdown' }
    );
    
    // 3. HAPUS DARI MEMORY & DB
    delete global.pendingDeposits[uniqueCode];
    db.run('DELETE FROM pending_deposits WHERE unique_code = ?', [uniqueCode]);
    
    logger.info(`🗑️ Expired cleaned: ${uniqueCode}`);
    
  } catch (error) {
    logger.error(`❌ Error expired:`, error.message);
  }
}

////////
function cleanupStuckDeposits() {
  const now = Date.now();
  const fiveMinutesAgo = now - (5 * 60 * 1000);
  
  Object.keys(global.pendingDeposits).forEach(uniqueCode => {
    const deposit = global.pendingDeposits[uniqueCode];
    
    // Jika deposit dibuat > 5 menit yang lalu dan masih "generating"
    if (deposit.createdAt && deposit.createdAt < fiveMinutesAgo && 
        deposit.status === 'generating') {
      logger.info(`🧹 Cleaning up stuck deposit: ${uniqueCode}`);
      delete global.pendingDeposits[uniqueCode];
      
      // Hapus dari database juga
      db.run('DELETE FROM pending_deposits WHERE unique_code = ?', [uniqueCode]);
    }
  });
}

// Tambahkan ke interval cleanup
setInterval(cleanupStuckDeposits, 60000); // Setiap 1 menit

function keyboard_abc() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const buttons = [];
  for (let i = 0; i < alphabet.length; i += 3) {
    const row = alphabet.slice(i, i + 3).split('').map(char => ({
      text: char,
      callback_data: char
    }));
    buttons.push(row);
  }
  buttons.push([{ text: '🔙 Hapus', callback_data: 'delete' }, { text: '✅ Konfirmasi', callback_data: 'confirm' }]);
  buttons.push([{ text: '🔙 Kembali ke Menu Utama', callback_data: 'send_main_menu' }]);
  return buttons;
}

function keyboard_nomor() {
  const buttons = [
    [{ text: '1', callback_data: '1' }, { text: '2', callback_data: '2' }, { text: '3', callback_data: '3' }],
    [{ text: '4', callback_data: '4' }, { text: '5', callback_data: '5' }, { text: '6', callback_data: '6' }],
    [{ text: '7', callback_data: '7' }, { text: '8', callback_data: '8' }, { text: '9', callback_data: '9' }],
    [{ text: '0', callback_data: '0' }, { text: '00', callback_data: '00' }],
    [{ text: '🔙 Hapus', callback_data: 'delete' }, { text: '✅ Konfirmasi', callback_data: 'confirm' }],
    [
      { text: '💰 5rb', callback_data: '5000' },
      { text: '💰 10rb', callback_data: '10000' },
      { text: '💰 20rb', callback_data: '20000' }
    ],
    [{ text: '🔙 Kembali ke Menu', callback_data: 'send_main_menu' }]
  ];
  return buttons;
}

function keyboard_nomor_simple() {
  const buttons = [
    [{ text: '1', callback_data: '1' }, { text: '2', callback_data: '2' }, { text: '3', callback_data: '3' }],
    [{ text: '4', callback_data: '4' }, { text: '5', callback_data: '5' }, { text: '6', callback_data: '6' }],
    [{ text: '7', callback_data: '7' }, { text: '8', callback_data: '8' }, { text: '9', callback_data: '9' }],
    [{ text: '0', callback_data: '0' }, { text: '00', callback_data: '00' }],
    [{ text: 'Hapus', callback_data: 'delete' }, { text: 'Konfirmasi', callback_data: 'confirm' }],
    [{ text: 'Kembali ke Menu', callback_data: 'send_main_menu' }]
  ];
  return buttons;
}

function keyboard_full() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const buttons = [];
  for (let i = 0; i < alphabet.length; i += 3) {
    const row = alphabet.slice(i, i + 3).split('').map(char => ({
      text: char,
      callback_data: char
    }));
    buttons.push(row);
  }
  buttons.push([{ text: '🔙 Hapus', callback_data: 'delete' }, { text: '✅ Konfirmasi', callback_data: 'confirm' }]);
  buttons.push([{ text: '🔙 Kembali ke Menu Utama', callback_data: 'send_main_menu' }]);
  return buttons;
}

async function getUserBalance(userId) {
  return new Promise((resolve, reject) => {
    db.get("SELECT saldo FROM users WHERE user_id = ?", [userId], function(err, row) {
        if (err) {
        logger.error('⚠️ Kesalahan saat mengambil saldo user:', err.message);
          reject(err);
      } else {
        resolve(row ? row.saldo : 0);
        }
    });
  });
}

// ✅ JALANKAN CLEANUP SETIAP 5 MENIT
setInterval(cleanupOldDeposits, 5 * 60 * 1000);
// Cleanup polling broadcast lama setiap 12 jam
setInterval(cleanupOldBroadcastPolls, 12 * 60 * 60 * 1000);


// ✅ FUNGSI CLEANUP PROCESSED TRANSACTIONS
function cleanupProcessedTransactions() {
  if (!global.processedTransactions || global.processedTransactions.size === 0) {
    return;
  }
  
  const oldSize = global.processedTransactions.size;
  
  // Hapus semua yang sudah lebih dari 24 jam
  // (Karena kita sudah set timeout di setiap add, ini backup saja)
  global.processedTransactions.clear();
  
  if (oldSize > 0) {
    logger.info(`🧹 Cleaned ${oldSize} processed transactions from cache`);
  }
}


function cleanupOldDeposits() {
  const now = Date.now();
  const oneHourAgo = now - (60 * 60 * 1000);
  let cleanedCount = 0;
  
  Object.keys(global.pendingDeposits).forEach(uniqueCode => {
    const deposit = global.pendingDeposits[uniqueCode];
    
    // ✅ CEK: Deposit lebih dari 1 jam dan masih pending
    if (deposit.createdAt && deposit.createdAt < oneHourAgo && deposit.status === 'pending') {
      logger.info(`🧹 Cleaning up old deposit: ${uniqueCode}, Age: ${now - deposit.createdAt}ms`);
      
      // ✅ HAPUS PESAN QR CODE JIKA ADA
      if (deposit.qrMessageId) {
        try {
          bot.telegram.deleteMessage(deposit.userId, deposit.qrMessageId).catch(() => {});
        } catch (e) {
          // Ignore error jika pesan sudah dihapus
        }
      }
      
      // ✅ KIRIM NOTIFIKASI KE USER (OPSIONAL)
      try {
        bot.telegram.sendMessage(
          deposit.userId,
          '📝 *Pengingat*\n\n' +
          'Deposit Anda yang belum dibayar telah dihapus dari sistem.\n' +
          'Silakan buat deposit baru jika masih ingin top-up.',
          { parse_mode: 'Markdown' }
        ).catch(() => {}); // Ignore jika user block bot
      } catch (e) {
        // Ignore error
      }
      
      delete global.pendingDeposits[uniqueCode];
      cleanedCount++;
      
      // ✅ HAPUS DARI DATABASE
      db.run('DELETE FROM pending_deposits WHERE unique_code = ?', 
        [uniqueCode], 
        (err) => {
          if (err) logger.error('Error cleaning up old deposit:', err.message);
        }
      );
    }
  });
  
  if (cleanedCount > 0) {
    logger.info(`🧹 Cleaned ${cleanedCount} old pending deposits`);
  }
}

// =================== JALANKAN POLLING ===================

// Jalankan polling setiap 10 detik
setInterval(pollBankMutations, 10000);

// Jalankan cleanup setiap jam
setInterval(cleanupOldDeposits, 60 * 60 * 1000);

// Jalankan polling segera setelah startup
setTimeout(pollBankMutations, 5000);

// Jalankan setiap 6 jam
setInterval(cleanupProcessedTransactions, 6 * 60 * 60 * 1000);

// Jalankan cleanup setiap 5 menit
setInterval(cleanupOldDeposits, 5 * 60 * 1000);


// ✅ FUNGSI UNTUK GENERATE RANDOM FEE YANG UNIK
async function generateUniqueFee(baseAmount, userId, existingDeposits) {
  logger.info(`🎲 Generating unique fee for user ${userId}, base: ${baseAmount}`);
  
  // Ambil semua amount yang sedang pending (dalam 24 jam)
  const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
  const recentDeposits = existingDeposits
    .filter(d => d.createdAt > twentyFourHoursAgo && d.status === 'pending');
  
  const recentAmounts = recentDeposits.map(d => d.amount);
  
  logger.info(`   Found ${recentAmounts.length} recent pending amounts`);
  
  // Tampilkan amounts yang sudah ada untuk debugging
  if (recentAmounts.length > 0) {
    logger.info(`   Existing amounts: ${recentAmounts.join(', ')}`);
  }
  
  let attempts = 0;
  const maxAttempts = 20; // Naikkan dari 15 ke 20
  let adminFee, finalAmount;
  let foundUnique = false;
  
  // Coba generate amount unik
  while (attempts < maxAttempts && !foundUnique) {
    attempts++;
    
    // Generate random fee 100-200 dengan variasi lebih banyak
    adminFee = Math.floor(Math.random() * 101) + 100;
    
    // Tambahkan random adjustment kecil (0-99) untuk lebih unik
    const randomAdjustment = Math.floor(Math.random() * 100);
    finalAmount = baseAmount + adminFee + randomAdjustment;
    
    logger.info(`   Attempt ${attempts}: ${baseAmount} + ${adminFee} + ${randomAdjustment} = ${finalAmount}`);
    
    // Cek apakah amount ini unik
    if (!recentAmounts.includes(finalAmount)) {
      // Double check di database (pending deposits) dengan query lebih spesifik
      try {
        const dbCheck = await new Promise((resolve) => {
          db.get(
            `SELECT COUNT(*) as count FROM pending_deposits 
             WHERE amount = ? 
             AND created_at > ? 
             AND status = 'pending'`,
            [finalAmount, twentyFourHoursAgo],
            (err, row) => {
              if (err) {
                logger.error('❌ DB check error:', err.message);
                resolve(0);
              } else {
                resolve(row ? row.count : 0);
              }
            }
          );
        });
        
        if (dbCheck === 0) {
          foundUnique = true;
          logger.info(`   ✅ Found unique amount after ${attempts} attempts`);
          break;
        } else {
          logger.info(`   ❌ Amount ${finalAmount} exists in database, trying again...`);
        }
      } catch (dbError) {
        logger.error('❌ Error checking database:', dbError.message);
      }
    } else {
      logger.info(`   ❌ Amount ${finalAmount} exists in recent amounts, trying again...`);
    }
    
    // Tunggu sedikit sebelum coba lagi
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  
  // JIKA MASIH TIDAK UNIK SETELAH MAX ATTEMPTS
  if (!foundUnique) {
    logger.warn(`⚠️ Could not find unique amount after ${maxAttempts} attempts`);
    
    // Gunakan algoritma fallback yang garansi unik
    // Gabungkan timestamp + user ID untuk garansi keunikan
    const timestampPart = Date.now() % 10000; // 0-9999
    const userIdPart = userId % 100; // 0-99
    const microAdjustment = (timestampPart + userIdPart) % 100; // 0-99
    
    adminFee = Math.floor(Math.random() * 101) + 100;
    finalAmount = baseAmount + adminFee + microAdjustment;
    
    logger.info(`   🔄 Using guaranteed unique amount: ${baseAmount} + ${adminFee} + ${microAdjustment} = ${finalAmount}`);
    logger.info(`      Timestamp: ${timestampPart}, UserID: ${userIdPart}, Adjustment: ${microAdjustment}`);
  }
  
  // FINAL VALIDATION - PASTIKAN TIDAK ADA DUPLIKAT
  const finalCheck = await new Promise((resolve) => {
    db.get(
      `SELECT COUNT(*) as count FROM pending_deposits 
       WHERE amount = ? 
       AND created_at > ? 
       AND status = 'pending'`,
      [finalAmount, Date.now() - (24 * 60 * 60 * 1000)],
      (err, row) => {
        resolve(err ? 1 : (row ? row.count : 0));
      }
    );
  });
  
  if (finalCheck > 0) {
    logger.error(`❌ CRITICAL: Generated amount ${finalAmount} STILL EXISTS in database!`);
    
    // EMERGENCY FALLBACK - PASTI UNIK
    const emergencyAdjustment = Date.now() % 1000;
    finalAmount = baseAmount + 150 + emergencyAdjustment; // 150 sebagai fixed fee
    
    logger.info(`   🚨 EMERGENCY: Using emergency amount: ${finalAmount}`);
  }
  
  logger.info(`   🎯 Final generated: ${baseAmount} + ${adminFee} = ${finalAmount} (unique: ${foundUnique})`);
  
  return {
    adminFee: adminFee,
    finalAmount: finalAmount,
    isUnique: foundUnique || true, // Selalu return true untuk force continue
    attempts: attempts,
    note: foundUnique ? 'Random unique' : 'Guaranteed unique'
  };
}

//////

// ✅ FUNGSI UNTUK GENERATE RANDOM FEE YANG BENAR-BENAR UNIK
function generateUniqueFee(baseAmount, userId) {
  // Generate random fee 100-200
  let adminFee = Math.floor(Math.random() * 101) + 100;
  let finalAmount = baseAmount + adminFee;
  let attempts = 0;
  
  // Cek apakah amount ini sudah pernah dipakai (pending)
  const isAmountUsed = Object.values(global.pendingDeposits)
    .some(d => d.amount === finalAmount);
  
  // Jika sudah dipakai, coba generate ulang (max 5x)
  while (isAmountUsed && attempts < 5) {
    adminFee = Math.floor(Math.random() * 101) + 100;
    finalAmount = baseAmount + adminFee;
    attempts++;
    
    const newCheck = Object.values(global.pendingDeposits)
      .some(d => d.amount === finalAmount);
    
    if (!newCheck) break;
  }
  
  // Jika masih tabrakan setelah 5x, tambahkan timestamp
  if (attempts >= 5) {
    const timestamp = Date.now() % 100; // 0-99
    adminFee = Math.floor(Math.random() * 101) + 100;
    finalAmount = baseAmount + adminFee + timestamp;
    logger.warn(`⚠️ Using timestamp adjustment for unique amount`);
  }
  
  return {
    adminFee: adminFee,
    finalAmount: finalAmount,
    attempts: attempts
  };
}

// ✅ FUNGSI UNTUK VALIDATE PAYMENT SECURITY
function validatePaymentSecurity(deposit, matchingTransaction) {
  const securityChecks = [];
  
  // 1. Check timing
  const paymentDelay = matchingTransaction.timestamp - deposit.createdAt;
  securityChecks.push({
    name: 'Timing',
    passed: paymentDelay >= 15000 && paymentDelay <= 270000,
    details: `${Math.round(paymentDelay/1000)}s (15s-4.5m)`
  });
  
  // 2. Check amount match (EXACT)
  securityChecks.push({
    name: 'Amount Match',
    passed: matchingTransaction.kredit === deposit.amount,
    details: `Expected: ${deposit.amount}, Got: ${matchingTransaction.kredit}`
  });
  
  // 3. Check reference in description (optional)
  if (matchingTransaction.deskripsi && matchingTransaction.deskripsi.trim() !== '-') {
    const descLower = matchingTransaction.deskripsi.toLowerCase();
    const hasReference = descLower.includes(deposit.referenceId.toLowerCase()) ||
                        descLower.includes(String(deposit.userId));
    securityChecks.push({
      name: 'Reference Match',
      passed: hasReference,
      details: hasReference ? 'Reference found' : 'No reference found'
    });
  }
  
  // 4. Check if transaction already processed
  const transactionKey = `${matchingTransaction.timestamp}_${deposit.amount}_${deposit.userId}`;
  const alreadyProcessed = global.processedTransactions && 
                          global.processedTransactions.has(transactionKey);
  securityChecks.push({
    name: 'Duplicate Check',
    passed: !alreadyProcessed,
    details: alreadyProcessed ? 'Already processed' : 'New transaction'
  });
  
  // Log all security checks
  logger.info(`🔒 Payment Security Check:`);
  securityChecks.forEach(check => {
    const status = check.passed ? '✅' : '❌';
    logger.info(`   ${status} ${check.name}: ${check.details}`);
  });
  
  // Return true if all mandatory checks pass
  const mandatoryChecks = securityChecks.filter(c => 
    c.name !== 'Reference Match' // Reference match optional
  );
  
  return mandatoryChecks.every(c => c.passed);
}

// ✅ FUNGSI UNTUK SEND PAYMENT SUMMARY
async function sendPaymentSummary(deposit, transactionDetails) {
  try {
    const summary = `
📊 *PAYMENT SUMMARY*

👤 User: ${deposit.userId}
💰 Base Amount: ${deposit.originalAmount}
🎲 Admin Fee: ${deposit.amount - deposit.originalAmount}
💵 Total: ${deposit.amount}
🆔 Reference: ${deposit.referenceId}

⏰ Timing:
• QR Created: ${new Date(deposit.createdAt).toLocaleTimeString('id-ID')}
• Payment Time: ${new Date(transactionDetails.timestamp).toLocaleTimeString('id-ID')}
• Delay: ${Math.round((transactionDetails.timestamp - deposit.createdAt)/1000)}s

🔍 Transaction Details:
• Amount: ${transactionDetails.kredit}
• Time: ${new Date(transactionDetails.timestamp).toLocaleString('id-ID')}
• Description: ${transactionDetails.deskripsi?.substring(0, 50) || 'N/A'}...

✅ Status: VERIFIED & COMPLETED
    `.trim();
    
    // Kirim ke admin/log channel jika ada
    if (GROUP_ID_NUM) {
      await bot.telegram.sendMessage(GROUP_ID_NUM, summary, { parse_mode: 'Markdown' });
    }
    
    logger.info(`📋 Payment summary logged`);
  } catch (error) {
    logger.error('❌ Error sending payment summary:', error.message);
  }
}

async function recordAccountTransaction(userId, type, amount = 0, action = 'other') {
  return new Promise((resolve, reject) => {
    const referenceId = `account-${action}-${type}-${userId}-${Date.now()}`;
    db.run(
      'INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, ?, ?, ?)',
      [userId, amount, type, referenceId, Date.now()],
      async (err) => {
        if (err) {
          logger.error('Error recording account transaction:', err.message);
          reject(err);
        } else {
          // ✅ TAMBAH: Notifikasi ke grup admin jika user adalah reseller
          try {
            const isReseller = await isUserReseller(userId);
            if (isReseller && GROUP_ID_NUM && action === 'create') {
              // Cek bulan ini sudah berapa akun
              const now = new Date();
              const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
              
              db.get(
                `SELECT COUNT(*) as count FROM transactions 
                 WHERE user_id = ? AND timestamp >= ? 
                 AND type IN ('ssh', 'vmess', 'vless', 'trojan', 'shadowsocks', 'zivpn', 'udp_http')
                 AND reference_id NOT LIKE 'account-trial-%'`,
                [userId, firstDay.getTime()],
                (err, row) => {
                  if (!err && row) {
                    const totalThisMonth = row.count;
                    
                    // Ambil info user
                    bot.telegram.getChat(userId).then(userInfo => {
                      const username = userInfo.username ? `@${userInfo.username}` : 
                                     (userInfo.first_name || `User ${userId}`);
                      
                      bot.telegram.sendMessage(
                        GROUP_ID_NUM,
                        `🛍️ *RESELLER TRANSAKSI*\n\n` +
                        `👤 Reseller: ${username}\n` +
                        `📦 Tipe: ${type.toUpperCase()}\n` +
                        `📊 Total Bulan Ini: ${totalThisMonth} akun\n` +
                        `⏰ ${now.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' })}`,
                        { parse_mode: 'Markdown' }
                      ).catch(e => logger.error('Gagal kirim notif reseller:', e.message));
                    }).catch(() => {
                      // Skip jika tidak bisa dapatkan info user
                    });
                  }
                }
              );
            }
          } catch (e) {
            // Skip error notifikasi
          }
          
          resolve();
        }
      }
    );
  });
}

// =============================
// 📦 AUTO BACKUP DATABASE 24 JAM
// =============================

const schedule = require('node-schedule');

const resellerRule = new schedule.RecurrenceRule();
resellerRule.tz = 'Asia/Jakarta';
resellerRule.dayOfMonth = 1;
resellerRule.hour = 0;
resellerRule.minute = 10;

schedule.scheduleJob('reseller_monthly_check', resellerRule, async () => {
  try {
    const now = new Date();
    if (now.getDate() !== 1) {
      logger.warn('Skip reseller check (bukan tanggal 1).');
      return;
    }
    const year = now.getFullYear();
    const month = now.getMonth();
    const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
    const end = new Date(year, month, 0, 23, 59, 59, 999);
    const periodLabel = start.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
    await evaluateResellerTermsForPeriod(start.getTime(), end.getTime(), periodLabel);
  } catch (err) {
    logger.error('Error menjalankan evaluasi syarat reseller:', err.message);
  }
});

const resellerWarningRule = new schedule.RecurrenceRule();
resellerWarningRule.tz = 'Asia/Jakarta';
resellerWarningRule.hour = 0;
resellerWarningRule.minute = 10;

schedule.scheduleJob('reseller_monthly_warning', resellerWarningRule, async () => {
  try {
    const now = new Date();
    const nextMonthFirst = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const msPerDay = 24 * 60 * 60 * 1000;
    const daysUntilFirst = Math.ceil((nextMonthFirst - now) / msPerDay);

    if (daysUntilFirst !== 5) return;

    const terms = loadResellerTerms();
    const resellers = listResellersSync();
    if (resellers.length === 0) return;

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const periodLabel = monthStart.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });

    for (const resellerId of resellers) {
      const stats = await getResellerStatsForPeriod(resellerId, monthStart.getTime(), now.getTime());
      if (stats.topup >= terms.min_topup) continue;

      const remaining = Math.max(0, terms.min_topup - stats.topup);
      const message =
        `⏰ *PENGINGAT SYARAT RESELLER*\n\n` +
        `Periode: ${periodLabel}\n` +
        `Top up saat ini: ${formatRupiah(stats.topup)}\n` +
        `Minimal top up: ${formatRupiah(terms.min_topup)}\n` +
        `Sisa target: ${formatRupiah(remaining)}\n\n` +
        `Sisa waktu: 5 hari lagi menuju reset bulan.\n` +
        `Segera penuhi target agar status reseller tidak turun.`;

      try {
        await bot.telegram.sendMessage(resellerId, message, { parse_mode: 'Markdown' });
      } catch (err) {
        logger.error('Gagal kirim notifikasi pengingat reseller:', err.message);
      }
    }
  } catch (err) {
    logger.error('Error menjalankan pengingat reseller:', err.message);
  }
});

const serverSyncRule = new schedule.RecurrenceRule();
serverSyncRule.tz = 'Asia/Jakarta';
serverSyncRule.minute = [0, 10, 20, 30, 40, 50];

schedule.scheduleJob('server_usage_sync_10m', serverSyncRule, async () => {
  try {
    const result = await syncServerUsageFromTunnel('every_10m');
    logger.info(
      `[SyncServer:every_10m] selesai. dicek=${result.checked}, berhasil=${result.updated}, gagal=${result.failed}, dilewati=${result.skipped}`
    );
  } catch (err) {
    logger.error(`[SyncServer:every_10m] gagal: ${err.message}`);
  }
});
const dbFile = path.join(__dirname, "sellvpn.db");
const autoBackupDir = path.join(__dirname, "auto_backup");

if (!fs.existsSync(autoBackupDir)) fs.mkdirSync(autoBackupDir);

// Fungsi kirim backup otomatis ke admin
function getNormalizedAdminIds() {
  if (Array.isArray(adminIds)) {
    return adminIds
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v) && v > 0);
  }

  if (typeof adminIds === 'string') {
    return adminIds
      .split(/[,\n\s]+/)
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isFinite(v) && v > 0);
  }

  const single = Number(adminIds);
  return Number.isFinite(single) && single > 0 ? [single] : [];
}

async function sendAutoBackup(filePath, preferredAdminId = null) {
  try {
    const admins = getNormalizedAdminIds();
    if (admins.length === 0) {
      logger.error('Tidak ada admin ID valid yang dikonfigurasi');
      return;
    }

    const targetAdminId = Number(preferredAdminId) > 0 ? Number(preferredAdminId) : admins[0];

    await bot.telegram.sendDocument(
      targetAdminId,
      { source: filePath },
      { caption: 'Backup otomatis database (setiap 24 jam)' }
    );

    logger.info('Backup otomatis terkirim ke admin: ' + targetAdminId);
  } catch (err) {
    logger.error('Gagal kirim backup otomatis:', {
      error: err.message,
      adminId: Number(preferredAdminId) > 0 ? Number(preferredAdminId) : 'none',
      code: err.response?.error_code
    });
  }
}

// Tambahkan error handler untuk bot
bot.catch((err, ctx) => {
  logger.error(`❌ Bot error: ${err.message}`);
  // Jika ini callback query error, coba handle gracefully
  if (ctx && ctx.updateType === 'callback_query') {
    try {
      ctx.answerCbQuery('⚠️ Terjadi kesalahan, coba lagi').catch(() => {});
    } catch (e) {
      // Ignore jika sudah expired
    }
  }
});

app.listen(port, async () => {
  logger.info(`🚀 Server berjalan di port ${port}`);
  
  // =================== VALIDASI AWAL ===================
  try {
    logger.info('🔧 Memeriksa konfigurasi pembayaran...');
    
    const { buildPayload } = require('./api-cekpayment-orkut');
    const qs = require('qs');
    const payload = buildPayload();
    const decoded = qs.parse(payload);
    
    // Cek credential default
    const isDefaultCredential = 
      decoded.username === 'yantoxxx' || 
      (decoded.token && decoded.token.includes('xxxxx')) ||
      decoded.username === 'AKUN_DEFAULT';
    
    if (isDefaultCredential) {
      logger.error('❌ ❌ ❌ PERINGATAN KRITIS! ❌ ❌ ❌');
      logger.error('Credential OrderKuota masih DEFAULT!');
      logger.error('User TIDAK BISA top-up otomatis!');
      logger.error(`Username: "${decoded.username}"`);
      logger.error(`Token: "${decoded.token ? decoded.token.substring(0, 30) + '...' : 'empty'}"`);
      
      // Nonaktifkan fitur topup otomatis
      bot.action('topup_saldo', async (ctx) => {
        await ctx.answerCbQuery();
        await ctx.reply(
          '❌ *TOP-UP OTOMATIS SEMENTARA TIDAK TERSEDIA*\n\n' +
          'Admin belum mengkonfigurasi sistem pembayaran.\n' +
          'Silakan hubungi admin untuk top-up manual via QRIS.\n\n' +
          `📞 Hubungi: ${getAdminTelegramUsername()}\n\n` +
          '_Admin sudah mendapatkan notifikasi untuk memperbaiki sistem._',
          { parse_mode: 'Markdown' }
        );
      });
      
      // Kirim notifikasi ke admin
// Di app.listen() - bagian yang kirim notifikasi ke admin:
const adminMessage = 
  `🚨 *PERINGATAN SISTEM PEMBAYARAN* 🚨\n\n` +
  `Credential OrderKuota masih DEFAULT!\n` +
  `User TIDAK BISA top-up otomatis.\n\n` +
  `📺 *Tutorial Ambil Credential:*\n` +
  `[🎬 Video Tutorial](https://drive.google.com/file/d/1ugR_N5gEtcLx8TDsf7ecTFqYY3zrlHn-/view)\n\n` +
  `📝 *Langkah Perbaikan:*\n` +
  `1. Tonton video tutorial\n` +
  `2. Edit file: \`api-cekpayment-orkut.js\`\n` +
  `3. Ganti username & token\n` +
  `4. Restart: \`pm2 restart app\`\n\n` +
  `🔧 Cek status: /checkpaymentconfig\n\n` +
  `⚠️ Fitur top-up otomatis dinonaktifkan sementara.`;      
      if (Array.isArray(adminIds)) {
        adminIds.forEach(adminId => {
          setTimeout(() => {
            bot.telegram.sendMessage(adminId, adminMessage, { 
              parse_mode: 'Markdown' 
            }).catch(() => {});
          }, 2000);
        });
      }
      
    } else {
      logger.info(`✅ Credential valid (username: ${decoded.username.substring(0, 3)}***)`);
    }
  } catch (error) {
    logger.error('❌ Gagal validasi payment config:', error.message);
  }
  // =================== END VALIDASI ===================
  
  // Fungsi untuk start bot dengan retry
  const startBot = async (retryCount = 0) => {
    try {
      logger.info('🔄 Memulai bot...');
      
      // Konfigurasi bot
      const botConfig = {
        dropPendingUpdates: true,
        allowedUpdates: ['message', 'callback_query'],
        handlerTimeout: 60000,
      };
      
      // Start bot
      await bot.launch(botConfig);
      logger.info('✅ Bot berhasil dimulai (Polling Mode)');
      
      // Set commands
      await bot.telegram.setMyCommands([
        { command: 'start', description: 'Mulai bot dan tampilkan menu utama' },
        { command: 'admin', description: 'Menu admin (khusus admin)' },
        { command: 'checkpaymentconfig', description: 'Cek status konfigurasi pembayaran' },
        { command: 'syncservernow', description: 'Sinkronisasi total akun server' }
      ]);
      logger.info('✅ Command menu berhasil diset.');
      
      // Enable graceful stop
      const stopBot = () => {
        logger.info('🛑 Stopping bot gracefully...');
        bot.stop();
        process.exit(0);
      };
      
      process.once('SIGINT', stopBot);
      process.once('SIGTERM', stopBot);
      
    } catch (error) {
      logger.error(`❌ Error saat memulai bot (Attempt ${retryCount + 1}):`, error.message);
      
      // Jika belum mencapai maksimal retry, coba lagi
      if (retryCount < 3) {
        const delay = Math.min(10000, 2000 * Math.pow(2, retryCount)); // Exponential backoff
        logger.info(`⏳ Akan mencoba lagi dalam ${delay/1000} detik...`);
        
        setTimeout(() => {
          startBot(retryCount + 1);
        }, delay);
      } else {
        logger.error('❌ Gagal memulai bot setelah 3 kali percobaan. Bot dimatikan.');
        process.exit(1);
      }
    }
  };
  
  // Mulai bot
  startBot();
  
  // Jalankan cleanup awal
  setTimeout(() => {
    logger.info('🚀 Running initial cleanup...');
    cleanupOldDeposits();
    cleanupOldBroadcastPolls();
  }, 10000);
});