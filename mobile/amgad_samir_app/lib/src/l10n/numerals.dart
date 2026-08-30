import 'package:flutter/foundation.dart';

/// Locale-aware number rendering.
///
/// The language toggle switches the digit system as well as the strings:
/// Arabic-Indic (٠–٩) with U+066B as the decimal mark in Arabic, Latin digits
/// with a full stop in English. Durations, file sizes and percentages all run
/// through here so no screen has to remember which system is active.
@immutable
class Numerals {
  const Numerals({required this.arabicIndic});

  const Numerals.arabic() : arabicIndic = true;

  const Numerals.latin() : arabicIndic = false;

  final bool arabicIndic;

  static const List<String> _arabicDigits = <String>[
    '٠',
    '١',
    '٢',
    '٣',
    '٤',
    '٥',
    '٦',
    '٧',
    '٨',
    '٩',
  ];

  /// U+066B ARABIC DECIMAL SEPARATOR.
  static const String arabicDecimalMark = '٫';

  String get _decimalMark => arabicIndic ? arabicDecimalMark : '.';

  /// Rewrites every ASCII digit in [source] into the active digit system and
  /// leaves everything else — including `:` and `×` — untouched.
  String digits(String source) {
    if (!arabicIndic) return source;
    final StringBuffer out = StringBuffer();
    for (final int unit in source.codeUnits) {
      if (unit >= 0x30 && unit <= 0x39) {
        out.write(_arabicDigits[unit - 0x30]);
      } else {
        out.writeCharCode(unit);
      }
    }
    return out.toString();
  }

  String integer(int value) => digits(value.toString());

  String decimal(num value, {int fractionDigits = 1}) =>
      digits(value.toStringAsFixed(fractionDigits)).replaceAll('.', _decimalMark);

  /// `mm:ss`, widening to `h:mm:ss` past an hour. Digits follow the locale;
  /// the colon does not — it reads the same in both scripts.
  String duration(Duration value) {
    final int total = value.inSeconds < 0 ? 0 : value.inSeconds;
    final int hours = total ~/ 3600;
    final int minutes = (total % 3600) ~/ 60;
    final int seconds = total % 60;
    final String two = seconds.toString().padLeft(2, '0');
    if (hours > 0) {
      return digits('$hours:${minutes.toString().padLeft(2, '0')}:$two');
    }
    return digits('${minutes.toString().padLeft(2, '0')}:$two');
  }

  /// Playback speed: `1.25×` / `١٫٢٥×`. Trailing zeros are trimmed to one
  /// decimal so 2.0 reads as `2.0×`, matching the design's speed pill.
  String speed(double multiplier) {
    final String body = multiplier == multiplier.roundToDouble()
        ? multiplier.toStringAsFixed(1)
        : multiplier.toString();
    return '${digits(body).replaceAll('.', _decimalMark)}×';
  }

  String percent(double fraction) =>
      '${integer((fraction.clamp(0, 1) * 100).round())}%';
}
