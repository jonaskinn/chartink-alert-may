const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');

const app = express();

// Middleware configuration
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: '*/*' }));

// Database Setup
const pool = new Pool({
    connectionString: process.env.SPRING_DATASOURCE_URL,
    ssl: { rejectUnauthorized: false }
});

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PUBLIC_URL = process.env.APP_PUBLIC_URL || 'https://notifyu.me';
const ADMIN_CHAT_ID = (process.env.ADMIN_CHAT_ID || '').trim();

// Alphabets for UID and Key generation
const UID_ALPHABET = "abcdefghjklmnpqrstuvwxyz23456789";
const KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function generateRandomString(alphabet, length) {
    let result = '';
    const bytes = crypto.randomBytes(length);
    for (let i = 0; i < length; i++) {
        result += alphabet[bytes[i] % alphabet.length];
    }
    return result;
}

function escapeMarkdown(s) {
    if (!s) return "";
    return s.replace(/_/g, "\\_").replace(/\*/g, "\\*").replace(/\[/g, "\\[").replace(/\]/g, "\\]")
            .replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/~/g, "\\~").replace(/`/g, "\\`")
            .replace(/>/g, "\\>").replace(/#/g, "\\#").replace(/\+/g, "\\+").replace(/-/g, "\\-")
            .replace(/=/g, "\\=").replace(/\|/g, "\\|").replace(/\{/g, "\\{").replace(/\}/g, "\\}")
            .replace(/\./g, "\\.").replace(/!/g, "\\!");
}

function escapeJson(s) {
    if (!s) return "";
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

function sendTelegram(chatId, text) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    axios.post(url, {
        chat_id: chatId,
        text: text,
        parse_mode: 'Markdown'
    }).catch(err => console.error("Telegram API sending error:", err.message));
}

// Database Auto-Initialization Routine (Replicates your schema.sql automatically)
async function initDatabase() {
    try {
        console.log("Initializing database tables...");
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_map (
                uid TEXT PRIMARY KEY,
                chat_id TEXT NOT NULL,
                user_key TEXT NOT NULL,
                updated_at BIGINT,
                alert_limit INT NOT NULL DEFAULT 100
            );
            CREATE UNIQUE INDEX IF NOT EXISTS ux_user_map_chat_id ON user_map(chat_id);
            CREATE UNIQUE INDEX IF NOT EXISTS ux_user_map_user_key ON user_map(user_key);
            
            CREATE TABLE IF NOT EXISTS daily_usage (
                day DATE NOT NULL,
                chat_id TEXT NOT NULL,
                alerts_count INT NOT NULL DEFAULT 0,
                PRIMARY KEY (day, chat_id)
            );
            
            CREATE TABLE IF NOT EXISTS telegram_updates (
                update_id BIGINT PRIMARY KEY,
                processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS ix_telegram_updates_time ON telegram_updates(processed_at);
        `);
        console.log("Database tables verified successfully!");
    } catch (err) {
        console.error("Database initialization error:", err.message);
    }
}

// 1) Chartink Webhook Endpoint
app.post('/chartink', async (req, res) => {
    const uid = (req.query.uid || '').trim().toLowerCase();
    const key = (req.query.key || '').trim();
    let body = req.body;

    if (!uid || !key) return res.send("NO_UID_OR_KEY");

    try {
        const userQuery = await pool.query(
            "SELECT chat_id, user_key, COALESCE(alert_limit, 100) as max_alerts FROM user_map WHERE uid = $1",
            [uid]
        );

        if (userQuery.rows.length === 0) return res.send("UID_NOT_LINKED");
        const user = userQuery.rows[0];

        if (user.user_key !== key) return res.send("FORBIDDEN");

        const todayStr = new Date().toISOString().split('T')[0];
        const usageQuery = await pool.query(
            "SELECT alerts_count FROM daily_usage WHERE chat_id = $1 AND day = $2",
            [user.chat_id, todayStr]
        );
        const currentUsage = usageQuery.rows[0]?.alerts_count || 0;

        if (currentUsage >= user.max_alerts) {
            return res.send("LIMIT_EXCEEDED");
        }

        await pool.query(
            `INSERT INTO daily_usage(day, chat_id, alerts_count) VALUES($1, $2, 1)
             ON CONFLICT (day, chat_id) DO UPDATE SET alerts_count = daily_usage.alerts_count + 1`,
            [todayStr, user.chat_id]
        );

        const msg = buildMessage(uid, body);
        sendTelegram(user.chat_id, msg);

        return res.send("OK");
    } catch (err) {
        console.error("Chartink Webhook Runtime Error:", err.message);
        return res.send("OK");
    }
});

// 2) Telegram Live Communication Router Webhook
app.post('/telegram', async (req, res) => {
    console.log("Received a Telegram webhook ping!");
    const update = req.body;
    const updateId = update.update_id;

    if (updateId) {
        try {
            const dedup = await pool.query(
                "INSERT INTO telegram_updates (update_id) VALUES ($1) ON CONFLICT (update_id) DO NOTHING",
                [updateId]
            );
            if (dedup.rowCount === 0) return res.send("OK");
        } catch (e) {
            return res.send("OK");
        }
    }

    try {
        const message = update.message || update.edited_message || update.channel_post || update.edited_channel_post;
        if (!message || !message.chat || !message.text) return res.send("OK");

        const chatId = String(message.chat.id);
        const text = message.text.trim();
        const isAdmin = (chatId === ADMIN_CHAT_ID);

        if (text.startsWith("/start")) {
            const existing = await pool.query("SELECT uid, user_key FROM user_map WHERE chat_id = $1", [chatId]);
            if (existing.rows.length > 0) {
                sendTelegram(chatId, `Linked Successfully : ${existing.rows[0].uid}\nUse /myuid for Webhook URL.`);
            } else {
                const newUid = generateRandomString(UID_ALPHABET, 8);
                const newKey = generateRandomString(KEY_ALPHABET, 24);
                await pool.query("INSERT INTO user_map(uid, chat_id, user_key, updated_at) VALUES($1,$2,$3,$4)", 
                    [newUid, chatId, newKey, Math.floor(Date.now() / 1000)]);
                sendTelegram(chatId, buildLinkedMessage(newUid, newKey));
            }
            return res.send("OK");
        }

        if (text.startsWith("/myuid")) {
            const existing = await pool.query("SELECT uid, user_key FROM user_map WHERE chat_id = $1", [chatId]);
            if (existing.rows.length === 0) return sendTelegram(chatId, "/start to generate.");
            sendTelegram(chatId, buildLinkedMessage(existing.rows[0].uid, existing.rows[0].user_key));
            return res.send("OK");
        }

        if (text.startsWith("/unlink")) {
            if (!text.includes("confirm")) return sendTelegram(chatId, "⚠️ Send `/unlink confirm` to delete your link.");
            await pool.query("DELETE FROM user_map WHERE chat_id = $1", [chatId]);
            sendTelegram(chatId, "❌ Unlinked.");
            return res.send("OK");
        }

        if (text.startsWith("/newuid")) {
            if (!text.includes("confirm")) return sendTelegram(chatId, "⚠️ Send `/newuid confirm` to rotate URL.");
            await pool.query("DELETE FROM user_map WHERE chat_id = $1", [chatId]);
            const newUid = generateRandomString(UID_ALPHABET, 8);
            const newKey = generateRandomString(KEY_ALPHABET, 24);
            await pool.query("INSERT INTO user_map(uid, chat_id, user_key, updated_at) VALUES($1,$2,$3,$4)", 
                [newUid, chatId, newKey, Math.floor(Date.now() / 1000)]);
            sendTelegram(chatId, buildLinkedMessage(newUid, newKey));
            return res.send("OK");
        }

        if (text.startsWith("/stats")) {
            const todayStr = new Date().toISOString().split('T')[0];
            const usageQuery = await pool.query("SELECT alerts_count FROM daily_usage WHERE chat_id = $1 AND day = $2", [chatId, todayStr]);
            const todayCount = usageQuery.rows[0]?.alerts_count || 0;
            sendTelegram(chatId, `📊 *Daily Usage*\nUsed: ${todayCount} / 100`);
            return res.send("OK");
        }

        if (text.startsWith("/more")) {
            sendTelegram(chatId, "⚙️ *Other Actions*\n\n/newuid - Rotate URL\n/unlink - Delete account");
            return res.send("OK");
        }

        if (isAdmin) {
            if (text.startsWith("/adminstats")) {
                const totalUsers = await pool.query("SELECT COUNT(*) FROM user_map");
                const todayStr = new Date().toISOString().split('T')[0];
                const totalAlerts = await pool.query("SELECT COALESCE(SUM(alerts_count),0) as sum FROM daily_usage WHERE day = $1", [todayStr]);
                sendTelegram(chatId, `📊 Admin Stats\n\nTotal Users: ${totalUsers.rows[0].count}\nAlerts Today: ${totalAlerts.rows[0].sum}`);
            }
            else if (text.startsWith("/adminusers")) {
                const rows = await pool.query("SELECT uid, chat_id FROM user_map ORDER BY updated_at DESC LIMIT 20");
                let sb = "👥 Latest 20 users\n\n";
                for (let r of rows.rows) {
                    sb += `• ${r.uid} | ${r.chat_id}\n`;
                }
                sendTelegram(chatId, sb);
            }
            else if (text.startsWith("/admintop")) {
                const todayStr = new Date().toISOString().split('T')[0];
                const top = await pool.query(
                    `SELECT um.uid, du.alerts_count FROM daily_usage du JOIN user_map um ON um.chat_id = du.chat_id 
                     WHERE du.day = $1 ORDER BY du.alerts_count DESC LIMIT 10`, [todayStr]
                );
                let sb = "🏆 Top 10 Today\n\n";
                for (let r of top.rows) {
                    sb += `• ${r.uid}: ${r.alerts_count}\n`;
                }
                sendTelegram(chatId, sb);
            }
            else if (text.startsWith("/setlimit")) {
                const parts = text.split(/\s+/);
                if (parts.length < 3) return sendTelegram(chatId, "⚠️ Usage: `/setlimit <chat_id_or_uid> <limit>`");
                const target = parts[1].trim();
                const newLimit = parseInt(parts[2].trim(), 10);
                if (isNaN(newLimit)) return sendTelegram(chatId, "❌ Invalid limit number structure.");

                const updateLimit = await pool.query(
                    "UPDATE user_map SET alert_limit = $1 WHERE chat_id = $2 OR LOWER(uid) = LOWER($3)",
                    [newLimit, target, target]
                );
                if (updateLimit.rowCount > 0) {
                    sendTelegram(chatId, `✅ Success! Alert limit updated to *${newLimit}* for target: \`${target}\``);
                } else {
                    sendTelegram(chatId, `❌ User mapping not found for identifier: \`${target}\``);
                }
            }
            else if (text.startsWith("/sendmsg")) {
                const parts = text.split(/\s+/);
                if (parts.length < 3) return sendTelegram(chatId, "⚠️ Usage: `/sendmsg <chat_id> <message>`");
                const targetChat = parts[1].trim();
                const customMsg = text.substring(text.indexOf(parts[2])).trim();
                try {
                    sendTelegram(targetChat, customMsg);
                    sendTelegram(chatId, `🚀 Message manually sent to \`${targetChat}\`:\n\n${customMsg}`);
                } catch (e) {
                    sendTelegram(chatId, `❌ Failed to send message to \`${targetChat}\`.`);
                }
            }
        }

        return res.send("OK");
    } catch (err) {
        console.error("Telegram Router Error:", err.message);
        return res.send("OK");
    }
});

