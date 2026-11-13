#!/bin/zsh
# Installs (or reinstalls) the 5-minute launchd job. Logs: ~/.release-pipeline/launchd.log
set -e
D=${0:a:h}
P=$HOME/Library/LaunchAgents/com.release-pipeline.tick.plist
mkdir -p $HOME/.release-pipeline
cat > $P <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.release-pipeline.tick</string>
  <key>ProgramArguments</key><array><string>/bin/zsh</string><string>$D/tick-all.sh</string></array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/.release-pipeline/launchd.log</string>
  <key>StandardErrorPath</key><string>$HOME/.release-pipeline/launchd.log</string>
</dict></plist>
PLIST
launchctl bootout gui/$(id -u) $P 2>/dev/null || true
launchctl bootstrap gui/$(id -u) $P
echo "installed: $P"
