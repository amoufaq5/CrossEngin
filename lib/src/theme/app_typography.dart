import 'package:flutter/material.dart';

/// The two bundled families. Both cover Arabic and Latin, so an Arabic title
/// rendered inside an English layout keeps its intended face.
abstract final class AppFonts {
  /// Titles, numerals, brand.
  static const String kufi = 'NotoKufiArabic';

  /// Body, meta, labels.
  static const String plex = 'IBMPlexSansArabic';
}

/// The type scale, transcribed from the handoff.
///
/// Styles carry no colour — apply one from [AppColors] at the use site. That
/// keeps a single scale across both themes instead of two parallel tables.
///
/// Arabic body text is set at 1.5 line-height (the handoff's 1.45–1.55 band);
/// titles sit at 1.45 so a two-line title stays compact.
abstract final class AppText {
  static const double _bodyHeight = 1.5;
  static const double _titleHeight = 1.45;

  /// Screen title — 24/700 Kufi.
  static const TextStyle screenTitle = TextStyle(
    fontFamily: AppFonts.kufi,
    fontSize: 24,
    fontWeight: FontWeight.w700,
    height: 1.25,
  );

  /// Series hero title — 21/700 Kufi.
  static const TextStyle seriesHero = TextStyle(
    fontFamily: AppFonts.kufi,
    fontSize: 21,
    fontWeight: FontWeight.w700,
    height: 1.3,
  );

  /// Player track title — 16/600 Kufi.
  static const TextStyle playerTitle = TextStyle(
    fontFamily: AppFonts.kufi,
    fontSize: 16,
    fontWeight: FontWeight.w600,
    height: _titleHeight,
  );

  /// Brand name in the home header — 15/600 Kufi.
  static const TextStyle brand = TextStyle(
    fontFamily: AppFonts.kufi,
    fontSize: 15,
    fontWeight: FontWeight.w600,
    height: 1.3,
  );

  /// Section header — 14.5/600 Kufi. Also the bottom-sheet title.
  static const TextStyle sectionHeader = TextStyle(
    fontFamily: AppFonts.kufi,
    fontSize: 14.5,
    fontWeight: FontWeight.w600,
    height: 1.35,
  );

  /// Resume card title — 14/500 Kufi, two lines max.
  static const TextStyle resumeTitle = TextStyle(
    fontFamily: AppFonts.kufi,
    fontSize: 14,
    fontWeight: FontWeight.w500,
    height: _titleHeight,
  );

  /// Series list row title — 13.5/500 Kufi.
  static const TextStyle seriesRowTitle = TextStyle(
    fontFamily: AppFonts.kufi,
    fontSize: 13.5,
    fontWeight: FontWeight.w500,
    height: _titleHeight,
  );

  /// Series rail card title — 12/500 Kufi.
  static const TextStyle seriesCardTitle = TextStyle(
    fontFamily: AppFonts.kufi,
    fontSize: 12,
    fontWeight: FontWeight.w500,
    height: _titleHeight,
  );

  /// Lesson row title — 12.5/500 Plex. Also settings row labels.
  static const TextStyle rowTitle = TextStyle(
    fontFamily: AppFonts.plex,
    fontSize: 12.5,
    fontWeight: FontWeight.w500,
    height: _bodyHeight,
  );

  /// Secondary text — 11.5/400 Plex. Mini-player title, sheet hints.
  static const TextStyle secondary = TextStyle(
    fontFamily: AppFonts.plex,
    fontSize: 11.5,
    fontWeight: FontWeight.w400,
    height: _bodyHeight,
  );

  /// Secondary text, tighter — 11/400 Plex.
  static const TextStyle secondarySmall = TextStyle(
    fontFamily: AppFonts.plex,
    fontSize: 11,
    fontWeight: FontWeight.w400,
    height: _bodyHeight,
  );

  /// Meta text — 10.5/400 Plex. Greeting, series sub-lines, hints.
  static const TextStyle meta = TextStyle(
    fontFamily: AppFonts.plex,
    fontSize: 10.5,
    fontWeight: FontWeight.w400,
    height: _bodyHeight,
  );

  /// Meta text, tighter — 10/400 Plex. Durations, progress read-outs.
  static const TextStyle metaSmall = TextStyle(
    fontFamily: AppFonts.plex,
    fontSize: 10,
    fontWeight: FontWeight.w400,
    height: _bodyHeight,
  );

  /// Kicker — 9.5/600 Plex with .14em tracking (1.33 logical px at 9.5).
  static const TextStyle kicker = TextStyle(
    fontFamily: AppFonts.plex,
    fontSize: 9.5,
    fontWeight: FontWeight.w600,
    letterSpacing: 9.5 * 0.14,
    height: 1.4,
  );

  /// Tab bar label — 10.5/500 Plex.
  static const TextStyle tabLabel = TextStyle(
    fontFamily: AppFonts.plex,
    fontSize: 10.5,
    fontWeight: FontWeight.w500,
    height: 1.2,
  );

  /// The language toggle's `EN` / `ع` glyph — 10/600 Plex.
  static const TextStyle langToggle = TextStyle(
    fontFamily: AppFonts.plex,
    fontSize: 10,
    fontWeight: FontWeight.w600,
    height: 1.2,
  );
}
