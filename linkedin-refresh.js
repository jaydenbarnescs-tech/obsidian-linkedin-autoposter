// linkedin-refresh.js
// Checks if the LinkedIn access token is near expiry and refreshes it.
// Run via cron / LaunchAgent daily — exits 0 if fine, exits 1 if manual re-auth needed.

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const CREDS_PATH = path.join(process.env.HOME, '.linkedin-credentials.json');
const LOG_DIR    = path.join(process.env.HOME, 'claude-agent/logs');
const LOG_FILE   = path.join(LOG_DIR, 'linkedin.log');

fs.mkdirSync(LOG_DIR, { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString()}] [refresh] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function httpsPost(postUrl, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(postUrl);
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`Non-JSON response: ${data}`)); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  if (!fs.existsSync(CREDS_PATH)) {
    log('ERROR: No credentials file found. Run linkedin-auth.js first.');
    process.exit(1);
  }

  const creds     = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf-8'));
  const expiresAt = new Date(creds.expires_at);
  const now       = new Date();
  const daysLeft  = (expiresAt - now) / (1000 * 60 * 60 * 24);

  log(`Access token expires: ${creds.expires_at} (${Math.round(daysLeft)} days left)`);

  if (daysLeft > 7) {
    log(`Token still valid for ${Math.round(daysLeft)} days — no refresh needed.`);
    return;
  }

  if (!creds.refresh_token) {
    log('ERROR: Token expiring soon but no refresh token available!');
    log('Re-run: node linkedin-auth.js');
    process.exit(1);
  }

  if (creds.refresh_token_expires_at) {
    const refreshExpiresAt = new Date(creds.refresh_token_expires_at);
    if (refreshExpiresAt <= now) {
      log('ERROR: Refresh token has also expired. Re-run: node linkedin-auth.js');
      process.exit(1);
    }
  }

  log('Refreshing access token...');

  const body = [
    'grant_type=refresh_token',
    `refresh_token=${encodeURIComponent(creds.refresh_token)}`,
    `client_id=${creds.client_id}`,
    `client_secret=${encodeURIComponent(creds.client_secret)}`,
  ].join('&');

  try {
    const res = await httpsPost('https://www.linkedin.com/oauth/v2/accessToken', body);

    if (res.error) {
      throw new Error(`Refresh failed: ${res.error} — ${res.error_description}`);
    }

    const nowMs          = Date.now();
    const expiresIn      = res.expires_in || 5184000;
    const refreshExpiresIn = res.refresh_token_expires_in || 31536000;

    creds.access_token  = res.access_token;
    creds.expires_at    = new Date(nowMs + expiresIn * 1000).toISOString();

    if (res.refresh_token) {
      creds.refresh_token              = res.refresh_token;
      creds.refresh_token_expires_at   = new Date(nowMs + refreshExpiresIn * 1000).toISOString();
    }

    creds.last_refreshed = new Date().toISOString();
    fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2));
    log(`✓ Token refreshed. New expiry: ${creds.expires_at}`);
  } catch (err) {
    log(`ERROR refreshing token: ${err.message}`);
    process.exit(1);
  }
}

main();
