import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    cacheHandlers: {
        default: require.resolve("./cache-handler.ts"),
    },
    reactCompiler: true,
    cacheComponents: true,
    partialPrefetching: true,
};

export default nextConfig;
