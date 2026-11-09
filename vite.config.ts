import basicSsl from "@vitejs/plugin-basic-ssl";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // basicSsl serves the dev server over HTTPS, which Kontent.ai requires for custom apps.
  plugins: [react(), basicSsl()],
});
