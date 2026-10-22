# Android приложение (APK)

Сглобява се от същия уеб код с Capacitor; родната част е в `java/com/biocode/razkazvach/`:

- `RazkazvachPlugin` — Android синтез на реч (всички инсталирани двигатели и гласове; изреченията се
  нареждат в родната опашка, затова четенето продължава при изгасен екран), управление на фоновата
  услуга и отваряне на книги от „Сподели“ / „Отвори с“.
- `ReaderService` — foreground услуга тип *mediaPlayback*: известие с бутони, заключен екран,
  бутони на слушалки, wake lock + Wi-Fi lock само докато се чете.
- `MainActivity` — държи WebView-то активно във фонов режим, докато услугата работи.

`patch-android.py` добавя кода, разрешенията, `<queries>` за TTS двигателите, филтрите за споделяне,
подписа и иконите в проекта, генериран от `npx cap add android`.

## Локално

```
npm ci
node scripts/build-shell.mjs && npx cap add android && python3 android-res/patch-android.py && npx cap sync android
cd android && ./gradlew assembleRelease
```

## Подпис

APK-тата се подписват с един и същ ключ, за да се инсталира всяко ново като обновление (библиотеката
и запазеното аудио остават). По подразбиране това е `razkazvach.keystore` от репото. Ако зададете
GitHub secret-и `RZ_KEYSTORE_BASE64`, `RZ_STORE_PASS`, `RZ_KEY_PASS`, CI ползва вашия частен ключ
(тогава старото APK трябва да се деинсталира веднъж).
