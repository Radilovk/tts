package com.biocode.razkazvach;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * Foreground "media playback" service. While it runs, Android keeps the app
 * (and its WebView) alive with the screen off, the CPU and Wi-Fi stay awake
 * during playback, and the notification / lock screen / headset buttons
 * control the reader.
 */
public class ReaderService extends Service {

    static final String CHANNEL = "reader";
    static final int NOTIFICATION_ID = 7;
    static volatile boolean active = false;

    private static String title = "Разказвач";
    private static String subtitle = "";
    private static boolean playing = false;

    private MediaSessionCompat session;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    public static void update(Context ctx, String t, String s, boolean p) {
        title = t;
        subtitle = s;
        playing = p;
        // Start the service only for playback; later updates (pause) just refresh it
        if (!active && !p) return;
        Intent i = new Intent(ctx, ReaderService.class).setAction("UPDATE");
        ContextCompat.startForegroundService(ctx, i);
    }

    public static void stop(Context ctx) {
        ctx.stopService(new Intent(ctx, ReaderService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        active = true;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Четене", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Контроли за четенето");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        session = new MediaSessionCompat(this, "Razkazvach");
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() { RazkazvachPlugin.emitMediaAction("play"); }
            @Override public void onPause() { RazkazvachPlugin.emitMediaAction("pause"); }
            @Override public void onStop() { RazkazvachPlugin.emitMediaAction("pause"); }
            @Override public void onSkipToNext() { RazkazvachPlugin.emitMediaAction("next"); }
            @Override public void onSkipToPrevious() { RazkazvachPlugin.emitMediaAction("prev"); }
            @Override public void onFastForward() { RazkazvachPlugin.emitMediaAction("forward"); }
            @Override public void onRewind() { RazkazvachPlugin.emitMediaAction("back"); }
        });
        session.setActive(true);
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "razkazvach:reader");
        wakeLock.setReferenceCounted(false);
        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wm != null) {
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "razkazvach:reader");
            wifiLock.setReferenceCounted(false);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if ("PLAY".equals(action)) RazkazvachPlugin.emitMediaAction("play");
        else if ("PAUSE".equals(action)) RazkazvachPlugin.emitMediaAction("pause");
        else if ("BACK".equals(action)) RazkazvachPlugin.emitMediaAction("back");
        else if ("FORWARD".equals(action)) RazkazvachPlugin.emitMediaAction("forward");
        else if ("CLOSE".equals(action)) {
            RazkazvachPlugin.emitMediaAction("pause");
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        refresh();
        return START_NOT_STICKY;
    }

    private void refresh() {
        long actions = PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE | PlaybackStateCompat.ACTION_PLAY_PAUSE
            | PlaybackStateCompat.ACTION_SKIP_TO_NEXT | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
            | PlaybackStateCompat.ACTION_FAST_FORWARD | PlaybackStateCompat.ACTION_REWIND | PlaybackStateCompat.ACTION_STOP;
        session.setPlaybackState(new PlaybackStateCompat.Builder()
            .setActions(actions)
            .setState(playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
                PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, 1f)
            .build());
        session.setMetadata(new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, subtitle.isEmpty() ? title : subtitle)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, title)
            .build());

        Notification n = buildNotification();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }

        if (playing) {
            if (!wakeLock.isHeld()) wakeLock.acquire(6 * 60 * 60 * 1000L);
            if (wifiLock != null && !wifiLock.isHeld()) wifiLock.acquire();
        } else {
            if (wakeLock.isHeld()) wakeLock.release();
            if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
            // Paused: the notification may be swiped away
            if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_DETACH);
        }
    }

    private PendingIntent serviceIntent(String action, int code) {
        Intent i = new Intent(this, ReaderService.class).setAction(action);
        return PendingIntent.getService(this, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification buildNotification() {
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent content = open == null ? null
            : PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_reader)
            .setContentTitle(subtitle.isEmpty() ? title : subtitle)
            .setContentText(title)
            .setContentIntent(content)
            .setDeleteIntent(serviceIntent("CLOSE", 5))
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setOngoing(playing)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .addAction(android.R.drawable.ic_media_rew, "Назад", serviceIntent("BACK", 1))
            .addAction(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                playing ? "Пауза" : "Пусни", serviceIntent(playing ? "PAUSE" : "PLAY", 2))
            .addAction(android.R.drawable.ic_media_ff, "Напред", serviceIntent("FORWARD", 3))
            .setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
                .setMediaSession(session.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2));
        return b.build();
    }

    @Override
    public void onDestroy() {
        active = false;
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        if (session != null) {
            session.setActive(false);
            session.release();
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
