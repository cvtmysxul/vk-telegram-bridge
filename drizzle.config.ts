import "dotenv/config";
import { defineConfig } from "drizzle-kit";
import { databaseSchemaName } from "./src/databaseSchema.js";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations/drizzle",
  dialect: "postgresql",
  schemaFilter: [databaseSchemaName],
  dbCredentials: {
    url: process.env.DATABASE_URL ?? ""
  }
});
