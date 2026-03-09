const axios = require('axios');
const { exec } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sellvpn.db');
async function createssh(username, password, exp, iplimit, serverId) {
  console.log(`Creating SSH account for ${username} with expiry ${exp} days, IP limit ${iplimit}, and password ${password}`);

  // Validasi username
  if (/\s/.test(username) || /[^a-zA-Z0-9]/.test(username)) {
    return '❌ Username tidak valid. Mohon gunakan hanya huruf dan angka tanpa spasi.';
  }

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
      if (err || !server) {
        console.error('❌ Error fetching server:', err?.message || 'server null');
        return resolve('❌ Server tidak ditemukan. Silakan coba lagi.');
      }

      const domain = server.domain;
      const param = `/vps/sshvpn`;
      const web_URL = `http://${domain}${param}`; // misalnya: http://idnusastb.domain.web.id/vps/sshvpn
      const AUTH_TOKEN = server.auth;
      const days = exp;
      const KUOTA = "0"; // jika perlu di-hardcode, bisa diubah jadi parameter juga
      const LIMIT_IP = iplimit;

      const curlCommand = `curl -s -X POST "${web_URL}" \
-H "Authorization: ${AUTH_TOKEN}" \
-H "Content-Type: application/json" \
-H "Accept: application/json" \
-d '{"expired":${days},"kuota":"${KUOTA}","limitip":"${LIMIT_IP}","password":"${password}","username":"${username}"}'`;

      exec(curlCommand, (_, stdout) => {
        let d;
        try {
          d = JSON.parse(stdout);
        } catch (e) {
          console.error('❌ Gagal parsing JSON:', e.message);
          console.error('🪵 Output:', stdout);
          return resolve('❌ Format respon dari server tidak valid.');
        }

        if (d?.meta?.code !== 200 || !d.data) {
          console.error('❌ Respons error:', d);
          const errMsg = d?.message || d?.meta?.message || JSON.stringify(d, null, 2);
          return resolve(`❌ Respons error:\n${errMsg}`);
        }

        const s = d.data;

        const msg = `
=============================
 *SSH ACCOUNT CREATED*
=============================

*[ SSH PREMIUM DETAILS ]*
-----------------------------
*SSH WS*       : \`${s.hostname}:80@${s.username}:${s.password}\`
*SSH SSL*      : \`${s.hostname}:443@${s.username}:${s.password}\`
*DNS SELOW*    : \`${s.hostname}:5300@${s.username}:${s.password}\`

*[ HOST INFORMATION ]*
-----------------------------
*Hostname*     : \`${s.hostname}\`
*Username*     : \`${s.username}\`
*Password*     : \`${s.password}\`
*Expiry Date*  : \`${s.exp}\`
*Expiry Time*  : \`${s.time}\`
*IP Limit*     : \`${LIMIT_IP === "0" ? "Unlimited" : LIMIT_IP}\`

*[ PORTS ]*
------------------------------
*TLS*          : \`${s?.port?.tls ?? '-'}\`
*Non-TLS*      : \`${s.port.none}\`
*OVPN TCP*     : \`${s.port.ovpntcp}\`
*OVPN UDP*     : \`${s.port.ovpnudp}\`
*SSH OHP*      : \`${s.port.sshohp}\`
*UDP Custom*   : \`${s.port.udpcustom}\`

*[ PAYLOAD WS ]*
------------------------------
\`GET wss://[host_port]/ HTTP/1.1[crlf]Host: [host_port][crlf]Upgrade: Websocket[crlf]Connection: Keep-Alive[crlf][crlf]\`

*[ PAYLOAD ENHANCED + SPLIT ]*
------------------------------
\`PATCH /ssh-ws HTTP/1.1[crlf]Host: [host][crlf]Host: www.google.com[crlf]Upgrade: websocket[crlf]Connection:
Upgrade[crlf]User-Agent: [ua][crlf][crlf][split]HTTP/1.1 200 OK[crlf][crlf]\`

*[ DOWNLOAD CONFIG ]*
------------------------------
http://${s.hostname}:81/myvpn-config.zip

------------------------------
*© Telegram Bots 1forcr - 2025*
*Terima kasih telah menggunakan layanan kami.*
`;

        return resolve(msg);
      });
    });
  });
}

