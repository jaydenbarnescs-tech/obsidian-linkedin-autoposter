# obsidian-linkedin-autoposter

Drop a voice note (`.m4a`) or a text/markdown file into your Obsidian vault root.  
Claude polishes it into a LinkedIn post, queues it intelligently, and posts it automatically at 1pm JST on weekdays.

```
Voice note (.m4a)  ──┺  ElevenLabs transcription  ──►  Claude polishes  ──►  2-queue/
Text note (.md)    ──────────────────────────────►  Claude polishes  ──┺  2-queue/
                                                                              │
                                                                    1pm JST daily
                                                                              │
                                                                     LinkedIn API ──┺ posted
```

---

## How it works

| File | Role |
|---|---|
| `linkedin-watcher-v2.js` | Watches the vault root; handles audio + md files |
| `linkedin-poster.js` | Daily cron: picks post #1 from queue, posts to LinkedIn |
| `linkedin-auth.js` | One-time OAuth flow to get your LinkedIn tokens |
| `linkedin-refresh.js` | Refreshes the access token before it expires |
| `launchagents/` | macOS LaunchAgent plists to run everything on login |

---

## Setup

### 1. Prerequisites

- **Node.js** 18+ (`brew install node`)
- **Claude Code CLI** installed and authenticated (`claude --version`)
- **LinkedIn Developer App** (see below — this is the tricky part)
- **ElevenLabs account** (for voice transcription — free tier works)

```bash
npm install
```

### 2. LinkedIn API setup (the tricky part)

LinkedIn's API requires a verified app. Here's the exact path that works:

#### Step 1 — Create a LinkedIn App

