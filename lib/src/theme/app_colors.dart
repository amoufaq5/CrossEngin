import 'package:flutter/material.dart';

/// The design's colour tokens, one instance per theme.
///
/// Values are transcribed verbatim from the handoff token tables. The light
/// secondaries (`mut2` ≈ 4.6:1, `dim` ≈ 4.3:1) were tuned for WCAG AA at the
/// small sizes this design uses — do not lighten them.
@immutable
class AppColors extends ThemeExtension<AppColors> {
  const AppColors({
    required this.bg,
    required this.surf,
    required this.surf2,
    required this.surf3,
    required this.txt,
    required this.mut,
    required this.mut2,
    required this.dim,
    required this.acc,
    required this.accTxt,
    required this.line,
    required this.track,
    required this.ok,
    required this.okbg,
    required this.navbg,
    required this.minibg,
    required this.shade,
    required this.coverLetter,
    required this.cardShadow,
    required this.brightness,
  });

  /// Screen background.
  final Color bg;

  /// Cards, rows, sheets.
  final Color surf;

  /// Icon buttons, chips.
  final Color surf2;

  /// Selected sheet row.
  final Color surf3;

  /// Primary text.
  final Color txt;

  /// Secondary text.
  final Color mut;

  /// Tertiary / meta text.
  final Color mut2;

  /// Inactive tabs, chevrons.
  final Color dim;

  /// Accent (gold).
  final Color acc;

  /// Text and icons drawn on [acc].
  final Color accTxt;

  /// Hairlines.
  final Color line;

  /// Progress track.
  final Color track;

  /// Downloaded state foreground.
  final Color ok;

  /// Downloaded state background.
  final Color okbg;

  /// Tab bar, behind an 18px blur.
  final Color navbg;

  /// Mini-player, behind an 18px blur.
  final Color minibg;

  /// Bottom-sheet scrim.
  final Color shade;

  /// The first-letter watermark drawn over placeholder cover art.
  final Color coverLetter;

  /// Dark mode has no drop shadows; light mode has exactly one, on white cards.
  final List<BoxShadow> cardShadow;

  final Brightness brightness;

  bool get isDark => brightness == Brightness.dark;

  /// The gold 1px ring on the resume card. The gold stops are literal —
  /// they do not follow [acc] — while the tail stop follows [line].
  ///
  /// CSS: `linear-gradient(135deg, rgba(201,162,90,.5), rgba(201,162,90,0) 55%, line)`.
  LinearGradient get resumeRing => LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: <Color>[
      const Color.fromRGBO(201, 162, 90, 0.5),
      const Color.fromRGBO(201, 162, 90, 0),
      line,
    ],
    stops: const <double>[0, 0.55, 1],
  );

  /// The count pill on series cover art. Literal in both themes — it sits on
  /// artwork, not on a surface.
  static const Color coverPill = Color.fromRGBO(10, 14, 24, 0.5);

  static const AppColors dark = AppColors(
    bg: Color(0xFF0B1020),
    surf: Color(0xFF111828),
    surf2: Color(0xFF141B2D),
    surf3: Color(0xFF1B2338),
    txt: Color(0xFFF3EFE8),
    mut: Color(0xFF8D96AC),
    mut2: Color(0xFF7A839B),
    dim: Color(0xFF5F6982),
    acc: Color(0xFFC9A25A),
    accTxt: Color(0xFF101625),
    line: Color.fromRGBO(255, 255, 255, 0.07),
    track: Color(0xFF26304A),
    ok: Color(0xFF5E9E7A),
    okbg: Color(0xFF16251E),
    navbg: Color.fromRGBO(11, 16, 32, 0.97),
    minibg: Color.fromRGBO(23, 31, 50, 0.96),
    shade: Color.fromRGBO(6, 9, 18, 0.62),
    coverLetter: Color.fromRGBO(255, 255, 255, 0.2),
    cardShadow: <BoxShadow>[],
    brightness: Brightness.dark,
  );

  static const AppColors light = AppColors(
    bg: Color(0xFFF6F2EA),
    surf: Color(0xFFFFFFFF),
    surf2: Color(0xFFF1ECE2),
    surf3: Color(0xFFEDE5D6),
    txt: Color(0xFF161C2A),
    mut: Color(0xFF59616F),
    mut2: Color(0xFF5F6878),
    dim: Color(0xFF6F7788),
    acc: Color(0xFF8A6A24),
    accTxt: Color(0xFFFFF9EE),
    line: Color.fromRGBO(22, 28, 42, 0.09),
    track: Color(0xFFE2DACB),
    ok: Color(0xFF2F7A56),
    okbg: Color(0xFFE7F1EB),
    navbg: Color.fromRGBO(246, 242, 234, 0.98),
    minibg: Color.fromRGBO(255, 255, 255, 0.97),
    shade: Color.fromRGBO(22, 28, 42, 0.42),
    coverLetter: Color.fromRGBO(22, 28, 42, 0.5),
    cardShadow: <BoxShadow>[
      BoxShadow(
        color: Color.fromRGBO(22, 28, 42, 0.06),
        offset: Offset(0, 1),
        blurRadius: 2,
      ),
    ],
    brightness: Brightness.light,
  );

  @override
  AppColors copyWith({Brightness? brightness}) =>
      brightness == Brightness.light ? light : dark;

  /// The handoff specifies an instant theme swap with no cross-fade, so this
  /// snaps rather than interpolating. [AmgadSamirApp] also pins
  /// `themeAnimationDuration` to zero; this keeps the promise even if some
  /// other path drives a lerp.
  @override
  AppColors lerp(ThemeExtension<AppColors>? other, double t) {
    if (other is! AppColors) return this;
    return t < 0.5 ? this : other;
  }
}

extension AppColorsContext on BuildContext {
  /// The active token set. Reads rebuild on theme change.
  AppColors get colors => Theme.of(this).extension<AppColors>()!;
}