async function createudphttp(username, password, exp, iplimit, serverId) {
  console.log(`Creating UDP HTTP Custom account for ${username} with expiry ${exp} days, IP limit ${iplimit}, and password ${password}`);

  if (/\s/.test(username) || /[^a-zA-Z0-9]/.test(username)) {
    return '❌ Username tidak valid. Mohon gunakan hanya huruf dan angka tanpa spasi.';
  }

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
      if (err || !server) {
        console.error('❌ Error fetching server:', err?.message || 'server null');
        return resolve('❌ Server tidak ditemukan. Silakan coba lagi.');
      }

      const domain = server.domain;
      const param = `/vps/sshvpn`;
      const web_URL = `http://${domain}${param}`;
      const AUTH_TOKEN = server.auth;
      const days = exp;
      const KUOTA = "0";
      const LIMIT_IP = iplimit;

      const curlCommand = `curl -s -X POST "${web_URL}" \
-H "Authorization: ${AUTH_TOKEN}" \
-H "Content-Type: application/json" \
-H "Accept: application/json" \
-d '{"expired":${days},"kuota":"${KUOTA}","limitip":"${LIMIT_IP}","password":"${password}","username":"${username}"}'`;

      exec(curlCommand, (_, stdout) => {
        let d;
        try {
          d = JSON.parse(stdout);
        } catch (e) {
          console.error('❌ Gagal parsing JSON:', e.message);
          console.error('🪵 Output:', stdout);
          return resolve('❌ Format respon dari server tidak valid.');
        }

        if (d?.meta?.code !== 200 || !d.data) {
          console.error('❌ Respons error:', d);
          const errMsg = d?.message || d?.meta?.message || JSON.stringify(d, null, 2);
          return resolve(`❌ Respons error:\n${errMsg}`);
        }

        const s = d.data;
        const port = '1-65535';
        const expired = s.exp || s.expired || s.to || 'N/A';
        const ipLimitText = LIMIT_IP === "0" ? "Unlimited" : LIMIT_IP;
        const copy = `${s.hostname}:${port}@${s.username}:${s.password}`;

        const msg = `*UDP HTTP CUSTOM ACCOUNT*

*Hostname*   : \`${s.hostname}\`
*Username*   : \`${s.username}\`
*Password*   : \`${s.password}\`
*Port*       : \`${port}\`
*Expired*    : \`${expired}\`
*IP Limit*   : \`${ipLimitText}\`

*Copy*:
\`${copy}\``;

        return resolve(msg);
      });
    });
  });
}
async function createvmess(username, exp, quota, limitip, serverId) {
  console.log(`Creating VMess account for ${username} with expiry ${exp} days, quota ${quota} GB, IP limit ${limitip}`);

  // Validasi username
  if (/\s/.test(username) || /[^a-zA-Z0-9]/.test(username)) {
    return '❌ Username tidak valid. Mohon gunakan hanya huruf dengan awalan tidak kapital dan angka tanpa spasi.';
  }

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
      if (err || !server) {
        console.error('❌ Error fetching server:', err?.message || 'server null');
        return resolve('❌ Server tidak ditemukan. Silakan coba lagi.');
      }

      const domain = server.domain;
      const param = `/vps/vmessall`;
      const web_URL = `http://${domain}${param}`; // contoh: http://idnusastb.domain.web.id/vps/vmess
      const AUTH_TOKEN = server.auth;
      const days = exp;
      const KUOTA = quota;
      const LIMIT_IP = limitip;

      const curlCommand = `curl -s -X POST "${web_URL}" \
-H "Authorization: ${AUTH_TOKEN}" \
-H "Content-Type: application/json" \
-H "Accept: application/json" \
-d '{"expired":${days},"kuota":"${KUOTA}","limitip":"${LIMIT_IP}","username":"${username}"}'`;

      exec(curlCommand, (_, stdout) => {
        let d;
        try {
          d = JSON.parse(stdout);
        } catch (e) {
          console.error('❌ Gagal parsing JSON:', e.message);
          console.error('🪵 Output:', stdout);
          return resolve('❌ Format respon dari server tidak valid.');
        }

        if (d?.meta?.code !== 200 || !d.data) {
          console.error('❌ Respons error:', d);
          const errMsg = d?.message || d?.meta?.message || JSON.stringify(d, null, 2);
          return resolve(`❌ Respons error:\n${errMsg}`);
        }

        const s = d.data;

        const remarks = s.remark || s.remarks || s.username || username;
        const city = s.city || s.kota || s.location || '-';
        const isp = s.isp || s.org || s.organization || '-';
        const pathWs = (s.path && (s.path.ws || s?.path?.stn ?? '-')) || s.path || '/vmess';
        const serviceName = s.serviceName || 'vmess';
        const pathUpgrade = s.path && (s.path.upgrade || s.path.up || s.path.upws) ? (s.path.upgrade || s.path.up || s.path.upws) : '/upvmess';
        const portTls = s.port?.tls || '-';
        const portNone = s.port?.none || '-';
        const portAny = s.port?.any || '-';
        const portGrpc = s.port?.grpc || '-';
        const linkTls = s.link?.tls || '-';
        const linkNone = s.link?.none || '-';
        const linkGrpc = s.link?.grpc || '-';
        const linkUpTls = s.link?.uptls || s.link?.upgrade_tls || s.link?.upgrade || '-';
        const linkUpNone = s.link?.upntls || s.link?.upgrade_none || s.link?.upgrade_ntls || '-';

        const msg =
`————————————————————————————————

           XRAY VMESS

—————————————————————————————————

VMESS

Remarks       : ${remarks}
Domain        : ${s.hostname}
Port TLS      : ${portTls},${portGrpc}
Port none TLS : ${portNone}
Port any      : ${portAny}
id            : ${s.uuid}
alterId       : 0
Security      : auto
network       : ws,grpc,upgrade
path ws       : ${pathWs}
serviceName   : ${serviceName}
path upgrade  : ${pathUpgrade}
limit         : ${LIMIT_IP === "0" ? "Unlimited" : LIMIT_IP}

————————————————————————————————
link TLS          : ${linkTls}
————————————————————————————————
link none TLS     : ${linkNone}
————————————————————————————————
link GRPC         : ${linkGrpc}
————————————————————————————————
link Upgrade TLS  : ${linkUpTls}
————————————————————————————————
link Upgrade nTLS : ${linkUpNone}
————————————————————————————————
Expired  :  ${s.expired || '-'}
————————————————————————————————`;

        return resolve(msg);
      });
    });
  });
}

