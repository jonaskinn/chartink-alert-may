-- 1) Create main user table with all necessary columns from the start
CREATE TABLE IF NOT EXISTS user_map (
    uid TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    user_key TEXT NOT NULL,
    updated_at BIGINT,
    alert_limit INT NOT NULL DEFAULT 100 -- Added for dynamic limits
);

-- 2) Create unique indexes for performance and constraints
CREATE UNIQUE INDEX IF NOT EXISTS ux_user_map_chat_id ON user_map(chat_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_user_map_user_key ON user_map(user_key);

-- 3) Create usage tracking tables
CREATE TABLE IF NOT EXISTS daily_usage (
    day DATE NOT NULL,
    chat_id TEXT NOT NULL,
    alerts_count INT NOT NULL DEFAULT 0,
    PRIMARY KEY (day, chat_id)
);

-- Legacy table support (if needed by other parts of your app)
CREATE TABLE IF NOT EXISTS alert_usage (
    chat_id TEXT NOT NULL,
    day DATE NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (chat_id, day)
);
CREATE INDEX IF NOT EXISTS ix_alert_usage_chat_day ON alert_usage(chat_id, day);

-- 4) Create telegram update tracker
CREATE TABLE IF NOT EXISTS telegram_updates (
    update_id BIGINT PRIMARY KEY,
    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Optional: Index for cleanup tasks
CREATE INDEX IF NOT EXISTS ix_telegram_updates_time ON telegram_updates(processed_at);
