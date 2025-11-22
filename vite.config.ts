import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

export default defineConfig(() => {
  // Configure allowed hosts via environment variable:
  // EIGENFOLIO_ALLOWED_HOSTS
  //
  // Examples:
  //   EIGENFOLIO_ALLOWED_HOSTS=example.net
  //   EIGENFOLIO_ALLOWED_HOSTS=example.net,example.com
  //   EIGENFOLIO_ALLOWED_HOSTS=all
  const rawAllowedHosts = process.env.EIGENFOLIO_ALLOWED_HOSTS;

  let allowedHosts: string[] | "all";

  if (!rawAllowedHosts) {
    // Default: allow all hosts (recommended to override in production)
    allowedHosts = "all";
  } else if (rawAllowedHosts === "all" || rawAllowedHosts === "*") {
    allowedHosts = "all";
  } else {
    allowedHosts = rawAllowedHosts
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean);
  }

  return {
    envPrefix: ["VITE_", "DISABLE_"],
    plugins: [react()],
    server: {
      host: "0.0.0.0",
      port: 5173,
      strictPort: true,
      allowedHosts,
    },
  };
});
