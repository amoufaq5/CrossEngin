import 'package:amgad_samir_app/src/theme/app_colors.dart';
import 'package:amgad_samir_app/src/theme/app_metrics.dart';
import 'package:amgad_samir_app/src/theme/app_theme.dart';
import 'package:amgad_samir_app/src/theme/app_typography.dart';
import 'package:amgad_samir_app/src/widgets/arabic_text.dart';
import 'package:amgad_samir_app/src/widgets/brand_mark.dart';
import 'package:amgad_samir_app/src/widgets/directional.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget _in(TextDirection direction, Widget child) => Directionality(
  textDirection: direction,
  child: Center(child: child),
);

void main() {
  const String arabicTitle = 'من ثمرات الذكر: طردُ الشيطان';

  group('ArabicText', () {
    testWidgets('opens an RTL island even inside an LTR layout', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        _in(TextDirection.ltr, const ArabicText(arabicTitle)),
      );

      final Text text = tester.widget<Text>(find.byType(Text));
      expect(text.textDirection, TextDirection.rtl);

      final Directionality island = tester.widget<Directionality>(
        find
            .descendant(
              of: find.byType(ArabicText),
              matching: find.byType(Directionality),
            )
            .first,
      );
      expect(island.textDirection, TextDirection.rtl);
    });

    testWidgets('the same title lands on the same painted glyphs either way', (
      WidgetTester tester,
    ) async {
      // The point of the island: layout direction must not change how the
      // content itself reads.
      final List<Rect> rects = <Rect>[];
      for (final TextDirection d in TextDirection.values) {
        await tester.pumpWidget(
          _in(d, const SizedBox(width: 300, child: ArabicText(arabicTitle))),
        );
        rects.add(tester.getRect(find.byType(Text)));
      }
      expect(rects[0].size, rects[1].size);
    });
  });

  group('EpisodeTitleText', () {
    testWidgets('Arabic mode renders one RTL run', (WidgetTester tester) async {
      await tester.pumpWidget(
        _in(
          TextDirection.rtl,
          const EpisodeTitleText(
            prefix: 'الحلقة ٤٢ — ',
            title: arabicTitle,
            isArabicUi: true,
          ),
        ),
      );
      expect(find.byType(ArabicText), findsOneWidget);
      expect(find.text('الحلقة ٤٢ — $arabicTitle'), findsOneWidget);
    });

    testWidgets('English mode keeps a Latin prefix and an Arabic title', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        _in(
          TextDirection.ltr,
          const EpisodeTitleText(
            prefix: 'Ep. 42 — ',
            title: arabicTitle,
            isArabicUi: false,
          ),
        ),
      );

      final RichText rich = tester.widget<RichText>(find.byType(RichText));
      expect(rich.textDirection, TextDirection.ltr);

      final List<TextSpan> runs = <TextSpan>[];
      rich.text.visitChildren((InlineSpan span) {
        if (span is TextSpan && span.text != null) runs.add(span);
        return true;
      });
      expect(runs, hasLength(2));
      expect(runs[0].text, 'Ep. 42 — ');
      // The Arabic run is wrapped in a bidi isolate so its punctuation stays
      // with it instead of resolving to the paragraph's left-to-right
      // direction, and declares its locale for shaping.
      expect(
        runs[1].text,
        '${EpisodeTitleText.firstStrongIsolate}$arabicTitle'
        '${EpisodeTitleText.popDirectionalIsolate}',
      );
      expect(runs[1].locale, const Locale('ar'));
    });
  });

  group('mirroring', () {
    testWidgets('MirrorForDirection flips in RTL and is a no-op in LTR', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        _in(TextDirection.ltr, const MirrorForDirection(child: Text('x'))),
      );
      expect(
        find.descendant(
          of: find.byType(MirrorForDirection),
          matching: find.byType(Transform),
        ),
        findsNothing,
      );

      await tester.pumpWidget(
        _in(TextDirection.rtl, const MirrorForDirection(child: Text('x'))),
      );
      final Transform t = tester.widget<Transform>(
        find.descendant(
          of: find.byType(MirrorForDirection),
          matching: find.byType(Transform),
        ),
      );
      // A horizontal flip about the centre: x scales by -1, y is untouched.
      expect(t.transform.entry(0, 0), -1);
      expect(t.transform.entry(1, 1), 1);
      expect(t.alignment, Alignment.center);
    });

    testWidgets('the chevron mirrors', (WidgetTester tester) async {
      for (final TextDirection d in TextDirection.values) {
        await tester.pumpWidget(
          _in(d, const ForwardChevron(color: Color(0xFF000000))),
        );
        expect(find.byType(MirrorForDirection), findsOneWidget);
      }
    });

    testWidgets('the play triangle never mirrors', (WidgetTester tester) async {
      // A play button points the same way in every language. This is the
      // single most common RTL bug in a media app, so it is asserted rather
      // than left to review.
      for (final TextDirection d in TextDirection.values) {
        await tester.pumpWidget(
          _in(d, const PlayGlyph(color: Color(0xFF000000))),
        );
        expect(
          find.descendant(
            of: find.byType(PlayGlyph),
            matching: find.byType(Transform),
          ),
          findsNothing,
        );
        expect(find.byType(MirrorForDirection), findsNothing);
      }
    });

    testWidgets('the play glyph keeps the design\'s 15:17 aspect', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        _in(
          TextDirection.rtl,
          const PlayGlyph(color: Color(0xFF000000), size: 30),
        ),
      );
      final Size size = tester.getSize(find.byType(CustomPaint).first);
      expect(size.width, 30);
      expect(size.height, closeTo(30 * 17 / 15, 0.001));
    });
  });

  group('BrandMark', () {
    testWidgets('is tinted from the theme, not baked into the asset', (
      WidgetTester tester,
    ) async {
      for (final AppColors c in <AppColors>[AppColors.dark, AppColors.light]) {
        await tester.pumpWidget(
          MaterialApp(
            theme: AppTheme.of(c.brightness),
            themeAnimationDuration: AppMotion.theme,
            home: const Scaffold(body: Center(child: BrandMark())),
          ),
        );
        await tester.pumpAndSettle();
        final Image image = tester.widget<Image>(find.byType(Image));
        expect(image.color, c.txt);
        // srcIn, so the mask's alpha survives and only the colour is replaced.
        expect(image.colorBlendMode, BlendMode.srcIn);
        expect(tester.getSize(find.byType(BrandMark)), const Size(34, 34));
      }
    });
  });

  group('type scale', () {
    test('titles are Kufi and body is Plex, at the handoff sizes', () {
      expect(AppText.screenTitle.fontFamily, AppFonts.kufi);
      expect(AppText.screenTitle.fontSize, 24);
      expect(AppText.screenTitle.fontWeight, FontWeight.w700);

      expect(AppText.seriesHero.fontSize, 21);
      expect(AppText.playerTitle.fontSize, 16);
      expect(AppText.sectionHeader.fontSize, 14.5);

      expect(AppText.rowTitle.fontFamily, AppFonts.plex);
      expect(AppText.rowTitle.fontSize, 12.5);
      expect(AppText.tabLabel.fontSize, 10.5);
      expect(AppText.metaSmall.fontSize, 10);
    });

    test('the kicker carries .14em tracking', () {
      expect(AppText.kicker.fontSize, 9.5);
      expect(AppText.kicker.letterSpacing, closeTo(9.5 * 0.14, 0.0001));
    });

    test('Arabic body text sits in the 1.45-1.55 leading band', () {
      for (final TextStyle s in <TextStyle>[
        AppText.rowTitle,
        AppText.secondary,
        AppText.secondarySmall,
        AppText.meta,
        AppText.metaSmall,
      ]) {
        expect(s.height, inInclusiveRange(1.45, 1.55));
      }
    });
  });
}
