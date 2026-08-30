import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'app_settings.dart';

/// Where [AppSettings] is read from and written to.
///
/// An interface rather than a direct `SharedPreferences` call so tests can run
/// against memory without a platform channel, and so a future migration to a
/// different store is one class.
abstract interface class SettingsStore {
  Future<AppSettings> read();

  Future<void> write(AppSettings settings);
}

/// Keys are namespaced so nothing collides with a plugin writing into the same
/// preference file. Renaming one silently resets that preference — don't.
abstract final class SettingsKeys {
  static const String theme = 'settings.theme';
  static const String language = 'settings.lang';
  static const String speed = 'settings.speed';
  static const String playbackQuality = 'settings.qualityKey';
  static const String audioOnly = 'settings.audioOnly';
  static const String backgroundPlayback = 'settings.bgPlay';
  static const String autoDownload = 'settings.autoDl';
  static const String autoDownloadQuality = 'settings.autoQualityKey';
  static const String sleepTimer = 'settings.sleepTimer';
}

class SharedPreferencesSettingsStore implements SettingsStore {
  SharedPreferencesSettingsStore(this._prefs);

  final SharedPreferencesAsync _prefs;

  @override
  Future<AppSettings> read() async {
    const AppSettings defaults = AppSettings();
    return AppSettings(
      themeMode: (await _prefs.getString(SettingsKeys.theme)) == 'light'
          ? Brightness.light
          : Brightness.dark,
      languageCode:
          await _prefs.getString(SettingsKeys.language) ??
          defaults.languageCode,
      speed: await _prefs.getDouble(SettingsKeys.speed) ?? defaults.speed,
      playbackQualityKey:
          await _prefs.getString(SettingsKeys.playbackQuality) ??
          defaults.playbackQualityKey,
      audioOnly:
          await _prefs.getBool(SettingsKeys.audioOnly) ?? defaults.audioOnly,
      backgroundPlayback:
          await _prefs.getBool(SettingsKeys.backgroundPlayback) ??
          defaults.backgroundPlayback,
      autoDownload:
          await _prefs.getBool(SettingsKeys.autoDownload) ??
          defaults.autoDownload,
      autoDownloadQualityKey:
          await _prefs.getString(SettingsKeys.autoDownloadQuality) ??
          defaults.autoDownloadQualityKey,
      sleepTimerMinutes:
          await _prefs.getInt(SettingsKeys.sleepTimer) ??
          defaults.sleepTimerMinutes,
    );
  }

  @override
  Future<void> write(AppSettings s) async {
    await Future.wait(<Future<void>>[
      _prefs.setString(SettingsKeys.theme, s.isDark ? 'dark' : 'light'),
      _prefs.setString(SettingsKeys.language, s.languageCode),
      _prefs.setDouble(SettingsKeys.speed, s.speed),
      _prefs.setString(SettingsKeys.playbackQuality, s.playbackQualityKey),
      _prefs.setBool(SettingsKeys.audioOnly, s.audioOnly),
      _prefs.setBool(SettingsKeys.backgroundPlayback, s.backgroundPlayback),
      _prefs.setBool(SettingsKeys.autoDownload, s.autoDownload),
      _prefs.setString(
        SettingsKeys.autoDownloadQuality,
        s.autoDownloadQualityKey,
      ),
      _prefs.setInt(SettingsKeys.sleepTimer, s.sleepTimerMinutes),
    ]);
  }
}

/// In-memory store for tests and for the first frame before disk is read.
class InMemorySettingsStore implements SettingsStore {
  InMemorySettingsStore([this._value = const AppSettings()]);

  AppSettings _value;
  int _writes = 0;

  AppSettings get value => _value;

  /// How many times [write] was called. Lets a test assert that a no-op
  /// change never reached disk.
  int get writeCount => _writes;

  @override
  Future<AppSettings> read() async => _value;

  @override
  Future<void> write(AppSettings settings) async {
    _writes++;
    _value = settings;
  }
}
