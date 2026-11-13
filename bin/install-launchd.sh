#!/bin/zsh
# Installs (or reinstalls) the 5-minute launchd job. Logs: ~/.release-pipeline/launchd.log
# It starts node directly: on an external disk macOS asks once to let node read it; a /bin/zsh
# started by launchd cannot be granted that.
set -e
D=${0:a:h}
NODE=$(command -v node)
P=$HOME/Library/LaunchAgents/com.release-pipeline.tick.plist
mkdir -p $HOME/.release-pipeline
cat > $P <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.release-pipeline.tick</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$D/rp.js</string><string>tick-all</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${NODE:h}:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/.release-pipeline/launchd.log</string>
  <key>StandardErrorPath</key><string>$HOME/.release-pipeline/launchd.log</string>
</dict></plist>
PLIST
launchctl bootout gui/$(id -u) $P 2>/dev/null || true
launchctl bootstrap gui/$(id -u) $P
echo "installed: $P"
