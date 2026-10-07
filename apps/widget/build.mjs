// `pnpm --filter @crumb/widget build`: widget.js and widget-record.js into the
// dashboard's public/. The stylesheet is one string in styles.ts, which
// --minify can't see inside, so minifyCss (unit-tested) runs on it here, once,
// instead of in every customer's browser. `pnpm dev` ships it as written.
import { build, transform } from "esbuild";
import { readFile } from "node:fs/promises";

const bakedCss = {
  name: "baked-css",
  setup(b) {
    b.onLoad({ filter: /[\\/]styles\.ts$/ }, async ({ path }) => {
      const { code } = await transform(await readFile(path, "utf8"), { loader: "ts", format: "esm" });
      const { css, minifyCss } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
      return { loader: "js", contents: `export const css = ${JSON.stringify(minifyCss(css))};` };
    });
  },
};

const common = { bundle: true, minify: true, format: "iife", target: "es2018", logLevel: "info" };
await build({ ...common, entryPoints: ["src/widget.ts"], outfile: "../dashboard/public/widget.js", plugins: [bakedCss] });
await build({ ...common, entryPoints: ["src/widget-record.ts"], outfile: "../dashboard/public/widget-record.js" });
