import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerServiceCommands } from "../src/cli/service.js";
import { VERSION } from "../src/version.js";
import { makeRoots, tmpHome } from "./helpers.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("update's manual-server restart notice (#597)", () => {
  it.each([
    { name: "RC to final at the same version and commit", before: { tag: "v0.2.9-rc.1", commit: "abc1234" }, after: { tag: "v0.2.9", commit: "abc1234" }, fresh: VERSION, warn: true },
    { name: "the same release again", before: { tag: "v0.2.9" }, after: { tag: "v0.2.9" }, fresh: VERSION, warn: false },
    { name: "older bundles with only commits", before: { commit: "abc1234" }, after: { commit: "def5678" }, fresh: VERSION, warn: true },
    { name: "a server without a known build", before: {}, after: { tag: "v0.2.9" }, fresh: VERSION, warn: true },
    { name: "version changes without build metadata", before: {}, after: {}, fresh: "0.2.10", warn: true },
  ])("handles $name", async ({ before, after, fresh, warn }) => {
    const dir = tmpHome();
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    // Exercise the actual update command and status API, with an installer that only swaps metadata.
    const bundle = path.join(dir, "app");
    const cli = path.join(bundle, "neatroots", "dist", "cli.js");
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, `console.log(${JSON.stringify(fresh)});\n`);
    fs.writeFileSync(path.join(bundle, ".neatroots-bundle"), JSON.stringify(before));
    fs.writeFileSync(path.join(dir, "next.json"), JSON.stringify(after));
    fs.writeFileSync(path.join(bundle, "install.sh"), 'cp "$NEATROOTS_INSTALL_DIR/next.json" "$NEATROOTS_INSTALL_DIR/app/.neatroots-bundle"\n');
    const argv = process.argv;
    process.argv = [process.execPath, cli];
    cleanup.push(() => { process.argv = argv; });
    vi.spyOn(os, "homedir").mockReturnValue(dir); // No developer service can be restarted.
    vi.stubEnv("NEATROOTS_HOME", path.join(dir, "home"));
    const server = await makeRoots({ serve: true, noEngine: true });
    cleanup.push(server.close);
    vi.stubEnv("NEATROOTS_PORT", String(server.roots.config.port));
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerServiceCommands(program);
    await program.parseAsync(["update"], { from: "user" });

    const message = output.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(message.includes("Restart it to use")).toBe(warn);
    if ("tag" in before && before.tag && warn) expect(message).toContain(before.tag);
    if ("tag" in after && after.tag && warn) expect(message).toContain(after.tag);
    // The running server must keep its startup identity after the installer replaces the file.
    const status = await fetch(`${server.url}/api/status`).then((r) => r.json());
    expect(status.version).toBe(VERSION);
    expect(status.build).toBe(("tag" in before && before.tag) || ("commit" in before && before.commit) || null);
  });
});
