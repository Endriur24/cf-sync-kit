import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import ssrPlugin from "vite-ssr-components/plugin";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const frameworkRoot = path.resolve(__dirname, "../..");

export default defineConfig({
  plugins: [cloudflare(), ssrPlugin(), tailwindcss()],
  resolve: {
    alias: [
      {
        find: /^cf-sync-kit\/server$/,
        replacement: path.resolve(frameworkRoot, "src/server.ts"),
      },
      {
        find: "cf-sync-kit",
        replacement: path.resolve(frameworkRoot, "src/index.ts"),
      },
    ],
  },
});
