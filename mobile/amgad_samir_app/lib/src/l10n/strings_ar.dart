import 'package:flutter/widgets.dart';

import '../core/quality.dart';
import 'app_strings.dart';
import 'numerals.dart';

/// Arabic — the default language and the design's native direction.
class ArabicStrings extends AppStrings {
  const ArabicStrings();

  @override
  Locale get locale => const Locale('ar');

  @override
  Numerals get numerals => const Numerals.arabic();

  @override
  TextDirection get direction => TextDirection.rtl;

  @override
  bool get isArabic => true;

  @override
  String get languageToggleGlyph => 'EN';

  @override
  String get brand => 'أمجد سمير';
  @override
  String get greeting => 'أهلًا بك — تابع من حيث توقفت';
  @override
  String get resumeKicker => 'أكمل الاستماع';
  @override
  String get seriesTitle => 'السلاسل';
  @override
  String get seeAll => 'الكل';
  @override
  String get latest => 'أحدث الدروس';
  @override
  String get thisWeek => 'هذا الأسبوع';
  @override
  String get clips => 'مقاطع قصيرة';
  @override
  String get cancel => 'إلغاء';
  @override
  String get retry => 'إعادة المحاولة';
  @override
  String get seriesKicker => 'سلسلة';
  @override
  String get playFromStart => 'تشغيل من البداية';
  @override
  String get libraryTitle => 'مكتبتي';
  @override
  String get storageTitle => 'مساحة التنزيلات';
  @override
  String get settingsTitle => 'الإعدادات';
  @override
  String get followSheikh => 'تابع الشيخ';

  @override
  String get tabHome => 'الرئيسية';
  @override
  String get tabSeries => 'السلاسل';
  @override
  String get tabLibrary => 'مكتبتي';
  @override
  String get tabSettings => 'الإعدادات';

  @override
  String get searchHint => 'ابحث في العناوين والسلاسل — أو اختر موضوعًا';
  @override
  String get searchPlaceholder => 'ابحث عن درس أو سلسلة…';
  @override
  String get mostPlayed => 'أكثر ما يُسمع هذا الأسبوع';
  @override
  String get searchEmptyTitle => 'لا نتائج';
  @override
  String get searchEmptyBody =>
      'جرّب كلمة أقصر، أو اختر موضوعًا من الأعلى.';

  @override
  String resultsFor(int count, String query) =>
      '${numerals.integer(count)} نتيجة لـ «$query»';

  @override
  String get upNext => 'التالي';
  @override
  String get noMoreEpisodes => 'انتهت الحلقات المتاحة من هذه السلسلة';
  @override
  String get mp3Button => 'صوت MP3';
  @override
  String get audioOnlyTag => 'MP3 · صوت فقط';
  @override
  String get back15 => '١٥−';
  @override
  String get forward15 => '+١٥';
  @override
  String get sleepShort => 'نوم';
  @override
  String get sleepEndShort => 'نهاية';
  @override
  String get worksOffline => 'يعمل بدون إنترنت';

  @override
  String keepsPlayingLocked({required Quality? downloadedAs}) {
    final String tail = downloadedAs == null
        ? 'غير محمَّل'
        : 'محمَّل: ${qualityLabel(QualitySelection.pinned(downloadedAs))}';
    return 'يستمر التشغيل والهاتف مقفول · $tail';
  }

  @override
  String get videoPausesWhenLocked =>
      'الفيديو يتوقف عند قفل الشاشة — حوّل إلى MP3 للاستماع مقفولًا';

  @override
  String qualityButton(QualitySelection selection) =>
      'الجودة · ${qualityLabel(selection)}';

  @override
  String miniPlayerMeta(Duration elapsed, QualitySelection selection) {
    final bool audio = selection.quality?.isAudioOnly ?? true;
    final String tail =
        audio ? 'MP3 · يعمل مقفولًا' : qualityLabel(selection);
    return '${numerals.duration(elapsed)} · $tail';
  }

  @override
  String lessons(int count) => '${numerals.integer(count)} درس';
  @override
  String episodes(int count) => '${numerals.integer(count)} حلقات';
  @override
  String hours(int count) => '${numerals.integer(count)} ساعة';

  @override
  String remaining(Duration value) => 'باقي ${numerals.duration(value)}';

  @override
  String elapsedOfTotal(Duration elapsed, Duration total) =>
      '${numerals.duration(elapsed)} / ${numerals.duration(total)}';

