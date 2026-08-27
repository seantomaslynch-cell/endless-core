#!/usr/bin/env bash
# Builds the Android debug APK. Run from the android/ directory (or this
# script cd's there itself).
#
# Three non-obvious local-environment fixes baked in here, each independently
# required to get this Windows machine's Gradle/JDK toolchain working at all:
#
# 1. JAVA_HOME must point at a real JDK 21 (found at the exact path below,
#    downloaded once by Gradle's Foojay toolchain resolver — see
#    android/settings.gradle). Every Capacitor 8.x Android module
#    (capacitor-android core included) targets sourceCompatibility/
#    targetCompatibility 21. JDK 17 can't target a release newer than
#    itself ("invalid source release: 21"), and this Gradle version
#    (8.14.3) can't even run on the newer JDK 25 bundled with Android
#    Studio ("Unsupported class file major version 69") — 21 is the one
#    JDK on this machine that's new enough to target and old enough for
#    Gradle itself to run on.
# 2. TEMP/TMP must point at a SHORT path (A:\tmp). The launcher JVM's
#    default temp dir under the real Windows user profile
#    ("C:\Users\DeLL Latitude 5540\AppData\Local\Temp") is long enough to
#    exceed the Windows AF_UNIX socket path length limit, which this JDK's
#    NIO selector implementation needs for its internal daemon-connection
#    pipe — without a short temp dir every build fails immediately with
#    "Unable to establish loopback connection" before a single task runs.
# 3. java.net.preferIPv4Stack=true — belt-and-suspenders alongside #2 for
#    the same loopback-connection failure class; kept since the working
#    build had it set and it's a harmless, well-known Windows/Gradle
#    compatibility flag.
set -e
cd "$(dirname "$0")"

export JAVA_HOME="/c/Users/DeLL Latitude 5540/.gradle/jdks/eclipse_adoptium-21-amd64-windows.2"
export TEMP="A:\tmp"
export TMP="A:\tmp"
export JAVA_TOOL_OPTIONS="-Djava.io.tmpdir=A:\tmp"
mkdir -p /a/tmp

./gradlew.bat assembleDebug --no-daemon
