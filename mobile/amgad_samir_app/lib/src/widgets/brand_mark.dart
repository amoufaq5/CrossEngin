import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_metrics.dart';

/// The Sheikh's mark, on the design's 34x34 r10 tile.
///
/// The asset is a single-colour alpha mask with its RGB normalised to white,
/// so one file serves both themes: it is tinted at paint time rather than
/// shipped twice. Tinting also means a future artwork revision is a file swap
/// with no colour work.
class BrandMark extends StatelessWidget {
  const BrandMark({super.key, this.size = 34, this.tint});

  static const String assetPath = 'assets/images/logo.png';

  /// Edge of the square tile. The mark is letterboxed inside it, so a
  /// non-square artwork keeps its aspect instead of stretching.
  final double size;

  /// Defaults to the theme's primary text colour, which is what gives the
  /// mark the same contrast as the brand name beside it.
  final Color? tint;

  @override
  Widget build(BuildContext context) {
    final AppColors c = context.colors;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: c.surf2,
        borderRadius: BorderRadius.circular(AppRadii.brandTile),
      ),
      padding: EdgeInsets.all(size * 0.18),
      child: Image.asset(
        assetPath,
        fit: BoxFit.contain,
        color: tint ?? c.txt,
        // srcIn keeps the mask's alpha and replaces every colour channel, so
        // the mark takes the tint exactly and its anti-aliased edges survive.
        colorBlendMode: BlendMode.srcIn,
        filterQuality: FilterQuality.medium,
        // Content, not decoration: the brand name sits beside it and already
        // names it, so the image itself is excluded from the reading order.
        excludeFromSemantics: true,
      ),
    );
  }
}
