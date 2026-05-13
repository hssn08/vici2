/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: "standalone",
  experimental: {
    instrumentationHook: false,
  },
  // Tree-shake lucide-react icons to a per-icon import path so the
  // agent-route bundle stays under the §12 budget.
  modularizeImports: {
    "lucide-react": {
      transform: "lucide-react/dist/esm/icons/{{kebabCase member}}",
      preventFullImport: true,
    },
  },
};

export default nextConfig;
