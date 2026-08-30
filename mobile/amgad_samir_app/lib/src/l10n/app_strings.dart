import 'package:flutter/widgets.dart';

import '../core/quality.dart';
import 'numerals.dart';

/// Every user-facing string, in one place, with the locale's number system
/// attached.
///
/// Written as an abstract class rather than a map so that adding a string
/// fails to compile until both languages carry it. Parameterised strings are
/// methods, which keeps grammar (Arabic's counted-noun agreement, English's
/// plural `s`) inside the language that needs it instead of at the call site.
///
/// Lesson and series titles never pass through here: they are content, they
/// stay Arabic in both languages, and they are rendered with [ArabicText].
abstract class AppStrings {
  const AppStrings();

  Locale get locale;
  Numerals get numerals;
  TextDirection get direction;
  bool get isArabic;

  /// Label on the language toggle: it names the language you would switch
  /// *to*, so Arabic shows `EN` and English shows `ع`.
  String get languageToggleGlyph;

  // ---------------------------------------------------------------- chrome
  String get brand;
  String get greeting;
  String get resumeKicker;
  String get seriesTitle;
  String get seeAll;
  String get latest;
  String get thisWeek;
  String get clips;
  String get cancel;
  String get retry;
  String get seriesKicker;
  String get playFromStart;
  String get libraryTitle;
  String get storageTitle;
  String get settingsTitle;
  String get followSheikh;

  // ---------------------------------------------------------------- tabs
  String get tabHome;
  String get tabSeries;
  String get tabLibrary;
  String get tabSettings;

  // ---------------------------------------------------------------- search
  String get searchHint;
  String get searchPlaceholder;
  String get mostPlayed;
  String get searchEmptyTitle;
  String get searchEmptyBody;

  /// `12 results for “x”` — the query is quoted with the locale's own marks.
  String resultsFor(int count, String query);

  // ---------------------------------------------------------------- player
  String get upNext;
  String get noMoreEpisodes;
  String get mp3Button;
  String get audioOnlyTag;
  String get back15;
  String get forward15;
  String get sleepShort;
  String get sleepEndShort;
  String get worksOffline;

  /// The player's honest status line while in audio mode.
  String keepsPlayingLocked({required Quality? downloadedAs});

  /// The player's honest status line while in video mode.
  String get videoPausesWhenLocked;

  /// `Quality · 720p`.
  String qualityButton(QualitySelection selection);

  /// Mini-player second line: `18:34 · MP3 · plays locked`.
  String miniPlayerMeta(Duration elapsed, QualitySelection selection);

  // ---------------------------------------------------------------- counts
  String lessons(int count);
  String episodes(int count);
  String hours(int count);

  /// Home resume card: `26:28 left`.
  String remaining(Duration value);

  /// Home resume card: `18:34 / 45:02`.
  String elapsedOfTotal(Duration elapsed, Duration total);

  /// A lesson's display title: `Ep. 42 — <Arabic title>`. The prefix is the
  /// only translated part; the title itself stays Arabic.
  String episodePrefix(int number);

  /// Series index sub-line.
  String seriesIndexLine({required int seriesCount, required int lessonCount});

  /// Series hero meta: `Second commentary · 42 lessons · 32 hours`.
  String seriesMetaLine({
    required String subtitle,
    required int lessonCount,
    required int hours,
  });

  /// The honest line under the series hero.
  String latestEpisodesLine(int loadedCount);

  /// Episode row meta suffix once the file is on the device.
  String onDeviceSuffix(Quality quality);

  // ---------------------------------------------------------------- library
  String libraryLine(int downloadedCount);
  String storageLine(double usedMegabytes, double capacityGigabytes);
  String autoDownloadLine(Quality quality);
  String get libTabDownloaded;
  String get libTabSaved;
  String get libTabPlayed;
  String get librarySavedBadge;
  String get libraryEmpty;

  // ---------------------------------------------------------------- settings
  String get settingAppearance;
  String get settingAppearanceHint;
  String get settingAppearanceDark;
  String get settingAppearanceLight;
  String get settingPlayWhileLocked;
  String get settingPlayWhileLockedHint;
  String get settingAutoDownload;
  String get settingAutoDownloadHint;
  String get settingDefaultQuality;
  String get settingDefaultQualityHint;
  String get settingLanguage;
  String get settingLanguageHint;
  String get settingLanguageValue;
  String get settingSleepTimer;
  String get settingSleepTimerHint;
  String get footerMirrorStatement;
  String get footerVersionLine;
  String get privacyPolicy;
  String get termsOfUse;
  String get backgroundPlaybackNote;

  // ---------------------------------------------------------------- socials
  String get socialYouTubeMain;
  String get socialYouTubeSecond;
  String get socialFacebook;
  String get socialTelegram;
  String get socialWebsite;

  // ---------------------------------------------------------------- sheets
  String get sheetPlaybackQualityTitle;
  String get sheetPlaybackQualityHint;
  String get sheetDefaultQualityTitle;
  String get sheetDefaultQualityHint;
  String get sheetSleepTimerTitle;
  String get sheetSleepTimerHint;
  String get sheetDownloadLessonTitle;
  String get sheetDownloadSeriesTitle;

  /// Download-sheet hint. [scopeLabel] is either a lesson duration or an
  /// episode/hours summary for a whole series.
  String sheetDownloadHint(String scopeLabel);

  String get noteRecommended;
  String get noteAudio;
  String get noteVideo;

  /// Quality ladder label. `mp3` reads as a sentence in each language;
  /// the video rungs are numerals plus a Latin `p`, localised in digits only.
  String qualityLabel(QualitySelection selection);

  /// Short badge form used on library rows: `MP3`, `720p`.
  String qualityBadge(Quality quality);

  /// Sleep-timer option label. `0` is off, `-1` is "end of lesson".
  String sleepTimerLabel(int minutes);

  /// Sleep-timer value as shown on the settings row.
  String sleepTimerValue(int minutes);

  /// Sleep-timer pill on the player transport row: `20m` / `End` / `Sleep`.
  String sleepTimerPill(int minutes);

  // ---------------------------------------------------------------- topics
  String get topicDhikr;
  String get topicHearts;
  String get topicKhutbah;
  String get topicContentment;
  String get topicProphet;
  String get topicTafsir;

  // ---------------------------------------------------------------- toasts
  String toastDownloading(Quality quality, Duration duration);
  String toastDownloadingSeries(int episodeCount, Quality quality);
  String get toastRemovedFromDevice;
  String get toastDownloadFailed;

  // ---------------------------------------------------------------- states
  String get offlineBanner;
  String get networkErrorTitle;
  String get networkErrorBody;
  String get loadOlderEpisodes;
  String get loadingOlderEpisodes;
  String get downloadQueued;
  String get downloadPaused;
  String get downloadFailed;

  /// `32 MB` / `1.4 GB`. Crosses over at 1000 MB, matching the handoff's
  /// decimal-megabyte sizing model.
  String fileSizeMegabytes(double megabytes) {
    if (megabytes >= 1000) {
      return '${numerals.decimal(megabytes / 1000)} $gigabyteUnit';
    }
    return '${numerals.integer(megabytes.round())} $megabyteUnit';
  }

  String get megabyteUnit;
  String get gigabyteUnit;
}
