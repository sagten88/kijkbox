package nl.agtenhosting.kijkbox;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Opent Kijkbox schermvullend en geeft de knoppen van de afstandsbediening door aan de website.
 * De website doet de rest, zodat verbeteringen aan de site vanzelf ook op de tv komen.
 * Het adres van de server vraagt de app bij de eerste start; daarna is het te wijzigen via
 * Account op de tv, de Menu-toets of het foutscherm.
 */
public class MainActivity extends Activity {
    private static final String PREFS = "kijkbox";
    private static final String KEY_SERVER = "server";

    private WebView web;
    private String home;      // bijvoorbeeld http://192.168.1.50:3000/
    private String authority; // host en poort, bijvoorbeeld 192.168.1.50:3000
    private boolean showingError = false;
    private boolean showingSetup = false;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable flushCookies = new Runnable() {
        @Override
        public void run() {
            CookieManager.getInstance().flush();
            handler.postDelayed(this, 15000);
        }
    };

    /** Voor de website: alleen om het serveradres opnieuw in te stellen. */
    public class Bridge {
        @JavascriptInterface
        public void changeServer() {
            handler.post(new Runnable() {
                @Override
                public void run() {
                    showSetup(null);
                }
            });
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(16, 18, 22));
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setUserAgentString(settings.getUserAgentString() + " KijkboxTV/1.3");
        web.addJavascriptInterface(new Bridge(), "KijkboxApp");

