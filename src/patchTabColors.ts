export type PatchTabColorCode = {
  code: string;
  primaryColor: string;
  secondaryColor: string;
  isMultiColor: boolean;
  label: string;
};

const hexColorPalette = [
  { digit: '0', color: '#ff4d5d', name: 'red' },
  { digit: '1', color: '#4d6dff', name: 'blue' },
  { digit: '2', color: '#ffb000', name: 'amber' },
  { digit: '3', color: '#4de1ff', name: 'cyan' },
  { digit: '4', color: '#8dff6b', name: 'green' },
  { digit: '5', color: '#b86dff', name: 'violet' },
  { digit: '6', color: '#f5f7ff', name: 'white' },
  { digit: '7', color: '#ff7a3d', name: 'orange' },
  { digit: '8', color: '#ff67c4', name: 'pink' },
  { digit: '9', color: '#4f8f3a', name: 'moss green' },
  { digit: 'A', color: '#45ffd5', name: 'teal' },
  { digit: 'B', color: '#8fb4ff', name: 'steel' },
  { digit: 'C', color: '#e065ff', name: 'magenta' },
  { digit: 'D', color: '#ffe45d', name: 'yellow' },
  { digit: 'E', color: '#9a6a3a', name: 'brown' },
  { digit: 'F', color: '#9eaab7', name: 'slate' },
] as const;

export function getPatchTabColorCode(index: number): PatchTabColorCode {
  if (index < hexColorPalette.length) {
    const paletteColor = hexColorPalette[index];

    return {
      code: paletteColor.digit,
      primaryColor: paletteColor.color,
      secondaryColor: paletteColor.color,
      isMultiColor: false,
      label: `HEX ${paletteColor.digit}: ${paletteColor.name}`,
    };
  }

  const extensionIndex = index - hexColorPalette.length;
  const highDigit = Math.floor(extensionIndex / hexColorPalette.length) % hexColorPalette.length;
  const lowDigit = extensionIndex % hexColorPalette.length;
  const highColor = hexColorPalette[highDigit];
  const lowColor = hexColorPalette[lowDigit];

  return {
    code: `${highColor.digit}${lowColor.digit}`,
    primaryColor: highColor.color,
    secondaryColor: lowColor.color,
    isMultiColor: true,
    label: `HEX ${highColor.digit}${lowColor.digit}: ${highColor.name} / ${lowColor.name}`,
  };
}
