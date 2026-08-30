import 'package:flutter/material.dart';

/// A placeholder cover: a two-stop 150° gradient plus the series' first Arabic
/// letter. Replaced by real artwork when it exists; the gradient stays as the
/// fallback for a series with no image.
@immutable
class CoverPalette {
  const CoverPalette({
    required this.letter,
    required this.darkStops,
    required this.lightStops,
  });

  /// The first Arabic letter of the series title, drawn as a watermark.
  final String letter;
  final (Color, Color) darkStops;
  final (Color, Color) lightStops;

  /// 150° in CSS measures clockwise from "to top"; Flutter's alignment axis
  /// runs from `begin` to `end`. This pair reproduces that direction.
  LinearGradient gradient(Brightness brightness) {
    final (Color a, Color b) =
        brightness == Brightness.dark ? darkStops : lightStops;
    return LinearGradient(
      begin: const Alignment(-0.5, -1),
      end: const Alignment(0.5, 1),
      colors: <Color>[a, b],
    );
  }

  static const CoverPalette fallback = CoverPalette(
    letter: '',
    darkStops: (Color(0xFF3A4459), Color(0xFF12161F)),
    lightStops: (Color(0xFFE1E5EC), Color(0xFFEFE7DA)),
  );

  /// The six gradients named in the handoff, keyed by series id.
  static const Map<String, CoverPalette> bySeriesId = <String, CoverPalette>{
    '1': CoverPalette(
      letter: 'و',
      darkStops: (Color(0xFF2C4763), Color(0xFF111A2A)),
      lightStops: (Color(0xFFDCE6F0), Color(0xFFEFE7DA)),
    ),
    '2': CoverPalette(
      letter: 'ش',
      darkStops: (Color(0xFF4A3A5C), Color(0xFF161226)),
      lightStops: (Color(0xFFE6DEF0), Color(0xFFEFE7DA)),
    ),
    '3': CoverPalette(
      letter: 'ك',
      darkStops: (Color(0xFF2E4C42), Color(0xFF101A17)),
      lightStops: (Color(0xFFDCEBE2), Color(0xFFEFE7DA)),
    ),
    '4': CoverPalette(
      letter: 'ط',
      darkStops: (Color(0xFF5A4326), Color(0xFF1A1410)),
      lightStops: (Color(0xFFF0E4D2), Color(0xFFEFE7DA)),
    ),
    '5': CoverPalette(
      letter: 'ج',
      darkStops: (Color(0xFF3A4459), Color(0xFF12161F)),
      lightStops: (Color(0xFFE1E5EC), Color(0xFFEFE7DA)),
    ),
    '6': CoverPalette(
      letter: 'غ',
      darkStops: (Color(0xFF5B2E33), Color(0xFF1A1013)),
      lightStops: (Color(0xFFF0DCDE), Color(0xFFEFE7DA)),
    ),
  };

  /// Gradients for the short-clip tiles, which are not tied to a series.
  static const List<LinearGradient> clipGradients = <LinearGradient>[
    LinearGradient(
      begin: Alignment(-0.35, -1),
      end: Alignment(0.35, 1),
      colors: <Color>[Color(0xFF3B4E6B), Color(0xFF131A28)],
    ),
    LinearGradient(
      begin: Alignment(-0.35, -1),
      end: Alignment(0.35, 1),
      colors: <Color>[Color(0xFF5B4327), Color(0xFF171310)],
    ),
    LinearGradient(
      begin: Alignment(-0.35, -1),
      end: Alignment(0.35, 1),
      colors: <Color>[Color(0xFF324A40), Color(0xFF101815)],
    ),
  ];

  static CoverPalette forSeries(String seriesId) =>
      bySeriesId[seriesId] ?? fallback;
}
