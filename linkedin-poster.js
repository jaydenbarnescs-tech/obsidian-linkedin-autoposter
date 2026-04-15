'use strict';

// linkedin-poster.js
// Picks the top post from 2-queue/, posts it to LinkedIn, moves it to 3-posted/.
// Runs daily at 1pm JST via LaunchAgent (see launchagents/).
// Adds a random 0–30 min (70%) or 90–120 min (30%) delay to look human.
// Skips weekends.

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const VAULT    = process.env.OBSIDIAN_VAULT || (process.env.HOME + '/Library/Mobile Documents/iCloud~md~obsidian/Documents/MGC');
const QUEUE    = VAULT  + '/2-queue/';
const POSTED   = VAULT  + '/3-posted/';
const HISTORY  = VAULT  + '/history/';
const CREDS    = process.env.HOME + '/.linkedin-credentials.json';
const LOG_DIR  = process.env.HOME + '/claude-agent/logs';
const LOG_FILE = LOG_DIR + '/linkedin-poster.log';

function log(msg) {
  const line = new Date().toISOString() + '  ' + msg;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([\w_-]+):\s*(.*)/);
    if (m) meta[m[1]] = m[2].trim();
  }
  return { meta, body: match[2] };
}

function buildFrontmatter(meta) {
  return '---\n' + Object.entries(meta).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n---\n';
}

function linkedinPost(creds, postContent) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      author: creds.person_urn,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary:   { text: postContent },
          shareMediaCategory: 'NONE'
        }
      },
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'CONNECTIONS' }
    });

    const options = {
      hostname: 'api.linkedin.com',
      path: '/v2/ugcPosts',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + creds.access_token,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function moveFile(src, dst) {
  try { fs.renameSync(src, dst); }
  catch (err) {
    if (err.code === 'EXDEV') { fs.copyFileSync(src, dst); fs.unlinkSync(src); }
    else { throw err; }
  }
}

function renumberQueue() {
  const files = fs.readdirSync(QUEUE).filter(f => f.endsWith('.md')).sort();
  files.forEach((file, idx) => {
    const newNum  = String(idx + 1).padStart(3, '0');
    const newName = file.replace(/^\d+/, newNum);
    if (newName !== file) fs.renameSync(path.join(QUEUE, file), path.join(QUEUE, newName));
  });
  log(`Queue renumbered: ${files.length} file(s) remaining`);
}

async function main() {
  log('linkedin-poster: starting');

  fs.mkdirSync(POSTED,  { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });

  // Weekend check (JST = UTC+9)
  const jstDate = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const dowJST  = jstDate.getUTCDay();
  if (dowJST === 0 || dowJST === 6) { log('Skipping: weekend'); process.exit(0); }

  // Random delay
  const delayMs = Math.random() < 0.7
    ? Math.floor(Math.random() * 31) * 60 * 1000
    : (90 + Math.floor(Math.random() * 31)) * 60 * 1000;
  log(`Delay: ${Math.round(delayMs / 60000)} min`);
  await new Promise(resolve => setTimeout(resolve, delayMs));

  // Pick from queue
  const queueFiles = fs.readdirSync(QUEUE).filter(f => f.endsWith('.md')).sort();
  let chosenFile = null;
  for (const file of queueFiles) {
    const { meta } = parseFrontmatter(fs.readFileSync(path.join(QUEUE, file), 'utf8'));
    if (meta.status === 'ready') { chosenFile = file; break; }
  }

  if (!chosenFile) { log('No posts in queue'); process.exit(0); }
  log(`Post picked: ${chosenFile}`);

  const filePath      = path.join(QUEUE, chosenFile);
  const fileContent   = fs.readFileSync(filePath, 'utf8');
  const { meta, body } = parseFrontmatter(fileContent);
  const postContent   = body.trim();

  const creds = JSON.parse(fs.readFileSync(CREDS, 'utf8'));

  log('Posting to LinkedIn...');
  const result = await linkedinPost(creds, postContent);
  log(`LinkedIn response: ${result.status}`);

  if (result.status === 401) { log('Token expired — run: node linkedin-refresh.js'); process.exit(1); }
  if (result.status !== 201) { log('LinkedIn error: ' + result.body); process.exit(1); }

  meta.status          = 'posted';
  meta.posted_at       = new Date().toISOString();
  meta.linkedin_status = '201';

  fs.writeFileSync(filePath, buildFrontmatter(meta) + body, 'utf8');
  moveFile(filePath, path.join(POSTED, chosenFile));
  log(`Moved to 3-posted/: ${chosenFile}`);

  if (meta.history_file) {
    try {
      let linkedinId = '';
      try { linkedinId = JSON.parse(result.body).id || ''; } catch (_) {}
      fs.appendFileSync(path.join(HISTORY, meta.history_file),
        `\n## 📤 Posted\n\nposted_at: ${meta.posted_at}\nlinkedin_id: ${linkedinId}\n`);
    } catch (e) { log(`WARN: History update failed: ${e.message}`); }
  }

  renumberQueue();
  log('linkedin-poster: done');
}

main().catch(err => { log('ERROR: ' + (err.stack || err.message)); process.exit(1); });