        CookieManager.getInstance().setAcceptCookie(true);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Alleen de eigen server in de app; andere links worden niet geopend.
                return !isOwnServer(request.getUrl());
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showError();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
            }
        });

        // Android schrijft cookies anders pas na een tijdje weg. Wordt de app eerder afgesloten,
        // bijvoorbeeld als de tv uitgaat, dan is de inlog kwijt. Daarom regelmatig opslaan.
        handler.postDelayed(flushCookies, 5000);

        SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String saved = prefs.getString(KEY_SERVER, null);
        // Bij installeren via ADB kan het adres meteen mee (alleen als er nog geen adres is):
        //   adb shell am start -n nl.agtenhosting.kijkbox/.MainActivity --es server 192.168.1.50:3000
        String preset = getIntent() != null ? normalize(getIntent().getStringExtra(KEY_SERVER)) : null;
        if (saved == null && preset != null) {
            prefs.edit().putString(KEY_SERVER, preset).apply();
            saved = preset;
        }
        if (saved == null) {
            showSetup(null);
        } else {
            useServer(saved);
            showWeb();
            if (savedInstanceState == null) web.loadUrl(home);
            else web.restoreState(savedInstanceState);
        }
    }

    private boolean isOwnServer(Uri uri) {
        return authority != null && authority.equalsIgnoreCase(uri.getEncodedAuthority());
    }

    private void useServer(String url) {
        home = url;
        authority = Uri.parse(url).getEncodedAuthority();
    }

    private void showWeb() {
        showingSetup = false;
        if (web.getParent() == null) setContentView(web);
        web.requestFocus(View.FOCUS_DOWN);
    }

    /** "192.168.1.50:3000" of "tv.voorbeeld.nl" wordt een volledig adres dat eindigt op "/". */
    static String normalize(String input) {
        String text = input == null ? "" : input.trim();
        if (text.isEmpty()) return null;
        if (!text.matches("(?i)^https?://.*")) text = "http://" + text;
        Uri uri = Uri.parse(text);
        if (uri.getHost() == null || uri.getHost().isEmpty()) return null;
        return uri.getScheme().toLowerCase() + "://" + uri.getEncodedAuthority() + "/";
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
    }

    private void showSetup(String problem) {
        showingSetup = true;
        showingError = false;
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(Color.rgb(16, 18, 22));
        box.setPadding(dp(80), dp(40), dp(80), dp(40));

        TextView title = new TextView(this);
        title.setText("Kijkbox instellen");
        title.setTextColor(Color.rgb(241, 242, 244));
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 30);
        box.addView(title);

        TextView info = new TextView(this);
        info.setText(problem != null ? problem
            : "Vul het adres van je Kijkbox-server in. Thuis bijvoorbeeld 192.168.1.50:3000, of je eigen domein zoals https://tv.voorbeeld.nl.");
        info.setTextColor(problem != null ? Color.rgb(255, 122, 107) : Color.rgb(154, 161, 173));
        info.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        info.setGravity(Gravity.CENTER);
        info.setPadding(0, dp(16), 0, dp(24));
        box.addView(info);

        final EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setImeOptions(EditorInfo.IME_ACTION_DONE);
        input.setTextColor(Color.WHITE);
        input.setHintTextColor(Color.rgb(120, 126, 138));
        input.setHint("192.168.1.50:3000");
        input.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        input.setMinWidth(dp(520));
        if (home != null) input.setText(home);
        box.addView(input);

        Button save = new Button(this);
        save.setText("Opslaan");
        save.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(20);
        box.addView(save, params);

        final Runnable apply = new Runnable() {
            @Override
            public void run() {
                String url = normalize(input.getText().toString());
                if (url == null) {
                    showSetup("Dat is geen geldig adres. Bijvoorbeeld: 192.168.1.50:3000");
                    return;
                }
                getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_SERVER, url).apply();
                useServer(url);
                showWeb();
                web.loadUrl(home);
            }
        };
        save.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                apply.run();
            }
        });
        input.setOnEditorActionListener(new TextView.OnEditorActionListener() {
            @Override
            public boolean onEditorAction(TextView v, int actionId, KeyEvent event) {
                apply.run();
                return true;
            }
        });

        setContentView(box); // haalt de WebView uit beeld; showWeb zet hem terug
        // Pas na OK het toetsenbord: eerst staat de selectie op Opslaan of het invoerveld.
        (home != null ? save : input).requestFocus();
    }

    private void showError() {
        showingError = true;
        String page = "<!doctype html><meta name=viewport content='width=device-width'>"
            + "<body style='margin:0;height:100vh;display:grid;place-content:center;gap:16px;text-align:center;"
            + "background:#101216;color:#f1f2f4;font-family:sans-serif'>"
            + "<h1 style='font-size:28px;margin:0'>Kijkbox is niet bereikbaar</h1>"
            + "<p style='color:#9aa1ad;margin:0'>Controleer de internetverbinding van de tv en of de server aan staat.</p>"
            + "<p style='color:#9aa1ad;margin:0'>Druk op OK om het opnieuw te proberen.</p>"
            + "<p style='color:#9aa1ad;margin:0'>Druk op Omlaag om een ander serveradres in te stellen.</p></body>";
        web.loadDataWithBaseURL(null, page, "text/html", "utf-8", null);
    }

    private static String keyName(int code) {
        switch (code) {
            case KeyEvent.KEYCODE_BACK: return "Back";
            case KeyEvent.KEYCODE_CHANNEL_UP: case KeyEvent.KEYCODE_PAGE_UP: return "ChannelUp";
            case KeyEvent.KEYCODE_CHANNEL_DOWN: case KeyEvent.KEYCODE_PAGE_DOWN: return "ChannelDown";
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE: return "PlayPause";
            case KeyEvent.KEYCODE_MEDIA_PLAY: return "Play";
            case KeyEvent.KEYCODE_MEDIA_PAUSE: return "Pause";
            case KeyEvent.KEYCODE_MEDIA_STOP: return "Stop";
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD: return "Forward";
            case KeyEvent.KEYCODE_MEDIA_REWIND: return "Rewind";
            case KeyEvent.KEYCODE_INFO: return "Info";
            default: return null;
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int code = event.getKeyCode();
        boolean up = event.getAction() == KeyEvent.ACTION_UP;
        if (showingSetup) {
            // Terug in het instelscherm: terug naar de site als er al een adres is, anders afsluiten.
            if (code == KeyEvent.KEYCODE_BACK && up) {
                if (home != null) {
                    showWeb();
                    web.loadUrl(home);
                } else {
                    finish();
                }
                return true;
            }
            return super.dispatchKeyEvent(event);
        }
        if (code == KeyEvent.KEYCODE_MENU && up) {
            showSetup(null);
            return true;
        }
        if (showingError && up) {
            if (code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER) {
                showingError = false;
                web.loadUrl(home);
                return true;
            }
            if (code == KeyEvent.KEYCODE_DPAD_DOWN) {
                showSetup(null);
                return true;
            }
        }
        String name = keyName(code);
        if (name == null || showingError) {
            if (showingError && code == KeyEvent.KEYCODE_BACK && up) finish();
            return super.dispatchKeyEvent(event);
        }
        if (event.getAction() != KeyEvent.ACTION_DOWN || event.getRepeatCount() > 0) return true;
        final boolean isBack = code == KeyEvent.KEYCODE_BACK;
        web.evaluateJavascript(
            "(window.kijkboxKey ? window.kijkboxKey('" + name + "') : false) === true",
            result -> {
                // De website zegt of ze de toets heeft gebruikt. Zo niet, dan sluit Terug de app.
                if (isBack && !"true".equals(result)) finish();
            });
        return true;
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (!showingSetup) web.saveState(outState);
    }

    @Override
    protected void onStop() {
        super.onStop();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(flushCookies);
        CookieManager.getInstance().flush();
        web.destroy();
        super.onDestroy();
    }
}
