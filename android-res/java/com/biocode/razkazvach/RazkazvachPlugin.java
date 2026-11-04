package com.biocode.razkazvach;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
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
import java.io.FileInputStream;
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
        if (narration != null) {
            NarrationPlayer n = narration;
            n.post(n::stop);
            narration = null;
        }
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
        // An engine that never reports back (broken or missing) must not leave the
        // reader waiting forever: after 10 s the waiting requests fail with a message
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
            List<Runnable> run;
            synchronized (pendingTts) {
                if (!ttsInitializing) return;
                ttsInitializing = false;
                ttsReady = false;
                run = new ArrayList<>(pendingTts);
                pendingTts.clear();
            }
            for (Runnable x : run) x.run();
        }, 10000);
    }

    private final UtteranceProgressListener progressListener = new UtteranceProgressListener() {
        @Override
        public void onStart(String id) {
            emit("ttsStart", id);
        }

        @Override
        public void onDone(String id) {
            if (finishRender(id, null)) return;
            emit("ttsDone", id);
        }

        @Override
        public void onError(String id) {
            if (finishRender(id, "Гласовият двигател не можа да запише откъса.")) return;
            emit("ttsError", id);
        }

        @Override
        public void onError(String id, int errorCode) {
            if (finishRender(id, "Гласовият двигател не можа да запише откъса (код " + errorCode + ").")) return;
            emit("ttsError", id);
        }

        // The engine says which part of the text it is speaking (Android 8+): the web side
        // moves the highlight to that sentence of the paragraph
        @Override
        public void onRangeStart(String id, int start, int end, int frame) {
            JSObject data = new JSObject();
            data.put("id", id);
            data.put("start", start);
            notifyListeners("ttsRange", data);
        }

        @Override
        public void onStop(String id, boolean interrupted) {
            if (finishRender(id, "Записът беше прекъснат.")) return;
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
                call.reject("Гласовият двигател на телефона не се стартира. Изберете друг двигател в Настройки → Гласов двигател.", "TTS_INIT");
                return;
            }
            Voice v = voiceName == null ? null : voicesByName.get(voiceName);
            if (v != null) tts.setVoice(v);
            else if (lang != null && !lang.isEmpty()) {
                int lr = tts.setLanguage(Locale.forLanguageTag(lang));
                // The engine has no voice for this language: say so instead of reading
                // in another language or staying silent
                if (lr == TextToSpeech.LANG_MISSING_DATA || lr == TextToSpeech.LANG_NOT_SUPPORTED) {
                    call.reject(lr == TextToSpeech.LANG_MISSING_DATA
                        ? "Гласът за този език не е изтеглен в гласовия двигател на телефона."
                        : "Гласовият двигател на телефона няма глас на този език.", "NO_LANG");
                    return;
                }
            }
            tts.setSpeechRate(rate);
            tts.setPitch(pitch);
            Bundle params = new Bundle();
            int r = tts.speak(text, flush ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD, params, id);
            if (pauseAfter > 0) tts.playSilentUtterance(pauseAfter, TextToSpeech.QUEUE_ADD, id + ":pause");
            if (r == TextToSpeech.ERROR) call.reject("Грешка при четене.");
            else call.resolve();
        });
    }

    // ---- recording a passage to a file ("studio" mode for the phone voice) ----
    // The engine renders the text into a WAV file instead of speaking it; the web side
    // trims long silences, levels it and plays it like any narrated passage.

    private final Map<String, PluginCall> renders = new HashMap<>();
    private final Map<String, File> renderFiles = new HashMap<>();

    private boolean finishRender(String id, String error) {
        PluginCall call;
        File f;
        synchronized (renders) {
            call = renders.remove(id);
            f = renderFiles.remove(id);
        }
        if (call == null) return false;
        if (error != null || f == null || !f.exists() || f.length() < 100) {
            call.reject(error != null ? error : "Гласовият двигател не записа нищо.", "RENDER_FAILED");
            if (f != null) f.delete();
            return true;
        }
        try (InputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[(int) f.length()];
            int off = 0, n;
            while (off < buf.length && (n = in.read(buf, off, buf.length - off)) > 0) off += n;
            JSObject ret = new JSObject();
            ret.put("data", Base64.encodeToString(buf, 0, off, Base64.NO_WRAP));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Записът не можа да се прочете: " + e.getMessage(), "RENDER_FAILED");
        } finally {
            f.delete();
        }
        return true;
    }

    @PluginMethod
    public void renderToFile(PluginCall call) {
        String id = "render-" + System.nanoTime();
        String text = call.getString("text", "");
        String voiceName = call.getString("voice", "");
        String lang = call.getString("lang", "");
        float pitch = call.getFloat("pitch", 1f);
        withTts(() -> {
            if (!ttsReady) {
                call.reject("Гласовият двигател на телефона не се стартира.", "TTS_INIT");
                return;
            }
            Voice v = voiceName == null ? null : voicesByName.get(voiceName);
            if (v != null) tts.setVoice(v);
            else if (lang != null && !lang.isEmpty()) {
                int lr = tts.setLanguage(Locale.forLanguageTag(lang));
                if (lr == TextToSpeech.LANG_MISSING_DATA || lr == TextToSpeech.LANG_NOT_SUPPORTED) {
                        call.reject("Гласовият двигател на телефона няма глас на този език.", "NO_LANG");
                    return;
                }
            }
            tts.setSpeechRate(1f);
            tts.setPitch(pitch);
            File dir = new File(getContext().getCacheDir(), "render");
            if (!dir.exists()) dir.mkdirs();
            File f = new File(dir, id + ".wav");
            synchronized (renders) {
                renders.put(id, call);
                renderFiles.put(id, f);
            }
            int r = tts.synthesizeToFile(text, new Bundle(), f, id);
            if (r == TextToSpeech.ERROR) finishRender(id, "Гласовият двигател не може да записва във файл.");
        });
    }

    /** Open the speech engine's own app (Supertonic: voice mix, quality, de-esser). */
    @PluginMethod
    public void openEngineApp(PluginCall call) {
        String pkg = enginePackage;
        if ((pkg == null || pkg.isEmpty()) && tts != null) pkg = tts.getDefaultEngine();
        Intent i = pkg == null ? null : getContext().getPackageManager().getLaunchIntentForPackage(pkg);
        if (i == null) { call.reject("Този двигател няма собствени настройки."); return; }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
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

    // ------------------------------------------------------- narration audio

    private NarrationPlayer narration;

    private NarrationPlayer narration() {
        if (narration == null) {
            narration = new NarrationPlayer(getContext(), (type, time, duration, detail) -> {
                JSObject data = new JSObject();
                data.put("type", type);
                data.put("time", time);
                data.put("duration", duration);
                data.put("detail", detail);
                notifyListeners("audio", data);
            });
        }
        return narration;
    }

    /** Write a passage (base64) to the app cache and prepare it; resolves { duration }. */
    @PluginMethod
    public void audioLoad(PluginCall call) {
        NarrationPlayer n = narration();
        File f = n.nextFile();
        try (OutputStream os = new FileOutputStream(f, false)) {
            os.write(Base64.decode(call.getString("data", ""), Base64.DEFAULT));
        } catch (Exception e) {
            call.reject("Аудиото не можа да се запише: " + e.getMessage());
            return;
        }
        n.post(() -> {
            try {
                double d = n.load(f);
                JSObject ret = new JSObject();
                ret.put("duration", d);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Аудиото не може да се възпроизведе: " + e.getMessage(), "NotSupportedError");
            }
        });
    }

    @PluginMethod
    public void audioPlay(PluginCall call) {
        NarrationPlayer n = narration();
        n.post(() -> {
            try { n.play(); call.resolve(); } catch (Exception e) { call.reject(e.getMessage(), "NotAllowedError"); }
        });
    }

    @PluginMethod
    public void audioPause(PluginCall call) {
        NarrationPlayer n = narration();
        n.post(() -> { n.pause(null); call.resolve(); });
    }

    @PluginMethod
    public void audioSeek(PluginCall call) {
        NarrationPlayer n = narration();
        double t = call.getDouble("time", 0.0);
        n.post(() -> { n.seek(t); call.resolve(); });
    }

    @PluginMethod
    public void audioRate(PluginCall call) {
        NarrationPlayer n = narration();
        float r = call.getFloat("rate", 1f);
        n.post(() -> { n.setRate(r); call.resolve(); });
    }

    @PluginMethod
    public void audioVolume(PluginCall call) {
        NarrationPlayer n = narration();
        float v = call.getFloat("volume", 1f);
        n.post(() -> { n.setVolume(v); call.resolve(); });
    }

    @PluginMethod
    public void audioStop(PluginCall call) {
        NarrationPlayer n = narration();
        n.post(() -> { n.stop(); call.resolve(); });
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

    // ------------------------------------------------------- saving audio files

    private final Map<String, File> exports = new HashMap<>();

    /** Start a file in the app cache; the web side then appends it in base64 pieces. */
    @PluginMethod
    public void fileBegin(PluginCall call) {
        String id = "x" + System.currentTimeMillis();
        File dir = new File(getContext().getCacheDir(), "exports");
        if (!dir.exists()) dir.mkdirs();
        File f = new File(dir, id + ".part");
        if (f.exists()) f.delete();
        exports.put(id, f);
        JSObject ret = new JSObject();
        ret.put("id", id);
        call.resolve(ret);
    }

    @PluginMethod
    public void fileAppend(PluginCall call) {
        File f = exports.get(call.getString("id", ""));
        if (f == null) { call.reject("Няма такъв файл."); return; }
        try (OutputStream os = new FileOutputStream(f, true)) {
            os.write(Base64.decode(call.getString("data", ""), Base64.DEFAULT));
            call.resolve();
        } catch (Exception e) {
            call.reject("Грешка при запис: " + e.getMessage());
        }
    }

    /** Move the finished file into Downloads/Razkazvach (visible to every app). */
    @PluginMethod
    public void fileEnd(PluginCall call) {
        String id = call.getString("id", "");
        File f = exports.remove(id);
        String name = safeName(call.getString("name", "audio.ogg"));
        String mime = call.getString("mime", "audio/ogg");
        if (f == null) { call.reject("Няма такъв файл."); return; }
        new Thread(() -> {
            try {
                String where;
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                    v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Razkazvach");
                    v.put(MediaStore.MediaColumns.IS_PENDING, 1);
                    ContentResolver cr = getContext().getContentResolver();
                    Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (uri == null) throw new Exception("MediaStore отказа файла");
                    try (InputStream in = new FileInputStream(f); OutputStream os = cr.openOutputStream(uri)) {
                        byte[] buf = new byte[256 * 1024];
                        int n;
                        while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                    }
                    v.clear();
                    v.put(MediaStore.MediaColumns.IS_PENDING, 0);
                    cr.update(uri, v, null, null);
                    where = Environment.DIRECTORY_DOWNLOADS + "/Razkazvach/" + name;
                } else {
                    File dir = new File(getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "Razkazvach");
                    if (!dir.exists()) dir.mkdirs();
                    File out = new File(dir, name);
                    try (InputStream in = new FileInputStream(f); OutputStream os = new FileOutputStream(out)) {
                        byte[] buf = new byte[256 * 1024];
                        int n;
                        while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                    }
                    where = out.getAbsolutePath();
                }
                f.delete();
                JSObject ret = new JSObject();
                ret.put("path", where);
                call.resolve(ret);
            } catch (Exception e) {
                f.delete();
                call.reject("Файлът не можа да се запише: " + e.getMessage());
            }
        }).start();
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
