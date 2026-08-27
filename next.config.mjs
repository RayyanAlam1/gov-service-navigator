/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  // onnxruntime-node ships native .node binaries; keep them external to the
  // server bundle so Next does not try to trace/inline them.
  serverExternalPackages: ['@huggingface/transformers', 'onnxruntime-node', 'pg', '@electric-sql/pglite'],
  eslint: {
    // Lint runs as its own CI step; a lint warning must not block a demo build.
    ignoreDuringBuilds: true,
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
