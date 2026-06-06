const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');

const app = express();

// Middleware to parse text or JSON payloads cleanly
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: '*/*' }));

// Serve all your existing front-end pages perfectly
app.use(express.static(path.join(__dirname, 'src/main/resources/static')));

// Database Setup
const pool = new Pool({
    host: 'aws-1-us-east-2.pooler.supabase.com',
    port: 6543,
    database: 'postgres',
    user: process.env.SPRING_DATASOURCE_USERNAME,
    password: process.env.SPRING_DATASOURCE_PASSWORD,
    ssl: { rejectUnauthorized: false }
});

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PUBLIC_URL = process.env.APP_PUBLIC_URL || '';
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

// Escapes special markdown text strings for Telegram
function escapeMarkdown(s) {
    if (!s) return "";
    return s.replace(/_/g, "\\_").replace(/\*/g, "\\*").replace(/\[/g, "\\[").replace(/\]/g, "\\]")
            .replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/~/g, "\\~").replace(/`/g, "\\`")
            .replace(/>/g, "\\>").replace(/#/g, "\\#").replace(/\+/g, "\\+").replace(/-/g, "\\-")
            .replace(/=/g, "\\=").replace(/\|/g, "\\|").replace(/\{/g, "\\{").replace(/\}/g, "\\}")
            .replace(/\./g, "\\.").replace(/!/g, "\\!");
}

// Safe asynchronous non-blocking Telegram Sender
function sendTelegram(chatId, text) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    axios.post(url, {
        chat_id: chatId,
        text: text,
        parse_mode: 'Markdown'
    }).catch(err => console.error("Telegram API sending error:", err.message));
}

// 1) Chartink Webhook Endpoint
app.post('/chartink', async (req, res) => {
    const uid = (req.query.uid || '').trim().toLowerCase();
    const key = (req.query.key || '').trim();
    let body = req.body;

    if (!uid) return res.send("NO_UID");
    if (!key) return res.send("NO_KEY");

    try {
        // Automatically fixes the column mismatch bug by querying alert_limit safely
        const userQuery = await pool.query(
            "SELECT chat_id, user_key, COALESCE(alert_limit, 100) as max_alerts FROM user_map WHERE uid = $1",
            [uid]
        );

        if (userQuery.rows.length === 0) return res.send("UID_NOT_LINKED");
        const user = userQuery.rows[0];

        if (user.user_key !== key) return res.send("FORBIDDEN");

        // Fetch current day's limit metric
        const todayStr = new Date().toISOString().split('T')[0];
        const usageQuery = await pool.query(
            "SELECT alerts_count FROM daily_usage WHERE chat_id = $1 AND day = $2",
            [user.chat_id, todayStr]
        );
        const currentUsage = usageQuery.rows[0]?.alerts_count || 0;

        if (currentUsage >= user.max_alerts) {
            return res.send("LIMIT_EXCEEDED");
        }

        // Atomically log increment metric
        await pool.query(
            `INSERT INTO daily_usage(day, chat_id, alerts_count) VALUES($1, $2, 1)
             ON CONFLICT (day, chat_id) DO UPDATE SET alerts_count = daily_usage.alerts_count + 1`,
            [todayStr, user.chat_id]
        );

        // Parse alert block
        const msg = buildMessage(uid, body);
        sendTelegram(user.chat_id, msg);

        return res.send("OK");
    } catch (err) {
        console.error(err);
        return res.send("OK");
    }
});

// 2) Telegram Live Communication Router Webhook
app.post('/telegram', async (req, res) => {
    const update = req.body;
    const updateId = update.update_id;

    if (updateId) {
        try {
            const dedup = await pool.query(
                "INSERT INTO telegram_updates (update_id) VALUES ($1) ON CONFLICT (update_id) DO NOTHING",
                [updateId]
            );
            if (dedup.rowCount === 0) return res.send("OK"); // Ignore if duplicate request processed
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

        // Admin Engine Controllers
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
        console.error(err);
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

// Low-overhead background cleanup routine running every 12 hours
setInterval(async () => {
    try {
        await pool.query("DELETE FROM telegram_updates WHERE processed_at < NOW() - INTERVAL '1 day'");
        console.log("Database update tables cleaned successfully.");
    } catch (err) {
        console.error("Cleanup runtime error:", err.message);
    }
}, 12 * 60 * 60 * 1000);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Ultra-low footprint Node router active on port ${PORT}`));
