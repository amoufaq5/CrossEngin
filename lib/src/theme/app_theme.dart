import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'app_colors.dart';
import 'app_metrics.dart';
import 'app_typography.dart';

/// Builds a [ThemeData] around one [AppColors] token set.
///
/// Material's own palette is derived from the tokens rather than the other way
/// round, so a stray Material widget picks up the design's colours instead of
/// a purple default.
abstract final class AppTheme {
  static ThemeData dark() => _build(AppColors.dark);

  static ThemeData light() => _build(AppColors.light);

  static ThemeData of(Brightness brightness) =>
      brightness == Brightness.dark ? dark() : light();

  static ThemeData _build(AppColors c) {
    final ColorScheme scheme =
        ColorScheme.fromSeed(
          seedColor: c.acc,
          brightness: c.brightness,
        ).copyWith(
          primary: c.acc,
          onPrimary: c.accTxt,
          surface: c.surf,
          onSurface: c.txt,
          outline: c.dim,
          error: const Color(0xFFD1495B),
        );

    return ThemeData(
      useMaterial3: true,
      brightness: c.brightness,
      colorScheme: scheme,
      scaffoldBackgroundColor: c.bg,
      canvasColor: c.bg,
      splashFactory: InkSparkle.splashFactory,
      fontFamily: AppFonts.plex,
      extensions: <ThemeExtension<dynamic>>[c],
      textTheme: _textTheme(c),
      dividerTheme: DividerThemeData(color: c.line, thickness: 1, space: 1),
      iconTheme: IconThemeData(color: c.mut, size: 19),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: c.surf,
        modalBackgroundColor: c.surf,
        surfaceTintColor: Colors.transparent,
        modalBarrierColor: c.shade,
        showDragHandle: false,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(
            top: Radius.circular(AppRadii.sheet),
          ),
        ),
      ),
      // The design draws its own chrome; Material's app bar never appears.
      appBarTheme: AppBarTheme(
        backgroundColor: c.bg,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        systemOverlayStyle: systemOverlayStyle(c.brightness),
      ),
      progressIndicatorTheme: ProgressIndicatorThemeData(
        color: c.acc,
        linearTrackColor: c.track,
        circularTrackColor: c.track,
      ),
      textSelectionTheme: TextSelectionThemeData(
        cursorColor: c.acc,
        selectionColor: c.acc.withValues(alpha: 0.28),
        selectionHandleColor: c.acc,
      ),
    );
  }

  static TextTheme _textTheme(AppColors c) => TextTheme(
    headlineSmall: AppText.screenTitle.copyWith(color: c.txt),
    titleLarge: AppText.seriesHero.copyWith(color: c.txt),
    titleMedium: AppText.playerTitle.copyWith(color: c.txt),
    titleSmall: AppText.sectionHeader.copyWith(color: c.txt),
    bodyLarge: AppText.rowTitle.copyWith(color: c.txt),
    bodyMedium: AppText.secondary.copyWith(color: c.mut),
    bodySmall: AppText.meta.copyWith(color: c.mut2),
    labelSmall: AppText.kicker.copyWith(color: c.mut2),
  );

  /// Status-bar and navigation-bar styling. The theme toggle switches this
  /// alongside the tokens.
  static SystemUiOverlayStyle systemOverlayStyle(Brightness brightness) {
    final bool isDark = brightness == Brightness.dark;
    final AppColors c = isDark ? AppColors.dark : AppColors.light;
    return SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: isDark ? Brightness.light : Brightness.dark,
      statusBarBrightness: isDark ? Brightness.dark : Brightness.light,
      systemNavigationBarColor: c.bg,
      systemNavigationBarIconBrightness: isDark
          ? Brightness.light
          : Brightness.dark,
      systemNavigationBarDividerColor: Colors.transparent,
    );
  }
}