async function createvless(username, exp, quota, limitip, serverId) {
  console.log(`Creating VLESS account for ${username} with expiry ${exp} days, quota ${quota} GB, limit IP ${limitip}`);

  // Validasi username
  if (/\s/.test(username) || /[^a-zA-Z0-9]/.test(username)) {
    return '❌ Username tidak valid. Mohon gunakan hanya huruf dan angka tanpa spasi.';
  }

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
      if (err || !server) {
        console.error('❌ Error fetching server:', err?.message || 'server null');
        return resolve('❌ Server tidak ditemukan. Silakan coba lagi.');
      }

      const domain = server.domain;
      const param = `/vps/vlessall`;
      const web_URL = `http://${domain}${param}`; // Contoh: http://domainmu.com/vps/vless
      const AUTH_TOKEN = server.auth;
      const days = exp;
      const KUOTA = quota;
      const LIMIT_IP = limitip;

      const curlCommand = `curl -s -X POST "${web_URL}" \
-H "Authorization: ${AUTH_TOKEN}" \
-H "Content-Type: application/json" \
-H "Accept: application/json" \
-d '{"expired":${days},"kuota":"${KUOTA}","limitip":"${LIMIT_IP}","username":"${username}"}'`;

      exec(curlCommand, (_, stdout) => {
        let d;
        try {
          d = JSON.parse(stdout);
        } catch (e) {
          console.error('❌ Gagal parsing JSON:', e.message);
          console.error('🪵 Output:', stdout);
          return resolve('❌ Format respon dari server tidak valid.');
        }

        if (d?.meta?.code !== 200 || !d.data) {
          console.error('❌ Respons error:', d);
          const errMsg = d?.message || d?.meta?.message || JSON.stringify(d, null, 2);
          return resolve(`❌ Respons error:\n${errMsg}`);
        }

        const s = d.data;

        const msg = `
=============================
        *VLESS ACCOUNT*
=============================

*[ VLESS DETAILS ]*
-----------------------------
*HOST*        : \`${s.hostname}\`
*PORT TLS*    : \`${s?.port?.tls ?? '-'}\`
*PORT NTLS*   : \`${s.port.none}\`
*UUID*        : \`${s.uuid}\`
*NETWORK*     : \`ws, grpc, upgrade\`
*PATH*        : \`${s?.path?.stn ?? '-'}\`
*EXPIRED*     : \`${s.expired}\` - \`${s.time}\`
*QUOTA*       : \`${KUOTA === "0" ? "Unlimited" : KUOTA} GB\`
*IP LIMIT*    : \`${LIMIT_IP === "0" ? "Unlimited" : LIMIT_IP} pengguna\`

*[ VLESS URL ]*
-----------------------------
TLS:
\`${s?.link?.tls ?? '-'}\`

Non-TLS:
\`${s.link.none}\`

gRPC:
\`${s.link.grpc}\`

Up TLS:
\`${s.link.uptls}\`

Up Non-TLS:
\`${s.link.upntls}\`

*[ HOST INFORMATION ]*
-----------------------------
*Domain*      : \`${s.hostname}\`
*SNI*         : \`${s.hostname}\`

*[ PORTS ]*
-----------------------------
*WS TLS*      : \`${s?.port?.tls ?? '-'}\`
*WS NTLS*     : \`${s.port.none}\`
*ANY PORT*    : \`${s.port.any}\`

*[ SUGGESTED SNI / BUG ]*
-----------------------------
\`${s.hostname}\`
\`www.google.com\`
\`www.bing.com\`

*[ DOWNLOAD CONFIG ]*
-----------------------------
http://${s.hostname}:81/vless-config.zip

-----------------------------
*© Telegram Bots 1forcr - 2025*
*Terima kasih telah menggunakan layanan kami.*
`;

        return resolve(msg);
      });
    });
  });
}
async function createtrojan(username, exp, quota, limitip, serverId) {
  console.log(`Creating Trojan account for ${username} with expiry ${exp} days, quota ${quota} GB, limit IP ${limitip}`);

  // Validasi username
  if (/\s/.test(username) || /[^a-zA-Z0-9]/.test(username)) {
    return '❌ Username tidak valid. Mohon gunakan hanya huruf dan angka tanpa spasi.';
  }

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
      if (err || !server) {
        console.error('❌ Error fetching server:', err?.message || 'server null');
        return resolve('❌ Server tidak ditemukan. Silakan coba lagi.');
      }

      const domain = server.domain;
      const param = `/vps/trojanall`;
      const web_URL = `http://${domain}${param}`; // contoh: http://domainmu.com/vps/trojan
      const AUTH_TOKEN = server.auth;
      const days = exp;
      const KUOTA = quota;
      const LIMIT_IP = limitip;

      const curlCommand = `curl -s -X POST "${web_URL}" \
-H "Authorization: ${AUTH_TOKEN}" \
-H "Content-Type: application/json" \
-H "Accept: application/json" \
-d '{"expired":${days},"kuota":"${KUOTA}","limitip":"${LIMIT_IP}","username":"${username}"}'`;

      exec(curlCommand, (_, stdout) => {
        let d;
        try {
          d = JSON.parse(stdout);
        } catch (e) {
          console.error('❌ Gagal parsing JSON:', e.message);
          console.error('🪵 Output:', stdout);
          return resolve('❌ Format respon dari server tidak valid.');
        }

        if (d?.meta?.code !== 200 || !d.data) {
          console.error('❌ Respons error:', d);
          const errMsg = d?.message || d?.meta?.message || JSON.stringify(d, null, 2);
          return resolve(`❌ Respons error:\n${errMsg}`);
        }

        const s = d.data;

        const msg = `
=============================
        *TROJAN ACCOUNT*
=============================

*[ TROJAN DETAILS ]*
-----------------------------
*HOST*        : \`${s.hostname}\`
*PORT TLS*    : \`${s?.port?.tls ?? '-'}\`
*PORT NTLS*   : \`${s.port.none}\`
*KEY*         : \`${s.uuid}\`
*NETWORK*     : \`ws, grpc, upgrade\`
*PATH*        : \`${s?.path?.stn ?? '-'}\`
*EXPIRED*     : \`${s.expired}\` - \`${s.time}\`
*QUOTA*       : \`${KUOTA === "0" ? "Unlimited" : KUOTA} GB\`
*IP LIMIT*    : \`${LIMIT_IP === "0" ? "Unlimited" : LIMIT_IP} pengguna\`

*[ TROJAN LINK ]*
-----------------------------
TLS:
\`${s?.link?.tls ?? '-'}\`

gRPC:
\`${s.link.grpc}\`

Up TLS:
\`${s.link.uptls}\`

*[ HOST INFORMATION ]*
-----------------------------
*Domain*      : \`${s.hostname}\`
*SNI*         : \`${s.hostname}\`

*[ PORTS ]*
-----------------------------
*WS TLS*      : \`${s?.port?.tls ?? '-'}\`
*WS NTLS*     : \`${s.port.none}\`
*ANY PORT*    : \`${s.port.any}\`
*GRPC TLS*    : \`${s.port.grpc}\`

*[ SUGGESTED SNI / BUG ]*
-----------------------------
\`${s.hostname}\`
\`www.google.com\`
\`www.bing.com\`

*[ DOWNLOAD CONFIG ]*
-----------------------------
http://${s.hostname}:81/trojan-config.zip

-----------------------------
*© Telegram Bots 1forcr - 2025*
*Terima kasih telah menggunakan layanan kami.*
`;

        return resolve(msg);
      });
    });
  });
}


