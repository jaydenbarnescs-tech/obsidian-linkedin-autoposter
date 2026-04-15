#!/bin/bash
# Drop a test note into the Obsidian inbox to verify the pipeline works end-to-end.
# Usage: bash test-linkedin.sh

VAULT="${OBSIDIAN_VAULT_SKIP_DEFAULT:-$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/MGC}"
INBOX="$VAULT"

echo "Dropping test note into: $INBOX"
cat > "$INBOX/linkedin-test-$(date +%s).md" << 'EOF'
Today I realised that most people overthink their LinkedIn posts.
They spend hours writing the perfect thing when really the best posts
come from just talking out loud for 2 minutes about something that
happened that day. Like this one. I literally just said this into my phone.
EOF

echo "Done. Tailing log..."
tail -f ~/claude-agent/logs/linkedin.log
