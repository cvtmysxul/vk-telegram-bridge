import "dotenv/config";

const DEFAULT_DATABASE_SCHEMA = "public";
const POSTGRES_IDENTIFIER_MAX_BYTES = 63;

export function parseDatabaseSchema(raw: string | undefined): string {
  const schema = raw?.trim() || DEFAULT_DATABASE_SCHEMA;

  if (schema.includes("\0")) {
    throw new Error("Invalid DATABASE_SCHEMA: null bytes are not allowed");
  }

  if (Buffer.byteLength(schema, "utf8") > POSTGRES_IDENTIFIER_MAX_BYTES) {
    throw new Error(
      `Invalid DATABASE_SCHEMA: PostgreSQL identifiers are limited to ${POSTGRES_IDENTIFIER_MAX_BYTES} bytes`
    );
  }

  const normalized = schema.toLowerCase();
  if (normalized === "information_schema" || normalized.startsWith("pg_")) {
    throw new Error(`Invalid DATABASE_SCHEMA: PostgreSQL system schema ${schema} cannot be used`);
  }

  return schema;
}

export const databaseSchemaName = parseDatabaseSchema(process.env.DATABASE_SCHEMA);
