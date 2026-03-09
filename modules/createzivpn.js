const { exec } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sellvpn.db');

async function createzivpn(username, password, exp, iplimit, serverId) {
  if (/\s/.test(username) || /[^a-zA-Z0-9]/.test(username)) {
    return '❌ Username hanya boleh huruf & angka (tanpa spasi)';
  }

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
      if (err || !server) {
        return resolve('❌ Server tidak ditemukan');
      }

      const url = `http://${server.domain}/vps/sshvpn`;
      const cmd = `curl -s -X POST "${url}" \
      -H "Authorization: ${server.auth}" \
      -H "Content-Type: application/json" \
      -d '{"expired":${exp},"limitip":"${iplimit}","password":"${password}","username":"${username}"}'`;

      exec(cmd, (_, stdout) => {
        let res;
        try {
          res = JSON.parse(stdout);
        } catch {
          return resolve('❌ Response server tidak valid');
        }

        if (res?.meta?.code !== 200) {
          try {
            console.error(`ZIVPN error response: ${JSON.stringify(res)}`);
          } catch (e) {
            console.error('ZIVPN error response: [unserializable]');
          }
          const rawMessage = (res?.message || res?.meta?.message || '').toString();
          const haystack = (rawMessage || JSON.stringify(res) || '').toLowerCase();
          if (
            (haystack.includes('username') || haystack.includes('client')) &&
            (haystack.includes('exist') || haystack.includes('exists') || haystack.includes('already') || haystack.includes('try another'))
          ) {
            return resolve('❌ username sudah ada mohon ulangi dengan username yang unik');
          }
          return resolve('❌ Gagal membuat akun ZIVPN');
        }

        const s = res.data;

        const msg = `
*✅ ZIVPN SSH ACCOUNT*

• *udp password* : \`${s.username}\`
• *Hostname* : \`${s.hostname}\`
• *Expired*  : \`${s.exp}\`
• *IP Limit* : ${iplimit} device
`;
        resolve(msg);
      });
    });
  });
}

module.exports = { createzivpn };