function buildLinkedMessage(uid, userKey) {
    let base = PUBLIC_URL.trim();
    if (base.endsWith('/')) base = base.slice(0, -1);
    const webhook = `${base}/chartink?uid=${uid}&key=${userKey}`;
    return `✅ *Linked Successfully!*\n\n*Webhook URL:* \`${webhook}\`\n\nPaste this URL in chartink/Tradingview , in the webhook field while setting alert\n\n/stats - Usage\n/more - Actions`;
}

function extractJsonValue(jsonStr, key) {
    try {
        const pattern = `"${key}":`;
        let start = jsonStr.indexOf(pattern);
        if (start === -1) return "";
        start += pattern.length;
        while (start < jsonStr.length && (jsonStr[start] === ' ' || jsonStr[start] === ':' || jsonStr[start] === '"')) {
            start++;
        }
        let end = jsonStr.indexOf('"', start);
        if (end === -1) {
            let endComma = jsonStr.indexOf(',', start);
            let endBrace = jsonStr.indexOf('}', start);
            if (endComma === -1) end = endBrace;
            else if (endBrace === -1) end = endComma;
            else end = Math.min(endComma, endBrace);
        }
        if (start >= end) return "";
        return jsonStr.substring(start, end).trim();
    } catch (e) {
        return "";
    }
}

