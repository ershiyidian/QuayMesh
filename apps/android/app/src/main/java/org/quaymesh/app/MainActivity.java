package org.quaymesh.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Toast;

public final class MainActivity extends Activity {
    private static final int SAVE_FILE = 7;
    private AppConfig config;
    private WebView webView;

    @Override public void onCreate(Bundle state) { super.onCreate(state); config = new AppConfig(this); showConfiguredPage(); }

    private void showConfiguredPage() {
        String server = config.server();
        if (server.isEmpty()) { showSettings(); return; }
        webView = new WebView(this); webView.getSettings().setJavaScriptEnabled(true); webView.getSettings().setDomStorageEnabled(true);
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("https".equalsIgnoreCase(uri.getScheme()) && uri.getHost() != null && uri.getHost().equals(Uri.parse(config.server()).getHost())) return false;
                if ("https".equalsIgnoreCase(uri.getScheme())) { startActivity(new Intent(Intent.ACTION_VIEW, uri)); return true; }
                return true;
            }
        });
        webView.loadUrl(server + (server.endsWith("/") ? "console/" : "/console/")); setContentView(webView);
    }

    private void showSettings() {
        LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL); layout.setPadding(32, 48, 32, 32);
        EditText address = new EditText(this); address.setHint("https://console.example.com"); address.setSingleLine(true);
        Button save = new Button(this); save.setText("保存并打开");
        save.setOnClickListener(view -> { try { config.saveServer(address.getText().toString()); showConfiguredPage(); } catch (IllegalArgumentException error) { Toast.makeText(this, error.getMessage(), Toast.LENGTH_LONG).show(); } });
        layout.addView(address, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)); layout.addView(save, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)); setContentView(layout);
    }

    @Override protected void onPause() { super.onPause(); if (webView != null) webView.onPause(); }
    @Override protected void onResume() { super.onResume(); if (webView != null) { webView.onResume(); webView.postDelayed(() -> webView.reload(), 0); } }
    @Override protected void onDestroy() { if (webView != null) { webView.stopLoading(); webView.destroy(); } super.onDestroy(); }
}
