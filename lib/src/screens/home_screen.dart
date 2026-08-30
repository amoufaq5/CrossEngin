import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/quality.dart';
import '../l10n/app_localizations.dart';
import '../l10n/app_strings.dart';
import '../settings/app_settings.dart';
import '../settings/settings_controller.dart';
import '../theme/app_colors.dart';
import '../theme/app_metrics.dart';
import '../theme/app_typography.dart';
import '../theme/series_palette.dart';
import '../widgets/arabic_text.dart';
import '../widgets/directional.dart';

/// Step 3 replaces this with the real home screen.
///
/// Until then it renders the step-1 deliverables directly — the token tables,
/// the type scale, the cover gradients, and the direction/digit/unit
/// behaviour of the language toggle — so the foundation can be reviewed
/// against the handoff before anything is built on top of it.
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppStrings str = context.strings;
    final AppSettings settings = ref.watch(settingsProvider);
    final SettingsController controller = ref.read(settingsProvider.notifier);

    return SafeArea(
      bottom: false,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(
          AppSpace.screenX,
          AppSpace.x18,
          AppSpace.screenX,
          AppSpace.contentBottom,
        ),
        children: <Widget>[
          _Header(
            onToggleTheme: controller.toggleTheme,
            onToggleLanguage: controller.toggleLanguage,
          ),
          const SizedBox(height: AppSpace.x22),
          _Section(
            title: str.isArabic ? 'الألوان' : 'Colour tokens',
            child: const _Swatches(),
          ),
          const SizedBox(height: AppSpace.x22),
          _Section(
            title: str.isArabic ? 'المقاسات' : 'Type scale',
            child: const _TypeScale(),
          ),
          const SizedBox(height: AppSpace.x22),
          _Section(
            title: str.isArabic ? 'أغلفة السلاسل' : 'Series covers',
            child: const _Covers(),
          ),
          const SizedBox(height: AppSpace.x22),
          _Section(
            title: str.isArabic ? 'الأرقام والوحدات' : 'Digits and units',
            child: _Numbers(settings: settings),
          ),
          const SizedBox(height: AppSpace.x22),
          _Section(
            title: str.isArabic ? 'الاتجاه' : 'Direction',
            child: const _DirectionProof(),
          ),
        ],
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.onToggleTheme, required this.onToggleLanguage});

  final VoidCallback onToggleTheme;
  final VoidCallback onToggleLanguage;

  @override
  Widget build(BuildContext context) {
    final AppColors c = context.colors;
    final AppStrings str = context.strings;
    return Row(
      spacing: AppSpace.x10,
      children: <Widget>[
        ClipRRect(
          borderRadius: BorderRadius.circular(10),
          child: Image.asset(
            'assets/images/logo.png',
            width: 34,
            height: 34,
            fit: BoxFit.cover,
          ),
        ),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            spacing: AppSpace.x4,
            children: <Widget>[
              // The brand name is content, not a UI label: it stays Arabic in
              // Arabic and transliterates in English, but either way it is set
              // in Kufi at the brand size.
              Text(str.brand, style: AppText.brand.copyWith(color: c.txt)),
              Text(
                str.greeting,
                style: AppText.meta.copyWith(color: c.mut),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ),
        ),
        _HeaderButton(
          onTap: onToggleTheme,
          child: Icon(
            c.isDark ? Icons.dark_mode_outlined : Icons.light_mode_outlined,
            size: 17,
            color: c.mut,
          ),
        ),
        _HeaderButton(
          onTap: onToggleLanguage,
          child: Text(
            str.languageToggleGlyph,
            style: AppText.langToggle.copyWith(color: c.acc),
          ),
        ),
      ],
    );
  }
}

/// A 34x34 painted button inside a full-size tap target.
///
/// The ink response covers the whole target rather than the painted box, so
/// the button is as easy to hit as the guidelines require without growing.
class _HeaderButton extends StatelessWidget {
  const _HeaderButton({required this.child, required this.onTap});

  final Widget child;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final AppColors c = context.colors;
    return SizedBox(
      width: AppTargets.minTarget,
      height: AppTargets.minTarget,
      child: InkResponse(
        onTap: onTap,
        containedInkWell: false,
        highlightShape: BoxShape.circle,
        radius: AppTargets.minTarget / 2,
        child: Center(
          child: Container(
            width: AppTargets.headerButton,
            height: AppTargets.headerButton,
            decoration: BoxDecoration(
              color: c.surf2,
              borderRadius: BorderRadius.circular(AppRadii.iconButton),
            ),
            child: Center(child: child),
          ),
        ),
      ),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.child});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final AppColors c = context.colors;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      spacing: AppSpace.x12,
      children: <Widget>[
        Text(title, style: AppText.sectionHeader.copyWith(color: c.txt)),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(AppSpace.x16),
          decoration: BoxDecoration(
            color: c.surf,
            borderRadius: BorderRadius.circular(AppRadii.card),
            border: Border.all(color: c.line),
            boxShadow: c.cardShadow,
          ),
          child: child,
        ),
      ],
    );
  }
}

class _Swatches extends StatelessWidget {
  const _Swatches();

