import 'package:amgad_samir_app/src/core/quality.dart';
import 'package:amgad_samir_app/src/settings/app_settings.dart';
import 'package:amgad_samir_app/src/settings/settings_controller.dart';
import 'package:amgad_samir_app/src/settings/settings_store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

ProviderContainer _container(InMemorySettingsStore store) {
  final ProviderContainer c = ProviderContainer(
    overrides: [
      settingsStoreProvider.overrideWithValue(store),
      initialSettingsProvider.overrideWithValue(store.value),
    ],
  );
  addTearDown(c.dispose);
  return c;
}

void main() {
  test('defaults are dark, Arabic, 1.0x, MP3 mode, background playback on', () {
    const AppSettings s = AppSettings();
    expect(s.themeMode, Brightness.dark);
    expect(s.languageCode, 'ar');
    expect(s.speed, 1.0);
    expect(s.audioOnly, isTrue);
    expect(s.backgroundPlayback, isTrue);
    expect(s.autoDownload, isTrue);
    expect(s.sleepTimerMinutes, 0);
  });

  test('every change reaches the store, so it survives a relaunch', () async {
    final InMemorySettingsStore store = InMemorySettingsStore();
    final ProviderContainer c = _container(store);
    final SettingsController controller = c.read(settingsProvider.notifier);

    await controller.toggleTheme();
    await controller.toggleLanguage();
    await controller.setSpeed(1.5);
    await controller.setSleepTimer(20);

    expect(store.value.themeMode, Brightness.light);
    expect(store.value.languageCode, 'en');
    expect(store.value.speed, 1.5);
    expect(store.value.sleepTimerMinutes, 20);

    // A fresh container seeded from the same store reads the saved values —
    // this is the relaunch path.
    final ProviderContainer relaunched = ProviderContainer(
      overrides: [
        settingsStoreProvider.overrideWithValue(store),
        initialSettingsProvider.overrideWithValue(await store.read()),
      ],
    );
    addTearDown(relaunched.dispose);
    expect(relaunched.read(settingsProvider).themeMode, Brightness.light);
    expect(relaunched.read(settingsProvider).languageCode, 'en');
    expect(relaunched.read(settingsProvider).speed, 1.5);
  });

  test('setting a value to what it already is does not touch disk', () async {
    final InMemorySettingsStore store = InMemorySettingsStore();
    final ProviderContainer c = _container(store);
    await c.read(settingsProvider.notifier).setLanguage('ar');
    expect(store.writeCount, 0);

    await c.read(settingsProvider.notifier).setLanguage('en');
    expect(store.writeCount, 1);
  });

  test('the speed pill cycles the ladder and wraps', () async {
    final ProviderContainer c = _container(InMemorySettingsStore());
    final SettingsController controller = c.read(settingsProvider.notifier);
    final List<double> seen = <double>[];
    for (int i = 0; i < AppSettings.speedLadder.length; i++) {
      await controller.cycleSpeed();
      seen.add(c.read(settingsProvider).speed);
    }
    expect(seen, <double>[1.25, 1.5, 2.0, 0.75, 1.0]);
  });

  group('mode and quality cannot disagree', () {
    test('picking an audio rendition puts the player in MP3 mode', () async {
      final ProviderContainer c = _container(InMemorySettingsStore());
      await c
          .read(settingsProvider.notifier)
          .setPlaybackQuality(const QualitySelection.pinned(Quality.p480));
      expect(c.read(settingsProvider).audioOnly, isFalse);
      expect(c.read(settingsProvider).playbackQualityKey, '480');

      await c
          .read(settingsProvider.notifier)
          .setPlaybackQuality(const QualitySelection.pinned(Quality.mp3));
      expect(c.read(settingsProvider).audioOnly, isTrue);
    });

    test('auto is treated as audio, the mode that keeps playing locked', () async {
      final ProviderContainer c = _container(InMemorySettingsStore());
      await c
          .read(settingsProvider.notifier)
          .setPlaybackQuality(const QualitySelection.auto());
      expect(c.read(settingsProvider).audioOnly, isTrue);
      expect(c.read(settingsProvider).playbackQuality.isAuto, isTrue);
    });

    test('leaving MP3 mode lands on a real video rendition', () async {
      final ProviderContainer c = _container(InMemorySettingsStore());
      await c.read(settingsProvider.notifier).toggleAudioOnly();
      expect(c.read(settingsProvider).audioOnly, isFalse);
      expect(c.read(settingsProvider).playbackQualityKey, Quality.p720.key);

      await c.read(settingsProvider.notifier).toggleAudioOnly();
      expect(c.read(settingsProvider).audioOnly, isTrue);
      expect(c.read(settingsProvider).playbackQualityKey, Quality.mp3.key);
    });
  });

  test('an unknown persisted quality key falls back rather than crashing', () {
    const AppSettings s = AppSettings(
      playbackQualityKey: '4320',
      autoDownloadQualityKey: 'nonsense',
    );
    expect(s.playbackQuality.isAuto, isTrue);
    expect(s.autoDownloadQuality, Quality.mp3);
  });

  group('estimated sizes follow the handoff rates', () {
    test('a 45-minute lesson', () {
      const Duration d = Duration(minutes: 45);
      expect(Quality.mp3.estimatedMegabytes(d), closeTo(32.4, 0.01));
      expect(Quality.p720.estimatedMegabytes(d), closeTo(324, 0.01));
      expect(Quality.p1080.estimatedMegabytes(d), closeTo(652.5, 0.01));
    });

    test('the ladder is ordered and mp3 is the only audio rung', () {
      final List<Quality> audio =
          Quality.values.where((Quality q) => q.isAudioOnly).toList();
      expect(audio, <Quality>[Quality.mp3]);
      for (int i = 1; i < Quality.values.length; i++) {
        expect(
          Quality.values[i].megabytesPerMinute,
          greaterThan(Quality.values[i - 1].megabytesPerMinute),
        );
      }
    });
  });
}
