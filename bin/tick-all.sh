#!/bin/zsh
# launchd runs this every 5 minutes. The phone is shared with other test runs on this Mac, so the
# whole tick runs inside the e2e lock when the Mac has one (~/.claude/bin/e2e-lock).
D=${0:a:h}
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
LOCK=$HOME/.claude/bin/e2e-lock
if [[ -x $LOCK ]]; then exec $LOCK -- "node $D/rp.js tick-all"; else exec node $D/rp.js tick-all; fi
