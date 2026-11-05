package com.biocode.razkazvach;

import android.content.Context;
import com.k2fsa.sherpa.onnx.GeneratedAudio;
import com.k2fsa.sherpa.onnx.GenerationConfig;
import com.k2fsa.sherpa.onnx.OfflineTts;
import com.k2fsa.sherpa.onnx.OfflineTtsConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsSupertonicModelConfig;
import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.apache.commons.compress.archivers.tar.TarArchiveEntry;
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream;
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream;

/**
 * Offline voice inside the app: the Supertonic 3 model (Bulgarian and 30 other
 * languages, 10 voices) run directly with sherpa-onnx — no separate engine app.
 * The model (~130 MB) is downloaded once; synthesis runs on one background thread.
 */
class LocalVoice {

    interface Listener { void onEvent(String phase, long done, long total, String error); }

    static final String[] FILES = {
        "duration_predictor.int8.onnx", "text_encoder.int8.onnx", "vector_estimator.int8.onnx",
        "vocoder.int8.onnx", "tts.json", "unicode_indexer.bin", "voice.bin",
    };

    private final Context ctx;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ExecutorService installer = Executors.newSingleThreadExecutor();
    private OfflineTts tts;
    private volatile boolean installing = false;

    LocalVoice(Context ctx) { this.ctx = ctx.getApplicationContext(); }

    File dir() { return new File(ctx.getFilesDir(), "voices/supertonic3"); }

    boolean installed() {
        if (!new File(dir(), "ready").exists()) return false;
        for (String f : FILES) if (!new File(dir(), f).exists()) return false;
        return true;
    }

    boolean isInstalling() { return installing; }

    long size() {
        long n = 0;
        File[] fs = dir().listFiles();
        if (fs != null) for (File f : fs) n += f.length();
        return n;
    }

    /** Download the model package (.tar.bz2) and unpack the files the voice needs. */
    void install(String url, Listener l) {
        if (installing) return;
        installing = true;
        installer.execute(() -> {
            File tmp = new File(ctx.getCacheDir(), "supertonic3.tar.bz2");
            File out = new File(ctx.getFilesDir(), "voices/supertonic3.part");
            try {
                // ---- download (continues a broken download where it stopped)
                long have = tmp.exists() ? tmp.length() : 0;
                HttpURLConnection c = open(url, have);
                int code = c.getResponseCode();
                if (code != 200 && code != 206) throw new Exception("HTTP " + code);
                boolean append = code == 206;
                long total = c.getContentLengthLong() + (append ? have : 0);
                if (!append) have = 0;
                try (InputStream in = new BufferedInputStream(c.getInputStream(), 1 << 16);
                     OutputStream os = new FileOutputStream(tmp, append)) {
                    byte[] buf = new byte[1 << 16];
                    int n;
                    long last = 0;
                    while ((n = in.read(buf)) > 0) {
                        os.write(buf, 0, n);
                        have += n;
                        if (have - last > 1_500_000) { last = have; l.onEvent("download", have, total, null); }
                    }
                }
                l.onEvent("download", have, total, null);
                // ---- unpack
                deleteTree(out);
                out.mkdirs();
                l.onEvent("unpack", 0, 0, null);
                try (TarArchiveInputStream tar = new TarArchiveInputStream(
                        new BZip2CompressorInputStream(new BufferedInputStream(new FileInputStream(tmp), 1 << 16)))) {
                    TarArchiveEntry e;
                    byte[] buf = new byte[1 << 16];
                    while ((e = tar.getNextEntry()) != null) {
                        if (e.isDirectory()) continue;
                        String name = new File(e.getName()).getName();
                        boolean wanted = false;
                        for (String f : FILES) if (f.equals(name)) wanted = true;
                        if (!wanted) continue;
                        try (OutputStream os = new FileOutputStream(new File(out, name))) {
                            int n;
                            while ((n = tar.read(buf)) > 0) os.write(buf, 0, n);
                        }
                    }
                }
                for (String f : FILES) if (!new File(out, f).exists()) throw new Exception("липсва " + f);
                new FileOutputStream(new File(out, "ready")).close();
                synchronized (this) {
                    release();
                    deleteTree(dir());
                    if (!out.renameTo(dir())) throw new Exception("файловете не можаха да се преместят");
                }
                tmp.delete();
                l.onEvent("ready", 0, 0, null);
            } catch (Exception e) {
                l.onEvent("error", 0, 0, e.getMessage() == null ? e.toString() : e.getMessage());
            } finally {
                installing = false;
            }
        });
    }