function buildMessage(uid, body) {
    if (!body || body.trim() === '') {
        return "🔔 *Alert Received*\n\nNo data payload found.";
    }
    let scanName = "External Alert";
    let stockData = "";
    let timePart = "";
    let triggeredStocks = "";

    try {
        const cleanBody = body.trim();
        if (cleanBody.startsWith("{")) {
            triggeredStocks = extractJsonValue(cleanBody, "stocks");
            let symbol = extractJsonValue(cleanBody, "symbol");
            let price = extractJsonValue(cleanBody, "trigger_price");
            if (!symbol) symbol = extractJsonValue(cleanBody, "Value1");
            if (symbol) stockData = symbol + (price ? " @ " + price : "");
            scanName = extractJsonValue(cleanBody, "alert_name") || extractJsonValue(cleanBody, "title") || "External Alert";
            timePart = extractJsonValue(cleanBody, "triggered_at");
        } else if (cleanBody.toLowerCase().includes("extra data:")) {
            const idx = cleanBody.toLowerCase().indexOf("extra data:") + 11;
            const extra = cleanBody.substring(idx).trim();
            const parts = extra.split(",");
            if (parts.length >= 1) scanName = parts[0].trim();
            if (parts.length >= 2) stockData = parts[1].trim();
            if (extra.includes("@")) timePart = extra.substring(extra.indexOf("@")).trim();
        } else {
            stockData = cleanBody;
        }
    } catch (e) {
        return "🔔 *Alert*\n\n" + escapeMarkdown(body);
    }

    let sb = "🔔 *New Alert*\n\n";
    if (scanName) sb += `🧠 *Scan:* ${escapeMarkdown(scanName)}\n`;
    if (stockData) sb += `📈 *Trigger:* ${escapeMarkdown(stockData)}\n`;
    if (triggeredStocks) sb += `📋 *Full List:* ${escapeMarkdown(triggeredStocks)}\n`;
    if (timePart) sb += `⏰ *Time:* ${escapeMarkdown(timePart)}\n`;

    return sb.trim();
}

// Background tables vacuuming task
setInterval(async () => {
    try {
        await pool.query("DELETE FROM telegram_updates WHERE processed_at < NOW() - INTERVAL '1 day'");
    } catch (err) {
        console.error("Cleanup error:", err.message);
    }
}, 12 * 60 * 60 * 1000);

// Safe Static Asset Router (Placed below webhook definitions to prevent routing overrides)
app.use(express.static(path.join(__dirname, 'src/main/resources/static')));

// Capture all fallback web traffic directly to your primary index file
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'src/main/resources/static/index.html'));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
    console.log(`Ultra-low footprint Node router active on port ${PORT}`);
    await initDatabase();
});
