import { getPrismaClient } from "./prisma";

export type DatabaseHealthStatus = {
  available: boolean;
};

export async function checkDatabaseAvailability(): Promise<DatabaseHealthStatus> {
  try {
    await getPrismaClient().$queryRaw`SELECT 1`;
    return { available: true };
  } catch {
    return { available: false };
  }
}
