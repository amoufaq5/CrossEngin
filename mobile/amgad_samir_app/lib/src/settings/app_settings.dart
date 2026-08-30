import 'package:flutter/material.dart';

import '../core/quality.dart';

/// The scalar preferences the handoff says must survive a relaunch.
///
/// The collection-shaped state it also names — `followed`, `bookmarked`, and
/// the downloads map — lives with the features that own it (steps 4 and 6),
/// because those need indexes and progress rows, not a single JSON blob.
@immutable
class AppSettings {
  const AppSettings({
    this.themeMode = Brightness.dark,
    this.languageCode = 'ar',
    this.speed = 1.0,
    this.playbackQualityKey = Quality.autoKey,
    this.audioOnly = true,
    this.backgroundPlayback = true,
    this.autoDownload = true,
    this.autoDownloadQualityKey = 'mp3',
    this.sleepTimerMinutes = 0,
  });

  /// Dark is the design's default theme.
  final Brightness themeMode;

  /// `ar` or `en`. Arabic is the default.
  final String languageCode;

  /// Playback rate, 0.75–2.0.
  final double speed;

  /// The playback-quality selection, `auto` or a [Quality] key.
  final String playbackQualityKey;

  /// Whether the player is in MP3 mode.
  final bool audioOnly;

  /// The "play while locked" switch. Off means the audio session is not kept
  /// alive in the background.
  final bool backgroundPlayback;

  final bool autoDownload;

  /// Default quality applied to auto-downloads.
  final String autoDownloadQualityKey;

  /// `0` off, `-1` end of lesson, otherwise minutes.
  final int sleepTimerMinutes;

  bool get isArabic => languageCode == 'ar';

  bool get isDark => themeMode == Brightness.dark;

  Locale get locale => Locale(languageCode);

  QualitySelection get playbackQuality =>
      QualitySelection.fromKey(playbackQualityKey);

  Quality get autoDownloadQuality =>
      Quality.fromKey(autoDownloadQualityKey) ?? Quality.mp3;

  /// The speed ladder on the player's speed pill.
  static const List<double> speedLadder = <double>[0.75, 1.0, 1.25, 1.5, 2.0];

  /// The sleep-timer ladder: off, three durations, then end-of-lesson.
  static const List<int> sleepTimerLadder = <int>[0, 10, 20, 30, -1];

  AppSettings copyWith({
    Brightness? themeMode,
    String? languageCode,
    double? speed,
    String? playbackQualityKey,
    bool? audioOnly,
    bool? backgroundPlayback,
    bool? autoDownload,
    String? autoDownloadQualityKey,
    int? sleepTimerMinutes,
  }) {
    return AppSettings(
      themeMode: themeMode ?? this.themeMode,
      languageCode: languageCode ?? this.languageCode,
      speed: speed ?? this.speed,
      playbackQualityKey: playbackQualityKey ?? this.playbackQualityKey,
      audioOnly: audioOnly ?? this.audioOnly,
      backgroundPlayback: backgroundPlayback ?? this.backgroundPlayback,
      autoDownload: autoDownload ?? this.autoDownload,
      autoDownloadQualityKey:
          autoDownloadQualityKey ?? this.autoDownloadQualityKey,
      sleepTimerMinutes: sleepTimerMinutes ?? this.sleepTimerMinutes,
    );
  }

  @override
  bool operator ==(Object other) =>
      other is AppSettings &&
      other.themeMode == themeMode &&
      other.languageCode == languageCode &&
      other.speed == speed &&
      other.playbackQualityKey == playbackQualityKey &&
      other.audioOnly == audioOnly &&
      other.backgroundPlayback == backgroundPlayback &&
      other.autoDownload == autoDownload &&
      other.autoDownloadQualityKey == autoDownloadQualityKey &&
      other.sleepTimerMinutes == sleepTimerMinutes;

  @override
  int get hashCode => Object.hash(
    themeMode,
    languageCode,
    speed,
    playbackQualityKey,
    audioOnly,
    backgroundPlayback,
    autoDownload,
    autoDownloadQualityKey,
    sleepTimerMinutes,
  );
}
