import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../core/quality.dart';
import 'app_settings.dart';
import 'settings_store.dart';

/// Overridden in `main` with the store that was opened before `runApp`, and in
/// tests with [InMemorySettingsStore].
final Provider<SettingsStore> settingsStoreProvider = Provider<SettingsStore>(
  (Ref ref) => SharedPreferencesSettingsStore(SharedPreferencesAsync()),
);

/// The persisted settings, loaded once at startup and written on every change.
///
/// Loaded synchronously from a value the launcher already read, so the very
/// first frame is painted in the user's saved theme and language — no flash of
/// the dark default before a light-mode user's theme arrives.
final NotifierProvider<SettingsController, AppSettings> settingsProvider =
    NotifierProvider<SettingsController, AppSettings>(SettingsController.new);

/// Seeded by `main` with the settings read from disk before the first frame.
final Provider<AppSettings> initialSettingsProvider = Provider<AppSettings>(
  (Ref ref) => const AppSettings(),
);

class SettingsController extends Notifier<AppSettings> {
  @override
  AppSettings build() => ref.read(initialSettingsProvider);

  Future<void> _commit(AppSettings next) async {
    if (next == state) return;
    state = next;
    await ref.read(settingsStoreProvider).write(next);
  }

  Future<void> toggleTheme() =>
      _commit(state.copyWith(
        themeMode: state.isDark ? Brightness.light : Brightness.dark,
      ));

  Future<void> setTheme(Brightness brightness) =>
      _commit(state.copyWith(themeMode: brightness));

  Future<void> toggleLanguage() =>
      _commit(state.copyWith(languageCode: state.isArabic ? 'en' : 'ar'));

  Future<void> setLanguage(String languageCode) =>
      _commit(state.copyWith(languageCode: languageCode));

  Future<void> setSpeed(double speed) =>
      _commit(state.copyWith(speed: speed));

  /// Advances to the next rung of [AppSettings.speedLadder], wrapping around —
  /// the player's speed pill cycles rather than opening a sheet.
  Future<void> cycleSpeed() {
    final int index = AppSettings.speedLadder.indexOf(state.speed);
    final int next = (index + 1) % AppSettings.speedLadder.length;
    return setSpeed(AppSettings.speedLadder[next]);
  }

  Future<void> setPlaybackQuality(QualitySelection selection) => _commit(
    state.copyWith(
      playbackQualityKey: selection.key,
      // Picking a rendition also settles the MP3/video mode, so the two can
      // never disagree about what is playing.
      audioOnly: selection.quality?.isAudioOnly ?? true,
    ),
  );

  /// The player's MP3 toggle. Leaving audio mode needs a video rendition to
  /// land on; the design picks 720p.
  Future<void> toggleAudioOnly() => _commit(
    state.audioOnly
        ? state.copyWith(audioOnly: false, playbackQualityKey: Quality.p720.key)
        : state.copyWith(audioOnly: true, playbackQualityKey: Quality.mp3.key),
  );

  Future<void> setBackgroundPlayback(bool value) =>
      _commit(state.copyWith(backgroundPlayback: value));

  Future<void> setAutoDownload(bool value) =>
      _commit(state.copyWith(autoDownload: value));

  Future<void> setAutoDownloadQuality(Quality quality) =>
      _commit(state.copyWith(autoDownloadQualityKey: quality.key));

  Future<void> setSleepTimer(int minutes) =>
      _commit(state.copyWith(sleepTimerMinutes: minutes));
}

/// Narrow selectors, so a widget that only cares about the theme does not
/// rebuild when the sleep timer changes.
final Provider<Brightness> brightnessProvider = Provider<Brightness>(
  (Ref ref) => ref.watch(settingsProvider.select((AppSettings s) => s.themeMode)),
);

final Provider<Locale> localeProvider = Provider<Locale>(
  (Ref ref) => ref.watch(settingsProvider.select((AppSettings s) => s.locale)),
);
