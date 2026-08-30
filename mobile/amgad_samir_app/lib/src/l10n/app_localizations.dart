import 'package:flutter/widgets.dart';

import 'app_strings.dart';
import 'numerals.dart';
import 'strings_ar.dart';
import 'strings_en.dart';

/// Installs [AppStrings] into the tree the standard way, so any widget can
/// read them with `context.strings` and rebuild when the language changes.
class AppLocalizations {
  const AppLocalizations._();

  static const List<Locale> supportedLocales = <Locale>[
    Locale('ar'),
    Locale('en'),
  ];

  static const LocalizationsDelegate<AppStrings> delegate =
      _AppStringsDelegate();

  static AppStrings stringsFor(Locale locale) =>
      locale.languageCode == 'en'
          ? const EnglishStrings()
          : const ArabicStrings();

  /// Arabic is the default: an unsupported system locale lands there rather
  /// than on English.
  static Locale resolve(Locale? deviceLocale, Iterable<Locale> supported) {
    if (deviceLocale?.languageCode == 'en') return const Locale('en');
    return const Locale('ar');
  }
}

class _AppStringsDelegate extends LocalizationsDelegate<AppStrings> {
  const _AppStringsDelegate();

  @override
  bool isSupported(Locale locale) =>
      locale.languageCode == 'ar' || locale.languageCode == 'en';

  @override
  Future<AppStrings> load(Locale locale) async =>
      AppLocalizations.stringsFor(locale);

  @override
  bool shouldReload(_AppStringsDelegate old) => false;
}

extension AppStringsContext on BuildContext {
  /// The active string table. Reads rebuild on language change.
  AppStrings get strings => Localizations.of<AppStrings>(this, AppStrings)!;

  /// Shorthand for the active number system.
  Numerals get numerals => strings.numerals;
}
