'use strict';
const fs = require('node:fs');
const http = require('node:http');

// Check the authenticated main-process endpoint, never send its token off-host.
async function checkHud({rpcFile, markerFile, pid, timeoutMs = 750}) {
  try {
    pid = Number(pid);
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    if (markerFile && fs.readFileSync(markerFile, 'utf8').trim() !== String(pid)) return false;
    process.kill(pid, 0);
    const cfg = JSON.parse(fs.readFileSync(rpcFile, 'utf8'));
    if (cfg.pid !== pid || typeof cfg.adminToken !== 'string' || !cfg.adminToken) return false;
    const url = new URL(cfg.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
    url.pathname = '/admin/status';
    return await new Promise(resolve => {
      let settled = false, req;
      const done = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); req?.destroy(); };
      const timer = setTimeout(() => done(false), timeoutMs);
      req = http.get(url, {headers: {'X-T3-Hud-Token': cfg.adminToken}}, res => {
        if (res.statusCode !== 200) { res.resume(); done(false); return; }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', data => { body += data; if (body.length > 65536) done(false); });
        res.on('error', () => done(false));
        res.on('end', () => {
          try { const value = JSON.parse(body); done(value.ok === true && value.pid === pid && value.lastInjectError === null && value.mounted === true); }
          catch { done(false); }
        });
      });
      req.on('error', () => done(false));
    });
  } catch { return false; }
}
module.exports = {checkHud};
if (require.main === module) {
  const [rpcFile, markerFile, pid] = process.argv.slice(2);
  checkHud({rpcFile, markerFile, pid}).then(ok => { process.exitCode = ok ? 0 : 1; });
}
