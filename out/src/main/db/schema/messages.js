import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const messages = sqliteTable('messages', {
    id: text('id').primaryKey(),
    source: text('source', { enum: ['electron', 'telegram'] }).notNull(),
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    content: text('content').notNull(),
    telegramChatId: integer('telegram_chat_id'),
    telegramUserId: integer('telegram_user_id'),
    telegramFrom: text('telegram_from'),
    telegramMessageId: integer('telegram_message_id'),
    createdAt: integer('created_at').notNull(),
});
