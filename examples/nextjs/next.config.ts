import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    cacheHandlers: {
        default: require.resolve("./cache-handler.ts"),
    },
    cacheMaxMemorySize: 0,
    reactCompiler: true,
    cacheComponents: true,
};

export default nextConfig;
