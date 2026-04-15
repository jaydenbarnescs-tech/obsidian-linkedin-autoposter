'use strict';

// linkedin-watcher-v2.js
// Watches your Obsidian vault root for new .m4a / .md / .txt files.
// Audio → transcribed via ElevenLabs Scribe v2, then polished by Claude CLI.
// Text/md → polished directly by Claude CLI.
// Good posts are auto-queued in 2-queue/ with Claude deciding the position.
// Junk / mic-tests are silently skipped and removed.

const chokidar = require('chokidar');
const fs       = require('fs');
const path     = require('path');
const { execFile, execSync } = require('child_process');

// ── Config ────────────────────────────────────────────────────────────────────
// Update VAULT to point to your Obsidian vault folder
const VAULT     = process.env.OBSIDIAN_VAULT || (process.env.HOME + '/Library/Mobile Documents/iCloud~md~obsidian/Documents/MGC');
const INBOX     = VAULT + '/';
const QUEUE     = VAULT + '/2-queue/';
const PROCESSED = VAULT + '/1-processed/';
const HISTORY   = VAULT + '/history/';
const CLAUDE    = process.env.CLAUDE_BIN  || (process.env.HOME + '/bin/claude');
const LOG_DIR   = process.env.HOME + '/claude-agent/logs';
const LOG_FILE  = LOG_DIR + '/linkedin.log';

// ElevenLabs API key — set via env var: export ELEVENLABS_API_KEY=sk_...
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

// ── PID file guard (prevent multiple instances) ───────────────────────────────
const PID_FILE = '/tmp/linkedin-watcher.pid';
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.floor(Math.random() * 400));
try {
  const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim());
  if (oldPid && oldPid !== process.pid) {
    try { process.kill(oldPid, 0); process.exit(0); } catch(_) {}
  }
} catch(_) {}
fs.writeFileSync(PID_FILE, String(process.pid));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
try {
  const checkPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim());
  if (checkPid !== process.pid) { process.exit(0); }
} catch(_) { process.exit(0); }
process.on('exit', () => { try { fs.unlinkSync(PID_FILE); } catch(_) {} });

// ── Ensure directories ────────────────────────────────────────────────────────
fs.mkdirSync(QUEUE,     { recursive: true });
fs.mkdirSync(PROCESSED, { recursive: true });
fs.mkdirSync(HISTORY,   { recursive: true });
fs.mkdirSync(LOG_DIR,   { recursive: true });

// ── Duplicate tracking ────────────────────────────────────────────────────────
const processing       = new Set();
const processingLock   = new Set();
const mdProcessingLock = new Set();

// ── Logging ───────────────────────────────────────────────────────────────────
function log(msg) {
  const line = new Date().toISOString() + ' ' + msg;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) { console.error('Log write failed:', e.message); }
}

