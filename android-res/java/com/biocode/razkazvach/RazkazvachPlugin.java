package com.biocode.razkazvach;

import android.Manifest;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Native side of Разказвач:
 *  - Android TextToSpeech with every installed engine and voice; utterances are
 *    queued natively so reading continues with the screen off;
 *  - the foreground playback service (notification, lock screen, headset buttons);
 *  - books shared to the app or opened with it.
 */
@CapacitorPlugin(name = "Razkazvach")
public class RazkazvachPlugin extends Plugin {

    private static RazkazvachPlugin instance;

    private TextToSpeech tts;
    private boolean ttsReady = false;
    private boolean ttsInitializing = false;
    private String enginePackage = null;
    private final List<Runnable> pendingTts = new ArrayList<>();
    private final Map<String, Voice> voicesByName = new HashMap<>();
    private JSObject pendingFile = null;

    @Override
    public void load() {
        instance = this;
        handleIntent(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        handleIntent(intent);
    }

    @Override
    protected void handleOnDestroy() {
        if (tts != null) {
            tts.shutdown();
            tts = null;
        }
        ReaderService.stop(getContext());
        instance = null;
    }

    /** Called by ReaderService for notification / headset / lock screen actions. */
    static void emitMediaAction(String action) {
        RazkazvachPlugin p = instance;
        if (p == null) return;
        JSObject data = new JSObject();
        data.put("action", action);
        p.notifyListeners("mediaAction", data);
    }

    // ---------------------------------------------------------------- TTS

    private void withTts(Runnable r) {
        synchronized (pendingTts) {
            if (tts != null && ttsReady) {
                r.run();
                return;
            }
            pendingTts.add(r);
            if (ttsInitializing) return;
            ttsInitializing = true;
        }
        TextToSpeech.OnInitListener listener = status -> {
            List<Runnable> run;
            synchronized (pendingTts) {
                ttsReady = status == TextToSpeech.SUCCESS;
                ttsInitializing = false;
                run = new ArrayList<>(pendingTts);
                pendingTts.clear();
            }
            if (ttsReady) {
                tts.setOnUtteranceProgressListener(progressListener);
                refreshVoices();
            }
            for (Runnable x : run) x.run();
        };
        tts = enginePackage == null
            ? new TextToSpeech(getContext(), listener)
            : new TextToSpeech(getContext(), listener, enginePackage);
    }

    private final UtteranceProgressListener progressListener = new UtteranceProgressListener() {
        @Override
        public void onStart(String id) {
            emit("ttsStart", id);
        }

        @Override
        public void onDone(String id) {
            emit("ttsDone", id);
        }

        @Override
        public void onError(String id) {
            emit("ttsError", id);
        }

        @Override
        public void onError(String id, int errorCode) {
            emit("ttsError", id);
        }

        @Override
        public void onStop(String id, boolean interrupted) {
            // Stopped on purpose (pause / seek) — the web side already knows.
        }

        private void emit(String event, String id) {
            JSObject data = new JSObject();
            data.put("id", id);
            notifyListeners(event, data);
        }
    };

    private void refreshVoices() {
        voicesByName.clear();
        try {
            Set<Voice> voices = tts.getVoices();
            if (voices != null) for (Voice v : voices) voicesByName.put(v.getName(), v);
        } catch (Exception ignored) {
        }
    }

    @PluginMethod
    public void getEngines(PluginCall call) {
        withTts(() -> {
            JSArray list = new JSArray();
            if (tts != null) {
                for (TextToSpeech.EngineInfo e : tts.getEngines()) {
                    JSObject o = new JSObject();
                    o.put("name", e.name);
                    o.put("label", e.label);
                    list.put(o);
                }
            }
            JSObject ret = new JSObject();
            ret.put("engines", list);
            ret.put("current", enginePackage != null ? enginePackage : (tts != null ? tts.getDefaultEngine() : ""));
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void setEngine(PluginCall call) {
        String engine = call.getString("engine", "");
        String target = engine == null || engine.isEmpty() ? null : engine;
        boolean same = (target == null && enginePackage == null) || (target != null && target.equals(enginePackage));
        if (!same || tts == null) {
            synchronized (pendingTts) {
                if (tts != null) tts.shutdown();
                tts = null;
                ttsReady = false;
                enginePackage = target;
            }
        }
        withTts(() -> {
            if (ttsReady) call.resolve();
            else call.reject("Гласовият двигател не може да се стартира.");
        });
    }

    @PluginMethod
    public void getVoices(PluginCall call) {
        withTts(() -> {
            if (!ttsReady) {
                call.reject("Синтезът на реч не е наличен на това устройство.");
                return;
            }
            refreshVoices();
            JSArray list = new JSArray();
            for (Voice v : voicesByName.values()) {
                Set<String> features = v.getFeatures();
                JSObject o = new JSObject();
                o.put("name", v.getName());
                o.put("locale", v.getLocale().toLanguageTag());
                o.put("language", v.getLocale().getLanguage());
                o.put("quality", v.getQuality());
                o.put("network", v.isNetworkConnectionRequired());
                o.put("installed", features == null || !features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED));
                list.put(o);
            }
            JSObject ret = new JSObject();
            ret.put("voices", list);
            call.resolve(ret);
        });
    }

    /**
     * Queue one utterance. flush=true replaces whatever is queued (start / seek).
     * pauseAfter (ms) adds a natural silence after it (paragraph breaks).
     */
    @PluginMethod
    public void speak(PluginCall call) {
        String id = call.getString("id", "u");
        String text = call.getString("text", "");
        String voiceName = call.getString("voice", "");
        String lang = call.getString("lang", "");
        float rate = call.getFloat("rate", 1f);
        float pitch = call.getFloat("pitch", 1f);
        boolean flush = Boolean.TRUE.equals(call.getBoolean("flush", false));
        int pauseAfter = call.getInt("pauseAfter", 0);
        withTts(() -> {
            if (!ttsReady) {
                call.reject("Синтезът на реч не е наличен на това устройство.");
                return;
            }
            Voice v = voiceName == null ? null : voicesByName.get(voiceName);
            if (v != null) tts.setVoice(v);
            else if (lang != null && !lang.isEmpty()) tts.setLanguage(Locale.forLanguageTag(lang));
            tts.setSpeechRate(rate);
            tts.setPitch(pitch);
            Bundle params = new Bundle();
            int r = tts.speak(text, flush ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD, params, id);
            if (pauseAfter > 0) tts.playSilentUtterance(pauseAfter, TextToSpeech.QUEUE_ADD, id + ":pause");
            if (r == TextToSpeech.ERROR) call.reject("Грешка при четене.");
            else call.resolve();
        });
    }

    @PluginMethod
    public void stopSpeaking(PluginCall call) {
        if (tts != null) tts.stop();
        call.resolve();
    }

    @PluginMethod
    public void openTtsSettings(PluginCall call) {
        try {
            Intent i = new Intent("com.android.settings.TTS_SETTINGS");
            i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (Exception e) {
            Intent i = new Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA);
            i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try { getContext().startActivity(i); } catch (Exception ignored) { }
        }
        call.resolve();
    }

    // ------------------------------------------------------- playback service

    @PluginMethod
    public void updatePlayback(PluginCall call) {
        String title = call.getString("title", "Разказвач");
        String subtitle = call.getString("subtitle", "");
        boolean playing = Boolean.TRUE.equals(call.getBoolean("playing", false));
        if (playing) askNotificationPermissionOnce();
        ReaderService.update(getContext(), title, subtitle, playing);
        call.resolve();
    }

    @PluginMethod
    public void stopPlayback(PluginCall call) {
        ReaderService.stop(getContext());
        call.resolve();
    }

    private void askNotificationPermissionOnce() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        android.content.SharedPreferences prefs = getContext().getSharedPreferences("razkazvach", Context.MODE_PRIVATE);
        if (prefs.getBoolean("askedNotifications", false)) return;
        prefs.edit().putBoolean("askedNotifications", true).apply();
        ActivityCompat.requestPermissions(getActivity(), new String[] { Manifest.permission.POST_NOTIFICATIONS }, 4711);
    }

    // ------------------------------------------------------------ shared files

    @PluginMethod
    public void getPendingFile(PluginCall call) {
        JSObject ret = new JSObject();
        if (pendingFile != null) {
            ret.put("file", pendingFile);
            pendingFile = null;
        }
        call.resolve(ret);
    }

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_VIEW.equals(action)) return;
        final Uri uri = Intent.ACTION_SEND.equals(action)
            ? (Uri) intent.getParcelableExtra(Intent.EXTRA_STREAM)
            : intent.getData();
        final String sharedText = intent.getStringExtra(Intent.EXTRA_TEXT);
        final String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        // Handle each share once, also across activity re-creation
        getActivity().setIntent(new Intent(Intent.ACTION_MAIN));
        new Thread(() -> {
            try {
                File dir = new File(getContext().getCacheDir(), "shared");
                if (!dir.exists()) dir.mkdirs();
                File out;
                if (uri != null) {
                    String name = displayName(uri);
                    out = new File(dir, safeName(name));
                    ContentResolver cr = getContext().getContentResolver();
                    try (InputStream in = cr.openInputStream(uri); OutputStream os = new FileOutputStream(out)) {
                        if (in == null) return;
                        byte[] buf = new byte[64 * 1024];
                        int n;
                        while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                    }
                } else if (sharedText != null && !sharedText.trim().isEmpty()) {
                    String name = (subject != null && !subject.trim().isEmpty() ? subject.trim() : "Споделен текст") + ".txt";
                    out = new File(dir, safeName(name));
                    try (OutputStream os = new FileOutputStream(out)) {
                        os.write(sharedText.getBytes(StandardCharsets.UTF_8));
                    }
                } else {
                    return;
                }
                JSObject file = new JSObject();
                file.put("path", out.getAbsolutePath());
                file.put("name", out.getName());
                pendingFile = file;
                JSObject data = new JSObject();
                data.put("file", file);
                notifyListeners("sharedFile", data, true);
            } catch (Exception e) {
                JSObject data = new JSObject();
                data.put("error", String.valueOf(e.getMessage()));
                notifyListeners("sharedFile", data, true);
            }
        }).start();
    }

    private String displayName(Uri uri) {
        String name = null;
        if ("content".equals(uri.getScheme())) {
            try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                if (c != null && c.moveToFirst()) name = c.getString(0);
            } catch (Exception ignored) {
            }
        }
        if (name == null) name = uri.getLastPathSegment();
        if (name == null || name.isEmpty()) name = "книга";
        if (!name.contains(".")) {
            String type = getContext().getContentResolver().getType(uri);
            if (type != null) {
                if (type.contains("epub")) name += ".epub";
                else if (type.contains("pdf")) name += ".pdf";
                else if (type.contains("fictionbook")) name += ".fb2";
                else if (type.contains("wordprocessingml")) name += ".docx";
                else if (type.contains("html")) name += ".html";
                else if (type.startsWith("text/")) name += ".txt";
            }
        }
        return name;
    }

    private static String safeName(String name) {
        String s = name.replaceAll("[\\\\/:*?\"<>|\\n\\r]+", "_").trim();
        if (s.length() > 120) s = s.substring(s.length() - 120);
        return s.isEmpty() ? "книга" : s;
    }
}
