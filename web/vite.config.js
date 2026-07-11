import { defineConfig } from "vite";

export default defineConfig({
  root: "./",
  build: {
    outDir: "../static",
    emptyOutDir: true,
    assetsDir: "assets",
    rollupOptions: {
      input: {
        main: "./index.html"
      }
    }
  }
});
