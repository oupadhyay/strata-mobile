#!/usr/bin/env bash
# Standalone ARM64 test APK; no device, Metro server, EAS account or publishing.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=.agents/android-env
source "$repo_root/.agents/android-env"
export CI=1 EXPO_NO_TELEMETRY=1 NODE_ENV=production
export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:+$JAVA_TOOL_OPTIONS }-XX:ActiveProcessorCount=2"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=1536"

pnpm --dir "$repo_root" exec expo prebuild --platform android --no-install --skip-dependency-update react,react-native

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
# Gradle's --max-workers does not bound Ninja or Metro workers.
cat > "$scratch/low-memory.gradle" <<'GRADLE'
gradle.beforeProject { project ->
    ["com.android.application", "com.android.library"].each { plugin ->
        project.pluginManager.withPlugin(plugin) {
            project.extensions.getByName("android").defaultConfig.externalNativeBuild.cmake.arguments.addAll([
                "-DCMAKE_JOB_POOLS=strata_native=1",
                "-DCMAKE_JOB_POOL_COMPILE=strata_native",
                "-DCMAKE_JOB_POOL_LINK=strata_native"
            ])
        }
    }
    project.pluginManager.withPlugin("com.facebook.react") {
        project.extensions.getByName("react").extraPackagerArgs.addAll(["--max-workers", "1"])
    }
}
GRADLE

gradle=(
  "$repo_root/android/gradlew" --project-dir "$repo_root/android"
  --no-daemon --max-workers=1 --console=plain -I "$scratch/low-memory.gradle"
  -PreactNativeArchitectures=arm64-v8a -Pexpo.useLegacyPackaging=true
  -Pkotlin.compiler.execution.strategy=in-process -Dorg.gradle.parallel=false
)
# Keep Metro and source compilation away from R8's larger resident heap.
"${gradle[@]}" app:createBundleReleaseJsAndAssets app:compileReleaseSources \
  '-Dorg.gradle.jvmargs=-Xmx1024m -XX:MaxMetaspaceSize=512m -XX:ActiveProcessorCount=2 -XX:G1PeriodicGCInterval=30000'
# R8 needs a larger heap; reduce it before the separate vital-lint worker starts.
"${gradle[@]}" app:minifyReleaseWithR8 \
  '-Dorg.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=512m -XX:ActiveProcessorCount=2 -XX:G1PeriodicGCInterval=30000'
"${gradle[@]}" app:assembleRelease -Pandroid.experimental.lint.heapSize=1024m \
  '-Dorg.gradle.jvmargs=-Xmx1024m -XX:MaxMetaspaceSize=512m -XX:ActiveProcessorCount=2 -XX:G1PeriodicGCInterval=30000'

apk="$repo_root/android/app/build/outputs/apk/release/app-release.apk"
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify "$apk"
"$ANDROID_HOME/build-tools/36.0.0/zipalign" -c -P 16 4 "$apk"
unzip -tq "$apk"

version="$(node -p 'require(process.argv[1]).expo.version' "$repo_root/app.json")"
output="$repo_root/.amp/in/artifacts/strata-test-$version-arm64-v8a.apk"
mkdir -p "$(dirname -- "$output")"
cp "$apk" "$output"
sha256sum "$output"
printf '\nTest APK: %s\nUses the template debug signing key, not production signing.\n' "$output"
