import 'package:amgad_samir_app/src/core/quality.dart';
import 'package:amgad_samir_app/src/l10n/app_strings.dart';
import 'package:amgad_samir_app/src/l10n/strings_ar.dart';
import 'package:amgad_samir_app/src/l10n/strings_en.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const AppStrings ar = ArabicStrings();
  const AppStrings en = EnglishStrings();

  test('the two tables disagree about direction and digit system', () {
    expect(ar.direction, TextDirection.rtl);
    expect(en.direction, TextDirection.ltr);
    expect(ar.numerals.arabicIndic, isTrue);
    expect(en.numerals.arabicIndic, isFalse);
  });

  test('the language toggle names the language you switch to', () {
    expect(ar.languageToggleGlyph, 'EN');
    expect(en.languageToggleGlyph, 'ع');
  });

  group('file sizes', () {
    test('megabytes below 1000, gigabytes above', () {
      expect(en.fileSizeMegabytes(32), '32 MB');
      expect(en.fileSizeMegabytes(1420), '1.4 GB');
      expect(ar.fileSizeMegabytes(32), '٣٢ م.ب');
      expect(ar.fileSizeMegabytes(1420), '١٫٤ غ.ب');
    });

    test('the crossover is exactly 1000 MB', () {
      expect(en.fileSizeMegabytes(999), '999 MB');
      expect(en.fileSizeMegabytes(1000), '1.0 GB');
    });
  });

  group('quality labels', () {
    test('MP3 reads as a sentence, video rungs as numerals plus p', () {
      expect(
        en.qualityLabel(const QualitySelection.pinned(Quality.mp3)),
        'MP3 audio only',
      );
      expect(
        ar.qualityLabel(const QualitySelection.pinned(Quality.mp3)),
        'صوت فقط MP3',
      );
      expect(
        en.qualityLabel(const QualitySelection.pinned(Quality.p720)),
        '720p',
      );
      // The `p` stays Latin; only the numerals localise.
      expect(
        ar.qualityLabel(const QualitySelection.pinned(Quality.p720)),
        '٧٢٠p',
      );
    });

    test('auto is a labelled selection, not a ladder rung', () {
      expect(en.qualityLabel(const QualitySelection.auto()), 'Auto (network)');
      expect(ar.qualityLabel(const QualitySelection.auto()), 'تلقائي حسب الشبكة');
    });

    test('the library badge is the short form', () {
      expect(en.qualityBadge(Quality.mp3), 'MP3');
      expect(ar.qualityBadge(Quality.p360), '٣٦٠p');
    });
  });

  group('counted nouns', () {
    test('English pluralises, Arabic does not', () {
      expect(en.lessons(1), '1 lesson');
      expect(en.lessons(42), '42 lessons');
      expect(ar.lessons(42), '٤٢ درس');
    });

    test('Arabic sleep-timer options agree with their number', () {
      // 3–10 take the plural, 11+ take the singular.
      expect(ar.sleepTimerLabel(10), '١٠ دقائق');
      expect(ar.sleepTimerLabel(20), '٢٠ دقيقة');
      expect(ar.sleepTimerLabel(30), '٣٠ دقيقة');
    });

    test('0 is off and -1 is end-of-lesson in both languages', () {
      expect(en.sleepTimerLabel(0), 'Timer off');
      expect(en.sleepTimerLabel(-1), 'End of lesson');
      expect(ar.sleepTimerLabel(0), 'إيقاف المؤقّت');
      expect(ar.sleepTimerLabel(-1), 'عند نهاية الدرس');
      expect(en.sleepTimerPill(0), 'Sleep');
      expect(en.sleepTimerPill(-1), 'End');
      expect(en.sleepTimerPill(20), '20m');
      expect(ar.sleepTimerPill(20), '٢٠ د');
    });
  });

  test('the episode prefix localises but leaves the title to the caller', () {
    expect(en.episodePrefix(42), 'Ep. 42 — ');
    expect(ar.episodePrefix(42), 'الحلقة ٤٢ — ');
  });

  test('the player status line changes with download state', () {
    expect(
      en.keepsPlayingLocked(downloadedAs: null),
      'Keeps playing while locked · not downloaded',
    );
    expect(
      en.keepsPlayingLocked(downloadedAs: Quality.mp3),
      'Keeps playing while locked · downloaded: MP3 audio only',
    );
  });

  test('the download toast carries quality and computed size', () {
    expect(
      en.toastDownloading(Quality.mp3, const Duration(minutes: 45)),
      'Downloading · MP3 audio only · 32 MB',
    );
    expect(
      ar.toastDownloading(Quality.mp3, const Duration(minutes: 45)),
      'جارٍ التنزيل · صوت فقط MP3 · ٣٢ م.ب',
    );
  });

  test('every string in both tables renders without throwing', () {
    // Guards against a parameterised string that reads a null or divides by a
    // count. Every getter and every method is exercised in both languages.
    for (final AppStrings s in <AppStrings>[ar, en]) {
      final List<String> rendered = <String>[
        s.brand, s.greeting, s.resumeKicker, s.seriesTitle, s.seeAll, s.latest,
        s.thisWeek, s.clips, s.cancel, s.retry, s.seriesKicker,
        s.playFromStart, s.libraryTitle, s.storageTitle, s.settingsTitle,
        s.followSheikh, s.tabHome, s.tabSeries, s.tabLibrary, s.tabSettings,
        s.searchHint, s.searchPlaceholder, s.mostPlayed, s.searchEmptyTitle,
        s.searchEmptyBody, s.upNext, s.noMoreEpisodes, s.mp3Button,
        s.audioOnlyTag, s.back15, s.forward15, s.sleepShort, s.sleepEndShort,
        s.worksOffline, s.videoPausesWhenLocked, s.libTabDownloaded,
        s.libTabSaved, s.libTabPlayed, s.librarySavedBadge, s.libraryEmpty,
        s.settingAppearance, s.settingAppearanceHint, s.settingAppearanceDark,
        s.settingAppearanceLight, s.settingPlayWhileLocked,
        s.settingPlayWhileLockedHint, s.settingAutoDownload,
        s.settingAutoDownloadHint, s.settingDefaultQuality,
        s.settingDefaultQualityHint, s.settingLanguage, s.settingLanguageHint,
        s.settingLanguageValue, s.settingSleepTimer, s.settingSleepTimerHint,
        s.footerMirrorStatement, s.footerVersionLine, s.privacyPolicy,
        s.termsOfUse, s.backgroundPlaybackNote, s.socialYouTubeMain,
        s.socialYouTubeSecond, s.socialFacebook, s.socialTelegram,
        s.socialWebsite, s.sheetPlaybackQualityTitle,
        s.sheetPlaybackQualityHint, s.sheetDefaultQualityTitle,
        s.sheetDefaultQualityHint, s.sheetSleepTimerTitle,
        s.sheetSleepTimerHint, s.sheetDownloadLessonTitle,
        s.sheetDownloadSeriesTitle, s.noteRecommended, s.noteAudio, s.noteVideo,
        s.topicDhikr, s.topicHearts, s.topicKhutbah, s.topicContentment,
        s.topicProphet, s.topicTafsir, s.toastRemovedFromDevice,
        s.toastDownloadFailed, s.offlineBanner, s.networkErrorTitle,
        s.networkErrorBody, s.loadOlderEpisodes, s.loadingOlderEpisodes,
        s.downloadQueued, s.downloadPaused, s.downloadFailed, s.megabyteUnit,
        s.gigabyteUnit,
        s.resultsFor(3, 'الذكر'),
        s.remaining(const Duration(minutes: 26, seconds: 28)),
        s.elapsedOfTotal(const Duration(minutes: 1), const Duration(hours: 1)),
        s.episodePrefix(42),
        s.seriesIndexLine(seriesCount: 6, lessonCount: 175),
        s.seriesMetaLine(subtitle: 'x', lessonCount: 42, hours: 32),
        s.latestEpisodesLine(6),
        s.onDeviceSuffix(Quality.p360),
        s.libraryLine(24),
        s.storageLine(1420, 4),
        s.autoDownloadLine(Quality.mp3),
        s.sheetDownloadHint('45:02'),
        s.qualityButton(const QualitySelection.auto()),
        s.miniPlayerMeta(Duration.zero, const QualitySelection.auto()),
        s.toastDownloadingSeries(6, Quality.mp3),
        s.episodes(6),
        s.hours(32),
        s.sleepTimerValue(20),
        s.fileSizeMegabytes(0),
      ];
      for (final String value in rendered) {
        expect(value, isNotEmpty);
      }
    }
  });
}
