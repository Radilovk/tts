package com.biocode.razkazvach;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.PlaybackParams;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import java.io.File;

/**
 * Plays the narrated passages (Google HD, Gemini) with Android's own MediaPlayer
 * instead of the WebView's audio element. In the WebView, losing the audio output
 * (audio focus, Bluetooth or speaker switch, screen off) left the element "playing"
 * into a silent output: the text kept moving while nothing was heard. MediaPlayer
 * owns the real output, takes audio focus, pauses for calls and resumes after them,
 * and pauses when headphones are unplugged.
 *
 * Everything runs on the main thread; events go to the web side through Listener.
 */
class NarrationPlayer {

    interface Listener {
        void onEvent(String type, double time, double duration, String detail);
    }

    private final Context ctx;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AudioManager am;
    private MediaPlayer mp;
    private boolean prepared = false;
    private boolean playing = false;
    private boolean resumeOnGain = false;
    private float rate = 1f;
    private float volume = 1f;
    private boolean ducked = false;
    private AudioFocusRequest focusRequest;
    private boolean noisyRegistered = false;
    private int fileIndex = 0;

    NarrationPlayer(Context ctx, Listener listener) {
        this.ctx = ctx.getApplicationContext();
        this.listener = listener;
        this.am = (AudioManager) this.ctx.getSystemService(Context.AUDIO_SERVICE);
    }

    void post(Runnable r) { main.post(r); }

    File nextFile() {
        File dir = new File(ctx.getCacheDir(), "narration");
        if (!dir.exists()) dir.mkdirs();
        fileIndex = (fileIndex + 1) % 3;
        return new File(dir, "passage" + fileIndex);
    }

    /** Prepare a passage; returns its duration in seconds. Main thread. */
    double load(File f) throws Exception {
        stopTicker();
        if (mp != null) {
            try { mp.release(); } catch (Exception ignored) {}
        }
        prepared = false;
        playing = false;
        mp = new MediaPlayer();
        mp.setAudioAttributes(new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build());
        mp.setWakeMode(ctx, PowerManager.PARTIAL_WAKE_LOCK);
        mp.setDataSource(f.getAbsolutePath());
        mp.prepare();
        prepared = true;
        applyVolume();
        final MediaPlayer self = mp;
        mp.setOnCompletionListener(p -> {
            if (p != mp) return;
            playing = false;
            stopTicker();
            emit("ended", self);
        });
        mp.setOnErrorListener((p, what, extra) -> {
            if (p != mp) return true;
            playing = false;
            prepared = false;
            stopTicker();
            listener.onEvent("error", 0, 0, what + "/" + extra);
            return true;
        });
        return mp.getDuration() / 1000.0;
    }

    void play() {
        if (mp == null || !prepared) throw new IllegalStateException("Няма заредено аудио.");
        if (!requestFocus()) throw new IllegalStateException("Android не даде звука (тече разговор?).");
        mp.start();
        applyRate();
        playing = true;
        resumeOnGain = false;
        registerNoisy();
        startTicker();
        emit("play", mp);
    }

    void pause(String reason) {
        if (mp != null && prepared && mp.isPlaying()) mp.pause();
        boolean was = playing;
        playing = false;
        stopTicker();
        if (reason != null && was) emit("pause:" + reason, mp);
        if (reason == null) {
            abandonFocus();
            unregisterNoisy();
        }
    }

    void seek(double seconds) {
        if (mp == null || !prepared) return;
        mp.seekTo((int) Math.round(seconds * 1000));
        emit("time", mp);
    }

    void setRate(float r) {
        rate = r;
        if (playing) applyRate();
    }

    void setVolume(float v) {
        volume = v;
        applyVolume();
    }

    void stop() {
        stopTicker();
        playing = false;
        resumeOnGain = false;
        if (mp != null) {
            try { mp.release(); } catch (Exception ignored) {}
            mp = null;
        }
        prepared = false;
        abandonFocus();
        unregisterNoisy();
    }

    // setPlaybackParams on a paused MediaPlayer starts it, so the speed is applied
    // only while playing.
    private void applyRate() {
        if (mp == null || Build.VERSION.SDK_INT < 23) return;
        try {
            PlaybackParams p = mp.getPlaybackParams();
            if (Math.abs(p.getSpeed() - rate) > 0.001f) mp.setPlaybackParams(p.setSpeed(rate).setPitch(1f));
        } catch (Exception ignored) {}
    }

    private void applyVolume() {
        if (mp == null) return;
        float v = volume * (ducked ? 0.3f : 1f);
        try { mp.setVolume(v, v); } catch (Exception ignored) {}
    }

    // ---- position updates for the text view (2 per second: enough for the highlight,
    // half the wake-ups of the web side with the screen off)

    private final Runnable ticker = new Runnable() {
        @Override public void run() {
            if (mp == null || !playing) return;
            emit("time", mp);
            main.postDelayed(this, 500);
        }
    };

    private void startTicker() {
        main.removeCallbacks(ticker);
        main.post(ticker);
    }

    private void stopTicker() {
        main.removeCallbacks(ticker);
    }

    private void emit(String type, MediaPlayer p) {
        double t = 0, d = 0;
        try {
            if (p != null && prepared) {
                t = p.getCurrentPosition() / 1000.0;
                d = p.getDuration() / 1000.0;
            }
        } catch (Exception ignored) {}
        listener.onEvent(type, t, d, "");
    }

    // ---- audio focus: calls, navigation prompts, other players

    private final AudioManager.OnAudioFocusChangeListener focusListener = change -> {
        switch (change) {
            case AudioManager.AUDIOFOCUS_LOSS:
                resumeOnGain = false;
                pause("focus");
                abandonFocus();
                break;
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:
                if (playing) {
                    resumeOnGain = true;
                    pause("focus");
                }
                break;
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK:
                ducked = true;
                applyVolume();
                break;
            case AudioManager.AUDIOFOCUS_GAIN:
                ducked = false;
                applyVolume();
                if (resumeOnGain && mp != null && prepared) {
                    resumeOnGain = false;
                    mp.start();
                    applyRate();
                    playing = true;
                    startTicker();
                    emit("play", mp);
                }
                break;
            default:
                break;
        }
    };

    private boolean requestFocus() {
        if (am == null) return true;
        int r;
        if (Build.VERSION.SDK_INT >= 26) {
            if (focusRequest == null) {
                focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build())
                    .setWillPauseWhenDucked(false)
                    .setOnAudioFocusChangeListener(focusListener, main)
                    .build();
            }
            r = am.requestAudioFocus(focusRequest);
        } else {
            r = am.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
        }
        return r == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
    }

    private void abandonFocus() {
        if (am == null) return;
        if (Build.VERSION.SDK_INT >= 26) {
            if (focusRequest != null) am.abandonAudioFocusRequest(focusRequest);
        } else {
            am.abandonAudioFocus(focusListener);
        }
    }

    // ---- headphones unplugged / Bluetooth gone: pause instead of playing aloud

    private final BroadcastReceiver noisy = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(i.getAction()) && playing) {
                resumeOnGain = false;
                pause("noisy");
            }
        }
    };

    private void registerNoisy() {
        if (noisyRegistered) return;
        IntentFilter f = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
        if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(noisy, f, Context.RECEIVER_NOT_EXPORTED);
        else ctx.registerReceiver(noisy, f);
        noisyRegistered = true;
    }

    private void unregisterNoisy() {
        if (!noisyRegistered) return;
        try { ctx.unregisterReceiver(noisy); } catch (Exception ignored) {}
        noisyRegistered = false;
    }
}
