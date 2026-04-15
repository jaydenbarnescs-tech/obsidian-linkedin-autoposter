// linkedin-auth.js
// One-shot LinkedIn OAuth2 flow — gets access + refresh tokens + person URN
// Run this once to generate ~/.linkedin-credentials.json

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const CLIENT_ID     = process.env.LINKEDIN_CLIENT_ID;
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
const REDIRECT_URI  = 'http://localhost:3000/callback';
const STATE         = 'mgc123';
const CREDS_PATH    = path.join(process.env.HOME, '.linkedin-credentials.json');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('ERROR: Set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET environment variables first.');
  console.error('  export LINKEDIN_CLIENT_ID=your_client_id');
  console.error('  export LINKEDIN_CLIENT_SECRET=your_client_secret');
  process.exit(1);
}

const AUTH_URL = [
  'https://www.linkedin.com/oauth/v2/authorization',
  `?response_type=code`,
  `&client_id=${CLIENT_ID}`,
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
  `&scope=openid%20profile%20w_member_social`,
  `&state=${STATE}`,
].join('');

function httpsRequest(method, reqUrl, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(reqUrl);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method,
      headers: headers || {},
    };
    if (body) {
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          reject(new Error(`Non-JSON response (${res.statusCode}): ${data}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  if (parsed.pathname !== '/callback') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  console.log(`\nCallback received: ${req.url}`);
  const { code, state, error, error_description } = parsed.query;

  if (error) {
    console.error(`\n✗ LinkedIn error: ${error} — ${error_description}`);
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(`<h1>Error</h1><p>${error}: ${error_description}</p>`);
    return;
  }

  if (state !== STATE) {
    console.error('✗ State mismatch');
    res.writeHead(400);
    res.end('State mismatch');
    return;
  }

  if (!code) {
    console.error('✗ No code in callback');
    res.writeHead(400);
    res.end('No authorization code received');
    return;
  }

  console.log(`✓ Authorization code: ${code.substring(0, 20)}...`);

  try {
    // Step 1: Exchange code for tokens
    console.log('\nExchanging code for tokens...');
    const tokenBody = [
      'grant_type=authorization_code',
      `code=${encodeURIComponent(code)}`,
      `client_id=${CLIENT_ID}`,
      `client_secret=${encodeURIComponent(CLIENT_SECRET)}`,
      `redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
    ].join('&');

    const tokenRes = await httpsRequest(
      'POST',
      'https://www.linkedin.com/oauth/v2/accessToken',
      {},
      tokenBody
    );

    if (tokenRes.data.error) {
      throw new Error(`Token error: ${tokenRes.data.error} — ${tokenRes.data.error_description}`);
    }

    const accessToken      = tokenRes.data.access_token;
    const refreshToken     = tokenRes.data.refresh_token || null;
    const expiresIn        = tokenRes.data.expires_in || 5184000;
    const refreshExpiresIn = tokenRes.data.refresh_token_expires_in || 31536000;

    console.log(`✓ Access token received (expires in ${Math.round(expiresIn / 86400)} days)`);
    if (refreshToken) {
      console.log(`✓ Refresh token received (expires in ${Math.round(refreshExpiresIn / 86400)} days)`);
    } else {
      console.log('⚠ No refresh token — you may need to enable "Sign In with LinkedIn using OpenID Connect" in your app');
    }

    // Step 2: Get person URN
    console.log('\nFetching person URN...');
    const meRes = await httpsRequest('GET', 'https://api.linkedin.com/v2/me', {
      Authorization: `Bearer ${accessToken}`,
    });

    let personUrn   = null;
    let displayName = null;

    if (meRes.status === 200 && meRes.data.id) {
      personUrn   = `urn:li:person:${meRes.data.id}`;
      displayName = [meRes.data.localizedFirstName, meRes.data.localizedLastName].filter(Boolean).join(' ') || null;
    } else {
      // Fallback: OpenID /v2/userinfo
      const uiRes = await httpsRequest('GET', 'https://api.linkedin.com/v2/userinfo', {
        Authorization: `Bearer ${accessToken}`,
      });
      if (uiRes.status === 200 && uiRes.data.sub) {
        personUrn   = `urn:li:person:${uiRes.data.sub}`;
        displayName = uiRes.data.name || null;
      }
    }

    console.log(`✓ Person URN: ${personUrn}`);
    if (displayName) console.log(`  Name: ${displayName}`);

    // Step 3: Save credentials
    const now   = Date.now();
    const creds = {
      access_token:              accessToken,
      refresh_token:             refreshToken,
      expires_at:                new Date(now + expiresIn * 1000).toISOString(),
      refresh_token_expires_at:  new Date(now + refreshExpiresIn * 1000).toISOString(),
      person_urn:                personUrn,
      name:                      displayName,
      client_id:                 CLIENT_ID,
      client_secret:             CLIENT_SECRET,
      created_at:                new Date().toISOString(),
    };

    fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2));
    console.log(`\n✓ Credentials saved to ${CREDS_PATH}`);

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <html><body style="font-family:system-ui;text-align:center;padding:60px">
        <h1>✓ LinkedIn connected</h1>
        <p><strong>${displayName || 'Unknown'}</strong></p>
        <p>Person URN: <code>${personUrn}</code></p>
        <p>Access token expires: ${creds.expires_at}</p>
        <p>Refresh token: ${refreshToken ? '✓ saved' : '✗ not available'}</p>
        <p style="margin-top:40px;color:#666">You can close this tab.</p>
      </body></html>
    `);
  } catch (err) {
    console.error(`\n✗ Error: ${err.message}`);
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(`<h1>Error</h1><pre>${err.message}</pre>`);
  }

  setTimeout(() => {
    console.log('\nServer shutting down.');
    server.close();
    process.exit(0);
  }, 1000);
});

server.listen(3000, () => {
  console.log('LinkedIn OAuth server listening on http://localhost:3000\n');
  console.log('════════════════════════════════════════');
  console.log('  Open this URL in your browser:');
  console.log('════════════════════════════════════════\n');
  console.log(AUTH_URL);
  console.log('\n════════════════════════════════════════');
  console.log('  Waiting for callback...');
  console.log('════════════════════════════════════════\n');
});
