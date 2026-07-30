import * as _TurndownService from '@joplin/turndown';
import * as TurndownPluginGfm from '@joplin/turndown-plugin-gfm';
import { getBasename } from './basename';

// CJS/ESM interop: .default exists in Vite, not in NestJS
const TurndownService = (_TurndownService as any).default || _TurndownService;

function sanitizeMdLinkText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/([\[\]!])/g, '\\$1')
    .replace(/[\r\n]+/g, ' ');
}

export function htmlToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    hr: '---',
    bulletListMarker: '-',
  });

  turndownService.use([
    TurndownPluginGfm.tables,
    headerlessTable,
    TurndownPluginGfm.strikethrough,
    TurndownPluginGfm.highlightedCodeBlock,
    taskList,
    callout,
    preserveDetail,
    listParagraph,
    orderedListItem,
    mathInline,
    mathBlock,
    iframeEmbed,
    image,
    video,
  ]);
  return turndownService.turndown(html).replaceAll('<br>', ' ');
}

function headerlessTable(turndownService: _TurndownService) {
  turndownService.addRule('headerlessTable', {
    filter: function (node: HTMLTableElement) {
      if (node.nodeName !== 'TABLE' || !isSimpleMarkdownTable(node)) {
        return false;
      }

      return !node.querySelector('th') || hasSyntheticEmptyHeader(node);
    },
    replacement: function (content: string, node: HTMLTableElement) {
      let rows = content
        .replace(/\n+/g, '\n')
        .trim()
        .split('\n')
        .filter(Boolean);
      const syntheticEmptyHeader = hasSyntheticEmptyHeader(node);
      const promotedRow = node.rows.item(syntheticEmptyHeader ? 1 : 0);
      const alignmentRow = node.rows.item(0);
      if (syntheticEmptyHeader) {
        rows = rows.slice(2);
      }

      const columnCount = promotedRow
        ? Array.from(promotedRow.cells).reduce(
            (count, cell) => count + Math.max(cell.colSpan || 1, 1),
            0,
          )
        : 0;

      if (rows.length === 0 || columnCount === 0) {
        return '';
      }

      const dividers = Array.from(alignmentRow?.cells ?? []).flatMap((cell) =>
        Array.from({ length: Math.max(cell.colSpan || 1, 1) }, () =>
          markdownTableDivider(cell),
        ),
      );
      while (dividers.length < columnCount) {
        dividers.push('---');
      }
      const divider = `| ${dividers.join(' | ')} |`;
      const body = rows.length > 1 ? `\n${rows.slice(1).join('\n')}` : '';
      const captionText = node.caption?.textContent?.trim();
      const caption = captionText ? `${captionText}\n\n` : '';

      return `\n\n${caption}${rows[0]}\n${divider}${body}\n\n`;
    },
  });
}

function isSimpleMarkdownTable(node: HTMLTableElement): boolean {
  if (
    node.rows.length === 0 ||
    (node.rows.length === 1 && node.rows.item(0)?.cells.length <= 1)
  ) {
    return false;
  }

  return !node.querySelector(
    'table, ul, ol, h1, h2, h3, h4, h5, h6, hr, blockquote, pre',
  );
}

function hasSyntheticEmptyHeader(node: HTMLTableElement): boolean {
  const firstRow = node.rows.item(0);
  if (!firstRow || node.rows.length < 2 || firstRow.cells.length === 0) {
    return false;
  }

  return Array.from(firstRow.cells).every(
    (cell) => cell.nodeName === 'TH' && !cell.textContent?.trim(),
  );
}

function markdownTableDivider(cell: HTMLTableCellElement): string {
  const alignment = (
    cell.style?.textAlign ||
    cell.getAttribute('align') ||
    ''
  ).toLowerCase();

  if (alignment === 'center') {
    return ':---:';
  }
  if (alignment === 'right') {
    return '---:';
  }
  if (alignment === 'left') {
    return ':---';
  }
  return '---';
}

function listParagraph(turndownService: _TurndownService) {
  turndownService.addRule('paragraph', {
    filter: ['p'],
    replacement: (content: string, node: HTMLInputElement) => {
      if (node.parentElement?.nodeName === 'LI') {
        return content;
      }
      return `\n\n${content}\n\n`;
    },
  });
}

