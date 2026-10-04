/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: "/favicon.ico",
        destination: "/stt-icon-v3.svg",
      },
    ];
  },
};

export default nextConfig;
