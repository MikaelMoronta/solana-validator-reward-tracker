// src/db.ts: the one shared connection to PostgreSQL for the whole project.
// Every other file imports `pool` from here instead of connecting on its own.

import dotenv from "dotenv";
import { Pool } from "pg";

// Copy the settings from the .env file into process.env (Node's environment variables).
// quiet: true stops dotenv printing a message every time it loads.
dotenv.config({ quiet: true });

// A Pool keeps a few database connections open and lends them out per query,
// instead of opening a brand-new connection every time (which is slow).
// With no settings passed in, pg reads PGHOST, PGPORT, PGUSER, PGPASSWORD and
// PGDATABASE from the environment, which is exactly what our .env file defines.
export const pool = new Pool();
