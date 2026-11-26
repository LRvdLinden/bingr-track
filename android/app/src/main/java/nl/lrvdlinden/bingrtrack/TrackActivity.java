package nl.lrvdlinden.bingrtrack;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;
import javax.net.ssl.HttpsURLConnection;

public final class TrackActivity extends Activity {
    private static final String PAGE = "file:///android_asset/index.html";
    private final ExecutorService worker = Executors.newFixedThreadPool(3);
    private WebView web;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        web.setBackgroundColor(0xff090909);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setTextZoom(100);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !PAGE.equals(request.getUrl().toString());
            }
        });
        web.addJavascriptInterface(new Bridge(), "TrackNative");
        FrameLayout frame = new FrameLayout(this);
        frame.setBackgroundColor(0xff090909);
        frame.addView(web);
        if (Build.VERSION.SDK_INT >= 30) frame.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets safe = insets.getInsets(android.view.WindowInsets.Type.systemBars()
                | android.view.WindowInsets.Type.displayCutout() | android.view.WindowInsets.Type.ime());
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            return insets;
        });
        setContentView(frame);
        web.loadUrl(PAGE);
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        Uri url = intent.getData();
        if (url != null && "bingrtrack".equals(url.getScheme()) && "oauth".equals(url.getHost())
            && "/trakt".equals(url.getPath())) {
            web.evaluateJavascript("window.oauth(" + JSONObject.quote(url.toString()) + ")", null);
        }
    }

    @Override protected void onDestroy() {
        worker.shutdownNow();
        web.destroy();
        super.onDestroy();
    }

    private final class Bridge {
        @JavascriptInterface public void send(String raw) {
            worker.execute(() -> {
                JSONObject reply = new JSONObject();
                int id;
                try {
                    JSONObject message = new JSONObject(raw);
                    id = message.getInt("id");
                    try { reply.put("value", handle(message)); }
                    catch (Exception badRequest) { reply.put("error", "De aanvraag kon niet worden uitgevoerd."); }
                } catch (Exception badMessage) { return; }
                runOnUiThread(() -> {
                    if (!isDestroyed()) web.evaluateJavascript("window.reply(" + id + "," + reply + ")", null);
                });
            });
        }
    }

    private Object handle(JSONObject message) throws Exception {
        switch (message.getString("action")) {
            case "config":
                return new JSONObject().put("url",getString(R.string.bingr_url)).put("key",getString(R.string.bingr_key))
                    .put("trakt",getString(R.string.trakt_id));
            case "open":
                Uri uri = Uri.parse(message.getString("url"));
                if (!"https".equals(uri.getScheme()) || !java.util.Arrays.asList("bingr.online","trakt.tv","www.imdb.com","www.themoviedb.org").contains(uri.getHost()))
                    throw new IllegalArgumentException();
                runOnUiThread(() -> {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
                    catch (android.content.ActivityNotFoundException error) {
                        android.widget.Toast.makeText(this, "Geen browser beschikbaar.", android.widget.Toast.LENGTH_SHORT).show();
                    }
                });
                return true;
            case "verifyPIN": return verifyPin(message.getString("pin"), message.getJSONObject("hash"));
            case "pkce":
                SecureRandom random = new SecureRandom();
                byte[] bytes = new byte[32];
                random.nextBytes(bytes);
                String verifier = base64URL(bytes);
                random.nextBytes(bytes);
                String challenge = base64URL(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)));
                return new JSONObject().put("verifier",verifier).put("state",base64URL(bytes)).put("challenge",challenge);
            case "readTraktSession":
            case "saveTraktSession":
            case "clearTraktSession": return TraktSessionVault.handle(this,message);
            case "request": return request(message);
            default: throw new IllegalArgumentException();
        }
    }

    private String base64URL(byte[] value) {
        return Base64.encodeToString(value, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }

    private boolean verifyPin(String pin, JSONObject hash) throws Exception {
        int rounds = hash.getInt("iter");
        if (!pin.matches("[0-9]{4,8}") || !"pbkdf2-sha256".equals(hash.getString("alg"))
            || rounds < 10000 || rounds > 2000000) return false;
        byte[] salt = Base64.decode(hash.getString("salt"), Base64.DEFAULT);
        byte[] expected = Base64.decode(hash.getString("hash"), Base64.DEFAULT);
        if (salt.length != 16 || expected.length != 32) return false;
        PBEKeySpec spec = new PBEKeySpec(pin.toCharArray(),salt,rounds,256);
        try {
            byte[] actual = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
            return MessageDigest.isEqual(expected,actual);
        } finally { spec.clearPassword(); }
    }

    private JSONObject request(JSONObject message) throws Exception {
        URL url = new URL(message.getString("url"));
        String bingrHost = Uri.parse(getString(R.string.bingr_url)).getHost();
        if (!"https".equals(url.getProtocol()) || !("api.trakt.tv".equals(url.getHost()) || url.getHost().equals(bingrHost)))
            throw new IllegalArgumentException();
        String method = message.getString("method");
        boolean stopCheckin = "DELETE".equals(method) && "api.trakt.tv".equals(url.getHost()) && "/checkin".equals(url.getPath());
        if (!"GET".equals(method) && !"POST".equals(method) && !stopCheckin) throw new IllegalArgumentException();
        boolean isAvatar = url.getHost().equals(bingrHost) && "GET".equals(method)
            && url.getPath().startsWith("/storage/v1/object/authenticated/avatars/") && url.getPath().endsWith(".jpg");
        HttpsURLConnection connection = (HttpsURLConnection) url.openConnection();
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(12000);
            connection.setReadTimeout(20000);
            connection.setRequestMethod(method);
            JSONObject headers = message.getJSONObject("headers");
            Iterator<String> names = headers.keys();
            while (names.hasNext()) {
                String name = names.next();
                connection.setRequestProperty(name,headers.getString(name));
            }
            if (!message.isNull("body")) {
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type","application/json");
                try (java.io.OutputStream output = connection.getOutputStream()) {
                    output.write(message.getJSONObject("body").toString().getBytes(StandardCharsets.UTF_8));
                }
            }
            int status = connection.getResponseCode();
            Object data = JSONObject.NULL;
            try (InputStream input = status < 400 ? connection.getInputStream() : connection.getErrorStream()) {
                if (input != null) {
                    java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
                    byte[] chunk = new byte[8192];
                    for (int count; (count = input.read(chunk)) != -1;) {
                        if (buffer.size() + count > 4 * 1024 * 1024) throw new java.io.IOException();
                        buffer.write(chunk, 0, count);
                    }
                    byte[] bytes = buffer.toByteArray();
                    if (isAvatar && status == 200) {
                        if (bytes.length >= 3 && bytes.length <= 1048576
                            && bytes[0] == (byte) 0xff && bytes[1] == (byte) 0xd8 && bytes[2] == (byte) 0xff) {
                            data = new JSONObject().put("jpeg", Base64.encodeToString(bytes, Base64.NO_WRAP));
                        }
                    } else if (bytes.length > 0) {
                        data = new JSONTokener(new String(bytes,StandardCharsets.UTF_8)).nextValue();
                    }
                }
            }
            return new JSONObject().put("status",status).put("data",data);
        } finally { connection.disconnect(); }
    }
}
