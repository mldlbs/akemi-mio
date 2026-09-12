import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const telegramOutbox = sqliteTable('telegram_outbox', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id').notNull(),
  bot: text('bot').default('chat'),
  msgType: text('msg_type', { enum: ['send', 'edit', 'reply', 'action', 'photo', 'media_group'] }).notNull(),
  category: text('category', {
    enum: ['dialogue', 'evolution', 'insight', 'creativity', 'plan', 'budget', 'recovery', 'stability', 'system'],
  })
    .notNull()
    .default('dialogue'),
  message: text('message').notNull(),
  targetMessageId: integer('target_message_id'),
  hash: text('hash'),
  status: text('status', { enum: ['pending', 'sent', 'failed'] })
    .notNull()
    .default('pending'),
  retryCount: integer('retry_count').notNull().default(0),
  lastError: text('last_error'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at'),
})
