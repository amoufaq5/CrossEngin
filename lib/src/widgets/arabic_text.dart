import 'package:flutter/widgets.dart';

import '../theme/app_typography.dart';

/// Content text — a lesson or series title — which stays Arabic and
/// right-to-left even when the UI language is English.
///
/// It opens its own [Directionality] island so that Flutter's bidi algorithm
/// puts the Arabic run, its punctuation and any embedded numerals in the right
/// order, and so that ellipsis and alignment fall on the correct edge, rather
/// than inheriting the surrounding LTR layout.
class ArabicText extends StatelessWidget {
  const ArabicText(
    this.data, {
    super.key,
    this.style,
    this.maxLines,
    this.overflow = TextOverflow.ellipsis,
    this.textAlign,
  });

  /// Arabic content. Never a translated UI string.
  final String data;

  final TextStyle? style;
  final int? maxLines;
  final TextOverflow overflow;
  final TextAlign? textAlign;

  @override
  Widget build(BuildContext context) {
    return Directionality(
      textDirection: TextDirection.rtl,
      child: Text(
        data,
        style: style,
        maxLines: maxLines,
        overflow: overflow,
        // Start resolves against the RTL island above, so the text aligns to
        // its own right edge regardless of the layout it sits in.
        textAlign: textAlign ?? TextAlign.start,
        textDirection: TextDirection.rtl,
      ),
    );
  }
}

/// A lesson title with its translated `Ep. 42 — ` prefix.
///
/// The prefix follows the UI language; the title does not. In English mode
/// the line mixes scripts: a Latin prefix reading left-to-right, then an
/// Arabic title reading right-to-left.
class EpisodeTitleText extends StatelessWidget {
  const EpisodeTitleText({
    super.key,
    required this.prefix,
    required this.title,
    required this.isArabicUi,
    this.style,
    this.maxLines = 2,
  });

  /// Unicode FIRST STRONG ISOLATE — opens a run whose direction is taken from
  /// its own first strong character rather than from the paragraph.
  static const String firstStrongIsolate = '\u2068';

  /// Unicode POP DIRECTIONAL ISOLATE — closes it.
  static const String popDirectionalIsolate = '\u2069';

  final String prefix;
  final String title;
  final bool isArabicUi;
  final TextStyle? style;
  final int? maxLines;

  @override
  Widget build(BuildContext context) {
    final TextStyle base = style ?? AppText.rowTitle;
    // In Arabic mode the whole line is one RTL run, so the simple path is
    // both correct and cheaper.
    if (isArabicUi) {
      return ArabicText('$prefix$title', style: base, maxLines: maxLines);
    }
    return Text.rich(
      TextSpan(
        children: <InlineSpan>[
          TextSpan(text: prefix),
          TextSpan(
            // Isolating the Arabic run keeps its own punctuation and any
            // trailing spaces with it. Without the isolate those neutral
            // characters resolve to the paragraph's left-to-right direction
            // and jump to the wrong end of the title.
            text: '$firstStrongIsolate$title$popDirectionalIsolate',
            // Declares the run as Arabic for shaping and font fallback.
            locale: const Locale('ar'),
          ),
        ],
      ),
      style: base,
      maxLines: maxLines,
      overflow: TextOverflow.ellipsis,
      textDirection: TextDirection.ltr,
    );
  }
}
