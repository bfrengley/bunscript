#!/usr/bin/env bun

import { $ } from "bun";
import util from "util";
import {
  exists,
  readlink as fsreadlink,
  realpath,
  readdir,
  symlink,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { exit } from "node:process";

function usage(): void {
  console.log(`\
Usage: bunscript new <script-name> [--edit] [--no-link] - Create a new bun script with the given name
       bunscript rm <script-name>                       - Removes an existing script
       bunscript link                                   - Link existing scripts into $PATH
       bunscript unlink [script-name]                   - Unlink existing scripts from $PATH (only the named script if provided)
       bunscript --help|-h                              - Print this message
       
The location into which scripts will be linked will be chosen from the following list, in order of preference:
  - $BUNSCRIPT_BIN_DIR
  - $HOME/bin
  - $HOME/.local/bin
If none of those directories exist, linking will fail.

The shebang of new scripts can be controlled using the $BUNSCRIPT_SHEBANG variable. If not set, it defaults to \`#!/usr/bin/env bun\`.
`);
}

const SCRIPT_DIR = path.join(__dirname, "scripts");

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

  const scriptTemplate = `${Bun.env.BUNSCRIPT_SHEBANG || "#!/usr/bin/env bun"}

import { $ } from "bun";

await $\`echo Hello, world!\`;
`;

  if (!scriptName) {
    usage();
    exit(2);
  }

  const scriptPath = path.join(SCRIPT_DIR, scriptName + ".ts");
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
    const linkDir = (await findLinkDirs())[0]!;
    await linkScript(linkDir, scriptPath);
  }
}

async function removescript(script: string): Promise<void> {
  if (!script) {
    usage();
    exit(2);
  }

  const scriptPath = path.join(SCRIPT_DIR, script + ".ts");
  const scriptFile = Bun.file(scriptPath);
  if (!(await scriptFile.exists())) {
    console.error(`couldn't find script ${script}`);
    exit(1);
  }

  await unlinkscripts(script);

  await scriptFile.delete();
  console.log("removed script", script);
}

async function linkscripts(): Promise<void> {
  let exitCode = 0;

  const linkdir = (await findLinkDirs())[0]!; // ! is safe since at least one is always returned

  for (const script of await readdir(SCRIPT_DIR)) {
    if (!script || !script.endsWith(".ts")) {
      continue;
    }

    const source = await realpath(path.join(SCRIPT_DIR, script));
    if (!(await linkScript(linkdir, source))) {
      exitCode = 1;
    }
  }

  exit(exitCode);
}

async function linkScript(
  linkDir: string,
  scriptPath: string
): Promise<boolean> {
  const scriptName = path.basename(scriptPath, ".ts");
  const target = path.join(linkDir, scriptName);
  const state = await linkState(scriptPath, target);

  if (state === LinkState.other) {
    console.error(`failed to link ${scriptName}: ${target} already exists`);
    return false;
  } else if (state === LinkState.valid) {
    console.log(`skipped ${scriptName}: link already exists`);
  } else {
    await symlink(scriptPath, target, "file");
    await $`chmod +x ${target}`;
    console.log(`linked ${scriptName} as ${target}`);
  }

  return true;
}

async function unlinkscripts(limitToScript: string): Promise<void> {
  const linkdirs = await findLinkDirs();

  for (const dir of linkdirs) {
    for (const file of await readdir(dir)) {
      if (!file) {
        continue;
      }

      const fullPath = path.join(dir, file);

      if (await fileIsLink(fullPath)) {
        const target = await fsreadlink(fullPath);
        if (path.dirname(target) !== SCRIPT_DIR) {
          continue;
        }

        const scriptName = path.basename(target, ".ts");
        if (limitToScript && scriptName !== limitToScript) {
          continue;
        }

        await unlink(fullPath);
        console.log("unlinked link to script", scriptName);
      }
    }
  }
}

const enum LinkState {
  /** No link or file exists */
  none,
  /** A valid link to a known script exists */
  valid,
  /** A file exists that is not a valid link to a known script */
  other,
}

async function linkState(script: string, target: string): Promise<LinkState> {
  if (await fileIsLink(target)) {
    if ((await fsreadlink(target)) === script) {
      return LinkState.valid;
    }
    return LinkState.other;
  }

  if (await Bun.file(target).exists()) {
    return LinkState.other;
  }

  return LinkState.none;
}

/**
 * This is a workaround for `Bun.file(...).exists()` failing on symlinks on Windows. I don't think this will
 * work in shells other than bash but that's fine.
 */
async function fileIsLink(file: string): Promise<boolean> {
  if (process.platform === "win32") {
    return (await $`test -h ${file}`.nothrow().quiet()).exitCode === 0;
  }
  return (await Bun.file(file).stat()).isSymbolicLink();
}

async function readlink(file: string): Promise<string> {
  if (process.platform === "win32") {
    throw new Error("unimplemented");
  }
  return fsreadlink(file);
}

async function findLinkDirs(): Promise<string[]> {
  const dirs: string[] = [];
  if (Bun.env.BUNSCRIPT_BIN_DIR) {
    const dir = Bun.file(Bun.env.BUNSCRIPT_BIN_DIR);
    if (!path.isAbsolute(Bun.env.BUNSCRIPT_BIN_DIR)) {
      console.warn("$BUNSCRIPT_BIN_DIR is set to a relative path; ignoring");
    } else if (
      (await exists(Bun.env.BUNSCRIPT_BIN_DIR)) &&
      (await dir.stat()).isDirectory()
    ) {
      dirs.push(Bun.env.BUNSCRIPT_BIN_DIR);
    } else {
      console.warn(
        `$BUNSCRIPT_BIN_DIR is set to ${Bun.env.BUNSCRIPT_BIN_DIR} but no such valid directory exists; ignoring`
      );
    }
  }

  const home = Bun.env.HOME;
  if (home) {
    for (const d in [
      path.join(home, "bin"),
      path.join(home, ".local", "bin"),
    ]) {
      const dir = Bun.file(d);
      // use fs.exists not Bun.file().exists due to the latter returning false for directories
      if ((await exists(d)) && (await dir.stat()).isDirectory()) {
        dirs.push(d);
      }
    }
  } else {
    console.warn("$HOME isn't set"); // should never happen
  }

  if (dirs.length === 0) {
    throw new Error("could not find a directory suitable for script links");
  }
  return dirs;
}
