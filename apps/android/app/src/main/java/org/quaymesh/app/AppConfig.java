package org.quaymesh.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

public final class AppConfig {
    private static final String PREFS = "quaymesh.settings";
    private static final String SERVER = "server";
    private final SharedPreferences preferences;

    public AppConfig(Context context) { preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    public String server() { return preferences.getString(SERVER, ""); }

    public void saveServer(String value) {
        Uri uri = Uri.parse(value.trim());
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null) {
            throw new IllegalArgumentException("服务器地址必须是没有账号信息、查询参数和片段的 HTTPS 地址。");
        }
        String normalized = new Uri.Builder().scheme("https").authority(uri.getHost() + (uri.getPort() > 0 ? ":" + uri.getPort() : "")).path(uri.getPath() == null ? "/" : uri.getPath()).build().toString();
        preferences.edit().putString(SERVER, normalized.endsWith("/") ? normalized : normalized + "/").apply();
    }
}
