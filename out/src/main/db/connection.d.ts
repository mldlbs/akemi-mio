import { Database as SqlJsDatabase } from 'sql.js';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import * as schema from './schema';
export declare function initDatabase(): Promise<void>;
export declare function getDatabase(): SqliteRemoteDatabase<typeof schema>;
export declare function markDirty(): void;
export declare function flushDatabase(): void;
export declare function closeDatabase(): void;
export declare function getRawDb(): SqlJsDatabase;
