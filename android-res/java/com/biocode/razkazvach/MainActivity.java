package com.biocode.razkazvach;

import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins must be registered before the bridge starts.
        registerPlugin(RazkazvachPlugin.class);
        super.onCreate(savedInstanceState);
    }

    // While a book is being read, keep the WebView running in the background
    // (screen off / other app in front) so the next part keeps coming.
    @Override
    public void onPause() {
        super.onPause();
        keepWebViewAlive();
    }

    @Override
    public void onStop() {
        super.onStop();
        keepWebViewAlive();
    }

    private void keepWebViewAlive() {
        if (!ReaderService.active || getBridge() == null) return;
        WebView w = getBridge().getWebView();
        if (w == null) return;
        w.onResume();
        w.resumeTimers();
    }
}
