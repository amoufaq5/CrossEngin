import 'package:flutter/widgets.dart';

/// Mirrors its child horizontally when the ambient direction is right-to-left.
///
/// Use it for direction-dependent glyphs — chevrons, back arrows, skip arcs.
/// Do **not** use it for the play triangle: a play button points the same way
/// in every language, and mirroring it is the classic RTL bug.
class MirrorForDirection extends StatelessWidget {
  const MirrorForDirection({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    if (Directionality.of(context) != TextDirection.rtl) return child;
    return Transform(
      alignment: Alignment.center,
      transform: Matrix4.identity()..scaleByDouble(-1, 1, 1, 1),
      child: child,
    );
  }
}

/// A forward chevron — `>` in LTR, `<` in RTL.
///
/// Traced from the design's `M1 1l6 6-6 6` in a 14x14 box, at the 1.7 stroke
/// weight the handoff specifies for every stroked icon.
class ForwardChevron extends StatelessWidget {
  const ForwardChevron({
    super.key,
    required this.color,
    this.size = 14,
    this.strokeWidth = 1.7,
  });

  final Color color;
  final double size;
  final double strokeWidth;

  @override
  Widget build(BuildContext context) {
    return MirrorForDirection(
      child: CustomPaint(
        size: Size.square(size),
        painter: _ChevronPainter(color: color, strokeWidth: strokeWidth),
      ),
    );
  }
}

class _ChevronPainter extends CustomPainter {
  const _ChevronPainter({required this.color, required this.strokeWidth});

  final Color color;
  final double strokeWidth;

  @override
  void paint(Canvas canvas, Size size) {
    final double s = size.width / 14;
    final Path path = Path()
      ..moveTo(1 * s, 1 * s)
      ..lineTo(7 * s, 7 * s)
      ..lineTo(1 * s, 13 * s);
    canvas.drawPath(
      path,
      Paint()
        ..style = PaintingStyle.stroke
        ..color = color
        ..strokeWidth = strokeWidth
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round,
    );
  }

  @override
  bool shouldRepaint(_ChevronPainter old) =>
      old.color != color || old.strokeWidth != strokeWidth;
}

/// The play triangle. Points right in both languages — deliberately not
/// wrapped in [MirrorForDirection].
///
/// Traced from the design's `M14 8.5L0 17V0z` in a 15x17 box.
class PlayGlyph extends StatelessWidget {
  const PlayGlyph({super.key, required this.color, this.size = 15});

  /// Width in logical pixels; height follows the 15:17 aspect of the source.
  final double size;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      size: Size(size, size * 17 / 15),
      painter: _PlayPainter(color),
    );
  }
}

class _PlayPainter extends CustomPainter {
  const _PlayPainter(this.color);

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final double sx = size.width / 15;
    final double sy = size.height / 17;
    final Path path = Path()
      ..moveTo(14 * sx, 8.5 * sy)
      ..lineTo(0, 17 * sy)
      ..lineTo(0, 0)
      ..close();
    canvas.drawPath(path, Paint()..color = color);
  }

  @override
  bool shouldRepaint(_PlayPainter old) => old.color != color;
}

/// The paired pause glyph: two rounded bars, symmetric so direction is moot.
class PauseGlyph extends StatelessWidget {
  const PauseGlyph({
    super.key,
    required this.color,
    this.size = 15,
    this.gap = 6,
  });

  final Color color;
  final double size;
  final double gap;

  @override
  Widget build(BuildContext context) {
    final double barWidth = (size - gap) / 2;
    return SizedBox(
      width: size,
      height: size * 17 / 15,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        spacing: gap,
        children: <Widget>[
          for (int i = 0; i < 2; i++)
            Container(
              width: barWidth,
              height: size * 17 / 15,
              decoration: BoxDecoration(
                color: color,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
        ],
      ),
    );
  }
}
