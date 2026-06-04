package com.chartink;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.*;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.SecureRandom;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;

@RestController
public class RouterController {

    private final JdbcTemplate jdbc;

    // Generators
    private static final SecureRandom RNG = new SecureRandom();
    private static final char[] UID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".toCharArray();
    private static final char[] KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".toCharArray();

    @Value("${telegram.botToken}")
    private String botToken;

    @Value("${app.publicUrl}")
    private String publicUrl;

    @Value("${admin.chatId:}")
    private String adminChatId;

    public RouterController(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    // Fix for "POST method not supported" warnings from bots
    

    // 1) Chartink Webhook
    @PostMapping(
            value = "/chartink",
            consumes = MediaType.ALL_VALUE,
            produces = "text/plain; charset=UTF-8"
    )
    public String chartinkWebhook(
            @RequestParam("uid") String uid,
            @RequestParam("key") String key,
            @RequestBody(required = false) String body
    ) throws Exception {

        if (!StringUtils.hasText(uid)) return "NO_UID";
        if (!StringUtils.hasText(key)) return "NO_KEY";

        String normalizedUid = uid.trim().toLowerCase();
        String providedKey = key.trim();

        Map<String, Object> row = jdbc.query(
                "SELECT chat_id, user_key FROM user_map WHERE uid = ?",
                rs -> rs.next()
                        ? Map.of("chat_id", rs.getString("chat_id"), "user_key", rs.getString("user_key"))
                        : null,
                normalizedUid
        );

        if (row == null) return "UID_NOT_LINKED";

        String expectedKey = (String) row.get("user_key");
        if (expectedKey == null || !expectedKey.equals(providedKey)) return "FORBIDDEN";

        String chatId = (String) row.get("chat_id");
        
        // Fetch the user's custom alert limit (defaults to 100 if something goes wrong)
        Integer alertLimit = jdbc.queryForObject(
                "SELECT COALESCE(alert_limit, 100) FROM user_map WHERE chat_id = ?",
                Integer.class, chatId
        );
        if (alertLimit == null) alertLimit = 100;

        int currentUsage = getTodayUsageFromDailyTable(chatId);
        if (currentUsage >= alertLimit) { // Checked against the dynamic limit instead of 100
            return "LIMIT_EXCEEDED";
        }
        incrementTodayUsage(chatId);

        String msg = buildMessage(normalizedUid, body);
        sendTelegram(chatId, msg);

        return "OK";
    }

    private int getTodayUsageFromDailyTable(String chatId) {
        List<Integer> counts = jdbc.query(
                "SELECT alerts_count FROM daily_usage WHERE chat_id = ? AND day = ?",
                (rs, rowNum) -> rs.getInt("alerts_count"),
                chatId, java.sql.Date.valueOf(LocalDate.now())
        );
        return counts.isEmpty() ? 0 : counts.get(0);
    }

    // 2) Telegram Webhook with Database-based Deduplication
    @PostMapping(value = "/telegram", produces = "text/plain; charset=UTF-8")
    public String telegramWebhook(@RequestBody Map<String, Object> update) {

        Object updateIdObj = update.get("update_id");
        if (updateIdObj instanceof Number) {
            long updateId = ((Number) updateIdObj).longValue();

            // Try to insert update_id into DB. If it exists, INSERT will fail (ON CONFLICT DO NOTHING)
            // or we check if we actually inserted a row.
            try {
                int rowsAffected = jdbc.update(
                        "INSERT INTO telegram_updates (update_id) VALUES (?) ON CONFLICT (update_id) DO NOTHING",
                        updateId
                );

                // If rowsAffected is 0, it means it was a duplicate and we do nothing.
                if (rowsAffected == 0) return "OK";

            } catch (Exception e) {
                // Secondary check for non-PostgreSQL DBs or unique constraint errors
                return "OK";
            }
        }

        try {
            Object messageObj = update.get("message");
            if (messageObj == null) messageObj = update.get("edited_message");
            if (messageObj == null) messageObj = update.get("channel_post");
            if (messageObj == null) messageObj = update.get("edited_channel_post");
            if (!(messageObj instanceof Map)) return "OK";

            Map<?, ?> message = (Map<?, ?>) messageObj;
            Object chatObj = message.get("chat");
            Object textObj = message.get("text");

            if (!(chatObj instanceof Map) || !(textObj instanceof String)) return "OK";

            Map<?, ?> chat = (Map<?, ?>) chatObj;
            Object chatIdObj = chat.get("id");
            if (chatIdObj == null) return "OK";

            String chatId = String.valueOf(chatIdObj);
            String text = ((String) textObj).trim();

            if (text.startsWith("/start")) { handleStart(chatId); return "OK"; }
            if (text.startsWith("/myuid")) { handleMyUid(chatId); return "OK"; }
            if (text.startsWith("/unlink")) { handleUnlink(chatId, text); return "OK"; }
            if (text.startsWith("/newuid")) { handleNewUid(chatId, text); return "OK"; }
            if (text.startsWith("/stats")) {
                int today = getTodayUsageFromDailyTable(chatId);
                sendTelegram(chatId, "📊 *Daily Usage*\nUsed: " + today + " / 100");
                return "OK";
            }
            if (text.startsWith("/more")) {
                sendTelegram(chatId, "⚙️ *Other Actions*\n\n/newuid - Rotate URL\n/unlink - Delete account");
                return "OK";
            }

            // Admin Commands
            if (text.startsWith("/adminstats") && isAdmin(chatId)) { handleAdminStats(chatId); return "OK"; }
            if (text.startsWith("/adminusers") && isAdmin(chatId)) { handleAdminUsers(chatId); return "OK"; }
            if (text.startsWith("/admintop") && isAdmin(chatId)) { handleAdminTop(chatId); return "OK"; }
            if (text.startsWith("/setlimit") && isAdmin(chatId)) { handleSetLimitCommand(chatId, text); return "OK"; }

            if (text.startsWith("/link")) { handleCustomLink(chatId, text); return "OK"; }

            return "OK";
        } catch (Exception ex) {
            return "OK";
        }
    }

    // Cleanup task to keep the database small (deletes IDs older than 24 hours)
    @Scheduled(cron = "0 0 0 * * *")
    public void cleanupOldUpdates() {
        jdbc.update("DELETE FROM telegram_updates WHERE processed_at < NOW() - INTERVAL '1 day'");
    }

    private boolean isAdmin(String chatId) {
        return StringUtils.hasText(adminChatId) && adminChatId.trim().equals(chatId);
    }

    private void handleAdminStats(String chatId) throws Exception {
        Integer totalUsers = jdbc.queryForObject("SELECT COUNT(*) FROM user_map", Integer.class);
        Integer todayAlerts = jdbc.queryForObject(
                "SELECT COALESCE(SUM(alerts_count),0) FROM daily_usage WHERE day = CURRENT_DATE",
                Integer.class
        );
        sendTelegram(chatId, "📊 Admin Stats\n\nTotal Users: " + totalUsers + "\nAlerts Today: " + todayAlerts);
    }

    private void handleAdminUsers(String chatId) throws Exception {
        List<Map<String, Object>> rows = jdbc.queryForList("SELECT uid, chat_id FROM user_map ORDER BY updated_at DESC LIMIT 20");
        StringBuilder sb = new StringBuilder("👥 Latest 20 users\n\n");
        for (Map<String, Object> r : rows) {
            sb.append("• ").append(r.get("uid")).append(" | ").append(r.get("chat_id")).append("\n");
        }
        sendTelegram(chatId, sb.toString());
    }

    private void handleAdminTop(String chatId) throws Exception {
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT um.uid, du.alerts_count FROM daily_usage du JOIN user_map um ON um.chat_id = du.chat_id " +
                        "WHERE du.day = CURRENT_DATE ORDER BY du.alerts_count DESC LIMIT 10");
        StringBuilder sb = new StringBuilder("🏆 Top 10 Today\n\n");
        for (Map<String, Object> r : rows) {
            sb.append("• ").append(r.get("uid")).append(": ").append(r.get("alerts_count")).append("\n");
        }
        sendTelegram(chatId, sb.toString());
    }