//create shadowsocks ga ada di potato
async function createshadowsocks(username, exp, quota, limitip, serverId) {
  console.log(`Creating Shadowsocks account for ${username} with expiry ${exp} days, quota ${quota} GB, limit IP ${limitip} on server ${serverId}`);

  // Validasi username
  if (/\s/.test(username) || /[^a-zA-Z0-9]/.test(username)) {
    return '❌ Username tidak valid. Mohon gunakan hanya huruf dan angka tanpa spasi.';
  }

  // Ambil domain dari database
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
      if (err) {
        console.error('Error fetching server:', err.message);
        return resolve('❌ Server tidak ditemukan. Silakan coba lagi.');
      }

      if (!server) return resolve('❌ Server tidak ditemukan. Silakan coba lagi.');

      const domain = server.domain;
      const auth = server.auth;
      const param = `:5888/createshadowsocks?user=${username}&exp=${exp}&quota=${quota}&iplimit=${limitip}&auth=${auth}`;
      const url = `http://${domain}${param}`;
      axios.get(url)
        .then(response => {
          if (response.data.status === "success") {
            const shadowsocksData = response.data.data;
            const msg = `
🌟 *AKUN SHADOWSOCKS PREMIUM* 🌟

🔹 *Informasi Akun*
┌─────────────────────
│ *Username* : \`${shadowsocksData.username}\`
│ *Domain*   : \`${shadowsocksData.domain}\`
│ *NS*       : \`${shadowsocksData.ns_domain}\`
│ *Port TLS* : \`443\`
│ *Port HTTP*: \`80\`
│ *Alter ID* : \`0\`
│ *Security* : \`Auto\`
│ *Network*  : \`Websocket (WS)\`
│ *Path*     : \`/shadowsocks\`
│ *Path GRPC*: \`shadowsocks-grpc\`
└─────────────────────
🔐 *URL SHADOWSOCKS TLS*
\`\`\`
${shadowsocksData.ss_link_ws}
\`\`\`
🔒 *URL SHADOWSOCKS GRPC*
\`\`\`
${shadowsocksData.ss_link_grpc}
\`\`\`
🔒 *PUBKEY*
\`\`\`
${shadowsocksData.pubkey}
\`\`\`
┌─────────────────────
│ Expiry: \`${shadowsocksData.expired}\`
│ Quota: \`${shadowsocksData.quota === '0 GB' ? 'Unlimited' : shadowsocksData.quota}\`
│ IP Limit: \`${shadowsocksData.ip_limit === '0' ? 'Unlimited' : shadowsocksData.ip_limit} IP\`
└─────────────────────
Save Account Link: [Save Account](https://${shadowsocksData.domain}:81/shadowsocks-${shadowsocksData.username}.txt)
✨ Selamat menggunakan layanan kami! ✨
`;
            console.log('Shadowsocks account created successfully');
            return resolve(msg);
          } else {
            console.log('Error creating Shadowsocks account');
            return resolve(`❌ Terjadi kesalahan: ${response.data.message}`);
          }
        })
        .catch(error => {
          console.error('Error saat membuat Shadowsocks:', error);
          return resolve('❌ Terjadi kesalahan saat membuat Shadowsocks. Silakan coba lagi nanti.');
        });
    });
  });
}

module.exports = { createssh, createudphttp, createvmess, createvless, createtrojan, createshadowsocks };





