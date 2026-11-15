#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HELPER="$SCRIPT_DIR/mac-helper.sh"

chmod +x "$HELPER" "$SCRIPT_DIR/install-mac.sh" "$PROJECT_DIR/Start Control Tower.command" "$PROJECT_DIR/Opret app (Mac).command"

if ! command -v osacompile >/dev/null 2>&1; then
  echo "Fejl: osacompile blev ikke fundet (kræver macOS)." >&2
  exit 1
fi

APP_DIR="$HOME/Applications"
APP_PATH="$APP_DIR/Control Tower.app"
mkdir -p "$APP_DIR"
rm -rf "$APP_PATH"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

APPLESCRIPT_FILE="$TMP_DIR/control-tower.applescript"
cat > "$APPLESCRIPT_FILE" <<EOF
property helperPath : "$HELPER"

on run
	try
		do shell script quoted form of helperPath & " status"
		do shell script quoted form of helperPath & " open"
		return
	end try

	set needsRoot to false
	try
		do shell script quoted form of helperPath & " has-root"
	on error errMsg number errNum
		if errNum is 2 then
			display dialog "Node.js blev ikke fundet på denne Mac." & return & return & "Installer Node.js 20 eller nyere fra https://nodejs.org og prøv igen." with title "Control Tower" buttons {"OK"} default button "OK" with icon stop
			quit
			return
		end if
		set needsRoot to true
	end try

	set rootArg to ""
	if needsRoot then
		try
			set chosen to choose folder with prompt "Vælg mappen hvor dine git-projekter ligger:"
			set rootArg to POSIX path of chosen
		on error
			quit
			return
		end try
	end if

	try
		if rootArg is not "" then
			do shell script quoted form of helperPath & " start " & quoted form of rootArg
		else
			do shell script quoted form of helperPath & " start"
		end if
	on error errMsg
		if errMsg contains "er optaget" then
			set portNum to "4317"
			try
				set portNum to do shell script "printf %s " & quoted form of errMsg & " | sed -nE 's/.*Port ([0-9]+) er optaget.*/\\1/p' | head -n 1"
				if portNum is "" then set portNum to "4317"
			end try
			set res to display dialog errMsg & return & return & "Vil du åbne http://127.0.0.1:" & portNum & " i browseren i stedet?" with title "Control Tower" buttons {"Luk", "Åbn i browser"} default button "Åbn i browser" with icon caution
			if button returned of res is "Åbn i browser" then
				do shell script "open " & quoted form of ("http://127.0.0.1:" & portNum & "/")
			end if
		else
			display dialog "Control Tower kunne ikke starte:" & return & return & errMsg with title "Control Tower" buttons {"OK"} default button "OK" with icon stop
		end if
		quit
	end try
end run

on reopen
	try
		do shell script quoted form of helperPath & " open"
	end try
end reopen

on idle
	try
		do shell script quoted form of helperPath & " status"
		return 5
	on error
		quit
		return 5
	end try
end idle

on quit
	try
		do shell script quoted form of helperPath & " stop"
	end try
	continue quit
end quit
EOF

osacompile -s -o "$APP_PATH" "$APPLESCRIPT_FILE"

# Tilføj Control Tower-ikon hvis Node + iconutil er tilgængelige
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  for c in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$c" ]; then NODE_BIN="$c"; break; fi
  done
fi

if [ -n "$NODE_BIN" ] && command -v iconutil >/dev/null 2>&1; then
  ICONSET_DIR="$TMP_DIR/ControlTower.iconset"
  "$NODE_BIN" "$SCRIPT_DIR/make-icons.js" --iconset "$ICONSET_DIR"
  iconutil -c icns "$ICONSET_DIR" -o "$APP_PATH/Contents/Resources/applet.icns"
fi

if [ -x /usr/libexec/PlistBuddy ]; then
  PLIST="$APP_PATH/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleName Control Tower" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleName string Control Tower" "$PLIST"
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Control Tower" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Control Tower" "$PLIST"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier local.control-tower.app" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string local.control-tower.app" "$PLIST"
fi

# Opdater Desktop-alias hvis muligt (ikke-fatalt hvis headless)
if [ -d "$HOME/Desktop" ]; then
  rm -f "$HOME/Desktop/Control Tower"
  osascript -e "tell application \"Finder\" to make alias file to POSIX file \"$APP_PATH\" at POSIX file \"$HOME/Desktop\" with properties {name:\"Control Tower\"}" >/dev/null 2>&1 || true
fi

echo "Oprettede macOS-app: $APP_PATH"
echo "Du kan nu starte Control Tower via Spotlight (Cmd+Mellemrum -> Control Tower), Dock eller Skrivebordet."
echo "Tip: Klik på ikonet i Docken for at genåbne browseren, og brug Cmd+Q (eller højreklik -> Slut) for at stoppe Control Tower pænt."