    private void handleStart(String chatId) throws Exception {
        UserLink existing = getByChatId(chatId);
        if (existing != null) {
            sendTelegram(chatId, "Linked Successfully : " + existing.uid + "\nUse /myuid for Webhook URL.");
            return;
        }
        String uid = generateUniqueUid();
        String userKey = generateUniqueUserKey();
        linkUidToChat(uid, userKey, chatId);
        sendTelegram(chatId, buildLinkedMessage(uid, userKey));
    }

    private void handleMyUid(String chatId) throws Exception {
        UserLink existing = getByChatId(chatId);
        if (existing == null) { sendTelegram(chatId, "/start to generate."); return; }
        sendTelegram(chatId, buildLinkedMessage(existing.uid, existing.userKey));
    }

    private void handleUnlink(String chatId, String text) throws Exception {
        if (!text.contains("confirm")) {
            sendTelegram(chatId, "⚠️ Send `/unlink confirm` to delete your link.");
            return;
        }
        jdbc.update("DELETE FROM user_map WHERE chat_id = ?", chatId);
        sendTelegram(chatId, "❌ Unlinked.");
    }

    private void handleNewUid(String chatId, String text) throws Exception {
        if (!text.contains("confirm")) {
            sendTelegram(chatId, "⚠️ Send `/newuid confirm` to rotate URL.");
            return;
        }
        jdbc.update("DELETE FROM user_map WHERE chat_id = ?", chatId);
        handleStart(chatId);
    }

