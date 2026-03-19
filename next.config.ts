import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Ensures server-only modules are never bundled into the client
  serverExternalPackages: ["@supabase/supabase-js"],
};

export default nextConfig;