  @override
  Widget build(BuildContext context) {
    final AppColors c = context.colors;
    final List<(String, Color)> tokens = <(String, Color)>[
      ('bg', c.bg),
      ('surf', c.surf),
      ('surf2', c.surf2),
      ('surf3', c.surf3),
      ('txt', c.txt),
      ('mut', c.mut),
      ('mut2', c.mut2),
      ('dim', c.dim),
      ('acc', c.acc),
      ('accTxt', c.accTxt),
      ('track', c.track),
      ('ok', c.ok),
      ('okbg', c.okbg),
      ('navbg', c.navbg),
      ('minibg', c.minibg),
    ];
    return Wrap(
      spacing: AppSpace.x10,
      runSpacing: AppSpace.x10,
      children: <Widget>[
        for (final (String name, Color value) in tokens)
          Column(
            spacing: AppSpace.x4,
            children: <Widget>[
              Container(
                width: 44,
                height: 30,
                decoration: BoxDecoration(
                  color: value,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: c.line),
                ),
              ),
              Text(name, style: AppText.metaSmall.copyWith(color: c.mut2)),
            ],
          ),
      ],
    );
  }
}

class _TypeScale extends StatelessWidget {
  const _TypeScale();

  @override
  Widget build(BuildContext context) {
    final AppColors c = context.colors;
    final List<(String, TextStyle, String)> rows = <(String, TextStyle, String)>[
      ('24/700 Kufi', AppText.screenTitle, 'السلاسل'),
      ('21/700 Kufi', AppText.seriesHero, 'شرح الوابل الصيب'),
      ('16/600 Kufi', AppText.playerTitle, 'من ثمرات الذكر: طردُ الشيطان'),
      ('14.5/600 Kufi', AppText.sectionHeader, 'أحدث الدروس'),
      ('12.5/500 Plex', AppText.rowTitle, 'كيف يُحيا القلب بعد موته؟'),
      ('11/400 Plex', AppText.secondarySmall, 'قراءة وتعليق'),
      ('10/400 Plex', AppText.metaSmall, '٤٥:٠٢'),
      ('9.5/600 Plex .14em', AppText.kicker, 'أكمل الاستماع'),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      spacing: AppSpace.x12,
      children: <Widget>[
        for (final (String label, TextStyle style, String sample) in rows)
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            spacing: AppSpace.x4,
            children: <Widget>[
              Text(label, style: AppText.metaSmall.copyWith(color: c.dim)),
              ArabicText(sample, style: style.copyWith(color: c.txt)),
            ],
          ),
      ],
    );
  }
}

class _Covers extends StatelessWidget {
  const _Covers();

  @override
  Widget build(BuildContext context) {
    final AppColors c = context.colors;
    return SizedBox(
      height: 92,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: CoverPalette.bySeriesId.length,
        separatorBuilder: (_, _) => const SizedBox(width: 13),
        itemBuilder: (BuildContext context, int i) {
          final CoverPalette palette = CoverPalette.forSeries('${i + 1}');
          return Container(
            width: 92,
            decoration: BoxDecoration(
              gradient: palette.gradient(c.brightness),
              borderRadius: BorderRadius.circular(AppRadii.cover),
            ),
            alignment: Alignment.center,
            child: Text(
              palette.letter,
              style: const TextStyle(
                fontFamily: AppFonts.kufi,
                fontSize: 38,
                fontWeight: FontWeight.w700,
              ).copyWith(color: c.coverLetter),
            ),
          );
        },
      ),
    );
  }
}

class _Numbers extends StatelessWidget {
  const _Numbers({required this.settings});

  final AppSettings settings;

  @override
  Widget build(BuildContext context) {
    final AppColors c = context.colors;
    final AppStrings str = context.strings;
    final List<String> lines = <String>[
      str.elapsedOfTotal(
        const Duration(minutes: 18, seconds: 34),
        const Duration(minutes: 45, seconds: 2),
      ),
      str.remaining(const Duration(minutes: 26, seconds: 28)),
      str.fileSizeMegabytes(Quality.mp3.estimatedMegabytes(
        const Duration(minutes: 45, seconds: 2),
      )),
      str.fileSizeMegabytes(1420),
      str.lessons(42),
      str.seriesIndexLine(seriesCount: 6, lessonCount: 175),
      str.numerals.speed(settings.speed),
      str.sleepTimerLabel(20),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      spacing: AppSpace.x8,
      children: <Widget>[
        for (final String line in lines)
          Text(line, style: AppText.secondary.copyWith(color: c.mut)),
      ],
    );
  }
}

class _DirectionProof extends StatelessWidget {
  const _DirectionProof();

  @override
  Widget build(BuildContext context) {
    final AppColors c = context.colors;
    final AppStrings str = context.strings;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      spacing: AppSpace.x12,
      children: <Widget>[
        // The chevron follows the layout; the play triangle does not.
        Row(
          spacing: AppSpace.x12,
          children: <Widget>[
            ForwardChevron(color: c.dim),
            Text(
              str.isArabic ? 'الشيفرون ينعكس' : 'Chevron mirrors',
              style: AppText.secondarySmall.copyWith(color: c.mut),
            ),
            const Spacer(),
            PlayGlyph(color: c.acc),
            Text(
              str.isArabic ? 'المثلث لا ينعكس' : 'Play never mirrors',
              style: AppText.secondarySmall.copyWith(color: c.mut),
            ),
          ],
        ),
        // An Arabic title inside whatever layout direction is active.
        EpisodeTitleText(
          prefix: str.episodePrefix(42),
          title: 'من ثمرات الذكر: طردُ الشيطان',
          isArabicUi: str.isArabic,
          style: AppText.rowTitle.copyWith(color: c.txt),
        ),
      ],
    );
  }
}
