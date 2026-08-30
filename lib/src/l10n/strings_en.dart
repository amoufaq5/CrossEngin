import 'package:flutter/widgets.dart';

import '../core/quality.dart';
import 'app_strings.dart';
import 'numerals.dart';

/// English — the optional UI language. It flips direction, strings, digits and
/// units, but never the content: lesson and series titles stay Arabic and RTL.
class EnglishStrings extends AppStrings {
  const EnglishStrings();

  @override
  Locale get locale => const Locale('en');

  @override
  Numerals get numerals => const Numerals.latin();

  @override
  TextDirection get direction => TextDirection.ltr;

  @override
  bool get isArabic => false;

  @override
  String get languageToggleGlyph => 'ع';

  @override
  String get brand => 'Amgad Samir';
  @override
  String get greeting => 'Welcome back — pick up where you left off';
  @override
  String get resumeKicker => 'Continue listening';
  @override
  String get seriesTitle => 'Series';
  @override
  String get seeAll => 'See all';
  @override
  String get latest => 'Latest lessons';
  @override
  String get thisWeek => 'This week';
  @override
  String get clips => 'Short clips';
  @override
  String get cancel => 'Cancel';
  @override
  String get retry => 'Try again';
  @override
  String get seriesKicker => 'Series';
  @override
  String get playFromStart => 'Play from the start';
  @override
  String get libraryTitle => 'My library';
  @override
  String get storageTitle => 'Downloads storage';
  @override
  String get settingsTitle => 'Settings';
  @override
  String get followSheikh => 'Follow the Sheikh';

  @override
  String get tabHome => 'Home';
  @override
  String get tabSeries => 'Series';
  @override
  String get tabLibrary => 'Library';
  @override
  String get tabSettings => 'Settings';

  @override
  String get searchHint => 'Search titles and series — or pick a topic';
  @override
  String get searchPlaceholder => 'Search a lesson or series…';
  @override
  String get mostPlayed => 'Most played this week';
  @override
  String get searchEmptyTitle => 'No results';
  @override
  String get searchEmptyBody =>
      'Try a shorter word, or pick a topic above.';

  @override
  String resultsFor(int count, String query) =>
      '$count ${count == 1 ? 'result' : 'results'} for “$query”';

  @override
  String get upNext => 'Up next';
  @override
  String get noMoreEpisodes => 'No more episodes available in this series';
  @override
  String get mp3Button => 'MP3 audio';
  @override
  String get audioOnlyTag => 'MP3 · audio only';
  @override
  String get back15 => '−15';
  @override
  String get forward15 => '+15';
  @override
  String get sleepShort => 'Sleep';
  @override
  String get sleepEndShort => 'End';
  @override
  String get worksOffline => 'Works offline';

  @override
  String keepsPlayingLocked({required Quality? downloadedAs}) {
    final String tail = downloadedAs == null
        ? 'not downloaded'
        : 'downloaded: ${qualityLabel(QualitySelection.pinned(downloadedAs))}';
    return 'Keeps playing while locked · $tail';
  }

  @override
  String get videoPausesWhenLocked =>
      'Video pauses when the screen locks — switch to MP3 to keep listening';

  @override
  String qualityButton(QualitySelection selection) =>
      'Quality · ${qualityLabel(selection)}';

  @override
  String miniPlayerMeta(Duration elapsed, QualitySelection selection) {
    final bool audio = selection.quality?.isAudioOnly ?? true;
    final String tail = audio ? 'MP3 · plays locked' : qualityLabel(selection);
    return '${numerals.duration(elapsed)} · $tail';
  }

  @override
  String lessons(int count) => '$count ${count == 1 ? 'lesson' : 'lessons'}';
  @override
  String episodes(int count) => '$count ${count == 1 ? 'episode' : 'episodes'}';
  @override
  String hours(int count) => '$count ${count == 1 ? 'hour' : 'hours'}';

  @override
  String remaining(Duration value) => '${numerals.duration(value)} left';

  @override
  String elapsedOfTotal(Duration elapsed, Duration total) =>
      '${numerals.duration(elapsed)} / ${numerals.duration(total)}';

  @override
  String episodePrefix(int number) => 'Ep. $number — ';

  @override
  String seriesIndexLine({
    required int seriesCount,
    required int lessonCount,
  }) =>
      '$seriesCount series · $lessonCount lessons · synced from the website';

  @override
  String seriesMetaLine({
    required String subtitle,
    required int lessonCount,
    required int hours,
  }) =>
      '$subtitle · ${lessons(lessonCount)} · ${this.hours(hours)}';

  @override
  String latestEpisodesLine(int loadedCount) =>
      'Latest $loadedCount episodes — pull to load older';

  @override
  String onDeviceSuffix(Quality quality) =>
      ' · ${qualityLabel(QualitySelection.pinned(quality))} on device';

  @override
  String libraryLine(int downloadedCount) =>
      '$downloadedCount ${downloadedCount == 1 ? 'lesson' : 'lessons'} '
      'on this device · works offline';

  @override
  String storageLine(double usedMegabytes, double capacityGigabytes) =>
      '${fileSizeMegabytes(usedMegabytes)} / '
      '${capacityGigabytes.round()} $gigabyteUnit';

  @override
  String autoDownloadLine(Quality quality) =>
      'Auto-download: new lessons from followed series — '
      '${qualityLabel(QualitySelection.pinned(quality))}';

  @override
  String get libTabDownloaded => 'Downloaded';
  @override
  String get libTabSaved => 'Saved';
  @override
  String get libTabPlayed => 'Played';
  @override
  String get librarySavedBadge => 'Saved';
  @override
  String get libraryEmpty =>
      'Nothing here yet — tap download next to any lesson and pick a quality.';