function orderedListItem(turndownService: _TurndownService) {
  turndownService.addRule('orderedListItem', {
    filter: function (node: HTMLInputElement) {
      return (
        node.nodeName === 'LI' && node.getAttribute('data-type') !== 'taskItem'
      );
    },
    replacement: (content: string, node: HTMLInputElement, options: any) => {
      const parent = node.parentNode as HTMLElement;
      if (parent.nodeName !== 'OL' && parent.nodeName !== 'UL') {
        return content;
      }

      content = content
        .replace(/^\n+/, '')
        .replace(/\n+$/, '\n')
        .replace(/\n/gm, '\n  ');

      let prefix: string;
      if (parent.nodeName === 'OL') {
        const start = parseInt(parent.getAttribute('start') || '1', 10);
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = `${start + index}. `;
      } else {
        prefix = `${options.bulletListMarker} `;
      }

      return (
        prefix +
        content +
        (node.nextSibling && !/\n$/.test(content) ? '\n' : '')
      );
    },
  });
}

function callout(turndownService: _TurndownService) {
  turndownService.addRule('callout', {
    filter: function (node: HTMLInputElement) {
      return (
        node.nodeName === 'DIV' && node.getAttribute('data-type') === 'callout'
      );
    },
    replacement: function (content: string, node: HTMLInputElement) {
      const calloutType = node.getAttribute('data-callout-type');
      return `\n\n:::${calloutType}\n${content.trim()}\n:::\n\n`;
    },
  });
}

function taskList(turndownService: _TurndownService) {
  turndownService.addRule('taskListItem', {
    filter: function (node: HTMLInputElement) {
      return (
        node.getAttribute('data-type') === 'taskItem' &&
        node.parentNode.nodeName === 'UL'
      );
    },
    replacement: function (_content: string, node: HTMLInputElement) {
      const isChecked = node.getAttribute('data-checked') === 'true';
      const div = node.querySelector('div');
      const text = div ? div.textContent.trim() : node.textContent.trim();

      const prefix = `- ${isChecked ? '[x]' : '[ ]'} `;

      return (
        prefix + text + (node.nextSibling && !/\n$/.test(text) ? '\n' : '')
      );
    },
  });
}

function preserveDetail(turndownService: _TurndownService) {
  turndownService.addRule('preserveDetail', {
    filter: function (node: HTMLInputElement) {
      return node.nodeName === 'DETAILS';
    },
    replacement: function (_content: string, node: HTMLInputElement) {
      const summary = node.querySelector(':scope > summary');
      let detailSummary = '';

      if (summary) {
        detailSummary = `<summary>${turndownService.turndown(summary.innerHTML)}</summary>`;
      }

      const detailsContent = Array.from(node.childNodes)
        .filter((child) => child.nodeName !== 'SUMMARY')
        .map((child) =>
          child.nodeType === 1
            ? turndownService.turndown((child as HTMLElement).outerHTML)
            : child.textContent,
        )
        .join('');

      return `\n<details>\n${detailSummary}\n\n${detailsContent}\n\n</details>\n`;
    },
  });
}

function mathInline(turndownService: _TurndownService) {
  turndownService.addRule('mathInline', {
    filter: function (node: HTMLInputElement) {
      return (
        node.nodeName === 'SPAN' &&
        node.getAttribute('data-type') === 'mathInline'
      );
    },
    replacement: function (content: string) {
      return `$${content}$`;
    },
  });
}

function mathBlock(turndownService: _TurndownService) {
  turndownService.addRule('mathBlock', {
    filter: function (node: HTMLInputElement) {
      return (
        node.nodeName === 'DIV' &&
        node.getAttribute('data-type') === 'mathBlock'
      );
    },
    replacement: function (content: string) {
      return `\n$$\n${content}\n$$\n`;
    },
  });
}

function iframeEmbed(turndownService: _TurndownService) {
  turndownService.addRule('iframeEmbed', {
    filter: function (node: HTMLInputElement) {
      return node.nodeName === 'IFRAME';
    },
    replacement: function (_content: string, node: HTMLInputElement) {
      const src = node.getAttribute('src');
      return '[' + src + '](' + src + ')';
    },
  });
}

function image(turndownService: _TurndownService) {
  turndownService.addRule('image', {
    filter: 'img',
    replacement: function (_content: string, node: HTMLInputElement) {
      const src = node.getAttribute('src') || '';
      if (!src) return '';
      const alt = sanitizeMdLinkText(node.getAttribute('alt') || '');
      const title = node.getAttribute('title') || '';
      const titlePart = title ? ' "' + title.replace(/"/g, '\\"') + '"' : '';
      return '![' + alt + '](' + src + titlePart + ')';
    },
  });
}

function video(turndownService: _TurndownService) {
  turndownService.addRule('video', {
    filter: function (node: HTMLInputElement) {
      return node.tagName === 'VIDEO';
    },
    replacement: function (_content: string, node: HTMLInputElement) {
      const src = node.getAttribute('src') || '';
      const ariaLabel = node.getAttribute('aria-label');
      const name = sanitizeMdLinkText(ariaLabel || getBasename(src) || src);
      return '[' + name + '](' + src + ')';
    },
  });
}