  @override
  String episodePrefix(int number) => 'الحلقة ${numerals.integer(number)} — ';

  @override
  String seriesIndexLine({
    required int seriesCount,
    required int lessonCount,
  }) =>
      '${numerals.integer(seriesCount)} سلاسل · '
      '${numerals.integer(lessonCount)} درسًا · تُحدَّث من الموقع تلقائيًا';

  @override
  String seriesMetaLine({
    required String subtitle,
    required int lessonCount,
    required int hours,
  }) =>
      '$subtitle · ${lessons(lessonCount)} · ${this.hours(hours)}';

  @override
  String latestEpisodesLine(int loadedCount) =>
      'أحدث ${numerals.integer(loadedCount)} حلقات — اسحب لتحميل الأقدم';

  @override
  String onDeviceSuffix(Quality quality) =>
      ' · ${qualityLabel(QualitySelection.pinned(quality))} على الجهاز';

  @override
  String libraryLine(int downloadedCount) =>
      '${numerals.integer(downloadedCount)} درسًا على الجهاز · تعمل بدون إنترنت';

  @override
  String storageLine(double usedMegabytes, double capacityGigabytes) =>
      '${fileSizeMegabytes(usedMegabytes)} / '
      '${numerals.integer(capacityGigabytes.round())} $gigabyteUnit';

  @override
  String autoDownloadLine(Quality quality) =>
      'التنزيل التلقائي: الدروس الجديدة من السلاسل المتابَعة — '
      'بجودة ${qualityLabel(QualitySelection.pinned(quality))}';

  @override
  String get libTabDownloaded => 'المحمَّلة';
  @override
  String get libTabSaved => 'المحفوظة';
  @override
  String get libTabPlayed => 'سمعتها';
  @override
  String get librarySavedBadge => 'محفوظ';
  @override
  String get libraryEmpty =>
      'لا شيء هنا بعد — اضغط زر التنزيل بجانب أي درس واختر الجودة المناسبة لك.';

  @override
  String get settingAppearance => 'المظهر';
  @override
  String get settingAppearanceHint => 'داكن مريح لليل، فاتح للنهار';
  @override
  String get settingAppearanceDark => 'داكن';
  @override
  String get settingAppearanceLight => 'فاتح';
  @override
  String get settingPlayWhileLocked => 'التشغيل والهاتف مقفول';
  @override
  String get settingPlayWhileLockedHint =>
      'يستمر الصوت في الخلفية، بتحكم كامل من شاشة القفل وسمّاعات السيارة';
  @override
  String get settingAutoDownload => 'التنزيل التلقائي';
  @override
  String get settingAutoDownloadHint =>
      'ينزّل الجديد من السلاسل المتابَعة على شبكة الواي فاي';
  @override
  String get settingDefaultQuality => 'جودة التنزيل الافتراضية';
  @override
  String get settingDefaultQualityHint => 'يمكنك تغييرها لكل درس عند التنزيل';
  @override
  String get settingLanguage => 'اللغة';
  @override
  String get settingLanguageHint =>
      'واجهة عربية أو إنجليزية — عناوين الدروس تبقى بالعربية';
  @override
  String get settingLanguageValue => 'العربية';
  @override
  String get settingSleepTimer => 'مؤقّت النوم';
  @override
  String get settingSleepTimerHint => 'يوقف التشغيل بعد مدة تختارها';
  @override
  String get footerMirrorStatement =>
      'التطبيق مرآة للموقع: كل درس يُنشر على amgadsamir.com يظهر هنا تلقائيًا.';
  @override
  String get footerVersionLine => 'الإصدار ١٫٠';
  @override
  String get privacyPolicy => 'سياسة الخصوصية';
  @override
  String get termsOfUse => 'شروط الاستخدام';
  @override
  String get backgroundPlaybackNote =>
      'يستمر التشغيل في الخلفية وعند إغلاق الشاشة · يحفظ موضعك تلقائيًا';

  @override
  String get socialYouTubeMain => 'يوتيوب — القناة الرئيسية';
  @override
  String get socialYouTubeSecond => 'يوتيوب — القناة الثانية';
  @override
  String get socialFacebook => 'فيسبوك';
  @override
  String get socialTelegram => 'تيليجرام';
  @override
  String get socialWebsite => 'الموقع';