    private HttpURLConnection open(String url, long from) throws Exception {
        for (int hop = 0; hop < 6; hop++) {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(20000);
            c.setReadTimeout(60000);
            if (from > 0) c.setRequestProperty("Range", "bytes=" + from + "-");
            int code = c.getResponseCode();
            if (code >= 300 && code < 400) {
                String loc = c.getHeaderField("Location");
                c.disconnect();
                if (loc == null) throw new Exception("пренасочване без адрес");
                url = new URL(new URL(url), loc).toString();
                continue;
            }
            return c;
        }
        throw new Exception("твърде много пренасочвания");
    }

    void delete() {
        worker.execute(() -> {
            synchronized (this) { release(); deleteTree(dir()); }
        });
    }

    private void release() {
        if (tts != null) { try { tts.release(); } catch (Throwable ignored) {} tts = null; }
    }

    private OfflineTts engine() {
        if (tts != null) return tts;
        File d = dir();
        OfflineTtsSupertonicModelConfig st = new OfflineTtsSupertonicModelConfig();
        st.setDurationPredictor(new File(d, "duration_predictor.int8.onnx").getAbsolutePath());
        st.setTextEncoder(new File(d, "text_encoder.int8.onnx").getAbsolutePath());
        st.setVectorEstimator(new File(d, "vector_estimator.int8.onnx").getAbsolutePath());
        st.setVocoder(new File(d, "vocoder.int8.onnx").getAbsolutePath());
        st.setTtsJson(new File(d, "tts.json").getAbsolutePath());
        st.setUnicodeIndexer(new File(d, "unicode_indexer.bin").getAbsolutePath());
        st.setVoiceStyle(new File(d, "voice.bin").getAbsolutePath());
        OfflineTtsModelConfig m = new OfflineTtsModelConfig();
        m.setSupertonic(st);
        m.setNumThreads(Math.max(2, Math.min(4, Runtime.getRuntime().availableProcessors())));
        m.setDebug(false);
        m.setProvider("cpu");
        OfflineTtsConfig cfg = new OfflineTtsConfig();
        cfg.setModel(m);
        cfg.setMaxNumSentences(1);
        tts = new OfflineTts(null, cfg);
        return tts;
    }

    interface Result { void done(String base64Wav, String error); }

    /** Synthesize text → mono 16-bit WAV at 24 kHz (base64), on the voice thread. */
    void synthesize(String text, int sid, int steps, float speed, String lang, Result r) {
        worker.execute(() -> {
            try {
                if (!installed()) throw new Exception("Офлайн гласът не е изтеглен.");
                GeneratedAudio a;
                synchronized (this) {
                    GenerationConfig g = new GenerationConfig();
                    g.setSid(sid);
                    g.setNumSteps(steps);
                    g.setSpeed(speed);
                    Map<String, String> extra = new HashMap<>();
                    extra.put("lang", lang == null || lang.isEmpty() ? "bg" : lang);
                    g.setExtra(extra);
                    a = engine().generateWithConfig(text, g);
                }
                float[] s = a.getSamples();
                int rate = a.getSampleRate();
                if (s == null || s.length == 0) throw new Exception("Гласът не върна звук.");
                r.done(android.util.Base64.encodeToString(wav(s, rate, 24000), android.util.Base64.NO_WRAP), null);
            } catch (Throwable e) {
                r.done(null, e.getMessage() == null ? e.toString() : e.getMessage());
            }
        });
    }

    // Float samples at `from` Hz → 16-bit WAV at `to` Hz (linear interpolation)
    private static byte[] wav(float[] s, int from, int to) {
        int n = from == to ? s.length : (int) ((long) s.length * to / from);
        ByteBuffer b = ByteBuffer.allocate(44 + n * 2).order(ByteOrder.LITTLE_ENDIAN);
        b.put("RIFF".getBytes()).putInt(36 + n * 2).put("WAVE".getBytes());
        b.put("fmt ".getBytes()).putInt(16).putShort((short) 1).putShort((short) 1)
            .putInt(to).putInt(to * 2).putShort((short) 2).putShort((short) 16);
        b.put("data".getBytes()).putInt(n * 2);
        double step = (double) from / to;
        for (int i = 0; i < n; i++) {
            double x = i * step;
            int k = (int) x;
            float f = (float) (x - k);
            float v0 = s[Math.min(k, s.length - 1)], v1 = s[Math.min(k + 1, s.length - 1)];
            float v = v0 + (v1 - v0) * f;
            b.putShort((short) Math.max(-32768, Math.min(32767, Math.round(v * 32767))));
        }
        return b.array();
    }

    private static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] fs = f.listFiles();
        if (fs != null) for (File x : fs) deleteTree(x);
        f.delete();
    }
}
