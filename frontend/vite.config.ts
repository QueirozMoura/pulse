import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
    css: false,
    env: { VITE_POLL_SECONDS: "30", VITE_ADMIN_URL: "" }, // cadência de 30 s só nos testes; o padrão real é 60 s
  },
});
