const { exec } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sellvpn.db');

async function trialzivpn(serverId) {
  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
      if (err || !server) {
        return resolve('❌ Server tidak ditemukan');
      }

      const url = `http://${server.domain}/vps/trialsshvpn`;
      const cmd = `curl -s -X POST "${url}" \
      -H "Authorization: ${server.auth}" \
      -H "Content-Type: application/json" \
      -d '{"timelimit":"1h"}'`;

      exec(cmd, (_, stdout) => {
        let res;
        try {
          res = JSON.parse(stdout);
        } catch {
          return resolve('❌ Response server tidak valid');
        }

        if (res?.meta?.code !== 200) {
          return resolve('❌ Gagal membuat trial ZIVPN');
        }

        const s = res.data;

        const msg = `
*⚡ TRIAL ZIVPN SSH*

• *udp password* : \`${s.username}\`
• *Hostname* : \`${s.hostname}\`
• *Expired*  : 1 Jam/Hour
• *IP Limit* : 1 device
`;
        resolve(msg);
      });
    });
  });
}

module.exports = { trialzivpn };
