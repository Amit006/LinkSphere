/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@linksphere/core'],
  experimental: {
    typedRoutes: true,
  },
};

export default nextConfig;
