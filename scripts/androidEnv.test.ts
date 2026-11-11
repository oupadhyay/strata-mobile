import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

const script = path.resolve(__dirname, "../.agents/android-env");

it.each([
  { version: 17, initial: undefined, explicit: false },
  { version: 21, initial: undefined, explicit: false },
  { version: 21, initial: "/missing/debian-12-jdk", explicit: false },
  { version: 21, initial: undefined, explicit: true },
])("activates the installed JDK ($version, inherited=$initial, explicit=$explicit)", ({ version, initial, explicit }) => {
  const root = mkdtempSync(path.join(tmpdir(), "strata-java-"));
  try {
    const installed = path.join(root, `installed-jdk-${version}`);
    const custom = path.join(root, "custom-jdk-17");
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    for (const jdk of [installed, custom]) {
      mkdirSync(path.join(jdk, "bin"), { recursive: true });
      writeFileSync(path.join(jdk, "bin/javac"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    symlinkSync(path.join(installed, "bin/javac"), path.join(bin, "javac"));
    for (const tool of ["dirname", "readlink"]) symlinkSync(`/usr/bin/${tool}`, path.join(bin, tool));
    const javaHome = explicit ? custom : initial;
    const expected = explicit ? custom : installed;
    const output = execFileSync("/bin/bash", ["-c", `set -euo pipefail
source "$1"
source "$1"
printf '%s\\n' "$JAVA_HOME" "$(command -v javac)"`, "_", script], {
      env: { HOME: root, PATH: bin, NODE_ENV: "test", ...(javaHome !== undefined && { JAVA_HOME: javaHome }) },
      encoding: "utf8",
    });
    expect(output).toBe(`${expected}\n${expected}/bin/javac\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
