import { closeDb, migrate } from "./db.js";

await migrate();
await closeDb();