    private void handleCustomLink(String chatId, String text) throws Exception {
        String[] parts = text.split("\\s+");
        if (parts.length < 2) { sendTelegram(chatId, "Usage: /link <uid>"); return; }
        String uid = parts[1].trim().toLowerCase();
        if (getByUid(uid) != null) { sendTelegram(chatId, "Taken."); return; }
        String userKey = generateUniqueUserKey();
        linkUidToChat(uid, userKey, chatId);
        sendTelegram(chatId, buildLinkedMessage(uid, userKey));
    }

    private static class UserLink {
        final String uid, chatId, userKey;
        UserLink(String u, String c, String k) { this.uid = u; this.chatId = c; this.userKey = k; }
    }

    private UserLink getByChatId(String chatId) {
        return jdbc.query("SELECT uid, chat_id, user_key FROM user_map WHERE chat_id = ?",
                rs -> rs.next() ? new UserLink(rs.getString(1), rs.getString(2), rs.getString(3)) : null, chatId);
    }

    private UserLink getByUid(String uid) {
        return jdbc.query("SELECT uid, chat_id, user_key FROM user_map WHERE uid = ?",
                rs -> rs.next() ? new UserLink(rs.getString(1), rs.getString(2), rs.getString(3)) : null, uid);
    }

    private void linkUidToChat(String uid, String userKey, String chatId) {
        jdbc.update("INSERT INTO user_map(uid, chat_id, user_key, updated_at) VALUES(?,?,?,?)",
                uid, chatId, userKey, Instant.now().getEpochSecond());
    }

    private String generateUniqueUid() throws Exception {
        for (int i = 0; i < 40; i++) {
            String uid = generateFromAlphabet(UID_ALPHABET, 8).toLowerCase();
            if (getByUid(uid) == null) return uid;
        }
        throw new Exception("UID gen failed");
    }

    private String generateUniqueUserKey() throws Exception {
        for (int i = 0; i < 40; i++) {
            String key = generateFromAlphabet(KEY_ALPHABET, 24);
            Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM user_map WHERE user_key = ?", Integer.class, key);
            if (count != null && count == 0) return key;
        }
        throw new Exception("Key gen failed");
    }

    private String generateFromAlphabet(char[] alphabet, int len) {
        StringBuilder sb = new StringBuilder(len);
        for (int i = 0; i < len; i++) sb.append(alphabet[RNG.nextInt(alphabet.length)]);
        return sb.toString();
    }

