import { sqliteTable, text } from "drizzle-orm/sqlite-core"

export const agent = sqliteTable("agent", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  tenantId: text("tenant_id").notNull(),
  gatewayClientId: text("gateway_client_id").notNull()
})
