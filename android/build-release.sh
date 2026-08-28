#!/usr/bin/env bash
# Builds the signed release Android App Bundle (.aab) — the format Google
# Play requires for new app uploads (plain .apk uploads are no longer
# accepted for new apps). Needs android/keystore.properties to exist
# (gitignored, generated once locally — see build.gradle's signingConfigs
# block for how it's loaded) or the resulting bundle won't be signed and
# Play Console will reject the upload.
#
# Same three environment fixes as build-debug.sh — see that file's
# comments for the full explanation of each.
set -e
cd "$(dirname "$0")"

if [ ! -f "keystore.properties" ]; then
  echo "ERROR: android/keystore.properties not found — the release bundle would be unsigned."
  echo "Generate the upload keystore first (see the commit that added build.gradle's signingConfigs)."
  exit 1
fi

export JAVA_HOME="/c/Users/DeLL Latitude 5540/.gradle/jdks/eclipse_adoptium-21-amd64-windows.2"
export TEMP="A:\tmp"
export TMP="A:\tmp"
export JAVA_TOOL_OPTIONS="-Djava.io.tmpdir=A:\tmp"
mkdir -p /a/tmp

./gradlew.bat bundleRelease --no-daemon
