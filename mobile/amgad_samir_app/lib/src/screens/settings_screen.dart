import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../l10n/app_localizations.dart';
import '../l10n/app_strings.dart';
import '../settings/app_settings.dart';
import '../settings/settings_controller.dart';
import '../theme/app_colors.dart';
import '../theme/app_metrics.dart';
import '../theme/app_typography.dart';
import '../widgets/directional.dart';
import 'placeholder_screen.dart';

/// Step 7 builds this out. Step 1 ships the two rows whose persistence it has
/// to prove — appearance and language — so a relaunch can be checked by hand.
class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final AppColors c = context.colors;
    final AppStrings str = context.strings;
    final AppSettings settings = ref.watch(settingsProvider);
    final SettingsController controller = ref.read(settingsProvider.notifier);

    return SafeArea(
      child: ListView(
        padding: const EdgeInsets.fromLTRB(
          AppSpace.screenX,
          AppSpace.x18,
          AppSpace.screenX,
          AppSpace.contentBottom,
        ),
        children: <Widget>[
          Text(
            str.settingsTitle,
            style: AppText.screenTitle.copyWith(color: c.txt),
          ),
          const SizedBox(height: AppSpace.x16),
          _ValueRow(
            label: str.settingAppearance,
            hint: str.settingAppearanceHint,
            value: settings.isDark
                ? str.settingAppearanceDark
                : str.settingAppearanceLight,
            onTap: controller.toggleTheme,
          ),
          const SizedBox(height: AppSpace.x10),
          _ValueRow(
            label: str.settingLanguage,
            hint: str.settingLanguageHint,
            value: str.settingLanguageValue,
            onTap: controller.toggleLanguage,
          ),
          const SizedBox(height: AppSpace.x16),
          Text(
            '${context.placeholderNote} — step 7',
            style: AppText.meta.copyWith(color: c.mut2),
          ),
        ],
      ),
    );
  }
}

class _ValueRow extends StatelessWidget {
  const _ValueRow({
    required this.label,
    required this.hint,
    required this.value,
    required this.onTap,
  });

  final String label;
  final String hint;
  final String value;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final AppColors c = context.colors;
    return Material(
      color: c.surf,
      borderRadius: BorderRadius.circular(AppRadii.rowTight),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppRadii.rowTight),
        child: Container(
          constraints: const BoxConstraints(minHeight: AppTargets.minTarget),
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpace.x14,
            vertical: AppSpace.x12,
          ),
          child: Row(
            spacing: AppSpace.x12,
            children: <Widget>[
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  spacing: AppSpace.x4,
                  children: <Widget>[
                    Text(
                      label,
                      style: AppText.rowTitle.copyWith(color: c.txt),
                    ),
                    Text(hint, style: AppText.metaSmall.copyWith(color: c.mut2)),
                  ],
                ),
              ),
              Text(value, style: AppText.secondarySmall.copyWith(color: c.acc)),
              ForwardChevron(color: c.dim, size: 12),
            ],
          ),
        ),
      ),
    );
  }
}
