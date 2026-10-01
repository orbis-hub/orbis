#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync, watch } from "node:fs";
import { basename, join, resolve } from "node:path";
import { buildModule, initModule, packModule, readManifest } from "../src/index.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const dir = resolve(rest.find((a) => !a.startsWith("--")) ?? ".");
const flag = (n) => rest.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];

const help = `orbis-module <command> [dir] [options]

  build [dir]                 bundle src/ → dist/ (minified)
  watch [dir] [--dev=<hubDataDir>]
                              rebuild on change; with --dev, mirror the module into <hubDataDir>/modules-dev/<id>
                              so a running hub hot-reloads it
  pack  [dir] [--out=file]    create module.tgz for a release
  init  <dir> --id=<id> --name=<name>
                              write a module.json stub
`;

try {
  switch (cmd) {
    case "build":
      await buildModule(dir);
      break;
    case "watch": {
      const devRoot = flag("dev");
      const manifest = readManifest(dir);
      const mirror = devRoot ? join(resolve(devRoot), "modules-dev", manifest.id) : null;
      const sync = () => {
        if (!mirror) return;
        mkdirSync(mirror, { recursive: true });
        for (const f of ["module.json", "dist", "assets", "icon.svg", "icon.png"]) {
          const src = join(dir, f);
          const dst = join(mirror, f);
          if (!existsSync(src)) continue;
          rmSync(dst, { recursive: true, force: true });
          cpSync(src, dst, { recursive: true });
        }
        console.log(`[orbis-module] synced → ${mirror}`);
      };
      await buildModule(dir, { watch: true, onRebuild: sync });
      if (mirror) {
        sync();
        watch(join(dir, "module.json"), () => setTimeout(sync, 100));
      }
      break;
    }
    case "pack":
      await packModule(dir, flag("out"));
      break;
    case "init": {
      const id = flag("id") ?? basename(dir);
      initModule(dir, id, flag("name") ?? id);
      console.log(`[orbis-module] wrote ${join(dir, "module.json")}`);
      break;
    }
    default:
      console.log(help);
      process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  console.error(`[orbis-module] ${err.message}`);
  process.exit(1);
}
