import 'package:amgad_samir_app/src/l10n/numerals.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const Numerals ar = Numerals.arabic();
  const Numerals en = Numerals.latin();

  group('digits', () {
    test('Arabic maps every ASCII digit to Arabic-Indic', () {
      expect(ar.digits('0123456789'), '٠١٢٣٤٥٦٧٨٩');
    });

    test('Latin leaves the source untouched', () {
      expect(en.digits('0123456789'), '0123456789');
    });

    test('non-digits pass through in both systems', () {
      expect(ar.digits('45:02'), '٤٥:٠٢');
      expect(ar.digits('720p'), '٧٢٠p');
    });

    test('every ASCII digit converts, brand names included', () {
      // `digits` is deliberately indiscriminate: it is for numbers, not for
      // text. `MP3` is a brand token, so the string tables carry it as a
      // literal and never route it through here.
      expect(ar.digits('MP3'), 'MP٣');
    });
  });

  group('duration', () {
    test('pads to mm:ss', () {
      expect(en.duration(const Duration(minutes: 5, seconds: 3)), '05:03');
      expect(ar.duration(const Duration(minutes: 45, seconds: 2)), '٤٥:٠٢');
    });

    test('widens to h:mm:ss past an hour', () {
      expect(
        en.duration(const Duration(hours: 1, minutes: 2, seconds: 3)),
        '1:02:03',
      );
    });

    test('a negative position clamps to zero rather than rendering a sign', () {
      expect(en.duration(const Duration(seconds: -30)), '00:00');
    });
  });

  group('decimal', () {
    test('Arabic uses U+066B, not a full stop', () {
      expect(ar.decimal(1.42), '١٫٤');
      expect(ar.decimal(1.42), contains(Numerals.arabicDecimalMark));
      expect(ar.decimal(1.42), isNot(contains('.')));
    });

    test('Latin uses a full stop', () {
      expect(en.decimal(1.42), '1.4');
    });
  });

  group('speed', () {
    test('renders the ladder in both systems', () {
      expect(en.speed(0.75), '0.75×');
      expect(en.speed(2), '2.0×');
      expect(ar.speed(0.75), '٠٫٧٥×');
      expect(ar.speed(1.25), '١٫٢٥×');
    });
  });

  test('percent clamps to the 0–1 range', () {
    expect(en.percent(0.41), '41%');
    expect(en.percent(1.9), '100%');
    expect(ar.percent(0.41), '٤١%');
  });
}
