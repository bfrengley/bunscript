#!/usr/bin/env bun

import { $ } from "bun";
import util from "util";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { exit } from "node:process";

function usage(): void {
  console.log(`\
Usage: bunscript new <script-name> [--edit] [--no-link] - Create a new bun script with the given name
       bunscript rm <script-name>                       - Removes an existing script
       bunscript link                                   - Link existing scripts into $PATH
       bunscript unlink [script-name]                   - Unlink existing scripts from $PATH (only the named script if provided)
       bunscript --help|-h                              - Print this message
`);
}

const SCRIPT_DIR = "./scripts";

if (Bun.argv.length <= 2) {
  usage();
  exit(2);
}

try {
  switch (Bun.argv[2]) {
    case "new": {
      await createscript(Bun.argv.slice(3));
      break;
    }
    case "rm": {
      await removescript(Bun.argv[3] ?? "");
      break;
    }
    case "link": {
      await linkscripts();
      break;
    }
    case "unlink": {
      await unlinkscripts(Bun.argv[3] ?? "");
      break;
    }
    case "--help":
    case "-h": {
      usage();
      break;
    }
    default: {
      console.error("unknown command", Bun.argv[2]);
      usage();
      exit(2);
    }
  }
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
  console.error(e);
}

async function createscript(args: string[]): Promise<void> {
  const { values, positionals } = util.parseArgs({
    args,
    options: {
      edit: { type: "boolean" },
      "no-link": { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });

  if (positionals.length !== 1) {
    usage();
    exit(2);
  }
  const [scriptName] = positionals;

  const scriptTemplate = `#!/usr/bin/env bun

import { $ } from "bun";

await $\`echo Hello, world!\`;
`;

  if (!scriptName) {
    usage();
    exit(2);
  }

  if (scriptName === "bunscript") {
    // maybe there's a better way to handle this
    console.error("the name 'bunscript' will collide with this file!");
    exit(1);
  }

  const scriptRelPath = path.join(SCRIPT_DIR, scriptName + ".ts");
  const scriptPath = path.normalize(path.join(__dirname, scriptRelPath));
  const scriptFile = Bun.file(scriptPath);
  if (await scriptFile.exists()) {
    console.error(`script ${scriptName} already exists`);
    exit(1);
  }

  Bun.write(scriptFile, scriptTemplate);
  console.log(`created new script ${scriptName} at ${scriptPath}`);

  if (values.edit) {
    await $`$EDITOR ${scriptPath}`;
  }

  if (values["no-link"] !== true) {
    await linkScripts([scriptRelPath]);
  }
}

async function removescript(script: string): Promise<void> {
  if (!script) {
    usage();
    exit(2);
  }

  const scriptPath = absoluteScriptPath(script);
  const scriptFile = Bun.file(scriptPath);
  if (!(await scriptFile.exists())) {
    console.error(`couldn't find script ${script}`);
    exit(1);
  }

  await unlinkscripts(script);

  await scriptFile.delete();
  console.log("removed script file", scriptPath);
}

async function linkscripts(): Promise<void> {
  const scripts: string[] = [];
  for (const script of await readdir(absoluteScriptPath())) {
    if (!script || !script.endsWith(".ts")) {
      continue;
    }

    const source = absoluteScriptPath(script);
    scripts.push(source);
  }

  await linkScripts(scripts);
}

async function linkScripts(scriptPaths: string[]): Promise<void> {
  const self = "bunscript";
  const pkgFile = Bun.file(path.join(__dirname, "package.json"));
  const pkgJson: PackageJson = await pkgFile.json();

  for (const scriptPath of scriptPaths) {
    const scriptName = path.basename(scriptPath, ".ts");
    if (scriptName === self) {
      console.warn("ignoring colliding script", self);
      continue;
    }
    pkgJson.bin[scriptName] = scriptPath;
    console.log(
      `linked script ${scriptName} at ${absoluteScriptPath(scriptName)}`
    );
  }

  // always ensure that this file remains linked
  pkgJson.bin[self] = `./${self}.ts`;
  Bun.write(pkgFile, JSON.stringify(pkgJson, null, 2));
  const res = await $`bun link -f`.cwd(__dirname).nothrow().quiet();
  if (res.exitCode !== 0) {
    throw new Error(`failed to link scripts: ${res.stderr.toString("utf-8")}`);
  }
}

type PackageJson = {
  bin: Record<string, string>;
};

async function unlinkscripts(limitToScript: string): Promise<void> {
  const self = "bunscript";
  const pkgFile = Bun.file(path.join(__dirname, "package.json"));
  const pkgJson: PackageJson = await pkgFile.json();

  for (const k of Object.keys(pkgJson.bin)) {
    if (k === self) {
      // don't accidentally unlink the main script
      continue;
    }

    if (limitToScript && k !== limitToScript) {
      continue;
    }

    delete pkgJson.bin[k];
    console.log(`unlinked script ${k}`);
  }

  // unlink before we remove the scripts to make sure they get removed
  const unlinkRes = await $`bun unlink`.cwd(__dirname).nothrow().quiet();
  if (unlinkRes.exitCode !== 0) {
    throw new Error(
      `failed to unlink scripts: unlink ${unlinkRes.stderr.toString("utf-8")}`
    );
  }

  // save and relink
  Bun.write(pkgFile, JSON.stringify(pkgJson, null, 2));
  const res = await $`bun link`.cwd(__dirname).nothrow().quiet();
  if (res.exitCode !== 0) {
    throw new Error(
      `failed to unlink scripts: relink ${res.stderr.toString("utf-8")}`
    );
  }
}

function absoluteScriptPath(script?: string): string {
  if (!script) {
    // just the script dir
    return path.normalize(path.join(__dirname, SCRIPT_DIR));
  }

  if (!script.endsWith(".ts")) {
    script += ".ts";
  }
  return path.normalize(path.join(__dirname, SCRIPT_DIR, script));
}
