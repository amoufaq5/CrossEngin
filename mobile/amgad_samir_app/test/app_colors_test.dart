import 'dart:math' as math;

import 'package:amgad_samir_app/src/theme/app_colors.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// WCAG relative luminance, from sRGB components.
double _luminance(Color c) {
  double channel(double v) =>
      v <= 0.03928 ? v / 12.92 : math.pow((v + 0.055) / 1.055, 2.4).toDouble();
  return 0.2126 * channel(c.r) +
      0.7152 * channel(c.g) +
      0.0722 * channel(c.b);
}

double _contrast(Color a, Color b) {
  final double la = _luminance(a);
  final double lb = _luminance(b);
  final double hi = math.max(la, lb);
  final double lo = math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

Color _hex(int argb) => Color(argb);

void main() {
  group('dark tokens match the handoff table exactly', () {
    test('opaque tokens', () {
      const AppColors c = AppColors.dark;
      expect(c.bg, _hex(0xFF0B1020));
      expect(c.surf, _hex(0xFF111828));
      expect(c.surf2, _hex(0xFF141B2D));
      expect(c.surf3, _hex(0xFF1B2338));
      expect(c.txt, _hex(0xFFF3EFE8));
      expect(c.mut, _hex(0xFF8D96AC));
      expect(c.mut2, _hex(0xFF7A839B));
      expect(c.dim, _hex(0xFF5F6982));
      expect(c.acc, _hex(0xFFC9A25A));
      expect(c.accTxt, _hex(0xFF101625));
      expect(c.track, _hex(0xFF26304A));
      expect(c.ok, _hex(0xFF5E9E7A));
      expect(c.okbg, _hex(0xFF16251E));
    });

    test('alpha tokens', () {
      const AppColors c = AppColors.dark;
      expect(c.line.a, closeTo(0.07, 0.005));
      expect(c.navbg.a, closeTo(0.97, 0.005));
      expect(c.minibg.a, closeTo(0.96, 0.005));
      expect(c.shade.a, closeTo(0.62, 0.005));
      expect(c.coverLetter.a, closeTo(0.2, 0.005));
    });

    test('dark mode has no drop shadows — depth comes from surface steps', () {
      expect(AppColors.dark.cardShadow, isEmpty);
    });
  });

  group('light tokens match the handoff table exactly', () {
    test('opaque tokens', () {
      const AppColors c = AppColors.light;
      expect(c.bg, _hex(0xFFF6F2EA));
      expect(c.surf, _hex(0xFFFFFFFF));
      expect(c.surf2, _hex(0xFFF1ECE2));
      expect(c.surf3, _hex(0xFFEDE5D6));
      expect(c.txt, _hex(0xFF161C2A));
      expect(c.mut, _hex(0xFF59616F));
      expect(c.mut2, _hex(0xFF5F6878));
      expect(c.dim, _hex(0xFF6F7788));
      expect(c.acc, _hex(0xFF8A6A24));
      expect(c.accTxt, _hex(0xFFFFF9EE));
      expect(c.track, _hex(0xFFE2DACB));
      expect(c.ok, _hex(0xFF2F7A56));
      expect(c.okbg, _hex(0xFFE7F1EB));
    });

    test('light mode has exactly one shadow, on white cards', () {
      expect(AppColors.light.cardShadow, hasLength(1));
      final BoxShadow s = AppColors.light.cardShadow.single;
      expect(s.offset, const Offset(0, 1));
      expect(s.blurRadius, 2);
      expect(s.color.a, closeTo(0.06, 0.005));
    });
  });

  group('light secondaries stay dark enough — do not lighten them', () {
    test('text tokens clear AA on the surface they are used on', () {
      const AppColors c = AppColors.light;
      expect(_contrast(c.txt, c.bg), greaterThanOrEqualTo(4.5));
      expect(_contrast(c.mut, c.bg), greaterThanOrEqualTo(4.5));
      expect(_contrast(c.mut2, c.bg), greaterThanOrEqualTo(4.5));
      expect(_contrast(c.acc, c.surf), greaterThanOrEqualTo(4.5));
    });

    test('dim carries icons and inactive tabs, so it holds the 3:1 UI floor', () {
      // `dim` is never body text: it is chevrons and unselected tab glyphs,
      // which WCAG scores against the 3:1 non-text threshold.
      expect(
        _contrast(AppColors.light.dim, AppColors.light.bg),
        greaterThanOrEqualTo(3),
      );
      expect(
        _contrast(AppColors.dark.dim, AppColors.dark.bg),
        greaterThanOrEqualTo(3),
      );
    });

    test('dark text tokens clear AA too', () {
      const AppColors c = AppColors.dark;
      expect(_contrast(c.txt, c.bg), greaterThanOrEqualTo(4.5));
      expect(_contrast(c.mut, c.surf), greaterThanOrEqualTo(4.5));
      expect(_contrast(c.mut2, c.surf), greaterThanOrEqualTo(4.5));
      expect(_contrast(c.accTxt, c.acc), greaterThanOrEqualTo(4.5));
    });
  });

  group('resume ring', () {
    test('the gold stops are literal, the tail follows the theme', () {
      // The design hardcodes rgb(201,162,90) in both themes; only the third
      // stop is a token. Swapping the gold for `acc` would wash the ring out
      // in light mode.
      for (final AppColors c in <AppColors>[AppColors.dark, AppColors.light]) {
        final LinearGradient g = c.resumeRing;
        expect(g.colors.first, const Color.fromRGBO(201, 162, 90, 0.5));
        expect(g.colors[1], const Color.fromRGBO(201, 162, 90, 0));
        expect(g.colors.last, c.line);
        expect(g.stops, const <double>[0, 0.55, 1]);
      }
      expect(AppColors.light.resumeRing.colors.first,
          isNot(AppColors.light.acc));
    });
  });

  test('theme changes snap rather than cross-fading', () {
    // The handoff calls for an instant theme swap. A lerp that interpolates
    // would produce off-palette intermediate colours.
    expect(AppColors.dark.lerp(AppColors.light, 0.4), AppColors.dark);
    expect(AppColors.dark.lerp(AppColors.light, 0.6), AppColors.light);
  });
}
