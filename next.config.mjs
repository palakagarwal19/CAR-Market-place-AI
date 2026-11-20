/** @type {import('next').NextConfig} */
const s3Bucket = process.env.NEXT_PUBLIC_S3_BUCKET;
const awsRegion = process.env.AWS_REGION || "ap-south-1";
const nextConfig = {
  experimental: {
    serverComponentsHmrCache: false, // defaults to true
  },
  images: {
    remotePatterns: s3Bucket
      ? [
          {
            protocol: "https",
            hostname: `${s3Bucket}.s3.${awsRegion}.amazonaws.com`,
          },
        ]
      : [],
  },

  async headers() {
    return [
      {
        source: "/embed",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "frame-src 'self' https://roadsidecoder.created.app;",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
