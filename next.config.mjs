/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Twilio SDK is server-only; keep it out of the client/edge bundle.
  serverExternalPackages: ["twilio"],
  async headers() {
    return [
      {
        // The DNI / form-capture snippet is loaded cross-origin from arbor-mgmt.com.
        source: "/track.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=300, must-revalidate" },
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
    ];
  },
};

export default nextConfig;
