// Attribute sets for the clock-and-cross mark, so the drawing stays out of the template's text.
export const mark = {
  svg: {
    viewBox: '-0.6 -0.6 25.2 25.2',
    'aria-hidden': 'true' as const,
    focusable: 'false',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-linecap': 'round' as const,
    'stroke-linejoin': 'round' as const,
  },
  ring: { cx: '10.2', cy: '10.2', r: '8', 'stroke-width': '2.2' },
  hand: { d: 'M10.2 5.9v4.3l2.8 2.1', 'stroke-width': '2.2' },
  knock: { cx: '17.6', cy: '17.6', r: '6.4', stroke: 'none' },
  badge: { cx: '17.6', cy: '17.6', r: '5.2', fill: 'currentColor', stroke: 'none' },
  cross: { d: 'M17.6 14.8v5.6M14.8 17.6h5.6', 'stroke-width': '1.9' },
};
