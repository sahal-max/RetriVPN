const axios = require('axios');
const { exec } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sellvpn.db');

function isValidUsername(username) {
  return !(/\s/.test(username) || /[^a-zA-Z0-9]/.test(username));
}

function getServer(serverId) {
  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
      if (err || !server) return resolve(null);
      resolve(server);
    });
  });
}

function execJson(command) {
  return new Promise((resolve) => {
    exec(command, (_, stdout) => {
      try {
        resolve({ ok: true, data: JSON.parse(stdout) });
      } catch (e) {
        resolve({ ok: false, error: 'Format respon dari server tidak valid.', raw: stdout });
      }
    });
  });
}

function buildRenewMessage(title, s, withQuota = false) {
  let msg = `✅ *${title}*

🔄 Akun berhasil diperpanjang
────────────────────────────
👤 Username    : \`${s.username}\`
`;

  if (withQuota) {
    msg += `📦 Quota       : \`${s.quota === '0' ? 'Unlimited' : s.quota} GB\`
`;
  }

  msg += `📆 Masa Aktif  :
🕒 Dari         : \`${s.from || '-'}\`
🕒 Sampai       : \`${s.to || s.exp || '-'}\`
────────────────────────────

✨ Terima kasih telah memperpanjang layanan kami.
© Telegram Bots - 2025`;

  return msg;
}

async function renewByEndpoint({ username, exp, quota = 0, serverId, endpoint, title, withQuota = false }) {
  if (!isValidUsername(username)) {
    return '❌ Username tidak valid. Gunakan huruf/angka tanpa spasi.';
  }

  const server = await getServer(serverId);
  if (!server) {
    return '❌ Server tidak ditemukan. Silakan coba lagi.';
  }

  const webURL = `http://${server.domain}${endpoint}/${username}/${exp}`;
  const authToken = server.auth;

  const curlCommand = `curl -s -X PATCH "${webURL}" \
-H "Authorization: ${authToken}" \
-H "accept: application/json" \
-H "Content-Type: application/json" \
-d '{"kuota": ${quota}}'`;

  const result = await execJson(curlCommand);
  if (!result.ok) {
    return '❌ ' + result.error;
  }

  const d = result.data;
  if (d?.meta?.code !== 200 || !d.data) {
    const errMsg = d?.message || d?.meta?.message || JSON.stringify(d, null, 2);
    return `❌ Respons error:\n${errMsg}`;
  }

  return buildRenewMessage(title, d.data, withQuota);
}

async function renewssh(username, exp, limitip, serverId) {
  return renewByEndpoint({
    username,
    exp,
    quota: 0,
    serverId,
    endpoint: '/vps/renewsshvpn',
    title: 'Renew SSH Account Success',
    withQuota: false
  });
}

async function renewudphttp(username, exp, limitip, serverId) {
  return renewByEndpoint({
    username,
    exp,
    quota: 0,
    serverId,
    endpoint: '/vps/renewsshvpn',
    title: 'Renew UDP HTTP Custom Success',
    withQuota: false
  });
}

async function renewvmess(username, exp, quota, limitip, serverId) {
  return renewByEndpoint({
    username,
    exp,
    quota,
    serverId,
    endpoint: '/vps/renewvmess',
    title: 'Renew VMess Account Success',
    withQuota: true
  });
}

async function renewvless(username, exp, quota, limitip, serverId) {
  return renewByEndpoint({
    username,
    exp,
    quota,
    serverId,
    endpoint: '/vps/renewvless',
    title: 'Renew VLESS Account Success',
    withQuota: true
  });
}

async function renewtrojan(username, exp, quota, limitip, serverId) {
  return renewByEndpoint({
    username,
    exp,
    quota,
    serverId,
    endpoint: '/vps/renewtrojan',
    title: 'Renew TROJAN Account Success',
    withQuota: true
  });
}

async function renewshadowsocks(username, exp, quota, limitip, serverId) {
  if (!isValidUsername(username)) {
    return '❌ Username tidak valid. Gunakan huruf/angka tanpa spasi.';
  }

  const server = await getServer(serverId);
  if (!server) {
    return '❌ Server tidak ditemukan. Silakan coba lagi.';
  }

  const param = `:5888/renewshadowsocks?user=${username}&exp=${exp}&quota=${quota}&iplimit=${limitip}&auth=${server.auth}`;
  const url = `http://${server.domain}${param}`;

  try {
    const response = await axios.get(url);
    if (response.data?.status !== 'success') {
      return `❌ Terjadi kesalahan: ${response.data?.message || 'unknown'}`;
    }

    const data = response.data.data || {};
    return `✅ *RENEW SHADOWSOCKS PREMIUM*

🔹 Informasi Akun
────────────────────────────
👤 Username     : \`${username}\`
📆 Kadaluarsa   : \`${data.exp || '-'}\`
📦 Quota        : \`${data.quota || '-'}\`
📶 Batas IP     : \`${data.limitip || limitip} IP\`
────────────────────────────
✅ Akun ${username} berhasil diperbarui.`;
  } catch (error) {
    return '❌ Terjadi kesalahan saat memperbarui Shadowsocks. Silakan coba lagi nanti.';
  }
}

async function renewzivpn(username, exp, limitip, serverId) {
  return renewByEndpoint({
    username,
    exp,
    quota: 0,
    serverId,
    endpoint: '/vps/renewsshvpn',
    title: 'Renew ZIVPN Success',
    withQuota: false
  });
}

module.exports = {
  renewshadowsocks,
  renewtrojan,
  renewvless,
  renewvmess,
  renewssh,
  renewudphttp,
  renewzivpn
};