-- Adds the provider-native session ID column used for native resume.
-- This column is written only from provider responses; it is intentionally
-- NOT backfilled from routa_agent_id (the two IDs must never be conflated).
ALTER TABLE `acp_sessions` ADD COLUMN `provider_session_id` text;
