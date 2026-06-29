import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const credentials = sqliteTable('credentials', {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
});
