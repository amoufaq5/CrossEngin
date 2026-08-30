import 'dart:math' as math;
import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../l10n/app_localizations.dart';
import '../l10n/app_strings.dart';
import '../theme/app_colors.dart';
import '../theme/app_metrics.dart';
import '../theme/app_typography.dart';

/// Holds the four tab branches and the bottom chrome.
///
/// Step 1 ships the tab bar's geometry and colours only — the stroked 19px
/// icon set, the mini-player above it, and the hide-while-the-player-is-open
/// rule arrive with steps 5 and 8.
class AppShell extends StatelessWidget {
  const AppShell({super.key, required this.shell});

  final StatefulNavigationShell shell;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: context.colors.bg,
      // Each screen draws its own header and the tab bar floats over the
      // content, so the body runs edge to edge.
      extendBody: true,
      body: shell,
      bottomNavigationBar: _TabBar(shell: shell),
    );
  }
}

class _TabBar extends StatelessWidget {
  const _TabBar({required this.shell});

  final StatefulNavigationShell shell;

  @override
  Widget build(BuildContext context) {
    final AppColors c = context.colors;
    final AppStrings s = context.strings;
    final List<String> labels = <String>[
      s.tabHome,
      s.tabSeries,
      s.tabLibrary,
      s.tabSettings,
    ];

    return ClipRect(
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: kChromeBlur, sigmaY: kChromeBlur),
        child: Container(
          decoration: BoxDecoration(
            color: c.navbg,
            border: Border(top: BorderSide(color: c.line)),
          ),
          padding: EdgeInsets.only(
            top: AppSpace.x8,
            // The design's 26px home-indicator inset, widened if the device
            // reports a larger safe area.
            bottom: math.max(
              AppSpace.x26,
              MediaQuery.viewPaddingOf(context).bottom,
            ),
          ),
          child: Row(
            children: <Widget>[
              for (int i = 0; i < labels.length; i++)
                Expanded(
                  child: _TabItem(
                    label: labels[i],
                    active: shell.currentIndex == i,
                    onTap: () => shell.goBranch(
                      i,
                      // Re-tapping the live tab pops it back to its root.
                      initialLocation: i == shell.currentIndex,
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _TabItem extends StatelessWidget {
  const _TabItem({
    required this.label,
    required this.active,
    required this.onTap,
  });

  final String label;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final AppColors c = context.colors;
    final Color color = active ? c.acc : c.dim;
    return InkWell(
      onTap: onTap,
      // A fixed height, not a minimum: `bottomNavigationBar` is handed loose
      // constraints, so an unbounded Column here grows to fill the screen and
      // swallows every tap meant for the content behind it.
      child: SizedBox(
        height: AppTargets.minTarget,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          mainAxisAlignment: MainAxisAlignment.center,
          spacing: AppSpace.x4,
          children: <Widget>[
            // Placeholder mark; the 1.7-weight stroked glyphs land in step 8.
            Container(
              width: 19,
              height: 19,
              decoration: BoxDecoration(
                border: Border.all(color: color, width: 1.7),
                borderRadius: BorderRadius.circular(5),
              ),
            ),
            Text(label, style: AppText.tabLabel.copyWith(color: color)),
          ],
        ),
      ),
    );
  }
}
