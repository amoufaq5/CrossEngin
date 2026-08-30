import 'package:flutter/material.dart';

import '../l10n/app_localizations.dart';
import '../theme/app_colors.dart';
import '../theme/app_metrics.dart';
import '../theme/app_typography.dart';

/// A screen that exists so navigation works end to end before its real
/// content is built. Each one names the step that replaces it.
class PlaceholderScreen extends StatelessWidget {
  const PlaceholderScreen({
    super.key,
    required this.title,
    required this.arrivesIn,
  });

  final String title;

  /// Human-readable note about which build step fills this in.
  final String arrivesIn;

  @override
  Widget build(BuildContext context) {
    final AppColors c = context.colors;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpace.screenX,
          AppSpace.x18,
          AppSpace.screenX,
          AppSpace.contentBottom,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          spacing: AppSpace.x8,
          children: <Widget>[
            Text(title, style: AppText.screenTitle.copyWith(color: c.txt)),
            Text(arrivesIn, style: AppText.meta.copyWith(color: c.mut2)),
          ],
        ),
      ),
    );
  }
}

extension PlaceholderStrings on BuildContext {
  /// Placeholder copy is intentionally untranslated: it never ships.
  String get placeholderNote =>
      strings.isArabic ? 'قيد الإنشاء' : 'Under construction';
}
