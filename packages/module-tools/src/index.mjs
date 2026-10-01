// Build tooling for Orbis modules.
// Server bundle: ESM for node, everything bundled except node builtins (runs inside the hub via import()).
// Client bundle: ESM for the browser; react, react-dom, react/jsx-runtime, @orbis/sdk/client and @orbis/ui are
// NOT bundled but resolved at runtime from window.__ORBIS__ so there is exactly one React instance.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as esbuild from "esbuild";
import * as tar from "tar";

const HOST_GLOBALS = {
  react: "React",
  "react-dom": "ReactDOM",
  "react/jsx-runtime": "jsxRuntime",
  "react/jsx-dev-runtime": "jsxRuntime",
  "@orbis/sdk/client": "sdk",
  "@orbis/ui": "ui",
};

/** esbuild plugin: rewrite host-provided packages to `window.__ORBIS__.<key>` re-exports. */
function hostBridgePlugin() {
  return {
    name: "orbis-host-bridge",
    setup(build) {
      const filter = new RegExp(`^(${Object.keys(HOST_GLOBALS).map((k) => k.replace(/[/.]/g, "\\$&")).join("|")})$`);
      build.onResolve({ filter }, (args) => ({ path: args.path, namespace: "orbis-host" }));
      build.onLoad({ filter: /.*/, namespace: "orbis-host" }, (args) => {
        const key = HOST_GLOBALS[args.path];
        const named = NAMED_EXPORTS[args.path] ?? [];
        const lines = [
          `const __h = (typeof window !== "undefined" && window.__ORBIS__) || (() => { throw new Error("Orbis host bridge missing (window.__ORBIS__)"); })();`,
          `const __m = __h[${JSON.stringify(key)}];`,
          `export default __m.default ?? __m;`,
          ...named.map((n) => `export const ${n} = __m[${JSON.stringify(n)}];`),
        ];
        return { contents: lines.join("\n"), loader: "js" };
      });
    },
  };
}

// Named exports we expose from the host for each bridged package. Keep in sync with apps/web/lib/host-bridge.ts.
const NAMED_EXPORTS = {
  react: [
    "Children", "Component", "Fragment", "Profiler", "PureComponent", "StrictMode", "Suspense", "cloneElement", "createContext",
    "createElement", "createRef", "forwardRef", "isValidElement", "lazy", "memo", "startTransition", "use", "useActionState",
    "useCallback", "useContext", "useDebugValue", "useDeferredValue", "useEffect", "useId", "useImperativeHandle",
    "useInsertionEffect", "useLayoutEffect", "useMemo", "useOptimistic", "useReducer", "useRef", "useState",
    "useSyncExternalStore", "useTransition", "version",
  ],
  "react-dom": ["createPortal", "flushSync", "version"],
  "react/jsx-runtime": ["jsx", "jsxs", "Fragment"],
  "react/jsx-dev-runtime": ["jsx", "jsxs", "jsxDEV", "Fragment"],
  "@orbis/sdk/client": ["host", "defineClient", "useModule", "useModuleApi", "useModuleEvents", "useModuleSettings", "useModuleDevices", "useModuleQuery", "getModuleContext"],
  "@orbis/ui": [
    "cx", "Window", "Button", "Icon", "iconNames", "Tabs", "Tab", "Field", "Input", "Textarea", "Select", "Checkbox", "Switch", "Chip",
    "Spinner", "Empty", "Modal", "Menu", "ToastProvider", "useToast", "Hr", "Kbd", "useStableId", "ICONS",
    "WeatherIcon", "weatherIconNames", "describeWmo", "ACCENTS", "accentById", "accentStyle", "isDarkTheme",
  ],
};

export function readManifest(dir) {
  const file = join(dir, "module.json");
  if (!existsSync(file)) throw new Error(`module.json not found in ${dir}`);
  return JSON.parse(readFileSync(file, "utf8"));
}

function entries(dir, manifest) {
  const src = join(dir, "src");
  const server = manifest.entry?.server ? (existsSync(join(src, "server.ts")) ? join(src, "server.ts") : join(src, "server.tsx")) : null;
  const client = manifest.entry?.client ? (existsSync(join(src, "client.tsx")) ? join(src, "client.tsx") : join(src, "client.ts")) : null;
  return { server, client };
}

export async function buildModule(dir, { watch = false, minify = !watch, onRebuild } = {}) {
  dir = resolve(dir);
  const manifest = readManifest(dir);
  const { server, client } = entries(dir, manifest);
  const dist = join(dir, "dist");
  if (!watch) rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });

  const common = {
    bundle: true,
    format: "esm",
    sourcemap: true,
    minify,
    logLevel: "info",
    define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
  };
  const builds = [];
  if (server) {
    builds.push({
      ...common,
      entryPoints: [server],
      outfile: join(dir, manifest.entry.server),
      platform: "node",
      target: "node22",
      packages: "bundle",
      // cjs dependencies (debug, etc.) call require() at runtime; give the esm bundle one
      banner: { js: 'import { createRequire as __orbisCreateRequire } from "node:module"; const require = __orbisCreateRequire(import.meta.url);' },
      external: ["better-sqlite3", "hono", "hono/*"],
    });
  }
  if (client) {
    builds.push({
      ...common,
      entryPoints: [client],
      outfile: join(dir, manifest.entry.client),
      platform: "browser",
      target: ["es2022"],
      jsx: "automatic",
      plugins: [hostBridgePlugin()],
    });
  }
  if (builds.length === 0) throw new Error("manifest.entry has neither server nor client");

  if (watch) {
    const ctxs = await Promise.all(
      builds.map((b) =>
        esbuild.context({
          ...b,
          plugins: [
            ...(b.plugins ?? []),
            { name: "notify", setup(bl) { bl.onEnd((r) => { if (r.errors.length === 0) onRebuild?.(); }); } },
          ],
        }),
      ),
    );
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log(`[orbis-module] watching ${manifest.id}…`);
    return () => Promise.all(ctxs.map((c) => c.dispose()));
  }
  await Promise.all(builds.map((b) => esbuild.build(b)));
  console.log(`[orbis-module] built ${manifest.id}@${manifest.version} → dist/`);
  return null;
}

/** Create module.tgz with module.json, dist/, README and optional assets/ – what a GitHub release ships. */
export async function packModule(dir, outFile) {
  dir = resolve(dir);
  const manifest = readManifest(dir);
  const files = ["module.json", "dist"];
  for (const extra of ["README.md", "LICENSE", "assets", "icon.svg", "icon.png"]) if (existsSync(join(dir, extra))) files.push(extra);
  outFile = outFile ?? join(dir, "module.tgz");
  await tar.c({ gzip: true, file: outFile, cwd: dir, portable: true }, files);
  console.log(`[orbis-module] packed ${manifest.id}@${manifest.version} → ${outFile}`);
  return outFile;
}

/** Write a module.json stub (used by `orbis-module init`). */
export function initModule(dir, id, name) {
  mkdirSync(join(dir, "src"), { recursive: true });
  const manifest = {
    id,
    name,
    version: "0.1.0",
    description: "",
    minHub: "0.1.0",
    entry: { server: "dist/server.js", client: "dist/client.js" },
    widgets: [{ id: "main", name, defaultSize: { w: 3, h: 2 } }],
    pages: [],
    permissions: [],
  };
  writeFileSync(join(dir, "module.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
