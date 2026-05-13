// N02 — HTML to plain-text converter.

import { convert } from 'html-to-text';

export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: 76,
    selectors: [
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
      { selector: 'img', format: 'skip' },
      {
        selector: 'table',
        options: { uppercaseHeaderCells: false, maxColumnWidth: 40 },
      },
    ],
  });
}
