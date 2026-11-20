import { PrismaClient } from "@prisma/client";

const sourceUrl = process.env.SOURCE_DATABASE_URL || process.env.DATABASE_URL;
const targetUrl = process.env.TARGET_DATABASE_URL;

if (!sourceUrl || !targetUrl) {
  throw new Error(
    "Set SOURCE_DATABASE_URL (or DATABASE_URL) and TARGET_DATABASE_URL before migrating."
  );
}

function getDatabaseAddress(connectionString) {
  const url = new URL(connectionString);
  return `${url.hostname}:${url.port || "5432"}${url.pathname}${url.searchParams.get("schema") || "public"}`;
}

if (getDatabaseAddress(sourceUrl) === getDatabaseAddress(targetUrl)) {
  throw new Error("Source and target resolve to the same database.");
}

const source = new PrismaClient({
  datasources: { db: { url: sourceUrl } },
});
const target = new PrismaClient({
  datasources: { db: { url: targetUrl } },
});

const models = [
  "user",
  "car",
  "dealershipInfo",
  "workingHour",
  "userSavedCar",
  "testDriveBooking",
];

try {
  const [sourceAddress, targetAddress] = await Promise.all([
    source.$queryRaw`SELECT current_database() AS name, current_schema() AS schema, inet_server_addr()::text AS host`,
    target.$queryRaw`SELECT current_database() AS name, current_schema() AS schema, inet_server_addr()::text AS host`,
  ]);
  if (
    sourceAddress[0].name === targetAddress[0].name &&
    sourceAddress[0].schema === targetAddress[0].schema &&
    sourceAddress[0].host === targetAddress[0].host
  ) {
    throw new Error("Source and target resolve to the same database.");
  }

  const sourceCounts = Object.fromEntries(
    await Promise.all(
      models.map(async (model) => [model, await source[model].count()])
    )
  );
  const targetCounts = Object.fromEntries(
    await Promise.all(
      models.map(async (model) => [model, await target[model].count()])
    )
  );

  if (Object.values(targetCounts).some((count) => count !== 0)) {
    throw new Error("Target database is not empty; refusing to overwrite data.");
  }

  const rows = Object.fromEntries(
    await Promise.all(
      models.map(async (model) => [model, await source[model].findMany()])
    )
  );

  await target.$transaction(async (transaction) => {
    for (const model of [
      "user",
      "car",
      "dealershipInfo",
      "workingHour",
      "userSavedCar",
      "testDriveBooking",
    ]) {
      if (rows[model].length > 0) {
        await transaction[model].createMany({ data: rows[model] });
      }
    }
  });

  const copiedCounts = Object.fromEntries(
    await Promise.all(
      models.map(async (model) => [model, await target[model].count()])
    )
  );

  for (const model of models) {
    if (sourceCounts[model] !== copiedCounts[model]) {
      throw new Error(
        `Verification failed for ${model}: expected ${sourceCounts[model]}, copied ${copiedCounts[model]}.`
      );
    }

    const [sourceRows, targetRows] = await Promise.all([
      source[model].findMany(),
      target[model].findMany(),
    ]);
    const canonicalize = (rows) =>
      rows.map((row) => JSON.stringify(row)).sort();
    if (
      JSON.stringify(canonicalize(sourceRows)) !==
      JSON.stringify(canonicalize(targetRows))
    ) {
      throw new Error(`Content verification failed for ${model}.`);
    }
  }

  console.log("Database migration and row-count verification succeeded.");
  console.log(JSON.stringify(copiedCounts, null, 2));
} finally {
  await Promise.all([source.$disconnect(), target.$disconnect()]);
}