1. Go to [linkedin.com/developers/apps](https://www.linkedin.com/developers/apps) and click **Create app**
2. Fill in:
   - **App name**: anything (e.g. "My Auto Poster")  
   - **LinkedIn Page**: you need a LinkedIn Company Page linked — create a free one if needed  
   - **App logo**: any 100x100 image  
3. Agree to terms → **Create app**

#### Step 2 — Add the right products

In your app's **Products** tab, request access to:

- ✅ **Sign In with LinkedIn using OpenID Connect** — this gives you the `openid`, `profile` scopes needed to get your `person_urn`
- ✅ **Share on LinkedIn** — this gives you the `w_member_social` scope needed to post

> **Note:** "Share on LinkedIn" may show as "pending review". It typically gets approved within a few minutes for personal use apps. If it's stuck, try removing and re-adding the product.

#### Step 3 — Configure OAuth redirect

In the **Auth** tab, under **Authorized redirect URLs for your app**, add:

```
http://localhost:3000/callback
```

#### Step 4 — Get your Client ID and Secret

In the **Auth** tab, copy:
- **Client ID** (public, starts with a short alphanumeric string)
- **Client Secret** (treat like a password — never commit to git)

#### Step 5 — Run the auth flow

```bash
export LINKEDIN_CLIENT_ID=your_client_id_here
export LINKEDIN_CLIENT_SECRET=your_client_secret_here

node linkedin-auth.js
```

This starts a local server on port 3000, prints a URL, and waits.  
Open the URL in your browser → authorize → it saves credentials to `~/.linkedin-credentials.json`.

You'll see:
```
✓ LinkedIn connected
  Person URL: urn:li:person:XXXXXXXX
  Access token expires: 2026-10-...
  Refresh token: ✓ saved
```

> **Why no refresh token?** If you don't see a refresh token, your app doesn't have the "Sign In with LinkedIn using OpenID Connect" product added. Add it in the Products tab and re-run the auth.

#### Access token lifetime

LinkedIn access tokens expire after ~60 days. The refresh token lasts ~1 year.  
`linkedin-refresh.js` checks daily and refreshes automatically if expiry is within 7 days.  
If the refresh token also expires, you need to re-run `node linkedin-auth.js` once.

---

### 3. ElevenLabs setup (for voice notes)

If you don't need audio → skip this.

1. Sign up at [elevenlabs.io](https://elevenlabs.io) (free tier: 30 min/month transcription)
2. Go to **Profile** → **API Keys** → copy your key
3. Set the env var (or add to your LaunchAgent plist):

```bash
export ELEVENLABS_API_KEY=sk_your_key_here
```

---

### 4. Configure your Obsidian vault path

By default the scripts use:
```
~/Library/Mobile Documents/iCloud~md~obsidian/Documents/MGC
```

Override with an env var:
```bash
export OBSIDIAN_VAULT="/path/to/your/vault"
```

The vault needs these folders (created automatically on first run):
```
your-vault/
├── 2-queue/      ← polished posts waiting to be published
├── 3-posted/     ← archive of published posts
├── 1-processed/  ← raw transcripts (deleted after polishing)
└── history/      ← full audit trail: transcript → polish → post
```

---

### 5. Run the watcher

**Manual (for testing):**
```bash
export ELEVENLABS_API_KEY=sk_...
export OBSIDIAN_VAULT=/path/to/vault
node linkedin-watcher-v2.js
```

**Always-on via LaunchAgent (recommended):**

```bash
# 1. Edit the plist — replace YOUR_USERNAME and add your API keys
cp launchagents/com.yourname.linkedin-watcher.plist \
   ~/Library/LaunchAgents/com.yourname.linkedin-watcher.plist

# Edit it in your editor, then:
launchctl load ~/Library/LaunchAgents/com.yourname.linkedin-watcher.plist

# Check it's running:
launchctl list | grep linkedin
```

---

### 6. Set up the daily poster

```bash
cp launchagents/com.yourname.linkedin-poster.plist \
   ~/Library/LaunchAgents/com.yourname.linkedin-poster.plist

# Edit it, then:
launchctl load ~/Library/LaunchAgents/com.yourname.linkedin-poster.plist
```

The poster fires at 13:00 daily, skips weekends, and adds a random human-like delay (0–30 min or 90–120 min) before actually calling the API.

---

### 7. Test the pipeline

```bash
bash test-linkedin.sh
```

This drops a sample `.md` file into your vault root.  
You should see the watcher pick it up in the logs within ~10 seconds.

---

## Logs

```bash
# Watcher logs
tail -f ~/claude-agent/logs/linkedin.log

# Poster logs
tail -f ~/claude-agent/logs/linkedin-poster.log
```

---

## Vault structure after running

```
2-queue/
├── 001-most-people-overthink-their.md   ← next to post (position 1)
├── 002-the-real-reason-we-moved-to.md
└── 003-three-things-japan-taught-me.md
```

Each queue file has YAML frontmatter with `position`, `status`, `polished_at`, etc.  
You can edit the post text directly in Obsidian before it goes live.  
To skip a post: change `status: ready` → `status: skip` in the frontmatter.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `401` from LinkedIn | Token expired → `node linkedin-refresh.js` |
| `403` from LinkedIn | App doesn't have "Share on LinkedIn" product yet |
| No refresh token on auth | Add "Sign In with LinkedIn using OpenID Connect" product to your app |
| Watcher doesn't see files | Check `OBSIDIAN_VAULT` path; iCloud may delay syncing `.m4a` files |
| Claude CLI not found | Set `CLAUDE_BIN` env var or ensure `~/bin/claude` exists |
| `ELEVENLABS_API_KEY not set` | Add the key to your env or LaunchAgent plist |

---

## Credits

Built with:
- [Claude Code CLI](https://claude.ai/code) — post polishing + queue decisions
- [ElevenLabs Scribe v2](https://elevenlabs.io) — voice transcription
- [LinkedIn UGC Posts API v2](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/community-management/shares/ugc-post-api)
- [chokidar](https://github.com/paulmillr/chokidar) — file watching
- macOS LaunchAgents — background process management