  @override
  String get settingAppearance => 'Appearance';
  @override
  String get settingAppearanceHint => 'Dark for night, light for day';
  @override
  String get settingAppearanceDark => 'Dark';
  @override
  String get settingAppearanceLight => 'Light';
  @override
  String get settingPlayWhileLocked => 'Play while locked';
  @override
  String get settingPlayWhileLockedHint =>
      'Audio keeps going in the background, with full lock-screen and car controls';
  @override
  String get settingAutoDownload => 'Auto-download';
  @override
  String get settingAutoDownloadHint =>
      'Fetches new lessons from followed series over Wi-Fi';
  @override
  String get settingDefaultQuality => 'Default download quality';
  @override
  String get settingDefaultQualityHint => 'Changeable per lesson at download time';
  @override
  String get settingLanguage => 'Language';
  @override
  String get settingLanguageHint =>
      'Arabic or English interface — lesson titles stay in Arabic';
  @override
  String get settingLanguageValue => 'English';
  @override
  String get settingSleepTimer => 'Sleep timer';
  @override
  String get settingSleepTimerHint => 'Stops playback after a chosen time';
  @override
  String get footerMirrorStatement =>
      'The app mirrors the website: every lesson published on amgadsamir.com '
      'appears here automatically.';
  @override
  String get footerVersionLine => 'Version 1.0';
  @override
  String get privacyPolicy => 'Privacy policy';
  @override
  String get termsOfUse => 'Terms of use';
  @override
  String get backgroundPlaybackNote =>
      'Playback continues in the background and while locked · your place is saved';

  @override
  String get socialYouTubeMain => 'YouTube — main channel';
  @override
  String get socialYouTubeSecond => 'YouTube — second channel';
  @override
  String get socialFacebook => 'Facebook';
  @override
  String get socialTelegram => 'Telegram';
  @override
  String get socialWebsite => 'Website';

  @override
  String get sheetPlaybackQualityTitle => 'Playback quality';
  @override
  String get sheetPlaybackQualityHint =>
      'Lower quality saves data — MP3 is the lightest and keeps playing while locked.';
  @override
  String get sheetDefaultQualityTitle => 'Default download quality';
  @override
  String get sheetDefaultQualityHint =>
      'Used for auto-downloads — changeable per lesson.';
  @override
  String get sheetSleepTimerTitle => 'Sleep timer';
  @override
  String get sheetSleepTimerHint =>
      'Playback stops on its own — your place is saved.';
  @override
  String get sheetDownloadLessonTitle => 'Download lesson';
  @override
  String get sheetDownloadSeriesTitle => 'Download series';

  @override
  String sheetDownloadHint(String scopeLabel) =>
      '$scopeLabel — pick a quality; the size is shown for each. '
      'Downloads work offline.';

  @override
  String get noteRecommended => 'Recommended';
  @override
  String get noteAudio => 'Audio';
  @override
  String get noteVideo => 'Video';

  @override
  String qualityLabel(QualitySelection selection) {
    final Quality? q = selection.quality;
    if (q == null) return 'Auto (network)';
    if (q == Quality.mp3) return 'MP3 audio only';
    return '${q.key}p';
  }

  @override
  String qualityBadge(Quality quality) =>
      quality == Quality.mp3 ? 'MP3' : '${quality.key}p';

  @override
  String sleepTimerLabel(int minutes) {
    if (minutes == 0) return 'Timer off';
    if (minutes < 0) return 'End of lesson';
    return '$minutes minutes';
  }

  @override
  String sleepTimerValue(int minutes) {
    if (minutes == 0) return 'Off';
    if (minutes < 0) return 'End of lesson';
    return '$minutes minutes';
  }

  @override
  String sleepTimerPill(int minutes) {
    if (minutes == 0) return sleepShort;
    if (minutes < 0) return sleepEndShort;
    return '${minutes}m';
  }

  @override
  String get topicDhikr => 'Dhikr';
  @override
  String get topicHearts => 'Hearts';
  @override
  String get topicKhutbah => 'Khutbah';
  @override
  String get topicContentment => 'Contentment';
  @override
  String get topicProphet => 'The Prophet ﷺ';
  @override
  String get topicTafsir => 'Tafsir';

  @override
  String toastDownloading(Quality quality, Duration duration) =>
      'Downloading · ${qualityLabel(QualitySelection.pinned(quality))} · '
      '${fileSizeMegabytes(quality.estimatedMegabytes(duration))}';

  @override
  String toastDownloadingSeries(int episodeCount, Quality quality) =>
      'Downloading $episodeCount episodes · '
      '${qualityLabel(QualitySelection.pinned(quality))}';

  @override
  String get toastRemovedFromDevice => 'Removed from this device';
  @override
  String get toastDownloadFailed => 'Download failed — try again';

  @override
  String get offlineBanner => 'No connection — showing downloaded lessons only';
  @override
  String get networkErrorTitle => 'Can’t connect';
  @override
  String get networkErrorBody =>
      'Check your internet connection and try again.';
  @override
  String get loadOlderEpisodes => 'Load older episodes';
  @override
  String get loadingOlderEpisodes => 'Loading…';
  @override
  String get downloadQueued => 'Queued';
  @override
  String get downloadPaused => 'Paused';
  @override
  String get downloadFailed => 'Download failed';

  @override
  String get megabyteUnit => 'MB';
  @override
  String get gigabyteUnit => 'GB';
}