  @override
  String get sheetPlaybackQualityTitle => 'جودة التشغيل';
  @override
  String get sheetPlaybackQualityHint =>
      'الجودة الأقل توفّر البيانات — وMP3 هو الأخفّ، ويعمل والهاتف مقفول.';
  @override
  String get sheetDefaultQualityTitle => 'جودة التنزيل الافتراضية';
  @override
  String get sheetDefaultQualityHint =>
      'تُستخدم للتنزيل التلقائي — ويمكن تغييرها لكل درس.';
  @override
  String get sheetSleepTimerTitle => 'مؤقّت النوم';
  @override
  String get sheetSleepTimerHint => 'يتوقف التشغيل تلقائيًا — ويحفظ موضعك.';
  @override
  String get sheetDownloadLessonTitle => 'تنزيل الدرس';
  @override
  String get sheetDownloadSeriesTitle => 'تنزيل السلسلة';

  @override
  String sheetDownloadHint(String scopeLabel) =>
      '$scopeLabel — اختر الجودة، والحجم أمام كل خيار. المحمَّل يعمل بدون إنترنت.';

  @override
  String get noteRecommended => 'موصى به';
  @override
  String get noteAudio => 'صوت';
  @override
  String get noteVideo => 'فيديو';

  @override
  String qualityLabel(QualitySelection selection) {
    final Quality? q = selection.quality;
    if (q == null) return 'تلقائي حسب الشبكة';
    if (q == Quality.mp3) return 'صوت فقط MP3';
    return '${numerals.digits(q.key)}p';
  }

  @override
  String qualityBadge(Quality quality) =>
      quality == Quality.mp3 ? 'MP3' : '${numerals.digits(quality.key)}p';

  @override
  String sleepTimerLabel(int minutes) {
    if (minutes == 0) return 'إيقاف المؤقّت';
    if (minutes < 0) return 'عند نهاية الدرس';
    // Arabic counts 3–10 with the plural, 11+ with the singular.
    final String noun = minutes >= 3 && minutes <= 10 ? 'دقائق' : 'دقيقة';
    return '${numerals.integer(minutes)} $noun';
  }

  @override
  String sleepTimerValue(int minutes) {
    if (minutes == 0) return 'مغلق';
    if (minutes < 0) return 'نهاية الدرس';
    return '${numerals.integer(minutes)} دقيقة';
  }

  @override
  String sleepTimerPill(int minutes) {
    if (minutes == 0) return sleepShort;
    if (minutes < 0) return sleepEndShort;
    return '${numerals.integer(minutes)} د';
  }

  @override
  String get topicDhikr => 'الذكر';
  @override
  String get topicHearts => 'القلوب';
  @override
  String get topicKhutbah => 'خطب الجمعة';
  @override
  String get topicContentment => 'الرضا';
  @override
  String get topicProphet => 'النبي ﷺ';
  @override
  String get topicTafsir => 'التفسير';

  @override
  String toastDownloading(Quality quality, Duration duration) =>
      'جارٍ التنزيل · ${qualityLabel(QualitySelection.pinned(quality))} · '
      '${fileSizeMegabytes(quality.estimatedMegabytes(duration))}';

  @override
  String toastDownloadingSeries(int episodeCount, Quality quality) =>
      'جارٍ تنزيل ${numerals.integer(episodeCount)} حلقات بجودة '
      '${qualityLabel(QualitySelection.pinned(quality))}';

  @override
  String get toastRemovedFromDevice => 'تم حذف الملف من الجهاز';
  @override
  String get toastDownloadFailed => 'تعذّر التنزيل — أعد المحاولة';

  @override
  String get offlineBanner => 'لا يوجد اتصال — تظهر الدروس المحمَّلة فقط';
  @override
  String get networkErrorTitle => 'تعذّر الاتصال';
  @override
  String get networkErrorBody =>
      'تحقّق من اتصالك بالإنترنت ثم أعد المحاولة.';
  @override
  String get loadOlderEpisodes => 'تحميل الحلقات الأقدم';
  @override
  String get loadingOlderEpisodes => 'جارٍ التحميل…';
  @override
  String get downloadQueued => 'في الانتظار';
  @override
  String get downloadPaused => 'متوقّف مؤقتًا';
  @override
  String get downloadFailed => 'فشل التنزيل';

  @override
  String get megabyteUnit => 'م.ب';
  @override
  String get gigabyteUnit => 'غ.ب';
}
