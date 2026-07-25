// @ts-check
import { defineConfig } from "astro/config";

import tailwindcss from "@tailwindcss/vite";

import sitemap from "@astrojs/sitemap";

// https://astro.build/config
export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
  },

  build: {
    inlineStylesheets: "always",
  },

  redirects: {
    "/line": "https://tinyurl.com/suhng",
  },

  site: "https://www.pablo666-brand.com",
  integrations: [sitemap()],
});