// ── Frontmatter helpers ───────────────────────────────────────────────────────
function stripFrontmatter(content) {
  return content.replace(/^---[\s\S]*?---\n*/, '').trim();
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result = {};
  for (const line of match[1].split('\n')) {
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const val = line.slice(sep + 1).trim().replace(/^["']|["']$/g, '');
    result[key] = val;
  }
  return result;
}

function slugifyFirstWords(text, wordCount = 5) {
  return text.trim().split(/\s+/).slice(0, wordCount).join(' ')
    .toLowerCase().replace(/[^a-z0-9\s]/g, '').trim()
    .replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'untitled';
}

function pad3(n) { return String(n).padStart(3, '0'); }

// ── Transcribe audio via ElevenLabs Scribe v2 ────────────────────────────────
async function transcribeAudio(audioPath) {
  if (!ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY env var not set');

  const ts       = Date.now();
  const tmpAudio = `/tmp/scribe-src-${ts}${path.extname(audioPath)}`;

  await new Promise((resolve, reject) => {
    execFile('cp', [audioPath, tmpAudio], err =>
      err ? reject(new Error('cp failed: ' + err.message)) : resolve()
    );
  });

  const audioData = fs.readFileSync(tmpAudio);
  try { fs.unlinkSync(tmpAudio); } catch(_) {}

  return new Promise((resolve, reject) => {
    const https    = require('https');
    const boundary = '----ScribeBoundary' + Date.now();
    const ext      = path.extname(audioPath).slice(1) || 'm4a';
    const mimeType = ext === 'wav' ? 'audio/wav' : ext === 'mp3' ? 'audio/mpeg' : 'audio/mp4';

    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="audio.${ext}"\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`
      ),
      audioData,
      Buffer.from(
        `\r\n--${boundary}\r\n` +
        `Content-Disposition: form-data; name="model_id"\r\n\r\nscribe_v2\r\n` +
        `--${boundary}--\r\n`
      )
    ]);

    const options = {
      hostname: 'api.elevenlabs.io',
      path: '/v1/speech-to-text',
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.text) { resolve(parsed.text.trim()); }
          else { reject(new Error('No text in response: ' + data.slice(0, 200))); }
        } catch(e) {
          reject(new Error('Parse error: ' + e.message + ' raw: ' + data.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Scribe timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Run Claude CLI ────────────────────────────────────────────────────────────
function runClaude(prompt, options = {}) {
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    const model   = options.model || 'claude-sonnet-4-6';
    const args    = ['-p', prompt, '--model', model, '--max-turns', '1', '--dangerously-skip-permissions'];
    const env     = { ...process.env };

    const child = spawn(CLAUDE, args, { stdio: ['ignore', 'pipe', 'pipe'], env });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);

    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Claude CLI timed out after 120s')); }, 120000);

    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        const err = new Error(`Claude CLI exited with code ${code}`);
        err.stdout = stdout; err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
    child.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// ── Queue helpers ─────────────────────────────────────────────────────────────
function readQueue() {
  let files;
  try { files = fs.readdirSync(QUEUE).filter(f => f.endsWith('.md')).sort(); }
  catch (e) { return []; }
  return files.map(filename => {
    const fullPath = path.join(QUEUE, filename);
    let content = '';
    try { content = fs.readFileSync(fullPath, 'utf8'); } catch (e) { return null; }
    const fm        = parseFrontmatter(content);
    const body      = stripFrontmatter(content);
    const firstLine = (body.split('\n').find(l => l.trim()) || '').slice(0, 120);
    return { filename, fullPath, position: parseInt(fm.position || '0', 10) || 0, status: fm.status || 'ready', firstLine };
  }).filter(Boolean).sort((a, b) => a.position - b.position);
}

function renumberQueue(existingQueue, decidedPosition, newContent) {
  const insertIdx         = Math.max(0, Math.min(decidedPosition - 1, existingQueue.length));
  const existingContents  = existingQueue.map(item => { try { return fs.readFileSync(item.fullPath, 'utf8'); } catch (e) { return null; } });
  const ordered           = [];
  for (let i = 0; i < existingQueue.length; i++) {
    if (i === insertIdx) ordered.push({ content: newContent, isNew: true });
    if (existingContents[i] !== null) ordered.push({ content: existingContents[i], isNew: false, oldPath: existingQueue[i].fullPath });
  }
  if (insertIdx >= existingQueue.length) ordered.push({ content: newContent, isNew: true });

  const stamp    = Date.now();
  const tmpFiles = ordered.map((_, i) => path.join(QUEUE, `.tmp_${stamp}_${i}.md`));
  let savedFilename = null;

  ordered.forEach(({ content }, i) => {
    const pos     = i + 1;
    const updated = content.replace(/^(position:\s*)\d+/m, `$1${pos}`);
    fs.writeFileSync(tmpFiles[i], updated, 'utf8');
  });
  existingQueue.forEach(item => { try { fs.unlinkSync(item.fullPath); } catch (e) {} });
  ordered.forEach(({ content, isNew }, i) => {
    const pos     = i + 1;
    const updated = content.replace(/^(position:\s*)\d+/m, `$1${pos}`);
    const body    = stripFrontmatter(updated);
    const slug    = slugifyFirstWords(body.split('\n').find(l => l.trim()) || '');
    const fname   = pad3(pos) + '-' + slug + '.md';
    fs.renameSync(tmpFiles[i], path.join(QUEUE, fname));
    if (isNew) savedFilename = fname;
  });
  return savedFilename;
}

// ── Polish prompt ─────────────────────────────────────────────────────────────
const POLISH_PROMPT = (transcript) =>
  `You are a LinkedIn ghostwriter for a Japan-based founder. Read this voice note transcript and decide: does it contain enough real substance to become a LinkedIn post? (A real idea, opinion, story, lesson, observation — not a test, mic check, or meaningless content.)\n\n` +
  `If YES: Return ONLY a JSON object like this:\n` +
  `{"action": "queue", "post": "your polished LinkedIn post here"}\n\n` +
  `Rules for the post: authentic voice, max 1300 chars, max 3 hashtags only if truly needed, first line must stop the scroll, short punchy paragraphs, never use: game-changer/excited to share/thrilled to announce, end with a question or thought that invites comments.\n\n` +
  `If NO: Return ONLY a JSON object like this:\n` +
  `{"action": "skip", "reason": "brief reason why e.g. mic test, no content, too short"}\n\n` +
  `Transcript: ` + transcript;

const POSITION_PROMPT = (queueJSON, polished) =>
  `Given the NEW post and the EXISTING queue, decide what position (1-based) to insert the new post at. ` +
  `Timely/trending topics should cut to position 1-2. Evergreen content goes to the back. ` +
  `Never put two similar topics back-to-back. ` +
  `Respond with ONLY a JSON object: {"position": NUMBER, "reason": "brief reason"}\n\n` +
  `EXISTING QUEUE:\n${queueJSON}\n\nNEW POST:\n${polished}`;

// ── Core pipeline (shared by audio + md paths) ────────────────────────────────
async function processTranscript(transcript, sourceFilename, historyFile, rawPath) {
  // 1. Polish & judge
  log(`[POLISHING] ${sourceFilename}`);
  let claudeResult;
  try {
    const { stdout } = await runClaude(POLISH_PROMPT(transcript));
    const cleaned    = stdout.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    claudeResult     = JSON.parse(cleaned);
  } catch (e) {
    log(`[ERROR] Polish/judge failed for ${sourceFilename}: ${e.message}`);
    if (e.stderr) log(`[STDERR] ${String(e.stderr).slice(0, 500)}`);
    return;
  }

  if (!claudeResult?.action) { log(`[ERROR] Invalid JSON from Claude for ${sourceFilename}`); return; }

  if (claudeResult.action === 'skip') {
    const reason = claudeResult.reason || 'no reason given';
    log(`[SKIPPED] ${sourceFilename} — ${reason}`);
    try { fs.unlinkSync(rawPath); } catch (e) { log(`[WARN] Could not delete raw file: ${e.message}`); }
    if (historyFile) {
      try {
        fs.appendFileSync(path.join(HISTORY, historyFile),
          `\n## ⏭️ Skipped\n\nreason: ${reason}\nskipped_at: ${new Date().toISOString()}\n`);
      } catch (e) { log(`[WARN] History append failed: ${e.message}`); }
    }
    return;
  }

  const polished = claudeResult.post;
  if (!polished) { log(`[ERROR] Empty post content from Claude for ${sourceFilename}`); return; }
  log(`[POLISHED] ${sourceFilename} — ${polished.length} chars`);

  // 2. Decide queue position
  const existingQueue     = readQueue();
  let decidedPosition     = existingQueue.length + 1;
  let queueReason         = 'defaulted to end';

  try {
    const queueSummaryJSON = JSON.stringify(
      existingQueue.map(q => ({ filename: q.filename, position: q.position, status: q.status, firstLine: q.firstLine })),
      null, 2
    );
    const { stdout: posOut } = await runClaude(POSITION_PROMPT(queueSummaryJSON, polished));
    const jsonMatch = posOut.match(/\{[\s\S]*?"position"[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (typeof parsed.position === 'number' && parsed.position >= 1) {
        decidedPosition = Math.min(Math.max(Math.round(parsed.position), 1), existingQueue.length + 1);
        queueReason     = parsed.reason || queueReason;
      }
    }
  } catch (e) { log(`[WARN] Position decision failed, defaulting to end: ${e.message}`); }

  log(`[QUEUE_POSITION] ${sourceFilename} → position ${decidedPosition} (${queueReason})`);

  // 3. Write queue file
  const now        = new Date();
  const dateStr    = now.toISOString().slice(0, 10);
  const polishedAt = now.toISOString();
  const scheduledFor = new Date(now.getTime() + (decidedPosition - 1) * 24 * 60 * 60 * 1000).toISOString();

  const newFileContent =
    `---\nposition: ${decidedPosition}\ndate: ${dateStr}\nsource_file: ${sourceFilename}\nstatus: ready\n` +
    `polished_at: ${polishedAt}\nqueue_reason: "${queueReason.replace(/"/g, "'")}"\n` +
    (historyFile ? `history_file: ${historyFile}\n` : '') +
    `---\n\n${polished}\n`;

  let savedFilename;
  try { savedFilename = renumberQueue(existingQueue, decidedPosition, newFileContent); }
  catch (e) { log(`[ERROR] Queue renumber failed: ${e.message}`); return; }

  log(`[SAVED] ${savedFilename} → 2-queue/`);

  // 4. Update history
  if (historyFile) {
    try {
      fs.appendFileSync(path.join(HISTORY, historyFile),
        `\n## ✍️ Polished Post\n\n${polished}\n\nqueue_position: ${decidedPosition}\nscheduled_for: ${scheduledFor}\n`);
    } catch (e) { log(`[WARN] History append failed: ${e.message}`); }
  }

  // 5. Clean up raw file
  try { fs.unlinkSync(rawPath); log(`[PROCESSED] Deleted raw transcript ${sourceFilename}`); }
  catch (e) { log(`[WARN] Could not delete raw transcript: ${e.message}`); }
}

// ── MD file handler ───────────────────────────────────────────────────────────
async function processFile(filePath) {
  const filename = path.basename(filePath);
  if (processing.has(filePath)) return;
  processing.add(filePath);
  log(`[DETECTED] ${filename}`);

  try {
    let raw;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try { raw = fs.readFileSync(filePath, 'utf8'); break; }
      catch (e) {
        if (attempt === 1) { try { execSync(`brctl download "${filePath}"`, { timeout: 10000 }); } catch (_) {} }
        log(`[RETRY] Cannot read ${filename} (attempt ${attempt}/5): ${e.message}`);
        if (attempt === 5) {
          try { raw = execSync(`cat "${filePath}"`, { encoding: 'utf8', timeout: 10000 }); break; }
          catch (_) { log(`[ERROR] Giving up on ${filename}`); processing.delete(filePath); return; }
        }
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    const strippedContent = stripFrontmatter(raw);
    if (!strippedContent) { log(`[SKIP] Empty after stripping frontmatter: ${filename}`); return; }
    const sourceMeta = parseFrontmatter(raw);

    await processTranscript(strippedContent, filename, sourceMeta.history_file || null, filePath);
  } catch (e) {
    log(`[ERROR] Unexpected error processing ${filename}: ${e.message}`);
  } finally {
    processing.delete(filePath);
  }
}

// ── Audio file handler ────────────────────────────────────────────────────────
async function handleAudioFile(filePath) {
  const filename = path.basename(filePath);
  if (filename.startsWith('.') || filename.startsWith('_')) return;
  const relativePath = path.relative(VAULT, filePath);
  if (relativePath.includes('/')) return;
  if (processingLock.has(filePath)) { log(`[AUDIO] Already processing ${filename}`); return; }
  processingLock.add(filePath);

  try {
    log(`[AUDIO] Detected: ${filename}`);
    await new Promise(r => setTimeout(r, 3000));

    try {
      const stat = fs.statSync(filePath);
      if (stat.size < 1000) { log(`[AUDIO] Skipping ${filename} — too small (${stat.size} bytes)`); return; }
    } catch(e) { log(`[AUDIO] File gone: ${filename}`); return; }

    try { execSync(`brctl download "${filePath}"`, { timeout: 15000 }); } catch(_) {}
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 5000));
      try { if (fs.statSync(filePath).size > 0) break; } catch(_) {}
    }

    log(`[AUDIO] Transcribing ${filename} via ElevenLabs Scribe v2...`);
    let text;
    try { text = await transcribeAudio(filePath); }
    catch(e) { log(`[AUDIO] Transcription failed for ${filename}: ${e.message}`); return; }

    if (!text || text.length < 3) { log(`[AUDIO] Empty transcription for ${filename}`); return; }
    log(`[AUDIO] Transcribed ${filename} — ${text.length} chars`);

    fs.unlinkSync(filePath);
    log(`[AUDIO] Deleted ${filename} after transcription`);

    const now       = new Date();
    const pad       = n => String(n).padStart(2, '0');
    const dateStr   = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
    const mdFname   = `voice-${dateStr}-${pad(now.getHours())}${pad(now.getMinutes())}.md`;
    const rawPath   = path.join(PROCESSED, `raw-${mdFname}`);

    fs.writeFileSync(rawPath,
      `---\ndate: ${dateStr}\ntime: ${pad(now.getHours())}:${pad(now.getMinutes())}\nstatus: raw\nsource: voice\nhistory_file: ${mdFname}\n---\n\n${text}\n`);

    const historyPath = path.join(HISTORY, mdFname);
    fs.writeFileSync(historyPath,
      `---\ncreated_at: ${now.toISOString()}\nsource_file: ${filename}\n---\n\n## 🎙️ Raw Transcript\n\n${text}\n`);

    await processTranscript(text, `raw-${mdFname}`, mdFname, rawPath);
  } finally {
    processingLock.delete(filePath);
  }
}

// ── Watcher ───────────────────────────────────────────────────────────────────
const watcher = chokidar.watch(INBOX, {
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 },
  persistent: true,
  depth: 0
});

const debounceTimers = new Map();

function handleFile(filePath) {
  const basename = path.basename(filePath);
  if (!basename.endsWith('.md') && !basename.endsWith('.txt')) return;
  if (basename.startsWith('_') || basename.startsWith('.')) return;
  if (mdProcessingLock.has(filePath)) return;
  processing.delete(filePath);

  if (debounceTimers.has(filePath)) clearTimeout(debounceTimers.get(filePath));

  const timer = setTimeout(() => {
    debounceTimers.delete(filePath);
    mdProcessingLock.add(filePath);
    processFile(filePath).catch(e => {
      log(`[ERROR] Unhandled: ${e.message}`);
      processing.delete(filePath);
    }).finally(() => { mdProcessingLock.delete(filePath); });
  }, 8000);
  debounceTimers.set(filePath, timer);
}

function handleAnyFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (['.m4a', '.wav', '.mp3'].includes(ext)) { handleAudioFile(filePath); }
  else if (ext === '.md') { handleFile(filePath); }
}

watcher.on('add',    handleAnyFile);
watcher.on('change', handleAnyFile);
watcher.on('error',  err => log(`[WATCHER_ERROR] ${err.message}`));
watcher.on('ready',  () => log(`[READY] Watching ${INBOX}`));

log(`[START] linkedin-watcher-v2 starting`);

function shutdown(signal) {
  log(`[SHUTDOWN] Received ${signal}, closing watcher...`);
  watcher.close().then(() => { log('[SHUTDOWN] Watcher closed.'); process.exit(0); }).catch(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