    private String buildLinkedMessage(String uid, String userKey) {
        String base = StringUtils.hasText(publicUrl) ? publicUrl.trim() : "(server)";
        if (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        String webhook = base + "/chartink?uid=" + uid + "&key=" + userKey;
        return "✅ *Linked Successfully!*\n\n" +
                "*Webhook URL:* `" + webhook + "`\n\n" +
                "Paste this URL in chartink/Tradingview , in the webhook field while setting alert\n\n" +
                "/stats - Usage\n" +
                "/more - Actions";
    }

    private String escapeMarkdown(String s) {
        if (s == null) return "";
        return s.replace("_", "\\_").replace("*", "\\*").replace("[", "\\[").replace("]", "\\]")
                .replace("(", "\\(").replace(")", "\\)").replace("~", "\\~").replace("`", "\\`")
                .replace(">", "\\>").replace("#", "\\#").replace("+", "\\+").replace("-", "\\-")
                .replace("=", "\\=").replace("|", "\\|").replace("{", "\\{").replace("}", "\\}")
                .replace(".", "\\.").replace("!", "\\!");
    }

    private String buildMessage(String uid, String body) {
        if (body == null || body.trim().isEmpty()) {
            return "🔔 *Alert Received*\n\nNo data payload found.";
        }

        String scanName = "External Alert";
        String stockData = "";
        String timePart = "";
        String triggeredStocks = "";

        try {
            String cleanBody = body.trim();

            if (cleanBody.startsWith("{")) {
                // Capture the full list of all stocks
                triggeredStocks = extractJsonValue(cleanBody, "stocks");

                // Extract primary symbol and price
                String symbol = extractJsonValue(cleanBody, "symbol");
                String price = extractJsonValue(cleanBody, "trigger_price");

                if (symbol.isEmpty()) symbol = extractJsonValue(cleanBody, "Value1");

                if (!symbol.isEmpty()) {
                    stockData = symbol + (!price.isEmpty() ? " @ " + price : "");
                }

                scanName = extractJsonValue(cleanBody, "alert_name");
                if (scanName.isEmpty()) scanName = extractJsonValue(cleanBody, "title");

                timePart = extractJsonValue(cleanBody, "triggered_at");
            }
            else if (cleanBody.toLowerCase().contains("extra data:")) {
                String extra = cleanBody.substring(cleanBody.toLowerCase().indexOf("extra data:") + 11).trim();
                String[] parts = extra.split(",");
                if (parts.length >= 1) scanName = parts[0].trim();
                if (parts.length >= 2) stockData = parts[1].trim();
                if (extra.contains("@")) timePart = extra.substring(extra.indexOf("@")).trim();
            } else {
                stockData = cleanBody;
            }
        } catch (Exception e) {
            return "🔔 *Alert*\n\n" + escapeMarkdown(body);
        }

        StringBuilder sb = new StringBuilder();
        sb.append("🔔 *New Alert*").append("\n\n");
        if (!scanName.isEmpty()) sb.append("🧠 *Scan:* ").append(escapeMarkdown(scanName)).append("\n");

        // Primary stock triggered
        if (!stockData.isEmpty()) sb.append("📈 *Trigger:* ").append(escapeMarkdown(stockData)).append("\n");

        // Show the full list of all stocks from the Chartink payload
        if (!triggeredStocks.isEmpty()) {
            sb.append("📋 *Full List:* ").append(escapeMarkdown(triggeredStocks)).append("\n");
        }

        if (!timePart.isEmpty()) sb.append("⏰ *Time:* ").append(escapeMarkdown(timePart)).append("\n");

        return sb.toString().trim();
    }

    private String extractJsonValue(String json, String key) {
        try {
            String pattern = "\"" + key + "\":";
            int start = json.indexOf(pattern);
            if (start == -1) return "";

            start += pattern.length();
            // Skip whitespace, colons, and the opening quote
            while (start < json.length() && (json.charAt(start) == ' ' || json.charAt(start) == ':' || json.charAt(start) == '"')) {
                start++;
            }

            // Find the ending quote of the value
            int end = json.indexOf("\"", start);
            if (end == -1) {
                // Fallback for unquoted numbers/values if quotes aren't found
                int endComma = json.indexOf(",", start);
                int endBrace = json.indexOf("}", start);
                if (endComma == -1) end = endBrace;
                else if (endBrace == -1) end = endComma;
                else end = Math.min(endComma, endBrace);
            }

            if (start >= end) return "";
            return json.substring(start, end).trim();
        } catch (Exception e) {
            return "";
        }
    }

    private void sendTelegram(String chatId, String text) throws Exception {
        String url = "https://api.telegram.org/bot" + botToken + "/sendMessage";
        String json = "{\"chat_id\":\"" + escapeJson(chatId) + "\",\"text\":\"" + escapeJson(text) + "\",\"parse_mode\":\"Markdown\"}";
        HttpURLConnection con = (HttpURLConnection) new URL(url).openConnection();
        con.setRequestMethod("POST");
        con.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
        con.setDoOutput(true);
        try (OutputStream os = con.getOutputStream()) { os.write(json.getBytes("UTF-8")); }
        con.getResponseCode();
    }

    private void incrementTodayUsage(String chatId) {
        jdbc.update("INSERT INTO daily_usage(day, chat_id, alerts_count) VALUES(CURRENT_DATE,?,1) " +
                "ON CONFLICT (day, chat_id) DO UPDATE SET alerts_count = daily_usage.alerts_count + 1", chatId);
    }

    private void handleSetLimitCommand(String adminChatId, String text) throws Exception {
        // Expected format: /setlimit <telegram_chat_id_or_uid> <new_limit>
        String[] parts = text.split("\\s+");
        if (parts.length < 3) {
            sendTelegram(adminChatId, "⚠️ Usage: `/setlimit <chat_id_or_uid> <limit>`");
            return;
        }

        String target = parts[1].trim();
        int newLimit;
        
        try {
            newLimit = Integer.parseInt(parts[2].trim());
        } catch (NumberFormatException e) {
            sendTelegram(adminChatId, "❌ Invalid limit number.");
            return;
        }

        // Update using either chat_id or unique app uid to make it easy for you to target users
        int rowsAffected = jdbc.update(
                "UPDATE user_map SET alert_limit = ? WHERE chat_id = ? OR LOWER(uid) = LOWER(?)",
                newLimit, target, target
        );

        if (rowsAffected > 0) {
            sendTelegram(adminChatId, "✅ Success! Alert limit updated to *" + newLimit + "* for target: `" + target + "`");
        } else {
            sendTelegram(adminChatId, "❌ User not found with Chat ID or UID: `" + target + "`");
        }
    }

    private String escapeJson(String s) {
        if (s == null) return "";
        StringBuilder out = new StringBuilder(s.length() + 16);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                default:
                    if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
                    else out.append(c);
            }
        }
        return out.toString();
    }
}
