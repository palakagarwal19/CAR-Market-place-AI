import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";

const client = new BedrockRuntimeClient({
  region: process.env.AWS_REGION,
});

const imageFormats = {
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export async function analyzeImageWithBedrock(file, prompt) {
  const format = imageFormats[file.type];

  if (!format) {
    throw new Error(`Unsupported image type: ${file.type || "unknown"}`);
  }

  const response = await client.send(
    new ConverseCommand({
      modelId: process.env.BEDROCK_MODEL_ID || "amazon.nova-lite-v1:0",
      messages: [
        {
          role: "user",
          content: [
            { text: prompt },
            {
              image: {
                format,
                source: { bytes: Buffer.from(await file.arrayBuffer()) },
              },
            },
          ],
        },
      ],
      inferenceConfig: {
        maxTokens: 1024,
        temperature: 0.2,
      },
    })
  );

  const text = response.output?.message?.content
    ?.map((item) => item.text)
    .filter(Boolean)
    .join("");

  if (!text) {
    throw new Error("Bedrock returned an empty image analysis response");
  }

  return text;
}
